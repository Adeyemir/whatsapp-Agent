import "./config.js";
import express, { Request, Response } from "express";
import { exec } from "child_process";
import twilio from "twilio";
import axios from "axios";
import { runAgent } from "./agent/agent.js";
import { plainWhatsAppText } from "./agent/whatsapp-format.js";
import { config } from "./config.js";

const PORT = 8080;

// ── Twilio MessagingResponse helper ────────────────────────────────────────────
const { MessagingResponse } = twilio.twiml;

// ── ngrok auto-tunnel ──────────────────────────────────────────────────────────
async function existingTunnel(): Promise<string | undefined> {
  try {
    const response = await fetch("http://127.0.0.1:4040/api/tunnels", {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return undefined;
    const data = await response.json() as {
      tunnels?: Array<{ public_url?: string; config?: { addr?: string } }>;
    };
    return data.tunnels?.find((tunnel) =>
      tunnel.public_url?.startsWith("https://") &&
      /(?:localhost|127\.0\.0\.1):8080$/.test(tunnel.config?.addr ?? "")
    )?.public_url;
  } catch {
    return undefined;
  }
}

async function getPublicUrl(): Promise<string> {
  const active = await existingTunnel();
  if (active) return active;
  exec(`ngrok http ${PORT} --log=stderr`, () => {});

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const url = await existingTunnel();
    if (url) return url;
  }
  throw new Error("ngrok did not start within 20 seconds");
}

// ── Twilio media download ──────────────────────────────────────────────────────
// Twilio media URLs require HTTP Basic Auth (SID + token) to download.
// We fetch the image ourselves and convert it to a base64 data URL so
// OpenRouter can receive it as inline image data instead of a protected URL.
async function downloadTwilioImage(url: string, mime: string): Promise<string> {
  const response = await axios.get<ArrayBuffer>(url, {
    auth: {
      username: config.TWILIO_ACCOUNT_SID,
      password: config.TWILIO_AUTH_TOKEN,
    },
    responseType: "arraybuffer",
    timeout: 15_000,
  });
  const b64 = Buffer.from(response.data).toString("base64");
  return `data:${mime};base64,${b64}`;
}

// ── Express app ────────────────────────────────────────────────────────────────
const app = express();
const seenInboundSids = new Map<string, number>();

function splitWhatsAppReply(message: string, maxLength = 1400): string[] {
  const chunks: string[] = [];
  let remaining = message;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < maxLength / 2) cut = remaining.lastIndexOf(" ", maxLength);
    if (cut < maxLength / 2) cut = maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// Twilio sends URL-encoded form bodies
app.use(express.urlencoded({ extended: false }));

// Health check
app.get("/", (_req: Request, res: Response) => {
  res.send(`${config.AGENT_NAME} — WhatsApp AI Agent ✅`);
});

// Twilio WhatsApp webhook
app.post("/webhook", twilio.webhook({ authToken: config.TWILIO_AUTH_TOKEN, protocol: "https" }), async (req: Request, res: Response) => {
  // Fail closed until the owner number is configured. Twilio's signature alone
  // proves the sender used Twilio, not that they own this agent wallet.
  if (!config.OWNER_WHATSAPP_NUMBER || req.body.From !== config.OWNER_WHATSAPP_NUMBER) {
    res.sendStatus(403);
    return;
  }
  if (req.body.To !== config.TWILIO_WHATSAPP_NUMBER) {
    res.sendStatus(403);
    return;
  }
  const inboundSid = req.body.MessageSid;
  if (typeof inboundSid === "string" && /^SM[a-fA-F0-9]{32}$/.test(inboundSid)) {
    const now = Date.now();
    for (const [sid, firstSeen] of seenInboundSids) {
      if (now - firstSeen > 15 * 60_000) seenInboundSids.delete(sid);
    }
    if (seenInboundSids.has(inboundSid)) {
      res.type("text/xml").send(new MessagingResponse().toString());
      return;
    }
    seenInboundSids.set(inboundSid, now);
  }
  const incomingText: string = (req.body.Body ?? "").trim();
  const from: string = req.body.From ?? "unknown";           // e.g. whatsapp:+447...
  const conversationId = from.replace("whatsapp:", "");      // use phone number as session key

  // ── Extract any media Twilio attached ─────────────────────────────────────
  const numMedia = parseInt(req.body.NumMedia ?? "0", 10);
  const rawImageEntries: Array<{ url: string; mime: string }> = [];
  const nonImageTypes: string[] = [];

  for (let i = 0; i < numMedia; i++) {
    const url: string = req.body[`MediaUrl${i}`] ?? "";
    const mime: string = req.body[`MediaContentType${i}`] ?? "";
    if (mime.startsWith("image/")) {
      rawImageEntries.push({ url, mime });
    } else if (mime) {
      nonImageTypes.push(mime);
    }
  }

  const mediaLabel = rawImageEntries.length
    ? ` [+${rawImageEntries.length} image(s)]`
    : nonImageTypes.length
    ? ` [media: ${nonImageTypes.join(", ")}]`
    : "";

  // Incoming text may be a Circle email code. Never print message contents.
  console.log(`📨  [${conversationId}]: ${incomingText.length} characters${mediaLabel}`);

  // Acknowledge Twilio immediately with an empty TwiML response,
  // then reply asynchronously so we don't hit the 15-second webhook timeout.
  const twiml = new MessagingResponse();
  res.type("text/xml").send(twiml.toString());

  // Process and reply out-of-band
  setImmediate(async () => {
    try {
      // Download images from Twilio using Basic Auth and convert to base64 data URLs.
      // The LLM cannot access Twilio's protected media URLs directly.
      const imageDataUrls: string[] = [];
      for (const { url, mime } of rawImageEntries) {
        try {
          const dataUrl = await downloadTwilioImage(url, mime);
          imageDataUrls.push(dataUrl);
          console.log(`🖼️  [${conversationId}] Image downloaded (${mime}, ${Math.round(dataUrl.length / 1024)}KB base64)`);
        } catch (dlErr) {
          // Axios errors can contain Basic Auth credentials in their request config.
          const code = axios.isAxiosError(dlErr) ? dlErr.code : undefined;
          const status = axios.isAxiosError(dlErr) ? dlErr.response?.status : undefined;
          console.error(`⚠️  [${conversationId}] Failed to download image`, { code, status });
        }
      }
      // If the user sent non-image media (audio, video, doc) and no images,
      // tell them we can't process that type yet.
      let effectiveText = incomingText;
      let effectiveImages = imageDataUrls;

      if (numMedia > 0 && imageDataUrls.length === 0 && nonImageTypes.length > 0) {
        effectiveText =
          `[The user sent a ${nonImageTypes[0] ?? "media"} file. ` +
          `Let them know you can only analyse images for now, and ask what they need help with.]`;
        effectiveImages = [];
      }

      const reply = plainWhatsAppText(await runAgent(conversationId, effectiveText, effectiveImages));
      console.log(`📤  [${conversationId}]: ${reply.length} characters`);

      // Send the reply via Twilio REST API
      const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
      for (const body of splitWhatsAppReply(reply)) {
        await client.messages.create({ from: config.TWILIO_WHATSAPP_NUMBER, to: from, body });
      }
    } catch (err) {
      // Twilio errors may include the authenticated HTTP request; never log them whole.
      const code = axios.isAxiosError(err) ? err.code : undefined;
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      console.error("❌ Agent/send error", { code, status, name: err instanceof Error ? err.name : "unknown" });
    }
  });
});

// ── Boot ────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🤖  ${config.AGENT_NAME} — WhatsApp AI Agent`);
  console.log("──────────────────────────────────────────");
  console.log(`🧠  LLM: OpenRouter (${config.OPENROUTER_MODEL})`);
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
