// A late normal update must never overwrite a later expiry/retirement update.
// Keep the lane occupied until the underlying transport settles, even on failure.
export function createCardUpdateQueue() {
  const lanes = new Map();
  return {
    run(track, operation) {
      const result = (lanes.get(track) ?? Promise.resolve()).then(operation);
      const settled = result.catch(() => {});
      lanes.set(track, settled);
      settled.finally(() => { if (lanes.get(track) === settled) lanes.delete(track); });
      return result;
    },
  };
}
