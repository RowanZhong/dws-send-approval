import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./assistant-fixture.mjs";
import { bridge } from "../assistant-bridge.mjs";
import { registerAssistantCardExtension } from "../card-transport.mjs";

function legacyBridge() {
  delete globalThis[Symbol.for("openclaw.dingtalk.reply-assistant.v1")];
  bridge().channel = { sendCard: async () => {}, updateCard: async () => {} };
}

test("modern-host migration retains drafts and settings but expires persisted legacy cards", async (t) => {
  legacyBridge();
  const calls = [], api = { id: "dws-send-approval", name: "Assistant", rootDir: "/plugin",
    runtime: { version: "2026.8.1", channel: {} } };
  let onAction, active;
  const extension = registerAssistantCardExtension(api, { accountId: "default", ownerUserId: "A" }, {
    require() { if (!active) throw Error("not active"); return { requireRuntime: () => ({ assistant: active }) }; },
  }, { register: (_api, options) => {
    onAction = options.onAction;
    return { isReady: () => true, sendCard: async (r) => calls.push(r), updateCard: async (r) => calls.push(r) };
  } });
  const f = await fixture(t, { transport: null, cardExtension: extension });
  const old = await f.assistant.show();
  await f.incoming(f.event());
  const before = f.assistant.store.list();
  const settings = f.assistant.store.get("settings");
  // Seed the persisted format used by the legacy deployment before restarting.
  f.assistant.store.card({ ...f.assistant.store.getCard(old.id), transport: "legacy" });
  await f.assistant.stop(); await f.assistant.start({ stateDir: f.dir }); active = f.assistant;
  await f.assistant.maintenance();
  assert.match(f.assistant.store.getCard(old.id).invalidated, /接口已切换/);
  assert.deepEqual(f.assistant.store.list(), before);
  assert.deepEqual(f.assistant.store.get("settings"), settings);
  const fresh = await f.assistant.show();
  assert.equal(fresh.transport, "generic");
  assert.equal(calls.at(-1).cardId, fresh.outTrackId.slice("dws-assistant-".length));
  assert.equal(calls.at(-1).outTrackId, undefined, "wire identity belongs to the provider");
  const action = fresh.actions.findIndex((a) => a.op === "listen");
  assert.ok(action >= 0);
  await onAction({ userId: "A", cardId: fresh.outTrackId.slice("dws-assistant-".length),
    actionIds: [`dws-assistant:${fresh.id}:${action}`], form: {} });
  await f.assistant.idle();
  assert.equal(f.assistant.store.cardForTrack(fresh.outTrackId).name, "listen");
  assert.equal(f.sends.length, 0);
});

for (const modern of [false, true]) {
  test(`same ${modern ? "modern" : "legacy"} backend after restart retains an unexpired operation card`, async (t) => {
    legacyBridge();
    const cardExtension = modern ? { isReady: () => true, sendCard: async () => {}, updateCard: async () => {} } : undefined;
    const f = await fixture(t, { transport: null, cardExtension });
    const card = await f.assistant.show();
    await f.assistant.stop(); await f.assistant.start({ stateDir: f.dir });
    assert.equal(f.assistant.store.getCard(card.id).invalidated, undefined);
    assert.equal(f.assistant.store.getCard(card.id).outTrackId, card.outTrackId);
    assert.equal(f.assistant.store.getCard(card.id).transport, modern ? "generic" : "legacy");
  });
}

test("temporary modern unreadiness never migrates card state to an available legacy bridge", async (t) => {
  legacyBridge();
  let ready = true;
  const cardExtension = { isReady: () => ready, sendCard: async () => {}, updateCard: async () => {} };
  const f = await fixture(t, { transport: null, cardExtension });
  const card = await f.assistant.show();
  ready = false;
  await f.assistant.maintenance();
  assert.equal(f.assistant.store.getCard(card.id).invalidated, undefined);
  assert.equal(f.assistant.store.getCard(card.id).transport, "generic");
});
