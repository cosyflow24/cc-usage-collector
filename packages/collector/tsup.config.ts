import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node22",
  clean: true,
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __ccuCreateRequire } from 'module';\nconst require = __ccuCreateRequire(import.meta.url);",
  },
  shims: false,
  noExternal: [/.*/],
});
