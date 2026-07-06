import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs } from "ai";
import { config } from "../config.js";
import { getHistory, addMessage, clearHistory } from "../memory/store.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { calculator, getDateTime, getWeather } from "./tools/builtin.js";
import {
  webSearch,
  tokenSearch,
  analyzeXAccount,
  checkWalletBalance,
  checkGatewayBalance,
  getTotalBalance,
  computeTotalBalance,
  getWalletStatus,
  payForService,
  discoverServices,
  getWalletAddress,
  gatewayDeposit,
  gatewayWithdraw,
} from "./tools/circle.js";
import {
  executeCommand,
  fetchUrl,
  getPendingCommand,
  clearPendingCommand,
  executeApprovedCommand,
} from "./tools/shell.js";

// Initialise Groq client
const groq = createOpenAI({
  apiKey: config.GROQ_API_KEY || "",
  baseURL: "https://api.groq.com/openai/v1",
});

// Initialise Google Gemini client
const google = createGoogleGenerativeAI({
  apiKey: config.GEMINI_API_KEY || "",
});

// Initialise Anthropic Claude client
const anthropic = createAnthropic({
  apiKey: config.ANTHROPIC_API_KEY || "",
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
 * Convert Zod schemas to OpenAPI schemas for OpenRouter compatibility.
 */
function zodToOpenApi(zodSchema: any): any {
  if (!zodSchema || zodSchema._def?.typeName !== "ZodObject") {
    return { type: "object", properties: {} };
  }

  const shape = zodSchema.shape;
  const properties: any = {};
  const required: string[] = [];

  for (const key of Object.keys(shape)) {
    const field = shape[key];
    let unwrapped = field;
    
    // Unwrap optional and default values to get the core Zod type
    while (unwrapped._def?.innerType || unwrapped._def?.schema) {
      unwrapped = unwrapped._def.innerType || unwrapped._def.schema;
    }
    
    const typeName = unwrapped._def?.typeName;
    const description = field.description || unwrapped.description;
    const fieldSchema: any = {};

    if (typeName === "ZodString") fieldSchema.type = "string";
    else if (typeName === "ZodNumber") fieldSchema.type = "number";
    else if (typeName === "ZodBoolean") fieldSchema.type = "boolean";
    else if (typeName === "ZodEnum") {
      fieldSchema.type = "string";
      fieldSchema.enum = unwrapped._def.values;
    }

    if (description) fieldSchema.description = description;
    properties[key] = fieldSchema;

    // If it has no optional wrapper, mark it as required
    if (field._def?.typeName !== "ZodOptional" && field._def?.typeName !== "ZodDefault") {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
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
      const address = await getWalletAddress(config.DEFAULT_CHAIN);
      if (!address) {
        return `No agent wallet found on ${config.DEFAULT_CHAIN}. Say 'create my wallet' to set one up.`;
      }
      const result = await executeApprovedCommand(
        `circle wallet balance --chain ${config.DEFAULT_CHAIN} --address ${address} --output json`
      );
      return result;
    } catch (err) {
      return `❌ Could not check balance: ${(err as Error).message}`;
    }
  }

  if (text === "/gateway") {
    // Cross-chain Gateway (nanopayments) balance — the pool that pays for services
    try {
      const address = await getWalletAddress(config.DEFAULT_CHAIN);
      if (!address) {
        return "No agent wallet found. Say 'create my wallet' to set one up.";
      }
      const result = await executeApprovedCommand(
        `circle gateway balance --address ${address} --chain ${config.DEFAULT_CHAIN} --all --output json`
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
    tokenSearch,
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
    gatewayDeposit,
    gatewayWithdraw,
  };

  if (config.LLM_PROVIDER === "openrouter") {
    // Convert Friday's tools to OpenAPI format dynamically
    const openApiTools = Object.entries(allTools).map(([name, toolObj]: [string, any]) => ({
      type: "function" as const,
      function: {
        name,
        description: toolObj.description,
        parameters: zodToOpenApi(toolObj.inputSchema),
      },
    }));

    // Local array tracking messages for this conversation turn
    const messages = [
      { role: "system", content: systemPrompt },
      ...history.map((m) => ({
        role: m.role as "user" | "assistant" | "tool",
        content: m.content,
        tool_calls: (m as any).tool_calls,
        tool_call_id: (m as any).tool_call_id,
        name: (m as any).name,
      })),
    ];

    while (true) {
      try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${config.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/Friday-Agent",
            "X-Title": "Friday WhatsApp Agent",
          },
          body: JSON.stringify({
            model: config.OPENROUTER_MODEL,
            messages,
            tools: openApiTools,
            temperature: 0.4,
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errText}`);
        }

        const data: any = await response.json();
        const choice = data.choices?.[0];
        const message = choice?.message;

        if (!message) throw new Error("No message returned from OpenRouter");

        // 1. Check if model requested tool calls
        if (message.tool_calls && message.tool_calls.length > 0) {
          messages.push(message);

          for (const toolCall of message.tool_calls) {
            const toolName = toolCall.function.name;
            const toolArgs = JSON.parse(toolCall.function.arguments);

            console.log(`🔧 [OpenRouter] Executing tool: ${toolName}`, toolArgs);

            const toolObj = (allTools as any)[toolName];
            let resultText = "";

            if (toolObj) {
              try {
                const output = await toolObj.execute(toolArgs);
                resultText = JSON.stringify(output);
              } catch (e: any) {
                console.error(`❌ Error executing tool ${toolName}:`, e);
                resultText = JSON.stringify({ error: e.message });
              }
            } else {
              resultText = JSON.stringify({ error: `Tool ${toolName} not found` });
            }

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: toolName,
              content: resultText,
            });
          }

          // Loop again to feed tool outputs back to OpenRouter
          continue;
        }

        // 2. Final conversational reply
        const reply = message.content || "";
        if (reply) {
          addMessage(conversationId, { role: "assistant", content: reply });
        }
        return reply || "I processed your request but didn't generate a text response.";
      } catch (err: any) {
        console.error("❌ OpenRouter tool loop error:", err.message);
        return "Something went wrong when communicating with OpenRouter. Please try again.";
      }
    }
  }

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Last attempt: drop tools so a model stuck emitting a malformed tool call
    // is forced to answer in plain text instead of failing again.
    const useTools = attempt < MAX_ATTEMPTS;
    try {
      let model;
      if (config.LLM_PROVIDER === "gemini") {
        model = google(config.GEMINI_MODEL);
      } else if (config.LLM_PROVIDER === "anthropic") {
        model = anthropic(config.ANTHROPIC_MODEL);
      } else {
        model = groq.chat(config.GROQ_MODEL);
      }

      const result = await generateText({
        model: model as any,
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
