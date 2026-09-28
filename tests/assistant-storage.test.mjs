import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./assistant-fixture.mjs";
import { readConfig } from "../config.mjs";
const DAY = 86400000;

test("body cleanup leaves only a fingerprint and a replay cannot create a new draft", async (t) => {
  let clock = Date.now();
  const f = await fixture(t, { now: () => clock });
  const event = f.event({ content: "private original text" });
  const d = await f.incoming(event);
  f.assistant.store.put({ ...d, status: "ignored", updated: clock });
  clock += 8 * DAY;
  const result = f.assistant.store.prune(clock);
  assert.equal(result.bodiesDeleted, 1);
  assert.equal(f.assistant.store.find(d.key), undefined);
  assert.equal(f.assistant.has(event), true);
  await f.incoming(event);
  assert.equal(f.assistant.store.list().length, 0);
  assert.equal(f.assistant.store.storageStats().fingerprints, 1);
  const columns = f.assistant.store.db.prepare("PRAGMA table_info(message_fingerprints)").all().map((r) => r.name);
  assert.deepEqual(columns, ["message_key", "expires"]);
  clock += 31 * DAY;
  f.assistant.store.prune(clock);
  assert.equal(f.assistant.store.storageStats().fingerprints, 0);
  await f.incoming(event);
  assert.equal(f.assistant.store.list().length, 0, "old events remain outside the replay window after the fingerprint expires");
});
test("expiry starts terminal retention now instead of deleting newly expired old records", async (t) => {
  let clock = Date.now();
  const f = await fixture(t, { now: () => clock });
  const d = await f.incoming(f.event());
  clock += 9 * DAY;
  f.assistant.store.prune(clock);
  const expired = f.assistant.store.draft(d.id);
  assert.equal(expired.status, "expired");
  assert.equal(expired.terminalAt, clock);
  assert.equal(expired.updated, clock);
});
test("sending, unknown, active references and unfinished agent runs survive cleanup", async (t) => {
  let clock = Date.now();
  const f = await fixture(t, { now: () => clock });
  const records = [];
  for (const status of ["sending", "unknown", "sent"]) {
    const d = await f.incoming(f.event());
    records.push(f.assistant.store.put({ ...d, status, updated: clock, ...(status === "sent" ? { agentRunPending: true } : {}) }));
  }
  const retained = await f.incoming(f.event());
  f.assistant.store.put({ ...retained, status: "sent", updated: clock });
  const card = await f.assistant.show("draft", { id: retained.id });
  f.assistant.store.card({ ...card, expires: clock + 20 * DAY });
  clock += 8 * DAY;
  f.assistant.store.prune(clock);
  assert.ok([...records, retained].every((d) => f.assistant.store.draft(d.id)));
});
test("overdue cards get a bounded repaint window before payloads are retired", async (t) => {
  let clock = Date.now();
  const f = await fixture(t, { now: () => clock, transport: {
    sendCard: async () => {}, updateCard: async () => { throw Error("offline"); },
  } });
  const card = await f.assistant.show();
  clock = card.expires;
  await f.assistant.maintenance();
  clock += 8 * DAY;
  f.assistant.store.prune(clock);
  const tombstone = f.assistant.store.getCard(card.id);
  assert.equal(tombstone.paintAbandoned, true);
  assert.equal(tombstone.renderedData, undefined);
  assert.deepEqual(tombstone.actions, []);
  assert.ok(tombstone.invalidated);
});
test("storage config defaults preserve old settings and validate dedupe retention", () => {
  const raw = { ownerUserId: "A", profile: "corp:A", dwsPath: "/usr/bin/dws" };
  assert.deepEqual(readConfig(raw).assistant.storage, { retentionDays: 7, expiredCardRetentionHours: 24, cleanupIntervalSeconds: 300, dedupeRetentionDays: 30 });
  assert.throws(() => readConfig({ ...raw, assistant: { storage: { retentionDays: 7, dedupeRetentionDays: 6 } } }));
  assert.throws(() => readConfig({ ...raw, assistant: { storage: { cleanupIntervalSeconds: 10 } } }));
});
