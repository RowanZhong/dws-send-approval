import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"],
  { cwd: root, encoding: "utf8" }));
const names = new Set(pack.files.map((f) => f.path));
for (const name of ["index.mjs", "card-transport.mjs", "vendor/dingtalk-card-extensions.mjs",
  "vendor/LICENSE.dingtalk", "openclaw.plugin.json", "compat/manifest.json",
  "compat/new-channel/card-extensions.patch", "docs/contributor/dws-reply-assistant-deployment.html",
  "docs/user/dws-reply-assistant-manual.html", "templates/dws-reply-assistant-card.json"])
  assert.ok(names.has(name), `Missing package file: ${name}`);
for (const name of names)
  assert.ok(!/^(?:node_modules|artifacts|\.local|\.git|channel)\//.test(name) &&
    !name.endsWith(".DS_Store") && !/\.sqlite(?:-|$)|\.env$/.test(name), `Unexpected package file: ${name}`);
const manifest = JSON.parse(await readFile(root + "compat/manifest.json", "utf8"));
for (const [name, hash] of [["vendor/dingtalk-card-extensions.mjs", manifest.vendoredEntrySha256],
  ["compat/new-channel/card-extensions.patch", manifest.patchSha256]])
  assert.equal(createHash("sha256").update(await readFile(root + name)).digest("hex"), hash);
console.log(JSON.stringify({ result: "passed", files: names.size, bytes: pack.size }));
