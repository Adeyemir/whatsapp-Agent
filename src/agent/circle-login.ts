import { execFile } from "node:child_process";
import path from "node:path";
import { computeTotalBalance, formatTotalBalance, getWalletAddress } from "./tools/circle.js";

type CliResult = {
  ok: boolean;
  data?: Record<string, unknown>;
  errorCode?: string;
};

type Flow =
  | { step: "terms" }
  | { step: "email" }
  | { step: "otp"; email: string; requestId: string; expiresAt: number; tries: number };

type RunCircle = (args: string[]) => Promise<CliResult>;
type BalanceReport = () => Promise<string>;

const circleBin = path.resolve(process.cwd(), "node_modules/.bin/circle");

async function runCircleCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    // execFile avoids a shell. In particular, an email or OTP cannot become a command.
    execFile(circleBin, [...args, "--output", "json"], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: "0" },
    }, (error, stdout) => {
      try {
        const parsed = JSON.parse(stdout) as {
          data?: Record<string, unknown>;
          error?: { code?: string };
        };
        resolve({ ok: !error && !parsed.error, data: parsed.data, errorCode: parsed.error?.code });
      } catch {
        // Never expose stderr or the Error object: they can include CLI arguments.
        resolve({ ok: false, errorCode: error ? "CLI_FAILED" : "INVALID_OUTPUT" });
      }
    });
  });
}

async function balanceReport(): Promise<string> {
  const address = await getWalletAddress("BASE");
  const total = await computeTotalBalance();
  if (!address || "error" in total) {
    return "Circle is connected, but I couldn't verify every balance yet. Ask me to check your balance again.";
  }
  return `Circle wallet connected.\n\nAddress: ${address}\n\n${formatTotalBalance(total)}`;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const otpPattern = /^(?:[A-Za-z0-9]{3}-)?\d{6}$/;
const authIntent = /\b(?:circle|agent wallet|wallet|gateway|usdc)\b/i;
const authAction = /\b(?:(?:log|sign)\s*(?:in|into|on)|connect|link|authenticat\w*|balance|funds|set\s?up|setup|check|show|how much|what(?:'s| is))\b/i;
const legacyBalanceCommand = /^\/(?:balance|gateway|total|wallet|setup)$/i;

/**
 * The owner completes Circle email login entirely in WhatsApp. Email and OTP
 * messages never reach the LLM or the persisted conversation history.
 */
export function createCircleLoginHandler(
  runCircle: RunCircle = runCircleCli,
  getBalanceReport: BalanceReport = balanceReport,
) {
  const flows = new Map<string, Flow>();
  const busy = new Set<string>();

  return async (conversationId: string, rawText: string): Promise<string | null> => {
    const text = rawText.trim();
    const flow = flows.get(conversationId);
    const wantsWallet = legacyBalanceCommand.test(text) ||
      (authIntent.test(text) && authAction.test(text));

    // A stray code must never be forwarded to the model or saved in chat history.
    if (!flow && otpPattern.test(text)) {
      return "I'm not waiting for a Circle code. Say 'connect my Circle wallet' to start.";
    }
    if (!flow && !wantsWallet) return null;
    if (busy.has(conversationId)) return "I'm finishing the Circle request. Please try again in a moment.";

    busy.add(conversationId);
    try {
      if (flow) {
        if (/^cancel$/i.test(text)) {
          flows.delete(conversationId);
          return "Circle sign-in cancelled.";
        }

        if (flow.step === "terms") {
          if (/^no$/i.test(text)) {
            flows.delete(conversationId);
            return "Circle sign-in cancelled. I haven't accepted the terms.";
          }
          if (!/^yes$/i.test(text)) return "Please reply yes or no after reviewing Circle's Terms and Privacy Policy.";
          const accepted = await runCircle(["terms", "accept"]);
          if (!accepted.ok) return "Circle couldn't record your acceptance. Please try again.";
          flows.set(conversationId, { step: "email" });
          return "What email did you use for your Circle agent wallet? Reply here with the email address.";
        }

        if (flow.step === "email") {
          if (text.length > 254 || !emailPattern.test(text)) {
            return "Please send the email address you use for your Circle agent wallet, or say cancel.";
          }
          const started = await runCircle(["wallet", "login", text, "--type", "agent", "--init"]);
          const message = typeof started.data?.message === "string" ? started.data.message : "";
          const requestId = message.match(/--request\s+([0-9a-f-]{36})/i)?.[1];
          if (!started.ok || !requestId) {
            return "Circle couldn't send a login code right now. Check the email and try again, or say cancel.";
          }
          flows.set(conversationId, {
            step: "otp", email: text, requestId, expiresAt: Date.now() + 10 * 60_000, tries: 0,
          });
          return `Circle sent a one-time code to ${text}. Reply with the six digits from that email. I won't save the code in Friday's chat history.`;
        }

        if (Date.now() > flow.expiresAt) {
          flows.delete(conversationId);
          return "That Circle login request expired. Say 'connect my Circle wallet' to start again.";
        }
        if (!otpPattern.test(text)) {
          return "Reply with the six-digit Circle email code, or say cancel.";
        }
        const completed = await runCircle([
          "wallet", "login", "--type", "agent", "--request", flow.requestId, "--otp", text,
        ]);
        if (!completed.ok) {
          if (completed.errorCode === "AUTH_REQUIRED") {
            flows.delete(conversationId);
            return "The Circle login request expired. Say 'connect my Circle wallet' to try again.";
          }
          const tries = flow.tries + 1;
          if (tries >= 3) {
            flows.delete(conversationId);
            return "That code didn't work. Say 'connect my Circle wallet' to request a new one.";
          }
          flows.set(conversationId, { ...flow, tries });
          return "That code didn't work. Check the Circle email and try again, or say cancel.";
        }
        flows.delete(conversationId);
        return await getBalanceReport();
      }

      const terms = await runCircle(["terms", "show"]);
      if (!terms.ok) return "I couldn't check Circle's Terms status right now. Try again in a moment.";
      if (terms.data?.accepted !== true) {
        const info = await runCircle(["terms", "show", "--init"]);
        const notice = info.data?.termsNotice;
        const termsUrl = info.data?.termsOfUseUrl;
        const privacyUrl = info.data?.privacyPolicyUrl;
        if (!info.ok || typeof notice !== "string" ||
            typeof termsUrl !== "string" || typeof privacyUrl !== "string") {
          return "I couldn't load Circle's current Terms. Try again in a moment.";
        }
        flows.set(conversationId, { step: "terms" });
        return `Circle requires acceptance before wallet sign-in.\n${notice}\nTerms: ${termsUrl}\nPrivacy: ${privacyUrl}\nReview both, then reply yes to accept or no to cancel.`;
      }

      const status = await runCircle(["wallet", "status"]);
      const mainnetStatus = (status.data?.mainnet as { tokenStatus?: string } | undefined)?.tokenStatus;
      if (status.ok && mainnetStatus === "VALID") {
        if (/\b(?:(?:log|sign)\s*(?:in|into|on)|connect|link|authenticat\w*)\b/i.test(text)) {
          return await getBalanceReport();
        }
        return null; // Let Friday answer a normal wallet question with its tools.
      }
      if (status.errorCode !== "AUTH_REQUIRED" &&
          mainnetStatus !== "EXPIRED" && mainnetStatus !== "NOT_LOGGED_IN") {
        return "I couldn't check the Circle wallet session right now. Try again in a moment.";
      }
      flows.set(conversationId, { step: "email" });
      return mainnetStatus === "EXPIRED"
        ? "Your Circle wallet session expired. What email did you use for it? Reply here with the email address, or say cancel."
        : "I can connect your Circle agent wallet here in WhatsApp. What email did you use for it? Reply with the email address, or say cancel.";
    } finally {
      busy.delete(conversationId);
    }
  };
}

export const handleCircleLoginMessage = createCircleLoginHandler();
