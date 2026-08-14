import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const stateModule = new URL("../cc-usage/tools/core/state.mjs", import.meta.url).href;

function bind(provider) {
  const sandbox = mkdtempSync(join(tmpdir(), "ccu-state-"));
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: join(sandbox, "claude"),
    CODEX_THREAD_ID: provider === "codex" ? "shared-id" : "",
    CLAUDE_CODE_SESSION_ID: provider === "claude" ? "shared-id" : "",
  };
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { setTask } = await import(${JSON.stringify(stateModule)});
    process.stdout.write(setTask("BI-220", "", ${JSON.stringify(sandbox)}));
  `], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const line = readFileSync(join(sandbox, "claude", "cc-usage", "tasks.jsonl"), "utf8").trim();
  const row = JSON.parse(line);
  rmSync(sandbox, { recursive: true, force: true });
  return row;
}

test("setTask records the current Codex thread with an explicit provider", () => {
  const row = bind("codex");
  assert.equal(row.sessionId, "shared-id");
  assert.equal(row.provider, "codex");
  assert.equal(row.jira, "BI-220");
});

test("setTask keeps Claude attribution behavior and marks the provider", () => {
  const row = bind("claude");
  assert.equal(row.sessionId, "shared-id");
  assert.equal(row.provider, "claude");
});
