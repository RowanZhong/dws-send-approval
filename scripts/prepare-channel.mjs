import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (!args[0] || args.length !== 1 && !(args.length === 3 && args[1] === "--source"))
  throw Error("Usage: node scripts/prepare-channel.mjs <new-directory> [--source <local-git-clone>]");
const target = resolve(args[0]);
if (existsSync(target)) throw Error("Destination must not exist; existing projects are never modified.");
const manifest = JSON.parse(readFileSync(join(root, "compat/manifest.json"), "utf8"));
const patch = join(root, "compat/new-channel/card-extensions.patch");
if (createHash("sha256").update(readFileSync(patch)).digest("hex") !== manifest.patchSha256)
  throw Error("Patch checksum mismatch");
const git = (params, cwd) => execFileSync("git", params, { cwd, stdio: "inherit" });
git(["clone", "--no-checkout", "--no-hardlinks", "--", args[2] ? resolve(args[2]) : manifest.upstream, target]);
git(["checkout", "--detach", manifest.baseCommit], target);
git(["switch", "-c", "codex/card-api-transition"], target);
git(["remote", "set-url", "origin", manifest.upstream + ".git"], target);
git(["apply", "--check", patch], target);
git(["apply", patch], target);
console.log(JSON.stringify({ result: "prepared", directory: target, upstream: manifest.upstream,
  base: manifest.baseCommit, next: ["pnpm install --frozen-lockfile", "pnpm run build:runtime",
    "pnpm run build:types", "pnpm run pack:check"] }));
