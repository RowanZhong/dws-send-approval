import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readConfig } from "../config.mjs";
import { createIdentityService } from "../identity-service.mjs";
import { prepareIdentityPolicy, COMPANY_AUTH_TEXT } from "../identity-migration.mjs";
import { createIdentityNotice } from "../identity-notice.mjs";
import { channelRobot, makeBinding, selectProfile, writeIdentity, readSavedIdentity } from "../identity-discovery.mjs";
import { AssistantStore } from "../assistant-store.mjs";
import { initialPreferences } from "../preferences.mjs";
import { initialSettings, ordinaryReplyDecision } from "../assistant-settings.mjs";
import { buildView } from "../assistant-views.mjs";
import { createAssistant } from "../assistant.mjs";
import { replySnapshot } from "../rules.mjs";
import { cfg, host, profiles, answer, folder, context } from "./identity-fixtures.mjs";

const target = "company-oauth", clock = Date.now();
const config = (policy = {}) => readConfig({ ...cfg, identityPolicy: { requiredDwsClientId: target, allowExistingBindingMigration: true, ...policy } }, { discovery: true });
const binding = (clientId = "old-oauth") => { const p = profiles(); p.profiles[0].clientId = clientId; return makeBinding(selectProfile(p, cfg), cfg, channelRobot(cfg, host)); };
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
async function seed(dir, { app = "old-oauth", business = true, targets = false, pendingRun = false } = {}) {
  await writeIdentity(dir, { version: 1, binding: binding(app), owner: { openId: "open-owner", checkedAt: clock }, robot: { openId: "open-bot", name: "小钉", checkedAt: clock } });
  if (!business) return;
  const path = join(dir, "dws-send-approval");
  const prefs = initialPreferences(cfg); prefs.enabled = true; prefs.rules.dm.mode = "all";
  if (targets) prefs.reply.users.push({ id: "peer-open", mode: "off", text: "" });
  await writeFile(join(path, "preferences.json"), JSON.stringify({ identity: { profile: "corp:owner", ownerUserId: "owner", accountId: "default" }, preferences: prefs }));
  const store = new AssistantStore({ ...cfg, profile: "corp:owner" });
  await store.open(dir);
  const settings = initialSettings();
  settings.autoRules = [{ id: "grant", scope: "dm", target: "", expires: clock + 3600000, cooldownMinutes: 30, keywords: [], text: "保留正文" }];
  settings.topics.rules = [{ id: "topic", enabled: true, scope: "all", targets: [], name: "问题", description: "说明", examples: "", exclusions: "", action: "auto", text: "主题正文", expires: clock + 3600000, cooldownMinutes: 30 }];
  store.set("settings", settings);
  store.set("directory", targets ? [{ kind: "user", id: "peer-open", userId: "peer-staff", name: "同名用户" }] : []);
  for (const status of ["pending", "sent", "unknown", "sending"]) {
    const row = store.create({ event_id: status, message_id: status, conversation_id: "old-chat", sender_open_dingtalk_id: "old-peer", content: "旧来信", timestamp: clock }, prefs, { direct: true, mode: "ai" }, clock);
    store.put({ ...row, status, text: `正文 ${status}` });
  }
  store.card({ id: "old-card", outTrackId: "old-track", expires: clock + 3600000, protocol: 2, presentationVersion: 3,
    name: "draft", actions: [{ op: "send" }], refs: [{ id: 1, version: 1 }], upgrade: { version: 3 } });
  if (pendingRun) store.putDraftRun({ sessionKey: "agent:dedicated:dws-draft:pending", state: "unsettled", runId: "pending-run" });
  store.close();
}
function readBusiness(dir) {
  const db = new DatabaseSync(join(dir, "dws-send-approval/assistant.sqlite"), { readOnly: true });
  try {
    const get = (key) => JSON.parse(db.prepare("SELECT body FROM kv WHERE key=?").get(key).body);
    return { settings: get("settings"), drafts: db.prepare("SELECT body FROM drafts ORDER BY id").all().map((r) => JSON.parse(r.body)), cards: db.prepare("SELECT body FROM cards").all().map((r) => JSON.parse(r.body)),
      marker: db.prepare("SELECT body FROM kv WHERE key='identityAppMigration'").get()?.body };
  } finally { db.close(); }
}
async function service(t, dir, { policy, mode = "new", mutate, checkpoint } = {}) {
  const calls = [], built = [], c = config(policy);
  const s = createIdentityService({}, c, {
    startupDelayMs: 1000000, now: () => clock, migrationCheckpoint: checkpoint,
    runner: async (_, args) => {
      calls.push(args);
      if (mutate) { const value = await mutate(args); if (value !== undefined) return value; }
      if (args[0] === "profile") {
        if (mode === "logged-out") return { success: true, profiles: [] };
        const p = profiles(); p.profiles[0].clientId = mode === "old" ? "old-oauth" : target; return p;
      }
      if (args[0] === "auth") return { success: true, authenticated: true, corp_id: "corp", user_id: "owner", token_valid: true };
      if (args.includes("peer-staff")) return { success: true, result: [{ userId: "peer-staff", openDingTalkId: "peer-open" }] };
      return answer(args);
    },
    buildRuntime: async (resolved) => { built.push(resolved); return { service: { stop: async () => {} }, assistant: { stop: async () => {} } }; },
  });
  s.start(context(dir)); t.after(() => s.stop());
  return { s, calls, built, c };
}

test("company policy validates inputs and remains opt-in", () => {
  assert.equal(cfg.identityPolicy.requiredDwsClientId, undefined);
  assert.equal(config({ allowExistingBindingMigration: false }).identityPolicy.allowExistingBindingMigration, false);
  for (const p of [null, [], { requiredDwsClientId: "bad id" }, { allowExistingBindingMigration: true }, { requiredDwsClientId: target, allowExistingBindingMigration: "true" }, { clientSecret: "never-accepted" }])
    assert.throws(() => readConfig({ ...cfg, identityPolicy: p }, { discovery: true }));
});

test("old app shows the exact approved guidance and does not authenticate or initialize", async (t) => {
  const dir = await folder(t); await seed(dir);
  const before = readBusiness(dir), saved = await readFile(join(dir, "dws-send-approval/identity.json"));
  const { s, calls, built } = await service(t, dir, { mode: "old" });
  await s.refresh();
  assert.equal(s.status().state, "company_auth_required"); assert.equal(s.status().detail, COMPANY_AUTH_TEXT);
  assert.match(COMPANY_AUTH_TEXT, /发送指令：请退出并重新登录dws/);
  assert.equal(built.length, 0); assert.equal(calls.length, 1);
  assert.deepEqual(readBusiness(dir), before); assert.deepEqual(await readFile(join(dir, "dws-send-approval/identity.json")), saved);
});

for (const existing of [false, true]) test(`logged-out employee waits without losing data (existing=${existing})`, async (t) => {
  const dir = await folder(t); if (existing) await seed(dir);
  const { s, calls, built } = await service(t, dir, { mode: "logged-out" });
  await s.refresh(); assert.equal(s.status().state, "waiting_login"); assert.equal(built.length, 0); assert.equal(calls.length, 1);
  if (existing) assert.equal(readBusiness(dir).drafts.length, 4);
});

test("new user with valid company login initializes without a migration", async (t) => {
  const dir = await folder(t), { s, built } = await service(t, dir);
  await s.ready(); assert.equal(built.length, 1); assert.equal(s.status().binding.dwsClientId, target);
  assert.equal((await readdir(join(dir, "dws-send-approval"))).some((f) => f.startsWith("app-migration")), false);
  assert.equal(built[0].listener.enabled, false);
});

test("existing company binding leaves grants and drafts intact", async (t) => {
  const dir = await folder(t); await seed(dir, { app: target }); const before = readBusiness(dir);
  const { s } = await service(t, dir); await s.ready(); assert.deepEqual(readBusiness(dir), before);
});

test("migration preserves content, pauses both authorization types, archives pending drafts and invalidates old cards", async (t) => {
  const dir = await folder(t); await seed(dir, { targets: true });
  const prefBefore = await readFile(join(dir, "dws-send-approval/preferences.json"));
  const { s, calls } = await service(t, dir); await s.ready();
  assert.equal(s.status().binding.dwsClientId, target);
  const after = readBusiness(dir);
  assert.equal(after.settings.autoRules[0].text, "保留正文"); assert.equal(after.settings.autoRules[0].expires, 0);
  assert.equal(after.settings.topics.rules[0].expires, 0); assert.equal(after.settings.topics.rules[0].action, "auto");
  assert.deepEqual(after.drafts.map((r) => r.status), ["superseded", "sent", "unknown", "unknown"]);
  assert.deepEqual(after.drafts.map((r) => r.text), ["正文 pending", "正文 sent", "正文 unknown", "正文 sending"]);
  assert.equal(after.cards[0].upgrade, undefined); assert.match(after.cards[0].invalidated, /授权方式已更新/);
  assert.deepEqual(await readFile(join(dir, "dws-send-approval/preferences.json")), prefBefore);
  assert.ok(calls.some((a) => a.includes("peer-staff")));
  const names = await readdir(join(dir, "dws-send-approval"));
  const backupDir = names.find((f) => f.startsWith("app-migration-backup-"));
  assert.equal((await json(join(dir, "dws-send-approval", backupDir, "identity.json"))).binding.dwsClientId, "old-oauth");
  const backed = new DatabaseSync(join(dir, "dws-send-approval", backupDir, "assistant.sqlite"), { readOnly: true });
  try { assert.equal(JSON.parse(backed.prepare("SELECT body FROM kv WHERE key='settings'").get().body).autoRules[0].expires, clock + 3600000); } finally { backed.close(); }
  const view = buildView("draft", { prefs: initialPreferences(cfg), settings: after.settings, store: { draft: () => after.drafts[0] }, directory: [], listener: {} }, { id: 1 });
  assert.match(view.description, /仅查看/); assert.equal(view.buttons.some((b) => ["send", "edit", "regenerate"].includes(b.op)), false);
  const decision = ordinaryReplyDecision({ conversation_id: "fresh", sender_open_dingtalk_id: "peer" }, { mode: "ai", direct: true }, after.settings, clock);
  assert.notEqual(decision.kind, "auto");
});

for (const stage of ["backup", "business", "identity"]) test(`interrupted ${stage} phase resumes idempotently`, async (t) => {
  const dir = await folder(t); await seed(dir);
  let interrupted = false;
  const { s } = await service(t, dir, { checkpoint: async (step) => { if (step === stage && !interrupted) { interrupted = true; throw Error("interrupted"); } } });
  await s.refresh(); assert.equal(s.status().state, "failed");
  await s.ready(); assert.equal(s.status().state, "ready");
  const after = readBusiness(dir);
  await s.refresh(true); assert.deepEqual(readBusiness(dir), after);
  assert.equal(after.drafts[0].version, 2);
});

test("completed migration does not revoke newly granted authority on refresh or with migration disabled", async (t) => {
  const dir = await folder(t); await seed(dir);
  const one = await service(t, dir); await one.s.ready(); await one.s.stop();
  const db = new DatabaseSync(join(dir, "dws-send-approval/assistant.sqlite"));
  const settings = JSON.parse(db.prepare("SELECT body FROM kv WHERE key='settings'").get().body);
  settings.autoRules[0] = { ...settings.autoRules[0], expires: clock + 7200000, appMigrationPaused: false };
  db.prepare("UPDATE kv SET body=? WHERE key='settings'").run(JSON.stringify(settings)); db.close();
  const two = await service(t, dir, { policy: { allowExistingBindingMigration: false } }); await two.s.ready();
  assert.equal(readBusiness(dir).settings.autoRules[0].expires, clock + 7200000);
});

for (const field of ["corpId", "userId", "channelClientId", "accountId", "dwsConfigDir"]) test(`different ${field} cannot migrate`, async (t) => {
  const dir = await folder(t); await seed(dir);
  const saved = await readSavedIdentity(dir); saved.binding[field] = "changed"; await writeIdentity(dir, saved);
  const { s, built } = await service(t, dir); await s.refresh(); assert.equal(s.status().state, "migration_required"); assert.equal(built.length, 0);
  assert.equal(readBusiness(dir).settings.autoRules[0].expires, clock + 3600000);
});

test("disabled migration reports a precise state and preserves the old binding", async (t) => {
  const dir = await folder(t); await seed(dir);
  const { s } = await service(t, dir, { policy: { allowExistingBindingMigration: false } }); await s.refresh();
  assert.equal(s.status().state, "migration_required"); assert.match(s.status().detail, /尚未开启/);
  assert.equal((await readSavedIdentity(dir)).binding.dwsClientId, "old-oauth");
});

for (const scenario of ["missing-binding", "missing-user-id", "changed-user-id", "pending-task", "invalid-auth", "changed-current-profile", "legacy-sources"]) test(`unsafe migration blocked: ${scenario}`, async (t) => {
  const dir = await folder(t); await seed(dir, { targets: scenario.includes("user-id"), pendingRun: scenario === "pending-task" });
  if (scenario === "missing-binding") await rm(join(dir, "dws-send-approval/identity.json"));
  if (scenario === "legacy-sources") await writeFile(join(dir, "dws-send-approval/sources.json"), JSON.stringify({ version: 1, records: [{ sessionKey: "unsettled" }] }));
  if (scenario === "missing-user-id") { const db = new DatabaseSync(join(dir, "dws-send-approval/assistant.sqlite")); db.prepare("UPDATE kv SET body='[]' WHERE key='directory'").run(); db.close(); }
  let profilesRead = 0;
  const { s, built } = await service(t, dir, { mutate: async (args) => {
    if (scenario === "changed-user-id" && args.includes("peer-staff")) return { success: true, result: [{ userId: "peer-staff", openDingTalkId: "different" }] };
    if (scenario === "invalid-auth" && args[0] === "auth") return { success: true, authenticated: false };
    if (scenario === "changed-current-profile" && args[0] === "profile" && ++profilesRead > 1) { const p = profiles(); p.profiles[0].corpId = "other"; p.profiles[0].profile = "other:owner"; p.currentProfile = "other:owner"; p.profiles[0].clientId = target; return p; }
  } });
  await s.refresh(); assert.notEqual(s.status().state, "ready"); assert.equal(built.length, 0);
  assert.equal(readBusiness(dir).settings.autoRules[0].expires, clock + 3600000);
});

test("per-instance sources differ and are frozen even before a later login", async (t) => {
  for (const source of ["employee-a-app", "employee-b-app"]) {
    const dir = await folder(t); await seed(dir, { app: source, business: false });
    const first = await prepareIdentityPolicy(dir, config(), host);
    assert.equal(first.ledger.sourceBinding.dwsClientId, source);
    const saved = await readSavedIdentity(dir); saved.binding.dwsClientId = "unrecorded-app"; await writeIdentity(dir, saved);
    await assert.rejects(prepareIdentityPolicy(dir, config(), host), /不一致/);
  }
});

test("guidance card has no business actions and send failure returns exact text without a backend retry", async () => {
  let sends = 0, payload;
  const transport = { start() {}, stop() {}, async sendCard(p) { sends++; payload = p; throw Error("uncertain-send"); } };
  const notice = createIdentityNotice(config(), { transport });
  assert.equal(await notice.show(), COMPANY_AUTH_TEXT); assert.equal(sends, 1);
  assert.equal(payload.data.button1, ""); assert.equal(payload.data.action1, ""); notice.stop();
});


test("cached company runtime checks the current login again when opening the assistant", async (t) => {
  const dir = await folder(t); await seed(dir, { app: target }); let changed = false;
  const { s } = await service(t, dir, { mutate: (args) => {
    if (changed && args[0] === "profile") { const p = profiles(); p.profiles[0].clientId = "another-app"; return p; }
  } });
  await s.ready(); changed = true;
  await assert.rejects(s.ready(), /公司授权方式已更新/);
  assert.equal(s.status().state, "company_auth_required");
  assert.throws(() => s.requireRuntime());
});

test("expired access with a valid refresh token can migrate; expired or revoked credentials cannot", async (t) => {
  for (const valid of [true, false]) {
    const dir = await folder(t); await seed(dir);
    const { s } = await service(t, dir, { mutate: (args) => args[0] === "auth" ? {
      success: true, authenticated: valid, corp_id: "corp", user_id: "owner", token_valid: false, refresh_token_valid: valid,
    } : undefined });
    await s.refresh(); assert.equal(s.status().state, valid ? "ready" : "waiting_login");
    assert.equal((await readSavedIdentity(dir)).binding.dwsClientId, valid ? target : "old-oauth");
  }
});

test("company policy cannot enable the legacy autonomous listener", () => {
  assert.throws(() => readConfig({ ...cfg, identityPolicy: config().identityPolicy, assistant: { enabled: false } }, { discovery: true }), /仅支持助手模式/);
});

test("after migration, stale buttons and text approvals cannot send; a new draft still sends once", async (t) => {
  const dir = await folder(t); await seed(dir);
  const db = new DatabaseSync(join(dir, "dws-send-approval/assistant.sqlite"));
  const id = "22222222-2222-4222-8222-222222222222", old = JSON.parse(db.prepare("SELECT body FROM cards").get().body);
  Object.assign(old, { id, owner: "owner", accountId: "default", transport: "legacy", presentationVersion: 2 });
  db.prepare("UPDATE cards SET id=?,body=?").run(id, JSON.stringify(old)); db.close();
  const { s } = await service(t, dir); await s.ready(); await s.stop();
  const c = readConfig({ ...cfg, profile: "corp:owner", ownerOpenId: "open-owner", listener: { ignoreSenderOpenIds: ["open-bot", "open-owner"] }, assistant: { ...cfg.assistant, cards: { presentationVersion: 3 } } });
  const sends = [], cards = [], prefs = initialPreferences(c); prefs.enabled = true; prefs.rules.dm.mode = "all";
  const assistant = createAssistant({ logger: { warn() {} }, runtime: { llm: { complete() { throw Error("unexpected model"); } } } }, c, {
    send: async (d) => { sends.push(d); }, draft: async () => "新的回复", batchTiming: { quietMs: 0, waitMs: 0 },
    transport: { sendCard: async (p) => cards.push(p), updateCard: async (p) => cards.push(p) },
    directoryRunner: async () => { throw Error("offline"); }, historyRunner: async () => ({ contractVersion: "im.message-list.v1", messages: [], complete: true }),
  });
  assistant.bind({ snapshot: () => structuredClone(prefs), status: () => ({ state: "ready" }), update: async (fn) => { fn(prefs); prefs.revision++; } });
  await assistant.start({ stateDir: dir }); t.after(() => assistant.stop());
  await assistant.idle();
  assert.equal(assistant.store.getCard(id).upgrade, undefined);
  await assistant.handle({ actionId: `dws-assistant:${id}:0`, outTrackId: old.outTrackId, userId: "owner", accountId: "default" });
  await assistant.idle(); assert.equal(sends.length, 0);
  await assert.rejects(assistant.command("ok", { id: 1, version: 1 }), /仅供查看/);
  const e = { type: "user_im_message_receive_o2o_all", event_id: "new", message_id: "new", conversation_id: "new-chat", sender_open_dingtalk_id: "peer", content: "新的来信", timestamp: Date.now() };
  await assistant.processEvent(e, prefs, replySnapshot(e, prefs)); await assistant.idle();
  const d = assistant.store.list(["pending"])[0]; assert.ok(d);
  const card = await assistant.show("draft", { id: d.id });
  const input = { actionId: `dws-assistant:${card.id}:${card.actions.findIndex((a) => a.op === "send")}`, outTrackId: card.outTrackId, userId: "owner", accountId: "default" };
  await assistant.handle(input); await assistant.idle(); await assistant.handle(input); await assistant.idle();
  assert.equal(sends.length, 1); assert.equal(sends[0].text, "新的回复");
});

test("group rules require exact accessible conversation identities", async (t) => {
  for (const valid of [true, false]) {
    const dir = await folder(t); await seed(dir);
    const file = join(dir, "dws-send-approval/preferences.json"), prefs = await json(file);
    prefs.preferences.rules.at = { mode: "groups", ids: ["known-group"] }; await writeFile(file, JSON.stringify(prefs));
    const { s, calls } = await service(t, dir, { mutate: (args) => args.includes("conversation-info") ? {
      success: true, result: { conversationInfo: { openConversationId: valid ? "known-group" : "different-group", singleChat: false } },
    } : undefined });
    await s.refresh(); assert.equal(s.status().state, valid ? "ready" : "migration_required");
    assert.ok(calls.some((a) => a.includes("known-group")));
  }
});

test("interrupted migration refuses a missing or modified backup", async (t) => {
  for (const damage of ["missing", "changed"]) {
    const dir = await folder(t); await seed(dir); let once = false;
    const { s } = await service(t, dir, { checkpoint: async (stage) => { if (stage === "backup" && !once) { once = true; throw Error("interrupted"); } } });
    await s.refresh(); assert.equal(s.status().state, "failed");
    const root = join(dir, "dws-send-approval"), name = (await readdir(root)).find(f => f.startsWith("app-migration-backup-"));
    if (damage === "missing") await rm(join(root, name), { recursive: true });
    else await writeFile(join(root, name, "preferences.json"), "{}");
    await s.refresh(); assert.equal(s.status().state, "migration_required"); assert.match(s.status().detail, /备份/);
    assert.equal((await readSavedIdentity(dir)).binding.dwsClientId, "old-oauth");
    assert.equal(readBusiness(dir).settings.autoRules[0].expires, clock + 3600000);
  }
});

test("a Pod restart reusing the same PID can reclaim its previous process lock", async (t) => {
  const dir = await folder(t); await seed(dir);
  await writeFile(join(dir, "dws-send-approval/.app-migration.lock"), JSON.stringify({ pid: process.pid, processToken: "previous-process", nonce: "old-lock" }));
  const { s } = await service(t, dir); await s.ready();
  assert.equal(s.status().state, "ready");
  assert.equal(readBusiness(dir).drafts[0].version, 2);
});

test("a second initialization in the same active process cannot steal its migration lock", async (t) => {
  const dir = await folder(t); await seed(dir);
  let release, entered;
  const waiting = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const one = await service(t, dir, { checkpoint: async (stage) => { if (stage === "backup") { entered(); await waiting; } } });
  const pending = one.s.refresh(); await started;
  try {
    const two = await service(t, dir); await two.s.refresh();
    assert.equal(two.s.status().state, "migration_required"); assert.match(two.s.status().detail, /已有应用迁移/);
  } finally { release(); await pending; }
  assert.equal(one.s.status().state, "ready"); assert.equal(readBusiness(dir).drafts[0].version, 2);
});
