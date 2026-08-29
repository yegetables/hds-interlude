# HDS Interlude 配置指南

适用版本：`0.1.4-beta3`

第一次安装先看 `BEGINNER_GUIDE.md`。本文件严格按照 Koishi Console 的显示顺序说明当前字段；旧版本已经移除或隐藏的字段集中列在末尾，不再混入正常配置流程。

## Console 顺序

1. `blindMode`：失明模式
2. `storyDefaults`：剧本起点
3. `model`：模型与服务商
4. `onebot`：OneBot / NapCat 权限
5. `sharedStory`：共享剧本
6. `runtime`：对话与时间
7. `agency`：主体行动窗口
8. `memory`：连续性与记忆
9. `alterSystem`：临时氛围偏移
10. `browser`：只读网页观察
11. `logging`：日志与隐私

首次测试先完成 `storyDefaults`、`model`、`onebot`、`sharedStory` 和 `runtime`；`blindMode` 保持关闭。Embedding、网页观察、主动联系和内容日志应在基础私聊稳定后逐项开启。

## 1. blindMode：失明模式

开启 `blindMode.enabled` 后，HDSI 不注册自己的管理指令，并静默拦截当前 Koishi 实例中所有已经识别的指令；普通聊天仍会进入叙事。HDSI 的普通运行日志、错误详情和消息预览都会隐藏，只按 `healthReportMinutes` 输出一次不含故事或账户内容的运行状态心跳；其它插件仍遵循各自的日志配置。

它适合追求高度沉浸感，并且模型、账号白名单和故事档案已经稳定正常的环境。关闭此模式需要在 Console 修改配置并重载插件；失明模式开启期间无法通过聊天指令恢复管理能力。旧 `blackBox` 配置仍可兼容读取，但 Console 只显示 `blindMode`。

## 2. storyDefaults：剧本起点

这些字段只在创建新主剧本时写入 Canon。修改 Console 不会自动重写已经存在的故事。

| 字段 | 说明 |
| --- | --- |
| `characterName` | 主角名称。 |
| `characterProfile` | 主角身份、性格、作息、习惯、压力和行为边界。 |
| `perspective` | 主角个体价值观 / 看待世界的方式。它作为独立于 Canon 的外壳人格层，在相关事件中自然影响判断；长期剧情可形成 `perspective` overlay。 |
| `userProfile` | 没有账号专属资料时使用的默认用户背景。 |
| `relationship` | 新参与者与主角的默认初始关系。 |
| `world` | 时间、地点、社会与现实规则。 |
| `supportingCast` | 重要配角及其与主角的关系。 |
| `location` | 主角主要活动地点。 |
| `style` | 当前故事文风，优先级高于全局 `model.stylePrompt`。 |
| `timezone` | IANA 时区，例如 `Asia/Shanghai`。主模型以该时区生成权威 `nowLocal`、当前时段和日照预期。 |

小幅补充无需维护。若大幅改变角色、Perspective、关系或世界前提，保存后执行对应的 `interlude.overlay.clear character|perspective|relationship|world`，避免旧 Overlay 与当前设定冲突。

`perspective` 是独立于 Canon 的主角外壳人格层，不会重写 `characterProfile`。Console 的 `storyDefaults.perspective` 会写入新主剧本；已有故事可通过 `interlude.setup {"perspective":"..."}` 一次性设置基础 Perspective，再让长期剧情形成其 overlay。

重载和长间隔不会沿用旧剧本中的钟点描述：当前 `nowLocal` 始终优先。时区无效时运行时回退到 UTC，因此发现上午/下午错误时应先检查这里是否为有效 IANA 名称。

## 3. model：模型与服务商

### 3.1 连接顺序

1. 将 `mode` 设为 `openai-compatible`。
2. 先确认 `vision.enabled`：纯文本模型保持关闭；视觉模型才开启。
3. 在 `providers` 的每一行一次填完连接地址、API Key 和实际模型名。
4. 勾选这行模型要承担的用途：主叙事、压缩、Alter 或 Embedding；每种用途保持一条即可。
5. 在下方按任务分别调整温度、token、超时、提示词和 Embedding 参数。

`fallback` 不调用远程模型，只适合验证插件、数据库和命令是否安装成功。

### 智谱官方提供商模式

在任意一行 `providers` 中将该行 `mode` 设为 `zhipu-official`，保存并重载后，Console 会切换为智谱专属字段：只需填写智谱 API Key、模型代码和推理强度。该行固定使用 `https://open.bigmodel.cn/api/paas/v4/chat/completions`，不会显示 endpoint、额外请求头或额外请求体；其它提供商行仍可保持 `openai-compatible`。

智谱行的 GLM‑5.3‑Flash 强制使用 SSE：首个可见文本等待上限为 45 秒，首字到达后不设置总等待上限。推理强度可选 `low`、`high`、`max`，默认 `high`；GLM‑5.3‑Flash 不支持关闭思考。图片请求会使用智谱接受的 `image_url.url` 形式，不附带 OpenAI 的 `detail` 字段。

### 其它官方提供商模式

每一行 `providers.mode` 都可以独立选择，保存并重载后显示该模式的字段。以下预设固定官方 Chat Completions endpoint，只需填写 API Key 与模型名：

| 模式 | 服务商 | 默认模型 | 说明 |
| --- | --- | --- | --- |
| `openai-official` | OpenAI | `gpt-5-mini` | OpenAI 官方 Chat Completions。 |
| `deepseek-official` | DeepSeek | `deepseek-chat` | DeepSeek 官方 Chat Completions。 |
| `moonshot-official` | Kimi / Moonshot | `kimi-k2.5` | Kimi 官方 OpenAI-compatible 接口。 |
| `dashscope-official` | 阿里云百炼 | `qwen-plus` | 可选择北京、新加坡或美国共享服务地域；工作空间专属地址使用自定义模式。 |
| `siliconflow-official` | 硅基流动 | `Qwen/Qwen3-8B` | 官方 OpenAI-compatible 接口。 |
| `openrouter` | OpenRouter | `openai/gpt-5-mini` | 使用 OpenRouter 模型 slug，例如 `anthropic/...` 或 `google/...`。 |
| `gemini-openai` | Google Gemini | `gemini-2.5-flash` | Gemini 官方 OpenAI 兼容端点。 |

`openai-compatible` 始终保留给第三方中转站、工作空间专属域名和自定义网关。Anthropic 官方 Messages API 与 HDSI 当前 Chat Completions 请求结构不同，因此不作为“官方兼容预设”显示；可通过 OpenRouter，或使用支持 Chat Completions 的中转服务。

### 3.2 providers

| 字段 | 说明 |
| --- | --- |
| `label` | 模型连接的显示名称，例如 GLM 4.7 Flash。 |
| `enabled` | 是否启用这条模型连接。 |
| `endpoint` | 完整 Chat Completions 地址。 |
| `apiKey` | 密钥；按密码处理，不要进入截图和日志。 |
| `model` | 服务商实际模型名；只在这行填写一次。 |
| `useForMain` | 用作主叙事模型。 |
| `useForCompaction` | 用作后台压缩模型。 |
| `useForAlter` | 用作 Alter 侧端分析模型。 |
| `useForEmbedding` | 用作 Embedding 模型；仅支持 `/embeddings` 的模型可勾选。 |
| `extraHeaders` / `extraBody` | 服务商明确要求时填写 JSON 对象。 |

模型行既是连接配置，也是用途分配中心。无需填写或记忆 `providerId`、`modelId`、`mainModelId`；旧配置中的这些字段仍可兼容读取。

### 3.3 主叙事调优

主叙事模型由上方 `useForMain` 自动选择。这里仅调整它的生成行为：

- `mainTemperature`
- `mainTopP`
- `mainMaxTokens`
- `mainTimeout`
- `mainResponseFormat`：主叙事唯一的输出格式设置

### 3.4 failover 与提示词

`failover.enabled` 控制失败切换；`strategy` 可选按顺序或轮询；`maxAttemptsPerProvider` 控制单服务尝试次数；`cooldownMinutes` 控制失败后的临时跳过。

提示词职责：

- `mainPrompt`：主叙事创作方向。
- `formatPrompt`：结构化协议的补充，不能取消固定 JSON 和时间规则。
- `fixedPrompt`：所有故事通用的长期约束。
- `stylePrompt`：全局文风。

### 3.5 vision、compaction、embedding

- `vision.enabled`：位于模型区最前面；开启后把当前私聊图片作为原生多模态输入，纯文本模型必须保持关闭。
- `compaction`：后台整理已发生剧本、事实和状态提案。模型由 `useForCompaction` 选择；这里配置温度、top-p、输出、超时、响应格式和压缩提示词。
- `embedding`：长期事实语义检索。模型由 `useForEmbedding` 选择；`liveQuery=false` 可避免每次实时回复多一次向量请求，`backfillBatchSize` 控制后台补齐旧事实的速度。

Embedding 地址留空时，插件会尝试从标准 `/chat/completions` 地址推导 `/embeddings`。非标准网关应填写完整地址。

## 4. onebot：OneBot / NapCat 权限

`onebot.enabled=true` 后采用显式白名单：`botAccounts` 或 `userAccounts` 为空都会拒绝对应账号。

### 4.1 botAccounts 与 userAccounts

- `botAccounts`：机器人 QQ、备注、启用状态。
- `userAccounts`：用户 QQ、主角称呼、稳定人物 ID、人物资料、初始关系、启用状态。
- `ignoreSelfMessages`：忽略机器人自己的事件回显，建议开启。

同一现实人物的多个账号可复用 `personId`。不同人物必须分别填写资料和关系，不能把所有 QQ 当作同一关系分支。

### 4.2 groupChats

| 字段 | 说明 |
| --- | --- |
| `groupId` / `label` / `enabled` | 群号、备注和启用状态。 |
| `purpose` | 群的用途和背景。 |
| `characterRole` | 主角在群中的身份和说话位置。 |
| `responseMode` | `mention-only` 只在被 @ 时进入主叙事；`always` 处理所有消息。 |
| `contextLimit` | 主叙事读取的最近群消息数。 |
| `debounceSeconds` | 合并连续群消息的等待时间。 |
| `cooldownSeconds` | 主角群发言后的最短冷却。 |
| `willingness` | 可选的纯算法群聊意愿：积累、半衰减、阈值概率与成功发言成本。 |

群聊不再调用独立快速筛选模型。满足入口规则的消息在合并后直接交给主叙事，由主叙事决定是否输出 `groupReply`。

对 `responseMode=always` 的活跃群，可开启 `willingness`。它完全在本地按算法运行：普通群消息累积意愿、按半衰期自然衰减、接近上限时增益递减、超过阈值后按概率决定是否进入主模型；主角成功群发言后会扣除意愿。关键词与引用机器人消息可增加意愿，@ 机器人始终绕过概率。它默认关闭，只作用于这个群，不影响私聊、Alter、Agency、自动推进或主提示词，也不产生额外模型调用。

### 4.3 voiceTranscription：SnowLuma 私聊语音转写

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 启用 SnowLuma `fetch_ptt_text`。仅处理当前私聊中的 QQ `record` 语音。 |
| `timeoutMs` | `20000` | 转写最大等待时间；超时后仍保留语音事实并继续本轮。 |

转写成功后，主模型收到的用户事件会带有 `[用户语音转写]` 标记，并和当前文本、图片一起构成同一个回合。该功能需要 SnowLuma 支持原始 OneBot `fetch_ptt_text` 动作；NapCat 或其它实现不支持时会安全降级。它不把音频文件或 base64 写入 HDSI 数据库。

### 4.4 chatActions：QQ 原生表情

`nativeFaces` 控制是否允许结构化 QQ 原生小表情；关闭后主模型不会收到对应字段，插件也不会发送 face 段。

`expressionThreshold` 是表达严格度，不是固定发送频率。HDSI 会同时校验模型意愿与当前回复文字是否具有相同的非语言含义：低分或语义不相符时不投递。`0.70` 是平衡值；`0.90` 以上非常克制；`0.95` 及以上接近关闭，适合只保留纯文字聊天的场景。

## 5. sharedStory：共享剧本

当前运行时固定为“同一机器人账号一个活动主剧本”，因此不再显示旧版 `enabled` 开关。

| 字段 | 说明 |
| --- | --- |
| `autoEnrollParticipants` | 白名单用户首次私聊时自动加入现有主剧本。 |
| `allowCrossConversationMessages` | 允许一次写作向其它合法参与者产生消息。 |
| `shareParticipantDetails` | 是否向模型提供其它关系分支的原始历史；默认关闭。 |
| `maxCrossConversationActions` | 单回合跨账号动作上限，建议保持 `1`。 |
| `participantContextLimit` | 单次请求携带的其它参与者摘要数量。 |
| `managerAccounts` | 有权执行全局管理命令的 QQ；空表表示所有已授权用户。 |

## 6. runtime：对话与时间

### 6.1 消息合并、回复和失败恢复

| 字段 | 说明 |
| --- | --- |
| `captureDirectMessages` | 是否接管私聊。 |
| `autoCreate` | 没有故事时是否从当前 Console 档案自动启动；关闭时先执行 `interlude.doctor`，再由管理员执行 `interlude.story.start`。 |
| `ignoreCommandMessages` | 防止管理命令进入剧本。 |
| `userMessageDebounceSeconds` | 合并连续私聊的静默等待时间，默认 2 秒。 |
| `narrativeRetryDelaySeconds` / `narrativeRetryMaxAttempts` | 叙事服务失败后的重试节奏。 |
| `cancelDelayedRepliesOnUserMessage` | 是否同时取消普通延迟回复和跨关系计划；未发送的 `<sep/>` 分段始终会被新消息截断。 |
| `minimumDelayedReplySeconds` / `maximumDelayedReplyMinutes` | 模型允许计划的延迟范围。 |
| `maxScriptCharacters` / `maxMessageCharacters` | 单回合剧本和单条可见消息的字符上限。 |

### 6.2 分段消息

`splitReplyMessages` 开启后，模型可以用 `messageSeparator`（默认 `<sep/>`）拆分聊天气泡。`typingBaseDelaySeconds`、`typingCharactersPerSecond` 和 `typingMaxDelaySeconds` 控制后续气泡的模拟输入时间。

主模型尚未提交第一条回复时，新消息会废弃旧请求，并把旧、新消息合并后重新写作，不再受固定秒数窗口限制。第一条回复已经提交后，新消息会取消剩余分段；未发送文字以 `interruptedOutgoingDrafts` 进入替代提示词，表示主角想发送但被新消息打断，不能视为已送达内容。

### 6.3 自动生活和主动联系

| 字段 | 说明 |
| --- | --- |
| `autoAdvanceEnabled` | 是否在没有新消息时继续写作生活。 |
| `autoAdvanceIntervalMinutes` / `autoAdvanceJitterMinutes` | 普通时段目标间隔和随机浮动。 |
| `conversationFollowUpMinutes` / `conversationFollowUpJitterMinutes` | 对话结束后的短期补写时间点。 |
| `restWindows` | 睡眠、工作等低频推进窗口，可跨午夜。 |
| `sweepIntervalMinutes` / `maxStoriesPerSweep` | 后台发现到期任务的频率和单轮故事上限。 |
| `minimumAdvanceMinutes` | 手动推进在没有到期任务时需要的最小时间差。 |
| `allowProactiveMessages` | 是否允许无新消息时产生可见主动联系。 |
| `proactiveWillingnessThreshold` | 主模型主动联系意愿门槛。 |
| `contextEntryLimit` / `memoryLimit` | 主叙事携带的近期条目和长期事实数量。 |

## 7. agency：主体行动窗口

Agency Window 只描述角色能否采取外部联系行动的现实条件，不描述情绪、关系阶段或联系风格。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 启用生活来源的联系候选、容量判断和 `proactive-check` 重查。 |
| `maxWindowMinutes` | `240` | 当前日程/隐私/设备判断最长有效时间，过期后必须重新生成。 |
| `minimumProactiveIntervalMinutes` | `60` | 同一参与者普通主动联系的安全间隔；承诺型联系可绕过。 |
| `maxCandidateHours` | `24` | 联系理由最长保留时间，过期后自然放下。 |

Agency Window 包含 `activityLoad`、`privacy` 和 `deviceAccess`。自动生活剧本先完成，之后才允许产生由真实生活事件、承诺、实际安排或关系后续支撑的联系候选。候选可以立即联系、稍后重查或放下；稍后重查不会预写未来消息。

`runtime.allowProactiveMessages=false` 时 Agency 不产生可见联系。`proactiveWillingnessThreshold`、白名单和单回合动作上限仍然是最终安全边界。Agency 不读取 Alter 数值，也不会影响文风。

## 8. memory：连续性与记忆

### 8.1 整理触发和预算

- `enabled`
- `backgroundIntervalMinutes`
- `sceneEntryThreshold` / `sceneCharacterThreshold`
- `recentEntryLimit` / `factLimit`
- `compactionEntryLimit` / `compactionCharacterLimit`
- `sceneHookCharacters` / `sceneSummaryCharacters` / `arcSummaryCharacters`
- `factContentCharacters`
- `maxFactsPerStory` / `maxStoriesPerCompactionRun`

近期使用原始剧本；更早内容通过场景、剧情弧线和长期事实压缩。默认在 16 条未压缩条目或 10000 个字符达到其一时整理，短对话会保留更宽的连续回合缓冲。压缩只处理已经发生的内容，不会制造未来事件。

### 8.2 事实排序

`factImportanceWeight`、`factConfidenceWeight`、`factRecencyWeight`、`semanticWeight` 和 `unresolvedWeight` 共同决定旧事实进入主提示词的顺序。Embedding 可用时，语义分数参与排序；否则语义分数为零。

### 8.3 剧情余波

- `activeConsequencesEnabled`
- `activeConsequencePromptLimit`
- `activeConsequenceMaxDays`
- `activeConsequenceDefaultStrength`

余波保存已经发生事件的短期影响，保持具体、短期，并由后续事件自然收束。

### 8.4 Overlay 演化与压缩

普通状态提案需满足置信度、至少三个独立剧本回合、至少两个日期以及同路径冷却。相关字段包括：

- `statePatchConfidenceThreshold`
- `majorStatePatchConfidenceThreshold`
- `statePatchMinEvidence`
- `statePatchMinTurns`
- `statePatchMinDays`
- `statePatchCooldownHours`
- `autoApplyStatePatches`
- `allowMajorStateChanges`

Overlay 压缩字段包括 `overlayCompressionEnabled`、近期保留天数、周/月窗口和摘要字符上限。管理员可使用 `interlude.overlay.status`、`interlude.overlay.compact` 和 `interlude.overlay.clear` 检查或维护。

## 9. alterSystem：临时氛围偏移

Alter 只衡量本轮新事件对整体氛围造成的净变化：正数偏严肃，负数偏轻松，范围 `-5..5`。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否评分和注入临时 offset。 |
| `baseThreshold` | `10` | 累计触发基础阈值。 |
| `densityFactor` | `0.3` | 最近一小时写作密度降低阈值的比例。 |
| `sameDirectionBoost` | `0.05` | 同向每点 Alter 增加的权重。 |
| `oppositeDecay` | `0.15` | 反向每点 Alter 减少的权重。 |
| `minWeight` | `0.2` | 低于此值清除旧 offset。 |
| `maxIntensity` | `2` | 新 offset 强度上限。 |

Alter 模型由上方 `useForAlter` 选择。`temperature`、`topP`、`maxTokens`、`timeout` 和 `prompt` 只控制这项低频分析任务。

达到阈值后，本轮先完成剧本、状态和可见消息；侧端分析在同一故事队列中后台运行，不阻塞当前回复。失败时保留累计值并进入五分钟冷却。完整算法见 `docs/ALTER_SYSTEM.md`。

## 10. browser：只读网页观察

需要同时启用 Koishi Puppeteer。插件只允许搜索或访问公开 HTTP(S) 页面，不登录、不填表、不下载、不发布内容，并拒绝 localhost、私网和不安全协议。

主要字段：

- `enabled`、`mode`
- `allowSearch`、`allowVisit`
- `searchUrlTemplate`
- `allowedDomains`、`blockedDomains`
- `maxConcurrentPages`、`maxResearchPerSweep`
- `navigationTimeout`、`waitUntil`
- `maxTextCharacters`、`maxExcerptCharacters`、`maxObservationsInPrompt`
- `cacheMinutes`
- `allowGroupTriggeredResearch`
- `logObservationPreview`

`allow-immediate` 会为少数私聊额外执行一次观察并重新请求主叙事，因此延迟和费用都更高。首次测试使用 `deferred-only`。

## 11. logging：日志与隐私

| 字段 | 说明 |
| --- | --- |
| `level` | 错误级别阈值；日常使用 `info`。 |
| `verbosity` | `summary`、`standard`、`diagnostic` 三档运行信息量。 |
| `format` | 默认 `layered` 彩色任务时间线；也可使用 compact 或兼容旧版的 detailed。 |
| `colors` | 为阶段、完成、Alter、警告和错误添加 ANSI 语义颜色。 |
| `colorTheme` | `dark` 使用深色界面的柔亮调色板；`light` 使用明亮界面的深色高对比调色板。由用户按 Console 主题手动选择。 |
| `kaomoji` | 使用固定颜文字；关闭后改用简洁符号。 |
| `logScriptPreview` | 是否记录剧本正文预览。 |
| `logMessageContent` | 是否记录用户和主角可见消息。 |
| `previewLength` | 内容预览字符上限。 |

标准档只保留直观业务事件；扫描、队列、计时器和 SQLite 临时重试进入诊断档。内容开关可能记录私聊和网页文本，排障结束后应关闭。

## 隐藏的历史兼容字段

以下字段不再出现在 Console：

- `sharedStory.enabled`：运行时固定使用共享主剧本。
- `sharedStory.participantPresets`：旧 YAML 可读取，新配置统一使用 `onebot.userAccounts`。
- `onebot.userMode`：运行时固定为 allowlist。
- `runtime.pauseAfterConversationMinutes`：已经被明确的 follow-up 时间表替代。
- `runtime.staleNarrativeRequestWindowSeconds`：稳定版不再使用固定过期秒数；首条回复提交前始终可由新消息替换。
- `model.groupGate`：群聊快速筛选模型已经移除。

旧配置中的这些字段不会恢复旧架构，也不应继续写入新配置。

## 推荐验证顺序

1. `npm run typecheck`、`npm test` 和 `npm run build`。
2. 使用 `fallback` 验证插件加载、数据库和命令。
3. 配置主模型，只测试一个白名单私聊。
4. 测试连续消息、延迟回复取消和 `<sep/>` 分段。
5. 开启自动推进和对话后续补写。
6. 检查 Alter 日志与后台分析。
7. 最后启用 Embedding、视觉、网页观察、群聊和跨账号主动联系。
