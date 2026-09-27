# DWS Send Approval

Independent OpenClaw plugin. One source tree supports OpenClaw 2026.7.1-2 and 2026.8.1.

- Run `npm ci`, `npm run check`, `npm test`, `npm run docs:build`, `npm run pack:check`.
- Run `npm run test:hosts -- <installed-host-directory> ...` for actual SDK compatibility.
- Keep plugin ID, persisted state paths and schema backward compatible.
- Modern DingTalk cards use the generic public interface; legacy hosts retain the existing channel bridge. Never retry a failed send on another backend.
- Keep upstream transition patches in `compat/`; pin commits and checksums. Do not copy full channel implementations into this project.
- Do not change existing channel repositories or user runtime configuration as a side effect of builds or tests.
- Keep credentials, real employee configuration, databases and live-test artifacts out of packages and Git.
- Technical docs: `docs/contributor/`; employee docs: `docs/user/`; designs and execution records: `docs/plans/`.
- Regenerate HTML from Markdown with `npm run docs:build` after documentation edits.
- Real-device validation must confirm visible cards and callbacks, then restore temporary config and state. Do not claim historical tests are new validation.

The DingTalk interface client and compatibility patch derive from OpenClaw DingTalk Channel Plugin, YM Shen and contributors: https://github.com/soimy/openclaw-channel-dingtalk. Preserve MIT notices in `NOTICE.md` and `vendor/`.
