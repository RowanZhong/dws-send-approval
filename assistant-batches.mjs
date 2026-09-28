import { messageTime } from "./assistant-context.mjs";
export function batchKey(config, event) {
  return JSON.stringify([config.profile, config.accountId, event.conversation_id, event.sender_open_dingtalk_id]);
}
export function batchMembers(store, draft) {
  return (draft.batch?.memberIds ?? [draft.id]).map((id) => store.draft(id)).filter(Boolean)
    .sort((a, b) => messageTime(a.event.timestamp) - messageTime(b.event.timestamp) || a.id - b.id);
}
export function batchContent(store, draft) {
  const members = batchMembers(store, draft);
  return members.length <= 1 ? draft.event.content : members.map((d) => d.event.content).join("\n\n");
}
export function nextBatch(config, previous, draft, now) {
  const before = previous?.batch;
  const time = messageTime(draft.event.timestamp);
  const lastTime = previous && messageTime(previous.event.timestamp);
  const merge = previous && !before?.closed && ["generating", "classifying", "pending", "inbox", "draft-error", "stale"].includes(previous.status) &&
    previous.expires > now && now - (before?.lastReceivedAt ?? previous.created) <= config.assistant.directBatch.mergeGapSeconds * 1000 &&
    now - (before?.startedAt ?? previous.created) < 300000 && time >= lastTime &&
    time - lastTime <= config.assistant.directBatch.mergeGapSeconds * 1000 && (before?.memberIds.length ?? 1) < 200;
  return { id: merge ? before?.id ?? previous.id : draft.id, revision: merge ? (before?.revision ?? 1) + 1 : 1,
    startedAt: merge ? before?.startedAt ?? previous.created : now, lastReceivedAt: now,
    memberIds: [...(merge ? before?.memberIds ?? [previous.id] : []), draft.id],
    messageIds: [...(merge ? before?.messageIds ?? [previous.event.message_id] : []), draft.event.message_id] };
}
// A single active job per participant; new snapshots wait for the old job to settle.
export function createBatchQueue({ now = Date.now, quietMs = 2000, waitMs = 10000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const lanes = new Map(); let stopped = false;
  const settle = (lane) => { if (!lane.active && !lane.work) { lane.waiters.splice(0).forEach((f) => f()); lanes.delete(lane.key); } };
  const pump = (lane) => {
    if (stopped || lane.active || !lane.work || !lane.due) return;
    const work = lane.work; lane.work = undefined; lane.first = undefined; lane.due = false; lane.active = true;
    Promise.resolve().then(work).catch(() => {}).finally(() => { lane.active = false; pump(lane); settle(lane); });
  };
  return {
    schedule(key, work) {
      if (stopped) return Promise.resolve();
      let lane = lanes.get(key);
      if (!lane) { lane = { key, waiters: [], active: false }; lanes.set(key, lane); }
      lane.first ??= now(); lane.work = work; lane.due = false;
      if (lane.timer) clearTimer(lane.timer);
      const delay = Math.max(0, Math.min(quietMs, lane.first + waitMs - now()));
      const result = new Promise((resolve) => lane.waiters.push(resolve));
      if (delay === 0) { lane.due = true; pump(lane); }
      else lane.timer = setTimer(() => { lane.timer = undefined; lane.due = true; pump(lane); }, delay);
      return result;
    },
    stop() { stopped = true; for (const lane of lanes.values()) { if (lane.timer) clearTimer(lane.timer); lane.work = undefined; settle(lane); } },
  };
}
