import { runDws } from "./assistant-dws.mjs";
import { stableId } from "./preferences.mjs";

export function messageTime(value) {
  if (typeof value === "number") return value < 100000000000 ? value * 1000 : value;
  if (typeof value !== "string") return NaN;
  // DWS's DingTalk wall-clock representation is Beijing time, not the host TZ.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return Date.parse(value.replace(" ", "T") + "+08:00");
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
}
function historyText(message) {
  // DWS may flatten rich messages and omit their original type. Only use the
  // returned text; never resolve embedded resources, links or attachments.
  if (message.quotedMessage || message.forwarded || message.resourceRefs?.length) return { media: true };
  const kind = message.messageType ?? message.msgType;
  if (kind !== undefined && kind !== null && kind !== "") {
    const type = String(kind).toLowerCase().replace(/[_-]/g, "");
    if (["image", "picture", "audio", "voice", "video", "file", "attachment", "card", "interactivecard"].includes(type)) return { media: true };
    if (!["text", "plaintext", "markdown", "richtext"].includes(type)) return { unknown: true };
  }
  const text = message.text
    .replace(/!\[[^\]\n]*\]\([^\n)]*\)/g, "")
    .replace(/\[(?:图片|语音|音频|视频|文件|附件|表情包)(?:消息)?\](?:\([^\n)]*\))?/g, "")
    .replace(/\[[^\]\n]*\]\((?:mediaId|fileId|resourceId|spaceId|dentryId)=[^\n)]*\)/gi, "")
    .replace(/\((?:mediaId|fileId|resourceId|spaceId|dentryId)=[^\n)]*\)/gi, "")
    .replace(/^[ \t]*(?:mediaId|fileId|resourceId|spaceId|dentryId)\s*[:=].*$/gim, "")
    .trim();
  return { text, projected: !kind || !["text", "plaintext"].includes(String(kind).toLowerCase()), media: text !== message.text.trim() };
}
export function selectContext(envelope, config, draft, start, end) {
  if (envelope?.contractVersion !== "im.message-list.v1" || !Array.isArray(envelope.messages)) throw Error("HISTORY_CONTRACT");
  const parties = new Set([draft.event.sender_open_dingtalk_id, config.ownerUserId, config.ownerOpenId].filter(Boolean));
  const rows = new Map(); let skippedUnknown = 0, filteredMedia = 0, textProjection = false, ownerLastMessageAt = 0;
  for (const m of envelope.messages) {
    const time = messageTime(m.createTime);
    if (m.conversationId !== draft.event.conversation_id || !parties.has(m.senderId) || !stableId(m.messageId) ||
      !Number.isFinite(time) || time < start || time >= end || typeof m.text !== "string" || !m.text.trim()) continue;
    if (m.senderId === config.ownerUserId || m.senderId === config.ownerOpenId) ownerLastMessageAt = Math.max(ownerLastMessageAt, time);
    const body = historyText(m);
    if (body.unknown) { skippedUnknown++; continue; }
    if (body.media) filteredMedia++;
    if (!body.text) continue;
    textProjection ||= body.projected;
    rows.set(m.messageId, { id: m.messageId, time, sender: m.senderId === config.ownerUserId || m.senderId === config.ownerOpenId ? "owner" : "sender", message: body.text });
  }
  // The admitted trigger is already supplied as externalMessage; do not repeat it.
  for (const id of draft.batch?.messageIds ?? [draft.event.message_id]) rows.delete(id);
  let messages = [...rows.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  let truncated = Boolean(envelope.truncated) || messages.length > 50;
  messages = messages.slice(-50); let remaining = 12000;
  messages = messages.toReversed().flatMap((m) => {
    if (remaining <= 0) { truncated = true; return []; }
    const message = m.message.slice(0, remaining);
    if (message.length < m.message.length) truncated = true;
    remaining -= message.length;
    return [{ ...m, message }];
  }).toReversed();
  const complete = envelope.complete === true && !envelope.partial && !envelope.failedCount && !envelope.hasMore && !truncated && !skippedUnknown && Boolean(config.ownerOpenId);
  return { messages, messageCount: messages.length, start, end, complete, partial: !complete, truncated, skippedUnknown, filteredMedia,
    textProjection, attachmentsRead: false, ownerLastMessageAt,
    ...(skippedUnknown ? { reason: "unsupported_message_type" } : !config.ownerOpenId ? { reason: "owner_identity_unavailable" } : {}) };
}
export function createContextReader(config, { runner = runDws, now = Date.now } = {}) {
  const cache = new Map(); let queue = Promise.resolve();
  const read = async (draft, { end: suppliedEnd, fresh = false } = {}) => {
    const end = suppliedEnd ?? messageTime(draft.event.timestamp) + 1;
    const start = end - config.assistant.context.historyMinutes * 60000;
    if (!config.assistant.context.historyMinutes) return { messages: [], start: end, end, complete: true, partial: false, truncated: false, disabled: true };
    if (!Number.isFinite(end) || !stableId(draft.event.conversation_id)) return { messages: [], complete: false, partial: true, reason: "invalid_window" };
    const key = JSON.stringify([config.profile, config.accountId, draft.event.conversation_id, start, end]);
    let entry = cache.get(key);
    if (fresh || !entry || now() - entry.at > 30000 || now() < entry.at) {
      try {
        const envelope = await runner(config, ["chat", "+chat-messages", "--group", draft.event.conversation_id,
          "--start", new Date(start).toISOString(), "--end", new Date(end).toISOString(), "--order", "desc",
          "--page-all", "--page-limit", "3", "--max-items", "150", "--limit", "50", "--no-reactions", "--format", "json"]);
        entry = { at: now(), envelope };
        if (envelope?.contractVersion !== "im.message-list.v1") throw Error("contract");
        cache.set(key, entry);
        while (cache.size > 128) cache.delete(cache.keys().next().value);
      } catch { return { messages: [], start, end, complete: false, partial: true, truncated: false, reason: "history_unavailable" }; }
    }
    try { return selectContext(entry.envelope, config, draft, start, end); }
    catch { return { messages: [], start, end, complete: false, partial: true, truncated: false, reason: "invalid_history" }; }
  };
  return {
    read(draft, options) { const task = queue.then(() => read(draft, options)); queue = task.catch(() => {}); return task; },
    clear() { cache.clear(); },
  };
}
