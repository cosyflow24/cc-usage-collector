import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { spawnDetachedProcess } from "../cc-usage/tools/core/collector.mjs";

test("SessionEnd worker outlives the three-second hook process", async () => {
  const base = mkdtempSync(join(tmpdir(), "ccu-detached-"));
  const worker = join(base, "worker.mjs");
  const marker = join(base, "finished");
  const log = join(base, "worker.log");
  writeFileSync(worker, `
    import { writeFileSync } from "node:fs";
    await new Promise((resolve) => setTimeout(resolve, 250));
    writeFileSync(process.argv[2], "done");
  `);
  try {
    const started = Date.now();
    spawnDetachedProcess(process.execPath, [worker, marker], process.env, log);
    assert.ok(Date.now() - started < 150, "launcher must return before worker finishes");
    for (let i = 0; i < 20 && !existsSync(marker); i += 1) await delay(50);
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
