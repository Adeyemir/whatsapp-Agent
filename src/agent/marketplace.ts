import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { getWalletAddress } from "./tools/circle.js";
import { buildMarketplaceRequest, validMarketplaceUrl } from "./marketplace-request.js";
import { getHistory } from "../memory/store.js";
import { pendingWalletActionPrompt } from "./wallet-actions.js";

type CliResult = { ok: boolean; data: any; error?: string };
type CatalogItem = {
  resource: string;
  accepts?: Array<{ network: string; amount: string; extra?: { name?: string } }>;
  metadata?: {
    method?: string;
    description?: string;
    provider?: { name?: string; category?: string; docsUrl?: string };
    input?: unknown;
  };
};
type Quote = { price: string; chain: string; scheme: string; seller: string };
type Pending = {
  url: string;
  method: string;
  body?: string;
  address: string;
  chain: string;
  quote: Quote;
  provider: string;
  serviceName: string;
  purpose: string;
  created: number;
  prompt: string;
};

const circleBin = fileURLToPath(new URL("../../node_modules/.bin/circle", import.meta.url));
const catalog = new Map<string, CatalogItem[]>();
const pending = new Map<string, Pending>();
const preparing = new Set<string>();
const inFlight = new Set<string>();
const recentDecision = new Map<string, { at: number; reply: string }>();
type StoredResult = { id: string; data: string; truncated: boolean; provider?: string; serviceName?: string; purpose?: string };
const resultsFile = path.resolve(process.cwd(), ".data", "marketplace-results.json");
function loadPaidResults(): Map<string, StoredResult[]> {
  const out = new Map<string, StoredResult[]>();
  try {
    const saved = JSON.parse(fs.readFileSync(resultsFile, "utf8")) as Record<string, StoredResult[]>;
    for (const [conversationId, results] of Object.entries(saved)) {
      if (!Array.isArray(results)) continue;
      out.set(conversationId, results.filter((item) =>
        typeof item?.id === "string" && typeof item?.data === "string" &&
        item.data.length <= 1_000_000 && typeof item?.truncated === "boolean"
      ).slice(-5));
    }
  } catch { /* No saved paid results yet. */ }
  return out;
}
const paidResults = loadPaidResults();
function persistPaidResults(): void {
  const saved = Object.fromEntries(paidResults);
  fs.mkdirSync(path.dirname(resultsFile), { recursive: true });
  const temp = `${resultsFile}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(saved), { mode: 0o600 });
  fs.renameSync(temp, resultsFile);
}
const TTL_MS = 10 * 60_000;
const CHAIN: Record<string, string> = {
  "1": "ETH", "10": "OP", "137": "MATIC", "8453": "BASE",
  "42161": "ARB", "43114": "AVAX", "130": "UNI",
};
const GATEWAY_DOMAIN: Record<number, string> = { 0: "ETH", 3: "ARB", 6: "BASE", 7: "MATIC" };

function stockResearchIntent(conversationId: string): boolean {
  const recent = getHistory(conversationId).filter((message) => message.role === "user" &&
    typeof message.content === "string" &&
    !/^(?:The owner approved and Friday called|Use the previously approved and paid)/.test(message.content))
    .slice(-6).map((message) => message.content as string);
  const latestTask = [...recent].reverse().find((message) =>
    !/^(?:yes|no|proceed|continue|go ahead|yes proceed)$/i.test(message.trim()) &&
    !/\b(?:request url|you are an ai agent|should be smart)\b/i.test(message));
  return !!latestTask && /\b(?:stocks?|equities|investment report|share prices?)\b/i.test(latestTask);
}

export function financialService(item: CatalogItem): boolean {
  const text = `${item.metadata?.description ?? ""} ${item.resource}`.toLowerCase();
  if (/video|tiktok|tikhub|douyin|content.analysis|youtube/.test(text)) return false;
  return /stock|equity|finance|financial|market.data|valuation|earnings|portfolio.risk/.test(text);
}

async function cli(args: string[], timeout = 30_000): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(circleBin, [...args, "--output", "json"], {
      timeout, maxBuffer: 3 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: "0", NODE_NO_WARNINGS: "1" },
    }, (error, stdout, stderr) => {
      const raw = stdout?.toString() || stderr?.toString() || "";
      let parsed: any;
      try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
      resolve({ ok: !error && !parsed?.error, data: parsed,
        error: parsed?.error?.message ?? (error ? "Circle CLI failed" : "Invalid Circle CLI response") });
    });
  });
}

function canonicalPrice(input: string): string | null {
  const match = /^\$?(\d+(?:\.\d{1,6})?)\s*(?:USDC)?$/i.exec(input.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value.toFixed(6);
}

function maxPrice(): number {
  const value = Number(process.env.MARKETPLACE_MAX_USDC_PER_CALL ?? "0.25");
  return Number.isFinite(value) && value > 0 ? value : 0.25;
}

function summarize(item: CatalogItem, id: number) {
  const m = item.metadata;
  const prices = (item.accepts ?? []).map((a) => Number(a.amount) / 1_000_000).filter(Number.isFinite);
  const input = m?.input as Record<string, any> | undefined;
  const schemaPart = (part: any) => part ? {
    required: part.required ?? [],
    fields: Object.fromEntries(Object.entries(part.properties ?? {}).slice(0, 25).map(([name, value]) => {
      const field = value as Record<string, any>;
      return [name, { type: field.type, description: field.description?.slice(0, 150), example: field.example }];
    })),
  } : undefined;
  const routeMap = new Map<string, { chain: string; rail: string; priceUsdc: string }>();
  for (const a of item.accepts ?? []) {
    const chain = CHAIN[a.network?.split(":")[1] ?? ""];
    const rail = a.extra?.name?.includes("Gateway") ? "gateway" : "onchain";
    if (chain) routeMap.set(`${chain}:${rail}`, { chain, rail, priceUsdc: (Number(a.amount) / 1_000_000).toFixed(6) });
  }
  const paymentRoutes = [...routeMap.values()].slice(0, 8);
  return {
    id: `svc_${id + 1}`,
    provider: m?.provider?.name,
    category: m?.provider?.category,
    description: m?.description,
    resource: item.resource,
    method: m?.method ?? "GET",
    listedPriceUsdc: prices.length ? Math.min(...prices).toFixed(6) : "unknown",
    input: {
      path: schemaPart(input?.pathParams),
      query: schemaPart(input?.queryParams),
      body: schemaPart(input?.body),
    },
    paymentRoutes,
    docsUrl: m?.provider?.docsUrl,
  };
}

function parseQuote(result: CliResult): Quote | null {
  const d = result.data?.data;
  if (!result.ok || typeof d?.price !== "string" || typeof d?.chain !== "string" ||
      typeof d?.scheme !== "string" || typeof d?.seller !== "string") return null;
  const price = canonicalPrice(d.price);
  return price ? { price, chain: d.chain, scheme: d.scheme, seller: d.seller } : null;
}

async function quoteCall(p: Pick<Pending, "url" | "method" | "body" | "address" | "chain">): Promise<Quote | null> {
  const args = ["services", "pay", p.url, "--address", p.address, "--chain", p.chain,
    "-X", p.method, "--estimate"];
  if (p.body !== undefined) args.push("--data", p.body);
  return parseQuote(await cli(args, 45_000));
}

async function availableChains(address: string, gatewayNeeded: boolean, onchainChains: string[]): Promise<{ gateway: Record<string, number>; onchain: Record<string, number> }> {
  const gateway: Record<string, number> = {};
  const onchain: Record<string, number> = {};
  if (gatewayNeeded) {
    const gw = await cli(["gateway", "balance", "--address", address, "--chain", "BASE", "--all"]);
    if (gw.ok) for (const b of gw.data?.data?.balances ?? []) {
      const chain = GATEWAY_DOMAIN[b.domain];
      if (chain) gateway[chain] = Number(b.balance);
    }
  }
  await Promise.all([...new Set(onchainChains)].map(async (chain) => {
    const result = await cli(["wallet", "balance", "--chain", chain, "--address", address]);
    if (result.ok) onchain[chain] = (result.data?.data?.balances ?? [])
      .filter((b: any) => b.token?.symbol === "USDC")
      .reduce((sum: number, b: any) => sum + Number(b.amount), 0);
  }));
  return { gateway, onchain };
}

export function approvalPrompt(p: Pending): string {
  const clean = (value: string, max = 180) => value.replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
  const rail = p.quote.scheme.includes("Gateway") ? "Circle Gateway balance" : "Circle wallet balance";
  const cost = Number(p.quote.price).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  let details = "";
  if (p.body && /email|mail/i.test(`${p.serviceName} ${p.provider}`)) {
    try {
      const body = JSON.parse(p.body) as { to?: string[]; subject?: string };
      if (Array.isArray(body.to)) details += `\nTo: ${body.to.map((item) => clean(item, 100)).join(", ")}`;
      if (body.subject) details += `\nSubject: ${clean(body.subject, 120)}`;
    } catch { /* The request body was already validated. */ }
  }
  return `Friday found a paid service for your request.\n\n${clean(p.purpose)}\nService: ${clean(p.serviceName, 120)}\nProvider: ${clean(p.provider, 100)}${details}\nMaximum cost: $${cost} USDC from your ${rail}.\n\nReply YES to pay for this one call, or NO to cancel. Expires in 10 minutes. Reply DETAILS if you want the technical request.`;
}

function redactSecrets(value: any): any {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [
      key,
      /payment.?header|payment.?payload|authoriz|private|secret|signature|api.?key|^token$|^receipt$/i.test(key)
        ? "[redacted]" : redactSecrets(inner),
    ]));
  }
  return value;
}

export function marketplaceTools(conversationId: string) {
  let requestAttempts = 0;
  const attemptsByService = new Map<string, number>();
  return {
    readMarketplaceResult: tool({
      description: "Read another chunk of a previously approved paid marketplace response. Use when the first response preview says it was truncated. This never pays again.",
      inputSchema: z.object({
        resultId: z.string().uuid(),
        offset: z.number().int().nonnegative().default(0),
      }),
      execute: async ({ resultId, offset }) => {
        const result = paidResults.get(conversationId)?.find((item) => item.id === resultId);
        if (!result) return { error: "That paid result is no longer available in this chat." };
        const chunk = result.data.slice(offset, offset + 10_000);
        return {
          resultId, offset, chunk,
          nextOffset: offset + chunk.length < result.data.length ? offset + chunk.length : null,
          capturedEntireResponse: !result.truncated,
        };
      },
    }),
    discoverServices: tool({
      description: "Search Circle Agent Marketplace for any relevant paid API, across all categories. Search short capability terms, then use the returned service ID with requestMarketplaceCall. If a narrow query has no results, try broader terms before saying no service exists.",
      inputSchema: z.object({ query: z.string().max(80).optional().describe("Short service keyword, such as stock, email, search, phone, image, or weather") }),
      execute: async ({ query }) => {
        const q = query?.trim() ?? "";
        if (q && !/^[a-zA-Z0-9 ._-]+$/.test(q)) return { error: "Use a short plain-language search term." };
        const result = await cli(["services", "search", ...(q ? [q] : []), "--limit", "50"]);
        if (!result.ok) return { error: `Marketplace search failed: ${result.error}` };
        const items: CatalogItem[] = (result.data?.data?.items ?? []).filter((i: CatalogItem) => !!validMarketplaceUrl(i.resource));
        const existing = catalog.get(conversationId) ?? [];
        for (const item of items) if (!existing.some((x) => x.resource === item.resource)) existing.push(item);
        // Keep IDs stable across searches, including parallel model tool calls.
        catalog.set(conversationId, existing);
        const stored = catalog.get(conversationId)!;
        const relevantItems = stockResearchIntent(conversationId)
          ? items.filter(financialService) : items;
        return {
          query: q || "all", total: result.data?.data?.pagination?.total ?? items.length,
          services: relevantItems.filter((i) => stored.some((x) => x.resource === i.resource))
            .map((i) => ({ item: i, summary: summarize(i, stored.findIndex((x) => x.resource === i.resource)) }))
            .sort((a, b) => {
              const score = (entry: typeof a) => {
                const terms = q.toLowerCase().split(/\s+/).filter((term) => term.length > 2);
                const description = (entry.item.metadata?.description ?? "").toLowerCase();
                const path = entry.item.resource.toLowerCase();
                return terms.reduce((n, term) => n + (description.includes(term) ? 5 : 0) + (path.includes(term) ? 3 : 0), 0)
                  + (entry.item.accepts?.length ? 1 : 0);
              };
              return score(b) - score(a) || Number(a.summary.listedPriceUsdc) - Number(b.summary.listedPriceUsdc);
            })
            .slice(0, 12).map((entry) => entry.summary),
          note: "These are catalog listings. A paid call still needs an exact live quote and owner approval.",
        };
      },
    }),
    requestMarketplaceCall: tool({
      description: "Prepare one paid Circle Marketplace API call for the user's task. Requires a service ID returned by discoverServices. This tool only quotes and asks for owner approval; it never pays. Supply exact GET URL query or POST JSON body based on the catalog input schema. The app handles the owner's yes/no and pays outside the model.",
      inputSchema: z.object({
        serviceId: z.string().describe("ID returned by discoverServices, such as svc_1"),
        purpose: z.string().max(200).describe("What this specific call will do for the owner, including any external side effect"),
        requestUrl: z.string().optional().describe("Exact HTTPS request URL; may add query parameters to the listed resource"),
        bodyJson: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())])
          .optional().describe("Request data for this service as a JSON object or array. A JSON string also works."),
      }),
      execute: async ({ serviceId, purpose, requestUrl, bodyJson: rawBody }) => {
        if (pending.has(conversationId) || pendingWalletActionPrompt(conversationId)) return { error: "An exact approval is already awaiting YES or NO. Do not create another yet." };
        if (preparing.has(conversationId)) return { error: "Another marketplace quote is being prepared for this chat. Wait for its result." };
        preparing.add(conversationId);
        try {
        requestAttempts++;
        const sameServiceAttempts = (attemptsByService.get(serviceId) ?? 0) + 1;
        attemptsByService.set(serviceId, sameServiceAttempts);
        if (requestAttempts > 3 || sameServiceAttempts > 2) {
          return { error: "I could not prepare a payable call after several attempts. Stop retrying this service in this reply and explain the last specific blocker." };
        }
        const match = /^svc_(\d+)$/.exec(serviceId);
        const item = match ? catalog.get(conversationId)?.[Number(match[1]) - 1] : undefined;
        if (!item) return { error: "That service ID is not in this chat's search results. Search first." };
        if (stockResearchIntent(conversationId) && !financialService(item)) {
          return { error: "That service analyzes unrelated content. Search for stock, equity, or Google Finance data instead." };
        }
        const bodyJson = rawBody === undefined ? undefined :
          typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);
        const request = buildMarketplaceRequest(item, requestUrl, bodyJson);
        if (!request.ok) return { error: request.error };
        const { url, method, body } = request;
        const address = await getWalletAddress("BASE");
        if (!address) return { error: "Connect the Circle agent wallet first." };
        const choices = (item.accepts ?? []).map((a) => ({
          chain: CHAIN[a.network?.split(":")[1] ?? ""],
          rail: a.extra?.name?.includes("Gateway") ? "gateway" : "vanilla",
          price: Number(a.amount) / 1_000_000,
        })).filter((a) => a.chain && Number.isFinite(a.price) && a.price > 0 && a.price <= maxPrice());
        if (choices.length === 0) {
          return { error: `This listing has no supported route within the ${maxPrice()} USDC per-call limit. Search for a cheaper service.` };
        }
        choices.sort((a, b) => Number(b.rail === "gateway") - Number(a.rail === "gateway") || a.price - b.price);
        const balances = await availableChains(address, choices.some((a) => a.rail === "gateway"),
          choices.filter((a) => a.rail === "vanilla").map((a) => a.chain));
        const choice = choices.find((a) => (a.rail === "gateway" ? balances.gateway[a.chain] : balances.onchain[a.chain]) >= a.price);
        if (!choice) {
          const cheapest = [...choices].sort((a, b) => a.price - b.price)[0];
          const available = cheapest.rail === "gateway" ? balances.gateway[cheapest.chain] : balances.onchain[cheapest.chain];
          return { error: `${item.metadata?.provider?.name ?? "This service"} costs ${cheapest.price.toFixed(6)} USDC on ${cheapest.chain} via ${cheapest.rail}; that route has ${(available ?? 0).toFixed(6)} USDC available. Funds on another rail or chain cannot pay this route directly. Search for a cheaper service with a funded route.` };
        }
        const draft = { url, method, body, address, chain: choice.chain };
        const quote = await quoteCall(draft);
        if (!quote) return { error: "Could not get a live payment quote for this exact request. Nothing was paid." };
        if (Number(quote.price) > maxPrice() || Number(quote.price) > choice.price) {
          return { error: `Live price ${quote.price} USDC exceeds the listed price or per-call limit. Nothing was paid.` };
        }
        const plan: Pending = { ...draft, quote, provider: item.metadata?.provider?.name ?? new URL(url).hostname,
          serviceName: item.metadata?.description ?? "Marketplace service",
          purpose, created: Date.now(), prompt: "" };
        plan.prompt = approvalPrompt(plan);
        pending.set(conversationId, plan);
        return { needsConfirmation: true, message: plan.prompt };
        } finally {
          preparing.delete(conversationId);
        }
      },
    }),
  };
}

/** Start a broad stock report with market-wide data, before selecting tickers. */
export async function prepareBroadStockResearch(conversationId: string): Promise<string> {
  const tools = marketplaceTools(conversationId);
  const found = await tools.discoverServices.execute?.({ query: "google finance" }, {} as any) as
    | { services?: Array<{ id: string; description?: string }>; error?: string }
    | undefined;
  if (found?.error) return `I couldn't search the marketplace for broad stock data: ${found.error}`;
  const service = found?.services?.find((item) => item.description === "Live Google Finance Explore Advanced");
  if (!service) return "I couldn't find a current broad stock-market data service. Nothing was paid.";
  const prepared = await tools.requestMarketplaceCall.execute?.({
    serviceId: service.id,
    purpose: "Research the US stock market before selecting short- and long-term candidates for your report",
    bodyJson: JSON.stringify([{ location_code: 2840, language_name: "English" }]),
  }, {} as any) as { message?: string; error?: string } | undefined;
  return prepared?.message ?? `I couldn't prepare the broad market call: ${prepared?.error ?? "unknown error"}. Nothing was paid.`;
}

export function pendingMarketplacePrompt(conversationId: string): string | null {
  return pending.get(conversationId)?.prompt ?? null;
}

export function savedMarketplaceResultContext(conversationId: string): string | null {
  const latest = paidResults.get(conversationId)?.at(-1);
  if (!latest) return null;
  const preview = latest.data.slice(0, 8_000);
  const more = latest.data.length > preview.length
    ? ` Read the rest with readMarketplaceResult using resultId ${latest.id} and offset ${preview.length}.`
    : "";
  return `Use the previously approved and paid marketplace result ${latest.id}. Its saved response begins: ${preview}.${more} Do not pay again for this result. The response${latest.truncated ? " was truncated during capture" : " was captured in full"}.`;
}

/** A factual status report for the broad market snapshot, which contains no company thesis. */
export function savedMarketOverview(conversationId: string, correctPreviousEmailClaim = false): string | null {
  const latest = paidResults.get(conversationId)?.at(-1);
  if (!latest) return null;
  try {
    return formatMarketOverview(JSON.parse(latest.data), correctPreviousEmailClaim);
  } catch {
    return null;
  }
}

export function formatMarketOverview(data: any, correctPreviousEmailClaim = false): string | null {
  try {
    const task = data?.response?.tasks?.[0];
    const result = task?.result?.[0];
    if (data?.response?.status_code !== 20000 || task?.status_code !== 20000 ||
        result?.type !== "finance_explore" || !Array.isArray(result?.items)) return null;
    const sections = result.items as Array<Record<string, any>>;
    const hero = sections.find((item) => item.type === "google_finance_hero_groups");
    const us = hero?.markets?.find((market: any) => market.market === "US")?.items ?? [];
    const indexes = us.slice(0, 3).map((item: any) =>
      `- ${item.displayed_name}: ${Number(item.index_value).toLocaleString("en-US", { maximumFractionDigits: 2 })} (${Number(item.percentage_delta).toFixed(2)}%, ${item.timestamp})`
    );
    const earnings = sections.find((item) => item.type === "google_finance_earnings_calendar")?.items ?? [];
    const calendar = earnings.slice(0, 5).map((item: any) => {
      const ticker = /\/quote\/([^:/?]+)/.exec(item.url ?? "")?.[1] ?? "unknown";
      return `- ${ticker}: ${String(item.timestamp).slice(0, 10)}`;
    });
    const trends = sections.find((item) => item.type === "google_finance_market_trends")?.items;
    const active = (trends?.most_active ?? []).slice(0, 3).map((item: any) => item.quote)
      .filter((quote: any) => quote?.ticker)
      .map((quote: any) => `- ${quote.ticker}: $${Number(quote.price).toFixed(2)} (${Number(quote.percentage_delta).toFixed(2)}%, ${quote.timestamp})`);
    const paid = data.payment?.amount ?? "the approved amount";
    const emailStatus = correctPreviousEmailClaim
      ? "I need to correct my last message: no email service was called, so there was no email-service error. The report has not been emailed.\n\n"
      : "Email status: no email service has been called, and the report has not been emailed.\n\n";
    return emailStatus +
      `What the approved ${paid} AIsa market-data call returned (${result.datetime}):\n` +
      `US market indexes\n${indexes.join("\n") || "No index values returned."}\n\n` +
      `Most-active examples\n${active.join("\n") || "No stock quotes returned."}\n\n` +
      `Upcoming earnings listed by the service\n${calendar.join("\n") || "No earnings dates returned."}\n\n` +
      `This is a market snapshot, not a completed short-term or long-term investment thesis. It does not include the company fundamentals, valuation, recent filings, and risk analysis needed to rank stocks responsibly. I have saved the full paid response and will use it without paying again. A finished report and a separately approved email send are still pending.\n\nSource: AIsa API / DataForSEO Google Finance Explore, captured ${result.datetime}.`;
  } catch {
    return null;
  }
}

export async function handleMarketplaceReply(conversationId: string, text: string): Promise<{ handled: boolean; reply?: string; result?: string }> {
  if (inFlight.has(conversationId)) return { handled: true, reply: "That approved call is already running." };
  const plan = pending.get(conversationId);
  if (!plan) {
    const recent = recentDecision.get(conversationId);
    if (text.trim().toLowerCase() === "yes" && recent && Date.now() - recent.at < TTL_MS) {
      return { handled: true, reply: recent.reply };
    }
    return { handled: false };
  }
  if (Date.now() - plan.created > TTL_MS) {
    pending.delete(conversationId);
    if (/^(?:yes|y)$/i.test(text.trim())) return { handled: true, reply: "That approval expired. Ask me to prepare the marketplace call again." };
    return { handled: false };
  }
  const answer = text.trim().toLowerCase();
  if (answer === "details") {
    return { handled: true, reply: `Technical request for the pending approval:\n${plan.method} ${plan.url}${plan.body ? `\nBody: ${plan.body}` : ""}\nQuoted maximum: ${plan.quote.price} USDC on ${plan.quote.chain}. Reply YES or NO.` };
  }
  if (["no", "n", "cancel"].includes(answer)) {
    pending.delete(conversationId);
    return { handled: true, reply: "Cancelled. No marketplace payment was made." };
  }
  if (!["yes", "y"].includes(answer)) {
    pending.delete(conversationId);
    return { handled: false };
  }
  inFlight.add(conversationId);
  pending.delete(conversationId); // consume before any payment, so duplicate webhooks cannot pay twice
  recentDecision.set(conversationId, { at: Date.now(), reply: "That approval was already used. I won't pay twice." });
  try {
    const latest = await quoteCall(plan);
    if (!latest || latest.price !== plan.quote.price || latest.chain !== plan.quote.chain ||
        latest.scheme !== plan.quote.scheme || latest.seller.toLowerCase() !== plan.quote.seller.toLowerCase()) {
      return { handled: true, reply: "The marketplace quote changed or could not be verified. I did not pay. Ask me to prepare the call again." };
    }
    const args = ["services", "pay", plan.url, "--address", plan.address, "--chain", plan.chain,
      "-X", plan.method, "--max-amount", plan.quote.price, "--timeout", "60"];
    if (plan.body !== undefined) args.push("--data", plan.body);
    const paid = await cli(args, 90_000);
    if (!paid.ok) {
      return { handled: true, reply: `The paid request failed: ${paid.error}. I will not retry it automatically because payment may have been submitted. Check Circle payment history before retrying.` };
    }
    const fullResult = JSON.stringify(redactSecrets(paid.data?.data ?? paid.data));
    const resultId = randomUUID();
    const captured = fullResult.slice(0, 1_000_000);
    const prior = paidResults.get(conversationId) ?? [];
    prior.push({ id: resultId, data: captured, truncated: captured.length < fullResult.length,
      provider: plan.provider, serviceName: plan.serviceName, purpose: plan.purpose });
    paidResults.set(conversationId, prior.slice(-5));
    try {
      persistPaidResults();
    } catch (error) {
      console.error("Could not persist a paid marketplace response:", error instanceof Error ? error.message : "unknown error");
    }
    const preview = captured.slice(0, 8_000);
    const more = captured.length > preview.length
      ? ` The response continues. Call readMarketplaceResult with resultId ${resultId} and offset ${preview.length} to read more without paying again.`
      : "";
    const captureNote = captured.length < fullResult.length
      ? " The seller response exceeded the capture limit; do not claim to have analyzed the omitted portion." : "";
    return { handled: true, result: `The owner approved and Friday called ${plan.provider} (${plan.method} ${plan.url}). Quoted maximum cost: ${plan.quote.price} USDC via ${plan.quote.scheme} on ${plan.chain}. Service response preview: ${preview}.${more}${captureNote} Continue the owner's original task using this real result. Report the service, cost, and any outcome or failure accurately.` };
  } finally {
    inFlight.delete(conversationId);
  }
}
