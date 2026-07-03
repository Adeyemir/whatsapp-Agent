import { z } from "zod";
import dotenv from "dotenv";

dotenv.config({ override: true });

const envSchema = z.object({
  // Twilio WhatsApp
  TWILIO_ACCOUNT_SID: z.string().min(1, "Missing TWILIO_ACCOUNT_SID"),
  TWILIO_AUTH_TOKEN: z.string().min(1, "Missing TWILIO_AUTH_TOKEN"),
  TWILIO_WHATSAPP_NUMBER: z.string().default("whatsapp:+14155238886"),

  // Groq
  GROQ_API_KEY: z.string().min(1, "Missing GROQ_API_KEY"),
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),

  // Web Search (optional Brave key; marketplace search is the default path)
  BRAVE_SEARCH_API_KEY: z.string().optional(),

  // Marketplace web search (x402). Friday pays per search from the wallet/Gateway.
  SEARCH_SERVICE_URL: z
    .string()
    .default("https://api.aisa.one/apis/v2/tavily/search"),
  // Searches at or under this USDC cost auto-pay (user opted into pay-per-search).
  // Anything pricier asks for confirmation first.
  SEARCH_MAX_AUTO_USDC: z.coerce.number().default(0.05),

  // Agent Behaviour
  AGENT_NAME: z.string().default("Friday"),
  MAX_HISTORY_MESSAGES: z.coerce.number().default(20),

  // Shell execution safety
  // Comma-separated list of allowed command prefixes the agent can run
  ALLOWED_COMMAND_PREFIXES: z
    .string()
    .default("circle,curl -sL https://agents.circle.com,npx skills,npm install -g @circle-fin/cli"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌  Invalid environment configuration:\n");
  parsed.error.issues.forEach((issue) => {
    console.error(`  • ${issue.path.join(".")}: ${issue.message}`);
  });
  console.error(
    "\n💡  Copy .env.example to .env and fill in the values.\n"
  );
  process.exit(1);
}

export const config = parsed.data;
