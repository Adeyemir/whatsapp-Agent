import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  // Telegram Bot (from @BotFather)
  TELEGRAM_BOT_TOKEN: z.string().min(1, "Missing TELEGRAM_BOT_TOKEN"),
  WEBHOOK_SECRET: z.string().default("friday-webhook-secret-2024"),

  // Google Gemini
  GOOGLE_GENERATIVE_AI_API_KEY: z
    .string()
    .min(1, "Missing GOOGLE_GENERATIVE_AI_API_KEY"),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),

  // Web Search (optional)
  BRAVE_SEARCH_API_KEY: z.string().optional(),

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
