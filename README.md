# Friday

Friday is a personal AI agent you message in WhatsApp. It uses OpenRouter for conversation, Twilio for WhatsApp, and a Circle agent wallet for USDC payments and transfers. It runs when the owner sends a message. There is no scheduled job.

This repository is a **single-owner local app**, tested with the Twilio WhatsApp Sandbox. It is not a hosted, multi-user wallet product.

## What Friday does

| Area | Current behavior |
| --- | --- |
| Conversation | Natural-language chat, calculations, weather, time zones, webpage reading, and image questions. Recent conversation is saved locally. |
| Live information | Web search, crypto prices, X account data, and other services through the Circle Agent Marketplace when a suitable endpoint and payment route are available. An optional Brave key provides a separate search route. |
| Circle wallet | Email-code sign-in inside WhatsApp, on-chain and Gateway USDC balances, and a combined balance view. |
| On-chain actions | Quote and approve USDC sends, CCTP bridges, and USDC-to-token swaps. A completed transaction includes an explorer link. |
| Gateway actions | Quote and approve deposits, partial sweeps, withdrawals, and direct transfers to supported chains. |

Friday discovers marketplace endpoints for a task instead of relying on a fixed finance API list. It shows the provider, purpose, and maximum price before a new marketplace call. Reply `yes` or `no`; reply `details` to inspect the technical request. A successful paid response is saved locally so Friday can continue a report without paying for the same response again. Email delivery depends on finding and successfully calling a suitable service; Friday does not claim an email was sent without its response.

Selected search, crypto-price, and X-data tools can make small payments automatically, up to `SEARCH_MAX_AUTO_USDC` per call. A general marketplace call requires its own WhatsApp approval and is capped by `MARKETPLACE_MAX_USDC_PER_CALL`. Availability and cost come from live service quotes, so requests can fail when a provider, compatible payment route, or wallet balance is unavailable.

## How USDC moves

Friday shows **on-chain USDC** per network and **Gateway USDC** separately. Gateway deposits from different supported networks contribute to a unified balance, but a particular marketplace service can still require a specific payment network and rail.

For `Send 1 USDC on Base to 0x...`, Friday chooses a funded source: on-chain Base first, then Gateway, then a quoted CCTP route from another on-chain network. You do not need to name the source. You do need to name the destination network because an EVM address alone does not identify one. Every send, bridge, swap, Gateway deposit, sweep, withdrawal, and transfer has a one-use `YES`/`NO` preview showing the amount, destination, and quoted fees. Approvals expire after 10 minutes and disappear on restart.

Examples:

```text
What's my total USDC balance?
Send 1 USDC on Base to 0x...
Deposit 1 USDC from Polygon into Gateway
Sweep my balances into Gateway
From Gateway send 1 USDC on Arc to 0x...
Can 1 USDC buy NVDAx on Arbitrum?
```

The agent-wallet integration exposes Arc, Base, Polygon, Arbitrum, Ethereum, Avalanche, Optimism, and Unichain. A direct Gateway deposit requires at least 0.5 USDC on one source network and submits a USDC approval plus a deposit transaction. `Sweep my balances into Gateway` previews a deposit of half of each eligible on-chain balance, leaving the other half for direct payments and gas. Each listed deposit is part of the one-use approval; a failed deposit stops the remaining ones.

Gateway transfers choose one funded Gateway source network per transfer. The recipient receives the stated USDC amount; Gateway debits that amount **plus** the quoted fee. Arc destination mints use the agent wallet's on-chain USDC for gas. Other supported destinations use [Circle Forwarding Service](https://developers.circle.com/gateway/references/forwarding-service), which includes destination mint gas in the Gateway fee cap. If forwarding is pending, Friday returns a transfer ID and can check its status on request. A failed manual Arc mint has a separate mint-only recovery action.

Actions are capped at 25 USDC each. Depositing into Gateway is explicit: an ordinary send does not silently sweep on-chain funds first. The app currently uses one Gateway source network for a transfer, even when the unified balance contains deposits on several networks. The Gateway-to-Arc transfer has been executed successfully; other destination transfer paths have live quote checks but have not been exercised with funds.

The xStock feature verifies a token in the official asset registry and requests a read-only Circle swap quote. If a swap route exists, an actual token purchase requires its own approval and confirmed transaction. This is a token swap pilot, not a brokerage account or stock-options trading system.

## Architecture

```text
Owner's WhatsApp
    → Twilio Sandbox
    → HTTPS webhook on this machine (ngrok)
    → Friday (OpenRouter + local tools)
        ├─ Built-in tools and webpage reading
        ├─ Circle Agent Marketplace paid APIs
        └─ Circle CLI wallet, Gateway, CCTP, and swaps
```

The webhook checks Twilio's signature and accepts messages only from `OWNER_WHATSAPP_NUMBER`. Circle email codes are handled by the login flow before messages reach the model or saved chat history. Twilio still carries the WhatsApp messages. The model has no arbitrary shell-command tool.

## Run locally

You need Node.js **20.18.2 or newer**, a Twilio account with WhatsApp Sandbox access, an OpenRouter API key, ngrok, and a Circle agent wallet. The Circle CLI is installed as a project dependency by `npm ci`; a global installation is not needed.

1. Install dependencies and create your local configuration:

   ```bash
   npm ci
   cp .env.example .env
   ```

2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `OWNER_WHATSAPP_NUMBER`, and `OPENROUTER_API_KEY` in `.env`. The owner number must include the `whatsapp:+` prefix. Check `.env.example` for optional model and spending settings. Keep `.env` private.

3. Start Friday:

   ```bash
   npm run dev
   ```

   The app listens on port 8080 and tries to reuse or start an ngrok HTTPS tunnel. If ngrok does not start automatically, run `ngrok http 8080` in another terminal.

4. In the Twilio Sandbox settings, set **When a message comes in** to the HTTPS tunnel URL followed by `/webhook`, with method `POST`. Follow the Sandbox join instructions in the Twilio console from the owner WhatsApp number.

5. Message Friday `Connect my Circle wallet`. If needed, Friday shows Circle's Terms links, asks for the email associated with the agent wallet, and completes the one-time-code login in WhatsApp. Then ask `What's my balance?` to verify both balance pools.

The Sandbox and ngrok are for local testing. This setup does not create a production WhatsApp sender or a public account system.

## Check the repo

```bash
npm run typecheck
npm test
npm run build
```

Conversation history and paid API results are stored under `.data/`, which is gitignored. Approval state is held in memory, so restart Friday and request a fresh quote if an approval was pending. Existing paid results remain available after restart.
