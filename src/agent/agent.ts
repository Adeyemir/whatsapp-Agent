import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, stepCountIs } from "ai";
import { config } from "../config.js";
import { getHistory, addMessage, clearHistory } from "../memory/store.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { webSearch, calculator, getDateTime, getWeather } from "./tools/builtin.js";
import {
  checkWalletBalance,
  getWalletStatus,
  payForService,
  discoverServices,
} from "./tools/circle.js";
import {
  executeCommand,
  fetchUrl,
  getPendingCommand,
  clearPendingCommand,
  executeApprovedCommand,
} from "./tools/shell.js";

// Initialise Gemini provider
const google = createGoogleGenerativeAI({
  apiKey: config.GOOGLE_GENERATIVE_AI_API_KEY,
});

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
      `/balance — check wallet\n` +
      `/wallet  — get wallet address\n` +
      `/setup   — set up Circle wallet\n` +
      `/services — browse marketplace\n` +
      `/reset   — clear chat history\n` +
      `/help    — this menu`
    );
  }

  if (text === "/balance") {
    // Direct shortcut — run circle wallet balance
    try {
      const result = await executeApprovedCommand(
        "circle wallet balance --chain BASE --output json"
      );
      return result;
    } catch (err) {
      return `❌ Could not check balance: ${(err as Error).message}`;
    }
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
async function runLLM(conversationId: string): Promise<string> {
  const history = getHistory(conversationId);
  const systemPrompt = buildSystemPrompt();

  try {
    const result = await generateText({
      model: google(config.GEMINI_MODEL),
      system: systemPrompt,
      messages: history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      tools: {
        // Free built-in tools
        webSearch,
        calculator,
        getDateTime,
        getWeather,

        // Shell & URL tools
        executeCommand,
        fetchUrl,

        // Circle wallet tools (via CLI)
        checkWalletBalance,
        getWalletStatus,
        payForService,
        discoverServices,
      },
      stopWhen: stepCountIs(10),
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
  } catch (err) {
    console.error(`❌ Agent error for ${conversationId}:`, err);
    return "Something went wrong on my end. Please try again in a moment.";
  }
}
