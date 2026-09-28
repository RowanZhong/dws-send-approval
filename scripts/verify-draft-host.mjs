// Actual host tool construction and hook execution. All DWS reads are inert;
// this is SDK compatibility evidence, not a live DingTalk/LLM validation.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readConfig } from "../config.mjs";
import { AssistantStore } from "../assistant-store.mjs";
import { initialPreferences } from "../preferences.mjs";
import { replySnapshot } from "../rules.mjs";
import { assertDraftAgent, createDraftPolicy, DRAFT_TOOLS } from "../assistant-draft-policy.mjs";
import { createDraftTools } from "../assistant-draft-tools.mjs";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
const host = resolve(process.argv[2]), dist = join(host, "dist");
const version = JSON.parse(await readFile(join(host, "package.json"), "utf8")).version;
async function load(prefix, symbol) {
  for (const name of (await readdir(dist)).filter((n) => n.startsWith(prefix) && n.endsWith(".js"))) {
    const source = await readFile(join(dist, name), "utf8");
    const alias = new RegExp("(?:[ {,])" + symbol + " as ([\\w$]+)(?:[, }])").exec(source.slice(source.lastIndexOf("export {")))?.[1];
    if (alias) return (await import(pathToFileURL(join(dist, name))))[alias];
  }
  throw Error("Host export missing: " + symbol);
}
const initialize = await load("hook-runner-global-", "initializeGlobalHookRunner");
const reset = await load("hook-runner-global-", "resetGlobalHookRunner");
const wrap = await load("agent-tools.before-tool-call-", "wrapToolWithBeforeToolCallHook");
const dir = await mkdtemp(join(tmpdir(), "dws-readonly-host-"));
const pluginDir = join(dir, "plugin"), workspace = join(dir, "workspace");
const config = readConfig({ ownerUserId: "owner", profile: "fixture:owner", dwsPath: "/nonexistent/dws",
  assistant: { drafting: { agentId: "dws-draft", toolsEnabled: true } } });
const store = new AssistantStore(config), contexts = new Map();
let queries = 0;
try {
  await mkdir(pluginDir); await mkdir(workspace); await store.open(dir);
  const prefs = initialPreferences(config);
  const event = { type: "user_im_message_receive_o2o_all", event_id: "fixture", message_id: "msg", conversation_id: "conversation", sender_open_dingtalk_id: "sender", content: "合成测试来信", timestamp: Date.now() };
  const draft = store.create(event, prefs, replySnapshot(event, prefs));
  const sessionKey = "agent:dws-draft:dws-draft:host-fixture";
  store.putDraftRun({ sessionKey, policy: 1, agentId: "dws-draft", profile: config.profile, accountId: config.accountId,
    state: "running", draftId: draft.id, version: draft.version, runId: "host-run", deadline: Date.now() + 120000 });
  contexts.set(sessionKey, { context: [{ sender: "owner", message: "合成上下文" }], handles: new Map() });
  const policy = createDraftPolicy({ store, config });
  const factory = createDraftTools({ config, policy, contexts, runner: async () => { queries++; return { success: true, result: [{ orgEmployeeModel: { orgUserName: "合成本人" } }] }; } });
  globalThis[Symbol.for("dws-readonly-host-fixture")] = { factory };
  await writeFile(join(pluginDir, "package.json"), JSON.stringify({ name: "dws-send-approval", version: "0.0.0", type: "module", openclaw: { extensions: ["./index.mjs"], runtimeExtensions: ["./index.mjs"] } }));
  await writeFile(join(pluginDir, "openclaw.plugin.json"), JSON.stringify({ id: "dws-send-approval", contracts: { tools: [...DRAFT_TOOLS] }, configSchema: { type: "object", properties: {} } }));
  await writeFile(join(pluginDir, "index.mjs"), `export default {id:"dws-send-approval",name:"Read-only fixture",register(api){api.registerTool(ctx=>globalThis[Symbol.for("dws-readonly-host-fixture")].factory(ctx),{names:${JSON.stringify(DRAFT_TOOLS)},optional:true});}};`);
  const agent = { workspace, model: "fixture/model", models: { "fixture/model": { agentRuntime: { id: "openclaw" }, codeMode: false } }, tools: { allow: [...DRAFT_TOOLS], codeMode: { enabled: false } } };
  if (version === "2026.7.1-2") delete agent.models["fixture/model"].codeMode;
  const cfg = { agents: version.startsWith("2026.8.") ? { entries: { "dws-draft": agent } } : { list: [{ id: "dws-draft", ...agent }] },
    plugins: { allow: ["dws-send-approval"], slots: { memory: "none" }, load: { paths: [pluginDir] }, entries: { "dws-send-approval": { enabled: true } } } };
  const registry = { plugins: [{ id: "dws-send-approval", status: "loaded" }], hooks: [], typedHooks: [
    { pluginId: "dws-send-approval", hookName: "before_tool_call", priority: 1000, handler: policy.before },
  ] };
  initialize(registry);
  await assertDraftAgent({ runtime: { version }, config: cfg }, config, sessionKey, workspace);
  const ctx = { config: cfg, agentId: "dws-draft", sessionKey, runId: "host-run", workspaceDir: workspace, modelProvider: "fixture", modelId: "model" };
  const tools = createOpenClawCodingTools(ctx);
  assert.deepEqual(tools.map((t) => t.name).sort(), [...DRAFT_TOOLS].sort());
  const contact = tools.find((t) => t.name === "dws_draft_contact");
  const queried = await contact.execute("allowed-call", { subject: "owner" });
  assert.equal(queries, 1); assert.match(JSON.stringify(queried), /合成本人/);
  let mutations = 0;
  for (const name of ["exec", "write", "edit", "apply_patch", "message", "sessions_spawn", "cron", "unknown"]) {
    const tool = wrap({ name, execute: async () => { mutations++; return { content: [] }; } }, ctx, { emitDiagnostics: false });
    await tool.execute("deny-" + name, { command: "synthetic write" }).catch(() => {});
  }
  assert.equal(mutations, 0);
  registry.typedHooks.push({ pluginId: "fixture-mutator", hookName: "before_tool_call", priority: -100, handler: (e) => ({ params: { ...e.params, argv: ["write"] } }) });
  initialize(registry);
  await contact.execute("modified-call", { subject: "owner" }).catch(() => {});
  assert.equal(queries, 1, "later hooks cannot introduce unchecked arguments");
  initialize({ ...registry, typedHooks: [{ pluginId: "dws-send-approval", hookName: "before_tool_call", handler: () => { throw Error("synthetic hook failure"); } }] });
  await contact.execute("failed-hook", { subject: "owner" }).catch(() => {});
  assert.equal(queries, 1, "hook failure cannot bypass execute-side identity verification");
  initialize(registry);
  const ordinary = wrap({ name: "exec", execute: async () => { mutations++; return { content: [] }; } }, { ...ctx, agentId: "main", sessionKey: "agent:main:main" }, { emitDiagnostics: false });
  await ordinary.execute("ordinary", {}); assert.equal(mutations, 1, "ordinary sessions retain their policy");
  console.log(JSON.stringify({ version, readonlyTools: tools.map((t) => t.name), allowedQueries: queries, refusedWritePaths: 8, ordinarySessionUnchanged: true, result: "passed" }));
} finally { reset(); delete globalThis[Symbol.for("dws-readonly-host-fixture")]; store.close(); await rm(dir, { recursive: true, force: true }); }
