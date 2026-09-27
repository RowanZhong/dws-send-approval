import assert from "node:assert/strict";
import test from "node:test";
import { createCardTransport, CARD_NAMESPACE } from "../card-transport.mjs";

const config = { accountId: "default", ownerUserId: "owner" };
const uuid = "12345678-1234-1234-1234-123456789abc";
const request = { ...config, templateId: "template.schema", outTrackId: `dws-assistant-${uuid}`,
  data: { title: "Hello", form: { fields: [{ name: "note", type: "TEXT" }] } } };
function setup(t, initial = "ready") {
  let status = initial, options, disposed = 0, failure;
  const calls = [], callbacks = [], state = { assistants: new Map(), channel: {
    sendCard: async (r) => calls.push(["legacy-send", r]),
    updateCard: async (r) => calls.push(["legacy-update", r]),
  } };
  const transport = createCardTransport(config, (action) => callbacks.push(action), {
    legacy: () => state,
    register: (input) => { options = input; return {
      getStatus: () => status,
      sendCard: async (r) => { calls.push(["generic-send", r]); if (failure) throw failure; },
      updateCard: async (r) => { calls.push(["generic-update", r]); if (failure) throw failure; },
      dispose: () => disposed++,
    }; },
  });
  transport.start(); t.after(() => transport.stop());
  return { transport, state, calls, callbacks, get options() { return options; },
    setStatus: (s) => status = s, fail: () => failure = Error("uncertain delivery"),
    get disposed() { return disposed; } };
}
test("prefers public API and serializes structured variables without sharing HTTP or credentials", async (t) => {
  const s = setup(t); await s.transport.sendCard(request);
  assert.equal(s.transport.mode(), "generic");
  assert.equal(s.options.namespace, CARD_NAMESPACE);
  assert.deepEqual(s.calls, [["generic-send", { cardId: uuid, userId: "owner", templateId: "template.schema",
    variables: { title: "Hello", form: JSON.stringify(request.data.form) } }]]);
});
test("public callback restores logical identity and forwards only the single original action", async (t) => {
  const s = setup(t);
  const action = { ...config, namespace: CARD_NAMESPACE, userId: "owner", cardId: uuid,
    actionIds: ["save"], form: { note: "test" } };
  await s.options.onAction(action);
  assert.deepEqual(s.callbacks[0], { accountId: "default", userId: "owner", outTrackId: request.outTrackId,
    actionId: "save", values: { note: "test" }, transport: "generic" });
  for (const override of [{ userId: "B" }, { accountId: "other" }, { actionIds: ["save", "send"] },
    { namespace: "another" }, { cardId: "wrong-id" }]) await s.options.onAction({ ...action, ...override });
  assert.equal(s.callbacks.length, 1);
});
test("legacy bridge remains usable when the public provider is absent", async (t) => {
  const s = setup(t, "unavailable"); await s.transport.sendCard(request);
  assert.equal(s.transport.mode(), "legacy");
  assert.equal(s.calls[0][0], "legacy-send");
  await s.state.assistants.get("default").handle({ accountId: "default", userId: "owner", outTrackId: request.outTrackId });
  assert.equal(s.callbacks[0].transport, "legacy");
});
test("an available but disconnected public provider never silently downgrades", async (t) => {
  const s = setup(t, "not-connected"); s.fail();
  await assert.rejects(s.transport.sendCard(request), /uncertain/);
  assert.equal(s.calls.length, 1); assert.equal(s.calls[0][0], "generic-send");
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
test("wrong owner, account, track ID and unknown backend are rejected before sending", async (t) => {
  const s = setup(t);
  for (const override of [{ ownerUserId: "B" }, { accountId: "other" }, { outTrackId: "ask_abc" },
    { transport: "anything" }]) await assert.rejects(s.transport.sendCard({ ...request, ...override }));
  assert.equal(s.calls.length, 0);
});
test("stop unregisters owned callbacks and prevents sends or stale callbacks", async (t) => {
  const s = setup(t); s.transport.stop();
  assert.equal(s.state.assistants.size, 0); assert.equal(s.disposed, 1);
  await assert.rejects(s.transport.sendCard(request));
  await s.options.onAction({ accountId: "default", userId: "owner", namespace: CARD_NAMESPACE,
    cardId: uuid, actionIds: ["save"], form: {} });
  assert.equal(s.callbacks.length, 0);
});
test("old disposer cannot delete a replacement legacy registration", (t) => {
  const s = setup(t), replacement = { handle() {} };
  s.state.assistants.set("default", replacement); s.transport.stop();
  assert.equal(s.state.assistants.get("default"), replacement);
});
test("duplicate account registration fails without replacing the running handler", (t) => {
  const s = setup(t);
  const duplicate = createCardTransport(config, () => {}, { legacy: () => s.state,
    register() { throw Error("must not register"); } });
  assert.throws(() => duplicate.start(), /已有/);
});
test("provider can become available after service startup without another registration", async (t) => {
  const s = setup(t, "unavailable"); delete s.state.channel;
  assert.equal(s.transport.mode(), undefined);
  await assert.rejects(s.transport.sendCard(request));
  s.setStatus("ready"); await s.transport.sendCard(request);
  assert.equal(s.calls[0][0], "generic-send");
});
