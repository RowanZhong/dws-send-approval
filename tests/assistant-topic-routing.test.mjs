import assert from "node:assert/strict";
import test from "node:test";
import { topicFixture, rule, none, review, match } from "./topic-fixture.mjs";

const outcomes = [none(), ...["ambiguous", "partial", "excluded", "conflict", "invalid", "failed", "busy"].map(review),
  { ...match(), ruleIds: ["pdf", "second"] }, { ...match(), coversWholeMessage: false }];
test("every non-unique result takes exactly the selected fallback branch", async (t) => {
  for (const mode of ["only", "fallback"]) for (const ordinary of ["ai", "fixed", "auto", "inbox", "off"]) {
    for (const decision of outcomes) {
      const f = await topicFixture(t, { classify: async () => decision }, { mode, rules: [rule(), rule({ id: "second" })] });
      f.prefs.reply.default = { mode: ordinary === "auto" ? "ai" : ordinary, text: ordinary === "fixed" ? "固定确认正文" : "" };
      if (ordinary === "auto") {
        const s = f.assistant.store.get("settings");
        s.autoRules = [{ id: "normal", scope: "all", target: "", keywords: [], text: "普通授权正文", expires: Date.now() + 3600000, cooldownMinutes: 30 }];
        f.assistant.store.set("settings", s);
      }
      const d = await f.incoming(f.event());
      if (ordinary === "off") { assert.equal(d, undefined); continue; }
      if (mode === "only") {
        assert.equal(d.status, "filtered"); assert.equal(f.models.length, 0); assert.equal(f.sends.length, 0);
        assert.equal(f.assistant.store.list(["pending", "inbox", "topic-review", "draft-error"]).length, 0);
        await f.assistant.flushNotifications(); assert.equal(f.cards.length, 0);
      } else {
        assert.equal(d.status, ordinary === "inbox" ? "inbox" : ordinary === "auto" ? "sent" : "pending");
        assert.equal(f.models.length, ordinary === "ai" ? 1 : 0);
        assert.equal(f.sends.length, ordinary === "auto" ? 1 : 0);
        if (ordinary === "fixed") assert.equal(d.text, "固定确认正文");
      }
      assert.equal(d.topic.branch, mode === "only" ? "filtered" : "fallback");
    }
  }
});
test("classification health recovers only after an actual valid classification", async (t) => {
  let result = review("failed");
  const f = await topicFixture(t, { classify: async () => result });
  await f.incoming(f.event());
  assert.equal(f.models.length, 1, "AI fallback still runs once");
  assert.equal(f.assistant.store.get("topicHealth").state, "degraded");
  f.setTopics((x) => { x.rules[0].enabled = false; });
  await f.incoming(f.event());
  assert.equal(f.assistant.store.get("topicHealth").state, "degraded", "skipped classification is not recovery");
  f.setTopics((x) => { x.rules[0].enabled = true; });
  result = none();
  await f.incoming(f.event());
  const health = f.assistant.store.get("topicHealth");
  assert.equal(health.state, "ready"); assert.equal(health.affectedCount, 1);
  assert.ok(health.lastSuccessAt >= health.lastFailureAt);
  assert.equal(f.sends.length, 0);
});
test("timeout follows configured handling, without classifying again", async (t) => {
  let calls = 0;
  const f = await topicFixture(t, { classify: () => { calls++; return new Promise(() => {}); }, topicQueueOptions: { timeoutMs: 5 } });
  const d = await f.incoming(f.event());
  assert.equal(d.status, "pending"); assert.equal(calls, 1); assert.equal(f.models.length, 1);
  assert.equal(d.topic.reasonCode, "failed");
});
test("inbox rules do not require a nonexistent reply template to cover the message", async (t) => {
  const f = await topicFixture(t, { classify: async () => ({ ...match(), coversWholeMessage: false }) }, { rules: [rule({ action: "inbox", text: "" })] });
  const d = await f.incoming(f.event());
  assert.equal(d.status, "inbox"); assert.equal(d.topic.ruleId, "pdf"); assert.equal(f.models.length, 0);
});
