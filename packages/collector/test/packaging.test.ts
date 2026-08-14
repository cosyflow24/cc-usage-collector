import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the executable bundle has exactly one shebang", () => {
  const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const bundle = readFileSync(new URL("../dist/cli.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /^#!/);
  assert.equal(bundle.match(/^#!/gm)?.length, 1);
  assert.match(bundle, /^#!\/usr\/bin\/env node\n/);
  const pluginPackage = JSON.parse(
    readFileSync(new URL("../../../cc-usage/package.json", import.meta.url), "utf8"),
  ) as { type?: string };
  assert.equal(pluginPackage.type, "module");
});

test("employee task bindings declare schema version 1", () => {
  // The shell scripts were folded into the Node CLI (#2); the binding
  // contract now lives in tools/core/state.mjs.
  const state = readFileSync(
    new URL("../../../cc-usage/tools/core/state.mjs", import.meta.url),
    "utf8",
  );
  assert.match(state, /schemaVersion:\s*1,\s*sessionId:/);
});

test("SessionEnd sync runs asynchronously within the Codex three-second cap", () => {
  const config = JSON.parse(
    readFileSync(new URL("../../../cc-usage/hooks/hooks.json", import.meta.url), "utf8"),
  ) as {
    hooks?: { SessionEnd?: Array<{ hooks?: Array<Record<string, unknown>> }> };
  };
  const handler = config.hooks?.SessionEnd?.[0]?.hooks?.[0];
  assert.equal(handler?.async, true);
  assert.equal(handler?.timeout, 3);
  const entry = readFileSync(
    new URL("../../../cc-usage/tools/cc-usage.mjs", import.meta.url),
    "utf8",
  );
  assert.match(entry, /runCollectorDetached/);
});
