import assert from "node:assert/strict";
import test from "node:test";
import { plainWhatsAppText, splitWhatsAppReply } from "../src/agent/whatsapp-format.js";

test("a short chat reply stays short", () => {
  assert.equal(plainWhatsAppText("Hi! How can I help?"), "Hi! How can I help?");
});

test("reports get section gaps while exact quotes, prices, and links survive", () => {
  const original = [
    "Summary:",
    "The provider said “Revenue rose 12%.” This is its exact claim.",
    "Pros:", "- Cash balance: $1.25 million", "- Demand grew",
    "Cons:", "- Valuation is uncertain",
    "Source: https://example.com/report?period=Q3&region=US",
  ].join("\n");
  const result = plainWhatsAppText(original);
  assert.match(result, /claim\.\n\nPros:\n- Cash balance: \$1\.25 million\n- Demand grew\n\nCons:/);
  assert.match(result, /\n\nSource: https:\/\/example\.com\/report\?period=Q3&region=US/);
  assert.match(result, /“Revenue rose 12%\.”/);
});

test("wallet details remain in one block with an intact transaction hash", () => {
  const hash = `0x${"a".repeat(64)}`;
  const result = plainWhatsAppText(`USDC sent\n\nAmount: 0.3 USDC\nNetwork: ARC\nTo: 0x${"b".repeat(40)}\nTransaction: ${hash}`);
  assert.match(result, /Amount: 0\.3 USDC\nNetwork: ARC\nTo: 0x[b]{40}\n\nTransaction: 0x[a]{64}$/);
});

test("long prose gains paragraph breaks without losing words", () => {
  const message = [
    "The market rose after the earnings release, but this alone does not establish a durable trend.",
    "The company's cash position improved while its debt stayed flat over the period discussed.",
    "A higher valuation makes the next quarter more sensitive to slower growth than the prior one.",
    "The report should compare those facts with filings and current prices before any purchase.",
    "The final recommendation depends on the owner's time horizon and risk tolerance.",
  ].join(" ");
  const result = plainWhatsAppText(message);
  assert.match(result, /\n\n/);
  assert.equal(result.replace(/\s+/g, " "), message);
});

test("long WhatsApp replies split at paragraph boundaries first", () => {
  const message = "First paragraph.\n\nSecond paragraph has details.\n\nThird paragraph follows.";
  assert.deepEqual(splitWhatsAppReply(message, 45), [
    "First paragraph.", "Second paragraph has details.", "Third paragraph follows.",
  ]);
});
