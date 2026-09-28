import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createIdentityService } from "../identity-service.mjs";
import { selectProfile, selectAuthCheckProfile, verifyAuthStatus } from "../identity-discovery.mjs";
import { IdentityError, cancelled } from "../identity-cli.mjs";
import { cfg, profiles, answer, folder, context, until } from "./identity-fixtures.mjs";

const incomplete = () => {
  const data = profiles();
  delete data.profiles[0].clientId;
  return data;
};
const authenticated = () => ({
  success: true, authenticated: true, corp_id: "corp", user_id: "owner", token_valid: true,
});
async function setup(t, respond, options = {}) {
  const dir = await folder(t), calls = [], built = [];
  let stopped = 0;
  const service = createIdentityService({}, cfg, {
    startupDelayMs: 100000,
    runner: async (_, args, controls) => {
      calls.push({ args, timeoutMs: controls.timeoutMs });
      return respond(args, controls);
    },
    buildRuntime: async (resolved) => {
      built.push(resolved);
      return { service: { stop: async () => stopped++ } };
    },
    ...options,
  });
  service.start(context(dir));
  t.after(() => service.stop());
  return { service, dir, calls, built, stopped: () => stopped };
}
const authCalls = (s) => s.calls.filter(({ args }) => args[0] === "auth");

test("profile diagnostics identify missing and malformed fields without echoing their values", () => {
  for (const field of ["corpId", "userId", "clientId"]) {
    for (const value of [undefined, " ", "PRIVATE invalid field!"]) {
      const data = profiles();
      data.profiles[0][field] = value;
      assert.throws(() => selectProfile(data, cfg), (error) => {
        assert.match(error.message, new RegExp(field));
        assert.match(error.message, value?.startsWith("PRIVATE") ? /格式异常/ : /缺少/);
        assert.doesNotMatch(error.message, /PRIVATE/);
        assert.equal(error.identityReason, field === "clientId" && !value?.trim() ? "profile_client_id_missing" : undefined);
        return true;
      });
    }
  }
  assert.equal(selectAuthCheckProfile(incomplete(), cfg).profile, "corp:owner");
});

test("auth status must positively verify the selected identity and valid credentials", () => {
  const selected = selectAuthCheckProfile(incomplete(), cfg);
  verifyAuthStatus(authenticated(), selected);
  verifyAuthStatus({ ...authenticated(), token_valid: false, refresh_token_valid: true }, selected);
  for (const change of [
    { success: false }, { authenticated: undefined }, { authenticated: "true" },
    { corp_id: "other" }, { user_id: "other" }, { token_valid: false },
    { token_valid: "true" }, { error: "PRIVATE" },
  ]) assert.throws(() => verifyAuthStatus({ ...authenticated(), ...change }, selected));
  for (const [reason, state, message] of [
    ["ciphertext_key_mismatch", "failed", /密钥不匹配/],
    ["dek_missing", "failed", /密钥缺失/],
    ["keychain_unavailable", "failed", /钥匙串/],
    ["PRIVATE unknown reason", "waiting_login", /重新授权/],
    ["constructor", "waiting_login", /重新授权/],
  ]) assert.throws(() => verifyAuthStatus({ success: true, authenticated: false, reason }, selected), (e) => {
    assert.equal(e.identityState, state);
    assert.match(e.message, message);
    assert.doesNotMatch(e.message, /PRIVATE/);
    return true;
  });
});

test("healthy startup and explicit refresh retain the original CLI call sequence", async (t) => {
  const s = await setup(t, answer);
  await s.service.refresh();
  await s.service.refresh(true);
  assert.equal(s.service.status().state, "ready");
  assert.equal(s.calls.length, 5);
  assert.equal(authCalls(s).length, 0);
  assert.equal(s.stopped(), 1);
});

test("incomplete login is never auth-checked by startup or ordinary command retry", async (t) => {
  const s = await setup(t, incomplete);
  await s.service.refresh(false, true);
  await assert.rejects(s.service.ready(), /clientId/);
  assert.equal(s.calls.length, 2);
  assert.equal(authCalls(s).length, 0);
  assert.equal(s.built.length, 0);
  assert.deepEqual(await readdir(s.dir), []);
});

test("manual refresh checks exactly one explicit profile then accepts newly complete metadata", async (t) => {
  let checked = false;
  const s = await setup(t, (args) => {
    if (args[0] === "auth") { checked = true; return authenticated(); }
    return args[0] === "profile" && !checked ? incomplete() : answer(args);
  });
  await s.service.refresh(true);
  assert.deepEqual(authCalls(s), [{
    args: ["auth", "status", "--profile", "corp:owner", "--format", "json"], timeoutMs: 15000,
  }]);
  assert.equal(s.calls.filter(({ args }) => args[0] === "profile").length, 2);
  assert.equal(s.service.status().state, "ready");
  assert.equal(s.service.status().binding.dwsClientId, "oauth-code");
  assert.equal(s.built[0].listener.enabled, false);
});

test("valid login with persistently missing app metadata fails clearly without writing identity", async (t) => {
  const s = await setup(t, (args) => args[0] === "auth" ? authenticated() : incomplete());
  await s.service.refresh(true);
  assert.equal(s.service.status().state, "failed");
  assert.match(s.service.text(), /登录有效.*缺少授权应用 ID/);
  assert.match(s.service.text(), /无需先退出所有账号/);
  assert.equal(s.calls.length, 3);
  assert.equal(s.built.length, 0);
  assert.deepEqual(await readdir(s.dir), []);
});

test("wrong owner, unusable, ambiguous and malformed profiles never trigger auth status", async (t) => {
  for (const edit of [
    (p) => { p.profiles[0].userId = "other"; },
    (p) => { delete p.profiles[0].corpId; },
    (p) => { p.profiles[0].clientId = "bad value"; },
    (p) => { p.profiles[0].status = "revoked"; },
    (p) => { p.profiles[0].status = "unavailable"; },
    (p) => { p.profiles.push({ ...p.profiles[0] }); },
    (p) => { p.currentProfile = "other"; },
  ]) {
    const data = incomplete(); edit(data);
    const s = await setup(t, () => data);
    await s.service.refresh(true);
    assert.notEqual(s.service.status().state, "ready");
    assert.equal(authCalls(s).length, 0);
    assert.equal(s.built.length, 0);
  }
  assert.throws(() => selectAuthCheckProfile(incomplete(), { ...cfg, profile: "other" }), { identityState: "account_mismatch" });
});

test("auth rejection or mismatch stops before rereading or creating a runtime", async (t) => {
  for (const status of [
    { success: true, authenticated: false },
    { ...authenticated(), user_id: "other" },
    { ...authenticated(), token_valid: false },
    { success: false },
  ]) {
    const s = await setup(t, (args) => args[0] === "auth" ? status : incomplete());
    await s.service.refresh(true);
    assert.equal(s.calls.length, 2);
    assert.equal(s.built.length, 0);
  }
});

test("profile changes during verification cannot initialize under a different organization", async (t) => {
  let checked = false;
  const s = await setup(t, (args) => {
    if (args[0] === "auth") { checked = true; return authenticated(); }
    if (!checked) return incomplete();
    const p = profiles(); p.profiles[0].corpId = "other-corp";
    return p;
  });
  await s.service.refresh(true);
  assert.equal(s.service.status().state, "account_mismatch");
  assert.equal(s.built.length, 0);
});

test("failed checks preserve existing binding and business files; recovery still enforces the OAuth binding", async (t) => {
  let mode = "healthy", checked = false;
  const s = await setup(t, (args) => {
    if (args[0] === "auth") { checked = true; return authenticated(); }
    const p = answer(args);
    if (args[0] === "profile" && mode !== "healthy") {
      if (!checked || mode === "missing") delete p.profiles[0].clientId;
      else p.profiles[0].clientId = "different-oauth";
    }
    return p;
  });
  await s.service.refresh(true);
  const stateDir = join(s.dir, "dws-send-approval");
  await mkdir(stateDir, { recursive: true });
  const saved = { "identity.json": await readFile(join(stateDir, "identity.json"), "utf8") };
  for (const name of ["preferences.json", "assistant.db", "sources.json"]) {
    saved[name] = `existing business state: ${name}`;
    await writeFile(join(stateDir, name), saved[name]);
  }
  mode = "missing";
  await s.service.refresh(true);
  assert.equal(s.service.status().state, "failed");
  assert.equal(s.stopped(), 1);
  for (const [name, data] of Object.entries(saved)) assert.equal(await readFile(join(stateDir, name), "utf8"), data);
  mode = "changed"; checked = false;
  await s.service.refresh(true);
  assert.equal(s.service.status().state, "account_mismatch");
  assert.equal(s.built.length, 1);
  for (const [name, data] of Object.entries(saved)) assert.equal(await readFile(join(stateDir, name), "utf8"), data);
  mode = "healthy";
  await s.service.refresh(true);
  assert.equal(s.service.status().state, "ready");
  assert.equal(s.built.length, 2);
  for (const [name, data] of Object.entries(saved).filter(([name]) => name !== "identity.json"))
    assert.equal(await readFile(join(stateDir, name), "utf8"), data);
});

test("manual check queued during automatic bootstrap is serialized and never automatically retried", async (t) => {
  let release, entered = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const s = await setup(t, async (args) => {
    if (args[0] === "auth") throw new IdentityError("failed", "网络暂时失败", true, 1);
    if (!entered) { entered = true; await gate; }
    return incomplete();
  }, { retryDelayMs: 1 });
  const first = s.service.refresh(false, true);
  await until(() => entered);
  const manual = s.service.refresh(true);
  release();
  await Promise.all([first, manual]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(authCalls(s).length, 1);
  assert.equal(s.calls.length, 3);
  assert.equal(s.built.length, 0);
});

test("auth check respects the overall timeout and service shutdown", async (t) => {
  for (const shutdown of [false, true]) {
    let entered = false;
    const s = await setup(t, (args, { signal }) => {
      if (args[0] !== "auth") return incomplete();
      entered = true;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(cancelled()), { once: true }));
    }, { budgetMs: shutdown ? 1000 : 30 });
    const pending = s.service.refresh(true);
    if (shutdown) { await until(() => entered); await s.service.stop(); }
    await pending;
    assert.equal(s.service.status().state, shutdown ? "stopped" : "failed");
    if (!shutdown) assert.match(s.service.text(), /超时/);
    assert.equal(authCalls(s).length, 1);
    assert.equal(s.built.length, 0);
    assert.deepEqual(await readdir(s.dir), []);
  }
});
