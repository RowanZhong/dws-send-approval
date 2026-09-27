import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./assistant-fixture.mjs";
import { bridge } from "../assistant-bridge.mjs";
const KEY = Symbol.for("openclaw.dingtalk.card-extensions");

test("public-provider migration retains drafts and settings but expires old cards", async (t) => {
  delete globalThis[KEY]; delete globalThis[Symbol.for("openclaw.dingtalk.reply-assistant.v1")];
  bridge().channel = { sendCard: async () => {}, updateCard: async () => {} };
  const f = await fixture(t, { transport: null });
  const old = await f.assistant.show();
  await f.incoming(f.event());
  const before = f.assistant.store.list();
  const settings = f.assistant.store.get("settings");
  const registry = globalThis[KEY];
  registry.accountStatus = () => "configured";
  const calls = [];
  registry.transports.set("default", { isConnected: () => true,
    send: async (r) => calls.push(r), update: async (r) => calls.push(r) });
  await f.assistant.maintenance();
  assert.match(f.assistant.store.getCard(old.id).invalidated, /接口已切换/);
  assert.deepEqual(f.assistant.store.list(), before);
  assert.deepEqual(f.assistant.store.get("settings"), settings);
  const fresh = await f.assistant.show();
  assert.equal(fresh.transport, "generic");
  assert.ok(calls.at(-1).outTrackId.startsWith("ocx1.default.dws-send-approval."));
  const action = fresh.actions.findIndex((a) => a.op === "listen");
  assert.ok(action >= 0);
  const handler = registry.registrations.get("default.dws-send-approval").onAction;
  await handler({ accountId: "default", namespace: "dws-send-approval", userId: "A",
    cardId: fresh.outTrackId.slice("dws-assistant-".length),
    actionIds: [`dws-assistant:${fresh.id}:${action}`], form: {} });
  await f.assistant.idle();
  assert.equal(f.assistant.store.cardForTrack(fresh.outTrackId).name, "listen");
  assert.equal(f.sends.length, 0);
});

test("same backend after restart retains an unexpired operation card", async (t) => {
  delete globalThis[KEY]; delete globalThis[Symbol.for("openclaw.dingtalk.reply-assistant.v1")];
  bridge().channel = { sendCard: async () => {}, updateCard: async () => {} };
  const f = await fixture(t, { transport: null });
  const card = await f.assistant.show();
  await f.assistant.stop(); await f.assistant.start({ stateDir: f.dir });
  assert.equal(f.assistant.store.getCard(card.id).invalidated, undefined);
  assert.equal(f.assistant.store.getCard(card.id).transport, "legacy");
});
