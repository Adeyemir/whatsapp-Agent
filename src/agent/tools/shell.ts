import { tool } from "ai";
import { z } from "zod";
import { exec } from "child_process";
import { config } from "../../config.js";

const allowedPrefixes = config.ALLOWED_COMMAND_PREFIXES.split(",").map((p) =>
  p.trim()
);

function isAutoAllowed(command: string): boolean {
  return allowedPrefixes.some((prefix) => command.startsWith(prefix));
}

// Per-conversation pending command approvals
// key = conversationId, value = command string awaiting approval
const pendingCommands = new Map<string, string>();

export function getPendingCommand(
  conversationId: string
): string | undefined {
  return pendingCommands.get(conversationId);
}

export function clearPendingCommand(conversationId: string): void {
  pendingCommands.delete(conversationId);
}

export function setPendingCommand(
  conversationId: string,
  command: string
): void {
  pendingCommands.set(conversationId, command);
}

/**
 * Execute a shell command and return stdout/stderr.
 * Has a 60-second timeout.
 */
function runShell(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        timeout: 60_000,
        maxBuffer: 1024 * 512, // 512KB
        env: { ...process.env, FORCE_COLOR: "0" },
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          exitCode: error?.code ?? (error ? 1 : 0),
        });
      }
    );
  });
}

// ─── Shell Execution Tool ─────────────────────────────────────────────────────

export const executeCommand = tool({
  description: `Execute a shell command on the host machine. This is how you run Circle CLI commands, read Circle skill files, and manage the agent wallet.

Auto-allowed command prefixes (no user approval needed):
${allowedPrefixes.map((p) => `  - "${p}"`).join("\n")}

For ANY other command, you MUST first ask the user for explicit approval in plain language before running it. Do NOT run unapproved commands.

Common workflows:
- Read a Circle skill: curl -sL https://agents.circle.com/skills/setup.md
- Check Circle CLI: circle --help
- Check wallet: circle wallet balance --chain BASE --output json
- Pay for a service: circle services pay "<url>" --address <addr> --chain BASE --data '{"key":"value"}'
- Install Circle CLI: npm install -g @circle-fin/cli@latest`,
  inputSchema: z.object({
    command: z
      .string()
      .describe("The shell command to execute"),
    reason: z
      .string()
      .describe("Brief reason why this command needs to run — shown to user if approval is needed"),
  }),
  execute: async ({ command, reason }) => {
    // Block obviously dangerous commands regardless
    const blocked = [
      "rm -rf /",
      "rm -rf ~",
      "mkfs",
      "dd if=",
      "> /dev/sd",
      "chmod -R 777 /",
      ":(){ :|:& };:",
    ];
    if (blocked.some((b) => command.includes(b))) {
      return { error: "This command is blocked for safety reasons." };
    }

    if (!isAutoAllowed(command)) {
      return {
        needsApproval: true,
        command,
        reason,
        message: `I need your permission to run this command:\n\n${command}\n\nReason: ${reason}\n\nReply "yes" to approve or "no" to cancel.`,
      };
    }

    console.log(`🔧  Executing: ${command}`);
    const result = await runShell(command);

    // Truncate very long output for WhatsApp readability
    const maxLen = 3000;
    let output = result.stdout || result.stderr || "(no output)";
    if (output.length > maxLen) {
      output = output.substring(0, maxLen) + "\n\n... (output truncated)";
    }

    return {
      exitCode: result.exitCode,
      output,
      success: result.exitCode === 0,
    };
  },
});

/**
 * Directly execute a command that was previously approved by the user.
 * Called from the agent loop when the user says "yes" to a pending command.
 */
export async function executeApprovedCommand(
  command: string
): Promise<string> {
  console.log(`🔧  Executing (approved): ${command}`);
  const result = await runShell(command);

  let output = result.stdout || result.stderr || "(no output)";
  if (output.length > 3000) {
    output = output.substring(0, 3000) + "\n\n... (output truncated)";
  }

  if (result.exitCode === 0) {
    return `✅ Command succeeded:\n\n${output}`;
  } else {
    return `❌ Command failed (exit ${result.exitCode}):\n\n${output}`;
  }
}

// ─── Fetch URL Content Tool ──────────────────────────────────────────────────

export const fetchUrl = tool({
  description:
    "Fetch the content of a URL and return it as text. Use this to read Circle skill files, API docs, or any web content the user shares. This is safer than running curl via shell for general web reading.",
  inputSchema: z.object({
    url: z.string().url().describe("The URL to fetch"),
  }),
  execute: async ({ url }) => {
    try {
      const { default: axios } = await import("axios");
      const response = await axios.get(url, {
        timeout: 15000,
        headers: { "User-Agent": "Friday-WhatsApp-Agent/1.0" },
        maxContentLength: 100_000,
        responseType: "text",
      });
      let content = String(response.data);
      if (content.length > 8000) {
        content = content.substring(0, 8000) + "\n\n... (content truncated)";
      }
      return { url, content, status: response.status };
    } catch (err) {
      return { error: `Failed to fetch ${url}: ${(err as Error).message}` };
    }
  },
});
