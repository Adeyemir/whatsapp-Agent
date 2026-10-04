/** Build one exact marketplace request from a catalog listing and model inputs. */
export type MarketplaceRequestItem = { resource: string; metadata?: { method?: string } };

export function validMarketplaceUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
        /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname === "localhost") return null;
    return url;
  } catch { return null; }
}

export function matchesCatalogResource(listed: URL, requested: URL): boolean {
  if (listed.origin !== requested.origin) return false;
  const templateParts = listed.pathname.split("/");
  const requestParts = requested.pathname.split("/");
  if (templateParts.length !== requestParts.length) return false;
  try {
    return templateParts.every((part, index) => {
      const template = decodeURIComponent(part);
      const actual = decodeURIComponent(requestParts[index]);
      if (/^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(template)) {
        return /^[A-Za-z0-9._~-]{1,80}$/.test(actual) && actual !== "." && actual !== "..";
      }
      return part === requestParts[index];
    });
  } catch { return false; }
}

export function buildMarketplaceRequest(item: MarketplaceRequestItem, requestUrl?: string, bodyJson?: string):
  | { ok: true; url: string; method: string; body?: string }
  | { ok: false; error: string } {
  const listed = validMarketplaceUrl(item.resource);
  if (!listed) return { ok: false, error: "The marketplace listing has an invalid URL." };
  const requested = requestUrl ? validMarketplaceUrl(requestUrl) : null;
  // The catalog endpoint is authoritative. A model may copy a URL from a
  // different search result; never call that URL under this service ID.
  const url = requested && matchesCatalogResource(listed, requested)
    ? requested : new URL(listed);
  const method = (item.metadata?.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return { ok: false, error: "Unsupported service HTTP method." };
  }

  let body: string | undefined;
  if (bodyJson !== undefined) {
    if (bodyJson.length > 80_000) return { ok: false, error: "This service request is too large. Nothing was paid." };
    let parsed: unknown;
    try { parsed = JSON.parse(bodyJson); } catch { return { ok: false, error: "The service request data was malformed. Nothing was paid." }; }
    if (method === "GET") {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "For GET, bodyJson must be a JSON object of path or query parameters." };
      }
      const params = { ...parsed } as Record<string, unknown>;
      let templatePath: string;
      try { templatePath = decodeURIComponent(listed.pathname); } catch {
        return { ok: false, error: "Invalid marketplace resource path." };
      }
      const pathNames = [...templatePath.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
      for (const name of pathNames) {
        const value = params[name];
        if (typeof value === "string" || typeof value === "number") {
          if (!/^[A-Za-z0-9._~-]{1,80}$/.test(String(value)) || value === "." || value === "..") {
            return { ok: false, error: `Invalid ${name} path value.` };
          }
          try { url.pathname = decodeURIComponent(url.pathname).replace(`{${name}}`, encodeURIComponent(String(value))); }
          catch { return { ok: false, error: "Invalid request path." }; }
          delete params[name];
        } else if (value !== undefined) {
          return { ok: false, error: `${name} path value must be text or a number.` };
        }
      }
      for (const [key, value] of Object.entries(params)) {
        if (pathNames.includes(key) || value === null || value === undefined) continue;
        if (!["string", "number", "boolean"].includes(typeof value)) {
          return { ok: false, error: `GET query parameter ${key} must be a simple value.` };
        }
        url.searchParams.set(key, String(value));
      }
    } else {
      body = JSON.stringify(parsed);
    }
  }
  if (url.toString().length > 2000 || !matchesCatalogResource(listed, url) || /\{[^}]+\}/.test(url.pathname)) {
    return { ok: false, error: "This service needs a valid path value or shorter query. Nothing was paid." };
  }
  return { ok: true, url: url.toString(), method, body };
}
