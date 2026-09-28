// Presentation only: old preference, authorization and topic keys remain intact.
export function fixedReplyRows(prefs, settings) {
  const rows = [];
  const addPreference = (rule, scope, id = "") => {
    if (rule.mode === "fixed") rows.push({ key: `preference:${scope}:${id}`, source: "preference", scope,
      target: id, text: rule.text, delivery: "confirm", keywords: [] });
  };
  addPreference(prefs.reply.default, "default");
  for (const r of prefs.reply.users) addPreference(r, "user", r.id);
  for (const r of prefs.reply.groups) addPreference(r, "group", r.id);
  for (const r of settings.fixedRules ?? []) rows.push({ ...r, key: `confirm:${r.id}`, source: "confirm", delivery: "confirm" });
  for (const r of settings.autoRules) rows.push({ ...r, key: `auto:${r.id}`, source: "auto", delivery: "auto" });
  for (const r of settings.topics.rules.filter((r) => r.action !== "inbox")) rows.push({ ...r,
    key: `topic:${r.id}`, source: "topic", delivery: r.action, target: r.targets.join("、"), keywords: [] });
  return rows;
}
