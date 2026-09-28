import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { fixture } from "./assistant-fixture.mjs";
import { readConfig } from "../config.mjs";
import { DRAFT_TOOLS } from "../assistant-draft-policy.mjs";
import { createDraftRuntime, finalDraftText } from "../assistant-draft-runtime.mjs";
async function setup(t, overrides = {}) {
  const f = await fixture(t), store = f.assistant.store;
  const config = readConfig({ ...f.config, assistant: { ...f.config.assistant, drafting: { agentId: "dws-draft", toolsEnabled: true } } });
  const d = await f.incoming(f.event()); store.put({ ...d, status: "generating", text: "" });
  const runs = [], deletes = [], waits = [];
  const subagent = { run: async (p) => { runs.push(p); return { runId: "run1", sessionKey: p.sessionKey }; },
    waitForRun: async (p) => { waits.push(p); return { status: "ok" }; },
    getSessionMessages: async () => ({ messages: [{ role: "toolResult", content: "not a reply" }, { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "请核对后发送。" }] }] }),
    deleteSession: async (p) => { deletes.push(p); }, ...overrides.subagent };
  const api = { runtime: { subagent }, config: { agents: { entries: { "dws-draft": {
    workspace: join(f.dir, "dws-send-approval", "draft-workspace", "dws-draft"), model: "openai/model",
    models: { "openai/model": { agentRuntime: { id: "openclaw" }, codeMode: false } }, tools: { allow: [...DRAFT_TOOLS], codeMode: { enabled: false } },
  } } } } };
  const options = { store, auditTools: async () => DRAFT_TOOLS.map((name) => ({ name, pluginId: "dws-send-approval" })), delay: async () => {}, ...overrides.options };
  const runtime = createDraftRuntime(api, config, options); await runtime.start(f.dir);
  return { ...f, store, config, api, runtime, options, runs, deletes, waits, draft: { ...store.draft(d.id), context: [{ sender: "owner", message: "已核实上下文" }] } };
}
test("one task uses target agent, isolated lane, no delivery and only final assistant text", async (t) => {
  const f = await setup(t), body = await f.runtime.draft(f.draft);
  assert.equal(body, "请核对后发送。"); assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0].deliver, false); assert.match(f.runs[0].sessionKey, /^agent:dws-draft:dws-draft:/);
  assert.equal(f.runs[0].lane, "dws-send-approval-draft"); assert.equal(f.runs[0].model, undefined);
  assert.equal(f.runs[0].disableTools, undefined, "common old-host API only");
  assert.equal(f.deletes.length, 1); assert.equal(f.store.draftRuns()[0].sessionDeleted, true);
  assert.equal(f.store.draft(f.draft.id).agentRunPending, false); f.runtime.stop();
});
test("pending and wait timeout continue the same task without a second run", async (t) => {
  let n = 0;
  const f = await setup(t, { subagent: { waitForRun: async () => ({ status: ["pending", "timeout", "ok"][n++] }) } });
  assert.equal(await f.runtime.draft(f.draft), "请核对后发送。"); assert.equal(n, 3); assert.equal(f.runs.length, 1); f.runtime.stop();
});
test("oversized input is rejected before a task or unsettled record is created", async (t) => {
  const f = await setup(t);
  await assert.rejects(f.runtime.draft({ ...f.draft, event: { ...f.draft.event, content: "x".repeat(8001) } }), { code: "LLM_DRAFT_INPUT_TOO_LONG" });
  assert.equal(f.runs.length, 0); assert.equal(f.store.draftRuns().length, 0); f.runtime.stop();
});
test("deadline retains unresolved task, blocks replay and discards late output after reconciliation", async (t) => {
  let clock = Date.now();
  const f = await setup(t, { options: { now: () => clock, budgetMs: 30 }, subagent: { waitForRun: async () => { clock += 15; return { status: "pending" }; } } });
  await assert.rejects(f.runtime.draft(f.draft), { code: "LLM_DRAFT_RUN_UNSETTLED" });
  assert.equal(f.store.draftRuns()[0].state, "unsettled"); assert.equal(f.store.draft(f.draft.id).agentRunPending, true);
  await assert.rejects(f.runtime.draft(f.draft), { code: "LLM_DRAFT_RUN_UNSETTLED" }); assert.equal(f.runs.length, 1);
  f.api.runtime.subagent.waitForRun = async () => ({ status: "ok" });
  await f.runtime.reconcile();
  assert.equal(f.store.draft(f.draft.id).text, ""); assert.equal(f.store.draft(f.draft.id).agentRunPending, false);
  assert.equal(f.store.draftRuns()[0].late, true); assert.equal(f.deletes.length, 1); f.runtime.stop();
});
test("restarting preserves session restrictions and reconciles without replaying tools", async (t) => {
  let clock = Date.now();
  const f = await setup(t, { options: { now: () => clock, budgetMs: 10 }, subagent: { waitForRun: async () => { clock += 10; return { status: "timeout" }; } } });
  await assert.rejects(f.runtime.draft(f.draft)); const task = f.store.draftRuns()[0]; f.runtime.stop();
  const fresh = createDraftRuntime(f.api, f.config, f.options); await fresh.start(f.dir);
  const denied = fresh.policy.before({ toolName: "dws_draft_history", params: {} }, { agentId: "dws-draft", sessionKey: task.sessionKey, runId: "run1", toolCallId: "late", toolName: "dws_draft_history" });
  assert.equal(denied.block, true);
  f.api.runtime.subagent.waitForRun = async () => ({ status: "ok" }); await fresh.reconcile();
  assert.equal(f.runs.length, 1); fresh.stop();
});
test("preflight rejects unsafe actual tool surface before starting any host task", async (t) => {
  const f = await setup(t, { options: { auditTools: async () => [{ name: "exec", pluginId: "other" }] } });
  await assert.rejects(f.runtime.draft(f.draft), { code: "LLM_DRAFT_READONLY_POLICY" });
  assert.equal(f.runs.length, 0); assert.equal(f.store.draftRuns()[0].state, "rejected"); f.runtime.stop();
});
test("final output never falls back to prior assistant prose, tool content or reasoning", () => {
  for (const last of [{ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] },
    { role: "assistant", content: "progress", channel: "commentary" }, { role: "assistant", content: "unfinished", stopReason: "toolUse" },
    { role: "assistant", content: [{ type: "toolCall", name: "x" }] }]) {
    assert.throws(() => finalDraftText([{ role: "assistant", content: "prior" }, last]));
  }
  assert.equal(finalDraftText([{ role: "tool", content: "untrusted" }, { role: "assistant", content: "最终正文" }]), "最终正文");
});
test("new and upgraded config default to tool-free drafting without a dedicated agent", () => {
  const base = { ownerUserId: "A", profile: "corp:A", dwsPath: "/bin/dws" };
  for (const assistant of [undefined, {}, { drafting: {} }, { drafting: { toolsEnabled: false } }]) assert.equal(readConfig({ ...base, assistant }).assistant.drafting.toolsEnabled, false);
  assert.equal(readConfig({ ...base, assistant: { drafting: { toolsEnabled: true } } }).assistant.drafting.toolsEnabled, true);
});
