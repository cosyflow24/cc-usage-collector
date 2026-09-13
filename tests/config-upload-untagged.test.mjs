// The opt-out that keeps untagged sessions local must survive the whole chain:
// config.json -> readConfig -> the env var the bundle reads. A break anywhere in
// it silently restores the default (upload everything), which is the one failure
// nobody would notice from the outside.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function withConfig(body, run) {
  const dir = mkdtempSync(join(tmpdir(), "ccu-cfg-"));
  const file = join(dir, "config.json");
  if (body !== null) writeFileSync(file, JSON.stringify(body));
  const prevDir = process.env.CC_USAGE_CONFIG_DIR;
  const prevFile = process.env.CC_USAGE_CONFIG_FILE;
  const prevEnv = process.env.CC_USAGE_UPLOAD_UNTAGGED;
  process.env.CC_USAGE_CONFIG_DIR = dir;
  process.env.CC_USAGE_CONFIG_FILE = file;
  delete process.env.CC_USAGE_UPLOAD_UNTAGGED;
  return import(`../cc-usage/tools/core/config.mjs?t=${Date.now()}${Math.random()}`)
    .then((m) => run(m, file))
    .finally(() => {
      if (prevDir === undefined) delete process.env.CC_USAGE_CONFIG_DIR;
      else process.env.CC_USAGE_CONFIG_DIR = prevDir;
      if (prevFile === undefined) delete process.env.CC_USAGE_CONFIG_FILE;
      else process.env.CC_USAGE_CONFIG_FILE = prevFile;
      if (prevEnv === undefined) delete process.env.CC_USAGE_UPLOAD_UNTAGGED;
      else process.env.CC_USAGE_UPLOAD_UNTAGGED = prevEnv;
      rmSync(dir, { recursive: true, force: true });
    });
}

test("uploadUntagged defaults to true", async () => {
  await withConfig({ schemaVersion: 1 }, (m) => {
    assert.equal(m.readConfig().uploadUntagged, true);
  });
});

test("uploadUntagged: false is read back as false", async () => {
  await withConfig({ schemaVersion: 1, uploadUntagged: false }, (m) => {
    assert.equal(m.readConfig().uploadUntagged, false);
  });
});

test("only an explicit false opts out — a truthy or absent value uploads", async () => {
  await withConfig({ schemaVersion: 1, uploadUntagged: true }, (m) => {
    assert.equal(m.readConfig().uploadUntagged, true);
  });
  await withConfig(null, (m) => {
    assert.equal(m.readConfig().uploadUntagged, true);
  });
});

test("writeConfig persists the opt-out and omits the default", async () => {
  await withConfig({ schemaVersion: 1 }, (m, file) => {
    m.writeConfig({ ingestUrl: "https://x/api/ingest", email: "a@b.de", uploadUntagged: false });
    assert.equal(m.readConfig().uploadUntagged, false);
    m.writeConfig({ ingestUrl: "https://x/api/ingest", email: "a@b.de" });
    assert.equal(m.readConfig().uploadUntagged, true);
    assert.equal("uploadUntagged" in JSON.parse(readFileSync(file, "utf8")), false);
  });
});
