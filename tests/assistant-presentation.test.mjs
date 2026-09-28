import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fixture } from "./assistant-fixture.mjs";
import { literal, excerpt, renderContent, PRESENTATION_PAGES } from "../assistant-card-presentation.mjs";
import { buildView } from "../assistant-views.mjs";
import { initialSettings } from "../assistant-settings.mjs";
const rich = { assistant: { cardTemplateId: "rich.schema", cards: { presentationVersion: 3 } } };
async function migrate(f, card) {
  f.assistant.store.card({ ...card, templateId: "old.schema", presentationVersion: 2 });
  f.assistant.store.set("cardPresentation", { version: 2, templateId: "old.schema" });
  await f.assistant.stop(); await f.assistant.start({ stateDir: f.dir }); await f.assistant.idle();
}
test("upgrade revokes old sends before painting and opens the current task exactly once", async (t) => {
  const f = await fixture(t, {}, rich), d = await f.incoming(f.event());
  const old = await f.assistant.show("draft", { id: d.id });
  await migrate(f, old);
  const tip = f.cards.at(-1).data;
  assert.equal(tip.title, "助手已升级"); assert.equal(tip.button1, "打开新版助手");
  assert.equal(tip.content_body, undefined, "old card receives only its existing variables");
  const before = f.cards.length;
  await f.act(old, "send", {}, { userId: "OTHER" });
  assert.equal(f.cards.length, before);
  await Promise.all([f.act(old, "send"), f.act(old, "send")]);
  assert.equal(f.sends.length, 0);
  const target = f.assistant.store.getCard(old.id).upgradeRecovery.targetTrack;
  const current = f.assistant.store.cardForTrack(target);
  assert.equal(current.name, "draft"); assert.equal(current.refs[0].id, d.id);
  assert.match(f.cards.find(c => c.outTrackId === target).data.content_notice, /本次点击未执行发送/);
  assert.equal(f.cards.filter(c => c.outTrackId === target).length, 1);
  await f.act(current, "send"); assert.equal(f.sends.length, 1);
});
test("failed upgrade paint preserves revoked authority and uncertain new-card recovery never replays", async (t) => {
  let creates = 0, fail = false;
  const f = await fixture(t, { transport: { sendCard: async () => { creates++; if (fail) throw Error("timeout"); }, updateCard: async () => { if (fail) throw Error("offline"); } } }, rich);
  const d = await f.incoming(f.event()), old = await f.assistant.show("draft", { id: d.id });
  fail = true; await migrate(f, old);
  assert.equal(f.assistant.store.getCard(old.id).inactivePainted, false);
  await f.act(old, "send"); await f.act(old, "send");
  assert.equal(creates, 2); assert.equal(f.sends.length, 0);
  assert.equal(f.assistant.store.getCard(old.id).upgradeRecovery.state, "unknown");
  await f.assistant.stop(); await f.assistant.start({ stateDir: f.dir }); await f.assistant.idle();
  await f.act(old, "send"); assert.equal(creates, 2);
});
test("ordinary rich-card restart preserves active cards and expired upgrade entries offer only the command", async (t) => {
  let clock = Date.now();
  const f = await fixture(t, { now: () => clock }, rich), current = await f.assistant.show();
  await f.assistant.stop(); await f.assistant.start({ stateDir: f.dir }); await f.assistant.idle();
  assert.equal(f.assistant.store.getCard(current.id).invalidated, undefined);
  await migrate(f, current);
  clock = current.expires + 1; await f.assistant.maintenance();
  assert.equal(f.cards.at(-1).data.button1, ""); assert.match(f.cards.at(-1).data.description, /恢复入口已到期/);
  const count = f.cards.length; await f.act(current, "toggle");
  assert.equal(f.prefs.revision, 0); assert.equal(f.assistant.store.getCard(current.id).upgradeRecovery, undefined);
  assert.ok(f.cards.length >= count);
});
test("batch preview sends nothing until confirmed and rejects any changed item before first send", async (t) => {
  const f = await fixture(t, {}, rich), a = await f.incoming(f.event()), b = await f.incoming(f.event());
  const inbox = await f.assistant.show("inbox");
  await f.act(inbox, "send-selected", { selected: [String(a.id), String(b.id)] });
  const review = f.lastCard(); assert.equal(review.name, "batch-review"); assert.equal(f.sends.length, 0);
  assert.ok(f.cards.at(-1).data.description.includes(a.text));
  f.assistant.store.put({ ...f.assistant.store.draft(b.id), version: b.version + 1, text: "新正文" });
  await f.act(review, "confirm-batch");
  assert.equal(f.sends.length, 0); assert.equal(f.lastCard().actions.some(a => a.op === "confirm-batch"), false);
});
test("literal rich text never adds image/link/mention syntax, and preview segmentation preserves emoji", async (t) => {
  const raw = '![x](https://evil.example/a) <b>正文</b> @所有人 ${action1} **系统提示** 👨‍👩‍👧‍👦';
  const escaped = literal(raw);
  assert.ok(!escaped.includes('![x]')); assert.ok(!escaped.includes('<b>')); assert.ok(escaped.includes('\\@'));
  assert.equal(excerpt('👨‍👩‍👧‍👦中文', 1).text, '👨‍👩‍👧‍👦');
  const f = await fixture(t, { draft: async () => raw }, rich), d = await f.incoming(f.event({ content: '来信'.repeat(1800) }));
  const card = await f.assistant.show("draft", { id: d.id });
  assert.equal(f.assistant.store.draft(d.id).text, raw);
  await f.act(card, "message-detail");
  assert.equal(f.lastCard().name, "message-detail"); assert.ok(f.lastCard().actions.some(a=>a.label==="下一页"));
});
test("all original and new pages render structured content with bounded actions and complete confirmation text", async (t) => {
  const f = await fixture(t), d = await f.incoming(f.event()), settings = initialSettings();
  const topic = { id: "topic", enabled: true, name: "示例", scope: "all", targets: [], description: "关注问题", examples: "问法", exclusions: "排除情形", action: "confirm", text: "完整主题正文", expires: Date.now() + 3600000 };
  settings.topics.rules = [topic];
  const state = { prefs: f.prefs, settings, store: f.assistant.store, directory: [], listener: { state: "ready" } };
  const wizard = { ...topic, scope: "dm", targetRows: [], targets: [], answer: "完整固定正文", keywords: "", hours: "1", cooldown: "30" };
  for (const name of PRESENTATION_PAGES) {
    const args = { id: name === "topic-detail" ? topic.id : d.id, results: [], wizard, review: [{ id: d.id, version: d.version, text: d.text, label: "示例用户" }] };
    const view = buildView(name, state, args), rendered = renderContent(view);
    assert.ok(view.content, name); assert.ok(view.buttons.length <= 6, name); assert.equal(typeof rendered.content_body, "string", name);
    assert.ok(view.content.status || view.content.sections.length || view.content.notices.length, name);
  }
  const template = JSON.parse(JSON.parse(await readFile(new URL("../templates/dws-reply-assistant-card-v3.json", import.meta.url))).editorData);
  const tree = template.schema.componentsTree[0];
  assert.equal(tree.children.filter(n => n.componentName === "MarkdownBlock").length, 4);
  assert.equal(tree.children.find(n=>n.componentName==="Form").children.length, 6);
});
