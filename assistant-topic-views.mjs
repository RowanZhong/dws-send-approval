import { TOPIC_ACTIONS, TOPIC_REASONS, initialTopics } from "./assistant-topic-rules.mjs";
const button = (label, op, extra = {}) => ({ label, op, ...extra });
const text = (name, label, value = "") => ({ name, label, type: "TEXT_AREA", required: false, defaultValue: value });
const select = (name, label, options, value, multi = false) => ({ name, label,
  type: multi ? "MULTI_CHECKBOX_GROUP" : "CHECKBOX_GROUP", required: false, defaultValue: value,
  options: options.map(([value, text]) => ({ value, text })) });
const scopeNames = { all: "全部已监听消息", dm: "已监听私聊", user: "指定人员", group: "指定群" };
export const TOPIC_PAGES = ["topics", "topic-mode", "topic-manage", "topic-detail", "topic-new",
  "topic-definition", "topic-action", "topic-trial", "topic-limits", "topic-review"];
export function buildTopicView(name, state, args, view) {
  if (!TOPIC_PAGES.includes(name)) return false;
  const topics = state.settings.topics ?? initialTopics(), w = args.wizard ?? {};
  const back = button("返回消息主题", "topics");
  const targets = (r) => r.targets.map((id) => state.directory.find((x) => x.id === id && x.kind === r.scope)?.name || id).join("、");
  const describe = (r) => `${r.name} · ${r.enabled ? "启用" : "停用"}\n${scopeNames[r.scope]}${r.targets.length ? `：${targets(r)}` : ""}\n${TOPIC_ACTIONS[r.action]}`;
  if (name === "topics") {
    view.title = "消息主题";
    view.description = `主题识别：${topics.enabled ? "已开启" : "已关闭"}\n未明确命中：${topics.mode === "only" ? "只关注指定主题，一律过滤" : "其他消息照常处理，沿用普通回复方式及有效自动授权"}\n主题规则：${topics.rules.length}条\n\n先检查监听来源，再判断主题。明确命中唯一主题才执行该规则；不确定、多个主题或识别异常均按上方设置处理。规则不扩大来源范围。${topics.enabled && topics.mode === "only" && !topics.rules.some((r) => r.enabled) ? "\n\n没有启用的主题：所有来信都将被过滤。" : ""}`;
    view.content = { status: `主题识别${topics.enabled ? "已开启" : "已关闭"}`, summary: [`已保存 ${topics.rules.length} 条规则`],
      sections: [{ title: "明确命中唯一主题", text: "执行该主题设置的动作。规则只在已允许的监听范围内生效。" },
        { title: "未明确命中", text: topics.mode === "only" ? "只关注指定主题：一律不处理。" : "其他消息照常处理：沿用普通回复方式及范围、期限内的自动发送授权。" }],
      notices: [...(!topics.enabled ? ["当前未开启主题识别，按普通回复方式处理。"] : []),
        ...(topics.enabled && topics.mode === "only" && !topics.rules.some((r) => r.enabled) ? ["没有启用的主题：所有已监听来信都将被过滤。"] : [])] };
    view.buttons = [button("主题开关与未命中策略", "topic-mode"), button("新增主题规则", "topic-new"),
      button("查看与管理规则", "topic-manage"), button("返回监听范围", "listen")];
  } else if (name === "topic-mode") {
    view.title = "主题开关与未命中策略";
    view.description = "明确命中唯一主题时执行该规则。\n未明确命中（含不确定、多个主题或识别异常）时：\n· 其他消息照常处理：按普通回复方式处理，包括范围与期限内的自动发送授权。\n· 只关注指定主题：一律过滤，不起草、不发送、不创建待办；可能过滤相关但无法明确匹配的消息，原因可在处理记录查看。\n关闭主题识别会恢复普通回复流程；本页不改变监听总开关。";
    view.content = { status: "选择未明确命中时的处理方式", summary: ["唯一明确命中：执行主题规则"],
      sections: [{ title: "其他消息照常处理", text: "按普通回复方式处理。已有自动发送授权仍受范围和期限限制。" },
        { title: "只关注指定主题", text: "未明确命中一律不处理，不起草、不发送、不进入待处理列表。可能漏掉相关但无法明确匹配的消息，原因可在处理记录查看。" }],
      notices: ["不确定、多个主题或识别异常，都按未明确命中处理。关闭主题识别恢复普通流程，不改变监听总开关。"] };
    view.fields = [select("enabled", "主题识别", [["on", "开启"], ["off", "关闭，恢复原有流程"]], topics.enabled ? "on" : "off"),
      select("mode", "未明确命中的消息", [["fallback", "其他消息照常处理"], ["only", "只关注指定主题"]], topics.mode)];
    view.buttons = [button("保存主题策略", "topic-save-mode"), back];
  } else if (name === "topic-manage") {
    const page = Math.max(0, Math.min(Number(args.page) || 0, Math.max(0, Math.ceil(topics.rules.length / 3) - 1)));
    const rows = topics.rules.slice(page * 3, page * 3 + 3);
    view.title = "主题规则管理";
    view.description = `共${topics.rules.length}条 · 第${page + 1}页\n\n${rows.map(describe).join("\n\n")}\n\n停用后不会匹配本规则，原有回复流程是否继续取决于未命中策略。`;
    view.content = { status: `共 ${topics.rules.length} 条 · 第 ${page + 1} 页`, summary: [],
      sections: rows.length ? rows.map((r) => ({ title: `${r.name} · ${r.enabled ? "启用" : "停用"}`,
        text: `${scopeNames[r.scope]}${r.targets.length ? `：${targets(r)}` : ""}\n${TOPIC_ACTIONS[r.action]}` })) : [{ title: "暂无主题规则", text: "返回消息主题后可新增规则。" }],
      notices: ["停用后不再匹配本规则，其余消息按未明确命中策略处理。"] };
    view.fields = [select("rules", "选择本页规则", rows.map((r) => [r.id, r.name]), [], true)];
    view.buttons = [...(rows.length ? [button("查看所选第一条", "topic-open"), button("停用所选", "topic-disable"), button("删除所选", "topic-delete")] : []),
      ...(page ? [button("上一页", "topic-manage", { page: page - 1 })] : []),
      ...((page + 1) * 3 < topics.rules.length ? [button("下一页", "topic-manage", { page: page + 1 })] : []), back];
  } else if (name === "topic-detail") {
    const r = topics.rules.find((r) => r.id === args.id);
    if (!r) throw new Error("主题已删除，请重新打开规则列表。");
    view.title = "主题规则详情";
    view.description = `${describe(r)}\n\n关注的问题：\n${r.description}\n\n典型问法：\n${r.examples || "未填写"}\n\n不适用情形：\n${r.exclusions || "未填写"}\n\n固定正文：\n${r.text || "只整理，不发送"}${r.action === "auto" ? `\n\n授权${r.expires <= Date.now() ? "已到期" : "有效至"}：${new Date(r.expires).toLocaleString("zh-CN", { timeZone: state.settings.notifications.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}\n同一会话间隔：${r.cooldownMinutes}分钟` : ""}`;
    view.content = { status: `${r.name} · ${r.enabled ? "启用" : "停用"}`, summary: [scopeNames[r.scope], ...(r.targets.length ? [targets(r)] : []), TOPIC_ACTIONS[r.action]],
      sections: [{ title: "关注的问题", text: r.description }, { title: "典型问法", text: r.examples || "未填写" }, { title: "不适用情形", text: r.exclusions || "未填写" },
        { title: "完整固定正文", text: r.text || "只整理，不发送" }, ...(r.action === "auto" ? [{ title: "自动发送授权", text: `授权${r.expires <= Date.now() ? "已到期" : "有效至"}：${new Date(r.expires).toLocaleString("zh-CN", { timeZone: state.settings.notifications.timezone })}\n同一会话间隔：${r.cooldownMinutes} 分钟` }] : [])], notices: [] };
    view.buttons = [button("编辑与重新启用", "topic-edit", { id: r.id }), button("试判本规则", "topic-test-saved", { id: r.id }), back];
  } else {
    const cancel = button("取消，不保存", "topics");
    const previous = (destination) => button("上一步", "topic-back", { destination });
    if (name === "topic-new") {
      view.title = "主题规则 · 1/6 来源";
      view.description = "仅在已允许的监听来源内生效。\n指定人员填 UserId，群填完整群名；多人、多群用逗号或换行分隔。";
      view.fields = [select("scope", "适用来源", Object.entries(scopeNames), w.scope || "all"),
        text("targetInput", "指定对象（选择全部时留空）", w.targetInput || "")];
      view.buttons = [button("校验来源，下一步", "topic-next"), cancel];
    } else if (name === "topic-definition") {
      view.title = "主题规则 · 2/6 识别什么";
      view.description = "描述同一类问题，不必穷举关键词。\n例如关注“询问导出PDF的操作方法”，排除“导出失败、权限不足、要求代操作”。";
      view.fields = [text("name", "主题名称（最多60字符）", w.name), text("description", "关注的问题（最多600字符）", w.description),
        text("examples", "典型问法（可留空，最多600字符）", w.examples), text("exclusions", "不适用情形（可留空，最多400字符）", w.exclusions)];
      view.buttons = [button("下一步：处理方式", "topic-next"), previous("topic-new"), cancel];
    } else if (name === "topic-action") {
      view.title = "主题规则 · 3/6 如何处理";
      view.description = "自动发送仅逐字使用你授权的正文，不让AI改写。\n完整教程可使用简短步骤＋文档链接。只整理时不填写正文。";
      view.fields = [select("action", "明确匹配后", Object.entries(TOPIC_ACTIONS), w.action || "confirm"),
        text("text", "固定回复正文（最多160字符）", w.text || "")];
      view.buttons = [button("下一步：模拟试判", "topic-next"), previous("topic-definition"), cancel];
    } else if (name === "topic-trial") {
      view.title = w.readOnly ? "试判已保存主题" : "主题规则 · 4/6 模拟试判";
      const result = w.trial;
      view.description = `主题：${w.name}\n仅试判本规则，假定来源满足范围；不验证实际订阅或其他规则冲突，不发送消息。${result ? `\n\n上次提交试判结果：${TOPIC_REASONS[result.reason] || "需本人判断"}${result.outcome === "match" ? `\n拟执行：${TOPIC_ACTIONS[w.action]}\n正文：${w.text || "只整理"}` : "\n不会因本规则自动发送"}` : ""}\n\n修改输入后需再次点击试判。试判不能保证所有问法都识别准确；自动授权前至少试判一条明确匹配的消息。`;
      view.content = { status: result ? "上次提交的试判结果" : "输入一条消息进行试判", summary: [`主题：${w.name}`],
        sections: [...(result ? [{ title: TOPIC_REASONS[result.reason] || "未明确命中", text: result.outcome === "match" ? `将执行：${TOPIC_ACTIONS[w.action]}\n${w.action === "inbox" ? "只整理，不生成回复。" : `完整正文：\n${w.text || ""}`}` : "不会执行本规则；实际来信按未明确命中策略处理。" }] : []),
          { title: "本次试判范围", text: "仅测试当前规则，假定来源符合范围。不验证实际监听或其他规则冲突，不发送消息。" }],
        notices: ["修改消息后请重新试判。自动授权前至少试判一条明确匹配的消息；试判不保证所有问法都准确。"] };
      view.fields = [text("sample", "模拟收到的消息（最多8000字符）", w.sample || "")];
      view.buttons = [button("试判，不发送", "topic-test"), ...(w.readOnly ? [back] : [button("下一步：期限与频率", "topic-next"), previous("topic-action"), cancel])];
    } else if (name === "topic-limits") {
      view.title = "主题规则 · 5/6 期限与频率";
      view.description = w.action === "auto" ? "最终确认后开始计时，最多7天。到期保留主题，但固定正文改由本人确认。\n冷却按规则和整个会话计算；全实例每小时自动发送最多30条。" : "本规则不自动发送，无须自动授权期限。";
      view.fields = w.action === "auto" ? [select("hours", "自动授权有效期", [["1", "1小时"], ["8", "8小时"], ["24", "24小时"], ["168", "7天"]], w.hours || "8"),
        select("cooldown", "同一会话最小间隔", [["5", "5分钟"], ["30", "30分钟"], ["60", "1小时"], ["1440", "一天"]], w.cooldown || "30")] : [];
      view.buttons = [button("下一步：完整确认", "topic-next"), previous("topic-trial"), cancel];
    } else {
      view.title = "主题规则 · 6/6 确认启用";
      view.description = `主题：${w.name}\n来源：${scopeNames[w.scope]}${w.targetRows?.length ? ` · ${w.targetRows.map((r) => r.name).join("、")}` : ""}\n关注：${w.description}\n典型问法：${w.examples || "未填写"}\n排除：${w.exclusions || "未填写"}\n\n处理：${TOPIC_ACTIONS[w.action]}\n完整正文：\n${w.text || "只整理，不发送"}${w.action === "auto" ? `\n\n授权${w.hours}小时；同一会话间隔${w.cooldown}分钟` : ""}\n\n同时启用主题识别。未命中：${topics.mode === "only" ? "不处理" : "沿用原有回复流程"}。\n监听总开关不改变；主题不能扩大来源范围。`;
      view.buttons = [button(w.action === "auto" ? "确认授权并启用主题" : "确认保存并启用主题", "topic-save"), previous("topic-limits"), cancel];
      view.content = { status: "核对后启用", summary: [`主题：${w.name}`, `来源：${scopeNames[w.scope]}${w.targetRows?.length ? " · " + w.targetRows.map((r) => r.name).join("、") : ""}`, `处理：${TOPIC_ACTIONS[w.action]}`],
        sections: [{ title: "适用条件", text: `关注：${w.description}\n典型问法：${w.examples || "未填写"}\n排除：${w.exclusions || "未填写"}` },
          { title: "完整正文", text: w.text || "只整理，不发送" },
          { title: "发送授权", text: w.action === "auto" ? `授权 ${w.hours} 小时\n同一会话间隔 ${w.cooldown} 分钟\n确认后将以你的身份自动发送以上固定正文。` : "不授权自动发送。" }],
        notices: [`同时启用主题识别；未明确命中时${topics.mode === "only" ? "一律不处理" : "按普通回复方式及有效授权处理"}。`, "监听总开关不改变；主题不能扩大来源范围。"] };
    }
  }
  return true;
}
