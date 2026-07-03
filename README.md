# Friday — WhatsApp AI Agent + Circle Wallet

A general-purpose AI agent that lives natively on WhatsApp. It runs on Groq (gpt-oss-120b), can execute shell commands, remembers your conversation across restarts, and holds a Circle USDC wallet so it can pay for x402 marketplace services when it cannot do something itself.

## Architecture

```
You (WhatsApp) → Twilio → ngrok → Express webhook → Groq brain → Tools
                                                        │
                          ┌─────────────────────────────┼─────────────────────────────┐
                          │                             │                             │
                     Free tools                    Shell / URL                   Circle CLI
                (weather, calc,                (run commands,               (wallet + Gateway,
                 date/time)                     fetch pages)                 pay x402 services)
                                                                                   │
                                                                    Paid via marketplace (x402):
                                                                    web search, X account analysis
```

## What it can do

### Free (built-in)
- Maths and calculations
- Weather for any city (Open-Meteo, no key needed)
- Date and time in any timezone
- Shell command execution (with safety controls)
- URL content fetching

### Paid per use (via the Circle x402 marketplace)
Friday pays a fraction of a cent from your wallet, automatically for small amounts:
- Web search for current facts and news (Tavily via the marketplace)
- X / Twitter account analysis (real profile stats and recent tweets)
- Any other x402 service it discovers: it inspects the seller, tells you the cost, and asks before paying anything above the auto cap

### Two balances, spent correctly
The Circle agent wallet holds two separate USDC pools:
- On-chain balance, held per blockchain (vanilla x402)
- Gateway balance, a cross-chain nanopayments pool

When Friday pays, it inspects each seller's accepted chains and schemes, checks both pools, and pays on a chain that actually works, preferring Gateway when the seller supports it.

## Setup

### 1. Install dependencies

```bash
cd whatsapp-agent
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in your `.env`:

| Key | Where to get it |
|---|---|
| `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` | [console.twilio.com](https://console.twilio.com) → Account Info |
| `TWILIO_WHATSAPP_NUMBER` | The Twilio sandbox number, `whatsapp:+14155238886` |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com), free |

Web search needs no key. It runs through the Circle marketplace and is paid per call from your wallet (see `SEARCH_SERVICE_URL` and `SEARCH_MAX_AUTO_USDC`).

### 3. Install the Circle CLI

```bash
npm install -g @circle-fin/cli@latest
```

### 4. Run the agent

```bash
npm run dev
```

This starts the webhook server on port 8080. Expose it with ngrok:

```bash
ngrok http 8080
```

### 5. Point Twilio at your webhook

In the Twilio console, go to Messaging, Try it out, Send a WhatsApp message, Sandbox settings. Put your ngrok URL plus `/webhook` in the "When a message comes in" field (HTTP POST) and save:

```
https://<your-ngrok-subdomain>.ngrok-free.dev/webhook
```

Then send the sandbox `join <keyword>` message from your WhatsApp to `+1 415 523 8886` to opt in.

### 6. Set up the Circle wallet (from WhatsApp)

Once the agent is live, message it:

```
Set up my Circle agent wallet
```

Friday reads the Circle setup instructions and walks you through accepting terms, logging in, and creating the wallet, all from WhatsApp.

## WhatsApp Commands

| Command | What it does |
|---|---|
| `/help` | Show all capabilities |
| `/balance` | On-chain wallet balance |
| `/gateway` | Gateway (nanopayments) balance |
| `/total` | Combined total balance, summed exactly in code |
| `/wallet` | Get wallet address |
| `/setup` | Start Circle wallet setup |
| `/services` | Browse marketplace services |
| `/reset` | Clear conversation history |

## Memory

Conversation history is persisted to `.data/conversations.json`, so Friday remembers context across restarts. The `.data/` directory is gitignored because it contains your messages.

## Shell Execution Safety

The agent can run shell commands, but with guardrails:

- Auto-approved: `circle` CLI commands and Circle skill fetches
- Requires approval: any other command, the agent asks you first
- Hard-blocked: destructive commands (`rm -rf /`, `mkfs`, and similar)

You control what is auto-approved via `ALLOWED_COMMAND_PREFIXES` in `.env`.

## Notes

- The Twilio WhatsApp sandbox caps you at 50 messages per day. Moving to production needs a WhatsApp Business API sender.
- `openai/gpt-oss-120b` is the most reliable Groq model for tool calling. Llama models on Groq often emit malformed tool calls. The agent still retries and falls back to a plain text answer if a malformed tool call slips through.
