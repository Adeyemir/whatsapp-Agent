import assert from "node:assert/strict";
import test from "node:test";
import { approvalPrompt, financialService, formatMarketOverview } from "../src/agent/marketplace.js";

test("approval explains a paid call without exposing HTTP details by default", () => {
  const prompt = approvalPrompt({
    url: "https://api.example.com/v2/finance/advanced",
    method: "POST",
    body: '[{"location_code":2840,"language_name":"English"}]',
    address: "0x123",
    chain: "MATIC",
    quote: { price: "0.100000", chain: "MATIC", scheme: "GatewayWalletBatched", seller: "0x456" },
    provider: "AIsa API",
    serviceName: "Live Google Finance Explore Advanced",
    purpose: "Research the US stock market for a report",
    created: Date.now(),
    prompt: "",
  });

  assert.match(prompt, /Service: Live Google Finance Explore Advanced/);
  assert.match(prompt, /Provider: AIsa API/);
  assert.match(prompt, /\$0\.10 USDC/);
  assert.match(prompt, /Reply YES.*NO.*DETAILS/s);
  assert.doesNotMatch(prompt, /POST|https:|location_code|bodyJson/);
});

test("paid market overview corrects a fabricated email failure and uses only returned data", () => {
  const report = formatMarketOverview({
    response: { status_code: 20000, tasks: [{ status_code: 20000, result: [{
      type: "finance_explore", datetime: "2026-10-04 05:54:52 +00:00", items: [
        { type: "google_finance_hero_groups", markets: [{ market: "US", items: [{
          displayed_name: "Sample Index", index_value: 100, percentage_delta: 1.25,
          timestamp: "2026-10-03 00:00:00 +00:00",
        }] }] },
        { type: "google_finance_earnings_calendar", items: [] },
        { type: "google_finance_market_trends", items: { most_active: [] } },
      ],
    }] }] },
    payment: { amount: "$0.1 USDC" },
  }, true);

  assert.match(report ?? "", /no email service was called/);
  assert.match(report ?? "", /Sample Index: 100 \(1\.25%/);
  assert.match(report ?? "", /not a completed short-term or long-term investment thesis/);
  assert.doesNotMatch(report ?? "", /email service returned an error|report has been emailed/i);
});

test("stock research rejects video services and accepts actual finance services", () => {
  assert.equal(financialService({ resource: "https://api.aisa.one/apis/v2/tikhub/video/analysis",
    metadata: { description: "Get Video Comparison Analysis" } }), false);
  assert.equal(financialService({ resource: "https://api.aisa.one/apis/v2/dataforseo/serp/google/finance_explore/live/advanced",
    metadata: { description: "Live Google Finance Explore Advanced" } }), true);
});
