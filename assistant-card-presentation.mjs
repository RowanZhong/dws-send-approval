// One page model drives both staged plain presentation and the rich template.
export const PRESENTATION_VERSION = 3;
export function literal(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([\\`*_{}\[\]()#+.!|~\-$@])/g, "\\$1");
}
export function excerpt(value, limit = 160) {
  const parts = Array.from(new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(String(value)), (x) => x.segment);
  return { text: parts.slice(0, limit).join(""), truncated: parts.length > limit };
}
const pageSections = {
  home: "运行概况", listen: "当前监听范围", "listen-dm": "私聊处理范围", "listen-at": "群消息处理范围", "listen-sender": "额外处理范围",
  directory: "填写对象", "search-results": "校验结果", reply: "当前回复方式", "reply-target": "选择适用对象", "reply-edit": "编辑回复方式",
  topics: "主题处理规则", "topic-mode": "未明确命中时", "topic-manage": "已保存的主题", "topic-detail": "规则详情",
  "topic-new": "第 1 步 · 适用范围", "topic-definition": "第 2 步 · 识别条件", "topic-action": "第 3 步 · 处理动作",
  "topic-trial": "检查试判结果", "topic-limits": "设置自动发送授权", "topic-review": "核对规则与授权",
  automation: "回复与提醒", "auto-manage": "已保存的授权", "fixed-replies": "固定回复规则", "fixed-detail": "当前规则", "fixed-new": "选择发送方式",
  "auto-new": "第 1 步 · 适用范围", "auto-content": "第 2 步 · 回复正文", "auto-limits": "第 3 步 · 授权期限", "auto-frequency": "第 4 步 · 发送频率", "auto-review": "核对正文与授权",
  notifications: "当前提醒设置", "notice-delivery": "选择提醒方式", "notice-frequency": "设置汇总间隔", "notice-quiet": "设置免打扰时段", "notice-priority": "设置优先人员",
  inbox: "待处理消息", history: "处理记录", draft: "回复详情", edit: "修改回复", regenerate: "重新起草", pause: "暂停此会话", pauses: "已暂停的会话",
  "message-detail": "来信全文", "batch-review": "核对即将发送的回复",
};
export const PRESENTATION_PAGES = Object.freeze(Object.keys(pageSections));
export function structureView(view) {
  const content = view.content ?? {
    status: "",
    summary: [],
    sections: view.description.split(/\n\n+/).filter(Boolean).map((text, i) => ({ title: i === 0 ? pageSections[view.name] ?? "页面说明" : "", text })),
    notices: [],
  };
  return { ...view, content, description: plainContent(content) };
}
export function plainContent(content) {
  return [content.status, content.summary?.join("\n"), ...(content.sections ?? []).map((s) => [s.title, s.text].filter(Boolean).join("\n")), ...(content.notices ?? [])].filter(Boolean).join("\n\n");
}
export function renderContent(view, notice = "") {
  const c = view.content;
  const section = (s) => [s.title && `**${literal(s.title)}**`, literal(s.text).replace(/\n/g, "  \n")].filter(Boolean).join("\n\n");
  return {
    content_status: c.status ? `**${literal(c.status)}**` : "",
    content_summary: (c.summary ?? []).map((v) => `- ${literal(v)}`).join("\n"),
    content_body: (c.sections ?? []).map(section).join("\n\n---\n\n"),
    content_notice: [notice, ...(c.notices ?? [])].filter(Boolean).map(literal).join("\n\n"),
  };
}
export function inactiveContent(card, now) {
  const upgrade = Boolean(card.upgrade), canOpen = upgrade && card.expires > now && !card.upgradeRecovery;
  const description = upgrade
    ? "这张卡片已停用。已保存的设置、草稿和待处理消息都已保留。\n" +
      (canOpen ? "点击下方按钮继续处理。" : card.upgradeRecovery ? "已请求打开新版助手；如未看到新卡，请发送 /dws。" : "此恢复入口已到期，请发送 /dws 打开新版助手。") +
      (["edit", "regenerate"].includes(card.name) ? "\n尚未提交的修改可能需要重新填写。" : "")
    : `${card.invalidated || "卡片已到期"}。\n请发送 /dws 打开新卡；已保存设置仍按原有效期生效。`;
  return {
    title: upgrade ? "助手已升级" : "代回复助手 · 已失效", description,
    ...(card.presentationVersion === 3 ? { content_status: upgrade ? "助手已升级" : "卡片已失效", content_summary: "", content_body: literal(description), content_notice: "" } : {}),
    card_status: canOpen ? "pending" : "expired", card_expires_note: "也可发送 /dws 打开助手", form: { fields: [] },
    ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [[`button${i + 1}`, i === 0 && canOpen ? "打开新版助手" : ""],
      [`action${i + 1}`, i === 0 && canOpen ? `dws-assistant:${card.id}:0` : ""]]).flat()),
  };
}
export function upgradeDestination(card, store) {
  if (["draft", "edit", "regenerate", "pause", "message-detail"].includes(card.name)) {
    const id = card.refs?.[0]?.id ?? card.args?.id;
    if (store.draft(id)) return { name: "draft", args: { id } };
    return { name: "inbox", args: {} };
  }
  if (["inbox", "history", "batch-review"].includes(card.name)) return { name: "inbox", args: {} };
  if (card.name.startsWith("topic")) return { name: "topics", args: {} };
  if (card.name.startsWith("auto") || card.name.startsWith("fixed")) return { name: "fixed-replies", args: {} };
  if (card.name.startsWith("reply")) return { name: "reply", args: {} };
  if (card.name.startsWith("listen") || ["directory", "search-results"].includes(card.name)) return { name: "listen", args: {} };
  if (card.name.startsWith("notice") || card.name === "notifications") return { name: "notifications", args: {} };
  return { name: "home", args: {} };
}
