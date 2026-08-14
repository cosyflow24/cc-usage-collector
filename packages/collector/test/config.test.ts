import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveCodexAccountEmail } from "../src/config.ts";

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("Codex identity comes from the local ID token email claim", () => {
  const base = mkdtempSync(join(tmpdir(), "ccu-codex-auth-"));
  const previous = process.env.CODEX_HOME;
  try {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "auth.json"), JSON.stringify({
      tokens: { id_token: jwt({ email: "Codex.User@Personal.Dev" }) },
    }));
    process.env.CODEX_HOME = base;
    assert.equal(resolveCodexAccountEmail(), "codex.user@personal.dev");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(base, { recursive: true, force: true });
  }
});
