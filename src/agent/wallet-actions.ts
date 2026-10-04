import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tool } from "ai";
import { z } from "zod";
import { getWalletAddress } from "./tools/circle.js";
import { usdcTokenAmount } from "./tools/usdc-balance.js";
import { pendingMarketplacePrompt } from "./marketplace.js";

const bin = fileURLToPath(new URL("../../node_modules/.bin/circle", import.meta.url));
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const amountPattern = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/;
const chains = ["ARC", "BASE", "MATIC", "ARB", "ETH", "AVAX", "OP", "UNI"] as const;
type Chain = typeof chains[number];
type Action = {
  kind: "send" | "bridge" | "swap" | "gateway-deposit" | "gateway-sweep" | "gateway-withdraw" | "gateway-transfer" | "gateway-mint-recovery";
  args: string[];
  prompt: string;
  created: number;
  maxFeeMicro?: bigint;
  swapFloor?: string;
  swapQuoteArgs?: string[];
  deposits?: Array<{ chain: Chain; address: string; amountUsdc: string }>;
  gatewayTransfer?: {
    sourceChain: Chain;
    destinationChain: Chain;
    sourceAddress: string;
    destinationWallet: string;
    backingEoa: string;
    recipient: string;
    amountUsdc: string;
    forwarded: boolean;
  };
};
const pending = new Map<string, Action>();
const running = new Set<string>();
const consumed = new Map<string, number>();
const ttl = 10 * 60_000;
const gatewayDomains: Partial<Record<Chain, number>> = {
  ETH: 0, AVAX: 1, OP: 2, ARB: 3, BASE: 6, MATIC: 7, UNI: 10, ARC: 26,
};
const explorerBases: Partial<Record<Chain, string>> = {
  ARC: "https://explorer.arc.io/tx/",
  BASE: "https://basescan.org/tx/",
  MATIC: "https://polygonscan.com/tx/",
  ARB: "https://arbiscan.io/tx/",
  ETH: "https://etherscan.io/tx/",
  AVAX: "https://subnets.avax.network/c-chain/tx/",
  OP: "https://optimistic.etherscan.io/tx/",
  UNI: "https://unichain.blockscout.com/tx/",
};
const gatewayWalletContract = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
const gatewayMinterContract = "0x2222222d7164433c4C09B0b0D809a9b52C04C205";
// A modest Arc gas preflight, not a quote for the gatewayMint transaction.
const minArcMintGasReserveMicro = 20_000n;

type Cli = { ok: boolean; data?: any; error?: string };
function cli(args: string[], timeout = 45_000): Promise<Cli> {
  return new Promise((resolve) => {
    execFile(bin, [...args, "--output", "json"], {
      timeout, maxBuffer: 1_000_000,
      env: { ...process.env, FORCE_COLOR: "0", NODE_NO_WARNINGS: "1" },
    }, (error, stdout) => {
      let parsed: any;
      try { parsed = JSON.parse(stdout); } catch { /* CLI error may have no JSON. */ }
      resolve({ ok: !error && !!parsed && !parsed.error, data: parsed?.data,
        error: parsed?.error?.message ?? (error ? "Circle CLI could not complete the request" : "Invalid Circle response") });
    });
  });
}

function chainOf(input: string): Chain | null {
  const chain = input.toUpperCase();
  return (chains as readonly string[]).includes(chain) ? chain as Chain : null;
}

function validAmount(input: string): boolean {
  return amountPattern.test(input) && Number(input) > 0 && Number(input) <= 25;
}

function toMicro(input: string): bigint {
  const [whole, fraction = ""] = input.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function fromMicro(amount: bigint): string {
  return `${amount / 1_000_000n}.${String(amount % 1_000_000n).padStart(6, "0")}`;
}

function argAfter(args: string[], flag: string): string {
  return args[args.indexOf(flag) + 1] ?? "";
}

function explorerUrl(chain: Chain, hash: unknown): string | null {
  return typeof hash === "string" && /^0x[a-fA-F0-9]{64}$/.test(hash)
    ? `${explorerBases[chain]}${hash}` : null;
}

async function arcNetworkFee(hash: unknown): Promise<string | null> {
  if (typeof hash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(hash)) return null;
  try {
    const response = await fetch("https://rpc.mainnet.arc.io/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionReceipt", params: [hash], id: 1 }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const result = await response.json() as { result?: { gasUsed?: string; effectiveGasPrice?: string; status?: string } };
    const receipt = result.result;
    if (!receipt || receipt.status !== "0x1" || !/^0x[a-fA-F0-9]+$/.test(receipt.gasUsed ?? "") ||
        !/^0x[a-fA-F0-9]+$/.test(receipt.effectiveGasPrice ?? "")) return null;
    const wei = BigInt(receipt.gasUsed!) * BigInt(receipt.effectiveGasPrice!);
    const whole = wei / 10n ** 18n;
    const fraction = String(wei % 10n ** 18n).padStart(18, "0").replace(/0+$/, "");
    return `${whole}${fraction ? `.${fraction}` : ""}`;
  } catch { return null; }
}

function estimatedNetworkFee(chain: Chain, fee: unknown): string {
  if (typeof fee !== "string" || !/^\d+(?:\.\d+)?$/.test(fee)) return "unavailable";
  const unit = chain === "ARC" ? "USDC" : chain === "MATIC" ? "POL" : chain === "AVAX" ? "AVAX" : "ETH";
  const rounded = Math.ceil(Number(fee) * 1_000_000) / 1_000_000;
  return `about ${rounded.toFixed(6)} ${unit}`;
}

function bytes32(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

type GatewayEstimate = { maxFeeMicro: bigint; maxBlockHeight: string; spec: Record<string, string | number> };
export function parseGatewayEstimate(payload: unknown): { maxFeeMicro: bigint; maxBlockHeight: string } | null {
  const body = Array.isArray(payload) ? payload : (payload as any)?.body;
  const burnIntent = Array.isArray(body) ? body[0]?.burnIntent : null;
  const maxFee = burnIntent?.maxFee, maxBlockHeight = burnIntent?.maxBlockHeight;
  return typeof maxFee === "string" && /^\d+$/.test(maxFee) &&
    typeof maxBlockHeight === "string" && /^\d+$/.test(maxBlockHeight)
    ? { maxFeeMicro: BigInt(maxFee), maxBlockHeight } : null;
}
async function gatewayEstimate(source: Chain, destination: Chain, backingEoa: string, recipient: string, amountUsdc: string, forwarded = false): Promise<GatewayEstimate | null> {
  const sourceDomain = gatewayDomains[source], destinationDomain = gatewayDomains[destination];
  if (sourceDomain === undefined || destinationDomain === undefined ||
      !addressPattern.test(backingEoa) || !addressPattern.test(recipient)) return null;
  const [sourceContract, destinationContract] = await Promise.all([
    cli(["contract", "address", "usdc", "--chain", source]),
    source === destination ? Promise.resolve(null) : cli(["contract", "address", "usdc", "--chain", destination]),
  ]);
  const sourceUsdc = sourceContract.data?.contracts?.find((entry: any) => entry.contract === "USDC")?.address;
  const destinationUsdc = destinationContract === null ? sourceUsdc
    : destinationContract.data?.contracts?.find((entry: any) => entry.contract === "USDC")?.address;
  if (!sourceContract.ok || (destinationContract !== null && !destinationContract.ok) ||
      !addressPattern.test(sourceUsdc ?? "") || !addressPattern.test(destinationUsdc ?? "")) return null;
  const spec = {
    version: 1, sourceDomain, destinationDomain,
    sourceContract: bytes32(gatewayWalletContract), destinationContract: bytes32(gatewayMinterContract),
    sourceToken: bytes32(sourceUsdc), destinationToken: bytes32(destinationUsdc),
    sourceDepositor: bytes32(backingEoa), destinationRecipient: bytes32(recipient),
    sourceSigner: bytes32(backingEoa), destinationCaller: `0x${"0".repeat(64)}`,
    value: toMicro(amountUsdc).toString(), salt: `0x${randomBytes(32).toString("hex")}`, hookData: "0x",
  };
  try {
    const response = await fetch(`https://gateway-api.circle.com/v1/estimate${forwarded ? "?enableForwarder=true" : ""}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ spec }]), signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json() as unknown;
    if (!response.ok) return null;
    const quote = parseGatewayEstimate(payload);
    return quote ? { ...quote, spec } : null;
  } catch {
    return null;
  }
}

const gatewayTypes = {
  EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }],
  TransferSpec: [
    { name: "version", type: "uint32" }, { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" }, { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" }, { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" }, { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" }, { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" }, { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" }, { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" }, { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
};

type GatewayRecovery = {
  transferId: string;
  sourceChain: Chain;
  destinationChain: Chain;
  destinationWallet: string;
  recipient: string;
  amountUsdc: string;
  attestation: string;
  signature: string;
  feeUsdc: string;
  mintTxHash?: string;
};
const gatewayRecoveryFile = path.resolve(process.cwd(), ".data", "gateway-recoveries.json");

async function loadGatewayRecoveries(): Promise<GatewayRecovery[]> {
  try {
    const data = JSON.parse(await fs.readFile(gatewayRecoveryFile, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

async function saveGatewayRecovery(record: GatewayRecovery): Promise<void> {
  await fs.mkdir(path.dirname(gatewayRecoveryFile), { recursive: true });
  const current = await loadGatewayRecoveries();
  const updated = current.filter((item) => item.transferId !== record.transferId);
  updated.push(record);
  const temporary = `${gatewayRecoveryFile}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(updated, null, 2), { mode: 0o600 });
  await fs.rename(temporary, gatewayRecoveryFile);
}

async function mintGatewayRecovery(record: GatewayRecovery, proofSaved = true): Promise<string> {
  const mint = await cli(["wallet", "execute", "gatewayMint(bytes,bytes)", record.attestation, record.signature,
    "--contract", gatewayMinterContract, "--address", record.destinationWallet, "--chain", record.destinationChain,
    "--idempotency-key", randomUUID()], 150_000);
  const hash = mint.data?.txHash ?? mint.data?.transactionHash;
  if (!mint.ok || typeof hash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(hash)) {
    return `Gateway accepted the transfer (ID ${record.transferId}), but the ${record.destinationChain} mint is not confirmed. Do not start another Gateway transfer.` +
      (proofSaved ? " The mint proof is saved for recovery. Ask Friday to resume the Gateway mint." :
        " The local recovery file could not be saved; keep this transfer ID for support.");
  }
  record.mintTxHash = hash;
  try { await saveGatewayRecovery(record); } catch { /* Receipt still includes the confirmed hash. */ }
  return gatewayTransferReceipt(record);
}

export function gatewayTransferReceipt(record: GatewayRecovery): string {
  const fee = amountPattern.test(record.feeUsdc) ? toMicro(record.feeUsdc) : 0n;
  const amount = toMicro(record.amountUsdc);
  const link = record.mintTxHash ? explorerUrl(record.destinationChain, record.mintTxHash) : null;
  return [
    "Gateway transfer complete", "",
    `From: Gateway on ${record.sourceChain}`,
    `To: ${record.recipient} on ${record.destinationChain}`,
    `Recipient received: ${record.amountUsdc} USDC`,
    `Gateway fee charged: ${record.feeUsdc} USDC`,
    `Total debited from Gateway: ${fromMicro(amount + fee)} USDC`,
    `Transfer ID: ${record.transferId}`, "",
    `Mint transaction: ${record.mintTxHash ?? "not yet confirmed"}`,
    ...(link ? [`View transaction: ${link}`] : []),
  ].join("\n");
}

type GatewayStatus = { status?: string; destinationDomain?: number; transactionHash?: string; fees?: { total?: string }; forwardingDetails?: { failureReason?: string } };
async function gatewayTransferStatus(transferId: string): Promise<GatewayStatus | null> {
  if (!/^[0-9a-fA-F-]{36}$/.test(transferId)) return null;
  try {
    const response = await fetch(`https://gateway-api.circle.com/v1/transfer/${transferId}`, {
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? await response.json() as GatewayStatus : null;
  } catch { return null; }
}

function gatewayForwardedReceipt(transferId: string, source: Chain, destination: Chain,
  recipient: string, amountUsdc: string, details: GatewayStatus | null, acceptedFee: string | null): string {
  const confirmed = details?.status === "confirmed" || details?.status === "finalized";
  const hash = confirmed ? details?.transactionHash : null;
  const link = explorerUrl(destination, hash);
  const fee = details?.fees?.total ?? acceptedFee;
  return [
    confirmed ? "Gateway transfer complete" : details?.status === "failed" || details?.status === "expired"
      ? "Gateway transfer needs attention" : "Gateway transfer accepted", "",
    `From: Gateway on ${source}`,
    `To: ${recipient} on ${destination}`,
    `${confirmed ? "Recipient received" : "Amount to recipient"}: ${amountUsdc} USDC`,
    ...(fee && amountPattern.test(fee)
      ? [`Gateway fee charged: ${fee} USDC`, `Total debited from Gateway: ${fromMicro(toMicro(amountUsdc) + toMicro(fee))} USDC`]
      : ["Gateway fee: check transfer status for final charge."]),
    `Status: ${details?.status ?? "pending verification"}`,
    ...(details?.forwardingDetails?.failureReason ? [`Reason: ${details.forwardingDetails.failureReason}`] : []),
    `Transfer ID: ${transferId}`,
    ...(hash ? [`Mint transaction: ${hash}`] : []),
    ...(link ? [`View transaction: ${link}`] : []),
    ...(!confirmed ? ["Ask Friday to check this Gateway transfer ID before retrying or claiming it finished."] : []),
  ].join("\n");
}

async function executeGatewayTransfer(action: Action): Promise<string> {
  const transfer = action.gatewayTransfer;
  if (!transfer) return "The Gateway transfer details are missing. Nothing was moved.";
  const { sourceChain, destinationChain, sourceAddress, destinationWallet, backingEoa, recipient, amountUsdc } = transfer;
  const available = await cli(["gateway", "balance", "--address", sourceAddress, "--chain", sourceChain, "--all"]);
  const sourceBalance = available.data?.balances?.find((entry: any) => entry.domain === gatewayDomains[sourceChain])?.balance;
  if (!available.ok || available.data?.backingEOA?.toLowerCase() !== backingEoa.toLowerCase() ||
      typeof sourceBalance !== "string" || !amountPattern.test(sourceBalance) ||
      toMicro(sourceBalance) < toMicro(amountUsdc) + (action.maxFeeMicro ?? 0n)) {
    return "The Gateway source balance changed or could not be verified. Nothing was moved.";
  }
  if (destinationChain === "ARC") {
    const arcGasBalance = await balance(destinationChain, destinationWallet);
    if (arcGasBalance === null || arcGasBalance < minArcMintGasReserveMicro) {
      return "The Arc wallet has less than 0.02 on-chain USDC for mint gas, or I could not verify it. Nothing was moved.";
    }
  }
  const estimate = await gatewayEstimate(sourceChain, destinationChain, backingEoa, recipient, amountUsdc, transfer.forwarded);
  if (!estimate || estimate.maxFeeMicro > (action.maxFeeMicro ?? 0n)) {
    return "The Gateway fee changed above your approved maximum, or no live quote was available. Nothing was moved.";
  }
  if (toMicro(sourceBalance) < toMicro(amountUsdc) + estimate.maxFeeMicro) {
    return "The Gateway balance no longer covers the transfer amount and quoted fee. Nothing was moved.";
  }
  const burnIntent = {
    maxBlockHeight: estimate.maxBlockHeight,
    maxFee: estimate.maxFeeMicro.toString(),
    spec: estimate.spec,
  };
  const typedData = {
    types: gatewayTypes,
    domain: { name: "GatewayWallet", version: "1" },
    primaryType: "BurnIntent",
    message: burnIntent,
  };
  const signed = await cli(["wallet", "sign", "typed-data", JSON.stringify(typedData),
    "--address", sourceAddress, "--chain", sourceChain], 90_000);
  const burnSignature = signed.data?.signature;
  if (!signed.ok || typeof burnSignature !== "string" || !/^0x[a-fA-F0-9]+$/.test(burnSignature)) {
    return "Circle could not sign the Gateway transfer. Nothing was moved.";
  }
  let accepted: any;
  try {
    const response = await fetch(`https://gateway-api.circle.com/v1/transfer${transfer.forwarded ? "?enableForwarder=true" : ""}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ burnIntent, signature: burnSignature }]),
      signal: AbortSignal.timeout(30_000),
    });
    accepted = await response.json();
    if (!response.ok || accepted?.success === false || accepted?.error) {
      return "Gateway rejected the transfer. No mint was submitted. Check your Gateway balance before trying again.";
    }
  } catch {
    return "Gateway did not confirm whether it accepted the transfer. I will not retry automatically; check your Gateway balance before trying again.";
  }
  if (transfer.forwarded) {
    const transferId = accepted?.transferId;
    if (typeof transferId !== "string") {
      return "Gateway accepted a forwarded transfer but returned no transfer ID. Do not retry automatically; check Gateway transfer history.";
    }
    const fee = typeof accepted.fees?.total === "string" ? accepted.fees.total : null;
    let details: GatewayStatus | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      details = await gatewayTransferStatus(transferId);
      if (details?.status === "confirmed" || details?.status === "finalized" ||
          details?.status === "failed" || details?.status === "expired") break;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    return gatewayForwardedReceipt(transferId, sourceChain, destinationChain, recipient, amountUsdc, details, fee);
  }
  if (typeof accepted?.transferId !== "string" || typeof accepted?.attestation !== "string" ||
      typeof accepted?.signature !== "string" || !/^0x[a-fA-F0-9]+$/.test(accepted.attestation) ||
      !/^0x[a-fA-F0-9]+$/.test(accepted.signature)) {
    return "Gateway accepted a transfer but returned an incomplete mint proof. Do not retry the burn; check Gateway transfer history.";
  }
  const record: GatewayRecovery = {
    transferId: accepted.transferId, sourceChain, destinationChain, destinationWallet, recipient, amountUsdc,
    attestation: accepted.attestation, signature: accepted.signature,
    feeUsdc: typeof accepted.fees?.total === "string" ? accepted.fees.total : fromMicro(estimate.maxFeeMicro),
  };
  let proofSaved = true;
  try { await saveGatewayRecovery(record); } catch { proofSaved = false; }
  return mintGatewayRecovery(record, proofSaved);
}

export function walletReceipt(action: Pick<Action, "kind" | "args">, receipt: any): string {
  const chain = chainOf(argAfter(action.args, "--chain"));
  const amount = argAfter(action.args, "--amount") || (action.kind === "swap" ? action.args[3] : "");
  const sourceHash = receipt?.depositTxHash ?? receipt?.burnTxHash ?? receipt?.txHash ?? receipt?.transactionHash ?? receipt?.mintTxHash ??
    receipt?.transactions?.at(-1)?.txHash ?? receipt?.id ?? receipt?.transactionId;
  const status = receipt?.status ?? receipt?.state ?? (action.kind === "swap" ? "Complete" : "Submitted");
  const title = action.kind === "send" ? "USDC sent" : action.kind === "swap" ? "Token swap complete"
    : action.kind === "bridge" ? "CCTP bridge" : action.kind === "gateway-deposit" ? "Gateway deposit submitted" : "Gateway withdrawal complete";
  const lines = [title, "", `Amount: ${amount} USDC`, `Network: ${chain ?? "unknown"}`];
  if (action.kind === "send") lines.push(`To: ${action.args[2]}`);
  if (action.kind === "bridge") lines.push(`Destination network: ${action.args[2]}`, `To: ${action.args[3]}`);
  if (action.kind === "gateway-withdraw") {
    lines.push(`To: ${argAfter(action.args, "--recipient")}`);
    if (receipt?.chargedFee?.total) lines.push(`Gateway fee charged: ${receipt.chargedFee.total} USDC`);
  }
  if (action.kind === "gateway-deposit") {
    lines.push("Gateway credit appears after source-chain confirmations.");
    if (receipt?.approveTxHash) lines.push(`USDC approval: ${receipt.approveTxHash}`);
  }
  if (action.kind === "swap") lines.push(`Received token: ${action.args[4]}`);
  if (receipt?.actualNetworkFeeUsdc) lines.push(`Network fee paid: ${receipt.actualNetworkFeeUsdc} USDC`);
  lines.push(`Status: ${status}`, "", `Transaction: ${sourceHash ?? "Circle returned no transaction ID"}`);
  if (chain) {
    const link = explorerUrl(chain, sourceHash);
    if (link) lines.push(`View transaction: ${link}`);
  }
  if (action.kind === "bridge" && receipt?.forwardTxHash) {
    const destination = chainOf(action.args[2]);
    const link = destination ? explorerUrl(destination, receipt.forwardTxHash) : null;
    lines.push("", `Destination mint: ${receipt.forwardTxHash}`);
    if (link) lines.push(`View destination mint: ${link}`);
  }
  return lines.join("\n");
}

export function minimumSwapOutput(quoted: string): string | null {
  if (!/^\d+(?:\.\d{1,18})?$/.test(quoted)) return null;
  const [whole, decimal = ""] = quoted.split(".");
  const places = Math.max(decimal.length, 6);
  const scale = 10n ** BigInt(places);
  const raw = BigInt(whole) * scale + BigInt(decimal.padEnd(places, "0"));
  const floor = raw * 99n / 100n;
  if (floor <= 0n) return null;
  return `${floor / scale}.${String(floor % scale).padStart(places, "0")}`;
}

async function balance(chain: Chain, address: string): Promise<bigint | null> {
  const result = await cli(["wallet", "balance", "--chain", chain, "--address", address]);
  if (!result.ok) return null;
  const value = usdcTokenAmount(result.data?.balances);
  return value !== null ? toMicro(value) : 0n;
}

async function onchainSources(toCheck: readonly Chain[] = chains): Promise<Array<{ chain: Chain; address: string; available: bigint }>> {
  const sources = await Promise.all(toCheck.map(async (chain) => {
    const address = await getWalletAddress(chain);
    if (!address) return null;
    const available = await balance(chain, address);
    return available === null ? null : { chain, address, available };
  }));
  return sources.filter((item): item is { chain: Chain; address: string; available: bigint } => item !== null);
}

function stage(conversationId: string, action: Action) {
  if (pending.has(conversationId) || pendingMarketplacePrompt(conversationId)) {
    return { error: "Another exact approval is already awaiting YES or NO." };
  }
  pending.set(conversationId, action);
  return { needsConfirmation: true, message: action.prompt };
}

export function pendingWalletActionPrompt(conversationId: string): string | null {
  return pending.get(conversationId)?.prompt ?? null;
}

export function walletApprovalWord(text: string): string {
  // Accept a simple "Yes 👍🏻" without treating extra instructions as approval.
  return text.toLowerCase()
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D\s.,!?]/gu, "")
    .trim();
}

export function walletActionTools(conversationId: string) {
  return {
    prepareUsdcSend: tool({
      description: "Preview an on-chain USDC send. Never transfers until the owner replies YES to the exact destination, chain, and amount.",
      inputSchema: z.object({ chain: z.string(), toAddress: z.string(), amountUsdc: z.string() }),
      execute: async ({ chain: rawChain, toAddress, amountUsdc }) => {
        if (pending.has(conversationId) || pendingMarketplacePrompt(conversationId)) return { error: "Another exact approval is already awaiting YES or NO." };
        const chain = chainOf(rawChain);
        if (!chain || !addressPattern.test(toAddress) || !validAmount(amountUsdc)) {
          return { error: "I need a supported chain, EVM destination address, and 0-25 USDC amount." };
        }
        const address = await getWalletAddress(chain);
        if (!address) return { error: "The Circle agent wallet is unavailable; connect it first." };
        const available = await balance(chain, address);
        if (available === null) return { error: "I could not verify the source balance. Nothing was sent." };
        if (available < toMicro(amountUsdc)) return { error: `Only ${fromMicro(available)} on-chain USDC is available on ${chain}. Nothing was sent.` };
        const contract = await cli(["contract", "address", "usdc", "--chain", chain]);
        const token = contract.data?.contracts?.find((entry: any) => entry.contract === "USDC")?.address;
        if (!contract.ok || !addressPattern.test(token ?? "")) return { error: "Could not resolve official USDC contract. Nothing was sent." };
        const args = ["wallet", "transfer", toAddress, "--amount", amountUsdc, "--token", token,
          "--address", address, "--chain", chain];
        const estimate = await cli([...args, "--estimate"]);
        if (!estimate.ok) return { error: `Could not estimate this USDC send: ${estimate.error}. Nothing was sent.` };
        const fee = estimate.data?.medium?.networkFee;
        if (chain === "ARC" && typeof fee === "string" && /^\d+(?:\.\d+)?$/.test(fee)) {
          const feeMicro = BigInt(Math.ceil(Number(fee) * 1_000_000));
          if (available < toMicro(amountUsdc) + feeMicro) {
            return { error: `This Arc send needs about ${fromMicro(toMicro(amountUsdc) + feeMicro)} USDC including network gas, but only ${fromMicro(available)} USDC is on-chain. Nothing was sent.` };
          }
        }
        const prompt = [
          "USDC transfer", "",
          `Amount: ${amountUsdc} USDC`, `Network: ${chain}`,
          `From: ${address}`, `To: ${toAddress}`,
          `Estimated network fee: ${estimatedNetworkFee(chain, fee)} (may change).`, "",
          "Reply YES to send once, or NO to cancel. Expires in 10 minutes.",
        ].join("\n");
        return stage(conversationId, { kind: "send", args, prompt, created: Date.now() });
      },
    }),
    prepareUsdcBridge: tool({
      description: "Preview a CCTP USDC bridge from one chain to another. The amount is what the recipient receives; source spends amount plus quoted fees. Requires exact YES before execution.",
      inputSchema: z.object({ fromChain: z.string(), toChain: z.string(), amountUsdc: z.string(), recipient: z.string().optional() }),
      execute: async ({ fromChain: rawFrom, toChain: rawTo, amountUsdc, recipient }) => {
        if (pending.has(conversationId) || pendingMarketplacePrompt(conversationId)) return { error: "Another exact approval is already awaiting YES or NO." };
        const from = chainOf(rawFrom), to = chainOf(rawTo);
        if (!from || !to || from === to || !validAmount(amountUsdc) ||
            (recipient !== undefined && !addressPattern.test(recipient))) {
          return { error: "I need two different supported chains, a valid recipient, and 0-25 USDC." };
        }
        const address = await getWalletAddress(from);
        if (!address) return { error: "The Circle agent wallet is unavailable; connect it first." };
        const fees = await cli(["bridge", "get-fee", to, "--chain", from]);
        const tier = fees.data?.fees?.find((item: any) => item.finalityThreshold === 1000);
        if (!fees.ok || !tier || !Number.isFinite(Number(tier.minimumFee)) ||
            !/^\d+$/.test(String(tier.forwardFee?.med ?? ""))) {
          return { error: "No live CCTP fee quote for that route. Nothing was bridged." };
        }
        const amount = toMicro(amountUsdc);
        const protocolFee = BigInt(Math.ceil(Number(amount) * Number(tier.minimumFee) / 10_000));
        const maxFee = protocolFee + BigInt(tier.forwardFee.med);
        const total = amount + maxFee;
        const available = await balance(from, address);
        if (available === null) return { error: "I could not verify the source balance. Nothing was bridged." };
        if (available < total) return { error: `This bridge needs about ${fromMicro(total)} USDC including CCTP fees, but only ${fromMicro(available)} is on-chain on ${from}. Gateway funds are a separate balance.` };
        const destination = recipient ?? address;
        const args = ["bridge", "transfer", to, destination, "--amount", amountUsdc,
          "--address", address, "--chain", from];
        const prompt = [
          "CCTP bridge", "",
          `Recipient receives: ${amountUsdc} USDC on ${to}`,
          `From: ${from} (${address})`, `To: ${destination}`,
          `Quoted CCTP fee: up to ${fromMicro(maxFee)} USDC.`,
          `Source spends up to ${fromMicro(total)} USDC, plus possible network gas.`, "",
          "Reply YES to bridge once, or NO to cancel. Expires in 10 minutes.",
        ].join("\n");
        return stage(conversationId, { kind: "bridge", args, prompt, created: Date.now(), maxFeeMicro: maxFee });
      },
    }),
    prepareTokenSwap: tool({
      description: "Preview a same-chain swap of USDC into another token. Quotes the route, sets a 1% minimum-output floor, and requires exact YES before execution. Supports token symbols or EVM contract addresses.",
      inputSchema: z.object({ chain: z.string(), amountUsdc: z.string(), buyToken: z.string() }),
      execute: async ({ chain: rawChain, amountUsdc, buyToken }) => {
        if (pending.has(conversationId) || pendingMarketplacePrompt(conversationId)) return { error: "Another exact approval is already awaiting YES or NO." };
        const chain = chainOf(rawChain);
        const inputToken = buyToken.trim();
        const token = addressPattern.test(inputToken) ? inputToken : inputToken.toUpperCase();
        if (!chain || !validAmount(amountUsdc) ||
            !(addressPattern.test(token) || /^[A-Z][A-Z0-9]{1,11}$/.test(token))) {
          return { error: "I need a supported chain, 0-25 USDC amount, and a token symbol or contract address." };
        }
        if (token === "USDC" || (chain === "ARC" && token === "NATIVE")) {
          return { error: "That would exchange USDC for the same asset. No swap was prepared." };
        }
        const address = await getWalletAddress(chain);
        if (!address) return { error: "The Circle agent wallet is unavailable; connect it first." };
        const available = await balance(chain, address);
        if (available === null) return { error: "I could not verify the source balance. Nothing was swapped." };
        if (available < toMicro(amountUsdc)) return { error: `Only ${fromMicro(available)} on-chain USDC is available on ${chain}. Gateway funds cannot pay a swap directly.` };
        const quoteArgs = ["wallet", "swap", "USDC", amountUsdc, token, "--chain", chain, "--quote"];
        const quote = await cli(quoteArgs);
        const expected = quote.data?.estimatedOutput;
        const floor = typeof expected === "string" ? minimumSwapOutput(expected) : null;
        if (!quote.ok || !floor) return { error: `No executable swap quote was available: ${quote.error ?? "route unavailable"}. Nothing was swapped.` };
        const args = ["wallet", "swap", "USDC", amountUsdc, token, floor, "--chain", chain, "--address", address,
          "--slippage-bps", "100"];
        const prompt = [
          "Token swap", "",
          `Spend: ${amountUsdc} USDC on ${chain}`, `Receive: about ${expected} ${token}`,
          `Minimum accepted: ${floor} ${token} (1% below the quote).`,
          `Source wallet: ${address}`, "",
          "Reply YES to swap once, or NO to cancel. Expires in 10 minutes.",
        ].join("\n");
        return stage(conversationId, { kind: "swap", args, prompt, created: Date.now(), swapFloor: floor, swapQuoteArgs: quoteArgs });
      },
    }),
    prepareGatewayDeposit: tool({
      description: "Preview moving on-chain USDC into Circle Gateway by a direct deposit. If the owner omits the source chain, choose a funded supported agent-wallet chain. Gateway deposits require at least 0.5 USDC, two on-chain transactions, and a one-use YES approval. This does not send to an external recipient.",
      inputSchema: z.object({ amountUsdc: z.string(), sourceChain: z.string().optional() }),
      execute: async ({ amountUsdc, sourceChain }) => {
        if (pending.has(conversationId) || pendingMarketplacePrompt(conversationId)) return { error: "Another exact approval is already awaiting YES or NO." };
        if (!validAmount(amountUsdc) || toMicro(amountUsdc) < 500_000n) {
          return { error: "Circle's current direct Gateway deposit minimum is 0.5 USDC per source chain, with a 25 USDC limit per approval." };
        }
        const requested = sourceChain ? chainOf(sourceChain) : null;
        if (sourceChain && !requested) return { error: "That source chain is not supported by this Circle agent wallet." };
        const candidates: Chain[] = requested ? [requested] : ["MATIC", "AVAX", "ARC", "BASE", "ARB", "OP", "UNI", "ETH"];
        const sources = await onchainSources(candidates);
        const chosen = sources.find((item) => item.available >= toMicro(amountUsdc) +
          (item.chain === "ARC" ? minArcMintGasReserveMicro : 0n));
        if (!chosen) return { error: `No supported on-chain wallet has ${amountUsdc} USDC plus any needed Arc gas reserve. Gateway funds already deposited cannot be deposited again. Nothing was moved.` };
        const args = ["gateway", "deposit", "--amount", amountUsdc, "--address", chosen.address,
          "--chain", chosen.chain, "--method", "direct"];
        const prompt = [
          "Gateway deposit", "",
          `Deposit: ${amountUsdc} USDC from the on-chain wallet on ${chosen.chain}`,
          `Gateway credit source: ${chosen.chain}`,
          `Current on-chain USDC there: ${fromMicro(chosen.available)} USDC.`,
          "Circle will submit a USDC approval and a Gateway deposit transaction. Source-chain network fees are additional and may change.",
          "Gateway credit appears after the source chain reaches the required confirmations.", "",
          "Reply YES to deposit once, or NO to cancel. Expires in 10 minutes.",
        ].join("\n");
        return stage(conversationId, { kind: "gateway-deposit", args, prompt, created: Date.now() });
      },
    }),
    prepareGatewaySweep: tool({
      description: "Preview depositing part of every eligible on-chain USDC balance into Gateway. Leave half on each source chain for gas and direct payments. Each deposit must meet Circle's 0.5 USDC minimum, and the total approval is capped at 25 USDC. This is a multi-transaction action and needs one explicit YES for the listed amounts and chains.",
      inputSchema: z.object({ sourceChain: z.string().optional() }),
      execute: async ({ sourceChain }) => {
        if (pending.has(conversationId) || pendingMarketplacePrompt(conversationId)) return { error: "Another exact approval is already awaiting YES or NO." };
        const requested = sourceChain ? chainOf(sourceChain) : null;
        if (sourceChain && !requested) return { error: "That source chain is not supported by this Circle agent wallet." };
        const sources = await onchainSources(requested ? [requested] : chains);
        const deposits = sources.map((source) => ({
          chain: source.chain, address: source.address, available: source.available,
          amount: source.available / 2n,
        })).filter((item) => item.amount >= 500_000n);
        if (!deposits.length) {
          const balances = sources.filter((item) => item.available > 0n)
            .map((item) => `${item.chain}: ${fromMicro(item.available)} USDC`).join("; ") || "none";
          return { error: `Nothing is eligible for a partial Gateway sweep. Circle requires at least 0.5 USDC per deposit, and Friday leaves half of each on-chain balance available for gas and direct payments. Current on-chain USDC: ${balances}. Nothing was moved.` };
        }
        const total = deposits.reduce((sum, item) => sum + item.amount, 0n);
        if (total > 25_000_000n) {
          return { error: `The proposed sweep totals ${fromMicro(total)} USDC, above Friday's 25 USDC per-approval limit. Give an amount and source chain for a smaller deposit.` };
        }
        const prompt = [
          "Gateway sweep preview", "",
          ...deposits.map((item) => `${item.chain}: deposit ${fromMicro(item.amount)} USDC from ${fromMicro(item.available)} USDC on-chain`),
          `Total to deposit: ${fromMicro(total)} USDC.`,
          "Friday leaves about half on each source chain for gas and direct payments.",
          "Each chain requires a USDC approval and a Gateway deposit transaction. Network fees are additional. Gateway credit follows chain confirmations.",
          "If one deposit fails, later deposits stop; earlier confirmed deposits are not reversed.", "",
          "Reply YES to run this listed sweep once, or NO to cancel. Expires in 10 minutes.",
        ].join("\n");
        return stage(conversationId, {
          kind: "gateway-sweep", args: [], prompt, created: Date.now(),
          deposits: deposits.map((item) => ({ chain: item.chain, address: item.address, amountUsdc: fromMicro(item.amount) })),
        });
      },
    }),
    prepareGatewayWithdrawal: tool({
      description: "Preview a same-chain Circle Gateway withdrawal to an EVM address on the funded chain. Use prepareGatewayTransfer for a crosschain Gateway transfer. Checks per-chain balance and live Gateway fee. Never executes until exact YES.",
      inputSchema: z.object({ amountUsdc: z.string(), destinationChain: z.string().optional(), recipient: z.string().optional() }),
      execute: async ({ amountUsdc, destinationChain, recipient }) => {
        if (pending.has(conversationId) || pendingMarketplacePrompt(conversationId)) return { error: "Another exact approval is already awaiting YES or NO." };
        if (!validAmount(amountUsdc) || (recipient !== undefined && !addressPattern.test(recipient))) {
          return { error: "I need an amount from 0.000001 to 25 USDC and an optional valid EVM recipient address." };
        }
        const destination = destinationChain ? chainOf(destinationChain) : null;
        if (destinationChain && !destination) return { error: "That destination chain is not supported." };
        const address = await getWalletAddress("BASE");
        if (!address) return { error: "The Circle agent wallet is unavailable; connect it first." };
        const gateway = await cli(["gateway", "balance", "--address", address, "--chain", "BASE", "--all"]);
        if (!gateway.ok || !addressPattern.test(gateway.data?.backingEOA ?? "") || !Array.isArray(gateway.data?.balances)) {
          return { error: "I could not verify the Gateway balance. Nothing was withdrawn." };
        }
        const funded = Object.entries(gatewayDomains)
          .map(([chain, domain]) => ({ chain: chain as Chain, balance: gateway.data.balances.find((entry: any) => entry.domain === domain)?.balance ?? "0" }))
          .filter((entry) => amountPattern.test(entry.balance) && toMicro(entry.balance) >= toMicro(amountUsdc))
          .sort((a, b) => Number(toMicro(b.balance) - toMicro(a.balance)));
        if (funded.length === 0) return { error: `No Gateway chain has ${amountUsdc} USDC available. Gateway total: ${gateway.data.total ?? "unknown"} USDC.` };
        const source = destination && funded.some((entry) => entry.chain === destination)
          ? destination : funded[0].chain;
        if (destination && source !== destination) {
          return { error: `Your Gateway funds for this amount are on ${source} (${funded[0].balance} USDC), not ${destination}. Use prepareGatewayTransfer for a direct transfer to ${destination}. Nothing was moved.` };
        }
        const sourceAddress = await getWalletAddress(source);
        if (!sourceAddress) return { error: `I could not resolve your agent wallet on ${source}. Nothing was withdrawn.` };
        const to = recipient ?? sourceAddress;
        const estimate = await gatewayEstimate(source, source, gateway.data.backingEOA, to, amountUsdc);
        const fee = estimate?.maxFeeMicro ?? null;
        if (fee === null) return { error: "I could not get a live Gateway fee quote. Nothing was withdrawn." };
        if (fee >= toMicro(amountUsdc)) return { error: "The Gateway fee would consume the withdrawal amount. Nothing was withdrawn." };
        const sourceBalance = funded.find((entry) => entry.chain === source)?.balance;
        if (!sourceBalance || toMicro(sourceBalance) < toMicro(amountUsdc) + fee) {
          return { error: `Gateway on ${source} needs ${fromMicro(toMicro(amountUsdc) + fee)} USDC including the fee. Nothing was withdrawn.` };
        }
        const args = ["gateway", "withdraw", "--amount", amountUsdc, "--address", sourceAddress,
          "--chain", source, "--recipient", to];
        const prompt = [
          "Gateway withdrawal", "",
          `Withdraw: ${amountUsdc} USDC from Gateway on ${source}`,
          `Recipient: ${to} on ${source}`,
          `Current Gateway fee estimate: ${fromMicro(fee)} USDC (checked again before execution).`,
          `Recipient receives: ${amountUsdc} USDC.`,
          `Maximum Gateway debit: ${fromMicro(toMicro(amountUsdc) + fee)} USDC.`,
          `Gateway balance on ${source}: ${funded.find((entry) => entry.chain === source)?.balance} USDC.`,
          "This does not move USDC to another chain.", "",
          "Reply YES to withdraw once, or NO to cancel. Expires in 10 minutes.",
        ].join("\n");
        return stage(conversationId, { kind: "gateway-withdraw", args, prompt, created: Date.now(), maxFeeMicro: fee });
      },
    }),
    prepareGatewayTransfer: tool({
      description: "Preview a direct Circle Gateway transfer from a funded Gateway chain to any supported agent-wallet EVM destination chain, without an intermediate withdrawal or CCTP bridge. Chooses a funded source chain automatically, quotes the Gateway fee, and waits for one exact YES. A recipient EVM address can be supplied; the destination chain must be explicit.",
      inputSchema: z.object({ amountUsdc: z.string(), destinationChain: z.string(), recipient: z.string().optional() }),
      execute: async ({ amountUsdc, destinationChain, recipient }) => {
        if (pending.has(conversationId) || pendingMarketplacePrompt(conversationId)) return { error: "Another exact approval is already awaiting YES or NO." };
        const destination = chainOf(destinationChain);
        if (!destination || !validAmount(amountUsdc) ||
            (recipient !== undefined && !addressPattern.test(recipient))) {
          return { error: "I need a supported destination chain, up to 25 USDC, and an optional EVM recipient address." };
        }
        const baseWallet = await getWalletAddress("BASE");
        const destinationWallet = await getWalletAddress(destination);
        if (!baseWallet || !destinationWallet) return { error: `The Circle agent wallet is unavailable on Base or ${destination}. Connect it first.` };
        const gateway = await cli(["gateway", "balance", "--address", baseWallet, "--chain", "BASE", "--all"]);
        if (!gateway.ok || !addressPattern.test(gateway.data?.backingEOA ?? "") || !Array.isArray(gateway.data?.balances)) {
          return { error: "I could not verify the Gateway balance. Nothing was transferred." };
        }
        const funded = Object.entries(gatewayDomains)
          .map(([chain, domain]) => ({ chain: chain as Chain, balance: gateway.data.balances.find((entry: any) => entry.domain === domain)?.balance ?? "0" }))
          .filter((entry) => amountPattern.test(entry.balance) && toMicro(entry.balance) >= toMicro(amountUsdc))
          .sort((a, b) => Number(toMicro(b.balance) - toMicro(a.balance)));
        if (!funded.length) return { error: `No Gateway source chain has ${amountUsdc} USDC available. Gateway total: ${gateway.data.total ?? "unknown"} USDC. Splitting one transfer across multiple Gateway source chains is not supported by this bot yet.` };
        funded.sort((a, b) => Number(b.chain === destination) - Number(a.chain === destination));
        const to = recipient ?? destinationWallet;
        const forwarded = destination !== "ARC";
        let chosen: { chain: Chain; balance: string; estimate: GatewayEstimate } | null = null;
        for (const candidate of funded) {
          const estimate = await gatewayEstimate(candidate.chain, destination, gateway.data.backingEOA, to, amountUsdc, forwarded);
          if (estimate && toMicro(candidate.balance) >= toMicro(amountUsdc) + estimate.maxFeeMicro) {
            chosen = { ...candidate, estimate };
            break;
          }
        }
        if (!chosen) return { error: `No single Gateway source chain can cover ${amountUsdc} USDC plus the live transfer fee. Gateway total: ${gateway.data.total ?? "unknown"} USDC. Nothing was moved.` };
        const source = chosen.chain;
        const sourceAddress = await getWalletAddress(source);
        if (!sourceAddress) return { error: `I could not resolve your agent wallet on ${source}. Nothing was transferred.` };
        let mintGasNote: string;
        if (destination === "ARC") {
          const arcGasBalance = await balance("ARC", destinationWallet);
          if (arcGasBalance === null || arcGasBalance < minArcMintGasReserveMicro) {
            return { error: "The Arc agent wallet needs at least 0.02 on-chain USDC for destination mint gas. I could not verify that balance. Nothing was transferred." };
          }
          mintGasNote = `Arc mint gas: additional USDC from the agent's on-chain Arc balance (${fromMicro(arcGasBalance)} available). Actual gas may exceed this balance.`;
        } else {
          mintGasNote = `Circle Forwarding Service will mint on ${destination}. Its fee and destination gas are included in the Gateway fee cap, so Friday does not need native gas on ${destination}.`;
        }
        const fee = chosen.estimate.maxFeeMicro;
        const prompt = [
          `Direct Gateway transfer to ${destination}`, "",
          `Send: ${amountUsdc} USDC from Gateway on ${source}`,
          `Recipient: ${to} on ${destination}`,
          `Current Gateway fee cap: ${fromMicro(fee)} USDC.`,
          `Recipient receives: ${amountUsdc} USDC.`,
          `Maximum Gateway debit: ${fromMicro(toMicro(amountUsdc) + fee)} USDC.`,
          mintGasNote,
          ...(forwarded ? ["Circle handles the destination mint. A transfer ID is provided if confirmation is still pending."]
            : [`If the mint cannot finish, its proof is saved so it can be resumed after funding ${destination}.`]),
          "One Gateway transfer, with no intermediate withdrawal or CCTP bridge.", "",
          "Reply YES to transfer once, or NO to cancel. Expires in 10 minutes.",
        ].join("\n");
        return stage(conversationId, {
          kind: "gateway-transfer", args: [], prompt, created: Date.now(), maxFeeMicro: fee,
          gatewayTransfer: {
            sourceChain: source, destinationChain: destination, sourceAddress, destinationWallet,
            backingEoa: gateway.data.backingEOA, recipient: to, amountUsdc, forwarded,
          },
        });
      },
    }),
    checkGatewayTransfer: tool({
      description: "Read the live status, final fees, and destination mint transaction for a Circle Gateway transfer ID. This is read-only and does not retry or spend funds.",
      inputSchema: z.object({ transferId: z.string() }),
      execute: async ({ transferId }) => {
        if (!/^[0-9a-fA-F-]{36}$/.test(transferId)) return { error: "I need a valid Gateway transfer ID." };
        const details = await gatewayTransferStatus(transferId);
        if (!details) return { error: "Circle did not return this Gateway transfer status. No transaction was retried." };
        const chain = Object.entries(gatewayDomains).find(([, domain]) => domain === details.destinationDomain)?.[0] as Chain | undefined;
        const link = chain ? explorerUrl(chain, details.transactionHash) : null;
        return {
          transferId, status: details.status ?? "unknown", destinationChain: chain ?? "unknown",
          feeUsdc: details.fees?.total ?? null, mintTxHash: details.transactionHash ?? null,
          explorerUrl: link, failureReason: details.forwardingDetails?.failureReason ?? null,
        };
      },
    }),
    prepareGatewayMintRecovery: tool({
      description: "Find an accepted Gateway transfer whose destination mint is not confirmed and prepare a one-use approval to resume only that mint. This does not burn or debit Gateway again. Use when a prior Gateway transfer reported pending mint or the user asks to resume it.",
      inputSchema: z.object({ transferId: z.string().optional() }),
      execute: async ({ transferId }) => {
        if (pending.has(conversationId) || pendingMarketplacePrompt(conversationId)) return { error: "Another exact approval is already awaiting YES or NO." };
        const recoveries = await loadGatewayRecoveries();
        const record = transferId
          ? recoveries.find((item) => item.transferId === transferId && !item.mintTxHash)
          : recoveries.filter((item) => !item.mintTxHash).at(-1);
        if (!record) return { error: "No locally saved Gateway transfer needs a destination mint." };
        const prompt = [
          "Resume Gateway mint", "",
          `Accepted transfer: ${record.transferId}`,
          `Amount: ${record.amountUsdc} USDC from Gateway on ${record.sourceChain}`,
          `Mint to: ${record.recipient} on ${record.destinationChain}`,
          "This submits only the destination mint. It does not debit Gateway again.",
          `${record.destinationChain} network gas may be charged; if a previous mint already landed, a duplicate attempt can fail.`, "",
          "Reply YES to try this mint once, or NO to cancel. Expires in 10 minutes.",
        ].join("\n");
        return stage(conversationId, { kind: "gateway-mint-recovery", args: [record.transferId], prompt, created: Date.now() });
      },
    }),
  };
}

const chainAliases: Record<string, Chain> = {
  arc: "ARC", base: "BASE", polygon: "MATIC", matic: "MATIC",
  arbitrum: "ARB", arb: "ARB", ethereum: "ETH", eth: "ETH",
  avalanche: "AVAX", avax: "AVAX", optimism: "OP", op: "OP",
  unichain: "UNI", uni: "UNI",
};

function chainAfter(request: string, prepositions: string): Chain | null {
  const match = request.match(new RegExp(`\\b(?:${prepositions})\\s+(?:(?:my|your|the)\\s+)?(arc|base|polygon|matic|arbitrum|arb|ethereum|eth|avalanche|avax|optimism|op|unichain|uni)\\b`, "ig"))?.at(-1);
  const alias = match?.match(/(arc|base|polygon|matic|arbitrum|arb|ethereum|eth|avalanche|avax|optimism|op|unichain|uni)$/i)?.[1]?.toLowerCase();
  return alias ? chainAliases[alias] : null;
}

function moneyAmount(request: string): string | null {
  const withoutAddresses = request.replace(/0x[a-fA-F0-9]{40}\b/g, " ");
  const amount = withoutAddresses.match(/\$\s*(\d+(?:\.\d{1,6})?)\b|\b(\d+(?:\.\d{1,6})?)\s*(?:USDC\b|\$)/i);
  return amount?.[1] ?? amount?.[2] ?? null;
}

export function parseNaturalWalletRequest(text: string): {
  source: "gateway" | "onchain" | "auto";
  sourceChain: Chain | null;
  destinationChain: Chain | null;
  amountUsdc: string | null;
  recipient?: string;
} | null {
  const request = text.trim();
  if (!/^(?:(?:please|can you|could you|from (?:your|my) gateway balance)\s+)*(?:send|move|transfer)\b/i.test(request)) {
    return null;
  }
  const recipient = request.match(/0x[a-fA-F0-9]{40}\b/)?.[0];
  if (!recipient && !/\b(?:USDC|gateway|wallet)\b|\$/i.test(request)) return null;
  const sourceChain = chainAfter(request, "from");
  const source = /\b(?:from|using)\s+(?:(?:my|your|the)\s+)?gateway\b|^from (?:your|my) gateway balance\b/i.test(request)
    ? "gateway" : sourceChain || /\bfrom\s+(?:my|your|the)?\s*(?:on.chain|wallet)\b/i.test(request) ? "onchain" : "auto";
  return {
    source, sourceChain, destinationChain: chainAfter(request, "on|to|into"),
    amountUsdc: moneyAmount(request), recipient,
  };
}

export function parseNaturalGatewayDeposit(text: string): {
  amountUsdc: string | null; sourceChain: Chain | null; sweep: boolean;
} | null {
  const request = text.trim();
  if (!/^(?:(?:please|can you|could you)\s+)*(?:deposit|sweep|move|add)\b/i.test(request) ||
      !/\b(?:to|into)\s+(?:(?:my|your|the)\s+)?gateway\b/i.test(request)) return null;
  return { amountUsdc: moneyAmount(request), sourceChain: chainAfter(request, "from|on"),
    sweep: /^(?:(?:please|can you|could you)\s+)*sweep\b/i.test(request) };
}

/** Route clear transfer requests to a real quote before the model can invent an approval. */
export async function prepareNaturalWalletRequest(conversationId: string, text: string): Promise<string | null> {
  const deposit = parseNaturalGatewayDeposit(text);
  if (deposit) {
    const tools = walletActionTools(conversationId);
    const result = deposit.sweep && !deposit.amountUsdc
      ? await (tools.prepareGatewaySweep.execute as Function)({ sourceChain: deposit.sourceChain ?? undefined })
      : deposit.amountUsdc
        ? await (tools.prepareGatewayDeposit.execute as Function)({ amountUsdc: deposit.amountUsdc, sourceChain: deposit.sourceChain ?? undefined })
        : { error: "How much on-chain USDC should I deposit into Gateway? Circle's current minimum is 0.5 USDC per source chain." };
    return result.message ?? result.error ?? "I could not prepare a verified Gateway deposit. Nothing was moved.";
  }
  const request = parseNaturalWalletRequest(text);
  if (!request) return null;
  if (!request.amountUsdc) return "How much USDC should I send? Include the amount, recipient address, and destination chain.";
  if (!request.destinationChain) return "Which destination chain should receive it? An EVM address can exist on Arc, Base, Polygon, and other chains, so I cannot choose safely from the address alone.";
  const ownWallet = /\b(?:my|your|agent)\s+(?:Circle\s+)?wallet\b/i.test(text);
  const recipient = request.recipient ?? (ownWallet ? await getWalletAddress(request.destinationChain) : null);
  if (!recipient) return "What EVM address should receive the USDC on that chain?";
  const tools = walletActionTools(conversationId);
  const amountUsdc = request.amountUsdc, destination = request.destinationChain;
  const prepared = (result: any): string | null => result?.message ?? null;
  if (request.source === "gateway") {
    const result = await (tools.prepareGatewayTransfer.execute as Function)({ amountUsdc, destinationChain: destination, recipient });
    return result.message ?? result.error ?? "I could not prepare a verified Gateway quote. Nothing was moved.";
  }
  if (request.source === "onchain") {
    const source = request.sourceChain ?? destination;
    const result = source === destination
      ? await (tools.prepareUsdcSend.execute as Function)({ amountUsdc, chain: destination, toAddress: recipient })
      : await (tools.prepareUsdcBridge.execute as Function)({ amountUsdc, fromChain: source, toChain: destination, recipient });
    return result.message ?? result.error ?? "I could not prepare a verified on-chain quote. Nothing was moved.";
  }
  const destinationWallet = await getWalletAddress(destination);
  const amount = validAmount(amountUsdc) ? toMicro(amountUsdc) : 0n;
  if (!destinationWallet || amount === 0n) return "I need a supported destination chain and an amount up to 25 USDC. Nothing was moved.";
  const directBalance = await balance(destination, destinationWallet);
  if (directBalance !== null && directBalance >= amount) {
    const direct = await (tools.prepareUsdcSend.execute as Function)({ amountUsdc, chain: destination, toAddress: recipient });
    if (prepared(direct)) return direct.message;
  }
  const gateway = await (tools.prepareGatewayTransfer.execute as Function)({ amountUsdc, destinationChain: destination, recipient });
  if (prepared(gateway)) return gateway.message;
  const sources = (await onchainSources()).filter((item) => item.chain !== destination && item.available > amount)
    .sort((a, b) => Number(b.available - a.available));
  for (const source of sources) {
    const bridge = await (tools.prepareUsdcBridge.execute as Function)({
      amountUsdc, fromChain: source.chain, toChain: destination, recipient,
    });
    if (prepared(bridge)) return bridge.message;
  }
  return `I could not quote a funded route for ${amountUsdc} USDC to ${destination}. ${gateway.error ?? "Gateway was unavailable."} No funds were moved.`;
}

export async function handleWalletActionReply(conversationId: string, text: string): Promise<string | null> {
  const reply = walletApprovalWord(text);
  if (running.has(conversationId)) return "The approved wallet action is already running.";
  const action = pending.get(conversationId);
  if (!action) {
    if (reply === "yes" && Date.now() - (consumed.get(conversationId) ?? 0) < ttl) {
      return "That YES was already used. I will not execute twice.";
    }
    return null;
  }
  if (Date.now() - action.created > ttl) {
    pending.delete(conversationId);
    return reply === "yes" ? "That wallet approval expired. Ask for a fresh quote." : null;
  }
  if (reply === "no" || reply === "cancel") {
    pending.delete(conversationId);
    return "Cancelled. No wallet transaction was sent.";
  }
  if (reply !== "yes") return `A wallet action is waiting for approval.\n\n${action.prompt}`;
  pending.delete(conversationId);
  running.add(conversationId);
  consumed.set(conversationId, Date.now());
  try {
    if (action.kind === "swap" && action.swapQuoteArgs) {
      const fresh = await cli(action.swapQuoteArgs);
      if (!fresh.ok || !fresh.data?.estimatedOutput ||
          !/^\d+(?:\.\d+)?$/.test(fresh.data.estimatedOutput) ||
          Number(fresh.data.estimatedOutput) < Number(action.swapFloor)) {
        return "The swap quote worsened below your approved minimum. Nothing was swapped.";
      }
    }
    if (action.kind === "bridge") {
      const from = action.args[action.args.indexOf("--chain") + 1];
      const to = action.args[2];
      const fresh = await cli(["bridge", "get-fee", to, "--chain", from]);
      const tier = fresh.data?.fees?.find((item: any) => item.finalityThreshold === 1000);
      const amount = toMicro(action.args[action.args.indexOf("--amount") + 1]);
      const newFee = tier && Number.isFinite(Number(tier.minimumFee)) && /^\d+$/.test(String(tier.forwardFee?.med ?? ""))
        ? BigInt(Math.ceil(Number(amount) * Number(tier.minimumFee) / 10_000)) + BigInt(tier.forwardFee.med)
        : null;
      if (!fresh.ok || newFee === null || newFee > (action.maxFeeMicro ?? 0n)) {
        return "The CCTP fee changed above your approved maximum. Nothing was bridged.";
      }
    }
    if (action.kind === "gateway-withdraw") {
      const chain = chainOf(argAfter(action.args, "--chain"));
      const source = argAfter(action.args, "--address");
      const recipient = argAfter(action.args, "--recipient");
      const amountUsdc = argAfter(action.args, "--amount");
      if (!chain || !addressPattern.test(source) || !addressPattern.test(recipient)) {
        return "The Gateway withdrawal preview is invalid. Nothing was moved.";
      }
      const gateway = await cli(["gateway", "balance", "--address", source, "--chain", chain, "--all"]);
      const available = gateway.data?.balances?.find((entry: any) => entry.domain === gatewayDomains[chain])?.balance;
      if (!gateway.ok || typeof available !== "string" || !amountPattern.test(available) ||
          toMicro(available) < toMicro(amountUsdc) + (action.maxFeeMicro ?? 0n)) {
        return "The Gateway balance changed or could not be verified. Nothing was moved.";
      }
      const freshFee = (await gatewayEstimate(chain, chain, gateway.data.backingEOA, recipient, amountUsdc))?.maxFeeMicro ?? null;
      if (freshFee === null || freshFee > (action.maxFeeMicro ?? 0n)) {
        return "The Gateway fee changed above your approved maximum, or no quote was available. Nothing was moved.";
      }
      if (toMicro(available) < toMicro(amountUsdc) + freshFee) {
        return "The Gateway balance no longer covers the withdrawal amount and quoted fee. Nothing was moved.";
      }
    }
    if (action.kind === "gateway-deposit") {
      const chain = chainOf(argAfter(action.args, "--chain"));
      const source = argAfter(action.args, "--address");
      const amountUsdc = argAfter(action.args, "--amount");
      if (!chain || !addressPattern.test(source) || !validAmount(amountUsdc) || toMicro(amountUsdc) < 500_000n) {
        return "The Gateway deposit preview is invalid. Nothing was moved.";
      }
      const available = await balance(chain, source);
      const reserve = chain === "ARC" ? minArcMintGasReserveMicro : 0n;
      if (available === null || available < toMicro(amountUsdc) + reserve) {
        return "The source on-chain balance changed or could not be verified. Nothing was deposited.";
      }
    }
    if (action.kind === "gateway-sweep") {
      if (!action.deposits?.length) return "The Gateway sweep plan is missing. Nothing was moved.";
      const lines = ["Gateway sweep result", ""];
      for (const deposit of action.deposits) {
        if (!addressPattern.test(deposit.address) || !validAmount(deposit.amountUsdc) ||
            toMicro(deposit.amountUsdc) < 500_000n) {
          lines.push(`Stopped at ${deposit.chain}: the saved deposit plan is invalid.`);
          break;
        }
        const available = await balance(deposit.chain, deposit.address);
        if (available === null || available < toMicro(deposit.amountUsdc) +
            (deposit.chain === "ARC" ? minArcMintGasReserveMicro : 0n)) {
          lines.push(`Stopped at ${deposit.chain}: the on-chain balance changed or could not be verified.`);
          break;
        }
        const result = await cli(["gateway", "deposit", "--amount", deposit.amountUsdc,
          "--address", deposit.address, "--chain", deposit.chain, "--method", "direct"], 240_000);
        if (!result.ok || !/^0x[a-fA-F0-9]{64}$/.test(result.data?.depositTxHash ?? "")) {
          lines.push(`Stopped at ${deposit.chain}: Circle did not confirm the Gateway deposit. Check transaction history before retrying.`);
          break;
        }
        lines.push(`${deposit.chain}: deposited ${deposit.amountUsdc} USDC.`);
        const link = explorerUrl(deposit.chain, result.data.depositTxHash);
        if (link) lines.push(`View transaction: ${link}`);
        lines.push("");
      }
      lines.push("Gateway credits appear after source-chain confirmations. No automatic retry was made.");
      return lines.join("\n");
    }
    if (action.kind === "gateway-transfer") return await executeGatewayTransfer(action);
    if (action.kind === "gateway-mint-recovery") {
      const record = (await loadGatewayRecoveries()).find((item) => item.transferId === action.args[0] && !item.mintTxHash);
      return record ? mintGatewayRecovery(record) : "That Gateway transfer no longer needs a mint, or its recovery data is unavailable.";
    }
    const result = await cli(action.kind === "gateway-withdraw" || action.kind === "gateway-deposit"
      ? action.args : [...action.args, "--idempotency-key", randomUUID()],
    action.kind === "gateway-withdraw" || action.kind === "gateway-deposit" ? 240_000 : 150_000);
    if (action.kind === "bridge" && typeof result.data?.burnTxHash === "string") {
      return walletReceipt(action, result.data) + (result.data.forwardTxHash ? "" :
        "\n\nDestination mint is still pending or could not be verified. Check the bridge status before retrying.");
    }
    if (!result.ok) return `Circle could not confirm the ${action.kind}: ${result.error}. I will not retry automatically; check transaction history before trying again.`;
    if (action.kind === "send" && argAfter(action.args, "--chain") === "ARC") {
      const fee = await arcNetworkFee(result.data?.txHash ?? result.data?.transactionHash);
      if (fee) result.data.actualNetworkFeeUsdc = fee;
    }
    return walletReceipt(action, result.data);
  } finally {
    running.delete(conversationId);
  }
}
