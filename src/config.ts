import { z } from "zod";
import dotenv from "dotenv";

dotenv.config({ override: true });

const envSchema = z
  .object({
    // Twilio WhatsApp
    TWILIO_ACCOUNT_SID: z.string().min(1, "Missing TWILIO_ACCOUNT_SID"),
    TWILIO_AUTH_TOKEN: z.string().min(1, "Missing TWILIO_AUTH_TOKEN"),
    TWILIO_WHATSAPP_NUMBER: z.string().default("whatsapp:+14155238886"),

    // Provider Selector
    LLM_PROVIDER: z.enum(["groq", "gemini", "anthropic", "openrouter"]).default("groq"),

    // Groq
    GROQ_API_KEY: z.string().optional(),
    GROQ_MODEL: z.string().default("llama-3.3-70b-versatile"),

    // Gemini
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().default("gemini-1.5-flash"),

    // Anthropic
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default("claude-3-5-sonnet-latest"),

    // OpenRouter
    OPENROUTER_API_KEY: z.string().optional(),
    OPENROUTER_MODEL: z.string().default("openai/gpt-4o-mini"),

    // Web Search (optional Brave key; marketplace search is the default path)
    BRAVE_SEARCH_API_KEY: z.string().optional(),

    // Marketplace web search (x402). Friday pays per search from the wallet/Gateway.
    SEARCH_SERVICE_URL: z
      .string()
      .default("https://api.aisa.one/apis/v1/tavily/search"),
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

    // Default Blockchain Chain
    DEFAULT_CHAIN: z.string().default("BASE"),
  })
  .refine(
    (data) => {
      if (data.LLM_PROVIDER === "groq" && !data.GROQ_API_KEY) {
        return false;
      }
      return true;
    },
    {
      message: "GROQ_API_KEY is required when LLM_PROVIDER is 'groq'",
      path: ["GROQ_API_KEY"],
    }
  )
  .refine(
    (data) => {
      if (data.LLM_PROVIDER === "gemini" && !data.GEMINI_API_KEY) {
        return false;
      }
      return true;
    },
    {
      message: "GEMINI_API_KEY is required when LLM_PROVIDER is 'gemini'",
      path: ["GEMINI_API_KEY"],
    }
  )
  .refine(
    (data) => {
      if (data.LLM_PROVIDER === "anthropic" && !data.ANTHROPIC_API_KEY) {
        return false;
      }
      return true;
    },
    {
      message: "ANTHROPIC_API_KEY is required when LLM_PROVIDER is 'anthropic'",
      path: ["ANTHROPIC_API_KEY"],
    }
  )
  .refine(
    (data) => {
      if (data.LLM_PROVIDER === "openrouter" && !data.OPENROUTER_API_KEY) {
        return false;
      }
      return true;
    },
    {
      message: "OPENROUTER_API_KEY is required when LLM_PROVIDER is 'openrouter'",
      path: ["OPENROUTER_API_KEY"],
    }
  );

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
