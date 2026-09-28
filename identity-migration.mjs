import { readFile, writeFile, mkdir, rename, rm, copyFile, chmod, stat, link } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { IdentityError, cancelled } from "./identity-cli.mjs";
import { readSavedIdentity, writeIdentity, sameBinding, makeBinding, channelRobot, discoverOwner, discoverRobot } from "./identity-discovery.mjs";
import { validatePreferences, initialPreferences } from "./preferences.mjs";
import { initialSettings, validateSettings } from "./assistant-settings.mjs";

export const COMPANY_AUTH_TITLE = "公司授权方式已更新";
export const COMPANY_AUTH_PARAGRAPHS = [
  "你当前仍使用旧的 DWS 授权，需要通过公司统一入口重新授权。",
  "原有设置、草稿和历史记录已保留。完成授权前，助手暂不处理消息或自动发送回复。",
  "通过公司统一入口完成授权（发送指令：请退出并重新登录dws），然后回到这里再次发送 `/dws`。",
];
export const COMPANY_AUTH_TEXT = `**${COMPANY_AUTH_TITLE}**\n\n${COMPANY_AUTH_PARAGRAPHS[0]}\n\n${COMPANY_AUTH_PARAGRAPHS[1]}\n\n**下一步：**${COMPANY_AUTH_PARAGRAPHS[2]}`;
const fail = (text) => { throw new IdentityError("migration_required", text); };
const check = (signal) => { if (signal?.aborted) throw cancelled(); };
const token = (s) => typeof s === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(s);
const digest = (s) => createHash("sha256").update(s).digest("hex");
// Pod restarts can reuse the same OS PID. All module instances in one process
// share this token; a restarted process receives a new one.
const processToken = globalThis[Symbol.for("dws-send-approval.migrationProcessToken")] ??= randomUUID();
const files = ["identity.json", "preferences.json", "sources.json", "assistant.sqlite", "assistant.sqlite-wal"];
async function optional(file) { try { return await readFile(file); } catch (e) { if (e.code === "ENOENT") return undefined; throw e; } }
async function fileInfo(file) { try { return await stat(file); } catch (e) { if (e.code === "ENOENT") return undefined; throw e; } }
async function json(file) {
  const bytes = await optional(file);
  if (!bytes) return undefined;
  try { return JSON.parse(bytes); } catch { fail("迁移记录或业务数据损坏，原数据保留，请管理员核对。"); }
}
async function atomic(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); await rename(tmp, file); }
  finally { await rm(tmp, { force: true }); }
}
function validateSource(binding, config, host) {
  if (!binding || ![binding.corpId, binding.userId, binding.dwsClientId].every(token) || binding.profile !== `${binding.corpId}:${binding.userId}`)
    fail("历史身份绑定不完整，不能自动迁移；请管理员核对。");
  const expected = makeBinding({ profile: binding.profile, corpId: binding.corpId, userId: binding.userId, dwsClientId: binding.dwsClientId }, config, channelRobot(config, host));
  if (binding.userId !== config.ownerUserId || !sameBinding(binding, expected))
    fail("历史组织、员工、机器人或 DWS 目录与当前实例不一致，未执行应用迁移。");
}

// Freeze only this instance's persisted source. A later login cannot choose or
// replace it. No policy means no ledger, extra auth checks, or migration writes.
export async function prepareIdentityPolicy(stateDir, config, host) {
  const target = config.identityPolicy?.requiredDwsClientId;
  if (!target) return undefined;
  const dir = join(stateDir, "dws-send-approval"), saved = await readSavedIdentity(stateDir);
  if (!saved) {
    const present = await Promise.all(["preferences.json", "sources.json", "assistant.sqlite"].map((name) => fileInfo(join(dir, name))));
    if (present.some(Boolean)) fail("已有助手业务数据但身份绑定缺失，不能按新安装接管；请管理员恢复并核对原绑定。");
    return { saved };
  }
  validateSource(saved.binding, config, host);
  const path = join(dir, `app-migration-${digest(target).slice(0, 24)}.json`);
  let ledger = await json(path);
  if (ledger) {
    validateSource(ledger.sourceBinding, config, host);
    if (ledger.version !== 1 || ledger.targetClientId !== target || !["pending", "backed_up", "complete"].includes(ledger.stage) ||
        !sameBinding(saved.binding, ledger.sourceBinding) && !sameBinding(saved.binding, { ...ledger.sourceBinding, dwsClientId: target }))
      fail("应用迁移记录与当前绑定不一致，未继续迁移。");
    if (ledger.stage === "complete" && saved.binding.dwsClientId !== target)
      fail("本实例已完成应用迁移，不能自动恢复旧绑定；请管理员核对状态卷。");
  } else if (saved.binding.dwsClientId !== target && config.identityPolicy.allowExistingBindingMigration) {
    ledger = { version: 1, targetClientId: target, sourceBinding: saved.binding, stage: "pending", createdAt: Date.now() };
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Exclusive creation preserves the first recorded source across contenders.
    try { await writeFile(path, JSON.stringify(ledger) + "\n", { mode: 0o600, flag: "wx" }); }
    catch (e) { if (e.code !== "EEXIST") throw e; return prepareIdentityPolicy(stateDir, config, host); }
  }
  return { saved, ledger, path, dir };
}

function readDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") fail("助手数据库完整性检查未通过，未迁移。");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    if (!["kv", "drafts", "cards"].every((t) => tables.has(t))) fail("助手数据库格式不支持自动迁移。");
    const get = (key) => { const row = db.prepare("SELECT body FROM kv WHERE key=?").get(key); return row ? JSON.parse(row.body) : undefined; };
    const runs = tables.has("draft_runs") ? db.prepare("SELECT state FROM draft_runs").all() : [];
    if (runs.some((r) => !["complete", "error", "rejected"].includes(r.state)))
      fail("有起草任务尚未确认结束，暂不迁移。请管理员先核实宿主任务终态，不能删除任务保护记录。");
    return { identity: get("identity"), settings: validateSettings(get("settings") ?? initialSettings()), directory: get("directory") ?? [], marker: get("identityAppMigration") };
  } finally { db.close(); }
}
async function stamp(dir) {
  const hash = createHash("sha256");
  for (const name of files) {
    hash.update(name); const file = join(dir, name), info = await fileInfo(file);
    // Opening a WAL database read-only can create an empty WAL sidecar.
    if (name.endsWith("-wal") && !info?.size) hash.update("EMPTY-WAL");
    else if (!info) hash.update("ABSENT");
    else for await (const chunk of createReadStream(file)) hash.update(chunk);
  }
  return hash.digest("hex");
}
async function snapshot(dir, binding) {
  const before = await stamp(dir), pref = await json(join(dir, "preferences.json"));
  if (pref && (pref.identity?.profile !== binding.profile || pref.identity?.ownerUserId !== binding.ownerUserId || pref.identity?.accountId !== binding.accountId))
    fail("个人设置归属与旧绑定不一致，未迁移。");
  const prefs = pref ? validatePreferences(pref.preferences) : undefined;
  const dbExists = Boolean(await fileInfo(join(dir, "assistant.sqlite")));
  const data = dbExists ? readDatabase(join(dir, "assistant.sqlite")) : { settings: initialSettings(), directory: [] };
  if (data.identity && (data.identity.profile !== binding.profile || data.identity.owner !== binding.ownerUserId || data.identity.account !== binding.accountId))
    fail("助手数据库归属与旧绑定不一致，未迁移。");
  // Legacy autonomous sessions have no terminal ledger. Do not assume they ended.
  const sources = await json(join(dir, "sources.json"));
  if (sources && (sources.version !== 1 || !Array.isArray(sources.records) || sources.records.length))
    fail("存在旧自主任务来源记录，需管理员确认任务已结束后迁移；原记录保留。");
  if (before !== await stamp(dir)) fail("迁移检查期间业务数据发生变化，请确认只有一个活动实例后重试。");
  return { ...data, prefs, dbExists, stamp: before };
}
export function migrationTargets(prefs, settings) {
  const targets = new Map();
  const add = (kind, id) => targets.set(`${kind}:${id}`, { kind, id });
  if (prefs) {
    for (const id of [...prefs.rules.dm.ids, ...prefs.rules.sender.ids]) add("user", id);
    for (const id of prefs.rules.at.ids) add("group", id);
    for (const kind of ["user", "group"]) for (const row of prefs.reply[`${kind}s`]) add(kind, row.id);
  }
  for (const r of [...settings.autoRules, ...settings.fixedRules]) if (["user", "group"].includes(r.scope)) add(r.scope, r.target);
  for (const r of settings.topics.rules) if (["user", "group"].includes(r.scope)) for (const id of r.targets) add(r.scope, id);
  for (const id of settings.notifications.priorityUsers) add("user", id);
  for (const id of Object.keys(settings.pauses)) add("conversation", id);
  if (targets.size > 600) fail("已保存目标超过单次迁移检查上限，请管理员分批核实；未放宽任何规则。");
  return [...targets.values()];
}
async function verifyTargets(data, binding, call, signal, config, owner, robot) {
  const targets = migrationTargets(data.prefs ?? initialPreferences(config), data.settings);
  for (const id of config.listener.ignoreSenderOpenIds) if (![owner.openId, robot.openId].includes(id) && !targets.some((t) => t.kind === "user" && t.id === id)) targets.push({ kind: "user", id });
  if (targets.length > 600) fail("已保存目标超过单次迁移检查上限，请管理员分批核实；未放宽任何规则。");
  let cursor = 0;
  let stopped = false;
  const results = await Promise.allSettled(Array.from({ length: Math.min(2, targets.length) }, async () => {
    try { while (!stopped && cursor < targets.length) {
      check(signal);
      const { kind, id } = targets[cursor++];
      let args;
      if (kind === "user") {
        const rows = data.directory.filter((r) => r.kind === "user" && r.id === id);
        if (rows.length !== 1 || !token(rows[0].userId)) fail("已保存人员规则缺少唯一的 UserId，无法核实跨应用目标；原规则保留，请管理员核对。");
        args = ["contact", "user", "search", "--query", rows[0].userId, "--format", "json"];
        const result = await call(["--profile", binding.profile, ...args]);
        const matches = result?.result?.filter?.((r) => r.userId === rows[0].userId);
        if (result?.success !== true || result.error || !matches || matches.length !== 1 || matches[0].openDingTalkId !== id)
          fail("已保存人员目标在新应用下无法唯一核实，未迁移；不会按姓名猜测或跳过排除规则。");
      } else {
        const result = await call(["--profile", binding.profile, "chat", "conversation-info", "--group", id, "--format", "json"]);
        const info = result?.result?.conversationInfo;
        if (result?.success !== true || result.error || info?.openConversationId !== id ||
            (kind === "group" ? info.singleChat !== false : typeof info.singleChat !== "boolean"))
          fail("已保存群或暂停会话在新应用下无法核实，未迁移；原范围保留。");
      }
    } } catch (error) { stopped = true; throw error; }
  }));
  const rejected = results.find((r) => r.status === "rejected");
  if (rejected) throw rejected.reason;
}
async function makeBackup(dir, ledger, path, signal, originalStamp) {
  const name = `app-migration-backup-${digest(ledger.targetClientId).slice(0, 24)}`;
  const destination = join(dir, name), temporary = `${destination}.${randomUUID()}.tmp`;
  const verifyBackup = async (expectedStamp) => {
    const manifest = await json(join(destination, "manifest.json"));
    if (!manifest || !sameBinding(manifest.sourceBinding, ledger.sourceBinding) || manifest.targetClientId !== ledger.targetClientId ||
        manifest.originalStamp !== expectedStamp || manifest.backupStamp !== await stamp(destination))
      fail("已有迁移备份缺失或不匹配，未覆盖备份或继续迁移。");
  };
  if (ledger.stage !== "pending") {
    if (ledger.backup !== name) fail("迁移备份记录异常，未继续迁移。");
    await verifyBackup(ledger.originalStamp);
    return;
  }
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const file of ["identity.json", "preferences.json", "sources.json"]) {
      check(signal);
      if (await optional(join(dir, file))) { await copyFile(join(dir, file), join(temporary, file)); await chmod(join(temporary, file), 0o600); }
    }
    if (await fileInfo(join(dir, "assistant.sqlite"))) {
      const db = new DatabaseSync(join(dir, "assistant.sqlite"), { readOnly: true });
      try {
        db.exec("PRAGMA busy_timeout=5000");
        db.prepare("VACUUM INTO ?").run(join(temporary, "assistant.sqlite"));
        await chmod(join(temporary, "assistant.sqlite"), 0o600);
      }
      finally { db.close(); }
    }
    check(signal);
    await atomic(join(temporary, "manifest.json"), { version: 1, sourceBinding: ledger.sourceBinding, targetClientId: ledger.targetClientId, originalStamp, backupStamp: await stamp(temporary) });
    try { await rename(temporary, destination); }
    catch (e) {
      if (!["EEXIST", "ENOTEMPTY"].includes(e.code)) throw e;
      await verifyBackup(originalStamp);
    }
    Object.assign(ledger, { stage: "backed_up", backup: name, originalStamp });
    await atomic(path, ledger);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
function protectBusiness(dir, target, at) {
  const db = new DatabaseSync(join(dir, "assistant.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    const get = (key) => { const r = db.prepare("SELECT body FROM kv WHERE key=?").get(key); return r && JSON.parse(r.body); };
    const set = (key, value) => db.prepare("INSERT INTO kv(key,body) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body").run(key, JSON.stringify(value));
    if (get("identityAppMigration")?.targetClientId === target) { db.exec("COMMIT"); return; }
    const settings = validateSettings(get("settings") ?? initialSettings());
    const pause = (rule) => ({ ...rule, expires: 0, appMigrationPaused: true, previousExpires: rule.expires });
    settings.autoRules = settings.autoRules.map(pause);
    settings.topics.rules = settings.topics.rules.map((r) => r.action === "auto" ? pause(r) : r);
    settings.revision++; settings.topics.revision++;
    set("settings", settings);
    for (const row of db.prepare("SELECT id,body FROM drafts").all()) {
      const draft = JSON.parse(row.body);
      if (["sent", "ignored", "expired", "superseded", "suppressed", "filtered"].includes(draft.status)) continue;
      const prior = draft.status;
      Object.assign(draft, { status: ["sending", "unknown"].includes(prior) ? "unknown" : "superseded", version: draft.version + 1,
        updated: at, identityMigrationArchived: true, previousStatus: prior,
        error: prior === "sending" || prior === "unknown" ? "授权应用已更新，原发送结果仍需核实；不会重发。" : "授权应用已更新，此旧草稿仅供查看，不可继续发送。" });
      db.prepare("UPDATE drafts SET status=?,version=?,updated=?,body=? WHERE id=?").run(draft.status, draft.version, at, JSON.stringify(draft), row.id);
    }
    for (const row of db.prepare("SELECT id,body FROM cards").all()) {
      const card = JSON.parse(row.body);
      // Remove the template-upgrade recovery action as well; no old action may send.
      delete card.upgrade; delete card.upgradeRecovery;
      Object.assign(card, { identityMigrationArchived: true, invalidated: "公司授权方式已更新，请发送 /dws 打开助手", invalidatedAt: at, inactivePainted: false,
        nextPaintAttemptAt: 0, paintAttempts: 0, retryUpdate: false });
      db.prepare("UPDATE cards SET body=? WHERE id=?").run(JSON.stringify(card), row.id);
    }
    set("identityAppMigration", { targetClientId: target, completedAt: at, autoRulesPaused: settings.autoRules.length,
      topicRulesPaused: settings.topics.rules.filter((r) => r.appMigrationPaused).length });
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
  finally { db.close(); }
}

export async function migrateIdentity({ stateDir, config, binding, policy, call, signal, now = Date.now, verifyCurrent, checkpoint = async () => {} }) {
  const { saved, ledger, path, dir } = policy;
  if (!saved) return { version: 1, binding };
  if (sameBinding(saved.binding, binding) && (!ledger || ledger.stage === "complete")) return saved;
  if (!config.identityPolicy.allowExistingBindingMigration)
    fail("DWS 授权应用已变化，管理员尚未开启历史绑定自动迁移；原数据保留。");
  if (!ledger || ledger.stage === "complete" || !sameBinding({ ...ledger.sourceBinding, dwsClientId: binding.dwsClientId }, binding))
    fail("变化不只涉及 DWS 授权应用，不能自动迁移；请管理员核对组织、员工、机器人和目录。");
  const lock = join(dir, ".app-migration.lock");
  const lockOwner = { pid: process.pid, processToken, nonce: randomUUID() };
  const lockCandidate = `${lock}.${lockOwner.nonce}.tmp`;
  try {
    await writeFile(lockCandidate, JSON.stringify(lockOwner), { flag: "wx", mode: 0o600 });
    // Install only a completely written lock, never an empty file after a crash.
    await link(lockCandidate, lock);
  }
  catch (e) {
    if (e.code !== "EEXIST") throw e;
    const holder = await json(lock), pid = holder?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof holder.processToken !== "string" || typeof holder.nonce !== "string")
      fail("迁移锁异常，请管理员核对活动实例。");
    let stale = pid === process.pid && holder.processToken !== processToken;
    try { if (!stale) process.kill(pid, 0); }
    catch (error) {
      if (error.code === "ESRCH") stale = true;
    }
    if (stale) { await rm(lock); return migrateIdentity({ stateDir, config, binding, policy, call, signal, now, verifyCurrent, checkpoint }); }
    fail("已有应用迁移正在执行，请稍后重试。");
  } finally { await rm(lockCandidate, { force: true }); }
  try {
    check(signal);
    const latest = await readSavedIdentity(stateDir);
    if (!sameBinding(latest?.binding, saved.binding)) fail("迁移期间身份绑定发生变化，未继续。");
    const data = await snapshot(dir, binding);
    if (ledger.stage === "backed_up" && data.marker?.targetClientId !== binding.dwsClientId && data.stamp !== ledger.originalStamp)
      fail("未完成迁移的业务数据与备份时不一致，请管理员核对；未覆盖备份。");
    const owner = await discoverOwner(binding, call, now), robot = await discoverRobot(binding, call, now);
    if (owner.openId === robot.openId || saved.owner && saved.owner.openId !== owner.openId || saved.robot && saved.robot.openId !== robot.openId)
      fail("本人或机器人开放 ID 在新应用下发生变化，需管理员核实映射；未自动迁移。");
    await verifyTargets(data, binding, call, signal, config, owner, robot);
    await verifyCurrent();
    check(signal);
    if (data.stamp !== await stamp(dir)) fail("迁移期间业务数据发生变化，未继续。请确保单实例运行。");
    await makeBackup(dir, ledger, path, signal, data.stamp);
    await checkpoint("backup"); check(signal);
    if (data.stamp !== await stamp(dir)) fail("备份期间业务数据发生变化，未继续。");
    if (data.dbExists) protectBusiness(dir, binding.dwsClientId, now());
    await checkpoint("business"); check(signal);
    // Durable DB guard precedes identity switch; replay never expires new grants.
    const record = { ...saved, binding, owner, robot, appMigration: { fromClientId: ledger.sourceBinding.dwsClientId, targetClientId: binding.dwsClientId, at: now() } };
    await writeIdentity(stateDir, record, signal);
    await checkpoint("identity"); check(signal);
    await atomic(path, { ...ledger, stage: "complete", completedAt: now() });
    return record;
  } finally {
    if ((await json(lock))?.nonce === lockOwner.nonce) await rm(lock, { force: true });
  }
}
