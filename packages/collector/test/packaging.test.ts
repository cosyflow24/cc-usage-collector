import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the executable bundle has exactly one shebang", () => {
  const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const bundle = readFileSync(new URL("../dist/cli.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /^#!/);
  assert.equal(bundle.match(/^#!/gm)?.length, 1);
  assert.match(bundle, /^#!\/usr\/bin\/env node\n/);
});
