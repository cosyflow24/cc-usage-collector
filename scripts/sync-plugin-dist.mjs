import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "packages/collector/dist");
const destination = resolve(root, "cc-usage/dist");

// The plugin executes cc-usage/dist/cli.js, not the package-local build output.
// Replace the whole directory so stale split chunks cannot survive a rebuild.
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });
