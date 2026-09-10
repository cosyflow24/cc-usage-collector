// The plugin runs cc-usage/dist/cli.js, not packages/collector/src. Every other
// test in this repo exercises the source, so a change can be green here and
// absent from what users actually install — which is exactly what happened: the
// 403-reason passthrough and the `skipped` counter were fixed in src, merged
// into a bundle that still had neither.
//
// This asserts the two are in sync by rebuilding into a temp dir and diffing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Concatenated bundle text, order-independent and free of chunk hash names. */
function bundleText(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n")
    // Chunk file names carry a content hash and appear in import statements;
    // they differ purely because of the output directory, not the code.
    .replace(/(chunk|upload)-[A-Z0-9]{8}\.js/g, "$1-HASH.js");
}

test("the published dist matches the current source", () => {
  const out = mkdtempSync(join(tmpdir(), "ccu-dist-"));
  try {
    execFileSync("npx", ["tsup", "--out-dir", out], {
      cwd: join(root, "packages", "collector"),
      stdio: "pipe",
      encoding: "utf8",
    });
    assert.equal(
      bundleText(out),
      bundleText(join(root, "cc-usage", "dist")),
      "cc-usage/dist is stale — run `pnpm build` and commit the result, or the plugin ships code nobody reviewed",
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
