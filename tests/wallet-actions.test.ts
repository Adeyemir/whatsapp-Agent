import assert from "node:assert/strict";
import test from "node:test";
import { gatewayTransferReceipt, handleWalletActionReply, minimumSwapOutput, parseGatewayEstimate, parseNaturalGatewayDeposit, parseNaturalWalletRequest, pendingWalletActionPrompt, walletActionTools, walletApprovalWord, walletReceipt } from "../src/agent/wallet-actions.js";
import { plainWhatsAppText } from "../src/agent/whatsapp-format.js";
import { usdcTokenAmount } from "../src/agent/tools/usdc-balance.js";

test("swap minimum output stays one percent below the live quote", () => {
  assert.equal(minimumSwapOutput("1"), "0.990000");
  assert.equal(minimumSwapOutput("0.008881"), "0.008792");
  assert.equal(minimumSwapOutput("0"), null);
  assert.equal(minimumSwapOutput("?"), null);
});

test("invalid money instructions cannot stage an approval", async () => {
  const conversation = "invalid-wallet-action-test";
  const tools = walletActionTools(conversation);
  const send = await (tools.prepareUsdcSend.execute as Function)({
    chain: "BASE", toAddress: "0xnot-an-address", amountUsdc: "1",
  });
  const bridge = await (tools.prepareUsdcBridge.execute as Function)({
    fromChain: "BASE", toChain: "BASE", amountUsdc: "1",
  });
  const swap = await (tools.prepareTokenSwap.execute as Function)({
    chain: "BASE", amountUsdc: "25.000001", buyToken: "EURC",
  });
  assert.ok(send.error);
  assert.ok(bridge.error);
  assert.ok(swap.error);
  assert.equal(pendingWalletActionPrompt(conversation), null);
  assert.equal(await handleWalletActionReply(conversation, "yes"), null);
});

test("WhatsApp yes with emoji is understood, while extra words are not", () => {
  assert.equal(walletApprovalWord("Yes 👍🏻"), "yes");
  assert.equal(walletApprovalWord("YES!"), "yes");
  assert.equal(walletApprovalWord("yes but change the address"), "yesbutchangetheaddress");
});

test("explicit WhatsApp transfers retain the requested funding pool", () => {
  const recipient = `0x${"b".repeat(40)}`;
  assert.deepEqual(parseNaturalWalletRequest(`from your gateway balance send 1$ on ARc to ${recipient}`),
    { source: "gateway", sourceChain: null, destinationChain: "ARC", amountUsdc: "1", recipient });
  assert.deepEqual(parseNaturalWalletRequest(`send 0.3$ on arc to ${recipient}`),
    { source: "auto", sourceChain: null, destinationChain: "ARC", amountUsdc: "0.3", recipient });
  assert.deepEqual(parseNaturalWalletRequest(`send 1 USDC to ${recipient} on Polygon`),
    { source: "auto", sourceChain: null, destinationChain: "MATIC", amountUsdc: "1", recipient });
  assert.deepEqual(parseNaturalWalletRequest(`send 1 USDC to ${recipient}`),
    { source: "auto", sourceChain: null, destinationChain: null, amountUsdc: "1", recipient });
  assert.deepEqual(parseNaturalGatewayDeposit("deposit 1 USDC from Base into Gateway"),
    { amountUsdc: "1", sourceChain: "BASE", sweep: false });
  assert.deepEqual(parseNaturalGatewayDeposit("sweep my balances into Gateway"),
    { amountUsdc: null, sourceChain: null, sweep: true });
  assert.equal(parseNaturalWalletRequest("why can't Friday spend my Gateway balance?"), null);
  assert.equal(parseNaturalWalletRequest("I want to send you some USDC on Arc"), null);
});

test("Gateway estimates accept both direct and forwarding response envelopes", () => {
  const body = [{ burnIntent: { maxBlockHeight: "95399126", maxFee: "54773" } }];
  assert.deepEqual(parseGatewayEstimate(body), { maxBlockHeight: "95399126", maxFeeMicro: 54773n });
  assert.deepEqual(parseGatewayEstimate({ body, fees: { total: "0.054773" } }),
    { maxBlockHeight: "95399126", maxFeeMicro: 54773n });
  assert.equal(parseGatewayEstimate({ body: [] }), null);
});

test("Gateway receipt shows the full recipient amount and fee charged separately", () => {
  const receipt = gatewayTransferReceipt({
    transferId: "d222c1a0-63bd-46f7-9f6f-7f9b4ff9ef32",
    sourceChain: "MATIC", destinationChain: "ARC", destinationWallet: `0x${"a".repeat(40)}`,
    recipient: `0x${"b".repeat(40)}`, amountUsdc: "1", feeUsdc: "0.0015",
    attestation: "0x01", signature: "0x02", mintTxHash: `0x${"c".repeat(64)}`,
  });
  assert.match(receipt, /Recipient received: 1 USDC/);
  assert.match(receipt, /Total debited from Gateway: 1\.001500 USDC/);
  assert.doesNotMatch(receipt, /0\.998500/);
});

test("successful Arc send receipt contains a readable explorer link", () => {
  const hash = `0x${"a".repeat(64)}`;
  const receipt = walletReceipt({
    kind: "send", args: ["wallet", "transfer", `0x${"b".repeat(40)}`, "--amount", "0.2", "--chain", "ARC"],
  }, { txHash: hash, state: "COMPLETE" });
  assert.match(receipt, /USDC sent\n\nAmount: 0\.2 USDC\nNetwork: ARC/);
  assert.match(receipt, new RegExp(`View transaction: https://explorer\\.arc\\.io/tx/${hash}`));
  assert.doesNotMatch(receipt, /\*/);
});

test("outbound WhatsApp text loses Markdown decoration", () => {
  assert.equal(plainWhatsAppText("*On-Chain Wallet Balance:*\n- ARC: 0.36 USDC"),
    "On-Chain Wallet Balance:\n- ARC: 0.36 USDC");
  assert.equal(plainWhatsAppText("**Total:** 1 USDC"), "Total: 1 USDC");
});

test("Arc native gas view is not added to its ERC-20 USDC balance", () => {
  const balances = [
    { amount: "0.16002999967499058", token: { symbol: "USDC", decimals: 18, isNative: true } },
    { amount: "0.160029", token: { symbol: "USDC", decimals: 6, isNative: false } },
  ];
  assert.equal(usdcTokenAmount(balances), "0.160029");
});
