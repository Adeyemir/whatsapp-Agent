import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import { config } from "../config.js";
import { getHistory, addMessage, clearHistory } from "../memory/store.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { calculator, getDateTime, getWeather } from "./tools/builtin.js";
import {
  webSearch,
  analyzeXAccount,
  checkWalletBalance,
  checkGatewayBalance,
  getTotalBalance,
  computeTotalBalance,
  getWalletStatus,
  payForService,
  discoverServices,
  getWalletAddress,
} from "./tools/circle.js";
import {
  executeCommand,
  fetchUrl,
  getPendingCommand,
  clearPendingCommand,
  executeApprovedCommand,
} from "./tools/shell.js";

// Initialise Groq via OpenAI-compatible provider
const groq = createOpenAI({
  apiKey: config.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});
// Note: always call groq.chat(model) — it targets /chat/completions.
// The default groq(model) would hit /responses, which Groq doesn't support.

// Approval detection
const APPROVAL_PHRASES = [
  "yes", "yeah", "yep", "sure", "go ahead", "do it", "proceed",
  "ok", "okay", "confirm", "approved", "accept",
];

function isApproval(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return APPROVAL_PHRASES.some((p) => lower.startsWith(p));
}

function isDenial(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return ["no", "nah", "nope", "cancel", "stop", "don't", "deny"].some(
    (p) => lower.startsWith(p)
  );
}

/**
 * Main agent entry point.
 */
export async function runAgent(
  conversationId: string,
  userText: string
): Promise<string> {
  const text = userText.trim();

  // ── Built-in slash commands ────────────────────────────────────────────────

  if (text === "/reset") {
    clearHistory(conversationId);
    return "Conversation history cleared. Fresh start! 🔄";
  }

  if (text === "/help") {
    return (
      `Hi! I'm ${config.AGENT_NAME}, your WhatsApp AI agent.\n\n` +
      `FREE TOOLS\n` +
      `• Web search — ask me anything\n` +
      `• Maths & calculations\n` +
      `• Weather for any city\n` +
      `• Date & time in any timezone\n` +
      `• Run shell commands\n\n` +
      `CIRCLE WALLET (USDC)\n` +
      `• Check balance & wallet address\n` +
      `• Pay for marketplace services\n` +
      `• Discover services to outsource tasks\n\n` +
      `COMMANDS\n` +
      `/balance — on-chain wallet balance\n` +
      `/gateway — Gateway (nanopayments) balance\n` +
      `/total   — combined total balance\n` +
      `/wallet  — get wallet address\n` +
      `/setup   — set up Circle wallet\n` +
      `/services — browse marketplace\n` +
      `/reset   — clear chat history\n` +
      `/help    — this menu`
    );
  }

  if (text === "/balance") {
    // Direct shortcut — resolve the agent wallet address first, then query balance
    try {
      const address = await getWalletAddress("BASE");
      if (!address) {
        return "No agent wallet found on BASE. Say 'create my wallet' to set one up.";
      }
      const result = await executeApprovedCommand(
        `circle wallet balance --chain BASE --address ${address} --output json`
      );
      return result;
    } catch (err) {
      return `❌ Could not check balance: ${(err as Error).message}`;
    }
  }

  if (text === "/gateway") {
    // Cross-chain Gateway (nanopayments) balance — the pool that pays for services
    try {
      const address = await getWalletAddress("BASE");
      if (!address) {
        return "No agent wallet found. Say 'create my wallet' to set one up.";
      }
      const result = await executeApprovedCommand(
        `circle gateway balance --address ${address} --chain BASE --all --output json`
      );
      return result;
    } catch (err) {
      return `❌ Could not check Gateway balance: ${(err as Error).message}`;
    }
  }

  if (text === "/total") {
    // Exact total USDC (Gateway + on-chain), summed in code — never the model's math
    const t = await computeTotalBalance();
    if ("error" in t) return `❌ ${t.error}`;
    let msg = `💰 Total balance: ${t.totalUsdc} USDC\n\n`;
    msg += `• Gateway (nanopayments): ${t.gatewayUsdc} USDC\n`;
    msg += `• On-chain: ${t.onchainUsdc} USDC`;
    if (Array.isArray(t.onchainByChain)) {
      for (const c of t.onchainByChain) {
        msg += `\n   - ${c.chain}: ${c.usdc} USDC`;
      }
    }
    return msg;
  }

  if (text === "/wallet") {
    try {
      const result = await executeApprovedCommand(
        "circle wallet status --output json"
      );
      return result;
    } catch (err) {
      return `❌ Could not fetch wallet status: ${(err as Error).message}`;
    }
  }

  if (text === "/setup") {
    // Kick off Circle wallet setup by fetching the skill file
    addMessage(conversationId, {
      role: "user",
      content: "Set up my Circle agent wallet. Read the setup instructions from https://agents.circle.com/skills/setup.md and walk me through it.",
    });
    // Fall through to the LLM to handle it
    return runLLM(conversationId);
  }

  if (text === "/services") {
    addMessage(conversationId, {
      role: "user",
      content: "Show me what services are available on the Circle Agent Marketplace that I can use.",
    });
    return runLLM(conversationId);
  }

  // ── Handle pending command approvals ──────────────────────────────────────

  const pendingCmd = getPendingCommand(conversationId);
  if (pendingCmd) {
    clearPendingCommand(conversationId);
    if (isApproval(text)) {
      const result = await executeApprovedCommand(pendingCmd);
      addMessage(conversationId, { role: "assistant", content: result });
      return result;
    } else if (isDenial(text)) {
      return "Got it — cancelled. What else can I help with?";
    }
    // If neither approval nor denial, treat as a new message and let LLM handle
  }

  // ── Normal message → LLM ─────────────────────────────────────────────────

  addMessage(conversationId, { role: "user", content: text });
  return runLLM(conversationId);
}

/**
 * Run the LLM with full tool access.
 */
// Groq's Llama models sometimes emit a malformed tool call (raw
// "<function=name(...)>" text) that Groq rejects with `tool_use_failed`.
// It is non-deterministic, so a re-roll usually succeeds.
function isToolFormatError(err: any): boolean {
  const body = String(err?.responseBody ?? "");
  const msg = String(err?.message ?? "");
  return (
    body.includes("tool_use_failed") ||
    msg.includes("Failed to call a function") ||
    msg.includes("tool call validation failed")
  );
}

async function runLLM(conversationId: string): Promise<string> {
  const history = getHistory(conversationId);
  const systemPrompt = buildSystemPrompt();

  const allTools = {
    // Free built-in tools
    webSearch,
    analyzeXAccount,
    calculator,
    getDateTime,
    getWeather,

    // Shell & URL tools
    executeCommand,
    fetchUrl,

    // Circle wallet tools (via CLI)
    checkWalletBalance,
    checkGatewayBalance,
    getTotalBalance,
    getWalletStatus,
    payForService,
    discoverServices,
  };

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Last attempt: drop tools so a model stuck emitting a malformed tool call
    // is forced to answer in plain text instead of failing again.
    const useTools = attempt < MAX_ATTEMPTS;
    try {
      const result = await generateText({
        model: groq.chat(config.GROQ_MODEL),
        temperature: 0.4,
        system: systemPrompt,
        messages: history.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        ...(useTools ? { tools: allTools, stopWhen: stepCountIs(10) } : {}),
        onStepFinish: ({ toolResults }) => {
          if (toolResults && toolResults.length > 0) {
            console.log(
              `🔧 [${conversationId}] Tool step:`,
              JSON.stringify(
                toolResults.map((r: { toolName?: string }) => r.toolName ?? "unknown"),
              )
            );
          }
        },
      });

      const reply = result.text;
      if (reply) {
        addMessage(conversationId, { role: "assistant", content: reply });
      }
      return reply || "I processed your request but didn't generate a text response. Try asking differently.";
    } catch (err: any) {
      if (isToolFormatError(err) && attempt < MAX_ATTEMPTS) {
        console.warn(
          `⚠️  [${conversationId}] Groq malformed tool call, retrying (${attempt}/${MAX_ATTEMPTS})`
        );
        continue;
      }
      console.error(`❌ Agent error for ${conversationId}:`);
      console.error(`   message:  ${err?.message}`);
      console.error(`   status:   ${err?.statusCode}`);
      console.error(`   body:     ${err?.responseBody}`);
      console.error(`   cause:    ${err?.cause}`);
      return "Something went wrong on my end. Please try again in a moment.";
    }
  }
  return "Something went wrong on my end. Please try again in a moment.";
}
