import { tool } from "ai";
import { z } from "zod";
import { exec } from "child_process";
import axios from "axios";
import { config } from "../../config.js";

/**
 * Run a circle CLI command and return parsed JSON output.
 */
function circleCmd(
  args: string
): Promise<{ success: boolean; data: unknown; raw: string }> {
  return new Promise((resolve) => {
    exec(
      `circle ${args} --output json`,
      { timeout: 30_000, env: { ...process.env, FORCE_COLOR: "0" } },
      (error, stdout, stderr) => {
        const raw = stdout?.toString() ?? stderr?.toString() ?? "";
        try {
          const data = JSON.parse(raw);
          resolve({ success: !error, data, raw });
        } catch {
          resolve({ success: !error, data: null, raw });
        }
      }
    );
  });
}

/**
 * Get the agent wallet address for a given chain.
 * Uses `circle wallet list --type agent --chain <chain>`.
 */
export async function getWalletAddress(chain = "BASE"): Promise<string | null> {
  const result = await circleCmd(`wallet list --type agent --chain ${chain}`);
  if (!result.success) return null;
  const d = result.data as { data?: { wallets?: Array<{ address: string }> } };
  return d?.data?.wallets?.[0]?.address ?? null;
}

// ─── Check Wallet Balance ─────────────────────────────────────────────────────

// ─── Check Wallet Balance ─────────────────────────────────────────────────────

export const checkWalletBalance = tool({
  description:
    "Check the agent's USDC wallet balance via Circle CLI. Returns balance, wallet address, and chain. Use when the user asks about balance or funds.",
  inputSchema: z.object({
    chain: z
      .string()
      .optional()
      .default("BASE")
      .describe(
        "Blockchain to check balance on. Valid values: BASE, ETH, MATIC (Polygon), ARB (Arbitrum), AVAX (Avalanche), OP (Optimism), UNI (Unichain). Default: BASE"
      ),
  }),
  execute: async ({ chain }) => {
    const chainName = chain ?? "BASE";
    const address = await getWalletAddress(chainName);
    if (!address) {
      return {
        error: `No agent wallet found on ${chainName}. Say 'create my wallet' to set one up.`,
      };
    }
    const result = await circleCmd(
      `wallet balance --chain ${chainName} --address ${address}`
    );
    if (!result.success) {
      return {
        error: `Could not query balance on ${chainName} right now.`,
        raw: result.raw,
      };
    }
    const balances =
      (result.data as { data?: { balances?: Array<{ amount: string; token: { symbol: string } }> } })
        ?.data?.balances ?? [];
    if (balances.length === 0) {
      // Query succeeded but the wallet holds no tokens on this chain.
      // Be explicit so the model reports "zero" rather than "unavailable / try again".
      return {
        chain: chainName,
        address,
        empty: true,
        message: `The wallet holds no tokens on ${chainName} (balance is 0). Funds may be on another chain such as BASE.`,
        balances: [],
      };
    }
    return {
      chain: chainName,
      address,
      balances: balances.map((b) => ({ amount: b.amount, symbol: b.token.symbol })),
    };
  },
});

// ─── Check Gateway (Nanopayments) Balance ─────────────────────────────────────

export const checkGatewayBalance = tool({
  description:
    "Check the agent's Circle GATEWAY balance (the cross-chain USDC nanopayments pool used to pay for x402 marketplace services). This is DIFFERENT from the on-chain wallet balance: use this when the user asks about their Gateway balance, nanopayments balance, or 'how much can I spend on services'. It reports a unified total plus a per-chain breakdown.",
  inputSchema: z.object({}),
  execute: async () => {
    const address = await getWalletAddress("BASE");
    if (!address) {
      return { error: "No agent wallet found. Say 'create my wallet' to set one up." };
    }
    // Gateway balance is cross-chain; --chain just names where the wallet lives.
    // --all includes zero-balance chains so we can show a full picture.
    const result = await circleCmd(
      `gateway balance --address ${address} --chain BASE --all`
    );
    if (!result.success) {
      return {
        error: "Could not read Gateway balance right now.",
        raw: result.raw,
      };
    }
    const d = (result.data as {
      data?: {
        total?: string;
        token?: string;
        balances?: Array<{ network: string; balance: string }>;
      };
    })?.data;
    const nonZero = (d?.balances ?? []).filter((b) => Number(b.balance) > 0);
    return {
      total: d?.total ?? "0",
      token: d?.token ?? "USDC",
      byChain: nonZero.length > 0 ? nonZero : "All chains are zero",
      note: "This is the Gateway nanopayments balance, used to pay for x402 services — separate from the on-chain wallet balance.",
    };
  },
});

// ─── Total Balance (computed in code, never by the model) ─────────────────────

// USDC has 6 decimals. We sum in integer micro-USDC to avoid float drift,
// then format back to a 6-decimal string.
const USDC_DECIMALS = 6;
const MICRO = 10 ** USDC_DECIMALS;

// On-chain chains with a default public RPC in the Circle CLI (ETH has none).
const ONCHAIN_CHAINS = ["BASE", "MATIC", "ARB"] as const;

function toMicro(amount: string | number): number {
  return Math.round(Number(amount) * MICRO);
}

function fromMicro(micro: number): string {
  return (micro / MICRO).toFixed(USDC_DECIMALS);
}

/** On-chain USDC (in micro-USDC) held by `address` on a single chain. */
async function onchainUsdcMicro(address: string, chain: string): Promise<number> {
  const result = await circleCmd(`wallet balance --chain ${chain} --address ${address}`);
  if (!result.success) return 0;
  const balances =
    (result.data as { data?: { balances?: Array<{ amount: string; token: { symbol: string } }> } })
      ?.data?.balances ?? [];
  return balances
    .filter((b) => b.token.symbol === "USDC")
    .reduce((sum, b) => sum + toMicro(b.amount), 0);
}

/** Gateway (nanopayments) USDC total, in micro-USDC. */
async function gatewayUsdcMicro(address: string): Promise<number> {
  const result = await circleCmd(`gateway balance --address ${address} --chain BASE --all`);
  if (!result.success) return 0;
  const total = (result.data as { data?: { total?: string } })?.data?.total ?? "0";
  return toMicro(total);
}

// ─── Chain mapping (x402 network id <-> Circle CLI --chain value) ─────────────
// Only mainnet chains the CLI can actually pay on.
const NETWORK_TO_CLI_CHAIN: Record<string, string> = {
  "1": "ETH",
  "137": "MATIC",
  "42161": "ARB",
  "8453": "BASE",
};
// Gateway "domain" number -> CLI chain, for reading the per-chain Gateway split.
const GATEWAY_DOMAIN_TO_CLI: Record<number, string> = {
  0: "ETH",
  3: "ARB",
  6: "BASE",
  7: "MATIC",
};

/** Gateway balance per CLI chain, in micro-USDC (e.g. { MATIC: 2442076 }). */
async function gatewayBalancesByChain(address: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const result = await circleCmd(`gateway balance --address ${address} --chain BASE --all`);
  if (!result.success) return out;
  const balances =
    (result.data as { data?: { balances?: Array<{ domain: number; balance: string }> } })
      ?.data?.balances ?? [];
  for (const b of balances) {
    const cli = GATEWAY_DOMAIN_TO_CLI[b.domain];
    if (cli) out[cli] = toMicro(b.balance);
  }
  return out;
}

interface Inspection {
  payable: boolean;
  method: string;
  priceMicro: number;
  cliChains: string[]; // seller-accepted chains the CLI can pay on
  rawChains: string[]; // all seller-accepted networks (for messaging)
  scheme: string;
  raw: string;
}

interface Accept {
  network: string; // e.g. "eip155:137"
  amount: string; // micro-USDC
  extra?: { name?: string };
}

/**
 * Fetch the raw 402 challenge to read ALL accepts with per-chain scheme.
 * `extra.name === "GatewayWalletBatched"` means that accept is Gateway;
 * anything else (usually "USD Coin") means vanilla on-chain x402.
 * Uses the seller's real HTTP method so the 402 is actually returned.
 */
function fetchAccepts(url: string, method: string): Promise<Accept[]> {
  const m = (method || "GET").toUpperCase();
  const bodyArgs =
    m === "GET" ? "" : ` -X ${m} -H 'Content-Type: application/json' -d '{}'`;
  const cmd = `curl -sS --max-time 20${bodyArgs} "${url}"`;
  return new Promise((resolve) => {
    exec(cmd, { timeout: 25_000 }, (_error, stdout) => {
      try {
        const body = JSON.parse(stdout?.toString() ?? "");
        resolve(Array.isArray(body?.accepts) ? (body.accepts as Accept[]) : []);
      } catch {
        resolve([]);
      }
    });
  });
}

/** Inspect an x402 endpoint: price, accepted chains, HTTP method, scheme. */
async function inspectService(url: string): Promise<Inspection | null> {
  const result = await circleCmd(`services inspect "${url}"`);
  const d = (result.data as {
    data?: {
      status?: string;
      httpStatus?: number;
      method?: string;
      price?: { amount?: string };
      chains?: string[];
      scheme?: string;
    };
  })?.data;
  if (!d) return null;
  const rawChains = d.chains ?? [];
  const cliChains = rawChains
    .map((n) => NETWORK_TO_CLI_CHAIN[n.split(":")[1] ?? ""])
    .filter((c): c is string => Boolean(c));
  return {
    payable: d.httpStatus === 402 || d.status === "payable",
    method: (d.method ?? "GET").toUpperCase(),
    priceMicro: Number(d.price?.amount ?? 0),
    cliChains,
    rawChains,
    scheme: d.scheme ?? "",
    raw: result.raw,
  };
}

export type TotalBalance =
  | { error: string }
  | {
      totalUsdc: string;
      gatewayUsdc: string;
      onchainUsdc: string;
      onchainByChain: Array<{ chain: string; usdc: string }> | "none";
      note: string;
    };

/**
 * Compute the exact total USDC balance (Gateway + on-chain) in code.
 * Shared by the getTotalBalance tool and the /total slash command so the
 * number is never produced by the model's arithmetic.
 */
export async function computeTotalBalance(): Promise<TotalBalance> {
  const address = await getWalletAddress("BASE");
  if (!address) {
    return { error: "No agent wallet found. Say 'create my wallet' to set one up." };
  }
  const [gatewayMicro, ...chainMicros] = await Promise.all([
    gatewayUsdcMicro(address),
    ...ONCHAIN_CHAINS.map((c) => onchainUsdcMicro(address, c)),
  ]);
  const onchainByChain = ONCHAIN_CHAINS.map((chain, i) => ({
    chain,
    usdc: fromMicro(chainMicros[i]),
  })).filter((c) => Number(c.usdc) > 0);
  const onchainMicro = chainMicros.reduce((a, b) => a + b, 0);
  const totalMicro = gatewayMicro + onchainMicro;
  return {
    totalUsdc: fromMicro(totalMicro),
    gatewayUsdc: fromMicro(gatewayMicro),
    onchainUsdc: fromMicro(onchainMicro),
    onchainByChain: onchainByChain.length > 0 ? onchainByChain : "none",
    note: "Total is computed exactly in code (Gateway + on-chain USDC). Report totalUsdc verbatim.",
  };
}

export const getTotalBalance = tool({
  description:
    "Compute the user's TOTAL USDC balance: the Gateway nanopayments balance plus on-chain USDC across supported chains. Use this whenever the user asks for their 'total balance', 'how much do I have altogether', or 'net worth'. The total is summed exactly in code — never estimate or add balances yourself.",
  inputSchema: z.object({}),
  execute: async () => computeTotalBalance(),
});

// ─── Get Wallet Status ────────────────────────────────────────────────────────

export const getWalletStatus = tool({
  description:
    "Get the agent wallet address and status. Use when the user asks for their wallet address or wants to fund the agent. Returns address, chain, and auth status.",
  inputSchema: z.object({}),
  execute: async () => {
    const address = await getWalletAddress("BASE");
    const authResult = await circleCmd("wallet status");
    return {
      address: address ?? "No wallet found — say 'create my wallet' to set one up",
      chain: "BASE",
      auth: authResult.data,
    };
  },
});

// ─── Pay for a Marketplace Service ────────────────────────────────────────────

/** Run `circle services pay` for a specific chain and return parsed result. */
function runPay(
  serviceUrl: string,
  address: string,
  chain: string,
  method: string,
  maxAmountUsdc: string,
  data?: string
): Promise<{ success: boolean; data?: unknown; error?: string; command: string }> {
  const dataArg = data && method !== "GET" ? ` --data '${data}'` : "";
  // --timeout gives slow marketplace servers room to respond after payment is
  // authorized, reducing "paid but no response" timeouts on flaky networks.
  const cmd = `circle services pay "${serviceUrl}" --address ${address} --chain ${chain} -X ${method}${dataArg} --max-amount ${maxAmountUsdc} --timeout 60 --output json`;
  return new Promise((resolve) => {
    exec(
      cmd,
      { timeout: 90_000, env: { ...process.env, FORCE_COLOR: "0" } },
      (error, stdout, stderr) => {
        const raw = stdout?.toString() ?? stderr?.toString() ?? "";
        if (error) {
          resolve({ success: false, error: `Payment failed: ${raw}`, command: cmd });
        } else {
          try {
            resolve({ success: true, data: JSON.parse(raw), command: cmd });
          } catch {
            resolve({ success: true, data: raw, command: cmd });
          }
        }
      }
    );
  });
}

type PreparedPayment =
  | { ok: false; error: string }
  | {
      ok: true;
      address: string;
      chain: string;
      rail: "gateway" | "vanilla";
      method: string;
      priceMicro: number;
    };

/**
 * Inspect an x402 seller, read its true per-chain scheme, check both balance
 * pools, and choose a chain + rail that can actually pay (Gateway preferred).
 * Does NOT pay. Shared by payForService and webSearch.
 */
export async function preparePayment(
  serviceUrl: string,
  method?: string
): Promise<PreparedPayment> {
  const address = await getWalletAddress("BASE");
  if (!address) {
    return { ok: false, error: "No agent wallet found. Set up your Circle wallet first." };
  }
  const insp = await inspectService(serviceUrl);
  if (!insp) {
    return { ok: false, error: "Could not inspect that service. Check the URL is a valid x402 endpoint." };
  }
  if (!insp.payable) {
    return { ok: false, error: "That endpoint is not a payable x402 service (no 402 challenge)." };
  }
  if (insp.cliChains.length === 0) {
    return {
      ok: false,
      error: `The seller only accepts chains this CLI cannot pay on yet (${insp.rawChains.join(", ")}). Try a different provider.`,
    };
  }

  // Build candidates from the RAW accepts so we know the true scheme per chain.
  const raw = await fetchAccepts(serviceUrl, method ?? insp.method);
  type Candidate = { chain: string; rail: "gateway" | "vanilla"; amountMicro: number };
  let candidates: Candidate[] = [];
  if (raw.length > 0) {
    candidates = raw
      .map((a): Candidate | null => {
        const chain = NETWORK_TO_CLI_CHAIN[a.network.split(":")[1] ?? ""];
        if (!chain) return null;
        const isGateway = (a.extra?.name ?? "").includes("Gateway");
        return { chain, rail: isGateway ? "gateway" : "vanilla", amountMicro: Number(a.amount) };
      })
      .filter((c): c is Candidate => c !== null);
  } else {
    const rail: "gateway" | "vanilla" = insp.scheme.includes("Gateway") ? "gateway" : "vanilla";
    candidates = insp.cliChains.map((chain) => ({ chain, rail, amountMicro: insp.priceMicro }));
  }

  // Prefer Gateway (instant, draws the cross-chain pool), else vanilla on-chain.
  const gwByChain = await gatewayBalancesByChain(address);
  let choice: Candidate | null =
    candidates.find((c) => c.rail === "gateway" && (gwByChain[c.chain] ?? 0) >= c.amountMicro) ?? null;
  if (!choice) {
    for (const c of candidates.filter((x) => x.rail === "vanilla")) {
      const vanilla = await onchainUsdcMicro(address, c.chain);
      if (vanilla >= c.amountMicro) {
        choice = c;
        break;
      }
    }
  }

  if (!choice) {
    const gwSummary =
      Object.entries(gwByChain)
        .filter(([, m]) => m > 0)
        .map(([c, m]) => `${c} Gateway ${fromMicro(m)}`)
        .join(", ") || "none";
    const accepted = candidates.map((c) => `${c.chain} ${c.rail} ${fromMicro(c.amountMicro)}`).join(", ");
    return {
      ok: false,
      error: `Not enough funds. Seller accepts: ${accepted}. Your Gateway balances: ${gwSummary}. Fund the wallet (vanilla) or Gateway on a chain the seller accepts.`,
    };
  }

  return {
    ok: true,
    address,
    chain: choice.chain,
    rail: choice.rail,
    method: insp.method,
    priceMicro: choice.amountMicro,
  };
}

export const payForService = tool({
  description: `Pay for an x402 marketplace service using the agent's Circle wallet. It inspects the seller, checks BOTH balance pools (on-chain USDC and Gateway) per chain, prefers Gateway when available, and pays on a chain that actually works.

TWO-STEP: First call this with confirmed=false (or omit it). It returns a plan (price, chain, rail) WITHOUT paying. Tell the user the cost and which balance it will use, get their explicit "yes", THEN call again with confirmed=true. NEVER call with confirmed=true unless the user just approved.`,
  inputSchema: z.object({
    serviceUrl: z.string().describe("The URL of the x402-enabled service to pay and call"),
    data: z
      .string()
      .optional()
      .describe("JSON body to send to the service, if it needs one"),
    confirmed: z
      .boolean()
      .optional()
      .default(false)
      .describe("Set true ONLY after the user has explicitly approved the exact cost. False returns a plan without paying."),
  }),
  execute: async ({ serviceUrl, data, confirmed }) => {
    const plan = await preparePayment(serviceUrl);
    if (!plan.ok) return { error: plan.error };
    const priceUsdc = fromMicro(plan.priceMicro);

    if (!confirmed) {
      return {
        needsConfirmation: true,
        service: serviceUrl,
        priceUsdc,
        chain: plan.chain,
        rail: plan.rail,
        message: `Ready to pay ${priceUsdc} USDC for this service, using your ${plan.rail} balance on ${plan.chain}. Reply yes to confirm, then I will call it again to pay.`,
      };
    }

    const result = await runPay(serviceUrl, plan.address, plan.chain, plan.method, priceUsdc, data);
    return { ...result, paidUsdc: priceUsdc, chain: plan.chain, rail: plan.rail };
  },
});

// ─── Web Search (paid via marketplace x402) ───────────────────────────────────

/** Pull a results array out of a paid search response, tolerant of wrapping. */
function extractSearchResults(
  payData: unknown
): Array<{ title?: string; url?: string; content?: string }> {
  const d = payData as Record<string, unknown> | null;
  // Try the common wrapped paths first (Circle CLI wraps under data; aisa under response).
  const known = [
    (d as any)?.data?.response?.results,
    (d as any)?.response?.results,
    (d as any)?.data?.results,
    (d as any)?.results,
  ];
  for (const c of known) if (Array.isArray(c)) return c;
  // Fallback: first array of objects that look like search hits.
  let found: any[] | null = null;
  const walk = (o: any): void => {
    if (found) return;
    if (Array.isArray(o)) {
      if (o.length && o[0] && typeof o[0] === "object" && ("url" in o[0] || "title" in o[0])) {
        found = o;
        return;
      }
      o.forEach(walk);
    } else if (o && typeof o === "object") {
      for (const k of Object.keys(o)) {
        walk(o[k]);
        if (found) return;
      }
    }
  };
  walk(d);
  return found ?? [];
}

/**
 * Free web search via the Brave Search API. Returns results, or null if no key
 * is set or the request fails (so the caller can fall back to the marketplace).
 */
async function braveSearch(
  query: string
): Promise<Array<{ title?: string; url?: string; content?: string }> | null> {
  const key = config.BRAVE_SEARCH_API_KEY;
  if (!key) return null;
  try {
    const res = await axios.get("https://api.search.brave.com/res/v1/web/search", {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
      params: { q: query, count: 5 },
      timeout: 15_000,
    });
    const results = (res.data?.web?.results ?? []) as Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
    if (results.length === 0) return null;
    return results.map((r) => ({
      title: r.title,
      url: r.url,
      content: (r.description ?? "").slice(0, 300),
    }));
  } catch {
    return null;
  }
}

export const webSearch = tool({
  description:
    "Search the web for current information, news, facts, prices, or anything you may not know or that could have changed. Free when a Brave key is set, otherwise a small pre-authorized USDC fee via the marketplace. Prefer this over answering from memory for anything current or factual.",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
    topic: z
      .enum(["general", "news", "finance"])
      .optional()
      .describe("Search category. Use 'news' for current events, 'finance' for markets. Default general."),
    confirmed: z
      .boolean()
      .optional()
      .default(false)
      .describe("Only needed if a search costs more than the auto-pay cap. Set true after the user approves the higher cost."),
  }),
  execute: async ({ query, topic, confirmed }) => {
    // Try free Brave search first; fall back to the paid marketplace on miss.
    const brave = await braveSearch(query);
    if (brave && brave.length > 0) {
      return { query, source: "brave", costUsdc: "0", results: brave.slice(0, 5) };
    }

    const url = config.SEARCH_SERVICE_URL;
    const body = JSON.stringify({ query, topic: topic ?? "general" });

    const plan = await preparePayment(url);
    if (!plan.ok) return { error: plan.error };
    const priceUsdc = fromMicro(plan.priceMicro);

    // Small searches auto-pay (user opted into pay-per-search). Pricier ones ask.
    const capMicro = Math.round(config.SEARCH_MAX_AUTO_USDC * MICRO);
    if (plan.priceMicro > capMicro && !confirmed) {
      return {
        needsConfirmation: true,
        priceUsdc,
        message: `This search costs ${priceUsdc} USDC, above the ${config.SEARCH_MAX_AUTO_USDC} auto-pay cap. Say yes to run it.`,
      };
    }

    const paid = await runPay(url, plan.address, plan.chain, plan.method, priceUsdc, body);
    if (!paid.success) return { error: `Search failed: ${paid.error}` };

    const results = extractSearchResults(paid.data)
      .slice(0, 5)
      .map((r) => ({
        title: r.title,
        url: r.url,
        content: (r.content ?? "").slice(0, 300),
      }));
    if (results.length === 0) {
      return { query, costUsdc: priceUsdc, note: "Search returned no parseable results.", raw: paid.data };
    }
    return { query, costUsdc: priceUsdc, paidVia: `${plan.rail} on ${plan.chain}`, results };
  },
});

// ─── X / Twitter account analysis (paid via marketplace) ──────────────────────

const TWITTER_API_BASE = "https://api.aisa.one/apis/v2/twitter";

/** Auto-pay a small x402 call (under the search cap) and return the parsed body. */
async function autoPaidCall(
  url: string,
  data?: string
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const plan = await preparePayment(url);
  if (!plan.ok) return { ok: false, error: plan.error };
  const capMicro = Math.round(config.SEARCH_MAX_AUTO_USDC * MICRO);
  if (plan.priceMicro > capMicro) {
    return {
      ok: false,
      error: `That call costs ${fromMicro(plan.priceMicro)} USDC, above the ${config.SEARCH_MAX_AUTO_USDC} auto-pay cap.`,
    };
  }
  const paid = await runPay(url, plan.address, plan.chain, plan.method, fromMicro(plan.priceMicro), data);
  if (!paid.success) return { ok: false, error: paid.error ?? "payment failed" };
  return { ok: true, data: paid.data };
}

/** Unwrap the Circle CLI ({data}) + aisa ({response}) wrapping to the inner payload. */
function unwrapResponse(payData: unknown): any {
  const d = payData as any;
  return d?.data?.response ?? d?.response ?? d?.data ?? d;
}

export const analyzeXAccount = tool({
  description:
    "Fetch REAL data about an X (Twitter) account: profile stats and recent tweets with engagement. Use this whenever the user asks to analyze, look up, or get info about an X/Twitter account or handle. It pays a tiny USDC fee (auto-approved). Return real numbers from this tool, never make up X data or give generic advice.",
  inputSchema: z.object({
    username: z.string().describe("The X/Twitter handle, with or without @, e.g. '_OxAde'"),
    includeTweets: z
      .boolean()
      .optional()
      .default(true)
      .describe("Also fetch recent tweets for content and engagement analysis"),
  }),
  execute: async ({ username, includeTweets }) => {
    const handle = username.trim().replace(/^@/, "");
    if (!handle) return { error: "Give me an X handle to look up." };

    const profRes = await autoPaidCall(
      `${TWITTER_API_BASE}/user/info?userName=${encodeURIComponent(handle)}`
    );
    if (!profRes.ok) return { error: profRes.error };
    const p = unwrapResponse(profRes.data)?.data ?? {};
    if (!p?.userName) {
      return { error: `Could not find X account @${handle}. Check the handle is right.` };
    }
    const profile = {
      name: p.name,
      handle: p.userName,
      bio: p.description,
      blueVerified: p.isBlueVerified,
      followers: p.followers,
      following: p.following,
      totalTweets: p.statusesCount,
      likesGiven: p.favouritesCount,
      mediaPosts: p.mediaCount,
      createdAt: p.createdAt,
      location: p.location || undefined,
    };

    let recentTweets: unknown;
    let tweetsNote: string | undefined;
    if (includeTweets) {
      const tRes = await autoPaidCall(
        `${TWITTER_API_BASE}/user/last_tweets?userName=${encodeURIComponent(handle)}`
      );
      if (!tRes.ok) {
        tweetsNote = `Could not fetch recent tweets: ${tRes.error}`;
      } else {
        const arr = unwrapResponse(tRes.data)?.data?.tweets ?? [];
        if (Array.isArray(arr) && arr.length > 0) {
          recentTweets = arr.slice(0, 10).map((t: any) => ({
            text: (t.text ?? "").slice(0, 280),
            likes: t.likeCount,
            retweets: t.retweetCount,
            replies: t.replyCount,
            views: t.viewCount,
            createdAt: t.createdAt,
            isReply: t.isReply,
          }));
        } else {
          tweetsNote = "No recent tweets returned for this account.";
        }
      }
    }

    return {
      profile,
      recentTweets,
      tweetsNote,
      note: "Real data from X via the paid marketplace. Analyze these actual numbers and tweets. Do not add generic advice unless asked.",
    };
  },
});

// ─── Crypto price (accurate, via CoinGecko marketplace) ───────────────────────

const CRYPTO_PRICE_URL = "https://api.aisa.one/apis/v2/coingecko/simple/price";

// Common tickers/names to CoinGecko IDs. Unknown inputs pass through lowercased.
const TICKER_TO_ID: Record<string, string> = {
  btc: "bitcoin",
  eth: "ethereum",
  ether: "ethereum",
  sol: "solana",
  usdc: "usd-coin",
  usdt: "tether",
  tether: "tether",
  bnb: "binancecoin",
  xrp: "ripple",
  doge: "dogecoin",
  ada: "cardano",
  matic: "matic-network",
  polygon: "matic-network",
  pol: "matic-network",
  avax: "avalanche-2",
  link: "chainlink",
  dot: "polkadot",
  ltc: "litecoin",
  arb: "arbitrum",
  op: "optimism",
};

function toCoinId(s: string): string {
  const k = s.trim().toLowerCase();
  return TICKER_TO_ID[k] ?? k.replace(/\s+/g, "-");
}

export const getCryptoPrice = tool({
  description:
    "Get the current price of one or more cryptocurrencies from CoinGecko (accurate, single authoritative source). Use this for ANY crypto price question instead of web search. Pays a tiny USDC fee (auto). Accepts names or tickers like 'bitcoin', 'btc', or 'eth, sol'.",
  inputSchema: z.object({
    coins: z
      .string()
      .describe("One or more coins, comma-separated. Names or tickers, e.g. 'bitcoin' or 'btc, eth, sol'"),
    vsCurrency: z
      .string()
      .optional()
      .default("usd")
      .describe("Fiat currency, e.g. usd, eur, gbp. Default usd."),
  }),
  execute: async ({ coins, vsCurrency }) => {
    const ids = coins.split(",").map(toCoinId).filter(Boolean).join(",");
    if (!ids) return { error: "Give me at least one coin, e.g. bitcoin." };
    const vs = (vsCurrency ?? "usd").toLowerCase();
    const url =
      `${CRYPTO_PRICE_URL}?ids=${encodeURIComponent(ids)}&vs_currencies=${encodeURIComponent(vs)}` +
      `&include_24hr_change=true&include_market_cap=true`;

    const res = await autoPaidCall(url);
    if (!res.ok) return { error: res.error };

    const body = unwrapResponse(res.data) ?? {};
    const prices: Record<string, unknown> = {};
    for (const [coin, v] of Object.entries(body)) {
      if (coin === "payment" || !v || typeof v !== "object") continue;
      const o = v as Record<string, number>;
      const change = o[`${vs}_24h_change`];
      prices[coin] = {
        price: o[vs],
        currency: vs.toUpperCase(),
        marketCap: o[`${vs}_market_cap`],
        change24h: typeof change === "number" ? `${change.toFixed(2)}%` : undefined,
      };
    }
    if (Object.keys(prices).length === 0) {
      return { error: `No price data for "${coins}". Use a valid coin name or ticker.`, raw: body };
    }
    return { prices, source: "CoinGecko", note: "Accurate single-source price. Report these numbers exactly." };
  },
});

// ─── Discover Marketplace Services ────────────────────────────────────────────

export const discoverServices = tool({
  description:
    "Search for available services on the Circle Agent Marketplace. Returns services the agent can pay for with USDC to complete tasks it can't handle internally.",
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe("What kind of service are you looking for? e.g. 'web scraping', 'phone calls', 'image generation'"),
  }),
  execute: async ({ query }) => {
    const args = query
      ? `services search "${query}"`
      : "services list";
    const result = await circleCmd(args);
    if (!result.success) {
      return {
        error:
          "Could not search marketplace. Circle CLI may not be installed. Try: npm install -g @circle-fin/cli@latest",
        raw: result.raw,
      };
    }
    return result.data;
  },
});
