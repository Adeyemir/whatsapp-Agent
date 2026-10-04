import test from "node:test";
import assert from "node:assert/strict";
import { buildMarketplaceRequest } from "../src/agent/marketplace-request.js";

const stockQuote = {
  resource: "https://nano.blockrun.ai/api/v1/usstock/price/{symbol}",
  metadata: { method: "GET" },
};

test("a stock ticker can fill the catalog path template", () => {
  assert.deepEqual(buildMarketplaceRequest(stockQuote, undefined, '{"symbol":"AAPL"}'), {
    ok: true,
    url: "https://nano.blockrun.ai/api/v1/usstock/price/AAPL",
    method: "GET",
    body: undefined,
  });
  assert.equal(buildMarketplaceRequest(stockQuote, "https://nano.blockrun.ai/api/v1/usstock/price/AAPL", "{}").ok, true);
});

test("GET JSON parameters become URL parameters, not a request body", () => {
  const result = buildMarketplaceRequest(stockQuote, undefined, '{"symbol":"AAPL","session":"post"}');
  assert.deepEqual(result, {
    ok: true,
    url: "https://nano.blockrun.ai/api/v1/usstock/price/AAPL?session=post",
    method: "GET",
    body: undefined,
  });
});

test("request stays on the catalog endpoint and rejects unsafe path values", () => {
  assert.equal(buildMarketplaceRequest(stockQuote, "https://elsewhere.example/api/v1/usstock/price/AAPL").ok, false);
  assert.equal(buildMarketplaceRequest(stockQuote, undefined, '{"symbol":"AAPL/../../admin"}').ok, false);
  assert.equal(buildMarketplaceRequest(stockQuote, "https://nano.blockrun.ai/api/v1/usstock/price/AAPL%2Fadmin").ok, false);
});

test("POST body remains exact for an email service approval", () => {
  const email = { resource: "https://stableemail.dev/api/send", metadata: { method: "POST" } };
  const body = { to: ["reader@example.com"], subject: "Report", text: "Research results" };
  assert.deepEqual(buildMarketplaceRequest(email, undefined, JSON.stringify(body)), {
    ok: true,
    url: email.resource,
    method: "POST",
    body: JSON.stringify(body),
  });
  assert.deepEqual(buildMarketplaceRequest(email, "https://unrelated.example/video", JSON.stringify(body)), {
    ok: true,
    url: email.resource,
    method: "POST",
    body: JSON.stringify(body),
  });
});
