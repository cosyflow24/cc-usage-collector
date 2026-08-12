import assert from "node:assert/strict";
import test from "node:test";
import { verifyToken, whoamiUrl } from "../cc-usage/tools/core/verify.mjs";

const mk = (status, body) => async () => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

test("whoamiUrl derives from the ingest URL", () => {
  assert.equal(whoamiUrl("https://x.example/api/ingest"), "https://x.example/api/ingest/whoami");
  assert.equal(whoamiUrl("https://x.example/api/ingest/"), "https://x.example/api/ingest/whoami");
});

test("200 → ok with enrolled emails", async () => {
  const r = await verifyToken("https://x/api/ingest", "ccu_t", {
    fetchImpl: mk(200, { ok: true, enrolledEmails: ["a@nnb24.de"] }),
  });
  assert.deepEqual(r, { verdict: "ok", enrolledEmails: ["a@nnb24.de"] });
});

test("401/403 → rejected; 5xx and network errors → unreachable (never rejected)", async () => {
  assert.equal((await verifyToken("u", "t", { fetchImpl: mk(401, {}) })).verdict, "rejected");
  assert.equal((await verifyToken("u", "t", { fetchImpl: mk(403, {}) })).verdict, "rejected");
  assert.equal((await verifyToken("u", "t", { fetchImpl: mk(503, {}) })).verdict, "unreachable");
  const boom = async () => { throw new Error("ECONNREFUSED"); };
  assert.equal((await verifyToken("u", "t", { fetchImpl: boom })).verdict, "unreachable");
});

test("missing token is rejected without a network call", async () => {
  const neverCalled = async () => { throw new Error("must not fetch"); };
  assert.equal((await verifyToken("u", "", { fetchImpl: neverCalled })).verdict, "rejected");
});
