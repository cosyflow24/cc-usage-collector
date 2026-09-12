import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

// The version users install is the PLUGIN's (cc-usage/package.json), not this
// package's. Both the build script and the packaging-freshness test run tsup
// from packages/collector, so the path is relative to that directory.
const pluginVersion = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../cc-usage/package.json"), "utf8"),
).version as string;

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node22",
  clean: true,
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __ccuCreateRequire } from 'module';\nconst require = __ccuCreateRequire(import.meta.url);",
  },
  shims: false,
  define: { __CC_USAGE_VERSION__: JSON.stringify(pluginVersion) },
  noExternal: [/.*/],
});
