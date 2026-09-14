// Keep src/version.ts (the User-Agent version) in sync with package.json.
// Runs before every build; `changeset version` only bumps package.json.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const target = join(root, "src", "version.ts");
const next = `/** SDK version; synced from package.json by scripts/sync-version.mjs (runs on build). */\nexport const VERSION = "${version}";\n`;
if (readFileSync(target, "utf8") !== next) {
  writeFileSync(target, next);
  console.log(`src/version.ts -> ${version}`);
}
