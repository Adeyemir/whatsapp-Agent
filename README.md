# Friday — WhatsApp AI Agent + Circle Wallet

A general-purpose AI agent that lives natively on WhatsApp. Powered by Google Gemini, with shell execution capabilities and a Circle USDC wallet to pay for marketplace services when it can't handle something itself.

## Architecture

```
You (WhatsApp) → Photon Spectrum → Gemini Brain → Tools
                                       │
                              ┌────────┼────────┐
                              │        │        │
                          Free Tools  Shell   Circle CLI
                          (search,    (run     (wallet,
                           weather,   commands  pay for
                           calc)      on host)  services)
```

## What it can do

### Free (built-in)
- 🔍 Web search (Brave Search API)
- 🧮 Maths & calculations
- 🌤️ Weather for any city (Open-Meteo — no key needed)
- 🕐 Date & time in any timezone
- 💻 Shell command execution (with safety controls)
- 🌐 URL content fetching

### Paid (via Circle USDC wallet)
Once you set up the Circle agent wallet (one-time), the agent can:
- 🛒 Browse the Circle Agent Marketplace for services
- 💳 Pay for x402-enabled services with USDC (always asks first)
- 📞 Make AI phone calls, research people, search domains, and more

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
| `PHOTON_PROJECT_ID` + `PHOTON_PROJECT_SECRET` | [app.photon.codes](https://app.photon.codes) → your project |
| `GOOGLE_GENERATIVE_AI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — free |
| `BRAVE_SEARCH_API_KEY` | [api.search.brave.com](https://api.search.brave.com) — optional, $3/mo |

### 3. Connect your WhatsApp Business number to Photon

1. Log in to [app.photon.codes](https://app.photon.codes)
2. Go to your project → Providers → WhatsApp Business
3. Connect your WhatsApp Business number
4. Copy `Project ID` and `Project Secret` into `.env`

### 4. Install Circle CLI (optional — can be done later via WhatsApp)

```bash
npm install -g @circle-fin/cli@latest
```

### 5. Run the agent

```bash
npm run dev
```

### 6. Set up the Circle wallet (from WhatsApp!)

Once the agent is live, send this message in WhatsApp:

```
Set up my Circle agent wallet
```

Or paste:
```
curl -sL https://agents.circle.com/skills/setup.md
```

The agent will read the Circle setup instructions and walk you through it step by step — accepting terms, logging in, creating the wallet, all from WhatsApp.

## WhatsApp Commands

| Command | What it does |
|---|---|
| `/help` | Show all capabilities |
| `/balance` | Check USDC wallet balance |
| `/wallet` | Get wallet address |
| `/setup` | Start Circle wallet setup |
| `/services` | Browse marketplace services |
| `/reset` | Clear conversation history |

## Shell Execution Safety

The agent can run shell commands, but with guardrails:

- **Auto-approved**: `circle` CLI commands, Circle skill fetches
- **Requires approval**: Any other command — the agent asks you first
- **Hard-blocked**: Destructive commands (`rm -rf /`, `mkfs`, etc.)

You control what's auto-approved via `ALLOWED_COMMAND_PREFIXES` in `.env`.

## Deploy

```bash
# Railway (recommended)
npm install -g @railway/cli
railway login && railway init && railway up
```

Set your environment variables in the Railway dashboard.
Don't forget to install `@circle-fin/cli` on the deployment server too.
