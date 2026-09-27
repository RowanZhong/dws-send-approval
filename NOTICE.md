# 来源与维护边界

本项目从已有的 `examples/dws-send-approval` 抽离。两版业务源码相同，抽离来源提交见 `compat/manifest.json`。插件 ID、配置键、员工状态目录和 SQLite 格式保持兼容。

基于 **OpenClaw DingTalk Channel Plugin**，**YM Shen and contributors**，<https://github.com/soimy/openclaw-channel-dingtalk>。原有 MIT 版权与许可保留在 `LICENSE`。

`vendor/dingtalk-card-extensions.mjs` 是上游 PR #630 的轻量公开入口构建产物，包含注册表客户端，不包含 Channel、鉴权、HTTP 或 Stream 实现。来源提交和 SHA-256 见 `compat/manifest.json`，许可见 `vendor/LICENSE.dingtalk`。随包携带它是为了支持 OpenClaw 各插件隔离安装时的模块解析，不要求员工安装第二份 Channel。

`compat/new-channel/card-extensions.patch` 仅包含同一 PR 的运行接口和构建/打包支持。它不包含助手业务、卡片模板、文件大小或问卷容量增强。新版优先使用上游已提供该 API 的兼容发行版；合并前应用此补丁，合并后删除过渡步骤。旧宿主继续使用原兼容分支，不在本仓库复制或维护完整社区插件。
