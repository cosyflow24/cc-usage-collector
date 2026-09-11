import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
    fetchImpl: mk(200, { ok: true, enrolledEmails: ["a@nnb24.de"], operator: "a@nnb24.de" }),
  });
  assert.deepEqual(r, { verdict: "ok", enrolledEmails: ["a@nnb24.de"], operator: "a@nnb24.de" , sharedAccounts: [] });
});

test("a dashboard that predates the operator field reports unknown, not a wrong owner", async () => {
  // An old deployment simply omits `operator`. Reporting null keeps `doctor`
  // honest ("attributed to: none") instead of claiming an attribution that the
  // server never made.
  const r = await verifyToken("https://x/api/ingest", "ccu_t", {
    fetchImpl: mk(200, { ok: true, enrolledEmails: ["a@nnb24.de"] }),
  });
  assert.deepEqual(r, { verdict: "ok", enrolledEmails: ["a@nnb24.de"], operator: null , sharedAccounts: [] });
});

test("a non-string operator is treated as absent", async () => {
  for (const bad of [42, {}, [], "", null]) {
    const r = await verifyToken("https://x/api/ingest", "ccu_t", {
      fetchImpl: mk(200, { ok: true, enrolledEmails: [], operator: bad }),
    });
    assert.equal(r.operator, null, `operator=${JSON.stringify(bad)} must degrade to null`);
  }
});

test("every non-ok verdict still carries an explicit null operator", async () => {
  const boom = async () => { throw new Error("ECONNREFUSED"); };
  for (const impl of [mk(401, {}), mk(503, {}), boom]) {
    assert.equal((await verifyToken("u", "t", { fetchImpl: impl })).operator, null);
  }
  assert.equal((await verifyToken("u", "", { fetchImpl: boom })).operator, null);
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


test("CLI contract version matches the installable package", () => {
  const root = new URL("../cc-usage/", import.meta.url);
  const expected = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).version;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("tools/cc-usage.mjs", root)), "contract"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).version, expected);
});
