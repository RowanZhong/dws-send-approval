import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const source = process.argv[2];
if (!source) throw new Error("Provide the pinned upstream docs/assets/card-template-v2.json; see compat/manifest.json.");
const raw = readFileSync(source);
const manifest = JSON.parse(readFileSync(root + "compat/manifest.json"));
if (createHash("sha256").update(raw).digest("hex") !== manifest.richCardComponent.sourceSha256) throw new Error("Upstream template checksum mismatch");
const upstream = JSON.parse(JSON.parse(raw).editorData);
const base = JSON.parse(JSON.parse(readFileSync(root + "templates/dws-reply-assistant-card.json")).editorData);
const find = (node, fn) => fn(node) ? node : (node.children ?? []).map((n) => find(n, fn)).find(Boolean);
const block = find(upstream.schema.componentsTree[0], (n) => n.componentName === "MarkdownBlock" && n.props.content.variable === "content");
if (!block) throw new Error("Pinned MarkdownBlock missing");
base.schema.componentsMap.push(structuredClone(upstream.schema.componentsMap.find((n) => n.componentName === "MarkdownBlock")));
const tree = base.schema.componentsTree[0];
// The live card editor exposes blue / blue_filled / gray / red / gold. Keep
// one primary action and use its documented gray style for remaining actions.
const styleButtons = (node) => {
  if (node.componentName === "SingleButton" && /^dws_assistant_button_[1-6]$/.test(node.id)) {
    node.props.color.value = node.id.endsWith("_1") ? "blue_filled" : "gray";
  }
  for (const child of node.children ?? []) styleButtons(child);
};
styleButtons(tree);
const variables = ["content_status", "content_summary", "content_notice", "content_body"];
const blocks = variables.map((name, index) => {
  const node = structuredClone(block);
  node.id = `dws_rich_${name}`;
  node.props.content.variable = name;
  node.props.visible.condition.conditions[0].variable = name;
  node.props.marginTop = index === 0 ? 8 : 12;
  node.props.marginBottom = 4;
  return node;
});
const i = tree.children.findIndex((n) => n.componentName === "BaseText" && n.props.text.content === "${description}");
if (i < 0) throw new Error("Description slot missing");
tree.children.splice(i, 1, ...blocks);
for (const name of variables) base.variableList.push({ name, id: name, type: "markdown", private: false, editorVarType: "variables" });
base.mockData.cardData = { ...base.mockData.cardData, title: "回复详情", content_status: "**待确认**",
  card_expires_note: "示例卡片 · 有效期以实际消息为准", button1: "确认发送", button2: "修改", button3: "重新起草",
  button4: "忽略", button5: "我来处理", button6: "查看来信全文",
  content_summary: "- 示例联系人 · 私聊\n- 连续收到 2 条消息", content_notice: "请核对下方完整回复后确认发送。",
  content_body: "**来信 · 09/28 09:00**\n\n请帮我确认今天的安排。\n\n---\n\n**将以你的身份回复 · 完整正文**\n\n我先核对安排，确认后回复你。" };
// The editor previews markdown from richTextData, not the raw cardData strings.
// Match the pinned upstream's compiled mock format; production still receives
// markdown strings through cardParamMap and the platform compiles them.
const textStyle = { colorTokenV2: "common_level1_base_color", darkColor: "#FFFFFF", lightColor: "#171A1D",
  lineHeight: 1.5, lineHeightToken: "common_body_text_style__line_height", size: 14, sizeToken: "common_body_text_style__font_size" };
const preview = (paragraphs) => ({ version: "1.1", items: paragraphs.flatMap(([text, bold], index) => [
  ...(index ? [{ data: {}, style: { gap: 10 }, type: "paragraphSpace" }] : []),
  { data: { text }, style: { ...textStyle, ...(bold ? { bold: 1 } : {}) }, type: "text" },
]) });
base.mockData.richTextData = { cardData: {
  content_status: preview([["待确认", true]]),
  content_summary: preview([["• 示例联系人 · 私聊"], ["• 连续收到 2 条消息"]]),
  content_notice: preview([["请核对下方完整回复后确认发送。"]]),
  content_body: preview([["来信 · 09/28 09:00", true], ["请帮我确认今天的安排。"],
    ["将以你的身份回复 · 完整正文", true], ["我先核对安排，确认后回复你。"]]),
}, localData: {} };
// This is an import source, NOT a platform-compiled or published export.
writeFileSync(root + "templates/dws-reply-assistant-card-v3.json", JSON.stringify({ editorData: JSON.stringify(base), widgetInfo: "", type: "im", mode: "card" }, null, 2) + "\n");
