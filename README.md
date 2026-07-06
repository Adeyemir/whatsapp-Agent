# Friday — WhatsApp AI Agent + Circle Wallet

A general-purpose AI agent that lives natively on WhatsApp. It runs on your choice of LLM (OpenRouter, Google Gemini, or Groq), can execute shell commands, remembers your conversation across restarts, and holds a Circle USDC wallet so it can pay for x402 marketplace services to automate tasks.

## Architecture

```
You (WhatsApp) → Twilio → ngrok → Express webhook → AI Brain → Tools
                                                        │
                           ┌─────────────────────────────┼─────────────────────────────┐
                           │                             │                             │
                      Free tools                    Shell / URL                   Circle CLI
                 (weather, calc,                (run commands,               (wallet + Gateway,
                  date/time)                     fetch pages)                 pay x402 services)
                                                                                    │
                                                                    Paid via marketplace (x402):
                                                                    web search, token search,
                                                                    X account analysis
```

## What it can do

### Free (built-in)
- Maths and calculations (calculator)
- Weather for any city (Open-Meteo, no key needed)
- Date and time in any timezone
- Shell command execution (with safety controls)
- URL content fetching

### Paid per use (via the Circle x402 marketplace)
Friday pays a fraction of a cent from your wallet, automatically for small amounts:
- **Web search**: Search the web for current facts and news (Tavily/AIsa via the marketplace, or direct free search via Brave API).
- **Token search**: Look up cryptocurrency token details, names, contract addresses, and statistics across chains (Allium API via the marketplace).
- **X / Twitter account analysis**: Look up real profile stats and recent tweets.
- **Any other x402 service**: It inspects the seller, tells you the cost, and asks before paying anything above the auto cap.

### Two balances, spent correctly
The Circle agent wallet holds two separate USDC pools:
- **On-chain balance**, held per blockchain (vanilla x402)
- **Gateway balance**, a cross-chain nanopayments pool

When Friday pays, it inspects each seller's accepted chains and schemes, checks both pools, and pays on a chain that actually works, preferring Gateway when the seller supports it.

---

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

| Key | Description | Where to get it |
|---|---|---|
| `LLM_PROVIDER` | Choose between: `openrouter`, `gemini`, or `groq` | — |
| `OPENROUTER_API_KEY` | OpenRouter API Key (e.g. `openai/gpt-4o-mini`) | [openrouter.ai](https://openrouter.ai/) |
| `GEMINI_API_KEY` | Google Gemini API Key | [aistudio.google.com](https://aistudio.google.com/) |
| `GROQ_API_KEY` | Groq Llama API Key | [console.groq.com](https://console.groq.com/) |
| `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` | Twilio Account SID & Auth Token | [console.twilio.com](https://console.twilio.com) → Account Info |
| `TWILIO_WHATSAPP_NUMBER` | The Twilio sandbox number | `whatsapp:+14155238886` |
| `DEFAULT_CHAIN` | Default blockchain network (e.g. `BASE` or `BASE-SEPOLIA`) | — |
| `BRAVE_SEARCH_API_KEY` | (Optional) Direct free web search API key | [search.brave.com](https://search.brave.com/api) |

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

---

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

---

## Gateway Transfers (WhatsApp instructions)
You can transfer USDC to and from your Gateway pool directly using plain text commands:
*   **Deposit**: *"Deposit 1 USDC to the Gateway"*
*   **Withdrawal**: *"Withdraw 1 USDC from my Gateway balance"* (Or: *"Withdraw 1 USDC from my Gateway balance on MATIC"*)

## Memory

Conversation history is persisted to `.data/conversations.json`, so Friday remembers context across restarts. The `.data/` directory is gitignored because it contains your messages.

## Shell Execution Safety

The agent can run shell commands, but with guardrails:

- Auto-approved: `circle` CLI commands and Circle skill fetches
- Requires approval: any other command, the agent asks you first
- Hard-blocked: destructive commands (`rm -rf /`, `mkfs`, and similar)

You control what is auto-approved via `ALLOWED_COMMAND_PREFIXES` in `.env`.
