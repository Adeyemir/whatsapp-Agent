import assert from "node:assert/strict";
import { test } from "node:test";
import { createCircleLoginHandler } from "../src/agent/circle-login.js";

const requestId = "11111111-2222-3333-4444-555555555555";

test("WhatsApp owner can log in with email OTP without sending it to the agent", async () => {
  const calls: string[][] = [];
  const runCircle = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "terms") return { ok: true, data: { accepted: true } };
    if (args[1] === "status") return { ok: false, errorCode: "AUTH_REQUIRED" };
    if (args.includes("--init")) return {
      ok: true,
      data: { message: `OTP code sent\nPlease run: circle wallet login --request ${requestId} --otp <code>` },
    };
    return { ok: true, data: { message: "Logged in" } };
  };
  const handle = createCircleLoginHandler(runCircle, async () => "Circle wallet connected. Total: 2 USDC");

  assert.match((await handle("owner", "connect my Circle wallet"))!, /What email/i);
  assert.match((await handle("owner", "owner@example.com"))!, /six digits/i);
  assert.equal(await handle("owner", "123456"), "Circle wallet connected. Total: 2 USDC");
  assert.deepEqual(calls.at(-1), ["wallet", "login", "--type", "agent", "--request", requestId, "--otp", "123456"]);
  assert.match((await handle("owner", "123456"))!, /not waiting/i);
});

test("Terms acceptance requires an explicit yes after showing live links", async () => {
  const calls: string[][] = [];
  const runCircle = async (args: string[]) => {
    calls.push(args);
    if (args.includes("--init")) return {
      ok: true,
      data: {
        termsNotice: "Current Circle terms notice",
        termsOfUseUrl: "https://example.com/terms",
        privacyPolicyUrl: "https://example.com/privacy",
      },
    };
    if (args[1] === "accept") return { ok: true };
    return { ok: true, data: { accepted: false } };
  };
  const handle = createCircleLoginHandler(runCircle, async () => "balance");

  assert.match((await handle("owner", "sign into Circle"))!, /Current Circle terms notice/);
  assert.match((await handle("owner", "okay"))!, /reply yes or no/i);
  assert.equal(calls.some((args) => args[1] === "accept"), false);
  assert.match((await handle("owner", "yes"))!, /What email/i);
  assert.equal(calls.filter((args) => args[1] === "accept").length, 1);
});

test("Signed-in balance questions fall through, and invalid email cannot reach CLI", async () => {
  const calls: string[][] = [];
  let signedIn = true;
  const runCircle = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "terms") return { ok: true, data: { accepted: true } };
    return signedIn
      ? { ok: true, data: { mainnet: { tokenStatus: "VALID" } } }
      : { ok: true, data: { mainnet: { tokenStatus: "EXPIRED" } } };
  };
  const handle = createCircleLoginHandler(runCircle, async () => "balance");

  assert.equal(await handle("owner", "what is my wallet balance?"), null);
  signedIn = false;
  assert.match((await handle("owner", "what is my wallet balance?"))!, /session expired.*What email/i);
  assert.match((await handle("owner", "foo@example.com; echo leaked"))!, /email address/i);
  assert.equal(calls.some((args) => args.includes("foo@example.com; echo leaked")), false);
  assert.equal(await handle("owner", "cancel"), "Circle sign-in cancelled.");
});
