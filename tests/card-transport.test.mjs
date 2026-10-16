import assert from "node:assert/strict";
import test from "node:test";
import { createCardTransport } from "../card-transport.mjs";

const config = { accountId: "default", ownerUserId: "owner" };
const uuid = "12345678-1234-1234-1234-123456789abc";
const request = { ...config, templateId: "template.schema", outTrackId: `dws-assistant-${uuid}`,
  data: { title: "Hello", form: { fields: [{ name: "note", type: "TEXT" }] } } };
function setup(t, modern = true) {
  let ready = true, failure;
  const calls = [], callbacks = [], state = { assistants: new Map(), channel: {
    sendCard: async (r) => calls.push(["legacy-send", r]),
    updateCard: async (r) => calls.push(["legacy-update", r]),
  } };
  const extension = {
    isReady: () => ready,
    sendCard: async (r) => { calls.push(["generic-send", r]); if (failure) throw failure; },
    updateCard: async (r) => { calls.push(["generic-update", r]); if (failure) throw failure; },
  };
  const transport = createCardTransport(config, (action) => callbacks.push(action), {
    legacy: () => state, extension: modern ? extension : undefined,
  });
  transport.start(); t.after(() => transport.stop());
  return { transport, state, calls, callbacks, setReady: (s) => ready = s,
    fail: () => failure = Error("uncertain delivery") };
}
test("public API serializes structured variables and keeps logical card identity", async (t) => {
  const s = setup(t); await s.transport.sendCard(request);
  assert.equal(s.transport.mode(), "generic");
  assert.equal(s.transport.isReady(), true);
  assert.deepEqual(s.calls, [["generic-send", { cardId: uuid, userId: "owner", templateId: "template.schema",
    variables: { title: "Hello", form: JSON.stringify(request.data.form) } }]]);
});
test("legacy host uses the bridge without a modern registration", async (t) => {
  const s = setup(t, false); await s.transport.sendCard(request);
  assert.equal(s.transport.mode(), "legacy");
  assert.equal(s.transport.isReady(), true);
  assert.equal(s.calls[0][0], "legacy-send");
  await s.state.assistants.get("default").handle({ accountId: "default", userId: "owner", outTrackId: request.outTrackId });
  assert.equal(s.callbacks[0].transport, "legacy");
});
test("isReady false never changes the selected backend or retries through the bridge", async (t) => {
  const s = setup(t); s.setReady(false); s.fail();
  assert.equal(s.transport.mode(), "generic");
  assert.equal(s.transport.isReady(), false);
  await assert.rejects(s.transport.sendCard(request), /uncertain/);
  assert.deepEqual(s.calls.map((c) => c[0]), ["generic-send"]);
});
test("update failures never create or retry a card on another backend", async (t) => {
  const s = setup(t); s.fail();
  await assert.rejects(s.transport.updateCard({ ...request, transport: "generic" }), /uncertain/);
  assert.deepEqual(s.calls.map((c) => c[0]), ["generic-update"]);
});
test("persisted backend selection is honored for old card updates", async (t) => {
  const s = setup(t);
  await s.transport.updateCard({ ...request, transport: "legacy" });
  assert.equal(s.calls[0][0], "legacy-update");
  assert.equal(s.calls[0][1].transport, undefined);
});
test("an old host cannot reinterpret persisted modern cards as legacy", async (t) => {
  const s = setup(t, false);
  await assert.rejects(s.transport.updateCard({ ...request, transport: "generic" }), /不支持/);
  assert.equal(s.calls.length, 0);
});
test("wrong owner, account, track ID and unknown backend are rejected before sending", async (t) => {
  const s = setup(t);
  for (const override of [{ ownerUserId: "B" }, { accountId: "other" }, { outTrackId: "ask_abc" },
    { transport: "anything" }]) await assert.rejects(s.transport.sendCard({ ...request, ...override }));
  assert.equal(s.calls.length, 0);
});
test("stop closes the runtime gate without disposing its plugin registration", async (t) => {
  const s = setup(t), callback = s.state.assistants.get("default").handle;
  s.transport.stop();
  assert.equal(s.state.assistants.size, 0);
  assert.equal(s.transport.isReady(), false);
  await assert.rejects(s.transport.sendCard(request));
  assert.equal(await callback({ accountId: "default", userId: "owner" }), false);
  assert.equal(s.callbacks.length, 0);
  s.transport.start();
  await s.transport.sendCard(request);
  assert.equal(s.calls[0][0], "generic-send");
});
test("old disposer cannot delete a replacement legacy registration", (t) => {
  const s = setup(t), replacement = { handle() {} };
  s.state.assistants.set("default", replacement); s.transport.stop();
  assert.equal(s.state.assistants.get("default"), replacement);
});
test("duplicate account runtime fails without replacing the running handler", (t) => {
  const s = setup(t), original = s.state.assistants.get("default");
  const duplicate = createCardTransport(config, () => {}, { legacy: () => s.state });
  assert.throws(() => duplicate.start(), /已有/);
  duplicate.stop();
  assert.equal(s.state.assistants.get("default"), original);
});
test("modern readiness can recover without re-registration or backend changes", async (t) => {
  const s = setup(t); s.setReady(false); delete s.state.channel;
  assert.equal(s.transport.mode(), "generic");
  assert.equal(s.transport.isReady(), false);
  s.setReady(true); await s.transport.sendCard(request);
  assert.equal(s.transport.isReady(), true);
  assert.equal(s.calls[0][0], "generic-send");
});
