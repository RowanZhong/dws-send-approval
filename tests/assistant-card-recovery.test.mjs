import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./assistant-fixture.mjs";

test("old buttons recover after both normal and error card updates failed", async (t) => {
  let online = false;
  const updates = [];
  const f = await fixture(t, { transport: {
    sendCard: async () => {}, updateCard: async (x) => {
      if (!online) throw Error("offline"); updates.push(x);
    },
  } });
  const original = await f.assistant.show();
  await f.act(original, "listen");
  assert.ok(f.assistant.store.getCard(original.id));
  assert.equal(f.assistant.store.getCard(original.id).operationState, "failed");
  const pendingDisplay = f.assistant.store.cardForTrack(original.outTrackId).renderedData.description;
  assert.match(pendingDisplay, /卡片暂时未能更新/);
  assert.match(pendingDisplay, /请核对最新状态后再操作/);
  assert.doesNotMatch(pendingDisplay, /offline/);
  online = true;
  // Original toggle is not replayed, even though it was not the first action.
  await f.act(original, "toggle");
  assert.equal(f.prefs.revision, 0);
  assert.match(updates.at(-1).data.description, /本次点击未执行操作/);
  const fresh = f.assistant.store.cardForTrack(original.outTrackId);
  await f.act(fresh, "listen");
  assert.equal(f.assistant.store.cardForTrack(original.outTrackId).name, "listen");
});
test("pending same-card refresh retries after restart without repeating the mutation", async (t) => {
  let clock = Date.now(), online = false;
  const updates = [];
  const f = await fixture(t, { now: () => clock, transport: {
    sendCard: async () => {}, updateCard: async (x) => {
      if (!online) throw Error("offline"); updates.push(x);
    },
  } });
  const original = await f.assistant.show();
  await f.act(original, "toggle");
  assert.equal(f.prefs.revision, 1);
  await f.assistant.stop();
  await f.assistant.start({ stateDir: f.dir });
  await f.assistant.idle();
  online = true;
  clock += 30000;
  await f.assistant.maintenance();
  assert.equal(updates.length, 1);
  assert.equal(f.assistant.store.cardForTrack(original.outTrackId).deliveryState, "delivered");
  await f.act(original, "toggle");
  assert.equal(f.prefs.revision, 1);
});
test("successful send followed by failed display refresh never sends again", async (t) => {
  let online = false;
  const f = await fixture(t, { transport: {
    sendCard: async () => {}, updateCard: async () => { if (!online) throw Error("offline"); },
  } });
  const d = await f.incoming(f.event());
  const original = await f.assistant.show("draft", { id: d.id });
  await f.act(original, "send");
  assert.equal(f.sends.length, 1);
  assert.equal(f.assistant.store.draft(d.id).status, "sent");
  online = true;
  await Promise.all([f.act(original, "send"), f.act(original, "send")]);
  assert.equal(f.sends.length, 1);
  const head = f.assistant.store.cardForTrack(original.outTrackId);
  assert.ok(!head.actions.some((a) => a.op === "send"));
  assert.match(head.renderedData.description, /回复已发送，本次点击未重复发送/);
  assert.match(head.renderedData.description, /已发送 · 完整正文/);
  assert.doesNotMatch(head.renderedData.description, /重新确认|将以你的身份回复/);
});
test("old tokens remain owner/account/track bound during display recovery", async (t) => {
  const f = await fixture(t);
  const original = await f.assistant.show();
  await f.act(original, "listen");
  const head = f.assistant.store.cardForTrack(original.outTrackId).id;
  const count = f.cards.length;
  await f.act(original, "toggle", {}, { userId: "OTHER" });
  await f.act(original, "toggle", {}, { accountId: "OTHER" });
  assert.equal(f.cards.length, count);
  assert.equal(f.assistant.store.cardForTrack(original.outTrackId).id, head);
  assert.equal(f.prefs.revision, 0);
});
