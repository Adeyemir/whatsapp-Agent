import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getHistory, addMessage, clearHistory, ContentPart } from "../memory/store.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { calculator, getDateTime, getWeather } from "./tools/builtin.js";
import {
  webSearch,
  analyzeXAccount,
  getCryptoPrice,
  checkWalletBalance,
  checkGatewayBalance,
  getTotalBalance,
  computeTotalBalance,
  getWalletStatus,
  getWalletAddress,
  formatTotalBalance,
} from "./tools/circle.js";
import {
  fetchUrl,
  executeApprovedCommand,
} from "./tools/shell.js";
import { inspectXStockBuy } from "./tools/xstocks.js";
import { handleCircleLoginMessage } from "./circle-login.js";
import { marketplaceTools, handleMarketplaceReply, pendingMarketplacePrompt, prepareBroadStockResearch, savedMarketplaceResultContext, savedMarketOverview } from "./marketplace.js";
import { walletActionTools, handleWalletActionReply, pendingWalletActionPrompt, prepareNaturalWalletRequest, walletApprovalWord } from "./wallet-actions.js";

// Initialise OpenRouter via OpenAI-compatible provider
const openrouter = createOpenAI({
  apiKey: config.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

function acceptedReportEmail(conversationId: string): string | null {
  try {
    const file = path.resolve(process.cwd(), ".data", "report-deliveries.json");
    const records = JSON.parse(fs.readFileSync(file, "utf8"));
    const record = records?.[conversationId];
    if (record?.providerAccepted !== true || typeof record?.recipient !== "string" ||
        typeof record?.messageId !== "string") return null;
    return `StableEmail accepted the stock report for ${record.recipient}. Provider message ID: ${record.messageId}. The Circle call cost ${record.costUsdc} USDC on ${record.chain}. I cannot verify delivery to your inbox from the provider's acceptance response; please check your inbox or spam folder.`;
  } catch {
    return null;
  }
}
// Note: always call openrouter.chat(model) — it targets /chat/completions.

/**
 * Main agent entry point.
 */
export async function runAgent(
  conversationId: string,
  userText: string,
  imageUrls: string[] = []
): Promise<string> {
  const text = userText.trim();

  // Handle Circle email and OTP before anything can reach the LLM or history.
  const circleLoginReply = await handleCircleLoginMessage(conversationId, text);
  if (circleLoginReply !== null) return circleLoginReply;

  if (pendingWalletActionPrompt(conversationId)) {
    const actionReply = await handleWalletActionReply(conversationId, text);
    if (actionReply !== null) {
      addMessage(conversationId, { role: "user", content: text });
      addMessage(conversationId, { role: "assistant", content: actionReply });
      return actionReply;
    }
  }

  if (/\b(?:did you|has friday|was the report|email status|report email status)\b/i.test(text) &&
      /\b(?:email|emailed|send|sent|report)\b/i.test(text)) {
    const status = acceptedReportEmail(conversationId);
    if (status) return status;
  }

  const marketplaceReply = await handleMarketplaceReply(conversationId, text);
  if (marketplaceReply.handled) {
    if (marketplaceReply.reply) return marketplaceReply.reply;
    if (marketplaceReply.result) {
      addMessage(conversationId, { role: "user", content: marketplaceReply.result });
      const marketOverview = savedMarketOverview(conversationId);
      if (marketOverview) {
        addMessage(conversationId, { role: "assistant", content: marketOverview });
        return marketOverview;
      }
      return runLLM(conversationId, false, true);
    }
  }
  const completedWalletAction = await handleWalletActionReply(conversationId, text);
  if (completedWalletAction !== null) {
    addMessage(conversationId, { role: "user", content: text });
    addMessage(conversationId, { role: "assistant", content: completedWalletAction });
    return completedWalletAction;
  }
  const recentHistory = getHistory(conversationId).slice(-10);
  if (imageUrls.length === 0) {
    const prepared = await prepareNaturalWalletRequest(conversationId, text);
    if (prepared !== null) {
      addMessage(conversationId, { role: "user", content: text });
      addMessage(conversationId, { role: "assistant", content: prepared });
      return prepared;
    }
    const gatewayCapabilityQuestion = /\bgateway\b/i.test(text) &&
      /\b(?:send|spend|transfer|bridge|withdraw|liquidity)\b/i.test(text) &&
      /^(?:why|how|can\b|could\b|is\b|does\b|do\b|wait\b)/i.test(text);
    if (gatewayCapabilityQuestion) {
      const reply = "Yes, Friday can prepare a direct transfer from your Gateway USDC to Arc, including an external Arc recipient. It uses a Gateway transfer and Arc mint, with a live fee quote and one YES approval. A normal on-chain send or CCTP bridge cannot spend the Gateway balance directly. The earlier answer saying Gateway could not reach Arc was wrong. No transfer was made by this explanation.";
      addMessage(conversationId, { role: "user", content: text });
      addMessage(conversationId, { role: "assistant", content: reply });
      return reply;
    }
    const lastAssistant = recentHistory.filter((message) => message.role === "assistant").at(-1);
    if (walletApprovalWord(text) === "yes" && typeof lastAssistant?.content === "string" &&
        /(?:reply yes.*(?:send|bridge|transfer)|please confirm.*(?:bridge|transfer|send)|would you like to send)/is.test(lastAssistant.content)) {
      const reply = "That earlier wallet message has no active transaction approval, so I did not move funds. Repeat the amount, source, chain, and recipient to get a fresh verified quote.";
      addMessage(conversationId, { role: "user", content: text });
      addMessage(conversationId, { role: "assistant", content: reply });
      return reply;
    }
    const fundingFollowup = /^(?:done|sent|i sent it|sent it)$/i.test(text) &&
      typeof lastAssistant?.content === "string" &&
      /(?:address for receiving USDC|send the USDC.*let me know when|fund (?:my|your|the) (?:Circle |agent )?wallet)/i.test(lastAssistant.content);
    const balanceQuestion = /^(?:what(?:'s| is)|check|show|give me|tell me|how much|balance\b|wallet\b|total\b|gateway balance\b)/i.test(text) &&
      /\b(?:balance|balances|funds|USDC)\b/i.test(text);
    if (fundingFollowup || balanceQuestion) {
      const total = await computeTotalBalance();
      const reply = "error" in total ? `I couldn't verify all balances: ${total.error}` : formatTotalBalance(total);
      addMessage(conversationId, { role: "user", content: text });
      addMessage(conversationId, { role: "assistant", content: reply });
      return reply;
    }
  }
  const marketplaceContinuation = /^(?:yes|(?:yes\s+)?(?:proceed|continue|go ahead))$/i.test(text) &&
    recentHistory.some((message) => typeof message.content === "string" &&
      /circle agent marketplace|circle marketplace|paid service|stock analysis/i.test(message.content));
  const researchContext = marketplaceContinuation
    ? recentHistory.filter((message) => message.role === "user" && typeof message.content === "string")
        .map((message) => message.content as string).join(" ")
    : text;
  const broadStockReport = /\b(?:stocks?|equities)\b/i.test(researchContext) &&
    /\b(?:research|report|best|short.term|long.term)\b/i.test(researchContext) &&
    /\b(?:circle|marketplace|paid)\b/i.test(researchContext) &&
    !recentHistory.some((message) => typeof message.content === "string" &&
      /The owner approved and Friday called AIsa API.*finance_explore/s.test(message.content));

  // ── Built-in slash commands ────────────────────────────────────────────────

  if (text === "/reset") {
    clearHistory(conversationId);
    return "Conversation history cleared. Fresh start! 🔄";
  }

  if (text === "/help") {
    return (
      `Hi! I'm ${config.AGENT_NAME}, your WhatsApp AI agent.\n\n` +
      `BUILT-IN TOOLS\n` +
      `• Maths & calculations\n` +
      `• Weather for any city\n` +
      `• Date & time in any timezone\n` +
      `• Read web pages and images\n\n` +
      `LIVE DATA\n` +
      `• Web search and crypto prices use paid marketplace APIs unless an optional Brave search key is configured\n` +
      `• Small selected data calls can pay automatically, subject to a cap\n\n` +
      `CIRCLE WALLET (USDC)\n` +
      `• Check balance & wallet address\n` +
      `• Pay for marketplace services\n` +
      `• Preview and approve USDC sends, CCTP bridges, swaps, Gateway deposits, sweeps, withdrawals, and Gateway transfers\n` +
      `• Discover services to outsource tasks\n\n` +
      `Just ask naturally, for example: 'Connect my Circle wallet' or 'What's my wallet balance?'`
    );
  }

  if (["/balance", "/gateway", "/total"].includes(text)) {
    const total = await computeTotalBalance();
    return "error" in total ? `I couldn't verify all balances: ${total.error}` : formatTotalBalance(total);
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

  // ── Normal message → LLM ─────────────────────────────────────────────────

  if (imageUrls.length > 0) {
    // Build a multimodal content array: images first, then the text prompt
    const parts: ContentPart[] = [
      ...imageUrls.map((url) => ({ type: "image" as const, image: url })),
      { type: "text" as const, text: text || "What's in this image?" },
    ];
    addMessage(conversationId, { role: "user", content: parts });
  } else {
    addMessage(conversationId, { role: "user", content: text });
  }
  if (imageUrls.length === 0 && /\b(?:continue|resume|finish|complete)\b/i.test(text) &&
      /\b(?:report|research|analysis|paid data|paid result)\b/i.test(text)) {
    const saved = savedMarketplaceResultContext(conversationId);
    if (saved) {
      addMessage(conversationId, { role: "user", content: saved });
      const previousAssistant = recentHistory.filter((message) => message.role === "assistant").at(-1);
      const correctEmailClaim = typeof previousAssistant?.content === "string" &&
        /issue while trying to send the report to your email|email service returned an error/i.test(previousAssistant.content);
      const marketOverview = savedMarketOverview(conversationId, correctEmailClaim);
      if (marketOverview) {
        addMessage(conversationId, { role: "assistant", content: marketOverview });
        return marketOverview;
      }
      return runLLM(conversationId, false, true);
    }
  }
  if (broadStockReport && imageUrls.length === 0) {
    const reply = await prepareBroadStockResearch(conversationId);
    addMessage(conversationId, { role: "assistant", content: reply });
    return reply;
  }
  return runLLM(conversationId, marketplaceContinuation);
}

/**
 * Run the LLM with full tool access.
 */
// Some models via OpenRouter may emit malformed tool calls intermittently.
// A re-roll on those errors usually succeeds.
function isToolFormatError(err: any): boolean {
  const body = String(err?.responseBody ?? "");
  const msg = String(err?.message ?? "");
  return (
    body.includes("tool_use_failed") ||
    msg.includes("Failed to call a function") ||
    msg.includes("tool call validation failed")
  );
}

async function runLLM(conversationId: string, marketplaceContinuation = false, afterPaidCall = false): Promise<string> {
  const history = getHistory(conversationId);
  const systemPrompt = afterPaidCall
    ? `You are ${config.AGENT_NAME}, a personal WhatsApp assistant. A Circle Marketplace call was just approved and paid for. Use only the saved response and the read-only tools available in this turn. Explain the actual result and cost. Do not claim to have attempted, sent, or failed to send an email: no email tool is available in this turn. If the owner requested email, say it has not been attempted and needs a separate approved call after a report is ready. Do not ask whether the owner wants a summary; give the useful result now. If the data is insufficient for a defensible investment thesis, say so. Never invent a service outcome. Write plain WhatsApp text with short paragraphs, a blank line between sections, and short bullets for grouped facts. Keep source links intact and quote only exact source wording with attribution.`
    : buildSystemPrompt() + (marketplaceContinuation
    ? "\n\nThe owner just said to proceed with a previous marketplace task, but there is no saved exact payment approval. Search again if needed, choose a relevant service with a funded payment route, and call requestMarketplaceCall to prepare one exact quote. Do not just list services or claim payment occurred. If no call can be prepared, report the specific tool error."
    : "");
  let lastMarketplaceError: string | null = null;

  const allTools = {
    // Free built-in tools
    webSearch,
    analyzeXAccount,
    getCryptoPrice,
    calculator,
    getDateTime,
    getWeather,

    // Read-only URL tool. Arbitrary shell commands are not exposed to the model.
    fetchUrl,

    // Circle wallet tools (via CLI)
    checkWalletBalance,
    checkGatewayBalance,
    getTotalBalance,
    getWalletStatus,
    ...marketplaceTools(conversationId),
    ...walletActionTools(conversationId),
    inspectXStockBuy,
  };
  const readOnlyTools = {
    readMarketplaceResult: marketplaceTools(conversationId).readMarketplaceResult,
    calculator,
    getDateTime,
    fetchUrl,
  };

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Last attempt: drop tools so a model stuck emitting a malformed tool call
    // is forced to answer in plain text instead of failing again.
    const useTools = attempt < MAX_ATTEMPTS;
    try {
      const result = await generateText({
        model: openrouter.chat(config.OPENROUTER_MODEL),
        temperature: 0.4,
        system: systemPrompt,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: history.flatMap((m): any[] => {
          if (m.role === "assistant") {
            return [{ role: "assistant" as const, content: typeof m.content === "string" ? m.content : "" }];
          }
          if (typeof m.content === "string") {
            return [{ role: "user" as const, content: m.content }];
          }
          return [{
            role: "user" as const,
            content: m.content.map((part) => {
              if (part.type !== "image") {
                return { type: "text" as const, text: part.text };
              }
              // Only base64 data URLs are safe to send to the LLM.
              // http/https Twilio URLs are auth-protected and ephemeral —
              // replace them with a text note so history doesn't break.
              if (part.image.startsWith("data:")) {
                return { type: "image" as const, image: part.image };
              }
              return { type: "text" as const, text: "[image from earlier message — no longer available]" };
            }),
          }];
        }),
        ...(useTools ? { tools: afterPaidCall ? readOnlyTools : allTools, stopWhen: stepCountIs(10) } : {}),
        onStepFinish: ({ toolResults }) => {
          if (toolResults && toolResults.length > 0) {
            for (const item of toolResults as Array<{ toolName?: string; output?: { error?: string }; result?: { error?: string } }>) {
              if (item.toolName !== "requestMarketplaceCall") continue;
              const error = item.output?.error ?? item.result?.error;
              if (typeof error === "string" &&
                  !error.includes("Another marketplace quote is being prepared") &&
                  (!error.includes("after several attempts") || !lastMarketplaceError)) {
                lastMarketplaceError = error;
              }
            }
            console.log(
              `🔧 [${conversationId}] Tool step:`,
              JSON.stringify(
                toolResults.map((r: { toolName?: string }) => r.toolName ?? "unknown"),
              )
            );
          }
        },
      });

      const candidate = result.text || lastMarketplaceError;
      const reply = pendingWalletActionPrompt(conversationId) ?? pendingMarketplacePrompt(conversationId) ?? (candidate || (afterPaidCall
        ? "The approved marketplace call succeeded and I saved its response. I couldn't finish the report in this reply; ask me to continue using the saved data. No further payment was made."
        : "I couldn't complete that request. Please give me a more specific task or service to try."));
      addMessage(conversationId, { role: "assistant", content: reply });
      return reply;
    } catch (err: any) {
      if (isToolFormatError(err) && attempt < MAX_ATTEMPTS) {
        console.warn(
          `⚠️  [${conversationId}] OpenRouter malformed tool call, retrying (${attempt}/${MAX_ATTEMPTS})`
        );
        continue;
      }
      console.error(`❌ Agent error for ${conversationId}:`);
      // Provider errors may embed request headers or user content in their body.
      console.error(`   name:    ${err?.name ?? "unknown"}`);
      console.error(`   status:  ${err?.statusCode ?? "unknown"}`);
      const reply = afterPaidCall
        ? "The approved marketplace call succeeded and I saved its response, but I couldn't finish the report just now. Ask me to continue using the saved data. No further payment was made."
        : "Something went wrong on my end. Please try again in a moment.";
      if (afterPaidCall) addMessage(conversationId, { role: "assistant", content: reply });
      return reply;
    }
  }
  return "Something went wrong on my end. Please try again in a moment.";
}
