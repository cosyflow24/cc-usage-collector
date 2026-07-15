import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  type AuditRow,
  loadJiraAudit,
  maxAuditTs,
  readAuditHwm,
  writeAuditHwm,
} from "../src/audit.ts";

const dir = mkdtempSync(path.join(tmpdir(), "cc-audit-"));

function writeLog(lines: unknown[]): string {
  const file = path.join(dir, `log-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return file;
}

const good = {
  ts: "2026-07-13T10:22:00Z",
  key: "KI-758",
  to: "OnHold",
  by: "idle-auto",
  reason: "idle>45min",
  verified: false,
};

test("loadJiraAudit: parses a valid line 1:1", () => {
  const rows = loadJiraAudit("", writeLog([good]));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], good as AuditRow);
});

test("loadJiraAudit: missing file returns []", () => {
  assert.deepEqual(loadJiraAudit("", path.join(dir, "nope.jsonl")), []);
});

test("loadJiraAudit: skips blank + unparseable + bad-key rows, no throw", () => {
  const file = writeLog([
    "",
    "{not json",
    { ...good, key: "lowercase-1" }, // fails KEY_RE
    { ...good, key: "KI-758'; drop table--" }, // injection attempt → rejected
    { ...good, key: "KI-999" }, // valid
  ]);
  const rows = loadJiraAudit("", file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "KI-999");
});

test("loadJiraAudit: HWM filter is boundary-INCLUSIVE (>= sinceTs)", () => {
  const file = writeLog([
    { ...good, ts: "2026-07-13T09:00:00Z", key: "KI-1" }, // before → dropped
    { ...good, ts: "2026-07-13T10:00:00Z", key: "KI-2" }, // == boundary → kept
    { ...good, ts: "2026-07-13T11:00:00Z", key: "KI-3" }, // after → kept
  ]);
  const rows = loadJiraAudit("2026-07-13T10:00:00Z", file);
  assert.deepEqual(rows.map((r) => r.key), ["KI-2", "KI-3"]);
});

test("loadJiraAudit: skips unparseable-ts and far-future-ts rows (HWM poisoning guard)", () => {
  const future = new Date(Date.now() + 48 * 3_600_000).toISOString();
  const file = writeLog([
    { ...good, ts: "zzzz", key: "KI-1" }, // unparseable → skipped
    { ...good, ts: future, key: "KI-2" }, // >24h in the future → skipped
    { ...good, ts: "2026-07-13T10:00:00Z", key: "KI-3" }, // valid → kept
  ]);
  const rows = loadJiraAudit("", file);
  assert.deepEqual(rows.map((r) => r.key), ["KI-3"]);
});

test("maxAuditTs: never advances past the max VALID ts", () => {
  const future = new Date(Date.now() + 48 * 3_600_000).toISOString();
  assert.equal(
    maxAuditTs([
      { ...good, ts: "zzzz" }, // unparseable — would win a naive string compare
      { ...good, ts: future }, // far future — uploads fine but must not pin the HWM
      { ...good, ts: "9999-12-31T00:00:00Z" }, // absurd future stamp
      { ...good, ts: "2026-07-13T12:00:00Z" }, // max VALID ts
    ]),
    "2026-07-13T12:00:00Z",
  );
  assert.equal(maxAuditTs([{ ...good, ts: "zzzz" }]), "");
});

test("maxAuditTs: returns the latest ts, '' when empty", () => {
  assert.equal(maxAuditTs([]), "");
  assert.equal(
    maxAuditTs([
      { ...good, ts: "2026-07-13T10:00:00Z" },
      { ...good, ts: "2026-07-13T12:00:00Z" },
      { ...good, ts: "2026-07-13T11:00:00Z" },
    ]),
    "2026-07-13T12:00:00Z",
  );
});

test("HWM roundtrip: write then read; corrupt/missing → '' (send all)", () => {
  const file = path.join(dir, "hwm.json");
  assert.equal(readAuditHwm(file), "");
  writeAuditHwm("2026-07-13T12:00:00Z", file);
  assert.equal(readAuditHwm(file), "2026-07-13T12:00:00Z");
  writeFileSync(file, "{ corrupt");
  assert.equal(readAuditHwm(file), "");
});
