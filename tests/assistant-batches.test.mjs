import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./assistant-fixture.mjs";
import { createBatchQueue, nextBatch } from "../assistant-batches.mjs";
const tick = () => new Promise(setImmediate);
test("oversized batches never produce an apparently complete draft from a truncated prefix", async (t) => {
  const f = await fixture(t, { batchTiming: { quietMs: 5, waitMs: 20 } });
  for (let i = 0; i < 4; i++) await f.admit(f.event({ conversation_id: "long-batch", content: String(i).repeat(2100) }));
  await f.assistant.idle();
  const rows = f.assistant.store.list(["draft-error"]);
  assert.equal(rows.length, 1); assert.equal(rows[0].batch.memberIds.length, 4);
  assert.equal(f.models.length, 0); assert.match(rows[0].error, /未截断/); assert.equal(f.sends.length, 0);
});
test("four direct messages become one draft with three visible messages and all four in model input", async (t) => {
  const f = await fixture(t, { batchTiming: { quietMs: 5, waitMs: 20 } });
  for (const text of ["第一条独有内容", "第二条内容", "第三条内容", "第四条内容"]) await f.admit(f.event({ conversation_id: "same", content: text }));
  await f.assistant.idle();
  const drafts = f.assistant.store.list(["pending"]);
  assert.equal(drafts.length, 1); assert.equal(f.models.length, 1);
  assert.equal(drafts[0].batch.memberIds.length, 4);
  assert.match(f.models[0][0].event.content, /第一条独有内容[\s\S]*第四条内容/);
  await f.assistant.show("draft", { id: drafts[0].id });
  const text = f.cards.at(-1).data.description;
  assert.doesNotMatch(text, /第一条独有内容/); assert.match(text, /第二条内容[\s\S]*第三条内容[\s\S]*第四条内容/);
});
test("quiet reset never delays snapshot past maximum wait and no participant runs concurrently", async () => {
  let now = 0, index = 0; const timers = new Map(), starts = [];
  const queue = createBatchQueue({ now: () => now, quietMs: 2000, waitMs: 10000,
    setTimer: (fn, delay) => { timers.set(++index, { at: now + delay, fn }); return index; }, clearTimer: (id) => timers.delete(id) });
  const advance = async (ms) => { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } await tick(); };
  let release;
  const work = (n) => () => { starts.push(n); return new Promise((r) => { release = r; }); };
  const pending = [queue.schedule("one", work(0))];
  for (let n = 1; n <= 9; n++) { await advance(1000); pending.push(queue.schedule("one", work(n))); }
  assert.deepEqual(starts, []); await advance(1000); assert.deepEqual(starts, [9]);
  pending.push(queue.schedule("one", work(10))); await advance(2000); assert.deepEqual(starts, [9]);
  release(); await tick(); assert.deepEqual(starts, [9, 10]); release(); await Promise.all(pending); queue.stop();
});
test("gap, maximum age, sending, manual close and out-of-order messages start separate batches", async (t) => {
  const f = await fixture(t), now = Date.now(), previous = { id: 1, created: now, expires: now + 999999, status: "pending", event: { timestamp: now, message_id: "m1" } };
  const draft = { id: 2, event: { timestamp: now + 1000, message_id: "m2" } };
  assert.deepEqual(nextBatch(f.config, previous, draft, now + 1000).memberIds, [1, 2]);
  for (const p of [{ ...previous, status: "sending" }, { ...previous, status: "ignored" }, { ...previous, expires: now },
    { ...previous, batch: { id: 1, closed: true, memberIds: [1] } }, { ...previous, created: now - 300001 }]) {
    assert.deepEqual(nextBatch(f.config, p, draft, now + 1000).memberIds, [2]);
  }
  assert.deepEqual(nextBatch(f.config, previous, draft, now + 31000).memberIds, [2]);
  assert.deepEqual(nextBatch(f.config, previous, { ...draft, event: { ...draft.event, timestamp: now - 1 } }, now).memberIds, [2]);
});
test("editing survives new messages and needs a fresh confirmation before send", async (t) => {
  const f = await fixture(t), first = await f.incoming(f.event({ conversation_id: "same", content: "旧问题" }));
  const edit = await f.assistant.show("edit", { id: first.id });
  const second = await f.incoming(f.event({ conversation_id: "same", content: "补充问题" }));
  assert.equal(f.assistant.store.cardForTrack(edit.outTrackId).id, edit.id);
  await f.act(edit, "edit-send", { body: "本人正在编辑的正文" });
  assert.equal(f.sends.length, 0); assert.equal(f.lastCard().args.id, second.id);
  assert.equal(f.lastCard().fields[0].defaultValue, "本人正在编辑的正文");
  await f.act(f.lastCard(), "edit-send"); assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].text, "本人正在编辑的正文");
});
test("send claim freezes the old batch, a concurrent new message starts a new one", async (t) => {
  let release; const f = await fixture(t, { send: () => new Promise((r) => { release = r; }) });
  const first = await f.incoming(f.event({ conversation_id: "same" }));
  const sending = f.assistant.command("ok", { id: first.id, version: first.version }); await tick();
  assert.equal(f.assistant.store.draft(first.id).status, "sending");
  await f.admit(f.event({ conversation_id: "same" })); await tick();
  const second = f.assistant.store.list(["pending"])[0];
  assert.deepEqual(second.batch.memberIds, [second.id]);
  release(); await sending; await f.assistant.idle();
  assert.equal(f.assistant.store.draft(first.id).status, "sent"); assert.equal(f.assistant.store.draft(second.id).status, "pending");
});
test("two senders in one group retain separate pending replies", async (t) => {
  const f = await fixture(t);
  await f.incoming(f.event({ type: "user_im_message_receive_at", conversation_id: "G", sender_open_dingtalk_id: "B" }));
  await f.incoming(f.event({ type: "user_im_message_receive_at", conversation_id: "G", sender_open_dingtalk_id: "C" }));
  assert.equal(f.assistant.store.list(["pending"]).length, 2);
});
test("owner manual reply found at send time blocks sending until separately acknowledged", async (t) => {
  const timestamp = Date.now() - 5000; let ownerAt = 0;
  const f = await fixture(t, { historyRunner: async () => ({ contractVersion: "im.message-list.v1", complete: true,
    messages: ownerAt ? [{ messageId: "own", conversationId: "same", senderId: "A", messageType: "text", text: "我自己已回复", createTime: ownerAt }] : [] }) });
  const d = await f.incoming(f.event({ conversation_id: "same", timestamp }));
  ownerAt = timestamp + 1000;
  await f.act(await f.assistant.show("draft", { id: d.id }), "send");
  assert.equal(f.sends.length, 0); assert.equal(f.assistant.store.draft(d.id).status, "stale");
  await f.act(f.lastCard(), "ack-owner-reply"); assert.equal(f.sends.length, 0);
  await f.act(f.lastCard(), "send"); assert.equal(f.sends.length, 1);
});
test("merging does not renew the current card lifetime", async (t) => {
  const f = await fixture(t), d = await f.incoming(f.event({ conversation_id: "same" }));
  const c = await f.assistant.show("draft", { id: d.id });
  await f.incoming(f.event({ conversation_id: "same" }));
  assert.equal(f.assistant.store.cardForTrack(c.outTrackId).expires, c.expires);
});
