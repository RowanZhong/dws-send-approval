# DWS Reply Assistant

独立维护的钉钉个人代回复助手。员工在自己的机器人私聊中选择监听范围、查看 AI 草稿、修改或批准回复，并为重复问题设置固定答复及主题规则。默认不开启监听，AI 生成正文需本人确认。

**插件版本 0.9.0，包含公司统一 DWS 授权应用策略与存量数据迁移；双版必要真机验收已完成，部署请同时记录实际 Git 提交。** · OpenClaw **2026.7.1-2 / 2026.8.1** · DWS **1.0.58** · Linux/macOS。

- [开发人员：技术方案与安装配置](docs/contributor/dws-reply-assistant-deployment.html)
- [员工：使用手册与场景指引](docs/user/dws-reply-assistant-manual.html)
- [本轮开发与验收执行记录](docs/plans/2026-09-28-development-record.md)
- [公司授权应用迁移与验收记录](docs/plans/2026-09-29-company-app-migration.md)
- [受限 Agent 起草配置](docs/contributor/read-only-drafting.md)
- [抽离设计及验收](docs/plans/standalone-extraction.md)
- [依赖来源与许可证](NOTICE.md)

## 两版共用一套助手

| 宿主 | Channel 维护方式 | 卡片接口 |
| --- | --- | --- |
| 2026.8.1 | 原作者仓库；通用接口合并前仅维护最小补丁 | 上游 PR [#630](https://github.com/soimy/openclaw-channel-dingtalk/pull/630) 的公开接口 |
| 2026.7.1-2 | 继续维护原本的社区插件兼容分支 | 原有桥接 |

新版基线、补丁与公开接口客户端均有固定提交和校验值，见 `compat/manifest.json`。不会在本项目维护完整社区插件。文件大小、问卷人数和问卷超时增强不属于助手依赖，不放入新版过渡补丁。

## 开发与打包

```bash
npm ci
npm run check
npm test
npm run docs:build
npm run pack:local
npm run pack:check
```

包在 `artifacts/dws-send-approval-0.9.0.tgz`。安装：`openclaw plugins install <包路径>`；升级、Channel 最小补丁准备及 Kubernetes 配置见开发文档。`npm run test:hosts -- <旧版宿主包目录> <新版宿主包目录>` 可在隔离临时目录验证两版 SDK 和实际宿主行为。

## 迁移保持什么

插件 ID、已有配置键、员工状态目录和持久化业务数据保持兼容。新版富文本模板须单独发布并显式启用展示版本 3；旧卡停用后提供恢复入口，不维持旧卡全部交互。旧 `examples/dws-send-approval` 的加载路径替换为本目录，不能重复加载两份。切换卡片接口后旧操作卡停用，重新 `/dws` 即可；草稿、偏好、授权和发送历史保留，不自动开启监听或重发消息。

上游接口客户端随包包含，业务卡片和状态仍由本项目负责。自动回复绕行的全局安全治理不属于本项目，也不依赖 Agent Aegis 才能运行。

0.9.0 的公司授权策略需由管理员显式配置，未配置时保留原身份校验行为。切换到公司统一 DWS 应用时，助手先核实原绑定和规则目标并备份，再迁移；原自动授权暂停，旧未完成草稿保留为只读，员工需重新授权自动回复。具体配置、员工提示和灰度部署见安装指南。

基于 OpenClaw DingTalk Channel Plugin，YM Shen and contributors，<https://github.com/soimy/openclaw-channel-dingtalk>。MIT，保留原版权与许可。
