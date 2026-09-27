import { registerDingTalkCardExtension } from "./vendor/dingtalk-card-extensions.mjs";
import { bridge } from "./assistant-bridge.mjs";

export const CARD_NAMESPACE = "dws-send-approval";
const TRACK = /^dws-assistant-([a-f0-9-]{36})$/;

// Keep persisted logical card IDs stable across the old bridge and the public API.
// The public provider owns the wire outTrackId; only this adapter translates it.
export function createCardTransport(config, handle, dependencies = {}) {
  const register = dependencies.register ?? registerDingTalkCardExtension;
  const legacy = dependencies.legacy ?? bridge;
  let extension, registration, active = false;
  function mode() {
    if (!active) return undefined;
    if (extension.getStatus() !== "unavailable") return "generic";
    if (legacy().channel) return "legacy";
    return undefined;
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
    sendCard: (request) => deliver(request, false),
    updateCard: (request) => deliver(request, true),
    start() {
      if (active) throw new Error("卡片适配已启动。");
      const state = legacy();
      if (state.assistants.has(config.accountId)) throw new Error("同一账号已有助手卡片处理器。");
      extension = register({ accountId: config.accountId, namespace: CARD_NAMESPACE,
        onAction(action) {
          if (!active || action.accountId !== config.accountId || action.userId !== config.ownerUserId ||
              action.namespace !== CARD_NAMESPACE || action.actionIds.length !== 1 ||
              !TRACK.test(`dws-assistant-${action.cardId}`)) return;
          return handle({ accountId: action.accountId, userId: action.userId,
            outTrackId: `dws-assistant-${action.cardId}`, actionId: action.actionIds[0],
            values: action.form, transport: "generic" });
        },
      });
      registration = { handle: (input) => {
        if (!active || input.accountId !== config.accountId || input.userId !== config.ownerUserId) return false;
        return handle({ ...input, transport: "legacy" });
      } };
      state.assistants.set(config.accountId, registration);
      active = true;
    },
    stop() {
      active = false;
      extension?.dispose();
      if (legacy().assistants.get(config.accountId) === registration) {
        legacy().assistants.delete(config.accountId);
      }
    },
  };
}
