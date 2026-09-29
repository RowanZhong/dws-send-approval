import { buildTopicView } from "./assistant-topic-views.mjs";
import { buildConfigView } from "./assistant-config-views.mjs";
import { targetInput } from "./assistant-directory.mjs";
import { batchMembers } from "./assistant-batches.mjs";
import { structureView, excerpt } from "./assistant-card-presentation.mjs";
import { PENDING, EDITABLE } from "./assistant-store.mjs";

const button = (label, op, extra = {}) => ({ label, op, ...extra });
const field = (name, label, type = "TEXT", extra = {}) => ({
  name,
  label,
  type,
  required: false,
  ...extra,
});
const select = (name, label, values, value) =>
  field(name, label, "CHECKBOX_GROUP", {
    defaultValue: value,
    options: values.map(([value, text]) => ({ value, text })),
  });
const text = (name, label, value = "") => field(name, label, "TEXT_AREA", { defaultValue: value });
const labels = {
  generating: "正在起草",
  classifying: "正在识别主题",
  "topic-review": "旧记录待确认",
  filtered: "已过滤",
  pending: "待确认",
  inbox: "仅整理",
  stale: "需要重新核对",
  "draft-error": "起草失败",
  sending: "发送中",
  sent: "已发送",
  unknown: "发送结果待核实",
  ignored: "已忽略",
  expired: "已过期",
  superseded: "已有更新草稿",
  suppressed: "频率限制，本次未发",
};
export function draftStatusLabel(d) {
  if (d.identityMigrationArchived && d.status !== "unknown") return "授权变更前的草稿 · 仅查看";
  if (d.status === "stale" && d.ownerReplyAt > (d.ownerReplyReviewedAt ?? 0)) return "你已回复，需再次确认";
  return d.status === "draft-error" && d.errorCode === "PROCESS_INTERRUPTED" ? "处理被中断" : labels[d.status] || "待核实";
}
export function draftBodyLabel(d) {
  if (d.text) return d.text;
  if (d.status === "inbox") return "已整理，按设置不生成回复。";
  if (d.status === "generating") return d.draftPhase === "querying" ? "正在查询资料并整理回复，请稍候。" : "正在生成回复，请稍候。";
  if (d.status === "classifying") return "正在识别主题，随后按设置处理。";
  if (d.status === "filtered") return "按“只关注指定主题”设置过滤，不生成回复。";
  if (d.status === "draft-error") return "起草未成功，可重试起草或手动填写。";
  if (d.status === "stale") return "暂无回复正文，请核对最新消息后生成草稿。";
  if (["expired", "superseded", "ignored", "suppressed"].includes(d.status)) return "本条已结束处理。";
  return "暂无回复正文，可查看状态后手动填写。";
}
export function draftLabel(d, directory = []) {
  const name = (kind, id, fallback) => {
    const display = directory.find((x) => x.kind === kind && x.id === id)?.name || fallback;
    const duplicate = directory.some((r) => r.kind === kind && r.id !== id && r.name === display);
    return display
      ? `${String(display).replace(/\p{C}/gu, " ").slice(0, 60)}${duplicate ? ` (${id.slice(-8)})` : ""}`
      : id;
  };
  const sender = name("user", d.event.sender_open_dingtalk_id, d.event.sender);
  return d.reply.direct
    ? `${sender} · 私聊`
    : `${name("group", d.event.conversation_id)} · ${sender}`;
}
export function buildView(name, state, args = {}) {
  const { prefs, settings, store, directory, listener } = state;
  const input = (kind, ids) => targetInput(kind, ids, directory);
  const view = {
    title: "代回复助手",
    description: "",
    fields: [],
    buttons: [],
    refs: [],
    name,
    args,
  };
  const home = button("返回首页", "home");
  if (name === "home") {
    const count = store.list([...PENDING, "unknown"]).length;
    view.description = `监听：${prefs.enabled ? "已开启" : "已关闭"}（${{ off: "已关闭", ready: "就绪", starting: "连接中", failed: "故障", unavailable: "初始化中" }[listener.state] || "待检查"}）\n私聊：${{ off: "关闭", all: "全部", users: "指定人员" }[prefs.rules.dm.mode]}；群@我：${{ off: "关闭", all: "所有群", groups: "指定群" }[prefs.rules.at.mode]}；额外发送者：${prefs.rules.sender.ids.length}人\n待处理：${count}条；关键词自动授权：${settings.autoRules.filter((r) => r.expires > Date.now()).length}条\n主题识别：${settings.topics?.enabled ? "开启" : "关闭"}；有效自动主题：${settings.topics?.enabled ? settings.topics.rules.filter((r) => r.enabled && r.action === "auto" && r.expires > Date.now()).length : 0}条\n发送使用你的身份；未授权内容由你确认。`;
    view.buttons = [
      button("查看待回复", "inbox"),
      button("监听范围", "listen"),
      button("回复方式", "reply"),
      button("固定回复与提醒", "automation"),
      button("处理记录", "history"),
      button(prefs.enabled ? "暂停全部" : "开启监听", "toggle"),
    ];
    if (settings.topics?.enabled && settings.topics.mode === "only" && !settings.topics.rules.some((r) => r.enabled)) {
      view.description += "\n\n只关注指定主题，但没有启用规则：所有来信都将被过滤。";
    }
    const health = store.get?.("topicHealth");
    if (settings.topics?.enabled && health?.state === "degraded") {
      view.description += `\n\n主题识别异常：${health.reason === "busy" ? "暂时繁忙" : health.reason === "invalid" ? "结果无效" : "调用未完成"}。\n最近异常：${new Date(health.lastFailureAt).toLocaleString("zh-CN", { timeZone: settings.notifications.timezone })}；累计影响 ${health.affectedCount} 条。\n消息已按未明确命中的设置处理，恢复后不会自动补发。`;
    }
    if (store.get?.("identityAppMigration"))
      view.description += "\n\n公司授权应用已更新，原设置和历史已保留。旧草稿仅供查看；原自动发送规则需编辑并重新授权后生效。";
    view.content = { status: `监听${prefs.enabled ? "已开启" : "已关闭"} · 待处理 ${count} 条`,
      summary: [`连接状态：${{ off: "已关闭", ready: "就绪", starting: "连接中", failed: "故障", unavailable: "初始化中" }[listener.state] || "待检查"}`,
        `普通回复：${{ ai: "AI 起草，我确认", fixed: "固定正文，我确认", inbox: "只整理消息", off: "不处理" }[prefs.reply.default.mode] || "按设置处理"}`],
      sections: [{ title: "监听范围", text: `私聊：${{ off: "关闭", all: "全部", users: "指定人员" }[prefs.rules.dm.mode]}\n群 @本人：${{ off: "关闭", all: "所有群", groups: "指定群" }[prefs.rules.at.mode]}\n额外发送者：${prefs.rules.sender.ids.length} 人` },
        { title: "主题与授权", text: `主题识别：${settings.topics?.enabled ? "开启" : "关闭"}\n有效普通自动授权：${settings.autoRules.filter((r) => r.expires > Date.now()).length} 条\n有效主题自动授权：${settings.topics?.enabled ? settings.topics.rules.filter((r) => r.enabled && r.action === "auto" && r.expires > Date.now()).length : 0} 条` }],
      notices: view.description.split("\n\n").slice(1) };
  } else if (name === "listen") {
    const describe = (key, kind) => {
      const rule = prefs.rules[key];
      if (rule.mode === "off") return "未监听";
      if (rule.mode === "all") return key === "dm" ? "全部私聊" : "所有群 @本人";
      return rule.ids
        .map((id) => {
          const row = directory.find((x) => x.kind === kind && x.id === id);
          return `· ${row?.name && row.name !== id ? String(row.name).replace(/\p{C}/gu, " ") : "暂未获取名称"}（ID：${row?.name && row.name !== id ? id.slice(-8) : id}）`;
        })
        .join("\n");
    };
    view.title = "监听范围";
    view.description = [
      `当前：${prefs.enabled ? "监听已开启，保存后立即生效" : "监听已关闭，保存后仍关闭"}`,
      `① 私聊\n${describe("dm", "user")}`,
      `② 群内 @本人\n${describe("at", "group")}`,
      `③ 额外发送者（高级）\n${describe("sender", "user")}`,
      "任一范围命中即处理，同一条消息只处理一次。",
    ].join("\n\n");
    view.buttons = [
      button("设置私聊", "listen-dm"),
      button("设置群 @本人", "listen-at"),
      button("设置额外发送者", "listen-sender"),
      button("消息主题", "topics"),
      button("校验人员或群", "directory"),
      home,
    ];
  } else if (["listen-dm", "listen-at", "listen-sender"].includes(name)) {
    const key = name.slice(7);
    const rule = prefs.rules[key];
    const group = key === "at";
    view.title = { dm: "私聊范围", at: "群内 @本人", sender: "额外发送者 · 高级" }[key];
    view.description = [
      key === "sender"
        ? "包含指定人员的私聊和群内发言，即使没有 @你。只需要私聊 + 群 @ 时，请保持关闭。"
        : group
          ? "只处理群里 @你的消息，不处理群内其他发言。"
          : "选择全部私聊，或仅指定人员。",
      group
        ? "指定群填完整群名；多个用逗号或换行分隔。"
        : "指定人员填钉钉 UserId；多个用逗号或换行分隔。",
      "每组最多20项。只保存本组，其他范围保持不变。",
    ].join("\n\n");
    view.fields = [
      select(
        key,
        "选择范围",
        [
          ["off", "关闭"],
          ...(key === "sender" ? [] : [["all", group ? "所有群 @本人" : "全部私聊"]]),
          [group ? "groups" : "users", group ? "指定群" : "指定人员"],
        ],
        rule.mode,
      ),
      text(
        `${key}Ids`,
        group ? "群名称（仅选“指定群”时填写）" : "UserId（仅选“指定人员”时填写）",
        input(group ? "group" : "user", rule.ids),
      ),
    ];
    view.buttons = [
      button("校验并保存本组", "save-listen", { section: key }),
      button("取消，返回范围", "listen"),
    ];
  } else if (name === "directory") {
    view.title = "校验人员或群";
    view.description =
      "人员填写钉钉 UserId（不一定等于企业自定义工号），群填写完整群名。逗号或换行分隔。仅校验，不改变监听。";
    view.fields = [
      select(
        "kind",
        "对象类型",
        [
          ["user", "人员 UserId"],
          ["group", "群名称"],
        ],
        "user",
      ),
      text("query", "UserId 或完整群名"),
    ];
    view.buttons = [button("校验", "search-directory"), button("监听范围", "listen"), home];
  } else if (name === "search-results") {
    view.title = "校验结果";
    view.description =
      args.results.map((x) => `${x.name} · ${x.userId || x.id}`).join("\n") +
      "\n校验成功，未改变监听范围。";
    view.buttons = [button("监听范围", "listen"), button("继续校验", "directory"), home];
  } else if (buildTopicView(name, state, args, view)) {
    // Reuse dynamic forms and six buttons; no new platform template variables.
  } else if (buildConfigView(name, state, args, view, input)) {
    // Configuration pages are kept short and grouped by one user decision.
  } else if (name === "pauses") {
    const all = Object.entries(settings.pauses).filter(([, until]) => until > Date.now());
    const page = Math.max(
      0,
      Math.min(Number(args.page) || 0, Math.max(0, Math.ceil(all.length / 5) - 1)),
    );
    view.title = "暂停的会话";
    view.description = `共${all.length}个 · 第${page + 1}页。恢复不自动重发旧消息。`;
    view.fields = [
      field("conversations", "会话", "MULTI_CHECKBOX_GROUP", {
        options: all.slice(page * 5, page * 5 + 5).map(([value]) => ({
          value,
          text: directory.find((x) => x.id === value)?.name || value,
        })),
      }),
    ];
    view.buttons = [
      ...(view.fields[0].options.length ? [button("恢复所选", "resume")] : []),
      ...(page ? [button("上一页", "pauses", { page: page - 1 })] : []),
      ...((page + 1) * 5 < all.length ? [button("下一页", "pauses", { page: page + 1 })] : []),
      home,
    ];
  } else if (name === "draft" || name === "edit" || name === "regenerate" || name === "pause") {
    const d = store.draft(args.id);
    if (!d) {
      throw new Error("这条记录不存在或已清理。");
    }
    if (d.identityMigrationArchived && name !== "draft") throw new Error("授权变更前的草稿仅供查看，请打开回复详情。");
    view.title = { draft: "回复详情", edit: "修改回复", regenerate: "重新起草", pause: "暂停此会话" }[name];
    const bodyTitle = !d.text ? "回复状态" : ({ sent: "已发送", sending: "正在发送", unknown: "发送结果待核实",
      pending: "将以你的身份回复" }[d.status] ?? "回复草稿") + " · 完整正文";
    view.description = `${draftStatusLabel(d)}\n${d.reply.direct ? "私聊回复" : "引用回复此条群消息"}\n原消息：${d.event.content.slice(0, 3000)}\n\n${bodyTitle}：\n${draftBodyLabel(d)}${d.error ? `\n${d.error}` : ""}${d.topic ? `\n\n消息主题：${d.topic.name || "未确定"} · ${d.topic.reasonLabel || "待核对"}` : ""}`;
    if (d.batch?.memberIds.length > 1) {
      const members = batchMembers(store, d);
      view.description = `${draftStatusLabel(d)}\n连续收到 ${members.length} 条，展示最近 ${Math.min(3, members.length)} 条\n\n` +
        members.slice(-3).map((m) => `${new Date(m.event.timestamp < 100000000000 ? m.event.timestamp * 1000 : m.event.timestamp).toLocaleTimeString("zh-CN", { timeZone: settings.notifications.timezone, hour12: false })}\n${m.event.content.slice(0, 1000)}`).join("\n\n") +
        `\n\n${bodyTitle}：\n${draftBodyLabel(d)}${d.error ? `\n${d.error}` : ""}`;
    }
    const contextNotice = d.contextStatus?.partial ? (PENDING.has(d.status)
      ? "近期上下文未完整取得；请核对回复，也可补充资料后重新起草。"
      : "起草时未完整取得近期上下文。")
      : d.contextStatus?.messageCount > 0 ? `起草参考：${d.contextStatus.messageCount} 条近期对话文字，未读取附件内容。` : "";
    if (contextNotice) view.description += `\n\n${contextNotice}`;
    view.refs = [{ id: d.id, version: d.version }];
    if (name === "edit") {
      view.description = `接收对象与原消息不变。${d.reply.direct ? "" : "发送时引用此条群消息。"}修改后点击发送即发送输入框中的完整正文。\n原消息：${d.event.content.slice(0, 160)}`;
      view.fields = [text("body", "修改后直接发送的完整正文", d.text)];
      view.buttons = [
        button("发送修改后的内容", "edit-send"),
        button("返回草稿", "draft", { id: d.id }),
      ];
    } else if (name === "regenerate") {
      view.description = "只重新生成草稿，确认后再发送。";
      view.fields = [
        select(
          "style",
          "调整方向",
          [
            ["", "按原要求"],
            ["更简短", "更简短"],
            ["更正式", "更正式"],
          ],
          "",
        ),
        text("hint", "补充写作要求"),
        text("material", "本人补充资料（仅用于本条，不加入自动答复）"),
      ];
      view.buttons = [button("重新起草", "generate"), button("返回草稿", "draft", { id: d.id })];
    } else if (name === "pause") {
      view.description = "暂停这个会话，现有待处理草稿将忽略。到期恢复监听，不自动重发旧消息。";
      view.fields = [
        select(
          "hours",
          "暂停多久",
          [
            ["1", "1小时"],
            ["8", "8小时"],
            ["24", "一天"],
            ["87600", "直到手动恢复"],
          ],
          "8",
        ),
      ];
      view.buttons = [
        button("我来处理并暂停", "pause-conversation"),
        button("返回草稿", "draft", { id: d.id }),
      ];
    } else if (PENDING.has(d.status)) {
      view.buttons = [
        ...(d.ownerReplyAt && d.text && d.status === "stale" ? [button("已核对，仍需回复", "ack-owner-reply")] : []),
        ...(d.status === "pending" ? [button("确认发送", "send")] : []),
        ...(EDITABLE.has(d.status) ? [button("修改", "edit", { id: d.id })] : []),
        button(d.status === "draft-error" ? "重试起草" : d.text ? "重新起草" : "生成草稿", "regenerate", { id: d.id }),
        button("忽略", "ignore"),
        button("我来处理", "pause", { id: d.id }),
        button("查看来信全文", "message-detail", { id: d.id }),
      ];
    } else {
      view.buttons = [button("查看待回复", "inbox"), home];
    }
    const allMembers = d.batch?.memberIds?.length ? batchMembers(store, d) : [d];
    const members = allMembers.slice(-3);
    const time = (m) => Number.isFinite(Number(m.event.timestamp)) ? new Date(m.event.timestamp < 100000000000 ? m.event.timestamp * 1000 : m.event.timestamp).toLocaleString("zh-CN", { timeZone: settings.notifications.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "时间未提供";
    if (name === "draft") view.content = {
      status: draftStatusLabel(d), summary: [draftLabel(d, directory), d.reply.direct ? "私聊回复" : "引用回复此条群消息", ...(allMembers.length > 1 ? [`连续收到 ${allMembers.length} 条，展示最近 ${members.length} 条`] : [])],
      sections: [...members.map((m) => { const preview = excerpt(m.event.content, 1000); return { title: `来信 · ${time(m)}`, text: preview.text + (preview.truncated ? "\n（已截取预览，请查看来信全文）" : "") }; }),
        { title: bodyTitle, text: draftBodyLabel(d), dividerBefore: true }],
      notices: [d.error, d.topic && `消息主题：${d.topic.name || "未明确命中"} · ${d.topic.reasonLabel || "按当前规则处理"}`,
        contextNotice,
        d.status === "unknown" && "发送结果尚未核实，请先检查会话记录。不会自动重发。"].filter(Boolean),
    };
    else view.content = { status: draftStatusLabel(d), summary: [draftLabel(d, directory)],
      sections: [{ title: name === "edit" ? "修改说明" : name === "regenerate" ? "起草说明" : "暂停说明", text: view.description }], notices: [] };
  } else if (name === "message-detail") {
    const d = store.draft(args.id);
    if (!d) throw new Error("这条记录不存在或已清理。");
    const members = (d.batch?.memberIds?.length ? batchMembers(store, d) : [d]).slice(-3);
    const pages = members.flatMap((m, i) => {
      const chars = Array.from(new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(m.event.content), (x) => x.segment);
      const chunks = Math.max(1, Math.ceil(chars.length / 2000));
      return Array.from({ length: chunks }, (_, n) => ({ title: `来信 ${i + 1}/${members.length} · ${n + 1}/${chunks}`, text: chars.slice(n * 2000, (n + 1) * 2000).join("") }));
    });
    const page = Math.max(0, Math.min(Number(args.page) || 0, pages.length - 1));
    view.title = "来信全文"; view.refs = [{ id: d.id, version: d.version }];
    view.content = { status: `第 ${page + 1}/${pages.length} 页`, summary: [draftLabel(d, directory)], sections: [pages[page]], notices: [] };
    view.buttons = [...(page > 0 ? [button("上一页", "message-detail", { id: d.id, page: page - 1 })] : []),
      ...(page + 1 < pages.length ? [button("下一页", "message-detail", { id: d.id, page: page + 1 })] : []), button("返回草稿", "draft", { id: d.id }), home];
  } else if (name === "batch-review") {
    const rows = args.review ?? [];
    const valid = rows.length > 0 && rows.length <= 3 && rows.every((r) => { const d = store.draft(r.id); return d?.status === "pending" && d.version === r.version && d.text === r.text && d.expires > Date.now(); });
    view.title = "确认发送所选回复";
    view.refs = rows.map(({ id, version }) => ({ id, version }));
    view.content = { status: valid ? `待确认 · ${rows.length} 条` : "内容或状态已变化", summary: ["以下各条将以你的身份发送。"],
      sections: rows.map((r, i) => ({ title: `回复 ${i + 1} · ${r.label}`, text: r.text, dividerBefore: true })),
      notices: valid ? [] : ["本页已不能发送，请返回待处理列表重新选择并核对。"] };
    view.buttons = [...(valid ? [button("确认发送以上全部", "confirm-batch")] : []), button("返回待处理", "inbox")];
  } else if (name === "inbox" || name === "history") {
    const history = name === "history",
      page = Math.max(0, Number(args.page) || 0),
      all = store
        .list(history ? null : [...PENDING, "unknown"])
        .filter((d) => !args.notificationIds || args.notificationIds.includes(d.id));
    const rows = all.slice(page * 3, page * 3 + 3);
    view.title = history ? "处理记录" : args.notificationIds ? "本次待回复" : "待我处理";
    view.notificationRefs = all.map((d) => ({ id: d.id, version: d.version }));
    const pagination = args.notificationIds ? { notificationIds: args.notificationIds } : {};
    view.description =
      `共${all.length}条 · 第${page + 1}页\n\n` +
      rows
        .map(
          (d) =>
            `#${d.id} ${draftLabel(d, directory)} · ${draftStatusLabel(d)}\n原消息：${d.event.content.slice(0, 160)}\n拟回复：${draftBodyLabel(d)}`,
        )
        .join("\n\n");
    view.refs = rows.map((d) => ({ id: d.id, version: d.version }));
    view.fields = [
      field("selected", "选择本页记录", "MULTI_CHECKBOX_GROUP", {
        options: rows.map((d) => ({
          value: String(d.id),
          text: `#${d.id} ${draftLabel(d, directory)}`,
        })),
      }),
    ];
    view.buttons = [
      ...(rows.length ? [button("查看所选第一条", "open-selected")] : []),
      ...(!history && rows.length
        ? [button("发送所选", "send-selected"), button("忽略所选", "ignore-selected")]
        : []),
      ...(page > 0 ? [button("上一页", name, { ...pagination, page: page - 1 })] : []),
      ...(all.length > (page + 1) * 3
        ? [button("下一页", name, { ...pagination, page: page + 1 })]
        : []),
      home,
    ];
    view.content = { status: all.length ? `共 ${all.length} 条 · 第 ${page + 1} 页` : "暂无待处理消息",
      summary: [], sections: rows.map((d) => ({ title: `${draftLabel(d, directory)} · ${draftStatusLabel(d)}`,
        text: `来信：${excerpt(d.event.content, 100).text}${excerpt(d.event.content, 100).truncated ? "…" : ""}\n回复：${excerpt(draftBodyLabel(d), 80).text}${excerpt(draftBodyLabel(d), 80).truncated ? "…" : ""}` })),
      notices: rows.length ? ["选择记录查看详情；发送前将完整展示所选回复。"] : [history ? "暂无处理记录。" : "新消息进入处理范围后，会出现在这里。"] };
  } else {
    throw new Error("不支持的页面。");
  }
  view.fields = view.fields.filter((f) => !f.options || f.options.length > 0);
  return structureView(view);
}
