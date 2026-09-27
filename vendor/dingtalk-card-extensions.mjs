// src/card/card-extension-types.ts
var DingTalkCardExtensionError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "DingTalkCardExtensionError";
  }
};

// src/card/card-extension-registry.ts
var REGISTRY_KEY = /* @__PURE__ */ Symbol.for("openclaw.dingtalk.card-extensions");
function getCardExtensionRegistry() {
  const globals = globalThis;
  const existing = globals[REGISTRY_KEY];
  if (existing && existing.version !== 1) {
    throw new DingTalkCardExtensionError(
      "version-mismatch",
      "Incompatible DingTalk card extension API"
    );
  }
  return globals[REGISTRY_KEY] ??= {
    version: 1,
    registrations: /* @__PURE__ */ new Map(),
    transports: /* @__PURE__ */ new Map()
  };
}
function cardExtensionKey(accountId, namespace) {
  return `${accountId}.${namespace}`;
}
function getCardExtensionStatus(accountId) {
  const registry = getCardExtensionRegistry();
  if (!registry.accountStatus) {
    return "unavailable";
  }
  const status = registry.accountStatus(accountId);
  if (status !== "configured") {
    return status;
  }
  return registry.transports.get(accountId)?.isConnected() ? "ready" : "not-connected";
}

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
function registerDingTalkCardExtension(options) {
  validateString(options?.accountId, /^[a-zA-Z0-9_-]{1,64}$/, "accountId");
  validateString(options?.namespace, /^[a-z][a-z0-9-]{0,31}$/, "namespace");
  if (typeof options.onAction !== "function") {
    throw new DingTalkCardExtensionError("invalid-argument", "onAction must be a function");
  }
  const registration = { ...options };
  const { accountId, namespace } = registration;
  const registry = getCardExtensionRegistry();
  const key = cardExtensionKey(accountId, namespace);
  if (registry.registrations.has(key)) {
    throw new DingTalkCardExtensionError(
      "namespace-conflict",
      "Card extension namespace already registered for this account"
    );
  }
  registry.registrations.set(key, registration);
  let disposed = false;
  const getStatus = () => disposed ? "disposed" : getCardExtensionStatus(accountId);
  const getTransport = () => {
    const status = getStatus();
    if (status !== "ready") {
      throw new DingTalkCardExtensionError(status, `DingTalk card extension is ${status}`);
    }
    return registry.transports.get(accountId);
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
    getStatus,
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
      return { outTrackId };
    },
    async updateCard(input) {
      const outTrackId = trackId(input?.cardId);
      const variables = copyVariables(input.variables);
      await getTransport().update({ cardId: input.cardId, variables, outTrackId });
      return { outTrackId };
    },
    dispose() {
      disposed = true;
      if (registry.registrations.get(key) === registration) {
        registry.registrations.delete(key);
      }
    }
  };
}
export {
  DingTalkCardExtensionError,
  registerDingTalkCardExtension
};
