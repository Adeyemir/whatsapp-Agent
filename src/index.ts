import "./config.js";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { exec, execSync } from "child_process";
import { Spectrum } from "spectrum-ts";
import { telegram } from "spectrum-ts/providers/telegram";
import { runAgent } from "./agent/agent.js";
import { config } from "./config.js";

const PORT = 3000;

async function getPublicUrl(): Promise<string> {
  // Start ngrok tunnel
  exec(`ngrok http ${PORT} --log=stderr`, () => {});

  // Poll ngrok local API until tunnel is ready
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const raw = execSync("curl -s http://localhost:4040/api/tunnels", {
        timeout: 3000,
      }).toString();
      const data = JSON.parse(raw);
      const url = data?.tunnels?.[0]?.public_url;
      if (url) return url;
    } catch {
      // not ready yet
    }
  }
  throw new Error("ngrok did not start within 20 seconds");
}

async function setTelegramWebhook(webhookUrl: string, secret: string) {
  const { default: axios } = await import("axios");
  const res = await axios.post(
    `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/setWebhook`,
    { url: webhookUrl, secret_token: secret }
  );
  if (!res.data.ok) throw new Error(JSON.stringify(res.data));
  console.log(`✅  Telegram webhook → ${webhookUrl}`);
}

/** Read raw bytes from an IncomingMessage */
function readBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

async function main() {
  console.log(`\n🤖  ${config.AGENT_NAME} — Telegram AI Agent`);
  console.log("──────────────────────────────────────────");
  console.log(`🧠  LLM: Google Gemini (${config.GEMINI_MODEL})`);

  // Check Circle CLI
  exec("circle --version", (err, stdout) => {
    console.log(err
      ? `💰  Circle CLI: not installed`
      : `💰  Circle CLI: ${stdout.trim()}`
    );
  });

  // Initialise Spectrum
  const app = await Spectrum({
    webhookSecret: config.WEBHOOK_SECRET,
    providers: [
      telegram.config({
        botToken: config.TELEGRAM_BOT_TOKEN,
        webhookSecret: config.WEBHOOK_SECRET,
      }),
    ],
  });

  // Raw HTTP server — passes bytes directly to Spectrum webhook
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url === "/webhook") {
      const body = await readBody(req);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v[0];
      }

      try {
        const result = await app.webhook(
          { body, headers },
          async (space, message) => {
            if (message.direction !== "inbound") return;

            const content = message.content;
            let incomingText: string | null = null;
            if (content.type === "text") incomingText = content.text;
            else if (content.type === "markdown") incomingText = content.markdown;

            if (!incomingText) {
              await app.send(space, "Send me a text and I'll help! 👋");
              return;
            }

            const conversationId = space.id;
            console.log(`📨  [${conversationId}]: ${incomingText.substring(0, 80)}`);

            // Fire and forget — respond to Telegram immediately, process async
            setImmediate(async () => {
              try {
                const reply = await runAgent(conversationId, incomingText!);
                await app.send(space, reply);
                console.log(`📤  [${conversationId}]: ${reply.substring(0, 80)}`);
              } catch (err) {
                console.error("❌ Agent error:", err);
                await app.send(space, "Something went wrong. Try again! 🙏");
              }
            });
          }
        );

        res.writeHead(result.status, result.headers);
        res.end(result.body);
      } catch (err) {
        console.error("❌ Webhook error:", err);
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    } else {
      res.writeHead(200);
      res.end("Friday Agent OK");
    }
  });

  server.listen(PORT, async () => {
    console.log(`🌐  HTTP server on port ${PORT}`);
    console.log(`🔗  Starting ngrok...`);

    try {
      const publicUrl = await getPublicUrl();
      await setTelegramWebhook(`${publicUrl}/webhook`, config.WEBHOOK_SECRET);
      console.log(`\n✅  Agent LIVE on Telegram! Message your bot.\n`);
    } catch (err) {
      console.error("❌ Setup error:", err);
      console.log(`\n💡 Manual: ngrok http ${PORT}  then set the webhook URL manually`);
    }
  });
}

main().catch((err) => {
  console.error("💥 Fatal:", err);
  process.exit(1);
});
