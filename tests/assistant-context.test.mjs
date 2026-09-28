import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../config.mjs";
import { createContextReader, messageTime, selectContext } from "../assistant-context.mjs";
import { fixture } from "./assistant-fixture.mjs";
const end = Date.parse("2026-09-28T01:00:00+08:00");
const config = readConfig({ ownerUserId: "owner-user", ownerOpenId: "owner-open", profile: "corp:owner-user", dwsPath: "/bin/dws" });
const draft = { event: { timestamp: end - 1, conversation_id: "G", sender_open_dingtalk_id: "B", message_id: "trigger" }, reply: { direct: false } };
const row = (extra = {}) => ({ messageId: "m", conversationId: "G", senderId: "B", messageType: "text", text: "可用历史", createTime: end - 1000, ...extra });
const envelope = (messages, extra = {}) => ({ contractVersion: "im.message-list.v1", complete: true, messages, ...extra });
test("group context keeps sender nonmentions and owner, rejects other parties, times, conversations and media", () => {
  const r = selectContext(envelope([
    row({ messageId: "start", createTime: end - 300000 }), row({ messageId: "before", createTime: end - 300001 }),
    row({ messageId: "end", createTime: end }), row({ messageId: "trigger" }), row({ messageId: "self", senderId: "owner-open" }),
    row({ messageId: "other", senderId: "C" }), row({ messageId: "wrong", conversationId: "X" }), row({ messageId: "media", messageType: "image" }),
    row({ messageId: "quote", quotedMessage: { text: "引用不要扩展" } }), row({ messageId: "unknown", messageType: undefined }),
    row({ messageId: "self", senderId: "owner-user" }), row({ messageId: "late", createTime: end + 30000 }),
  ]), config, draft, end - 300000, end);
  assert.deepEqual(r.messages.map((m) => m.id), ["start", "self", "unknown"]);
  assert.equal(r.messages[1].sender, "owner"); assert.equal(r.skippedUnknown, 0); assert.equal(r.complete, true);
  assert.equal(r.textProjection, true); assert.equal(r.attachmentsRead, false);
});
test("flattened history uses available text but strips identifiable media without retrieving resources", () => {
  const r = selectContext(envelope([
    row({ messageId: "plain", messageType: undefined, text: "会面时间为 18:35。" }),
    row({ messageId: "mixed", messageType: undefined, text: "请看说明。\n[图片消息](mediaId=secret)\n![附件截图](https://example.test/image)\n明天再讨论。" }),
    row({ messageId: "placeholder", messageType: undefined, text: "[文件消息](fileId=secret)" }),
    row({ messageId: "resource", messageType: undefined, text: "不可读附件", resourceRefs: [{ id: "secret" }] }),
    row({ messageId: "card", messageType: undefined, msgType: "card", text: "卡片内容" }),
    row({ messageId: "rich", messageType: "richText", text: "保留正文里的普通链接 https://example.test/guide 和 [待办] 字样" }),
    row({ messageId: "unknown-kind", messageType: "unsupported-format", text: "不能确认其内容" }),
  ]), config, draft, end - 300000, end);
  assert.deepEqual(r.messages.map(m => m.id), ["mixed", "plain", "rich"]);
  assert.match(r.messages[0].message, /请看说明。[\s\S]*明天再讨论。/);
  assert.doesNotMatch(JSON.stringify(r.messages), /secret|image|不可读附件|卡片内容/);
  assert.match(r.messages[2].message, /https:\/\/example.test\/guide/);
  assert.equal(r.messageCount, 3); assert.equal(r.filteredMedia, 4);
  assert.equal(r.skippedUnknown, 1); assert.equal(r.partial, true); assert.equal(r.attachmentsRead, false);
});
test("DingTalk wall clock parsing does not depend on machine timezone", () => {
  assert.equal(messageTime("2026-09-28 01:00:00"), end);
  assert.equal(messageTime(end / 1000), end);
  assert.ok(Number.isNaN(messageTime("2026-09-28T01:00:00")));
});
test("bounded cached reads preserve partial results and never accept model-provided query arguments", async () => {
  const calls = []; let tick = end;
  const reader = createContextReader(config, { now: () => tick, runner: async (c, args) => { calls.push({ c, args }); return envelope([row()], { complete: false, partial: true, failedCount: 1 }); } });
  const a = await reader.read(draft); await reader.read(draft);
  assert.equal(a.partial, true); assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes("--download-resources"), false);
  assert.equal(calls[0].args[calls[0].args.indexOf("--group") + 1], "G");
  await reader.read({ ...draft, event: { ...draft.event, sender_open_dingtalk_id: "C" } });
  assert.equal(calls.length, 1, "cached rows are filtered again for each sender");
  tick += 30001; await reader.read(draft); assert.equal(calls.length, 2);
  await reader.read(draft, { fresh: true }); assert.equal(calls.length, 3);
});
test("history toggle prevents all queries and result limits are enforced", async () => {
  const disabled = { ...config, assistant: { ...config.assistant, context: { historyMinutes: 0 } } };
  const r = await createContextReader(disabled, { runner() { throw Error("must not call"); } }).read(draft);
  assert.equal(r.disabled, true); assert.deepEqual(r.messages, []);
  const large = selectContext(envelope(Array.from({ length: 60 }, (_, i) => row({ messageId: `m${i}`, text: "x".repeat(1000) }))), config, draft, end - 300000, end);
  assert.ok(large.messages.length <= 50); assert.equal(large.messages.reduce((n, m) => n + m.message.length, 0), 12000);
  assert.equal(large.truncated, true);
});
test("failed history does not prevent no-tool drafting and history payload is not persisted", async (t) => {
  const f = await fixture(t, { historyRunner: async () => { throw Error("offline"); } });
  const d = await f.incoming(f.event());
  assert.equal(d.status, "pending"); assert.equal(d.context, undefined);
  assert.equal(d.contextStatus.reason, "history_unavailable"); assert.equal(f.models.length, 1);
});
