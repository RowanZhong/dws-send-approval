import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fixture } from "./assistant-fixture.mjs";
import { readConfig } from "../config.mjs";

function seed(store, base, expires, count) {
  return Array.from({ length: count }, () => {
    const card = { ...base, id: randomUUID(), outTrackId: `dws-assistant-${randomUUID()}`, expires,
      invalidated: undefined, inactivePainted: false, paintAttempts: 0, nextPaintAttemptAt: 0 };
    store.card(card);
    return card;
  });
}
test("failed expiry paints back off and cannot starve other cards", async (t) => {
  let clock = Date.now();
  const attempts = [], fail = new Set();
  const f = await fixture(t, { now: () => clock, transport: {
    sendCard: async () => {}, updateCard: async ({ outTrackId }) => {
      attempts.push(outTrackId); if (fail.has(outTrackId)) throw Error("offline");
    },
  } });
  const base = await f.assistant.show();
  await f.assistant.idle();
  const cards = seed(f.assistant.store, base, clock - 1000, 15);
  cards.forEach((c) => fail.add(c.outTrackId));
  await f.assistant.maintenance();
  assert.equal(attempts.length, 10);
  fail.clear();
  await f.assistant.maintenance();
  assert.equal(attempts.length, 15);
  assert.equal(new Set(attempts).size, 15);
  clock += 30000;
  await f.assistant.maintenance();
  assert.equal(attempts.length, 25);
  assert.ok(cards.every((c) => f.assistant.store.getCard(c.id).inactivePainted));
  await f.assistant.maintenance();
  assert.equal(attempts.length, 25);
});
test("restart paints old cards before cleanup and retains failed expiry work", async (t) => {
  let clock = Date.now(), online = false;
  const painted = [];
  const f = await fixture(t, { now: () => clock, transport: {
    sendCard: async () => {}, updateCard: async (x) => {
      if (!online) throw Error("offline"); painted.push(x.outTrackId);
    },
  } });
  const base = await f.assistant.show();
  await f.assistant.idle();
  const [old] = seed(f.assistant.store, base, clock - 8 * 86400000, 1);
  await f.assistant.stop();
  await f.assistant.start({ stateDir: f.dir });
  await f.assistant.idle();
  assert.ok(f.assistant.store.getCard(old.id));
  assert.equal(f.assistant.store.getCard(old.id).paintAttempts, 1);
  online = true;
  clock += 30000;
  await f.assistant.maintenance();
  assert.ok(painted.includes(old.outTrackId));
});
test("expiry is the last update when a normal card update was in flight", async (t) => {
  let clock = Date.now(), release, block = false;
  const states = [];
  const f = await fixture(t, { now: () => clock, transport: {
    sendCard: async () => {}, updateCard: async (x) => {
      if (block && x.data.card_status === "pending") await new Promise((r) => { release = r; });
      states.push(x.data.card_status);
    },
  } });
  const base = await f.assistant.show();
  await f.assistant.idle();
  block = true;
  const showing = f.assistant.show("listen", {}, base.outTrackId);
  while (!release) await new Promise(setImmediate);
  clock = base.expires;
  const expiring = f.assistant.maintenance();
  release();
  await Promise.all([showing, expiring]);
  assert.deepEqual(states, ["pending", "expired"]);
  assert.equal(f.assistant.store.cardForTrack(base.outTrackId).inactivePainted, true);
});
test("capacity pruning preserves active cards and unfinished expiry paints", async (t) => {
  const f = await fixture(t);
  const base = await f.assistant.show();
  await f.assistant.idle();
  const live = seed(f.assistant.store, base, Date.now() + 300000, 1001);
  const [old] = seed(f.assistant.store, base, Date.now() - 8 * 86400000, 1);
  f.assistant.store.prune();
  assert.ok(live.every((c) => f.assistant.store.getCard(c.id)));
  assert.ok(f.assistant.store.getCard(old.id));
});
test("expiry check settings upgrade with the default and reject unsafe intervals", () => {
  const raw = { ownerUserId: "A", profile: "corp:A", dwsPath: "/usr/bin/dws" };
  assert.equal(readConfig(raw).assistant.cards.expiryCheckSeconds, 10);
  assert.equal(readConfig({ ...raw, assistant: { cards: { expiryCheckSeconds: 60 } } }).assistant.cards.expiryCheckSeconds, 60);
  for (const value of [0, 4, 61, 10.5, "10"]) {
    assert.throws(() => readConfig({ ...raw, assistant: { cards: { expiryCheckSeconds: value } } }));
  }
});
