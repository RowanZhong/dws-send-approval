import assert from "node:assert/strict";
import test from "node:test";
import { registerAssistantCardExtension, CARD_NAMESPACE } from "../card-transport.mjs";
import { runtimeBinding } from "../runtime-binding.mjs";

const config = { accountId: "default", ownerUserId: "owner" };
const api = { id: "dws-send-approval", name: "DWS Reply Assistant", rootDir: "/plugin",
  runtime: { version: "2026.8.1", channel: {} } };
const cardId = "12345678-1234-1234-1234-123456789abc";
const action = { cardId, userId: "owner", actionIds: ["save"], form: { note: "test" }, callbackId: "callback" };
function setup(t) {
  const binding = runtimeBinding({ ...config, test: t.name }), calls = [], registrations = [];
  const extension = { isReady: () => false, sendCard: async () => {}, updateCard: async () => {} };
  const result = registerAssistantCardExtension(api, config, binding, {
    register: (received, options) => { registrations.push({ api: received, options }); return extension; },
  });
  let live;
  t.after(() => binding.remove(live));
  return { result, extension, registrations, calls, binding,
    callback: registrations[0].options.onAction,
    publish(handle = (input) => calls.push(input)) {
      live = { requireRuntime: () => ({ assistant: { handle } }) }; binding.publish(live);
    },
    remove() { binding.remove(live); },
  };
}
test("registers synchronously with host metadata and the new action-only contract", async (t) => {
  const s = setup(t);
  assert.equal(s.result, s.extension);
  assert.equal(s.registrations[0].api, api);
  assert.equal(s.registrations[0].options.accountId, "default");
  assert.equal(s.registrations[0].options.namespace, CARD_NAMESPACE);
  s.publish(); await s.callback(action);
  assert.deepEqual(s.calls, [{ accountId: "default", userId: "owner", outTrackId: `dws-assistant-${cardId}`,
    actionId: "save", values: { note: "test" }, transport: "generic" }]);
});
test("valid callbacks reject before startup, during identity refresh, and after stop", async (t) => {
  const s = setup(t);
  await assert.rejects(s.callback(action), /尚未就绪/);
  const starting = { requireRuntime() { throw Error("identity is starting"); } };
  s.binding.publish(starting);
  await assert.rejects(s.callback(action), /identity is starting/);
  s.binding.remove(starting);
  s.publish(); await s.callback(action); s.remove();
  await assert.rejects(s.callback(action), /尚未就绪/);
  assert.equal(s.calls.length, 1);
});
test("identity/runtime replacement reuses one registration and resolves the current handler", async (t) => {
  const s = setup(t), old = [], fresh = [];
  s.publish((input) => old.push(input)); await s.callback(action); s.remove();
  s.publish((input) => fresh.push(input)); await s.callback(action);
  assert.equal(old.length, 1); assert.equal(fresh.length, 1);
  assert.equal(s.registrations.length, 1);
});
test("prewarm callback registration locates the active runtime for the same config", async (t) => {
  const s = setup(t), anotherBinding = runtimeBinding({ ...config, test: t.name });
  const live = { requireRuntime: () => ({ assistant: { handle: (input) => s.calls.push(input) } }) };
  anotherBinding.publish(live);
  try { await s.callback(action); assert.equal(s.calls.length, 1); }
  finally { anotherBinding.remove(live); }
});
test("public callbacks keep owner and single-action validation without expecting removed fields", async (t) => {
  const s = setup(t); s.publish();
  for (const override of [{ userId: "other" }, { actionIds: ["save", "send"] }, { actionIds: [] },
    { actionIds: undefined }, { cardId: "wrong" }]) await s.callback({ ...action, ...override });
  assert.equal(s.calls.length, 0);
});
test("handler failure propagates so the host can release its deduplication claim", async (t) => {
  const s = setup(t); s.publish(() => { throw Error("retryable failure"); });
  await assert.rejects(s.callback(action), /retryable failure/);
});
test("legacy host never loads the modern client or its absent SDK subpaths", () => {
  for (const version of ["2026.7.1-2", "2026.7.1-2+build", "2026.8.0+build"]) {
    const result = registerAssistantCardExtension({ ...api, runtime: { version } }, config, {}, {
      load() { throw Error("modern module must not load"); },
    });
    assert.equal(result, undefined);
  }
});
test("modern host client-load and registration failures are not downgraded", () => {
  assert.throws(() => registerAssistantCardExtension(api, config, {}, {
    load() { throw Object.assign(Error("missing SDK export"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }); },
  }), /missing SDK export/);
  assert.throws(() => registerAssistantCardExtension(api, config, {}, {
    register() { throw Object.assign(Error("namespace conflict"), { code: "namespace-conflict" }); },
  }), /namespace conflict/);
});
