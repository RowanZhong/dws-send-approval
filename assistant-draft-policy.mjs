import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
export const DRAFT_MARKER = ":dws-draft:";
export const DRAFT_TOOLS = Object.freeze(["dws_draft_history", "dws_draft_contact", "dws_draft_search", "dws_draft_read"]);
export const DRAFT_POLICY_VERSION = 1;
const deny = (reason) => ({ block: true, blockReason: `起草只允许受限读取和检索：${reason}` });
export const isDraftSession = (key) => typeof key === "string" && key.toLowerCase().includes(DRAFT_MARKER);
export const draftError = (message, code = "LLM_DRAFT_READONLY_POLICY") => Object.assign(new Error(message), { code });
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function validateDraftParams(name, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw draftError("工具参数无效。");
  const keys = { dws_draft_history: ["limit"], dws_draft_contact: ["subject"], dws_draft_search: ["query"], dws_draft_read: ["handle"] }[name];
  if (!keys || Object.keys(params).some((k) => !keys.includes(k))) throw draftError("工具或参数不在允许范围内。");
  if (name === "dws_draft_history" && params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 50)) throw draftError("历史条数无效。");
  if (name === "dws_draft_contact" && !["owner", "sender"].includes(params.subject)) throw draftError("只能读取本次会话双方的基本资料。");
  if (name === "dws_draft_search" && (typeof params.query !== "string" || !params.query.trim() || params.query.length > 120 || /[\p{C}]|https?:\/\//u.test(params.query))) throw draftError("检索词无效。");
  if (name === "dws_draft_read" && (typeof params.handle !== "string" || !/^[a-f0-9-]{36}$/.test(params.handle))) throw draftError("必须使用本任务检索得到的资源句柄。");
}
export function createDraftPolicy({ store, config, now = Date.now }) {
  const tickets = new Map();
  const task = (ctx) => {
    const record = store.draftRun(ctx?.sessionKey);
    if (!record || record.policy !== DRAFT_POLICY_VERSION || record.agentId !== ctx.agentId ||
      record.profile !== config.profile || record.accountId !== config.accountId || !isDraftSession(ctx.sessionKey)) throw draftError("起草身份无法核实。");
    return record;
  };
  const active = (ctx) => {
    const record = task(ctx), d = store.draft(record.draftId);
    if (!config.assistant.drafting.toolsEnabled || !["starting", "running"].includes(record.state) || now() >= record.deadline ||
      !d || d.version !== record.version || d.status !== "generating") throw draftError("此起草任务已失效，工具调用已停止。");
    return record;
  };
  return {
    task, active,
    before(event, ctx) {
      if (!isDraftSession(ctx?.sessionKey) && ctx?.agentId !== config.assistant.drafting.agentId) return;
      // A dedicated draft agent with missing identity must not inherit ordinary authority.
      if (!isDraftSession(ctx?.sessionKey)) return config.assistant.drafting.toolsEnabled ? deny("缺少专属会话身份。") : undefined;
      try {
        const record = active(ctx); validateDraftParams(event.toolName, event.params);
        const runId = ctx.runId ?? event.runId, callId = ctx.toolCallId ?? event.toolCallId;
        if (event.toolName !== ctx.toolName || !runId || !callId ||
          (ctx.runId && event.runId && ctx.runId !== event.runId) || (record.runId && record.runId !== runId)) throw draftError("任务或工具身份不一致。");
        if (!record.runId) store.putDraftRun({ ...record, runId });
        if (tickets.size >= 100 || (record.calls ?? 0) >= 12) throw draftError("本次查询预算已用尽。");
        const key = `${ctx.sessionKey}:${callId}`;
        if (tickets.has(key)) throw draftError("重复工具调用。");
        tickets.set(key, { name: event.toolName, digest: digest(event.params), runId });
        store.putDraftRun({ ...store.draftRun(ctx.sessionKey), calls: (record.calls ?? 0) + 1 });
      } catch (error) { return deny(error.code ? error.message : "权限检查未通过。"); }
    },
    execute(ctx, callId, name, params) {
      const record = active(ctx), key = `${ctx.sessionKey}:${callId}`, ticket = tickets.get(key);
      tickets.delete(key); validateDraftParams(name, params);
      if (!ticket || ticket.name !== name || ticket.digest !== digest(params) || ticket.runId !== record.runId) throw draftError("执行前身份或参数校验未通过。");
      return record;
    },
    clear(sessionKey) { for (const key of tickets.keys()) if (key.startsWith(sessionKey + ":")) tickets.delete(key); },
  };
}

// This validates both configuration and the actual SDK-resolved tool surface.
export async function assertDraftAgent(api, config, sessionKey, workspaceDir, { auditTools } = {}) {
  const cfg = typeof api.runtime.config?.current === "function" ? api.runtime.config.current() : api.config;
  const id = config.assistant.drafting.agentId;
  const agent = cfg?.agents?.entries?.[id] ?? cfg?.agents?.list?.find((r) => r.id === id);
  if (!agent || id === "main" || id === cfg.agents?.defaults?.systemAgent?.agentId) throw draftError("请配置专用起草 Agent。", "LLM_DRAFT_AGENT_NOT_CONFIGURED");
  if (!agent.workspace || resolve(agent.workspace) !== resolve(workspaceDir) || await realpath(agent.workspace) !== await realpath(workspaceDir)) throw draftError("起草 Agent 必须使用插件专属的独立工作目录。");
  const tools = agent.tools;
  if (!Array.isArray(tools?.allow) || tools.allow.length !== DRAFT_TOOLS.length || new Set(tools.allow).size !== DRAFT_TOOLS.length || tools.allow.some((n) => !DRAFT_TOOLS.includes(n)) ||
    tools.alsoAllow?.length || Object.keys(tools.byProvider ?? {}).length || Object.keys(tools.toolsBySender ?? {}).length || tools.codeMode?.enabled !== false) throw draftError("Agent 工具允许清单必须精确限定为四个起草查询工具，并关闭 Code Mode。");
  if (Object.keys(cfg.tools?.toolSearch ?? {}).length && cfg.tools.toolSearch.enabled !== false) throw draftError("当前宿主动态工具加载未关闭，不能确认只读边界。");
  if (cfg.hooks?.enabled || cfg.hooks?.internal?.enabled) throw draftError("当前宿主启用了尚未审核的生命周期 Hook，无法启用工具起草。");
  // OpenClaw auto-enables its bundled model provider. Its registrations supply
  // inference/media providers, not Agent lifecycle hooks or model-callable tools.
  // The trusted host installation remains part of the boundary; an external
  // replacement with the same provider ID has not been audited.
  if (cfg.plugins?.installs?.openai) throw draftError("外部安装的同名模型插件尚未通过只读审核。");
  const known = new Set(["dws-send-approval", "dingtalk", "memory-core", "openai"]);
  const enabled = new Set([...(cfg.plugins?.allow ?? []), ...Object.entries(cfg.plugins?.entries ?? {}).filter(([, v]) => v.enabled !== false).map(([k]) => k)]);
  for (const plugin of enabled) if (!known.has(plugin) && cfg.plugins?.entries?.[plugin]?.enabled !== false) throw draftError("当前实例存在尚未审核的 Agent 插件，无法确认其生命周期无副作用。");
  if (cfg.plugins?.slots?.memory && !["none", "memory-core"].includes(cfg.plugins.slots.memory)) throw draftError("当前记忆插件尚未验证起草隔离。");
  const model = typeof agent.model === "string" ? agent.model : agent.model?.primary ?? (typeof cfg.agents.defaults?.model === "string" ? cfg.agents.defaults.model : cfg.agents.defaults?.model?.primary);
  if (!model?.includes("/")) throw draftError("需要明确的 Agent 模型。");
  const fallbacks = (typeof agent.model === "object" ? agent.model.fallbacks : undefined) ?? cfg.agents.defaults?.model?.fallbacks ?? [];
  const legacyHost = api.runtime.version === "2026.7.1-2";
  for (const ref of [model, ...fallbacks]) {
    if (agent.models?.[ref]?.agentRuntime?.id !== "openclaw" ||
      (legacyHost ? agent.models?.[ref]?.codeMode === true : agent.models?.[ref]?.codeMode !== false)) throw draftError("起草模型及回退模型必须显式使用 OpenClaw 运行方式并关闭 Code Mode。");
  }
  const inspect = auditTools ?? (async (options) => {
    const { createOpenClawCodingTools } = await import("openclaw/plugin-sdk/agent-harness");
    const { getPluginToolMeta } = await import("openclaw/plugin-sdk/agent-harness-runtime");
    return createOpenClawCodingTools(options).map((tool) => ({ name: tool.name, pluginId: getPluginToolMeta(tool)?.pluginId }));
  });
  for (const ref of [model, ...fallbacks]) {
    const slash = ref.indexOf("/");
    const surface = await inspect({ config: cfg, agentId: id, sessionKey, workspaceDir,
      modelProvider: ref.slice(0, slash), modelId: ref.slice(slash + 1), includeToolSearchControls: true });
    if (surface.length !== DRAFT_TOOLS.length || new Set(surface.map((t) => t.name)).size !== DRAFT_TOOLS.length || surface.some((t) => !DRAFT_TOOLS.includes(t.name) || t.pluginId !== "dws-send-approval")) throw draftError("实际运行时的工具集合或来源不符合只读策略。");
  }
  return { agentId: id, model };
}
