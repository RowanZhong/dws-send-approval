// Import the plugin through the real installed host SDK. No Gateway or external effects.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import entry from "../index.mjs";
const host = resolve(process.argv[2]),
  version = JSON.parse(await readFile(join(host, "package.json"), "utf8")).version;
const [year, month] = version.split(".").map(Number);
const modern = year > 2026 || year === 2026 && month >= 8;
const clearInteractive = modern
  ? (await import(pathToFileURL(join(host, "dist/plugin-sdk/plugin-runtime.js")))).clearPluginInteractiveHandlers
  : undefined;
async function load(prefix, symbol) {
  for (const name of (await readdir(join(host, "dist"))).filter(
    (n) => n.startsWith(prefix) && n.endsWith(".js"),
  )) {
    const source = await readFile(join(host, "dist", name), "utf8"),
      exports = source.slice(source.lastIndexOf("export {"));
    const alias = new RegExp("(?:[ {,])" + symbol + " as ([\\w$]+)(?:[, }])").exec(exports)?.[1];
    if (alias) {
      return (await import(pathToFileURL(join(host, "dist", name))))[alias];
    }
  }
  throw Error("Host export missing: " + symbol);
}
const registerCommand = await load("command-registration-", "registerPluginCommand");
const clearCommands = await load("command-registration-", "clearPluginCommands");
const matchCommand = await load("commands-", "matchPluginCommand");
const executeCommand = await load("commands-", "executePluginCommand");
const createRuntimeChannel = modern ? await load("runtime-channel-", "createRuntimeChannel") : undefined;
const folder = await mkdtemp(join(tmpdir(), "dws-assistant-host-")),
  commands = [],
  services = [],
  hooks = [];
const cfg = {
  ownerUserId: "owner",
  dwsPath: join(folder, "dws-fixture"),
  listener: { enabled: false },
  assistant: { cardTemplateId: "fake-template" },
};
const logger = { info() {}, warn() {}, error() {} };
const api = {
  id: "dws-send-approval",
  name: "DWS Reply Assistant",
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
  pluginConfig: cfg,
  logger,
  runtime: {
    version,
    channel: createRuntimeChannel?.(),
    llm: {
      complete() {
        throw Error("No live model expected");
      },
    },
  },
  on: (...args) => hooks.push(args),
  registerCommand: (c) => {
    assert.equal(registerCommand("dws-send-approval", c).ok, true);
    commands.push(c);
  },
  registerService: (s) => services.push(s),
};
try {
  await writeFile(
    cfg.dwsPath,
    `#!${process.execPath}\nconst a=process.argv.slice(2);process.stdout.write(JSON.stringify(a[0]==='profile'?{success:true,currentProfile:'fake:owner',profiles:[{profile:'fake:owner',corpId:'fake',userId:'owner',clientId:'oauth-code',isCurrent:true,status:'active'}]}:a.includes('contact')?{success:true,result:[{userId:'owner',openDingTalkId:'open-owner'}]}:a.includes('search')?{success:true,robotList:[{robotCode:'robot-code',robotName:'fixture'}]}:{success:true,result:{bots:[{name:'fixture',botOpenDingTalkId:'open-fixture'}],hasMore:false}}));\n`,
    { mode: 0o700 },
  );
  assert.equal(entry.register(api), undefined, "plugin registration must remain synchronous");
  assert.deepEqual(
    commands.map((c) => c.name),
    ["dws-listen", "dws-reply", "dws", "ok", "no", "edit"],
  );
  assert.equal(hooks[0][0], "before_tool_call");
  assert.equal(services.length, 1);
  await services[0].start({
    stateDir: folder,
    config: {
      channels: { dingtalk: { clientId: "robot-code" } },
      commands: { text: true, allowFrom: { dingtalk: ["owner"] } },
    },
    logger,
  });
  const invoke = (name, args, overrides = {}) => {
    const body = `/${name} ${args}`.trim(),
      matched = matchCommand(body, { channel: overrides.channel ?? "dingtalk" });
    if (!matched) {
      return { text: "仅允许本人在钉钉中操作。" };
    }
    return executeCommand({
      command: matched.command,
      args: matched.args,
      commandBody: body,
      config: { commands: { text: true, allowFrom: { dingtalk: ["owner"] } } },
      channel: "dingtalk",
      channelId: "dingtalk",
      accountId: "default",
      senderId: "owner",
      from: "owner",
      to: "owner",
      isAuthorizedSender: true,
      sessionKey: "agent:main:main",
      ...overrides,
    });
  };
  // Host registry replay clears commands/interactive handlers, but only the
  // first service is running. New callbacks must locate that active runtime.
  clearCommands();
  clearInteractive?.();
  assert.equal(entry.register(api), undefined);
  assert.equal(services.length, 2);
  assert.match((await invoke("dws", "identity")).text, /正在检测|已就绪/);
  // Cold host imports and child process scheduling can exceed two seconds.
  for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
    if ((await invoke("dws", "identity")).text.includes("状态：已就绪")) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.match((await invoke("dws", "identity")).text, /状态：已就绪/);
  assert.match((await invoke("dws", "identity refresh")).text, /后台身份检测/);
  // Cold host imports and child process scheduling can exceed two seconds.
  for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
    const status = (await invoke("dws", "identity")).text;
    // Refresh retains the verified bot label while replacing the runtime. Wait
    // for readiness as well; the cached label alone is not a completion signal.
    if (status.includes("状态：已就绪") && status.includes("开放 ID：open-fixture")) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.match((await invoke("dws", "identity")).text, /开放 ID：open-fixture/);
  assert.match((await invoke("dws", "identity")).text, /状态：已就绪/);
  assert.match((await invoke("dws-listen", "status")).text, /已关闭/);
  assert.match((await invoke("dws-listen", "dm all")).text, /私聊：全部/);
  assert.match((await invoke("dws", "list")).text, /暂无/);
  assert.match((await invoke("dws", "")).text, /卡片暂不可用/);
  assert.match((await invoke("ok", "1")).text, /编号-版本/);
  for (const overrides of [
    { senderId: "B" },
    { channel: "webchat" },
    { from: "group" },
    { isAuthorizedSender: false },
  ]) {
    assert.match(
      (await invoke("dws", "list", overrides)).text,
      /仅允许本人|not authorized|requires authorization|无权|unauthorized/i,
    );
    assert.match(
      (await invoke("dws", "identity refresh", overrides)).text,
      /仅允许本人|not authorized|requires authorization|无权|unauthorized/i,
    );
  }
  process.stdout.write(
    JSON.stringify({
      version,
      result: "passed",
      checks: [
        "actual-plugin-entry-sdk-import",
        "synchronous-card-registration",
        "six-command-registration",
        "actual-host-command-match-and-dispatch",
        "runtime-prewarm-command-reregistration",
        "guard-retained",
        "service-start-stop",
        "default-off-no-listener-spawn",
        "automatic-profile-and-bot-discovery",
        "owner-only-identity-status-and-refresh",
        "owner-only-private-control",
        "text-fallback",
        "versioned-command-syntax",
      ],
    }) + "\n",
  );
} finally {
  await services[0]?.stop();
  clearInteractive?.();
  await rm(folder, { recursive: true, force: true });
}
