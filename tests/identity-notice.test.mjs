import assert from "node:assert/strict";
import test from "node:test";
import { readdir } from "node:fs/promises";
import { bridge, BRIDGE_KEY } from "../assistant-bridge.mjs";
import { createIdentityNotice } from "../identity-notice.mjs";
import { createIdentityService } from "../identity-service.mjs";
import { COMPANY_AUTH_TEXT, COMPANY_AUTH_TITLE } from "../identity-migration.mjs";
import { readConfig } from "../config.mjs";
import { cfg, profiles, folder, context } from "./identity-fixtures.mjs";

const config = readConfig({ ...cfg, identityPolicy: { requiredDwsClientId: "company-oauth" } }, { discovery: true });
function setup(t, failure) {
  delete globalThis[BRIDGE_KEY];
  const calls = [], legacy = [];
  bridge().channel = { sendCard: async (r) => legacy.push(r), updateCard: async () => {} };
  const cardExtension = { isReady: () => !failure,
    sendCard: async (r) => { calls.push(r); if (failure) throw failure; },
    updateCard: async () => { throw Error("guidance must never update a business card"); } };
  t.after(() => delete globalThis[BRIDGE_KEY]);
  return { cardExtension, calls, legacy };
}
function assertNoActions(variables) {
  assert.equal(variables.title, COMPANY_AUTH_TITLE);
  assert.deepEqual(JSON.parse(variables.form), { fields: [] });
  for (let i = 1; i <= 6; i++) {
    assert.equal(variables[`button${i}`], "");
    assert.equal(variables[`action${i}`], "");
  }
}

test("blocked company identity uses the registered modern handle without a business runtime", async (t) => {
  const { cardExtension, calls, legacy } = setup(t), dir = await folder(t);
  let identityCalls = 0, builds = 0;
  const service = createIdentityService({}, config, { cardExtension, startupDelayMs: 1000000,
    runner: async () => { identityCalls++; return profiles(); },
    buildRuntime: async () => { builds++; throw Error("business runtime must remain blocked"); } });
  service.start(context(dir));
  try {
    await service.refresh();
    assert.equal(service.status().state, "company_auth_required");
    assert.equal(await service.companyGuidance(), "已显示公司授权更新指引。");
    assert.equal(calls.length, 1); assert.equal(legacy.length, 0);
    assert.equal(calls[0].userId, config.ownerUserId);
    assert.match(calls[0].cardId, /^[a-f0-9-]{36}$/);
    assert.equal(calls[0].outTrackId, undefined);
    assertNoActions(calls[0].variables);
    assert.equal(identityCalls, 1); assert.equal(builds, 0);
    assert.throws(() => service.requireRuntime());
    assert.equal((await readdir(dir, { recursive: true })).some((name) => name.includes("assistant.sqlite")), false);
  } finally { await service.stop(); }
  assert.equal(bridge().assistants.size, 0);
});

test("unavailable modern guidance returns text without retrying an available legacy bridge", async (t) => {
  const { cardExtension, calls, legacy } = setup(t, Error("uncertain delivery"));
  const notice = createIdentityNotice(config, { cardExtension });
  try {
    assert.equal(await notice.show(), COMPANY_AUTH_TEXT);
    assert.equal(calls.length, 1); assert.equal(legacy.length, 0);
    assertNoActions(calls[0].variables);
  } finally { notice.stop(); }
});

test("legacy guidance still uses the bridge and has no actionable callback", async (t) => {
  const { legacy } = setup(t);
  const notice = createIdentityNotice(config);
  try {
    assert.equal(await notice.show(), "已显示公司授权更新指引。");
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0].data.button1, "");
    assert.equal(legacy[0].data.action1, "");
    assert.equal(await bridge().assistants.get(config.accountId).handle({
      accountId: config.accountId, userId: config.ownerUserId,
      outTrackId: legacy[0].outTrackId, actionId: "forged-action",
    }), false);
  } finally { notice.stop(); }
});

test("guidance restart reuses the modern handle without disposing its host registration", async (t) => {
  const { cardExtension, calls } = setup(t);
  const notice = createIdentityNotice(config, { cardExtension });
  try {
    assert.equal(await notice.show(), "已显示公司授权更新指引。");
    notice.stop();
    assert.equal(await notice.show(), "已显示公司授权更新指引。");
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].cardId, calls[1].cardId);
  } finally { notice.stop(); }
});
