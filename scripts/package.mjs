import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
execFileSync(process.execPath, [join(root, "scripts/check.mjs")], { stdio: "inherit" });
execFileSync(process.execPath, [join(root, "scripts/render-docs.mjs")], { stdio: "inherit" });
await mkdir(join(root, "artifacts"), { recursive: true });
const [pack] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json",
  "--pack-destination", join(root, "artifacts")], { cwd: root, encoding: "utf8" }));
process.stdout.write(join(root, "artifacts", pack.filename) + "\n");
