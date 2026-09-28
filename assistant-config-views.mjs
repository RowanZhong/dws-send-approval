import { fixedReplyRows } from "./assistant-fixed-rules.mjs";
const button = (label, op, extra = {}) => ({ label, op, ...extra });
const text = (name, label, defaultValue = "", type = "TEXT_AREA") => ({
  name,
  label,
  type,
  required: false,
  defaultValue,
});
const select = (name, label, options, defaultValue) => ({
  name,
  label,
  type: "CHECKBOX_GROUP",
  required: false,
  defaultValue,
  options: options.map(([value, text]) => ({ value, text })),
});
const modes = [
  ["ai", "AI起草，我确认"],
  ["fixed", "固定回复，逐条确认"],
  ["inbox", "只整理消息"],
  ["off", "不处理"],
];
const scopeName = (scope) =>
  ({
    default: "默认规则",
    dm: "全部已监听私聊",
    all: "全部已监听消息",
    user: "指定人员",
    group: "指定群",
  })[scope];
const back = (label, op, extra) => button(`返回${label}`, op, extra);
export function buildConfigView(name, state, args, view, input) {
  const { prefs, settings, directory } = state;
  const targetLabel = (kind, ids) =>
    ids.map((id) => directory.find((x) => x.kind === kind && x.id === id)?.name || id).join("、");
  if (name === "reply") {
    view.title = "回复方式";
    view.description = `默认：${modes.find(([value]) => value === prefs.reply.default.mode)?.[1]}\n人员专属规则：${prefs.reply.users.length}项\n群专属规则：${prefs.reply.groups.length}项\n\n优先级：不处理 > 人员 > 群 > 默认。\n这里只设置处理方式，自动发送需单独授权。`;
    view.content = { status: modes.find(([v]) => v === prefs.reply.default.mode)?.[1], summary: [`人员专属规则：${prefs.reply.users.length} 项`, `群专属规则：${prefs.reply.groups.length} 项`],
      sections: [{ title: "处理方式的区别", text: "AI 起草：生成回复，由你确认发送。\n固定回复：使用已保存正文，选择逐条确认或授权自动发送。\n只整理消息：进入待处理，不生成回复。\n不处理：不进入回复流程。" }],
      notices: ["优先级：不处理 > 人员 > 群 > 默认。自动发送必须有有效授权。"] };
    view.buttons = [
      button("修改默认规则", "reply-edit", { targetKind: "default" }),
      button("设置指定人员", "reply-target", { targetKind: "user" }),
      button("设置指定群", "reply-target", { targetKind: "group" }),
      button("固定回复", "fixed-replies"),
      back("首页", "home"),
    ];
  } else if (name === "reply-target") {
    const kind = args.targetKind === "group" ? "group" : "user";
    const saved = prefs.reply[kind === "group" ? "groups" : "users"];
    view.title = `回复方式 · ${scopeName(kind)}`;
    view.description = `填写${kind === "group" ? "完整群名" : "钉钉 UserId"}，多个用逗号或换行分隔。\n下一步先校验对象，再编辑规则。多人/多群将应用同一规则。\n\n已配置：${
      saved.length
        ? targetLabel(
            kind,
            saved.map((x) => x.id),
          )
        : "暂无"
    }`;
    view.fields = [
      text(
        "targetInput",
        kind === "group" ? "群名称" : "人员 UserId",
        input(
          kind,
          (args.targets || []).map((x) => x.id),
        ),
      ),
    ];
    view.buttons = [
      button("校验对象，下一步", "load-reply", { targetKind: kind }),
      back("回复方式", "reply"),
    ];
  } else if (name === "reply-edit") {
    const kind = args.targetKind || "default",
      targets = args.targets || [];
    const rule =
      kind === "default"
        ? prefs.reply.default
        : targets.length === 1
          ? prefs.reply[kind === "user" ? "users" : "groups"].find(
              (x) => x.id === targets[0].id,
            ) || { mode: "ai", text: "" }
          : { mode: "ai", text: "" };
    view.title = `编辑回复 · ${scopeName(kind)}`;
    view.description = `对象：${kind === "default" ? "默认规则" : targets.map((x) => `${x.name}（${x.userId || x.id.slice(-8)}）`).join("、")}`;
    view.fields = [
      select("mode", "处理方式", modes, rule.mode),
      text("requirements", "AI 写作要求 / 固定回复正文", rule.text),
    ];
    view.buttons = [
      button("保存回复规则", "save-reply"),
      button(kind === "default" ? "恢复默认要求" : "删除专属规则", "reset-reply"),
      back("回复方式", "reply"),
    ];
  } else if (name === "automation") {
    const count = settings.autoRules.filter((r) => r.expires > Date.now()).length;
    view.title = "固定回复与提醒";
    view.description = `有效自动答复：${count}条\n提醒：${{ digest: "定时汇总", immediate: "即时提醒", manual: "仅主动查看" }[settings.notifications.mode]}\n\n自动答复只发送你授权的固定正文。\n关闭提醒不会停止自动发送。`;
    view.buttons = [
      button("固定回复", "fixed-replies"),
      button("提醒设置", "notifications"),
      button("暂停的会话", "pauses"),
      back("首页", "home"),
    ];
  } else if (name === "fixed-replies") {
    const all = fixedReplyRows(prefs, settings);
    const page = Math.max(0, Math.min(Number(args.page) || 0, Math.max(0, Math.ceil(all.length / 3) - 1)));
    const rows = all.slice(page * 3, page * 3 + 3);
    const label = (r) => `${r.name || scopeName(r.scope)} · ${r.delivery === "auto" ? "授权自动发送" : "逐条确认"}`;
    view.title = "固定回复";
    view.description = `共 ${all.length} 条 · 第 ${page + 1} 页\n设置一次正文，选择逐条确认或授权自动发送。\n\n` + (rows.map((r, i) => `${i + 1}. ${label(r)}\n来源：${{ preference: "普通回复设置", confirm: "固定回复", auto: "自动发送授权", topic: "主题规则" }[r.source]}\n${r.text}`).join("\n\n") || "暂无固定回复。添加规则后，每条是否自动发送由你选择。");
    view.fields = rows.length ? [select("rule", "选择要查看的规则", rows.map((r) => [r.key, label(r)]), rows[0].key)] : [];
    view.buttons = [...(rows.length ? [button("查看规则", "fixed-open")] : []), button("新增固定回复", "fixed-new"),
      ...(page ? [button("上一页", "fixed-replies", { page: page - 1 })] : []),
      ...((page + 1) * 3 < all.length ? [button("下一页", "fixed-replies", { page: page + 1 })] : []), back("回复与提醒", "automation")];
  } else if (name === "fixed-detail") {
    const r = fixedReplyRows(prefs, settings).find((r) => r.key === args.key);
    view.title = "固定回复详情";
    if (!r) { view.description = "规则已变化，请返回重新选择。"; view.buttons = [back("固定回复", "fixed-replies")]; return view; }
    view.description = [`发送方式：${r.delivery === "auto" ? "授权自动发送" : "每条由我确认"}`, `范围：${r.name || scopeName(r.scope)}${r.target ? " · " + r.target : ""}`,
      `关键词：${r.keywords.join("、") || "不限制"}`, `完整正文：\n${r.text}`,
      r.delivery === "auto" ? `授权${r.expires > Date.now() ? "有效至" : "已到期"}：${new Date(r.expires).toLocaleString("zh-CN", { timeZone: settings.notifications.timezone })}\n同一会话间隔：${r.cooldownMinutes} 分钟` : "没有自动发送授权。",
      "修改范围、正文或发送方式后，需要重新查看并确认。"].join("\n\n");
    view.content = { status: r.delivery === "auto" ? r.expires > Date.now() ? "授权自动发送" : "自动授权已到期" : "每条由我确认",
      summary: [`范围：${r.name || scopeName(r.scope)}${r.target ? " · " + r.target : ""}`, `关键词：${r.keywords.join("、") || "不限制"}`],
      sections: [{ title: "完整固定正文", text: r.text }, { title: "授权", text: r.delivery === "auto" ? `截止：${new Date(r.expires).toLocaleString("zh-CN", { timeZone: settings.notifications.timezone })}\n同一会话间隔：${r.cooldownMinutes} 分钟` : "没有自动发送授权。" }],
      notices: ["修改范围、正文或发送方式后，需要重新查看并确认。"] };
    view.buttons = [button("编辑规则", "fixed-edit"), ...(["auto", "confirm"].includes(r.source) ? [button("撤销规则", "fixed-remove")] : []), back("固定回复", "fixed-replies")];
  } else if (name === "fixed-new") {
    view.title = "固定回复 · 发送方式";
    view.description = "逐条确认：生成固定正文，每条由你检查后发送。\n授权自动发送：在指定范围、关键词、期限和频率内自动发送固定正文，最后一步会再次确认授权。";
    view.fields = [select("delivery", "发送方式", [["confirm", "每条由我确认"], ["auto", "条件内自动发送"]], args.wizard?.delivery || "confirm")];
    view.buttons = [button("下一步：范围与正文", "fixed-start"), back("固定回复", "fixed-replies")];
  } else if (name === "auto-manage") {
    const page = Math.max(
        0,
        Math.min(Number(args.page) || 0, Math.max(0, Math.ceil(settings.autoRules.length / 5) - 1)),
      ),
      rows = settings.autoRules.slice(page * 5, page * 5 + 5);
    const label = (r) =>
      `${scopeName(r.scope)}${r.target ? " · " + targetLabel(r.scope, [r.target]) : ""}`;
    view.title = "自动答复授权";
    view.description =
      `共${settings.autoRules.length}条 · 第${page + 1}页\n\n` +
      (rows
        .map(
          (r, i) =>
            `${i + 1}. ${label(r)}\n${r.expires > Date.now() ? "有效至" : "已到期"} ${new Date(r.expires).toLocaleString("zh-CN", { timeZone: settings.notifications.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}\n正文：${r.text}`,
        )
        .join("\n\n") || "尚未授权自动答复。");
    view.fields = rows.length
      ? [
          {
            name: "rules",
            label: "勾选本页要撤销的授权",
            type: "MULTI_CHECKBOX_GROUP",
            options: rows.map((r, i) => ({ value: r.id, text: `${i + 1}. ${label(r)}` })),
          },
        ]
      : [];
    view.buttons = [
      ...(rows.length ? [button("撤销所选授权", "revoke-auto")] : []),
      ...(page ? [button("上一页", "auto-manage", { page: page - 1 })] : []),
      ...((page + 1) * 5 < settings.autoRules.length
        ? [button("下一页", "auto-manage", { page: page + 1 })]
        : []),
      back("自动答复", "automation"),
    ];
  } else if (
    ["auto-new", "auto-content", "auto-limits", "auto-frequency", "auto-review"].includes(name)
  ) {
    const draft = args.wizard || {};
    const confirm = draft.delivery === "confirm";
    const previous = (destination) => button("上一步", "auto-back", { destination });
    const cancel = button("取消，不保存", "automation");
    if (name === "auto-new") {
      view.title = `固定回复 · 1/${confirm ? 3 : 5} 选择范围`;
      view.description =
        "只对已经监听的消息生效。\n指定对象填 UserId / 完整群名，多个用逗号或换行分隔。";
      view.fields = [
        select(
          "scope",
          "适用范围",
          [
            ["dm", "全部私聊"],
            ["all", "全部已监听消息"],
            ["user", "指定人员"],
            ["group", "指定群"],
          ],
          draft.scope || "dm",
        ),
        text("targetInput", "指定对象（选择全部时留空）", draft.targetInput || ""),
      ];
      view.buttons = [button("校验范围，下一步", "auto-next"), cancel];
    } else if (name === "auto-content") {
      view.title = `固定回复 · 2/${confirm ? 3 : 5} 正文`;
      view.description = `范围：${scopeName(draft.scope)}\n只逐字发送以下正文，不让 AI 补充。\n关键词任一命中即回复；留空则匹配范围内全部消息。`;
      view.fields = [
        text("answer", "完整回复正文（最多160字符）", draft.answer || ""),
        text("keywords", "关键词（可留空，逗号或换行分隔）", draft.keywords || ""),
      ];
      view.buttons = [button(confirm ? "下一步：检查规则" : "下一步：授权期限", "auto-next"), previous("auto-new"), cancel];
    } else if (name === "auto-limits") {
      view.title = "固定回复 · 3/5 授权期限";
      view.description = "最终确认后开始计时，到期停止自动答复。";
      view.fields = [
        select(
          "hours",
          "有效期",
          [
            ["1", "1小时"],
            ["8", "8小时"],
            ["24", "24小时"],
            ["168", "7天"],
          ],
          draft.hours || "8",
        ),
      ];
      view.buttons = [button("下一步：发送频率", "auto-next"), previous("auto-content"), cancel];
    } else if (name === "auto-frequency") {
      view.title = "固定回复 · 4/5 发送频率";
      view.description = "避免连续打扰同一会话。每实例每小时最多自动发送30条。";
      view.fields = [
        select(
          "cooldown",
          "同一会话最小间隔",
          [
            ["5", "5分钟"],
            ["30", "30分钟"],
            ["60", "1小时"],
            ["1440", "一天"],
          ],
          draft.cooldown || "30",
        ),
      ];
      view.buttons = [button("下一步：确认授权", "auto-next"), previous("auto-limits"), cancel];
    } else {
      view.title = confirm ? "固定回复 · 3/3 检查规则" : "固定回复 · 5/5 确认授权";
      view.description = [
        `范围：${scopeName(draft.scope)}`,
        draft.targets?.length
          ? `对象：${draft.targets.map((x) => `${x.name}（${x.userId || x.id}）`).join("、")}`
          : "",
        `完整正文：\n${draft.answer || ""}`,
        `关键词：${draft.keywords || "不限制"}`,
        confirm ? "每条由你确认后发送。" : `有效期：${draft.hours}小时；同一会话间隔：${draft.cooldown}分钟`,
        confirm ? "保存规则不会授权自动发送。" : "确认后将以你的身份自动发送以上固定正文。",
        "同一消息若命中相互冲突的固定回复规则，将转为人工处理。",
      ]
        .filter(Boolean)
        .join("\n\n");
      view.buttons = [button(confirm ? "保存逐条确认规则" : "确认授权自动发送", "save-auto"), previous(confirm ? "auto-content" : "auto-frequency"), cancel];
      view.content = { status: confirm ? "待保存 · 每条确认" : "待授权 · 自动发送", summary: [`范围：${scopeName(draft.scope)}`, ...(draft.targets?.length ? [`对象：${draft.targets.map((x) => `${x.name}（${x.userId || x.id}）`).join("、")}`] : [])],
        sections: [{ title: "完整正文", text: draft.answer || "" }, { title: "匹配条件", text: `关键词：${draft.keywords || "不限制"}` },
          { title: "发送授权", text: confirm ? "每条由你确认后发送。保存规则不会授权自动发送。" : `有效期：${draft.hours} 小时\n同一会话间隔：${draft.cooldown} 分钟\n确认后将以你的身份自动发送以上固定正文。` }],
        notices: ["同一消息若命中相互冲突的固定回复规则，将转为人工处理。"] };
    }
  } else if (name === "notifications") {
    const n = settings.notifications;
    view.title = "提醒设置";
    view.description = `提醒方式：${{ digest: "定时汇总", immediate: "即时提醒", manual: "仅主动查看" }[n.mode]}\n汇总间隔：${n.minutes}分钟\n免打扰：${n.quietStart === n.quietEnd ? "关闭" : `${n.quietStart}–${n.quietEnd}`}\n时区：${n.timezone}\n重点联系人：${n.priorityUsers.length}人\n\n提醒设置不影响已授权的自动发送。`;
    view.content = { status: { digest: "定时汇总", immediate: "即时提醒", manual: "仅主动查看" }[n.mode], summary: [`汇总间隔：${n.minutes} 分钟`, `重点联系人：${n.priorityUsers.length} 人`],
      sections: [{ title: "免打扰", text: `${n.quietStart === n.quietEnd ? "关闭" : `${n.quietStart}–${n.quietEnd}`}\n时区：${n.timezone}` }], notices: ["关闭提醒不会停止已授权的自动发送。"] };
    view.buttons = [
      button("提醒方式", "notice-delivery"),
      button("汇总间隔", "notice-frequency"),
      button("免打扰时段", "notice-quiet"),
      button("重点联系人", "notice-priority"),
      back("固定回复与提醒", "automation"),
    ];
  } else if (
    ["notice-delivery", "notice-frequency", "notice-quiet", "notice-priority"].includes(name)
  ) {
    const n = settings.notifications;
    view.title = {
      "notice-delivery": "提醒方式",
      "notice-frequency": "汇总间隔",
      "notice-quiet": "免打扰时段",
      "notice-priority": "重点联系人",
    }[name];
    if (name === "notice-delivery") {
      view.description =
        "即时提醒：草稿就绪后约2秒推送；密集来信合并，两次提醒至少间隔10秒。\n定时汇总：按选定间隔提醒；仅主动查看：不主动提醒。\n自动回复成功只记入历史，可通过定时汇总查看。";
      view.content = { status: "选择接收提醒的方式", summary: [], sections: [
        { title: "即时提醒", text: "草稿就绪后约 2 秒提醒。密集来信合并，两次提醒至少间隔 10 秒。" },
        { title: "定时汇总", text: "按设定间隔集中提醒，可包含自动回复成功记录。" },
        { title: "仅主动查看", text: "不主动提醒，可随时打开助手查看。" }],
        notices: ["提醒方式不影响已授权的自动发送。"] };
      view.fields = [
        select(
          "mode",
          "提醒方式",
          [
            ["digest", "定时汇总"],
            ["immediate", "即时提醒"],
            ["manual", "仅主动查看"],
          ],
          n.mode,
        ),
      ];
    } else if (name === "notice-frequency") {
      view.description = "仅选择“定时汇总”时生效。";
      view.fields = [
        select(
          "minutes",
          "汇总间隔（仅定时汇总生效）",
          [
            ["5", "5分钟"],
            ["15", "15分钟"],
            ["30", "30分钟"],
            ["60", "1小时"],
          ],
          String(n.minutes),
        ),
      ];
    } else if (name === "notice-quiet") {
      view.description =
        "免打扰期间不主动提醒，仍可主动查看。\n时间使用24小时制 HH:MM；起止相同表示关闭。";
      view.fields = [
        text("quietStart", "开始时间", n.quietStart, "TEXT"),
        text("quietEnd", "结束时间", n.quietEnd, "TEXT"),
        text("timezone", "时区", n.timezone, "TEXT"),
      ];
    } else {
      view.description =
        "在非免打扰时段即时提醒。\n填写 UserId；多个用逗号或换行分隔。留空并保存可清空。";
      view.fields = [text("priorityUsers", "重点联系人 UserId", input("user", n.priorityUsers))];
    }
    view.buttons = [
      button("保存本项", "save-notifications", { section: name }),
      back("提醒设置", "notifications"),
    ];
  } else return false;
  return true;
}
