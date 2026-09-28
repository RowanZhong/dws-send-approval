import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fixture } from "./assistant-fixture.mjs";
import { readConfig } from "../config.mjs";
import { createDraftPolicy, assertDraftAgent, DRAFT_TOOLS } from "../assistant-draft-policy.mjs";
import { createDraftTools } from "../assistant-draft-tools.mjs";
export async function draftFixture(t) {
  const f = await fixture(t); const config = readConfig({ ...f.config, assistant: { ...f.config.assistant, drafting: { toolsEnabled: true, agentId: "dws-draft" } } });
  let d = await f.incoming(f.event()); d = f.assistant.store.put({ ...d, status: "generating" });
  const sessionKey = "agent:dws-draft:dws-draft:test", store = f.assistant.store;
  const record = store.putDraftRun({ sessionKey, agentId: "dws-draft", profile: config.profile, accountId: config.accountId,
    policy: 1, state: "starting", draftId: d.id, version: d.version, deadline: Date.now() + 100000 });
  const policy = createDraftPolicy({ store, config });
  const ctx = { sessionKey, agentId: "dws-draft", runId: "run1", toolCallId: "call1", toolName: "dws_draft_contact" };
  return { ...f, config, d, store, record, policy, ctx };
}
test("every unreviewed tool and side-effect parameter is refused before execute", async (t) => {
  const f = await draftFixture(t);
  for (const toolName of ["exec", "write", "edit", "apply_patch", "browser", "message", "sessions_spawn", "cron", "tool_search", "code_mode", "unknown"]) {
    assert.equal(f.policy.before({ toolName, params: { command: "delete user data" } }, { ...f.ctx, toolName }).block, true);
  }
  assert.equal(f.policy.before({ toolName: "dws_draft_contact", params: { subject: "owner", profile: "other" } }, f.ctx).block, true);
  assert.equal(f.policy.before({ toolName: "dws_draft_contact", params: { subject: "owner" } }, { ...f.ctx, sessionKey: undefined }).block, true);
  assert.equal(f.policy.before({ toolName: "exec", params: {} }, { agentId: "main", sessionKey: "agent:main:main", toolName: "exec" }), undefined);
});
test("execute rechecks final arguments, call identity, state and profile, and consumes each ticket once", async (t) => {
  const f = await draftFixture(t), params = { subject: "owner" };
  assert.equal(f.policy.before({ toolName: f.ctx.toolName, params }, f.ctx), undefined);
  assert.throws(() => f.policy.execute(f.ctx, "call1", f.ctx.toolName, { ...params, argv: ["write"] }));
  assert.throws(() => f.policy.execute(f.ctx, "call1", f.ctx.toolName, params), /校验/);
  const ctx = { ...f.ctx, toolCallId: "call2" };
  assert.equal(f.policy.before({ toolName: ctx.toolName, params }, ctx), undefined);
  assert.equal(f.policy.execute(ctx, "call2", ctx.toolName, params).runId, "run1");
  assert.throws(() => f.policy.execute(ctx, "call2", ctx.toolName, params));
  assert.equal(f.policy.before({ toolName: ctx.toolName, params }, { ...ctx, toolCallId: "call3", runId: "other" }).block, true);
  f.store.put({ ...f.d, version: f.d.version + 1 });
  assert.equal(f.policy.before({ toolName: ctx.toolName, params }, { ...ctx, toolCallId: "call4" }).block, true);
});
test("readonly contact tool uses a fixed command and returns no phone/email fields", async (t) => {
  const f = await draftFixture(t), calls = [], params = { subject: "owner" };
  const contexts = new Map([[f.ctx.sessionKey, { context: [], handles: new Map() }]]);
  const factory = createDraftTools({ config: f.config, policy: f.policy, contexts, runner: async (_, argv) => {
    calls.push(argv); return { success: true, result: [{ orgEmployeeModel: { orgUserName: "测试本人", orgUserMobile: "secret-phone", orgEmail: "secret-email", depts: [{ deptName: "测试部门" }] } }] };
  } });
  const tool = factory(f.ctx).find((t) => t.name === f.ctx.toolName);
  f.policy.before({ toolName: f.ctx.toolName, params }, f.ctx);
  const result = await tool.execute("call1", params);
  assert.deepEqual(calls, [["contact", "user", "get-self", "--format", "json"]]);
  assert.match(result.content[0].text, /测试本人/); assert.doesNotMatch(result.content[0].text, /secret-/);
  await assert.rejects(tool.execute("call1", params)); assert.equal(calls.length, 1);
});
test("unregistered or replayed sessions expose no tools; config disabled still blocks protected sessions", async (t) => {
  const f = await draftFixture(t);
  const factory = createDraftTools({ config: f.config, policy: f.policy, contexts: new Map() });
  assert.deepEqual(factory({ ...f.ctx, sessionKey: "agent:dws-draft:dws-draft:unknown" }), []);
  const disabled = createDraftPolicy({ store: f.store, config: { ...f.config, assistant: { ...f.config.assistant, drafting: { ...f.config.assistant.drafting, toolsEnabled: false } } } });
  assert.equal(disabled.before({ toolName: f.ctx.toolName, params: { subject: "owner" } }, f.ctx).block, true);
});
test("preflight checks resolved tool names and implementation ownership, not just an allow array", async (t) => {
  const f = await draftFixture(t), workspace = join(f.dir, "draft-workspace"); await mkdir(workspace);
  const sentinel = join(f.dir, "user-data.txt"); await writeFile(sentinel, "unchanged");
  const agent = { workspace, model: "openai/model", models: { "openai/model": { agentRuntime: { id: "openclaw" }, codeMode: false } }, tools: { allow: [...DRAFT_TOOLS], codeMode: { enabled: false } } };
  const api = { runtime: {}, config: { agents: { entries: { "dws-draft": agent } } } };
  const valid = DRAFT_TOOLS.map((name) => ({ name, pluginId: "dws-send-approval" }));
  await assertDraftAgent(api, f.config, f.ctx.sessionKey, workspace, { auditTools: async () => valid });
  for (const surface of [[...valid, { name: "exec" }], valid.map((r) => ({ ...r, pluginId: "spoof" })), valid.slice(1)]) {
    await assert.rejects(assertDraftAgent(api, f.config, f.ctx.sessionKey, workspace, { auditTools: async () => surface }), /工具集合或来源/);
  }
  agent.tools.alsoAllow = ["exec"];
  await assert.rejects(assertDraftAgent(api, f.config, f.ctx.sessionKey, workspace, { auditTools: async () => valid }), /允许清单/);
  assert.equal(await readFile(sentinel, "utf8"), "unchanged");
});

test("document handles require verified workspace metadata and are rechecked before reading", async (t) => {
  const f = await draftFixture(t), calls = [], contexts = new Map([[f.ctx.sessionKey, { context: [], handles: new Map() }]]);
  const config = { ...f.config, assistant: { ...f.config.assistant, drafting: { ...f.config.assistant.drafting, documentWorkspaceIds: ["allowed"] } } };
  let moved = false;
  const factory = createDraftTools({ config, policy: f.policy, contexts, runner: async (_, argv) => {
    calls.push(argv);
    if (argv[1] === "+search") return { contractVersion: "doc.list.v1", complete: true, documents: [
      { nodeId: "safe", docType: "adoc", name: "可读取" }, { nodeId: "outside", docType: "adoc", name: "不能泄露标题" }, { nodeId: "file", docType: "pdf", name: "附件" }] };
    if (argv[1] === "+inspect") return { contractVersion: "doc.operation.v1", data: { document: { nodeId: argv[3], workspaceId: argv[3] === "safe" && !moved ? "allowed" : "outside" } } };
    if (argv[1] === "+fetch") return { contractVersion: "doc.content.v1", content: { markdown: "已核实正文" } };
    throw Error("unexpected command");
  } });
  async function call(name, params, id) {
    const ctx = { ...f.ctx, toolName: name, toolCallId: id };
    assert.equal(f.policy.before({ toolName: name, params }, ctx), undefined);
    return JSON.parse((await factory(ctx).find(t=>t.name===name).execute(id, params)).content[0].text);
  }
  const result = await call("dws_draft_search", { query: "说明" }, "search");
  assert.equal(result.documents.length, 1); assert.equal(result.complete, false);
  assert.ok(!JSON.stringify(result).includes("不能泄露标题"));
  const handle = result.documents[0].handle;
  assert.equal((await call("dws_draft_read", { handle }, "read")).text, "已核实正文");
  moved = true; const reads = calls.filter(a=>a[1]==="+fetch").length;
  await assert.rejects(call("dws_draft_read", { handle }, "moved"), /范围/);
  assert.equal(calls.filter(a=>a[1]==="+fetch").length, reads);
});

test("empty document search can find bounded authorized root titles without leaking other rows", async (t) => {
  const f = await draftFixture(t), calls = [], contexts = new Map([[f.ctx.sessionKey, { context: [], handles: new Map() }]]);
  const config = { ...f.config, assistant: { ...f.config.assistant, drafting: { ...f.config.assistant.drafting, documentWorkspaceIds: ["one", "two", "three", "four"] } } };
  const factory = createDraftTools({ config, policy: f.policy, contexts, runner: async (_, argv) => {
    calls.push(argv);
    if (argv[1] === "+search") return { contractVersion: "doc.list.v1", complete: true, documents: [] };
    if (argv[0] === "wiki") return { success: true, hasMore: true, nodes: argv[4] === "one" ? [
      { nodeId: "safe", workspaceId: "one", extension: "adoc", name: "Blue Whale instructions" },
      { nodeId: "wrong-scope", workspaceId: "outside", extension: "adoc", name: "Blue secret" },
      { nodeId: "attachment", workspaceId: "one", extension: "pdf", name: "Blue attachment" },
      { nodeId: "irrelevant", workspaceId: "one", extension: "adoc", name: "Unrelated secret" },
    ] : [] };
    if (argv[1] === "+inspect") return { data: { document: { nodeId: "safe", workspaceId: "one" } } };
    throw Error("unexpected query");
  } });
  const name = "dws_draft_search", params = { query: "blue" }, ctx = { ...f.ctx, toolName: name };
  assert.equal(f.policy.before({ toolName: name, params }, ctx), undefined);
  const result = JSON.parse((await factory(ctx).find(t => t.name === name).execute(ctx.toolCallId, params)).content[0].text);
  assert.equal(result.complete, false); assert.equal(result.matching, "limited_root_titles");
  assert.deepEqual(result.documents.map(d => d.title), ["Blue Whale instructions"]);
  assert.doesNotMatch(JSON.stringify(result), /secret|attachment/);
  assert.deepEqual(calls.filter(a => a[0] === "wiki").map(a => a[4]), ["one", "two", "three"]);
  assert.ok(calls.filter(a => a[0] === "wiki").every(a => a.includes("50") && !a.includes("--cursor")));
  assert.deepEqual(calls.filter(a => a[1] === "+inspect").map(a => a[3]), ["safe"]);
});

test("document search errors and incomplete searches never use the title supplement", async (t) => {
  for (const response of [{ ok: false, error: "permission denied" }, { contractVersion: "doc.list.v1", complete: false, documents: [] }]) {
    const f = await draftFixture(t), calls = [], contexts = new Map([[f.ctx.sessionKey, { context: [], handles: new Map() }]]);
    const config = { ...f.config, assistant: { ...f.config.assistant, drafting: { ...f.config.assistant.drafting, documentWorkspaceIds: ["allowed"] } } };
    const factory = createDraftTools({ config, policy: f.policy, contexts, runner: async (_, argv) => { calls.push(argv); return response; } });
    const name = "dws_draft_search", params = { query: "test" }, ctx = { ...f.ctx, toolName: name };
    f.policy.before({ toolName: name, params }, ctx);
    const request = factory(ctx).find(t => t.name === name).execute(ctx.toolCallId, params);
    if (response.ok === false) await assert.rejects(request, /查询失败/); else await request;
    assert.equal(calls.length, 1); assert.equal(calls[0][1], "+search");
  }
});
