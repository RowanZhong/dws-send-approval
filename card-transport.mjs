import { createRequire } from "node:module";
import { bridge } from "./assistant-bridge.mjs";
import { assertHostVersion } from "./config.mjs";

export const CARD_NAMESPACE = "dws-send-approval";
const TRACK = /^dws-assistant-([a-f0-9-]{36})$/;
const require = createRequire(import.meta.url);

// The supported Node versions can synchronously require ESM. Load the modern
// client only during modern-host registration: older SDKs lack its imports.
// Loading/registration failures on a modern host must never select the bridge.
export function registerAssistantCardExtension(api, config, binding, dependencies = {}) {
  assertHostVersion(api.runtime.version);
  const [year, month, day] = api.runtime.version.split(/[.+-]/).map(Number);
  if (year < 2026 || year === 2026 && (month < 8 || month === 8 && day < 1)) return;
  const register = dependencies.register ?? (dependencies.load ?? require)("./vendor/dingtalk-card-extensions.mjs").registerDingTalkCardExtension;
  return register(api, { accountId: config.accountId, namespace: CARD_NAMESPACE,
    async onAction(action) {
      if (action.userId !== config.ownerUserId || !Array.isArray(action.actionIds) ||
          action.actionIds.length !== 1 || !TRACK.test(`dws-assistant-${action.cardId}`)) return;
      // Resolve at callback time: identity refresh replaces the assistant, and
      // service stop removes the binding before asynchronous teardown begins.
      // Throw while unavailable so the host releases its callback dedup claim.
      const assistant = binding.require().requireRuntime().assistant;
      if (!assistant) throw new Error("代回复卡片服务尚未就绪。");
      await assistant.handle({ accountId: config.accountId, userId: action.userId,
        outTrackId: `dws-assistant-${action.cardId}`, actionId: action.actionIds[0],
        values: action.form, transport: "generic" });
    },
  });
}

// Keep persisted logical card IDs stable across the old bridge and the public API.
// The public provider owns the wire outTrackId; only this adapter translates it.
export function createCardTransport(config, handle, dependencies = {}) {
  const extension = dependencies.extension;
  const legacy = dependencies.legacy ?? bridge;
  let registration, active = false;
  function mode() {
    if (!active) return undefined;
    // Readiness is transient, backend ownership is not. A disconnected modern
    // host must retain its selected backend and all persisted card identities.
    if (extension) return "generic";
    if (legacy().channel) return "legacy";
    return undefined;
  }
  function isReady() {
    return active && (extension ? extension.isReady() : Boolean(legacy().channel));
  }
  function validate(request) {
    const match = TRACK.exec(request.outTrackId ?? "");
    if (!active || !match || request.accountId !== config.accountId ||
        request.ownerUserId !== config.ownerUserId) {
      throw new Error("卡片账号或服务状态不匹配。");
    }
    return match[1];
  }
  async function deliver(request, update) {
    const cardId = validate(request);
    const selected = request.transport ?? mode();
    if (selected === "generic") {
      if (!extension) throw new Error("当前宿主不支持新版钉钉卡片接口。");
      const variables = Object.fromEntries(Object.entries(request.data).map(([key, value]) =>
        [key, typeof value === "string" ? value : JSON.stringify(value)]));
      return update
        ? extension.updateCard({ cardId, variables })
        : extension.sendCard({ cardId, userId: request.ownerUserId,
            templateId: request.templateId, variables });
    }
    if (selected !== "legacy" || !legacy().channel) {
      throw new Error("钉钉卡片接口尚未就绪，请检查社区插件版本和连接状态。");
    }
    // Never retry through the other backend: a failed request may have been delivered.
    const { transport: _, ...input } = request;
    return legacy().channel[update ? "updateCard" : "sendCard"](input);
  }
  return {
    mode,
    isReady,
    sendCard: (request) => deliver(request, false),
    updateCard: (request) => deliver(request, true),
    start() {
      if (active) throw new Error("卡片适配已启动。");
      const state = legacy();
      if (state.assistants.has(config.accountId)) throw new Error("同一账号已有助手卡片处理器。");
      registration = { handle: (input) => {
        if (!active || input.accountId !== config.accountId || input.userId !== config.ownerUserId) return false;
        return handle({ ...input, transport: "legacy" });
      } };
      state.assistants.set(config.accountId, registration);
      active = true;
    },
    stop() {
      active = false;
      if (legacy().assistants.get(config.accountId) === registration) {
        legacy().assistants.delete(config.accountId);
      }
    },
  };
}
