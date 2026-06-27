import { tool } from "ai";
import { z } from "zod";
import { exec } from "child_process";

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

// ─── Check Wallet Balance ─────────────────────────────────────────────────────

export const checkWalletBalance = tool({
  description:
    "Check the agent's USDC wallet balance via Circle CLI. Returns balance, wallet address, and chain. Use when the user asks about balance or funds.",
  inputSchema: z.object({
    chain: z
      .string()
      .optional()
      .default("BASE")
      .describe("Blockchain to check balance on (default: BASE)"),
  }),
  execute: async ({ chain }) => {
    const result = await circleCmd(`wallet balance --chain ${chain ?? "BASE"}`);
    if (!result.success) {
      return {
        error:
          "Could not check balance. The Circle CLI may not be installed or the wallet may not be set up yet. Try: npm install -g @circle-fin/cli@latest",
        raw: result.raw,
      };
    }
    return result.data;
  },
});

// ─── Get Wallet Status ────────────────────────────────────────────────────────

export const getWalletStatus = tool({
  description:
    "Get the agent wallet status — whether it exists, its address, and chain. Use when the user asks for their wallet address or wants to fund the agent.",
  inputSchema: z.object({}),
  execute: async () => {
    const result = await circleCmd("wallet status");
    if (!result.success) {
      return {
        error:
          "Wallet not set up. To create one, I can walk you through the Circle CLI setup. Just say 'set up my wallet'.",
        raw: result.raw,
      };
    }
    return result.data;
  },
});

// ─── Pay for a Marketplace Service ────────────────────────────────────────────

export const payForService = tool({
  description: `Pay for an x402 marketplace service using the agent's Circle wallet. This executes 'circle services pay' to make a USDC payment to a service URL.

IMPORTANT: ALWAYS tell the user the service URL and estimated cost BEFORE calling this tool. Get their explicit "yes" or approval first. NEVER pay without confirmation.`,
  inputSchema: z.object({
    serviceUrl: z.string().describe("The URL of the x402-enabled service to pay and call"),
    data: z
      .string()
      .optional()
      .describe("JSON data payload to send to the service (if required)"),
    chain: z.string().optional().default("BASE").describe("Blockchain for payment (default: BASE)"),
  }),
  execute: async ({ serviceUrl, data, chain }) => {
    // Get wallet address first
    const walletResult = await circleCmd("wallet status");
    if (!walletResult.success || !walletResult.data) {
      return {
        error: "Wallet is not set up. Please set up your Circle wallet first.",
      };
    }

    const walletData = walletResult.data as { data?: { address?: string } };
    const address = walletData?.data?.address;
    if (!address) {
      return { error: "Could not determine wallet address." };
    }

    const dataArg = data ? ` --data '${data}'` : "";
    const cmd = `circle services pay "${serviceUrl}" --address ${address} --chain ${chain ?? "BASE"}${dataArg}`;

    return new Promise((resolve) => {
      exec(
        cmd,
        {
          timeout: 60_000,
          env: { ...process.env, FORCE_COLOR: "0" },
        },
        (error, stdout, stderr) => {
          const raw = stdout?.toString() ?? stderr?.toString() ?? "";
          if (error) {
            resolve({
              success: false,
              error: `Payment failed: ${raw}`,
              command: cmd,
            });
          } else {
            try {
              resolve({
                success: true,
                data: JSON.parse(raw),
                command: cmd,
              });
            } catch {
              resolve({
                success: true,
                data: raw,
                command: cmd,
              });
            }
          }
        }
      );
    });
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
