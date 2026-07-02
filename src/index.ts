import "./config.js";
import express, { Request, Response } from "express";
import { exec } from "child_process";
import { execSync } from "child_process";
import twilio from "twilio";
import { runAgent } from "./agent/agent.js";
import { config } from "./config.js";

const PORT = 8080;

// ── Twilio MessagingResponse helper ────────────────────────────────────────────
const { MessagingResponse } = twilio.twiml;

// ── ngrok auto-tunnel ──────────────────────────────────────────────────────────
async function getPublicUrl(): Promise<string> {
  exec(`ngrok http ${PORT} --log=stderr`, () => {});

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
      // not ready yet — keep polling
    }
  }
  throw new Error("ngrok did not start within 20 seconds");
}

// ── Express app ────────────────────────────────────────────────────────────────
const app = express();

// Twilio sends URL-encoded form bodies
app.use(express.urlencoded({ extended: false }));

// Health check
app.get("/", (_req: Request, res: Response) => {
  res.send(`${config.AGENT_NAME} — WhatsApp AI Agent ✅`);
});

// Twilio WhatsApp webhook
app.post("/webhook", async (req: Request, res: Response) => {
  const incomingText: string = (req.body.Body ?? "").trim();
  const from: string = req.body.From ?? "unknown";           // e.g. whatsapp:+447...
  const conversationId = from.replace("whatsapp:", "");      // use phone number as session key

  console.log(`📨  [${conversationId}]: ${incomingText.substring(0, 80)}`);

  // Acknowledge Twilio immediately with an empty TwiML response,
  // then reply asynchronously so we don't hit the 15-second webhook timeout.
  const twiml = new MessagingResponse();
  res.type("text/xml").send(twiml.toString());

  // Process and reply out-of-band
  setImmediate(async () => {
    try {
      const reply = await runAgent(conversationId, incomingText);
      console.log(`📤  [${conversationId}]: ${reply.substring(0, 80)}`);

      // Send the reply via Twilio REST API
      const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
      await client.messages.create({
        from: config.TWILIO_WHATSAPP_NUMBER,   // e.g. whatsapp:+14155238886
        to: from,                               // e.g. whatsapp:+447...
        body: reply,
      });
    } catch (err) {
      console.error("❌ Agent/send error:", err);
    }
  });
});

// ── Boot ────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🤖  ${config.AGENT_NAME} — WhatsApp AI Agent`);
  console.log("──────────────────────────────────────────");
  console.log(`🧠  LLM: Groq (${config.GROQ_MODEL})`);
  console.log(`📱  Transport: Twilio WhatsApp Sandbox`);

  // Check Circle CLI
  exec("circle --version", (err, stdout) => {
    console.log(
      err
        ? `💰  Circle CLI: not installed`
        : `💰  Circle CLI: ${stdout.trim()}`
    );
  });

  app.listen(PORT, async () => {
    console.log(`🌐  HTTP server on port ${PORT}`);

    try {
      const publicUrl = await getPublicUrl();
      const webhookUrl = `${publicUrl}/webhook`;
      console.log(`\n✅  Agent LIVE!\n`);
      console.log(`📋  Paste this URL into Twilio Sandbox config:`);
      console.log(`    ${webhookUrl}\n`);
      console.log(`    Twilio Console → Messaging → Try it out → Send a WhatsApp message`);
      console.log(`    → "When a message comes in" field\n`);
    } catch {
      console.log(`\n💡 Manual setup: run  ngrok http ${PORT}  then paste the HTTPS URL`);
      console.log(`   into Twilio Console → Messaging → Try it out → Send a WhatsApp message\n`);
    }
  });
}

main().catch((err) => {
  console.error("💥 Fatal:", err);
  process.exit(1);
});
