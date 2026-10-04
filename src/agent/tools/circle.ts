import { tool } from "ai";
import { z } from "zod";
import { exec, execFile } from "child_process";
import { fileURLToPath } from "url";
import axios from "axios";
import { config } from "../../config.js";
import { usdcTokenAmount } from "./usdc-balance.js";

const localCircleBin = fileURLToPath(new URL("../../../node_modules/.bin/circle", import.meta.url));

/**
 * Run a circle CLI command and return parsed JSON output.
 */
function circleCmd(
  args: string
): Promise<{ success: boolean; data: unknown; raw: string }> {
  return new Promise((resolve) => {
    exec(
      `${localCircleBin} ${args} --output json`,
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
  return new Promise((resolve) => {
    execFile(localCircleBin, ["wallet", "list", "--type", "agent", "--chain", chain, "--output", "json"],
      { timeout: 30_000, env: { ...process.env, FORCE_COLOR: "0", NODE_NO_WARNINGS: "1" } },
      (error, stdout) => {
        if (error) return resolve(null);
        try {
          const result = JSON.parse(stdout) as { data?: { wallets?: Array<{ address?: string }> } };
          const address = result.data?.wallets?.[0]?.address;
          resolve(typeof address === "string" && /^0x[a-fA-F0-9]{40}$/.test(address) ? address : null);
        } catch { resolve(null); }
      });
  });
}

// ─── Check Wallet Balance (all chains) ──────────────────────────────────────

const ALL_CLI_CHAINS = ["ARC", "BASE", "MATIC", "ARB", "ETH", "AVAX", "OP"] as const;

export const checkWalletBalance = tool({
  description:
    "Check the agent's on-chain USDC wallet balance across ARC, BASE, MATIC, ARB, ETH, AVAX, and OP in parallel. Use when the user asks about balance or wallet funds. Returns a total only when all chains succeed.",
  inputSchema: z.object({
    chain: z
      .string()
      .optional()
      .describe("Optional: specific chain to highlight. If omitted, all chains are shown."),
  }),
  execute: async () => {
    const address = await getWalletAddress("BASE");
    if (!address) {
      return { error: "No agent wallet found. Say 'create my wallet' to set one up." };
    }

    // Query all chains in parallel
    const results = await Promise.all(
      ALL_CLI_CHAINS.map(async (c) => {
        const r = await circleCmd(`wallet balance --chain ${c} --address ${address}`);
        if (!r.success) return { chain: c, usdc: "0", error: r.raw };
        const bals =
          (r.data as { data?: { balances?: Array<{ amount: string; token: { symbol: string } }> } })
            ?.data?.balances ?? [];
        return { chain: c, usdc: usdcTokenAmount(bals) ?? "0" };
      })
    );
    const failures = results.filter((r) => "error" in r);
    if (failures.length) {
      return { error: "Could not verify every on-chain balance; no total was computed.", failures };
    }

    const nonZero = results.filter((r) => Number(r.usdc) > 0);
    const totalMicro = results.reduce((sum, r) => sum + toMicro(r.usdc), 0);

    return {
      address,
      onchainByChain: results,
      nonZeroChains: nonZero.length > 0 ? nonZero : "No on-chain USDC found on any chain",
      totalOnchainUsdc: fromMicro(totalMicro),
      note: "On-chain balances only. Run checkGatewayBalance to see Gateway (service payment) funds separately.",
    };
  },
});

// ─── Check Gateway (Nanopayments) Balance ─────────────────────────────────────

export const checkGatewayBalance = tool({
  description:
    "Check the agent's Circle GATEWAY USDC balance. Gateway funds can pay supported x402 services and can be transferred to an on-chain wallet with a Gateway withdrawal or crosschain transfer. They cannot be used as a direct on-chain wallet send or swap balance. Use this for Gateway, service spending, or transfer availability questions. It reports a unified total plus a per-chain breakdown.",
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
      note: "Gateway can pay supported x402 services or fund a Gateway transfer to an on-chain wallet. It is separate from directly spendable on-chain wallet USDC.",
    };
  },
});

// ─── Gateway Withdraw (Gateway → on-chain wallet) ─────────────────────────────

export const gatewayWithdraw = tool({
  description:
    "Withdraw USDC from the Circle Gateway nanopayments pool back to the on-chain wallet. Use when the user asks to move/withdraw/transfer funds FROM the Gateway TO their wallet on a specific chain. Requires explicit user confirmation before executing — tell them the amount and destination chain, and only proceed when they say yes.",
  inputSchema: z.object({
    amount: z.string().describe("Amount of USDC to withdraw, e.g. '1' or '0.5'"),
    chain: z
      .string()
      .default("BASE")
      .describe("Chain to withdraw to (BASE, MATIC, ARB, AVAX, OP). Default: BASE"),
    confirmed: z
      .boolean()
      .default(false)
      .describe("Set true only after the user has explicitly confirmed the withdrawal"),
  }),
  execute: async ({ amount, chain, confirmed }) => {
    if (!confirmed) {
      return {
        needsConfirmation: true,
        message: `This will withdraw ${amount} USDC from Gateway to your ${chain} on-chain wallet. Reply yes to confirm.`,
      };
    }
    const address = await getWalletAddress("BASE");
    if (!address) return { error: "No agent wallet found." };

    const result = await circleCmd(
      `gateway withdraw --amount ${amount} --address ${address} --chain ${chain}`
    );
    if (!result.success) {
      return { error: `Withdrawal failed: ${result.raw}` };
    }
    return {
      success: true,
      message: `Withdrew ${amount} USDC from Gateway to your ${chain} wallet.`,
      data: result.data,
    };
  },
});

// ─── Gateway Deposit (on-chain wallet → Gateway) ──────────────────────────────

export const gatewayDeposit = tool({
  description:
    "Deposit USDC from the on-chain wallet into the Circle Gateway nanopayments pool. Use when the user asks to top up, fund, or move funds INTO the Gateway from their on-chain wallet. Requires explicit user confirmation.",
  inputSchema: z.object({
    amount: z.string().describe("Amount of USDC to deposit, e.g. '1' or '0.5'"),
    chain: z
      .string()
      .default("BASE")
      .describe("Chain to deposit from (BASE, MATIC, ARB, AVAX, OP). Default: BASE"),
    confirmed: z
      .boolean()
      .default(false)
      .describe("Set true only after the user has explicitly confirmed the deposit"),
  }),
  execute: async ({ amount, chain, confirmed }) => {
    if (!confirmed) {
      return {
        needsConfirmation: true,
        message: `This will deposit ${amount} USDC from your ${chain} on-chain wallet into the Gateway. Reply yes to confirm.`,
      };
    }
    const address = await getWalletAddress("BASE");
    if (!address) return { error: "No agent wallet found." };

    const result = await circleCmd(
      `gateway deposit --amount ${amount} --address ${address} --chain ${chain}`
    );
    if (!result.success) {
      return { error: `Deposit failed: ${result.raw}` };
    }
    return {
      success: true,
      message: `Deposited ${amount} USDC from your ${chain} wallet into the Gateway.`,
      data: result.data,
    };
  },
});

// ─── Total Balance (computed in code, never by the model) ─────────────────────

// USDC has 6 decimals. We sum in integer micro-USDC to avoid float drift,
// then format back to a 6-decimal string.
const USDC_DECIMALS = 6;
const MICRO = 10 ** USDC_DECIMALS;

// On-chain chains the Circle CLI can query (has public RPC support).
const ONCHAIN_CHAINS = ALL_CLI_CHAINS;

function toMicro(amount: string | number): number {
  return Math.round(Number(amount) * MICRO);
}

function fromMicro(micro: number): string {
  return (micro / MICRO).toFixed(USDC_DECIMALS);
}

/** On-chain USDC (in micro-USDC) held by `address` on a single chain. */
async function onchainUsdcMicro(address: string, chain: string): Promise<number> {
  const result = await circleCmd(`wallet balance --chain ${chain} --address ${address}`);
  if (!result.success) throw new Error(`Could not check ${chain} on-chain balance: ${result.raw}`);
  const balances =
    (result.data as { data?: { balances?: Array<{ amount: string; token: { symbol: string } }> } })
      ?.data?.balances ?? [];
  return toMicro(usdcTokenAmount(balances) ?? "0");
}

/** Gateway USDC total and its funding chains, from the same verified response. */
async function gatewayUsdcSnapshot(address: string): Promise<{ totalMicro: number; byChain: Array<{ chain: string; usdc: string }> }> {
  const result = await circleCmd(`gateway balance --address ${address} --chain BASE --all`);
  if (!result.success) throw new Error(`Could not check Gateway balance: ${result.raw}`);
  const data = (result.data as { data?: { total?: string; balances?: Array<{ domain: number; balance: string }> } })?.data;
  if (!data || typeof data.total !== "string" || !/^\d+(?:\.\d{1,6})?$/.test(data.total) || !Array.isArray(data.balances)) {
    throw new Error("Circle returned an incomplete Gateway balance.");
  }
  const byChain = data.balances
    .filter((item) => GATEWAY_DOMAIN_TO_CLI[item.domain] && /^\d+(?:\.\d{1,6})?$/.test(item.balance) && Number(item.balance) > 0)
    .map((item) => ({ chain: GATEWAY_DOMAIN_TO_CLI[item.domain], usdc: item.balance }));
  return { totalMicro: toMicro(data.total), byChain };
}

// ─── Chain mapping (x402 network id <-> Circle CLI --chain value) ─────────────
// Only mainnet chains the CLI can actually pay on.
const NETWORK_TO_CLI_CHAIN: Record<string, string> = {
  "1":     "ETH",
  "137":   "MATIC",   // Polygon
  "42161": "ARB",     // Arbitrum
  "8453":  "BASE",    // Base
  "43114": "AVAX",    // Avalanche
  "10":    "OP",      // Optimism
  "130":   "UNI",     // Unichain
};
// Gateway "domain" number -> CLI chain, for reading the per-chain Gateway split.
const GATEWAY_DOMAIN_TO_CLI: Record<number, string> = {
  0: "ETH",
  1: "AVAX",
  2: "OP",
  3: "ARB",
  6: "BASE",
  7: "MATIC",
  10: "UNI",
  26: "ARC",
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
      gatewayByChain: Array<{ chain: string; usdc: string }>;
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
  let gateway: { totalMicro: number; byChain: Array<{ chain: string; usdc: string }> };
  let chainMicros: number[];
  try {
    [gateway, ...chainMicros] = await Promise.all([
      gatewayUsdcSnapshot(address),
      ...ONCHAIN_CHAINS.map((c) => onchainUsdcMicro(address, c)),
    ]);
  } catch (error) {
    return { error: (error as Error).message };
  }
  const onchainByChain = ONCHAIN_CHAINS.map((chain, i) => ({
    chain,
    usdc: fromMicro(chainMicros[i]),
  })).filter((c) => Number(c.usdc) > 0);
  const onchainMicro = chainMicros.reduce((a, b) => a + b, 0);
  const totalMicro = gateway.totalMicro + onchainMicro;
  return {
    totalUsdc: fromMicro(totalMicro),
    gatewayUsdc: fromMicro(gateway.totalMicro),
    gatewayByChain: gateway.byChain,
    onchainUsdc: fromMicro(onchainMicro),
    onchainByChain: onchainByChain.length > 0 ? onchainByChain : "none",
    note: "Total is computed exactly in code (Gateway + on-chain USDC). Report totalUsdc verbatim.",
  };
}

export function formatTotalBalance(balance: Exclude<TotalBalance, { error: string }>): string {
  const onchain = Array.isArray(balance.onchainByChain)
    ? balance.onchainByChain.map((item) => `${item.chain}: ${item.usdc} USDC`).join("\n")
    : "No on-chain USDC found";
  const gateway = balance.gatewayByChain.length
    ? balance.gatewayByChain.map((item) => `${item.chain}: ${item.usdc} USDC`).join("\n")
    : "No Gateway USDC found";
  return [
    "Current verified USDC balances", "",
    "On-chain wallet", onchain,
    `On-chain total: ${balance.onchainUsdc} USDC`, "",
    "Gateway", gateway,
    `Gateway total: ${balance.gatewayUsdc} USDC`, "",
    `Combined total: ${balance.totalUsdc} USDC`,
  ].join("\n");
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
  const command = "circle services pay";
  let url: URL;
  try {
    url = new URL(serviceUrl);
  } catch {
    return Promise.resolve({ success: false, error: "Invalid service URL.", command });
  }
  if (url.protocol !== "https:" || url.username || url.password ||
      !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method) ||
      !/^0x[a-fA-F0-9]{40}$/.test(address) ||
      !/^(?:ETH|AVAX|OP|ARB|BASE|MATIC|UNI)$/.test(chain) ||
      !/^\d+(?:\.\d{1,6})?$/.test(maxAmountUsdc)) {
    return Promise.resolve({ success: false, error: "Invalid service payment parameters.", command });
  }
  const args = ["services", "pay", serviceUrl, "--address", address, "--chain", chain, "-X", method];
  if (data && method !== "GET") args.push("--data", data);
  // The CLI timeout allows the service to respond after payment settles.
  args.push("--max-amount", maxAmountUsdc, "--timeout", "60", "--output", "json");
  const circleBin = fileURLToPath(new URL("../../../node_modules/.bin/circle", import.meta.url));
  return new Promise((resolve) => {
    execFile(
      circleBin,
      args,
      { timeout: 90_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: "0" } },
      (error, stdout, stderr) => {
        const raw = stdout?.toString() ?? stderr?.toString() ?? "";
        if (error) {
          resolve({ success: false, error: `Payment failed: ${raw.slice(0, 500)}`, command });
        } else {
          try {
            resolve({ success: true, data: JSON.parse(raw), command });
          } catch {
            resolve({ success: true, data: raw, command });
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
  }),
  execute: async ({ query, topic }) => {
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
    if (plan.priceMicro > capMicro) {
      return {
        error: `This search costs ${priceUsdc} USDC, above the ${config.SEARCH_MAX_AUTO_USDC} USDC automatic-payment cap. Use the marketplace call flow for an exact WhatsApp approval. No payment was made.`,
        priceUsdc,
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
    if (query && !/^[a-zA-Z0-9 ._-]{1,80}$/.test(query)) {
      return { error: "Service search supports letters, numbers, spaces, periods, underscores, and hyphens only." };
    }
    const args = query
      ? `services search "${query}"`
      : "services search";
    const result = await circleCmd(args);
    if (!result.success) {
      return {
        error:
          "Could not search the Circle marketplace right now.",
        raw: result.raw,
      };
    }
    return result.data;
  },
});
