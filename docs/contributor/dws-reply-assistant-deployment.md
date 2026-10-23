# 钉钉个人代回复助手 · 技术方案与安装配置

**开发及运维指南 · 插件 0.9.2 · 更新于 2026-10-23 · 公司授权监听适配与完整部署说明**

面向开发人员和平台管理员。员工操作另见[员工使用手册](../user/dws-reply-assistant-manual.html)。适用一名员工一个 Pod、独立 OpenClaw 实例；兼容验证覆盖 OpenClaw 2026.7.1-2 与 2026.8.1。

## 1. 整体方案与定向控制原理

这套方案为每名员工的独立 OpenClaw 实例增加一条**受控的个人消息处理流程** ：DWS 用员工已登录的身份接收消息，自定义插件按员工设置筛选来源、识别消息主题、生成草稿并管理授权，社区钉钉插件负责投递卡片和接收本人操作。员工可以确认后发送，也可以提前授权有范围、有期限的固定答复。平台统一部署代码和配置模板，员工自己的身份、监听偏好与状态保留在各自 Pod 的持久化目录中。

核心做法是**把来信内容与可执行权限分开** 。当前默认的助手模式调用宿主的无工具文本生成接口起草回复；显式开启工具时，使用经过权限核验的专用只读 Agent。拟稿输入限定为本条或当前批次来信、同一会话的有限上下文、写作要求和本人为本条补充的资料；专用 Agent 还可查询允许范围内的资料。模型生成的文字不能直接执行命令或更换接收人；只有插件中的发送器能把经过授权的完整正文发回绑定的来源会话。

### 一条消息如何走到发送

1. **接入与筛选。** 从后台自动发现并校验的 DWS profile 接收事件，先排除本人及审批机器人，再检查监听开关、私聊/群 @本人/额外发送者规则，按业务消息去重；未命中范围的来信不进入助手。
2. **主题、草稿与自动答复。** 启用主题后，在已允许来源内按语义判断同类问题；所有未明确命中情况按员工选择走普通方式（含有效自动授权）或一律过滤。普通消息生成待确认草稿；命中本人预授权规则时，只逐字使用已授权固定正文，并检查期限与频率。模型生成内容不进入免确认自动发送路径。
3. **本人确认。** 卡片回调使用社区插件提供的可信用户 ID，核对本人、账号、卡片、令牌、到期时间和草稿版本。页面上显示的接收对象和正文必须与即将发送的版本一致。
4. **定向发送。** 发送器再次核对监听范围、暂停状态及偏好版本，再用固定 DWS 可执行路径和参数发送；接收目标来自保存的事件，不接受模型或表单另行指定。先记录发送中状态，再执行请求，结果不明时不自动重试。

### 为什么正常主会话不会被一律拦截

当前助手模式的来信走上述专用流程，员工自己在钉钉机器人或 Web 中发起的日常请求仍走原来的主会话。保留的 `before_tool_call` 钩子为旧版监听 Agent 路径提供额外控制；它先判断**宿主工具上下文中的 `sessionKey`** ，再判断命令，而不是扫描所有用户消息或全局禁用 DWS 发信。

旧路径在派发任务之前，先把事件对应的专用会话登记到 `sources.json`：会话键形如 `agent:<agentId>:dws-listener:<hash>`，hash 来自已绑定 profile 与事件 ID；登记记录也绑定 profile。钩子核对宿主传来的完整会话键、agentId 和登记记录。消息正文中自称“本人发起”“来自 Web”，或者包含同样的字符串，都不能替代这些宿主字段。

| 实际来源与动作 | 插件处理 | 对正常使用的影响 |
| --- | --- | --- |
| 本人在钉钉或 Web 主会话请求发消息；宿主提供正常会话键 | 来源判为 ordinary，钩子直接返回 | 不额外增加本插件审批；仍受 OpenClaw 原有权限约束 |
| DWS 事件进入助手模式 | 范围过滤 → 可选主题判类 → 无工具/受限 Agent 拟稿或固定正文 → 本人确认或固定正文预授权 → 固定发送器 | 仅处理员工选择的消息范围；AI 正文始终由本人确认 |
| 已登记的旧监听专用会话调用 `dws chat message send` 或 `dws chat +messages-send` | 按 block / approval 配置阻断或要求单次审批；有无 `--yes` 都检查 | 同一条发信命令在监听来源中受控，不因此限制已识别的普通主会话 |
| 会话键缺失，或使用监听标记但登记、profile、agentId 无法核实 | 对匹配的 DWS 发送拒绝执行；跨会话转交/延迟任务也拒绝 | 保守拒绝来源不明的操作，应修复上下文传递，不能假装来源可信 |

**“定向”有明确前提，不是绝对零误拦的承诺。** 正常主会话必须由宿主正确提供会话键，且不使用保留的监听标记；来源缺失时，对匹配的 DWS 发信及任务转交采取保守拒绝。旧路径的命令检测只覆盖指定 DWS 发信形式，不是任意脚本、HTTP、其他工具或主 Agent 的全局安全沙箱。当前助手模式通过无工具拟稿和固定发送器缩小权限面；员工主动补充的敏感资料仍可能出现在草稿里，发送前应核对全文。

## 2. 技术架构与边界

<div id="architecture"></div>

```text
DWS 认证事件 → 范围过滤、业务消息去重 → 持久化草稿/收件箱
                                      ├─ 已授权固定正文 → 确定性发送器
                                      └─ 无工具 / 专用只读 Agent 拟稿
                                           → 本人卡片确认 → 确定性发送器
钉钉社区插件 ← 通用接口 / 旧版桥接 → 独立助手插件 ← SQLite + 个人偏好
```

- **社区插件** 只新增卡片投递与 Stream 回调适配层。通过已有 Stream 连接传递回调的用户 ID、账号、卡片 ID，不从消息正文或表单字段推断身份。没有新增 HTTP 端口或第二条社区插件 Stream 连接。
- **独立助手插件** 负责个人偏好、监听、草稿、自动授权、通知和发送。从 0.8.0 起只维护一个项目、一个安装包；新版通过通用卡片接口接入，旧版通过既有桥接接入。业务逻辑无需同步到两个社区仓库。
- **AI 拟稿** 默认使用宿主 `runtime.llm.complete`，传入写作要求、当前来信或私聊批次（完整正文合计最多 8000 字符）、默认最近 5 分钟同会话的可用对话文字（最多 50 条、12000 字符；过滤可识别媒体，不读附件）及本条本人提供的资料。默认不启动 Agent；显式开启受限工具时按专用 Agent 策略运行，配置步骤见[第 3 节专用 Agent 部署](#draft-agent-setup)。不同会话上下文不混合，历史未发送草稿不作为已发事实。
- **确认校验** 绑定本人 staffId、社区账号、outTrackId、一次性按钮令牌、到期时间和草稿版本。接收会话只能来自可信 DWS 事件，表单不能更换接收人、DWS profile 或执行命令。本人以外点击、转发卡、旧版本、重复点击都会被拒绝。
- **发送器** 用固定可执行路径、绑定 profile 和 argv（`shell:false`）发送。私聊使用 `chat +messages-send --as user`；群消息使用 `chat +messages-reply`，绑定监听事件的 `--conversation-id`、`--message-id`、`--ref-sender`，并按已审阅正文生成稳定幂等键。人工发送、编辑后发送和固定自动回复共用该发送器。引用失败不回退普通群消息；无本地来源信息时保留待处理，网络或结果不明确时标为 unknown，禁止自动重发。`--yes` 只由授权后的代码添加。DWS 1.0.58 的 `im.message-reply.v1` 回执与普通发送格式不同，必须分别校验；引用回复不等同于独立话题写入。
- **重启恢复** 先把 sending 状态写入数据库，再发出请求。发送成功才记 sent；超时、断线或进程中断记 unknown，不自动重试，避免重复发信。卡片和草稿可恢复；结果不明时需本人核对钉钉实际记录。

**拟稿的 Agent 选择（0.6.1 修正）。** 插件在拟稿时读取宿主当前的已解析配置，使用宿主 SDK 解析 Agent 归属，而不只检查 Agent 数量或猜测 `main`。当配置的 `agentId` 与宿主默认归属一致时省略请求中的 `agentId`，避免把正常拟稿误判为跨 Agent 覆盖。SDK 按需加载，不加入 Gateway 启动等待链。

| 环境 | 默认归属解析 |
| --- | --- |
| 2026.7.1-2 | 首个 `default:true`；无标记时取列表首项；无 Agent 时按宿主隐式 main 规则 |
| 2026.8.1 | 优先 systemAgent，再按宿主的显式/兼容归属规则解析；支持 `agents.entries`。显式空列表、多个候选或 `ownership:explicit` 不伪装成唯一 main |
| 两版通用 | 使用 `runtime.config.current()` 的最新已解析配置，兼容 `$include` 展开；找不到指定 Agent 或未展开的配置时拒绝拟稿并给出诊断 |

**企业五 Agent 示例：** `main` 标记 `default:true`，另有 `mail/come/bpm/code`，插件配置 `agentId:"main"`，正常拟稿无需开放 `llm.allowAgentIdOverride`，无需删除其他 Agent，也无需改 `subagents.allowAgents`。后者约束子 Agent 运行，与本方案的无工具完成接口不同。真正指定非默认 Agent 时仍由宿主权限策略决定是否允许；无法确定归属时也不会自动换 Agent、换模型或退回有工具主会话。

权限不足、Agent 不存在及配置无法核实有不同的安全提示。日志只记录草稿编号和受限错误码，不记录来信、凭据或提供商原始错误。拟稿失败与仅整理记录可点「修改」手工填写回复，也可重新拟稿；手动发送仍校验本人、来源会话、正文长度、草稿版本、有效期、监听开关、暂停及平台禁发。发送结果未知不能用手动修改绕过防重复发送。

`/dws-reply preview` 使用宿主为当前命令绑定的无工具接口，仅试写、无发送；多 Agent 环境中预览成功不能替代后台监听拟稿验收，后台仍按上述插件 `agentId` 与宿主默认归属检查。

操作卡片的截止时间由独立字段 `card_expires_note` 投递，模板在按钮下方以右对齐的小号备注显示“卡片有效期至 MM/DD HH:mm”。它只控制卡片回调；监听设置持续生效，草稿和自动答复授权分别检查自己的到期时间。从不含备注组件的早期版本升级时，需新建普通卡片模板、导入并发布配套 JSON，再更新 `assistant.cardTemplateId`。0.8.0 抽离当时不需要再发模板；启用 0.9.0 配套富文本模板时，必须先导入模板、由平台编译发布并完成验证，再切换唯一模板 ID 与展示版本。已经使用该配套模板及展示版本 3 的实例，无须仅因本次版本号升级重新发布模板。

**即时提醒去重（0.6.1）。** 只把尚未成功提醒的草稿版本加入新通知；多条合并时保留本批消息范围，翻页或打开其中一条不会忘记其他已提醒项。成功投递/更新后才记录覆盖；新卡投递结果未知时持久化预留且禁止自动换卡重发，仅原卡更新失败可退避补刷；状态有上限，不新增进程或轮询。重启后原卡有效则不重复推送；过期卡允许重新提醒，设置为定时汇总时仍按员工选择汇总待办。原卡主动重新拟稿会更新其版本记录，不再另弹同条通知。编辑中的页面继续保留。

等待用户确认只保存状态，不占 main 执行 lane；无工具拟稿有自己的串行队列，单次最长 30 秒。可选专用 Agent 起草使用独立执行通道，默认等待预算 120 秒。DWS 调用最长 20 秒，卡片 API 请求最长 15 秒。Stream 回调接收后异步处理，避免模型请求占住回调确认。

这不表示完全没有同步工作：SQLite 的短事务是同步执行，CPU、磁盘、内存、模型额度仍与主实例共享。命令注册和后台服务通过完整配置指纹绑定，兼容宿主的运行时预热重新注册。持久化不可用、队列超限等情况会停止监听接入，不静默丢弃后继续自动发送。修复问题后由员工重新开启；若状态要求重启，按日志处理。

旧的 `before_tool_call` 来源保护仍保留：对已登记的监听专用会话执行发送控制，对来源缺失或疑似监听但无法核实的会话保守拒绝；匹配的命令为 `dws chat message send` 与 `dws chat +messages-send`。旧兼容执行路径明确指定 `lane: dws-send-approval`。`assistant.enabled:false` 才回到旧方案；旧方案的两命令拦截不能覆盖任意脚本、HTTP 或其他外发工具，不能当作整个主 Agent 的数据隔离沙箱。


### 消息主题与固定说明

“监听范围 → 消息主题”是来源之后的筛选层。私聊、群 @本人、额外发送者三组取并集；主题不能把未获来源授权的消息纳入。默认关闭，员工卡片设置保存在 PVC 上既有 SQLite 的 settings 中，不改 `openclaw.json`，不增加环境变量、必填字段或 DWS 常驻进程。

```text
可信来源与员工开关 → 回复/暂停规则 → 适用主题 → 无工具判类
                                             ├─ 唯一明确命中 → 执行该主题规则
                                             └─ 未明确命中 → 普通回复及有效授权 / 一律过滤
发送前再次核对身份、来源、版本、授权、限额与原会话
```

模型只能返回 `outcome/ruleIds/coversWholeMessage/reason`，不接收模型生成的收件人和发送正文。规则与模板来自员工保存的服务端状态，外来消息作为不可信数据。自动发送必须唯一匹配且整条问题可覆盖；排除、复合问题、多规则冲突、未知 ID、额外返回字段和解析失败均进入“未明确命中”分支。语义识别存在误判可能，这些约束不等于对任意恶意输入的数学保证；不让判类执行工具或读取私有资料，是独立于语义准确率的限制。

调用 `api.runtime.llm.complete`，沿用 0.6.1 的默认 Agent 解析，不启动 Agent 会话或占用 main lane。每实例判类并发 1，最多 32 个运行/排队请求，排队上限 30 秒、单次调用超时 15 秒，不自动重试。提供方忽略取消时，旧调用结束前不再启动新判类，后续按未明确命中策略处理。每条适用消息最多一次判类，明确未命中且沿用 AI 回复模式时可能再调用一次拟稿；模拟试判也占模型请求。主题关闭或该来源没有适用主题时不调用判类模型。Gateway 启动和关闭监听均不新增模型请求。

settings 仍为 version 1，可选 `topics:{enabled,mode,revision,rules}` 在读旧状态时填默认值，既有偏好不变。规则保存、停用、删除及主题模式变更递增独立 revision；仅修改提醒不会使判类失效。来源偏好与主题版本在模型返回后和发送前双重检查，设置中途变化不能继续自动发送。重启将 `classifying/generating` 恢复为 `draft-error` 并标记 `PROCESS_INTERRUPTED`，卡片显示“处理被中断”；已存在的旧 `topic-review` 记录仍可查看，不再为新判类结果生成第三态待判断记录。`sending` 恢复为 `unknown`，不自动重试发送。`filtered` 记录使用可配置终态保留策略（默认 7 天）。私聊按同一发送者批次合并；群消息仅替代同一会话同一发送者的旧待办。

主题动作支持自动固定模板、模板待确认、只整理。自动授权最长 7 天，到期仍匹配但转模板待确认；卡片提供的同一规则同一会话冷却最少 5 分钟，与普通自动规则共享每小时 30 条上限。明确命中主题时以主题规则为准；普通固定规则的正文冲突转为仅整理、由本人填写或起草，同正文但发送方式冲突转为待确认。“不处理”、暂停、只整理优先。群内发送沿用原消息引用发送路径。

主题配置复用动态 `form.fields`、最多 6 个按钮和有效期备注；每页不超过 4 个字段，六步向导最终确认读取服务端保存的摘要。自动授权必须至少完成一条正向试判；试判页面不发送、不扩大来源，不续期已有规则。富文本正文采用 v3 配套模板，Channel 接口、模板选择与安装要求以第 3 节为准。


## 3. 管理员安装、升级和卡片模板

### 独立项目与版本组合

从 0.8.0 起，助手在独立项目 `dws-send-approval` 中维护，同一个安装包适配两版宿主。不再向两个社区插件仓库复制业务源码。

当前安装包为 **0.9.2**，本次将所有事件消费命令固定为 `--stream-ticket-mode custom`，适配公司统一入口授权；无需新增插件配置项。沿用 0.9.1 的卡片排版和既有回复功能。0.9.0 新增的公司统一 DWS 授权应用策略、存量绑定迁移及中断恢复继续保留，配置见[公司统一授权应用切换](#company-app-migration)。升级包本身不会启用该策略，管理员需显式下发 `identityPolicy`；未配置时沿用原身份校验。公司应用迁移会暂停原自动授权、将旧未完成草稿保留为只读，员工需在迁移完成后重新授权自动回复。插件 ID、状态目录和原配置保持兼容，工具起草仍默认关闭。

| 宿主 | 社区钉钉插件来源 | 助手接入方式 |
| --- | --- | --- |
| OpenClaw 2026.8.1 | 原作者 `soimy/openclaw-channel-dingtalk`；通用接口未正式提供前，使用锁定基线加最小补丁 | `@soimy/dingtalk/card-extensions` 通用卡片接口 |
| OpenClaw 2026.7.1-2 | 继续维护 `RowanZhong/openclaw-channel-dingtalk` 的 `codex/dws-reply-assistant-2026.7.1-2` 兼容分支 | 原有助手卡片桥接 |

接口的上游 PR 是 [#630](https://github.com/soimy/openclaw-channel-dingtalk/pull/630)。不能把“已提交 PR”当成 npm 发行包已支持。过渡基线、接口提交和校验值保存在 `compat/manifest.json`；本次为基线 `8a73a59` 加接口提交 `3f7994e`。上游正式提供相同接口后，选择与宿主兼容的发行版，省去补丁步骤。

新版过渡补丁只提供通用卡片接口、Stream 分派和构建导出，不携带助手逻辑，也不携带 20 MiB、问卷 1000 人或 4320 分钟增强。助手功能不依赖这些增强。旧版兼容分支原有提交保持不动。

### 新版：生成隔离的最小补丁工作目录

在本项目根目录执行，目标目录必须不存在。脚本不会修改任何已有社区插件目录。

```bash
node scripts/prepare-channel.mjs ../dingtalk-card-api-2026.8.1
cd ../dingtalk-card-api-2026.8.1
pnpm install --frozen-lockfile
pnpm run build:runtime
pnpm run build:types
pnpm run pack:check
npm pack --ignore-scripts
```

然后用该实例的 `openclaw plugins install <社区插件包路径>` 安装。源码加载时把社区插件的 `plugins.load.paths` 改为新目录，并先构建 `dist/index.js`。同一个钉钉 Channel 只加载一份，不能同时保留新旧目录。脚本支持 `--source <本地上游克隆目录>`，仍然新建独立克隆，只读使用源仓库。

### 两版共用：安装独立助手包

开发环境使用 Node 24.15 或符合 `package.json` engines 的版本。依赖只用于开发与宿主兼容测试；运行时复用 OpenClaw SDK，通用接口客户端已包含在助手包中。

```bash
npm ci
npm test
npm run pack:local
npm run pack:check
openclaw plugins install ./artifacts/dws-send-approval-0.9.2.tgz
```

已有同名插件时按当前 OpenClaw 的本地插件更新流程替换代码。开发调试也可把 `plugins.load.paths` 中的旧 `examples/dws-send-approval` 路径替换为本独立目录；不要同时加载两份 `dws-send-approval`。插件条目仍叫 `dws-send-approval`，监听默认值仍为 `listener.enabled:false`。

首次部署先配置员工身份和卡片模板，暂关闭插件条目；安装完成后启用条目。已有员工的是否开启、范围、回复规则和主题授权从原状态恢复，部署不会代替员工更改选择。

### 从 0.9.0 / 0.9.1 升级到 0.9.2

1. 保留员工持久卷、DWS 登录态、现有 `assistant.cardTemplateId` 和 `assistant.cards.presentationVersion`，替换助手安装包。已经使用 v3 的实例必须保留 `presentationVersion:3`，不要用基础示例的 `2` 覆盖；本次没有新模板或数据结构迁移。
2. 正常滚动重启 Pod，使旧消费进程和 DWS bus 一并退出，按新参数重新创建。仅替换磁盘代码不会改变已运行的进程参数；不要让同一员工的新旧实例同时监听。
3. 核对实际运行命令包含 `--stream-ticket-mode custom`，并确认仍使用原 profile 和来源目标。该参数由插件生成，不是新增的 `openclaw.json` 配置字段，不应写入 `identityPolicy` 或 `listener` 对象。
4. 在公司环境核对新私聊和群 @本人是否实际进入待回复或处理记录。“连接就绪”只能说明消费程序报告 ready，不能单独证明事件投递成功。原有开关、范围、回复方式及自动授权按既有规则保存，本次代码升级不重新暂停授权。

0.9.1 起的 v3 排版继续保留：一个 `content_body` 展示状态、摘要、提示和分节正文，其他三槽清空；段内换行左对齐，小标题与正文适度留白。正文、原生表单及按钮协议保持兼容。展示版本 2 继续使用纯文本；首次从 v2 切换到 v3 才需要发布相应富文本模板。

**仅更新到 0.9.2 不等于再次切换 DWS 授权应用。** 已完成公司应用迁移的员工不需要为这个补丁重新登录或重新迁移；若公司同时更换 OAuth 应用，则另按[公司授权应用切换](#company-app-migration)处理，旧自动授权和旧草稿适用迁移保护。

### 从原来的 0.7.0 抽离版本迁移

1. 备份 OpenClaw 配置与该员工的整个状态目录/PVC；记录当前 Channel 分支和版本。维护窗口可先用 `/dws-listen off` 暂停，结束后由员工恢复。
2. 只替换助手加载路径或安装包，保留 `plugins.entries.dws-send-approval`、`ownerUserId`、`accountId`、`dwsPath`、模板 ID、模型授权及其他 Channel 配置。
3. 旧宿主继续加载原兼容 Channel。新宿主切换为上述上游基线加通用接口补丁，或已正式包含接口的兼容上游版本。
4. 保留同一 `stateDir`。`dws-send-approval/assistant.sqlite`、偏好、身份缓存和来源记录继续使用，不需要导出再导入。
5. 重启后确认 `openclaw channels status --probe --json` 为运行且已连接；本人发送 `/dws identity`、`/dws-listen status`、`/dws` 核对身份、偏好和卡片。

若卡片从旧桥接切换到通用接口，旧操作卡会在服务端停用，历史消息中的卡片可能仍然可见；请重新 `/dws` 打开新卡。仅切换卡片接口或模板时，未处理草稿、员工配置和发送历史保留；待办可以通过新卡或文字命令继续处理。已经成功发送和状态不明的消息不会因迁移自动重发。同一接口内重启仍保留有效卡片及通知去重。若同时切换 DWS 授权应用，还需执行[公司授权迁移](#company-app-migration)，旧未完成草稿转只读、原自动授权暂停，不能套用仅换模板的恢复方式。

新版已安装原定制 Channel 时，独立助手仍可使用其旧桥接，便于先迁移助手再迁移 Channel。只要通用接口已经提供，就优先采用该接口；连接暂断或请求失败时不会偷偷改用旧桥接重试。

回滚时恢复原 Channel 与旧助手代码；切换过卡片接口的场景请重新打开操作卡。若需要回滚员工业务状态，恢复经核对的同一员工备份，不混用其他员工的数据库或身份缓存。

### 卡片模板与必要权限

既有已发布模板可继续用于默认的展示版本 2。请在 [企业开发者后台卡片平台](https://open-dev.dingtalk.com/fe/card) 选择目标企业和实际机器人应用，在消息卡片下新建普通卡片。版本 2 导入并发布 `templates/dws-reply-assistant-card.json`；个人 AI 卡片入口不是这里的发布入口。

`templates/dws-reply-assistant-card.platform-export.json` 保留既有平台导出版本供核对。复制本企业生成的完整模板 ID（含 `.schema`）到 `assistant.cardTemplateId`，不要直接使用其他企业的测试模板 ID。

启用新版分区富文本时，导入 `templates/dws-reply-assistant-card-v3.platform-export.json`，在本企业完成预览、发布与真实回调验证后，将同一个 `assistant.cardTemplateId` 配置项改为新模板，并设置 `assistant.cards.presentationVersion: 3`。`dws-reply-assistant-card-v3.json` 是可重新生成的搭建源，示例富文本预览数据与运行时 Markdown 字符串分别保存；不得只看示例预览就判断运行时可用。

切换到展示版本 3 会停用原卡片的业务操作，并提供升级说明及有效期内的“打开新版助手”入口。仅切换模板时，已保存设置、规则、授权期限和草稿保留；到期入口引导重新发送 `/dws`。仅重启且模板未变时，有效卡继续可用。不需要在配置中同时维护两套模板 ID；已有卡片保留自身模板信息用于停用提示。公司授权迁移停用的旧卡不提供此恢复按钮，统一指引重新发送 `/dws`。

社区机器人仍需具备卡片 API 权限，回调继续使用已有 STREAM 连接。审批卡在本人与机器人私聊中，群消息的个人回复仍由 DWS 引用原消息发送。本项目不新增机器人连接或 HTTP 服务。

若使用 `plugins.allow`，追加 `dws-send-approval` 并保留原有条目；不要覆盖其他插件、Web Channel 或模型权限配置。

```bash
openclaw gateway restart
openclaw channels status --probe --json
```


<div id="draft-agent-setup"></div>

### 可选：开启专用只读起草 Agent（两版完整步骤）

本节适用于已经完成上文助手安装、DWS 身份绑定和卡片配置的实例。新装及升级均默认 `assistant.drafting.toolsEnabled:false`，继续使用无工具起草；只有需要起草时主动查询资料，才执行本节。普通无工具起草也会带入默认最近 5 分钟的对话文字。主题识别仍使用无工具接口，AI 草稿最终仍由本人确认发送。

开启需要同时满足两项：**宿主中新增专用 Agent，并在助手配置中选择该 Agent、打开工具开关。** 专用 Agent 不作为系统主 Agent，也不接收普通钉钉会话。不要把插件顶层 `config.agentId` 改成 `dws-draft`；顶层仍指向原有无工具拟稿 Agent。

#### 第一步：核对配置文件、状态目录和授权

在 Gateway 相同的运行用户、容器及环境变量下执行：

```bash
openclaw --version
openclaw config file
```

编辑命令返回的实际配置文件；若使用 `$include`，在对应源文件合并，避免同一配置在多个文件重复定义。先备份配置和员工状态。Kubernetes 部署在该员工的配置来源中更新，并保留原 PVC；本节示例不改变 DWS 登录环境或要求重新登录。

| 示例值 | 部署时替换为 |
| --- | --- |
| `main` | 当前主 Agent ID；保留其模型、工作目录、工具及普通会话权限 |
| `default` | 助手 `accountId` 对应的钉钉账号 ID，和现有 Channel 一致 |
| `dws-draft` | 新增专用 Agent ID；若改名，Agent 定义、插件 `drafting.agentId` 和工作目录末级必须同步 |
| `/srv/openclaw/state` | 该实例实际的 service stateDir 绝对路径；通常由 Gateway 的 `OPENCLAW_STATE_DIR` 决定，未设置时使用该运行用户的宿主默认状态目录。不能用主 Agent 的 workspace 代替，也不能仅凭配置文件位置推断 |
| `openai/gpt-5.6-sol` | 已向专用 Agent 授权且支持工具调用的模型；同时替换 `model.primary` 和 `models` 中的键 |
| `OWNER_STAFF_ID`、`/usr/local/bin/dws`、模板 ID | 原助手配置中的本人身份、实际 DWS 路径和已发布模板 ID，保持原值 |

专用 workspace 必须精确等于 `<service stateDir>/dws-send-approval/draft-workspace/<起草 Agent ID>`。插件启用后创建该目录；不能指向员工工作文件目录。宿主可在自己的任务会话和该目录保存临时状态，四个起草工具不修改用户业务数据。

以下两份 JSON 是**各版本独立可用的配置合并示例**，包含完整的 Agent、钉钉路由和助手开关层级；不是整个 `openclaw.json` 的替换文件。保留现有 `channels`、模型提供商与认证、`commands`、其他 Agent、其他插件及原助手配置字段。对象按键合并，数组按下面说明逐项处理，不能用示例数组覆盖原数组。

<div id="draft-agent-modern"></div>

#### 第二步 A：OpenClaw 2026.8.1 配置

在根对象的 `agents.entries` 中新增 `dws-draft`。示例使用 `ownership:"explicit"`，通过 `defaults.systemAgent.agentId` 明确保持原主 Agent，并为钉钉账号保留明确路由。`main:{}` 表示保留已有主 Agent 的全部字段，不是清空其配置。

<!-- draft-config:2026.8.1 -->
```json
{
  "agents": {
    "ownership": "explicit",
    "defaults": {
      "systemAgent": { "agentId": "main" }
    },
    "entries": {
      "main": {},
      "dws-draft": {
        "workspace": "/srv/openclaw/state/dws-send-approval/draft-workspace/dws-draft",
        "model": {
          "primary": "openai/gpt-5.6-sol",
          "fallbacks": []
        },
        "models": {
          "openai/gpt-5.6-sol": {
            "agentRuntime": { "id": "openclaw" },
            "codeMode": false
          }
        },
        "tools": {
          "allow": [
            "dws_draft_history",
            "dws_draft_contact",
            "dws_draft_search",
            "dws_draft_read"
          ],
          "codeMode": { "enabled": false }
        },
        "skills": []
      }
    }
  },
  "bindings": [
    {
      "agentId": "main",
      "match": { "channel": "dingtalk", "accountId": "default" }
    }
  ],
  "plugins": {
    "entries": {
      "dws-send-approval": {
        "enabled": true,
        "config": {
          "agentId": "main",
          "accountId": "default",
          "ownerUserId": "OWNER_STAFF_ID",
          "dwsPath": "/usr/local/bin/dws",
          "listener": { "enabled": false },
          "assistant": {
            "enabled": true,
            "cardTemplateId": "PUBLISHED_ASSISTANT_CARD_TEMPLATE_ID",
            "drafting": {
              "toolsEnabled": true,
              "agentId": "dws-draft",
              "timeoutSeconds": 120,
              "documentWorkspaceIds": []
            }
          }
        }
      }
    }
  }
}
```

如果现有配置采用兼容的 `default:true` 主 Agent 标记，可以保持该归属模式并新增起草 Agent；**不要同时设置 `ownership:"explicit"` 和 `default:true`**。若按上述示例转为 explicit，先核对原主 Agent，再移除旧默认标记，保留原来的 `authInheritance`、`sessionStore` 等其他归属配置。已有钉钉账号级 binding 时核对并复用，缺失时再追加；保留群或个人的更具体路由及其他 Channel 路由。只设置 systemAgent 不能替代钉钉账号路由。

模型配置和 `tools` 两层的 Code Mode 均须关闭。示例不设置回退模型；若部署自定义回退模型，每个回退模型也要在该 Agent 的 `models` 下显式配置 `agentRuntime.id:"openclaw"` 和 `codeMode:false`。

<div id="draft-agent-legacy"></div>

#### 第二步 B：OpenClaw 2026.7.1-2 配置

在根对象的 `agents.list` 数组中追加起草 Agent，按 ID 保留原主 Agent 及其他 Agent 的完整内容，并确保只有原主 Agent 标记 `default:true`。本版不使用 `agents.entries`、`agents.ownership` 或 `defaults.systemAgent`。以下是独立示例，不需要从新版示例手动删除字段：

<!-- draft-config:2026.7.1-2 -->
```json
{
  "agents": {
    "list": [
      { "id": "main", "default": true },
      {
        "id": "dws-draft",
        "workspace": "/srv/openclaw/state/dws-send-approval/draft-workspace/dws-draft",
        "model": {
          "primary": "openai/gpt-5.6-sol",
          "fallbacks": []
        },
        "models": {
          "openai/gpt-5.6-sol": {
            "agentRuntime": { "id": "openclaw" }
          }
        },
        "tools": {
          "allow": [
            "dws_draft_history",
            "dws_draft_contact",
            "dws_draft_search",
            "dws_draft_read"
          ],
          "codeMode": { "enabled": false }
        },
        "skills": []
      }
    ]
  },
  "bindings": [
    {
      "agentId": "main",
      "match": { "channel": "dingtalk", "accountId": "default" }
    }
  ],
  "plugins": {
    "entries": {
      "dws-send-approval": {
        "enabled": true,
        "config": {
          "agentId": "main",
          "accountId": "default",
          "ownerUserId": "OWNER_STAFF_ID",
          "dwsPath": "/usr/local/bin/dws",
          "listener": { "enabled": false },
          "assistant": {
            "enabled": true,
            "cardTemplateId": "PUBLISHED_ASSISTANT_CARD_TEMPLATE_ID",
            "drafting": {
              "toolsEnabled": true,
              "agentId": "dws-draft",
              "timeoutSeconds": 120,
              "documentWorkspaceIds": []
            }
          }
        }
      }
    }
  }
}
```

旧版 `models[模型]` 不支持 `codeMode` 字段，所以示例只在 `tools.codeMode.enabled` 关闭 Code Mode；不要从新版复制模型层的 `codeMode:false`。每个回退模型仍须显式设置 `agentRuntime.id:"openclaw"`。`bindings` 同样按现有账号路由核对、缺失时追加，不覆盖其他路由。

#### 第三步：配置模型认证与允许检索的知识库

专用 Agent 必须能通过宿主支持的认证方式调用所选模型。主 Agent 的无工具起草成功，不足以证明新增 Agent 的模型授权可用。沿用平台的模型凭据管理，不在示例中粘贴真实密钥，也不手工复制 OAuth 刷新材料到多个 Agent。

对于 **2026.7.1-2、已经存在有效 OpenAI OAuth 登录、但起草 Agent 报缺少 API key** 的组合，2026-09-28 的隔离真机验证使用如下认证类型声明后可正常运行。只在确认实际 profile ID 和认证类型一致时合并；这段声明不执行登录，不适用于原本使用 API key 的 profile：

```json
{
  "auth": {
    "profiles": {
      "openai:default": { "provider": "openai", "mode": "oauth" }
    }
  }
}
```

两份示例的 `documentWorkspaceIds:[]` 默认不开放文档检索。需要查询知识库时，改为该员工 DWS 账号有权读取的知识库空间 ID，例如 `["WORKSPACE_ID_1", "WORKSPACE_ID_2"]`，最多20个。这里是**知识库空间 ID**，不是文档链接、目录路径或模板 ID；配置不能扩大该账号原有访问权限。

| 工具 | 当前允许的操作 | 边界 |
| --- | --- | --- |
| `dws_draft_history` | 读取本次起草已固定的近期对话文字，最多50条 | 只含本人及发送者，不能换会话，不读附件 |
| `dws_draft_contact` | 读取本人或已核实发送者的姓名、部门、职位 | 不按姓名猜测身份，不返回手机号或邮箱 |
| `dws_draft_search` | 检索指定知识库中的在线文字文档 | 先核实知识库归属，再返回标题和本任务读取标识；范围为空时不可用 |
| `dws_draft_read` | 读取本任务检索到的文档正文，单篇最多8000字符 | 不能提供任意 URL、文件路径或其他任务的标识 |

工具允许清单必须恰好为这四项。每次起草最多12次工具调用，单次工具结果最多16000字符。没有开放浏览器、任意文件读取、通用命令执行、消息发送、写入、删除或任务委派。新增工具需要代码实现与边界审查，不能只在 `allow` 中追加名称。知识库检索范围和四个工具与卡片展示版本无关，启用 Agent 不要求同时切换 v3 模板。

#### 第四步：校验配置、重启并验收

1. 在与 Gateway 一致的运行环境执行 `openclaw config validate --json`，确认宿主配置和已安装插件配置均有效；校验不会启动 Gateway。若校验提示插件不存在，先完成本项目安装及原有加载路径配置。配置格式通过不代表模型凭据、只读预检或工具调用已经通过。
2. 检查起草 Agent 的专属 workspace、模型、四个工具及两版 Code Mode 差异。当前实现会拒绝未经审核的生命周期 Hook、已配置且未明确关闭的动态工具加载，以及未审核插件或记忆插件的运行组合。已验组合是本助手、钉钉 Channel、`memory-core` 和宿主内置 `openai` 提供商；生产实例若还有其他组件，先审查兼容性，不能为绕过检查直接删除生产插件或放宽起草工具权限。
3. 服务方式部署执行 `openclaw gateway restart`；Pod 部署通过原编排流程重启该员工实例。保留状态卷，并确保同一员工只有一个活动实例。用 `openclaw channels status --probe --json` 确认钉钉连接正常。
4. 本人在机器人私聊发送 `/dws identity`，应显示已就绪，再发送 `/dws` 打开卡片，确认原监听范围和回复设置仍在。这一步只验证身份与卡片，**不能单独证明 Agent 起草已启用**。
5. 在卡片把测试来源设置为“AI起草，我确认”，开启该测试来源的监听；若启用了主题规则，保证测试消息会进入 AI 起草分支。由测试联系人发送一条要求引用知识库测试文档中独有信息的来信，文档须在允许空间内。核对实际检索/读取记录、草稿事实和待确认状态；如未配置知识库，可先以“参考本人部门信息拟稿”的来信验证联系人查询。模型可自行判断是否需要工具，因此仅看到一段草稿不能证明工具已被调用。
6. 核对普通机器人私聊仍交给原主 Agent；测试草稿未批准前，不应向联系人发送回复。确需验证发送时，由本人在卡片明确批准并核对目标和正文。验收后恢复临时测试范围、规则与监听选择。不要依赖已清理的临时 transcript 作长期审计记录。

默认起草等待预算为120秒，可设10–600秒。超时不等于宿主任务已结束；插件保留未结束任务保护，不重启同一任务、不采用迟到输出。关闭工具起草时，把 `assistant.drafting.toolsEnabled` 设为 `false` 并重启；后续新任务恢复无工具起草。已有未结束任务仍需确认终态，不删除其账本、草稿或会话来绕过保护。其他 Agent 和业务数据不需要清空。

#### 常见错误与处理

| 表现或提示 | 核对与处理 |
| --- | --- |
| “请配置专用起草 Agent” | 核对 Agent 是否存在、`drafting.agentId` 是否一致；不能填 `main` 或当前系统主 Agent |
| “起草 Agent 必须使用插件专属的独立工作目录” | 从 Gateway 的实际 stateDir 重新计算路径；不要填主 Agent workspace、配置目录或另一员工的 PVC |
| 旧版配置提示 `codeMode` 字段无效 | 删除 `agents.list` 中模型层的 `codeMode`，保留 `tools.codeMode.enabled:false`；新版须保留两层 |
| 新版提示多个 Agent 没有明确归属，或 `explicit` 与默认标记冲突 | 核对 `ownership`、systemAgent 和既有 `default:true`；按本节第二步 A 保留一种合法归属模式 |
| 钉钉提示 `routing has no explicit owner` | 补齐当前钉钉 `accountId` 到原主 Agent 的账号级 binding；不要把普通消息路由到 `dws-draft` |
| 提示工具清单、实际工具来源或只读策略不符合要求 | 四个工具须来自本插件；核对 `allow`、Code Mode、`alsoAllow`、按提供商或发送者加工具、动态加载及生命周期插件。保持失败时拒绝，不放宽为全部工具 |
| 起草报模型认证失败、缺少 API key | 核对专用 Agent 使用的模型和认证 profile；旧版已用 OpenAI OAuth 的情况按第三步确认类型。DWS 重新登录不能修复模型认证 |
| 提示“管理员尚未配置可检索的知识库范围” | 填写 `documentWorkspaceIds`；填完还需确认 DWS 账号本来就有读取权限 |
| 发送者资料无法核实、文档不存在或无权访问 | 允许草稿说明资料不足；不按姓名猜测身份、不换账号查询、不扩大知识库范围 |
| “上一次任务尚未确认结束”或超过等待预算 | 等待宿主终态并核对运行状态，不重复启动或删除保护记录；普通 `/dws identity refresh` 不是取消 Agent 的命令 |
| 开了工具但卡片只有固定回复或不生成草稿 | 检查来源、主题动作、普通回复方式和监听选择；只有进入 AI 起草分支才使用专用 Agent |

更多查询限制、任务清理和已知接口差异见[只读起草能力与限制](read-only-drafting.md)。本节示例已通过两版宿主的配置格式与路由校验；历史功能真机证据见第 7 节的记录索引；0.9.2 的自动化检查与公司实际事件投递待验范围分开记录。


## 4. 配置项从哪里来

| 字段 | 来源与含义 |
| --- | --- |
| ownerUserId / OC_OWNER_STAFF_ID | 仍由平台提供：本人给社区机器人发消息时的 senderStaffId。支持 `/whoami` 的版本可在私聊查询；不是姓名、企业自定义工号或 DWS 开放 ID |
| dwsPath | 仍由镜像/平台配置：Pod 内绝对可执行路径。用同一运行用户执行 `command -v dws` 核对；不依赖自动搜索 PATH |
| accountId | 不填时为 `default`，优先读取 `channels.dingtalk.accounts.default`，否则读取顶层 `channels.dingtalk`；指定命名账号时读取 `channels.dingtalk.accounts[accountId]`，按社区插件规则继承顶层 clientId。不会自动选择列表中的第一个账号 |
| profile | 0.6.0 自动执行 `dws profile list --format json`，校验 `currentProfile` 对应的唯一当前账号、组织、userId 和 DWS 授权应用，再固定为 `corpId:userId`。userId 必须等于 ownerUserId |
| 审批机器人的开放 ID | 0.6.0 自动查找；不再配置 APPROVAL_BOT_OPEN_DINGTALK_ID 或 OC_APPROVAL_BOT_OPEN_ID。它是社区机器人在个人 IM 事件里的 sender_open_dingtalk_id，不是 clientId/robotCode，也不是主人的 UserId |
| assistant.cardTemplateId / OC_DWS_ASSISTANT_CARD_TEMPLATE_ID | 本应用可使用的已发布代回复助手卡片模板 ID；保留原值可继续使用 v2，启用新版富文本排版时按第3节“卡片模板与必要权限”发布并切换到 v3 模板 |
| agentId | 模型配置来源，通常 `main`，与 DWS 账号选择无关 |
| identityPolicy.requiredDwsClientId | 公司统一指定的 DWS OAuth 应用 ID；没有公司策略时不填，与社区机器人 clientId 无关 |
| identityPolicy.allowExistingBindingMigration | 默认 `false`；公司切换期间改为 `true`，完成后关闭，保留目标应用 ID |
| assistant.cards / storage / context / directBatch / drafting | 下方单实例示例列出常用默认值；完整范围见[只读起草能力、参数与部署限制](read-only-drafting.md)，这些参数不会覆盖员工已保存的回复偏好 |

### 自动发现如何执行

以下自动发现和缓存说明描述未配置公司授权策略时的行为。启用 `identityPolicy.requiredDwsClientId` 后，还会执行[公司授权策略的核验与迁移](#company-app-migration)，包括认证检查、消息接入与发送前的 profile 检查，以及最长 120 秒的迁移初始化预算。

启动服务入口只安排后台工作，立即返回。后台先读取当前 profile、校验员工，再读取绑定缓存与个人设置。监听关闭时只做本地 profile 查询；不查询本人开放 ID 或机器人、不建立 IM 订阅。员工已保存“开启”时，或者本人主动启用监听时，本人及机器人身份就绪后才创建消费进程。

启用监听前还会按 ownerUserId 精确查询本人的开放 ID，用于过滤本人发出的消息。DWS 可能把本人以用户身份发送的消息也推送回来；不依赖发送者姓名或消息正文判断，避免再次生成草稿或循环回复。本人及机器人查询固定使用刚校验的 profile，顺序如下；`ROBOT_NAME` 来自匹配 clientId 的真实结果，不由模型填写：

```bash
dws profile list --format json
dws --profile CORP_ID:USER_ID contact user search --query OWNER_USER_ID --format json
dws --profile CORP_ID:USER_ID chat bot search --page 1 --size 50 --format json
# robotList 中 robotCode == 对应钉钉 channel 的 clientId，取得 robotName
dws --profile CORP_ID:USER_ID chat bot find --query ROBOT_NAME --limit 20 --format json
# result.bots 中精确匹配名称，取得唯一 botOpenDingTalkId
```

当前企业部署前提是员工创建自己的机器人且机器人名称唯一。代码仍检查空结果、重复结果、非法字段和分页，不会随意取第一项。search 最多 5 页 × 50 项；find 最多 5 页 × 20 项，游标重复或超限即停止。

成功结果自动加入运行时的发送者排除列表，防止审批提醒再次触发代回复。`listener.ignoreSenderOpenIds` 现在仅用于管理员额外排除的对象，可不填。发现结果不写回 `openclaw.json`。

### 启动、失败隔离与缓存

| 情形 | 插件行为 | Gateway / 主会话 |
| --- | --- | --- |
| DWS 已登录、个人监听关闭 | 本地校验 profile、加载个人状态；本人开放 ID 和机器人身份按需获取 | 服务启动入口立即返回 |
| DWS 已登录、个人监听开启 | 校验身份，复用有效缓存或后台查询机器人，再恢复原范围 | 不等待查询及订阅就绪 |
| DWS 尚未登录 / 授权不可用 | 显示“等待 DWS 登录”；保留个人偏好与草稿，不启动监听 | 不抛出服务启动失败，不影响普通钉钉 / Web 会话 |
| CLI 缺失、权限错误、无效结果或超时 | 显示对应故障，拒绝代回复；可重新检测 | 故障限定于助手，不作为 Gateway 就绪失败 |
| 登录员工、组织、授权应用或机器人绑定变化 | 暂停旧运行时并拒绝自动重新绑定；保留原数据 | 原主会话继续按宿主原权限运行 |

profile 单次最多 5 秒，本人/机器人查询单次最多 10 秒，手动刷新时的条件性认证检查最多 15 秒。普通身份初始化总预算 30 秒；启用公司目标应用策略后整体初始化预算 120 秒，机器人按需身份解析仍有独立的 30 秒预算。超时/停止发送 SIGTERM，500 毫秒后仍未退出则 SIGKILL；完成或取消后清理定时器和子进程。CLI 输出总量不超过 1 MiB，不把原始 stderr、令牌或登录凭据写入用户提示。

自动启动只有明确可重试的错误会额外重试最多 2 次，基础间隔 5 秒、30 秒，加随机抖动并遵守较长的服务端 retry-after。未登录、账号不符、结果不唯一等不会循环重试。没有登录态轮询。未配置公司策略时，不为每条消息重新查询身份；配置公司策略后，助手入口、事件接入及发送前会核对当前 profile，防止授权应用变化后继续使用旧运行时。登录后由员工 `/dws identity refresh`、再次启用或重启触发检测。同一实例内并发检测合并，主动刷新若遇到正在初始化会串行执行，不会被静默忽略。

缓存位于 `<service stateDir>/dws-send-approval/identity.json`，0600、原子写入，本人及机器人结果有效期 24 小时。绑定包含员工、组织/profile、DWS OAuth clientId、社区 accountId/clientId 和 DWS 配置目录；同一员工换应用也不能无提示复用旧缓存。过期在下一次启动、启用或刷新时处理，不按固定周期访问平台。`/dws identity refresh` 强制重新查询，不清空偏好或草稿，也不擅自开启监听；如果个人原本开启，会短暂停止后按原范围恢复，重建订阅期间的历史消息不会补读。

旧版显式 `profile` 仍接受，但只作为一致性检查；推荐从配置中删除，改为自动发现。升级时务必删除配置中的 `${OC_DWS_PROFILE}` 和机器人 ID 占位引用，不能仅删除环境变量，否则宿主在加载配置阶段就可能因变量缺失失败。若原状态保存了别名而不是规范 `corpId:userId`，会保守拒绝身份不一致；管理员先备份并核对旧状态后迁移，不手工复制另一个员工的 identity.json。

### 员工与运维自检

在本人机器人私聊中，每条单独发送：

```text
/dws identity
/dws identity refresh
```

第一个只读取内存状态，不启动 CLI，显示员工、profile、机器人应用和已解析的开放 ID、查询时间与缓存来源；第二个立即回复“已开始后台身份检测”，后台检测后再用第一个查看结果。两者都校验本人身份、钉钉账号及私聊来源，不能在群聊、Web 或其他员工会话冒用。未登录时也可以查看此状态入口；需要登录的员工完成 DWS 授权后再刷新。

### 已登录但账号信息不完整

“DWS 已登录”与“助手已验证完整绑定”是两项检查。DWS profile 元数据缺少组织 ID（corpId）、用户 ID（userId）或授权应用 ID（clientId）时，助手会明确列出缺失或格式异常的字段，保留个人数据并停止初始化。DWS 授权应用 ID 与社区机器人的 clientId 含义不同，不能互相替代。

只有本人手动 `/dws identity refresh`，且当前账号唯一、组织和用户有效、与实例主人及显式 profile 配置一致、仅缺少 clientId 时，才执行一次 `dws auth status --profile CORP_ID:USER_ID --format json`。插件校验返回的组织、用户和有效凭据，再读取一次 profile。字段恢复完整后仍需通过原身份缓存的全部绑定校验，才能继续初始化。未配置公司授权策略时，正常启动、普通 `/dws` 重试、健康账号刷新均不增加认证检查，也没有后台轮询或自动反复尝试。

DWS 1.0.58 的认证检查不返回授权应用 ID；已实测有效登录仍可能缺少 profile 的 clientId。此时会提示“DWS 登录有效，但账号信息仍缺少授权应用 ID”，请管理员在 **Gateway 的同一运行用户、配置目录和密钥环境** 对当前账号重新授权，然后刷新。无需先退出所有账号。插件不会登录、登出、切换账号、读取令牌文件或猜测缺失 ID；旧缓存也不能充当当前身份的证明。如果认证检查报告密钥或钥匙串问题，应先保留凭据并修复运行环境。恢复后若授权应用发生变化，仍按原绑定迁移流程处理，不能直接覆盖 identity.json。

<a id="company-app-migration"></a>

### 公司统一 DWS 授权应用：集中下发、每实例自动迁移

**0.9.2 监听票据模式修订（2026-10-23）。** 公司统一入口授权要求事件监听显式传入 `--stream-ticket-mode custom`。助手的所有监听消费命令现统一添加该参数，覆盖全部私聊、指定人员私聊、群内 @本人、额外发送者以及合并订阅；不依赖迁移开关是否开启，也无需员工增加配置字段。保留的 `listenerArgs` 辅助函数同步使用 `event consume`；DWS 1.0.58 的 `+listen-im` 入口不支持此参数，不向该入口拼接不支持的选项。

例如“指定人员私聊＋全部群 @本人”对应两个进程（占位值由该实例真实身份及已保存对象填入）：

```bash
dws --profile '<corpId:userId>' event consume user_im_message_receive_o2o \
  --open-dingtalk-id '<对方完整openDingTalkId>' \
  --stream-ticket-mode custom --flatten --format ndjson

dws --profile '<corpId:userId>' event consume user_im_message_receive_at \
  --stream-ticket-mode custom --flatten --format ndjson
```

升级时保留原配置、模板 ID、展示版本和员工状态卷，更新助手代码并正常滚动重启 Pod，使原监听进程与 DWS bus 一并换新；无需清理业务数据或重新迁移身份。重启后检查实际消费命令包含该参数，并以新消息确实进入处理记录验证事件投递，不能只凭“就绪”判断问题已解决。使用原始 DWS 命令诊断时同样添加该参数，可加 `--duration 3m` 限定诊断时长。该修订的自动化检查与尚未覆盖范围见[监听票据模式修订记录](../plans/2026-10-23-custom-stream-ticket.md)，此前真机记录不等于本次已验证公司 custom 事件投递。

适用于 OpenClaw **2026.7.1-2、2026.8.1**，两版的助手配置完全相同。公司从员工各自的旧 DWS 应用切换到统一应用时，在原有 `plugins.entries["dws-send-approval"].config` 中增加以下字段，保留其余配置：

```json
{
  "identityPolicy": {
    "requiredDwsClientId": "COMPANY_DWS_CLIENT_ID",
    "allowExistingBindingMigration": true
  }
}
```

`COMPANY_DWS_CLIENT_ID` 替换为公司指定的 **DWS OAuth 应用 ID**，不是 `channels.dingtalk.clientId`（审批机器人应用）。插件不需要也不接受 `client-secret`；公司登录入口负责授权参数和凭据。此策略仅支持默认助手模式，不能同时配置 `assistant.enabled:false` 的旧自主执行路径。

| 字段 | 默认与生命周期 | 作用 |
| --- | --- | --- |
| `requiredDwsClientId` | 默认未设置；公司完成切换后长期保留 | 只允许已授权给该 DWS 应用的账号运行助手 |
| `allowExistingBindingMigration` | 默认 `false`；迁移阶段设 `true`，全员完成后统一关闭 | 允许从各 Pod 自己保存的历史绑定迁移到目标应用；不需要收集不同员工的旧 client-id |

**未设置公司策略的实例保持原身份校验流程；0.9.2 的 custom 监听票据参数仍统一生效。** 仅设置目标 ID 不等于授权迁移。已有目标绑定不会因反复刷新、重启或后来关闭迁移开关再次撤销授权。以后升级仍保留这两个配置项；它们不是下个版本就删除的一次性参数。迁移开关关闭后尚未迁移的离线 Pod 会等待管理员重新安排迁移，不应只按当前在线人数认定“全员完成”。

`allowExistingBindingMigration:false` 表示禁止继续迁移，不会撤销已完成的绑定；删除策略也不会自动恢复旧应用。当前没有公司级“自动恢复每个员工原应用”的回退功能。迁移记录以目标应用区分，反复改目标做往返迁移可能与已完成记录冲突；不能用删除迁移记录或覆盖身份缓存绕过保护。

#### 员工所处状态与实际行为

| 当前状态 | 助手行为 | 下一步 |
| --- | --- | --- |
| 从未登录或已退出 | 等待 DWS 登录，不处理消息，保留已有数据 | 员工通过公司入口授权后再发 `/dws` |
| 仍登录旧应用 A/B/C，包含旧应用凭据已过期 | 显示“公司授权方式已更新”，暂停处理与自动发送 | 按指引通过公司入口重新授权 |
| 已登录目标应用，访问令牌过期但 refresh token 有效 | 由 DWS 续期；真实身份查询成功后继续 | 无需员工逐 Pod 执行迁移脚本 |
| 目标应用凭据撤销、失效或无法读取 | 等待重新授权或报告凭据环境问题，原数据保留 | 重新授权；密钥/目录问题由管理员处理，不能删除原凭据碰运气 |
| 新用户、目标应用有效、没有历史助手状态 | 正常首次初始化，监听默认关闭 | 员工自行配置范围并启用 |
| 旧用户、目标应用有效、仅应用 ID 变化 | 迁移开关开启且核验通过后自动迁移 | 核对保留的设置；按需重新确认自动发送授权 |
| 已完成目标应用绑定 | 正常启动，不重复迁移 | 无须重复授权已重新确认的规则 |
| 组织、员工、机器人、配置目录也变化，或历史绑定缺失但业务数据仍在 | 停在“应用迁移待核实”，不覆盖状态 | 管理员处理异常实例，不自动按姓名映射或丢掉排除规则 |

公司旧应用提示使用统一文案：

> **公司授权方式已更新**
>
> 你当前仍使用旧的 DWS 授权，需要通过公司统一入口重新授权。
>
> 原有设置、草稿和历史记录已保留。完成授权前，助手暂不处理消息或自动发送回复。
>
> **下一步：**通过公司统一入口完成授权（发送指令：请退出并重新登录dws），然后回到这里再次发送 `/dws`。

提示使用已有卡片模板；没有操作按钮，不代员工执行登录或退出。卡片投递失败时返回相同文案。公司必须保证入口确实使用新应用参数；插件不会接管主 Agent 对“请退出并重新登录dws”的处理。完成授权后，`/dws` 会重新检查并接续迁移，无需再次重启 Pod。`/dws identity refresh` 也可以重新核实。停用期间收到的历史消息不会自动补发。

#### 保存、核实与中断恢复

每个实例先读取并校验本地 `identity.json`，把本实例旧来源绑定冻结到迁移记录的 `sourceBinding`；完成后 `identity.json` 更新为目标应用绑定，旧绑定仍在迁移记录和备份中。单轮迁移只允许应用 ID 变为配置目标。保留原员工、组织/profile、社区机器人、账号和 DWS 配置目录的一致性要求。重新查询本人、机器人及已保存规则中的人员/群/暂停会话；人员必须有唯一的已保存 UserId，且新授权查询出的开放 ID 与原规则一致。开放 ID 变化、缺少稳定 ID、群不可访问、待结束的 Agent 任务或无法核实的旧自主任务记录，均暂停整个助手等待核对。不会偷偷删掉“不处理”规则或扩大来源范围。

核实后先创建 `app-migration-backup-<目标ID摘要>/`，其中包含旧身份、个人偏好、来源记录及 SQLite 一致性快照（不会遗漏 WAL 中已提交内容）；再在一个事务里保护发送状态，最后切换身份绑定。`app-migration-<目标ID摘要>.json` 保存进度。备份和迁移记录存放于原助手状态目录，权限分别为目录 0700、文件 0600。备份包含员工消息内容，沿用公司状态卷访问控制；迁移不自动删除备份，验收和公司保留期限满足后再由平台清理，勿打进镜像或安装包。

- **保留：** 监听开关、范围、回复设置、主题内容、固定正文、处理记录、冷却与去重信息。
- **需要重新确认：** 普通固定自动授权及主题自动授权暂停，正文和规则仍可编辑。员工在新卡片内重新核对期限、范围和频率后授权；不静默沿用旧发送权限。
- **旧草稿和卡片：** 未完成草稿转为只读归档；发送中转为结果未知，已有未知结果保持不明且不重发。旧卡片停用并提示发送 `/dws`，新卡可以查看保留的数据。归档正文仍遵循已有存储保留期限，不是永久保存。
- **首页提示：** `identityAppMigration` 记录存在时，首页持续显示迁移完成说明，即使规则已重新授权也不会自动消失。看实际规则与有效授权数量判断是否可自动发送；普通 AI 起草、逐条确认和只整理不依赖自动发送授权。
- **恢复：** 重启或再次 `/dws` 接续检查；已完成步骤不重复撤销新授权。数据、备份或来源冲突时停止，不能用清空状态、覆盖 identity.json、改写旧应用 ID 的方式“修复”。

迁移需保持每份状态卷只有一个活动 Gateway。若发现遗留迁移锁，锁以完整文件原子落盘；代码在记录的进程已不存在，或 Pod 重启复用了本进程 PID 但进程实例标识不同的时候接续；无法确定进程归属时保持暂停。若管理员确认异常后人工处理，应先停实例并保留全部状态供核对。**已有发送发生后，不能直接整库回滚到迁移前备份**，否则可能丢失发送/去重记录；需要核对并保留迁移后的发送事实。

#### 15000 Pod 的发布与观察

1. 公司先验证新应用的权限、机器人查询、人员及群访问、登录入口；保留原状态卷和现有配置。选择不同员工状态的小批 Pod 灰度，不能只测刚安装的新用户。
2. 统一下发目标应用 ID 和迁移开关并滚动重启。每实例启动查询随机错开 0.1–30.1 秒，目标核实并发最多 2、规则目标最多 600，迁移初始化预算 120 秒；网络临时错误最多两次退避重试。平台仍应限制批次规模，根据 DWS 限流与实际耗时调整，不应一次重启全部 Pod。
3. 原来未登录/旧应用的员工按卡片指引自行授权；原来已登录目标应用的员工自动迁移。无须管理员逐 Pod 输入旧 client-id 或运行迁移命令。
4. 使用现有集中日志收集 `[DWSIdentity] state=...`，并读取实例的迁移状态文件核对 `pending/backed_up/complete`；员工可用 `/dws identity` 自查。代码没有内置公司级管理后台或 15000 实例汇总平台。统计完成、等待登录、等待公司授权、需人工核对及长期离线实例，只处理异常名单。
5. 覆盖离线员工并确认完成后统一设置 `allowExistingBindingMigration:false`，保留 `requiredDwsClientId` 和状态卷内的完成记录。

公司策略启用后，初始化增加一次 `auth status` 验证；已就绪的 `/dws`、消息接入及实际发送前也检查当前 profile，防止缓存掩盖员工重新授权导致的变化。无固定周期登录轮询；不阻塞 Gateway 服务启动。员工数据量影响本地一致性检查和备份耗时，需给状态卷预留至少一份数据库快照的空间。真实新公司应用的权限及企业级限流必须由灰度验证，本地双宿主验收不代表已测试 15000 Pod 容量。

### 单实例配置

下面示例与包内 [`config.example.json`](../../config.example.json) 一致，适用于 **0.9.2 和两版宿主**，显式列出常用参数及默认值。它是合并到现有 `openclaw.json` 的片段，不能替代整份宿主配置：保留已有 `channels`、`agents`、模型与凭据、Web 权限、其他插件及加载路径；使用 `plugins.allow` 时追加本插件 ID。`approvals.plugin` 用于兼容旧审批，保留其他插件现有审批配置，不直接用示例数组覆盖原数组。

替换本人 `OWNER_STAFF_ID`、实际 DWS 绝对路径、已发布模板 ID，并将 `main`、`default` 改为实例实际的无工具拟稿 Agent 和钉钉账号。**这是新安装实例的默认配置示例，不是升级时覆盖员工配置的模板。** 示例默认不启用公司授权限制、不开放工具、使用展示版本 2。公司首次切换统一应用时另合并下方 `identityPolicy`；已使用 v3 富文本的实例必须保留原模板 ID 和 `presentationVersion:3`，不能因复制示例漏配或降为 2。

<!-- single-instance-config:config.example.json -->
```json
{
  "commands": {
    "text": true,
    "allowFrom": {
      "dingtalk": [
        "OWNER_STAFF_ID"
      ]
    }
  },
  "approvals": {
    "plugin": {
      "enabled": true,
      "mode": "targets",
      "targets": [
        {
          "channel": "dingtalk",
          "accountId": "default",
          "to": "user:OWNER_STAFF_ID"
        }
      ]
    }
  },
  "plugins": {
    "entries": {
      "dws-send-approval": {
        "enabled": true,
        "config": {
          "agentId": "main",
          "accountId": "default",
          "ownerUserId": "OWNER_STAFF_ID",
          "dwsPath": "/absolute/path/to/dws",
          "mode": "approval",
          "timeoutMs": 120000,
          "identityPolicy": {
            "allowExistingBindingMigration": false
          },
          "listener": {
            "enabled": false
          },
          "assistant": {
            "enabled": true,
            "cardTemplateId": "PUBLISHED_ASSISTANT_CARD_TEMPLATE_ID",
            "draftTtlMinutes": 1440,
            "cardTtlMinutes": 30,
            "cards": {
              "expiryCheckSeconds": 10,
              "presentationVersion": 2
            },
            "storage": {
              "retentionDays": 7,
              "expiredCardRetentionHours": 24,
              "cleanupIntervalSeconds": 300,
              "dedupeRetentionDays": 30
            },
            "context": {
              "historyMinutes": 5
            },
            "directBatch": {
              "mergeGapSeconds": 30
            },
            "drafting": {
              "toolsEnabled": false,
              "timeoutSeconds": 120,
              "documentWorkspaceIds": []
            }
          }
        }
      }
    }
  }
}
```

`commands.allowFrom.dingtalk` 只允许本人使用该渠道的宿主命令，它不替代 `channels.dingtalk.dmPolicy/allowFrom`。保留原有其他渠道项，不添加全局 `*` 规则；该钉钉项不会改变 Web 渠道原有权限。所有助手命令和按钮仍独立校验本人身份及私聊来源。

`mode:block` 是平台层禁止代发送；不等于停止监听。员工开关及选项存放在独立状态文件中，已有偏好优先于初始模板。

#### 公司本次切换：必须补充目标应用与迁移开关

将以下两项合并到同一 `plugins.entries["dws-send-approval"].config.identityPolicy`，覆盖基础示例中的 `false`。`requiredDwsClientId` 必须替换为公司指定的 DWS 应用 ID，不能填机器人应用 ID，也不要在助手配置内加入 client-secret。

<!-- company-policy-config -->
```json
{
  "requiredDwsClientId": "COMPANY_DWS_CLIENT_ID",
  "allowExistingBindingMigration": true
}
```

只装新包或只照抄基础示例不会启用迁移；只填目标 ID 而保留 `false`，也不会迁移已有旧应用绑定。已保存的身份和业务状态应原样保留，全员迁移完成后关闭迁移开关并长期保留目标 ID。新实例没有旧数据时不需要迁移授权，但仍必须使用目标应用登录。不同登录状态的提示与处理见[公司授权应用切换](#company-app-migration)。

#### 按实际能力选择模板和 Agent

| 场景 | 配置方式 |
| --- | --- |
| 保留既有展示版本 2 模板 | 保留原 `cardTemplateId` 和 `cards.presentationVersion:2` |
| 首次从 v2 切换到分区富文本 | 先发布并验证 v3 模板，再同时设置其 `cardTemplateId` 和 `cards.presentationVersion:3` |
| 已使用 v3，升级到 0.9.2 | 保留原模板 ID 和 `cards.presentationVersion:3`；不重新发布模板 |
| 默认无工具起草 | 保持 `drafting.toolsEnabled:false`；最近 5 分钟对话上下文仍生效 |
| 开启只读工具起草 | 按[两版专用 Agent 配置步骤](#draft-agent-setup)新增并核验 Agent，再显式填写 `drafting.agentId`、开启工具；不能只把开关改成 `true` |

基础示例省略 `profile` 和自动发现的机器人开放 ID；`listener.kind/target` 属于兼容的初始来源配置，普通助手通过卡片保存范围，无须手填。`listener.ignoreSenderOpenIds` 仅在需要额外排除对象时配置。未填 `drafting.agentId` 时继承顶层 `agentId`，不代表该主 Agent 可直接用于受限工具起草；`documentWorkspaceIds:[]` 表示不开放知识库检索。配置范围与上限见[参数说明](read-only-drafting.md)。

合并后先执行 `openclaw config validate --json`，再按安装步骤重启并核对 `/dws identity`、`/dws` 的真实状态和卡片。配置格式有效不代表 DWS 授权、模型、模板权限或真实回调已经验证通过。

## 5. 15000 个 Pod 的统一部署

同一镜像、同一 ConfigMap 模板。profile 和机器人开放 ID 已由插件自动发现；剩余身份和模板由开户平台提供：

| 变量 | 是否因人不同 |
| --- | --- |
| OC_OWNER_STAFF_ID | 是；与本 Pod 员工绑定 |
| OC_DWS_ASSISTANT_CARD_TEMPLATE_ID | 按应用授权范围共享或分别配置 |
| OC_DWS_REQUIRED_CLIENT_ID | 仅启用公司策略时需要；全公司统一，不因员工不同 |

直接使用包内 `config.kubernetes.example.json`，宿主支持字符串中的 `${ENV_NAME}` 替换。环境变量缺失应由部署校验发现，不能把另一个员工的默认身份补给当前实例。DWS OAuth 登录态由每个员工独立授权并保存；复制 profile 名不能复制出有效授权。

该文件与单实例基础示例采用相同默认值，仍不自动启用公司策略或 v3 展示。公司本次部署需在 ConfigMap 的助手配置中合并下列对象，并通过环境变量提供公司统一应用 ID；没有启用公司策略的部署无需设置这个环境变量。迁移完成后将布尔值改为 `false`，不要把布尔值写成字符串。

<!-- company-kubernetes-policy-config -->
```json
{
  "identityPolicy": {
    "requiredDwsClientId": "${OC_DWS_REQUIRED_CLIENT_ID}",
    "allowExistingBindingMigration": true
  }
}
```

使用 v3 模板时，同步在 ConfigMap 中设置 `assistant.cards.presentationVersion:3`，并将 `OC_DWS_ASSISTANT_CARD_TEMPLATE_ID` 设为已发布验证的 v3 模板 ID；两项必须配套。

OpenClaw 状态目录和 DWS 配置目录挂载员工独立的持久卷。不要让两个运行中的 Pod 共用同一员工状态卷、profile 和监听；更新策略确保同一员工只有一个活动实例。共享 ConfigMap 只负责初始默认值，不写回员工设置。

自动身份缓存为同目录的 `identity.json`；员工的规则在 `<service stateDir>/dws-send-approval/preferences.json`；草稿、按钮令牌、自动授权、冷却和记录在 `assistant.sqlite`（含运行时 WAL）；旧来源保护在 `sources.json`。目录 0700、数据库 0600。备份/迁移应暂停服务并完整保留状态，或使用 SQLite 一致性备份；不要只复制活跃数据库而遗漏 WAL。

首次默认关闭。员工主动开启后，Pod 重建从个人持久卷恢复其选择；这与“新员工默认不开启”并不冲突。自动授权到期自动失效；卡片默认有效 **30 分钟** ，`assistant.cardTtlMinutes` 可设 1–1440 分钟；绝对到期，翻页、修改及保存都不延长。每次新发 `/dws` 会停用同类手动操作卡，独立通知卡仍按自身期限与状态处理。草稿默认 24 小时，`draftTtlMinutes` 可设 10–10080 分钟，两者互不替代。待处理达到 200 条后阻止新会话接入，已有会话可继续更新，不是严格总量上限；到期扫描不受旧版 1000 张活跃卡上限影响。终态正文默认保留 7 天，已刷失效的过期卡默认再保留 24 小时；发送中、结果未知和未结束 Agent 任务受保护。后台默认每 10 秒做轻量到期巡检，每轮公平回写最多 10 张失效卡；失败按原卡、原后端退避重试。重型清理默认每 300 秒运行，分批删除及被动 WAL checkpoint；删除正文后留下默认 30 天去重指纹。长时间不可投递的卡在 7 天后仅保留权限墓碑。服务端按绝对时间拒绝过期回调，不依赖前端刷新。升级前已被清理的历史记录无法回写卡面，但点击同样被拒绝。

身份发现仅顺序启动短生命周期 CLI，同一解析过程最多一个查询子进程，不增加常驻身份查询进程。全部私聊 + 所有群 @本人可合并为一个 DWS consume 进程；指定人员可能按唯一目标增加消费进程，最多 41 个（两个各 20 人列表并集 + 一个广泛订阅）。DWS 自身的事件总线进程、连接、认证与平台订阅配额也要纳入集群预算。群范围过滤在本地，不会为每个群额外创建一个消费进程。

15000 Pod 应分批滚动发布，并保留员工 PVC 的身份缓存。冷缓存且已开启监听的实例仍需访问机器人接口；插件的有限重试和抖动不能替代企业侧批次、配额与整体容量控制。DWS 配置目录和运行用户必须一致，容器临时目录也应保持一致。

升级、回滚按第 3 节的版本组合和迁移步骤执行。维护时备份整个助手状态目录，保留发送记录供核对，不把 unknown 状态批量重试；旧宿主无需因助手抽离而更换既有兼容 Channel。

## 6. 独立维护边界

助手只依赖卡片投递、更新和可信 Stream 回调，不依赖大文件上传上限、问卷人数或问卷超时增强。新版只跟随原作者代码与通用卡片接口，不继续维护这些无关改动；旧版兼容分支保留已有历史提交。

助手项目不包含完整的 Channel，也不直接持有社区机器人的密钥或另建 Stream 连接。通用客户端在 `vendor/` 中保存固定版本与 MIT 声明，通过进程内注册表调用已经加载的 Channel；旧桥接仅为兼容已有部署。

接口可用时，临时断线或请求错误不会触发跨接口重试。切换接口导致旧操作卡停用，业务状态保留。接口升级应连同宿主版本、补丁校验值与卡片真机回归一起验收。

当前两版专用 Agent 的完整配置、路由和排错见[第 3 节](#draft-agent-setup)，参数与查询限制见[只读起草能力](read-only-drafting.md)。部署应同时记录 **0.9.2、实际 Git 提交或安装包 SHA-256**；版本号不能替代构建标识或企业灰度验收。

## 7. 验证、性能与交付状态

### 0.9.2 当前验证范围

| 检查 | 本版状态与范围 |
| --- | --- |
| 参数、业务回归和静态检查 | 全量 423 项测试及语法检查；覆盖各监听范围的实际 spawn 参数、ready 和停止流程 |
| OpenClaw 2026.7.1-2 / 2026.8.1 | 实际安装 SDK 矩阵及宿主集成脚本；模型使用本机模拟服务，不等于真实模型或 DWS 投递验收 |
| 文档配置示例 | 单实例与包内 JSON 保持一致；两版专用 Agent、公司策略及 Kubernetes 片段分别校验宿主 schema、插件 schema 和配置解析 |
| 文档与安装包 | Markdown 重新生成 HTML，检查版本、链接、示例和包内容；包内排除凭据、员工数据库与本机测试产物 |
| 公司 custom 模式下的真实事件 | 尚待部署环境复验；遵照用户要求，未恢复此前停止的真机验证 |
| 企业 15000 Pod 容量、Linux 生产环境、全部手机展示 | 不能由本地自动化或历史单实例真机结果推定，仍按企业发布策略灰度核验 |

本次实现与检查结果见[0.9.2 监听票据修订记录](../plans/2026-10-23-custom-stream-ticket.md)。下列历史记录只证明各自日期、版本和环境中的结果，不计为本次 custom 模式已经通过：

- [0.9.1 卡片排版及两轮间距验证（2026-09-29）](../plans/2026-09-29-v0.9.1-card-spacing.md)
- [功能、真实来信与只读 Agent 验证（2026-09-28）](../plans/2026-09-28-development-record.md)
- [身份恢复验证（2026-09-28）](../plans/2026-09-28-identity-recovery.md)
- [公司应用迁移验证（2026-09-29）](../plans/2026-09-29-company-app-migration.md)
- [历次页面、SDK、性能及 DWS 排障的原始摘录](../plans/2026-10-23-historical-validation-notes.md)

### 当前诊断边界与已知限制

- “监听就绪”来自 DWS 启动时的 ready 标记，当前没有逐条入站计数或丢弃原因展示。正常日志没有某条消息，不足以证明 DWS 没投递；程序就绪也不证明持续收到事件。
- 2026-10-20 的隔离路由检查发现同名 `dws` skill 的抢占风险：旧版工具分派型 skill、新版普通或工具分派型 skill 都可能优先处理 `/dws`。先确认插件已成功加载，再核对 skill 的斜杠入口；将冲突 skill 的 `user-invocable` 设为 `false` 可作为定向配置处理。0.9.2 未修改宿主命令优先级。
- “旧监听尚未正常停止”可能是真实消费进程未退出，也可能是启动失败后的清理异常覆盖了原错误。已有 v3 状态却配成默认 v2 是一条已复现路径。0.9.2 未修复该错误覆盖问题，不能据此盲删状态、身份或迁移记录。
- DWS 1.0.58 曾出现状态查询按 `items` 解析、接口实际返回 `list` 的差异，因此 `subscriptions:[]` 不能单独证明服务端没有订阅。需要核对原始业务响应及本次订阅 ID。

### 收不到消息：最短排查路径

1. 查看 `/dws identity`、`/dws-listen status`、`/dws-reply status`；确认消息在监听开启后产生、对象及群 @本人符合范围、没有“不处理”规则或会话暂停。
2. 主动看待回复和处理记录。有记录但无提醒，查免打扰/提醒方式；“已过滤”表示主题筛选后的正常记录；起草失败也会保留记录。两处都没有新消息时，优先查事件接入或入库前排除条件。
3. 在 Gateway 同一容器、同一运行用户、相同 DWS 配置目录及 `TMPDIR` / `XDG_RUNTIME_DIR` 下，以 `/dws identity` 返回的实际 profile 查询：

```bash
dws --version
dws --profile '<corpId:userId>' event status --status all --format json
```

4. 需要独立复现时，先由员工 `/dws-listen off` 暂停助手，并确认原消费进程退出。在同一环境执行一条有界的原生群 @诊断命令：

```bash
dws --profile '<corpId:userId>' event consume user_im_message_receive_at   --stream-ticket-mode custom --flatten --format ndjson --duration 3m
```

等待 `[event] ready` 后由另一个员工真正 @该员工本人，记录消息时间及本次 `subscribe_id`、`bus_pid`，观察终端事件和对应 consumer 的 received/dropped。该用例只验证群 @；私聊按公司监听适配章节的指定人员命令单独核验。诊断结束后恢复原监听开关；本次新建订阅退出时会取消，应按测试时段查日志。若原生命令也收不到，继续查 DWS 订阅、远端推送和本地 bus 分发；这本身不能单独认定服务端故障。

## 8. 卡片协议、组件与发布验收

模板只是可复用的展示结构，业务状态保存在插件中。首页、范围设置、草稿、批处理和历史使用同一个模板，以变量切换标题、说明、动态表单及最多六个按钮；不是把所有页面塞进一张卡片。

| 模板部分 | 数据/协议 | 服务端职责 |
| --- | --- | --- |
| CardHeaderV2 / v2 BaseText | title、description | 标题共用；展示版本 2 用分段文字显示对象、正文与说明 |
| v3 MarkdownBlock 正文分区 | content_status、content_summary、content_body、content_notice | 0.9.2 沿用 content_body 统一展示状态、摘要、提示和分节正文，其他三槽清空；正文先转义，单换行用 `<br>`，空行保留为段落，不更改原草稿正文 |
| 有效期备注 | card_expires_note | 显示卡片绝对到期时间，与草稿和授权有效期分开 |
| Form | form.fields（输入、多行输入、单选、多选） | 验证字段与允许的操作 |
| 六个 SingleButton | button1…6、action1…6 | 保存一次性令牌与按钮索引绑定 |
| 可见性表达式 | card_status、show_button_1…6 | 隐藏空按钮，过期后禁用 |
| Stream request 事件 | cardPrivateData.actionIds、params.form | 从顶层 userId/outTrackId 校验真实操作者 |

钉钉官方提供[模板导入示例](https://github.com/open-dingtalk/dingtalk-card-examples)、[事件链能力](https://open.dingtalk.com/document/dingstart/using-event-chains-for-card-interaction)与[卡片回调示例](https://opensource.dingtalk.com/developerpedia/docs/explore/tutorials/stream/bot/go/card-callback/)。这些文档证明能力存在，不能替代本模板在目标租户的实际验收。

展示版本 2 使用重新分段的 `description`；版本 3 保留四个富文本变量的模板契约，0.9.2 沿用 `content_body` 统一呈现并清空其余三槽。动态表单与回调协议共用，配置只维护一个当前模板 ID。历史页面记录已单独归档；首次启用 v3 须按第 3 节发布配套模板。已使用 v3 时升级到 0.9.2 无需重新发布，旧 v2 模板不会因软件升级自动获得富文本组件。

模板发布流程：新建专用模板 → 导入 JSON → 编译/预览 → 发布 → 取得模板 ID → 确认机器人可使用 → 配置并构建插件 → 重启 Gateway → 确认 Stream 已连接 → 本人私聊 `/dws` → 操作按钮并检查真实回调。不要覆盖既有问卷模板。

### 故障定位与回滚

1. 模板导入失败：确认 JSON 是搭建器导出格式，不是 createAndDeliver 请求体；保存平台原始错误及版本。
2. 投递失败：核对模板已发布、应用授权、真实 staffId、机器人账号；不要把 clientId 当模板 ID。
3. 卡片可见但点击无效：检查 STREAM 回调、outTrackId 与一次性 actionId；不得降级为信任表单中的 userId。
4. 页面过期或正文改变：重新 `/dws` 获取新卡，按新版本确认；不要关闭版本校验。
5. 新卡显示为空白：本轮桌面自动化观察到后台窗口暂不绘制卡片，将钉钉窗口置于前台后，同一卡片立即显示且回调正常；重启客户端也曾恢复显示。这是实测恢复方法，不代表已确定客户端内部根因。不要仅凭投递成功判定展示成功，也不要为此反复发布模板。
6. 临时真机调试结束：恢复原配置路径并重新启动 Gateway，验证频道重新连接。新增测试模板保留用于复验；不把测试模板 ID 写入通用配置。

## 9. 开发、打包与交付

助手源码在本项目根目录，`index.mjs` 为入口，`card-transport.mjs` 统一适配两类 Channel 接口。原社区项目中的副本不再作为后续开发入口。

```bash
npm ci
npm run check
npm test
npm run test:hosts -- /path/to/openclaw-2026.7.1-2 /path/to/openclaw-2026.8.1
npm run docs:build
npm run pack:local
npm run pack:check
```

`test:hosts` 需要实际安装的 OpenClaw 包目录，隔离运行 SDK 与本地模型夹具，不读取员工配置、不连接钉钉。源码为原生 ESM，入口是根目录 `index.mjs`，无需给助手生成 `dist/index.js`。必须完整安装包内 `.mjs`、插件清单及随包依赖文件，不能只复制某个文件或沿用旧副本。Channel 补丁的运行时与类型构建见第 3 节。

HTML 由 Markdown 生成：开发文档为 `docs/contributor/dws-reply-assistant-deployment.html`，员工手册为 `docs/user/dws-reply-assistant-manual.html`。包内保留对应 Markdown、模板、兼容补丁、脚本和测试，不携带 node_modules、凭据或员工状态。所有配置示例 ID 由部署系统或管理员绑定。

---

基于 OpenClaw DingTalk Channel Plugin，YM Shen and contributors，https://github.com/soimy/openclaw-channel-dingtalk 。MIT；模板与改造代码随包保留 LICENSE。DWS 命令核对自 https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli 的 1.0.58 代码。OpenClaw 兼容验证使用本机两版已安装宿主。
