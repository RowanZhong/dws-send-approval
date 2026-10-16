// src/card/card-extension-api.ts
import { registerPluginInteractiveHandler } from "openclaw/plugin-sdk/plugin-runtime";

// src/card/card-extension-runtime.ts
import { getChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
var CARD_EXTENSION_CAPABILITY = "dingtalk.card-extensions.transport.v1";
function getCardExtensionTransport(channelRuntime, accountId) {
  const context = getChannelRuntimeContext({
    channelRuntime,
    channelId: "dingtalk",
    accountId,
    capability: CARD_EXTENSION_CAPABILITY
  });
  if (!context || typeof context !== "object") {
    return void 0;
  }
  const candidate = context;
  return typeof candidate.isConnected === "function" && typeof candidate.send === "function" && typeof candidate.update === "function" ? candidate : void 0;
}
function cardExtensionNamespace(accountId, namespace) {
  return `ocx1.${accountId}.${namespace}`;
}

// src/card/card-extension-types.ts
var DingTalkCardExtensionError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "DingTalkCardExtensionError";
  }
};

// src/card/card-extension-api.ts
function validateString(value, pattern, field) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new DingTalkCardExtensionError("invalid-argument", `Invalid ${field}`);
  }
}
function copyVariables(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DingTalkCardExtensionError("invalid-argument", "variables must be a string map");
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 256 || entries.some(([key, item]) => !key || key.length > 128 || typeof item !== "string")) {
    throw new DingTalkCardExtensionError("invalid-argument", "Invalid card variables");
  }
  const copy = Object.fromEntries(entries);
  if (JSON.stringify(copy).length > 256 * 1024) {
    throw new DingTalkCardExtensionError(
      "invalid-argument",
      "Card variables exceed 256 KiB character limit"
    );
  }
  return copy;
}
function registerDingTalkCardExtension(api, options) {
  validateString(options?.accountId, /^[a-zA-Z0-9_-]{1,64}$/, "accountId");
  validateString(options?.namespace, /^[a-z][a-z0-9-]{0,31}$/, "namespace");
  if (typeof options.onAction !== "function") {
    throw new DingTalkCardExtensionError("invalid-argument", "onAction must be a function");
  }
  if (!api?.id || !api.runtime?.channel?.runtimeContexts) {
    throw new DingTalkCardExtensionError("unavailable", "OpenClaw channel runtime is required");
  }
  const { accountId, namespace, onAction } = options;
  const channelRuntime = api.runtime.channel;
  const registration = registerPluginInteractiveHandler(
    api.id,
    {
      channel: "dingtalk",
      namespace: cardExtensionNamespace(accountId, namespace),
      async handler(value) {
        if (!value || typeof value !== "object") {
          return;
        }
        const action = value;
        if (action.accountId !== accountId || action.namespace !== namespace) {
          return;
        }
        await onAction({
          cardId: action.cardId,
          userId: action.userId,
          actionIds: action.actionIds,
          form: action.form,
          ...action.callbackId ? { callbackId: action.callbackId } : {}
        });
      }
    },
    { pluginName: api.name, pluginRoot: api.rootDir }
  );
  if (!registration.ok) {
    throw new DingTalkCardExtensionError(
      "namespace-conflict",
      "Card extension namespace already registered for this account"
    );
  }
  const getTransport = () => {
    const transport = getCardExtensionTransport(channelRuntime, accountId);
    if (!transport) {
      throw new DingTalkCardExtensionError("unavailable", "DingTalk card transport is unavailable");
    }
    if (!transport.isConnected()) {
      throw new DingTalkCardExtensionError("not-connected", "DingTalk account disconnected");
    }
    return transport;
  };
  const trackId = (cardId) => {
    validateString(cardId, /^[a-zA-Z0-9_-]{1,64}$/, "cardId");
    const value = `ocx1.${accountId}.${namespace}.${cardId}`;
    if (value.length > 128) {
      throw new DingTalkCardExtensionError(
        "invalid-argument",
        "Composed outTrackId exceeds 128 characters"
      );
    }
    return value;
  };
  return {
    isReady: () => getCardExtensionTransport(channelRuntime, accountId)?.isConnected() === true,
    async sendCard(input) {
      const outTrackId = trackId(input?.cardId);
      validateString(input.templateId, /^[a-zA-Z0-9._-]{1,128}$/, "templateId");
      validateString(input.userId, /^[a-zA-Z0-9._@-]{1,128}$/, "userId");
      const variables = copyVariables(input.variables);
      await getTransport().send({
        cardId: input.cardId,
        templateId: input.templateId,
        userId: input.userId,
        variables,
        outTrackId
      });
    },
    async updateCard(input) {
      const outTrackId = trackId(input?.cardId);
      const variables = copyVariables(input.variables);
      await getTransport().update({ cardId: input.cardId, variables, outTrackId });
    }
  };
}
export {
  DingTalkCardExtensionError,
  registerDingTalkCardExtension
};
