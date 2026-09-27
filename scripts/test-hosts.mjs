import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const hosts = process.argv.slice(2);
if (!hosts.length) throw Error("Pass one or more installed OpenClaw package directories.");
for (const supplied of hosts) {
  const host = resolve(supplied), folder = mkdtempSync(join(tmpdir(), "dws-host-matrix-"));
  const version = JSON.parse(readFileSync(join(host, "package.json"), "utf8")).version;
  try {
    for (const name of readdirSync(root)) {
      if (name.endsWith(".mjs") || ["package.json", "openclaw.plugin.json", "scripts", "tests", "templates", "vendor"].includes(name))
        cpSync(join(root, name), join(folder, name), { recursive: true });
    }
    mkdirSync(join(folder, "node_modules"));
    symlinkSync(host, join(folder, "node_modules/openclaw"), "dir");
    const env = { ...process.env, OPENCLAW_STATE_DIR: join(folder, "state"),
      OPENCLAW_CONFIG_PATH: join(folder, "absent.json") };
    const tests = readdirSync(join(folder, "tests")).filter((f) => f.endsWith(".test.mjs"));
    execFileSync(process.execPath, ["--test", ...tests.map((f) => join(folder, "tests", f))],
      { cwd: folder, env, stdio: "inherit" });
    for (const name of ["verify-host", "verify-assistant-host", "verify-model-host", "verify-identity-startup"])
      execFileSync(process.execPath, [join(folder, "scripts", name + ".mjs"), host],
        { cwd: folder, env, stdio: "inherit" });
    console.log(JSON.stringify({ version, result: "passed" }));
  } finally { rmSync(folder, { recursive: true, force: true }); }
}
