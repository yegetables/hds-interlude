import { Context, Schema, Session } from 'koishi'
import { CompactionConfig, EmbeddingConfig, FailoverConfig, ModelConfig, ProviderConfig, VisionConfig } from './narrator'
import { BlindModeConfig, BrowserConfig, ChatActionsConfig, Config as InterludeConfig, extractSessionVoiceCount, GroupChatRule, InterludeService, LoggingConfig, MemoryConfig, OneBotAccountRule, OneBotNapCatConfig, RestWindow, RuntimeConfig, SharedStoryConfig, StickerLibraryConfig, StoryDefaults } from './service'
import { AgencyConfig, AlterSystemConfig, ChatReactionName, NativeFaceSemantic, StorySetting } from './types'
import { HDS_INTERLUDE_VERSION } from './meta'
import { GroupWillingnessConfig } from './group-willingness'

declare module 'koishi' { interface Context { interlude: InterludeService } }

export const name = 'hds-interlude'
export const version = HDS_INTERLUDE_VERSION
export const inject = { required: ['database', 'http'], optional: ['puppeteer'] }

const defaultProvider: ProviderConfig = {
  id: 'primary',
  label: 'Primary provider',
  enabled: true,
  endpoint: '',
  apiKey: '',
  model: '',
  temperature: 0.8,
  topP: 1,
  maxTokens: 4096,
  timeout: 60_000,
  responseFormat: 'json-object',
  extraHeaders: '',
  extraBody: '',
  useForMain: true,
  useForCompaction: true,
  useForAlter: true,
  useForEmbedding: false,
  useForStickers: false,
  mode: 'openai-compatible',
}

const ProviderCommon = Schema.object({
  label: Schema.string().default('Primary model').description('模型连接的显示名称，例如 GLM 4.7 Flash。'),
  enabled: Schema.boolean().default(true).description('是否启用这条模型连接。'),
  mode: Schema.union(['openai-compatible', 'zhipu-official', 'openai-official', 'deepseek-official', 'moonshot-official', 'dashscope-official', 'siliconflow-official', 'openrouter', 'gemini-openai']).default('openai-compatible').description('请求协议。保存并重载后显示对应字段。'),
  useForMain: Schema.boolean().default(true).description('主叙事用途；每类用途建议一条。'),
  useForCompaction: Schema.boolean().default(true).description('后台压缩用途。'),
  useForAlter: Schema.boolean().default(true).description('Alter 分析用途。'),
  useForEmbedding: Schema.boolean().default(false).description('Embedding 用途；模型需支持 /embeddings。'),
  useForStickers: Schema.boolean().default(false).description('表情包描述用途；必须选择能够识图的模型。'),
})

function OfficialProvider(mode: 'openai-official' | 'deepseek-official' | 'moonshot-official' | 'siliconflow-official' | 'openrouter' | 'gemini-openai', defaultModel: string, description: string): Schema<any> {
  return Schema.object({
    mode: Schema.const(mode),
    apiKey: Schema.string().role('secret').default('').description(`${description} API Key。官方 endpoint 自动使用。`),
    model: Schema.string().default(defaultModel).description(`${description} 模型代码。`),
  })
}

const Provider: Schema<ProviderConfig> = Schema.intersect([
  ProviderCommon,
  Schema.union([
    Schema.object({
      mode: Schema.const('openai-compatible'),
      endpoint: Schema.string().default('').description('OpenAI 兼容 Chat Completions 完整地址，例如 /v1/chat/completions。'),
      apiKey: Schema.string().role('secret').default('').description('鉴权密钥；仅保存在 Koishi 配置中。'),
      model: Schema.string().default('').description('服务商实际模型名，例如 gpt-4o-mini。'),
      extraHeaders: Schema.string().role('textarea').default('').description('额外 HTTP 请求头，必须是 JSON 对象；无特殊需求留空。'),
      extraBody: Schema.string().role('textarea').default('').description('额外请求体字段，必须是 JSON 对象；无特殊需求留空。'),
    }),
    Schema.object({
      mode: Schema.const('zhipu-official'),
      apiKey: Schema.string().role('secret').default('').description('智谱开放平台 API Key。官方 endpoint 会自动使用。'),
      model: Schema.string().default('glm-5.3-flash').description('智谱模型代码，例如 glm-5.3-flash。'),
      reasoningEffort: Schema.union(['low', 'high', 'max']).default('high').description('GLM-5.3-Flash 推理强度；high 是平衡默认值。'),
    }),
    OfficialProvider('openai-official', 'gpt-5-mini', 'OpenAI 官方'),
    OfficialProvider('deepseek-official', 'deepseek-chat', 'DeepSeek 官方'),
    OfficialProvider('moonshot-official', 'kimi-k2.5', 'Kimi / Moonshot 官方'),
    Schema.object({
      mode: Schema.const('dashscope-official'),
      apiKey: Schema.string().role('secret').default('').description('阿里云百炼 API Key。官方 OpenAI-compatible endpoint 自动使用。'),
      model: Schema.string().default('qwen-plus').description('百炼模型代码，例如 qwen-plus。'),
      dashscopeRegion: Schema.union(['beijing', 'singapore', 'us']).default('beijing').description('百炼共享服务地域。工作空间专属 endpoint 请使用 openai-compatible 自定义模式。'),
    }),
    OfficialProvider('siliconflow-official', 'Qwen/Qwen3-8B', '硅基流动官方'),
    OfficialProvider('openrouter', 'openai/gpt-5-mini', 'OpenRouter'),
    OfficialProvider('gemini-openai', 'gemini-2.5-flash', 'Google Gemini OpenAI 兼容'),
  ]),
]) as unknown as Schema<ProviderConfig>

const Failover: Schema<FailoverConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('主服务商失败时是否尝试其它已启用服务商。'),
  strategy: Schema.union(['priority', 'round-robin']).default('priority').description('priority 按配置顺序选择；round-robin 轮换选择。'),
  maxAttemptsPerProvider: Schema.natural().min(1).max(5).default(1).description('单个服务商连续失败前的最大尝试次数。'),
  cooldownMinutes: Schema.natural().min(0).max(1_440).default(5).description('服务商失败后的冷却时间，单位分钟。'),
})

const Embedding: Schema<EmbeddingConfig> = Schema.object({
  modelId: Schema.string().default('').description('模型预设 ID；填写后优先使用 model.models 中对应的模型。'),
  liveQuery: Schema.boolean().default(false).description('是否在每次实时对话中额外请求 Embedding 做语义检索。关闭可减少一次网络请求、降低回复延迟；后台向量补齐不受影响。'),
  enabled: Schema.boolean().default(false).description('启用长期事实的语义检索。关闭时退化为规则排序。'),
  providerId: Schema.string().default('').description('生成向量所使用的服务商 id；留空时自动选择。'),
  endpoint: Schema.string().default('').description('Embedding 接口地址；留空时根据聊天接口推导。'),
  model: Schema.string().default('').description('Embedding 模型标识，例如 text-embedding-3-small。'),
  dimensions: Schema.natural().min(0).max(32_768).default(0).description('向量维度；0 表示由服务商决定。'),
  timeout: Schema.natural().min(500).max(120_000).default(10_000).role('ms').description('向量请求超时，单位毫秒。'),
  maxInputCharacters: Schema.natural().min(100).max(32_000).default(4_000).description('单条事实送入 Embedding 的最大字符数。'),
  backfillBatchSize: Schema.natural().min(0).max(100).default(5).description('每轮后台补齐向量的事实数量；0 表示不补齐旧记录。'),
})
void Embedding

const Vision: Schema<VisionConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('原生识图开关。开启后，当前私聊图片会作为多模态输入发送给所选 OpenAI-compatible 主模型；模型本身必须支持视觉输入。图片不会写入剧本数据库。'),
}).collapse(true)

const Model: Schema<ModelConfig> = Schema.object({
  vision: Vision.default({ enabled: false }).description('图片理解：开启后把当前私聊图片送入主叙事模型。请只为明确支持视觉输入的模型开启。'),
  providers: Schema.array(Provider.collapse(true)).default([defaultProvider]).description('模型中心：每一行一次性填写连接、密钥、模型名和用途分配。无需填写或记忆任何 ID。'),
  mainTemperature: Schema.number().min(0).max(2).default(0.8).description('主叙事采样温度。'),
  mainTopP: Schema.number().min(0).max(1).default(1).description('主叙事 top-p；通常保持 1，仅调整 temperature。'),
  mainMaxTokens: Schema.natural().min(0).max(100_000).default(4096).description('主叙事最大输出 token 数。'),
  mainTimeout: Schema.natural().min(1_000).max(300_000).default(60_000).role('ms').description('主叙事请求超时，单位毫秒。'),
  mainResponseFormat: Schema.union(['json-object', 'prompt-only']).default('json-object').description('主叙事唯一的输出格式设置。支持 JSON mode 时选 json-object；不支持时改为 prompt-only。'),
  failover: Failover.default({ enabled: true, strategy: 'priority', maxAttemptsPerProvider: 1, cooldownMinutes: 5 }).description('主模型请求失败时的切换策略。'),
  mainPrompt: Schema.string().role('textarea').default('Continue the character-centered life script with grounded actions, motives, relationships, and ordinary time passing.').description('主叙事行为指令：定义模型如何连续写作、推进生活并处理外部事件。'),
  formatPrompt: Schema.string().role('textarea').default('').description('结构化输出补充说明；只能扩展固定协议，不能覆盖 JSON、时间和安全校验。'),
  fixedPrompt: Schema.string().role('textarea').default('').description('所有故事通用的长期约束。'),
  stylePrompt: Schema.string().role('textarea').default('Use restrained, realistic prose with concrete daily details, natural pauses, and no forced drama.').description('全局叙事文风；故事级 style 可进一步覆盖。'),
  embedding: (Schema.object({
    enabled: Schema.boolean().default(false).description('启用长期事实的语义检索。模型由上方“用作 Embedding 模型”用途开关选择。'),
    liveQuery: Schema.boolean().default(false).description('是否在每次实时对话中额外请求 Embedding 做语义检索。'),
    endpoint: Schema.string().default('').description('Embedding 完整地址；留空时从所选模型连接的 Chat 地址推导。'),
    dimensions: Schema.natural().min(0).max(32_768).default(0).description('向量维度；0 表示由服务商决定。'),
    timeout: Schema.natural().min(500).max(120_000).default(10_000).role('ms').description('Embedding 请求超时，单位毫秒。'),
    maxInputCharacters: Schema.natural().min(100).max(32_000).default(4_000).description('单条事实送入 Embedding 的最大字符数。'),
    backfillBatchSize: Schema.natural().min(0).max(100).default(5).description('每轮后台补齐旧事实的数量。'),
  }) as unknown as Schema<EmbeddingConfig>).default({ enabled: false, modelId: '', providerId: '', endpoint: '', model: '', dimensions: 0, timeout: 10_000, maxInputCharacters: 4_000, backfillBatchSize: 5 }).description('长期事实的语义召回设置。'),
  compaction: (Schema.object({
    enabled: Schema.boolean().default(true).description('启用后台剧本压缩与长期事实提取。'),
    temperature: Schema.number().min(0).max(2).default(0.3).description('压缩采样温度；建议保持较低以提高稳定性。'),
    maxTokens: Schema.natural().min(0).max(100_000).default(2048).description('压缩响应的最大 token 数。'),
    timeout: Schema.natural().min(1_000).max(300_000).default(60_000).role('ms').description('压缩请求超时，单位毫秒。'),
    topP: Schema.number().min(0).max(1).default(1).description('压缩请求的核采样概率。'),
    responseFormat: Schema.union(['json-object', 'prompt-only']).default('json-object').description('压缩请求的 JSON 模式；不支持时改为 prompt-only。'),
    mainPrompt: Schema.string().role('textarea').default('Compress completed scenes into concise continuity notes while preserving causality, promises, unresolved matters, and gradual character change.').description('压缩任务指令：定义摘要、事实和状态变更的提取目标。'),
    fixedPrompt: Schema.string().role('textarea').default('').description('压缩器必须遵守的长期规则。'),
    stylePrompt: Schema.string().role('textarea').default('Concise, factual, chronological, and concrete.').description('压缩结果的表达风格。'),
  }) as unknown as Schema<CompactionConfig>).default({ enabled: true, modelId: '', providerId: '', model: '', temperature: 0.3, topP: 1, maxTokens: 2048, timeout: 60_000, responseFormat: 'json-object', mainPrompt: 'Compress completed scenes into concise continuity notes while preserving causality, promises, unresolved matters, and gradual character change.', fixedPrompt: '', stylePrompt: 'Concise, factual, chronological, and concrete.' }),
})

const RestWindowSchema: Schema<RestWindow> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用该休息窗口。'),
  label: Schema.string().default('night sleep').description('窗口名称，仅用于识别。'),
  start: Schema.string().pattern(/^\d{1,2}:\d{2}$/).default('23:00').description('窗口开始时间，格式 HH:mm。'),
  end: Schema.string().pattern(/^\d{1,2}:\d{2}$/).default('07:00').description('窗口结束时间，格式 HH:mm；可跨午夜。'),
  minIntervalMinutes: Schema.natural().min(30).max(1_440).default(120).description('窗口内自动推进的最短间隔。'),
  maxIntervalMinutes: Schema.natural().min(30).max(1_440).default(240).description('窗口内自动推进的最长间隔。'),
})

const Runtime: Schema<RuntimeConfig> = Schema.object({
  splitReplyMessages: Schema.boolean().default(true).description('是否将主模型回复中的 <sep/> 拆成多条 QQ 消息。'),
  messageSeparator: Schema.string().default('<sep/>').description('分段消息标记。通常保持 <sep/>；模型会在需要多条气泡时输出它。'),
  typingBaseDelaySeconds: Schema.number().min(0).max(60).default(1).description('发送第二条及后续分段消息前的基础打字等待秒数。'),
  typingCharactersPerSecond: Schema.number().min(1).max(100).default(8).description('模拟打字速度，每秒字符数；数值越小，长消息等待越久。'),
  typingMaxDelaySeconds: Schema.number().min(0).max(120).default(12).description('单条后续分段消息的最长打字等待秒数。'),
  userMessageDebounceSeconds: Schema.number().min(0).max(15).default(2).description('短消息合并等待：每次收到私聊后，等待这段时间再请求主模型；期间的新消息会合并进同一次写作。设为 0 可关闭。'),
  narrativeRetryDelaySeconds: Schema.natural().min(5).max(3_600).default(60).description('叙事模型请求失败后，自动再次尝试处理该用户回合前等待的秒数。'),
  narrativeRetryMaxAttempts: Schema.natural().min(0).max(50).default(6).description('单次用户回合因模型失败可自动重试的最多次数；0 表示关闭。'),
  captureDirectMessages: Schema.boolean().default(true).description('是否拦截并处理私聊文本消息。'),
  autoCreate: Schema.boolean().default(false).description('无主剧本时是否从当前 Console 档案自动启动；关闭后先用 interlude.doctor 检查，再执行 interlude.story.start。'),
  ignoreCommandMessages: Schema.boolean().default(true).description('是否跳过 interlude.* 管理命令，避免进入剧本。'),
  allowProactiveMessages: Schema.boolean().default(false).description('是否允许无新消息时向参与者主动发送可见消息。'),
  proactiveWillingnessThreshold: Schema.number().min(0).max(1).step(0.05).default(0.65).description('主动联系意愿门槛。自动推进时由主模型为每次联系给出 0~1 的意愿值，低于此值不发送；没有固定冷却。'),
  sweepIntervalMinutes: Schema.natural().min(1).max(1_440).default(5).description('后台扫描周期；仅用于发现到期任务，不代表每轮都调用模型。'),
  minimumAdvanceMinutes: Schema.natural().min(1).max(10_080).default(30).description('手动“interlude.advance”的最小有效补写间隔；到期计划和对话后的短期补写不受此限制。'),
  maxStoriesPerSweep: Schema.natural().min(1).max(1_000).default(20).description('单轮后台扫描最多处理的主剧本数量。'),
  contextEntryLimit: Schema.natural().min(1).max(200).default(30).description('主模型读取的最近剧本条目数；越大越耗 token。'),
  memoryLimit: Schema.natural().min(1).max(200).default(20).description('主模型读取的长期事实数量；会经过相关性重排。'),
  maxScriptCharacters: Schema.natural().min(500).max(12_000).default(8_000).description('单次写作允许追加的剧本文本上限。'),
  maxMessageCharacters: Schema.natural().min(1).max(12_000).default(2_000).description('单条可见消息的最大字符数。'),
  minimumDelayedReplySeconds: Schema.natural().min(0).max(86_400).default(10).description('模型允许设置的最短延迟，单位秒。'),
  maximumDelayedReplyMinutes: Schema.natural().min(1).max(43_200).default(1_440).description('模型允许设置的最长延迟，单位分钟。'),
  cancelDelayedRepliesOnUserMessage: Schema.boolean().default(true).description('新消息到达时取消普通延迟回复和跨关系计划；未发送的 <sep/> 分段无论此开关如何都会被截断并进入替代写作上下文。'),
  autoAdvanceEnabled: Schema.boolean().default(true).description('无对话时是否按真实时间补写角色生活。'),
  autoAdvanceIntervalMinutes: Schema.natural().min(5).max(1_440).default(40).description('普通时段自动推进的目标间隔，单位分钟。'),
  autoAdvanceJitterMinutes: Schema.natural().min(0).max(60).default(5).description('自动推进间隔的随机浮动范围，单位分钟。'),
  conversationFollowUpMinutes: Schema.array(Schema.natural().min(1).max(240)).default([10, 20]).description('一段对话结束后，额外补写生活的时间点，单位分钟。默认约第 10、20 分钟。'),
  conversationFollowUpJitterMinutes: Schema.natural().min(0).max(10).default(1).description('短期补写的随机浮动范围，单位分钟。填 0 可固定在指定时间点。'),
  restWindows: Schema.array(RestWindowSchema).role('table').default([
    { enabled: true, label: 'night sleep', start: '23:00', end: '07:00', minIntervalMinutes: 120, maxIntervalMinutes: 240 },
  ]).description('可配置多个低频推进窗口，例如睡眠或午休。'),
})

const BlindMode: Schema<BlindModeConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('沉浸运行：静默命令与 HDSI 日志，仅保留健康心跳。稳定后开启；关闭并重载即可恢复管理。'),
  healthReportMinutes: Schema.natural().min(1).max(1_440).default(10).description('健康心跳间隔，单位分钟。'),
}).description('0. 失明模式：沉浸式运行、命令静默与最小健康心跳。')

const Agency: Schema<AgencyConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('启用主体行动窗口。它只判断日程、隐私、设备和生活来源的联系理由，不读取或复用 Alter 情绪值。'),
  maxWindowMinutes: Schema.natural().min(5).max(1_440).default(240).description('一张 Agency Window 最长有效时间；过期后必须由新的生活回合重新判断。'),
  minimumProactiveIntervalMinutes: Schema.natural().min(0).max(10_080).default(60).description('同一参与者两次普通主动联系之间的安全间隔；承诺型联系可以绕过。'),
  maxCandidateHours: Schema.natural().min(1).max(168).default(24).description('生活产生的主动联系候选最长保留时间；过期后自然放下。'),
})

const AlterSystem: Schema<AlterSystemConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('启用情绪偏移追踪。它只增加临时氛围参考，不替代 recentScript、continuity 或稳定设定。'),
  baseThreshold: Schema.number().min(1).max(50).default(10).description('Alter 累计绝对值达到此基础阈值时调用侧端分析模型。'),
  densityFactor: Schema.number().min(0).max(1).step(0.05).default(0.3).description('最近一小时叙事越密集，阈值降低的比例越大；运行时最低不会低于基础阈值的一半。'),
  sameDirectionBoost: Schema.number().min(0).max(1).step(0.01).default(0.05).description('新变化与上次触发方向一致时，每点 Alter 增加的提示权重。'),
  oppositeDecay: Schema.number().min(0).max(1).step(0.01).default(0.15).description('新变化与上次触发方向相反时，每点 Alter 衰减的提示权重。'),
  minWeight: Schema.number().min(0).max(1).step(0.05).default(0.2).description('权重低于该值时清除当前 emotionalOffset。'),
  maxIntensity: Schema.number().min(1).max(3).step(0.1).default(2).description('触发值超过阈值时允许的最大情绪偏移强度。'),
  temperature: Schema.number().min(0).max(2).step(0.1).default(0.3).description('侧端分析温度。较低值能保持描述稳定而不过度发挥。'),
  topP: Schema.number().min(0).max(1).step(0.05).default(1).description('侧端分析 top_p。'),
  maxTokens: Schema.natural().min(64).max(2_000).default(400).description('侧端分析最大输出 token；只需要一到两句话。'),
  timeout: Schema.natural().min(1_000).max(120_000).default(30_000).role('ms').description('侧端分析超时。失败时保留累计值，稍后重试。'),
  prompt: Schema.string().role('textarea').default('').description('侧端分析的附加要求；不能覆盖固定的 JSON、隐私和非指令化约束。'),
})

const Browser: Schema<BrowserConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('启用 Puppeteer 只读网页观察。还需要在 Koishi 安装并启用 puppeteer 插件；未启用时聊天功能不受影响。'),
  mode: Schema.union(['deferred-only', 'allow-immediate']).default('deferred-only').description('延后浏览不会增加当前回复等待；允许即时浏览时，主模型可为少数当前私聊额外读取一次网页，因此回复会更慢。'),
  allowSearch: Schema.boolean().default(true).description('允许主角提出网页搜索意图。搜索结果会作为之后的网页观察进入剧本。'),
  allowVisit: Schema.boolean().default(true).description('允许主角访问安全策略允许的公开网页 URL。不会登录、填写表单、下载或发布内容。'),
  searchUrlTemplate: Schema.string().default('https://html.duckduckgo.com/html/?q={query}').description('搜索地址模板，必须包含 {query}。默认使用 DuckDuckGo 的轻量结果页。'),
  allowedDomains: Schema.array(Schema.string()).role('table').default([]).description('允许访问的域名白名单；留空表示不额外限制。填入后，仅这些域名及其子域名可访问。'),
  blockedDomains: Schema.array(Schema.string()).role('table').default([]).description('永远禁止访问的域名黑名单；localhost、私网地址和非 HTTP(S) 地址始终禁止。'),
  maxConcurrentPages: Schema.natural().min(1).max(4).default(1).description('同时打开的网页页数上限。建议保持 1，避免浏览器占用影响 Koishi。'),
  maxResearchPerSweep: Schema.natural().min(1).max(20).default(1).description('每轮后台最多处理的网页浏览意图数。保持 1 可避免网页积压拖慢剧本队列。'),
  navigationTimeout: Schema.natural().min(1_000).max(120_000).default(15_000).role('ms').description('单页加载超时，单位毫秒。超时会记录失败观察，不会中断剧本。'),
  waitUntil: Schema.union(['domcontentloaded', 'networkidle2']).default('domcontentloaded').description('读取网页的等待条件。domcontentloaded 更快；networkidle2 对动态页面更完整但更慢。'),
  maxTextCharacters: Schema.natural().min(500).max(50_000).default(12_000).description('从网页正文提取的最大字符数。仅提取可见文本，不保存 HTML。'),
  maxExcerptCharacters: Schema.natural().min(200).max(12_000).default(3_000).description('单条网页观察送给主模型的最大字符数。'),
  maxObservationsInPrompt: Schema.natural().min(1).max(20).default(4).description('单次主叙事请求附带的最近网页观察数量。'),
  cacheMinutes: Schema.natural().min(0).max(10_080).default(30).description('相同搜索或 URL 在此时间内复用已有观察，减少重复浏览；0 表示每次重新读取。'),
  allowGroupTriggeredResearch: Schema.boolean().default(false).description('允许群聊主叙事产生浏览意图。默认关闭，避免群成员内容触发角色浏览。'),
  logObservationPreview: Schema.boolean().default(false).description('在日志中显示网页观察的标题和节选；网页内容可能包含隐私或不可信文本，生产环境建议关闭。'),
})

const Memory: Schema<MemoryConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('启用场景压缩、长期事实和状态演化。'),
  backgroundIntervalMinutes: Schema.natural().min(1).max(1_440).default(10).description('后台记忆整理检查周期，单位分钟。'),
  sceneEntryThreshold: Schema.natural().min(1).max(500).default(16).description('未压缩剧本条目达到此数量时触发整理。默认 16 条，减少短对话中的频繁后台调用。'),
  sceneCharacterThreshold: Schema.natural().min(500).max(200_000).default(10_000).description('未压缩剧本字符数达到此值时触发整理。默认 10000 字，长场景会优先保持连续性。'),
  recentEntryLimit: Schema.natural().min(1).max(200).default(30).description('每次主模型请求附带的最近原始条目数。'),
  factLimit: Schema.natural().min(1).max(200).default(20).description('每次主模型请求附带的长期事实数。'),
  statePatchConfidenceThreshold: Schema.number().min(0).max(1).default(0.82).description('普通设定变更的最低置信度；低于此值只保留为候选。'),
  majorStatePatchConfidenceThreshold: Schema.number().min(0).max(1).default(0.95).description('重大设定变更的最低置信度。'),
  statePatchMinEvidence: Schema.natural().min(1).max(20).default(3).description('兼容旧配置；普通变化至少需要的证据回合数下限。运行时不会低于 3。'),
  statePatchMinTurns: Schema.natural().min(3).max(20).default(3).description('普通人格或关系变化至少需要来自多少个不同剧本回合。'),
  statePatchMinDays: Schema.natural().min(1).max(30).default(2).description('普通变化至少要跨越多少个日历日；重大事件不受此限制。'),
  statePatchCooldownHours: Schema.natural().min(1).max(720).default(72).description('同一人格或关系路径应用一次长期变化后，多少小时内不再应用新的变化。'),
  maxFactsPerStory: Schema.natural().min(10).max(2_000).default(200).description('单个主剧本保留的长期事实总量上限。'),
  maxStoriesPerCompactionRun: Schema.natural().min(1).max(1_000).default(20).description('单轮后台整理最多处理的主剧本数。'),
  compactionEntryLimit: Schema.natural().min(1).max(500).default(80).description('压缩模型单次读取的最大剧本条目数。'),
  compactionCharacterLimit: Schema.natural().min(500).max(200_000).default(32_000).description('压缩模型单次读取的最大字符数。'),
  sceneHookCharacters: Schema.natural().min(100).max(10_000).default(2_000).description('场景引子的最大字符数。'),
  sceneSummaryCharacters: Schema.natural().min(500).max(50_000).default(8_000).description('场景摘要的最大字符数。'),
  arcSummaryCharacters: Schema.natural().min(500).max(100_000).default(12_000).description('剧情弧线摘要的最大字符数。'),
  factContentCharacters: Schema.natural().min(100).max(20_000).default(4_000).description('单条长期事实的最大字符数。'),
  factImportanceWeight: Schema.number().min(0).max(1).default(0.5).description('事实排序中的重要度权重。'),
  factConfidenceWeight: Schema.number().min(0).max(1).default(0.35).description('事实排序中的置信度权重。'),
  factRecencyWeight: Schema.number().min(0).max(1).default(0.15).description('事实排序中的时间衰减权重。'),
  semanticWeight: Schema.number().min(0).max(2).default(0.55).description('启用 Embedding 后的语义相关度权重。'),
  unresolvedWeight: Schema.number().min(0).max(2).default(0.2).description('未解决事项的额外排序权重。'),
  autoApplyStatePatches: Schema.boolean().default(true).description('是否自动应用达到门槛的设定演化建议。'),
  allowMajorStateChanges: Schema.boolean().default(true).description('是否允许自动应用重大人物或世界状态变更。'),
  activeConsequencesEnabled: Schema.boolean().default(true).description('启用“剧情余波”：让确实影响后续生活的谈话或事件，在之后的写作中持续发挥短期作用。关闭后不会新增或注入余波。'),
  activeConsequencePromptLimit: Schema.natural().min(1).max(20).default(6).description('单次主模型写作最多携带几条仍在生效的剧情余波。数值越高，连续性更强，但会增加少量上下文。'),
  activeConsequenceMaxDays: Schema.natural().min(1).max(30).default(7).description('一条剧情余波最长保留多少天。到期后会自然淡出；它不用于永久修改角色设定。'),
  activeConsequenceDefaultStrength: Schema.number().min(0).max(1).step(0.05).default(0.55).description('剧情余波未写明强度时的默认影响程度。0 表示极轻微，1 表示会明显影响主角近期生活。'),
  overlayCompressionEnabled: Schema.boolean().default(true).description('将较久以前、已应用的人设和关系变化压缩为分层摘要；不会改变 Canon 或删除原始补丁。'),
  overlayRecentDays: Schema.natural().min(1).max(14).default(2).description('最近多少天的 overlay 变化保留原始细节，不进入压缩。默认 2 天。'),
  overlayMonthlyAfterDays: Schema.natural().min(5).max(180).default(10).description('超过多少天后，将短期摘要合并为长期状态。默认 10 天。'),
  overlayWeeklyWindowDays: Schema.natural().min(1).max(14).default(5).description('短期 overlay 摘要的合并窗口。默认每 5 天合并一次。'),
  overlayMonthlyWindowDays: Schema.natural().min(5).max(30).default(10).description('长期 overlay 状态的合并窗口。默认每 10 天合并一次。'),
  overlayWeeklySummaryCharacters: Schema.natural().min(300).max(8_000).default(1_600).description('单个七天 overlay 摘要的最大字符数。'),
  overlayMonthlySummaryCharacters: Schema.natural().min(300).max(12_000).default(2_400).description('单个长期 overlay 摘要的最大字符数。'),
})

const StoryDefaults: Schema<StoryDefaults> = Schema.object({
  characterName: Schema.string().default('Unnamed character').description('主角显示名称。'),
  characterProfile: Schema.string().role('textarea').default('').description('主角的背景、性格、日程和说话方式；作为故事起点，不是永久锁定的人设。若这里发生大幅修改，请保存后执行 interlude.overlay.clear character，随后按提示输入 y 确认；小幅补充、措辞调整或细节修正无需其它操作。'),
  perspective: Schema.string().role('textarea').default('').description('主角个体价值观 / 看待世界的方式：独立于 Canon 的外壳人格层，描述她面对人和事件时稳定的理解习惯。仅在相关情境中自然影响判断；可由 perspective overlay 随长期剧情演化。新故事创建时写入。'),
  userProfile: Schema.string().role('textarea').default('').description('未单独配置参与者时使用的默认用户资料；可被白名单行覆盖。'),
  relationship: Schema.string().role('textarea').default('').description('未单独配置参与者时使用的初始关系；可被白名单行覆盖。大幅改变关系定位时执行 interlude.overlay.clear relationship，随后按提示输入 y 确认；小幅调整无需处理。'),
  world: Schema.string().role('textarea').default('').description('故事时代、地点和现实规则；作为剧本的初始世界状态。若大幅改写世界前提，请执行 interlude.overlay.clear world，随后按提示输入 y 确认；小幅补充无需处理。'),
  supportingCast: Schema.string().role('textarea').default('').description('配角及其与主角的关系；无配角可留空。'),
  location: Schema.string().default('').description('主角的主要活动地点。'),
  style: Schema.string().role('textarea').default('现实主义日常叙事，情绪克制，关系变化缓慢而具体。').description('该主剧本的文风；优先级高于全局 stylePrompt。'),
  timezone: Schema.string().default('Asia/Shanghai').description('用于自动推进、休息窗口和延迟时间解析的 IANA 时区。'),
})

const Logging: Schema<LoggingConfig> = Schema.object({
  level: Schema.union(['silent', 'error', 'warn', 'info', 'debug']).default('info').description('错误级别阈值。日常运行建议保持 info；排查异常时临时使用 debug。'),
  verbosity: Schema.union(['summary', 'standard', 'diagnostic']).default('standard').description('运行信息密度：摘要只显示关键结果；标准显示模型、计时器和后台任务；诊断追加跳过原因、队列和上下文统计。'),
  format: Schema.union(['layered', 'compact', 'detailed']).default('layered').description('显示布局：layered 为彩色任务时间线；compact 为单行；detailed 为兼容旧版的分行格式。'),
  colors: Schema.boolean().default(true).description('为阶段、完成、警告、错误、记忆和 Alter 添加 ANSI 语义颜色；Koishi Console 与常规终端均可渲染。'),
  colorTheme: Schema.union(['dark', 'light']).default('dark').description('layered 的高对比配色：dark 适合深色 Console；light 使用更深颜色，适合白色或明亮背景。服务端无法自动判断 Console 主题，请按界面手动选择。'),
  kaomoji: Schema.boolean().default(true).description('使用固定颜文字标识接收、处理、完成、投递等动作；关闭后改用简洁符号。'),
  logScriptPreview: Schema.boolean().default(false).description('是否输出本轮剧本内容；可能包含私聊信息，生产环境建议关闭。'),
  logMessageContent: Schema.boolean().default(false).description('是否输出用户消息和主角可见消息内容；涉及隐私，生产环境建议关闭。'),
  previewLength: Schema.natural().min(50).max(4_000).default(500).description('剧本和消息内容写入日志时的最大字符数。'),
})

const OneBotBotAccount: Schema<OneBotAccountRule> = Schema.object({
  qq: Schema.string().default('').description('机器人 QQ 号；为空表示不限制发送账号。'),
  label: Schema.string().default('').description('账号备注，仅用于识别。'),
  enabled: Schema.boolean().default(true).description('是否允许此机器人账号投递角色消息。'),
})

// The allowlist is also the identity sheet for the shared story. Each row is
// a collapsible card, so the two long narrative fields get full-width editors.
const OneBotUserAccount: Schema<OneBotAccountRule> = Schema.object({
  qq: Schema.string().default('').description('允许互动的用户 QQ；未列出的账号直接拒绝。'),
  label: Schema.string().default('').description('主角对该用户的称呼；留空时使用平台昵称。'),
  personId: Schema.string().default('').description('稳定的人物标识；同一现实人物的多个账号可复用。'),
  profile: Schema.string().role('textarea').default('').description('主角已知的用户背景；仅用于该关系分支。'),
  relationship: Schema.string().role('textarea').default('').description('该用户与主角的初始关系，例如“熟悉但近来联系不多”。'),
  enabled: Schema.boolean().default(true).description('是否接受该账号的私聊并允许向其投递消息。'),
}).collapse(true)

const GroupWillingness: Schema<GroupWillingnessConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('启用本地群聊意愿门，不增加模型调用。'),
  maxScore: Schema.number().min(0.1).max(10).step(0.05).default(1).description('意愿累积上限。'),
  threshold: Schema.number().min(0).max(10).step(0.01).default(0.24).description('低于此分数时保持静默。'),
  probabilityAmplifier: Schema.number().min(0).max(10).step(0.05).default(1.3).description('超过阈值后的发言概率增幅。'),
  decayHalfLifeSeconds: Schema.natural().min(10).max(86_400).default(180).description('意愿自然衰减到一半所需秒数。'),
  replyCost: Schema.number().min(0).max(10).step(0.05).default(0.55).description('主角成功在群内发言后扣除的意愿。'),
  baseGain: Schema.number().min(0).max(10).step(0.01).default(0.12).description('每批普通群消息带来的基础意愿。'),
  quoteGain: Schema.number().min(0).max(10).step(0.01).default(0.12).description('引用机器人消息时的额外意愿。'),
  keywordGain: Schema.number().min(0).max(10).step(0.01).default(0.18).description('命中关键词时的额外意愿。'),
  keywords: Schema.array(Schema.string()).role('table').default([]).description('命中后增加群聊意愿。'),
}).collapse(true)

const GroupChatRuleSchema: Schema<GroupChatRule> = (Schema.object({
  groupId: Schema.string().default('').description('QQ 群号。只有列在这里且启用的群会被插件处理。'),
  label: Schema.string().default('').description('群聊备注，帮助主模型理解这个群。'),
  enabled: Schema.boolean().default(true).description('是否允许插件读取并参与这个群。'),
  purpose: Schema.string().role('textarea').default('').description('这个群主要做什么，例如“同事讨论项目”或“朋友闲聊”。'),
  characterRole: Schema.string().role('textarea').default('').description('主角在群里的身份和说话位置。'),
  responseMode: Schema.union(['mention-only', 'always']).default('mention-only').description('mention-only: 仅在被 @ 时触发主叙事；always: 所有群消息都触发主叙事'),
  contextLimit: Schema.natural().min(4).max(100).default(20).description('进入主叙事时附带的最近群消息条数。'),
  debounceSeconds: Schema.number().min(0).max(10).default(1).description('合并短时间连续群消息后再开始主叙事的等待秒数。'),
  cooldownSeconds: Schema.natural().min(0).max(86_400).default(60).description('主角群发言后的冷却时间，避免连续刷屏。'),
  willingness: GroupWillingness.default({ enabled: false, maxScore: 1, threshold: 0.24, probabilityAmplifier: 1.3, decayHalfLifeSeconds: 180, replyCost: 0.55, baseGain: 0.12, quoteGain: 0.12, keywordGain: 0.18, keywords: [] }).description('群聊本地意愿门；@ 机器人直接通过。'),
}) as unknown as Schema<GroupChatRule>).collapse(true)

const VoiceTranscription: Schema<import('./service').VoiceTranscriptionConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('SnowLuma 私聊语音转写，默认关闭。'),
  timeoutMs: Schema.natural().min(1_000).max(60_000).default(20_000).role('ms').description('单条语音转写等待上限。'),
}).collapse(true)

const OneBot: Schema<OneBotNapCatConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('启用 OneBot/NapCat 账号过滤。'),
  botAccounts: Schema.array(OneBotBotAccount).role('table').default([]).description('允许处理和投递角色消息的机器人账号。启用过滤时，空表拒绝所有机器人账号。'),
  userAccounts: Schema.array(OneBotUserAccount).default([]).description('用户白名单及关系初始化表；纵向卡片便于填写人物资料和关系文本。空表拒绝所有私聊用户。'),
  groupChats: Schema.array(GroupChatRuleSchema).default([]).description('群聊白名单。每个群以可折叠卡片显示，适合填写群用途和角色定位。群成员无需重复加入私聊用户白名单。'),
  ignoreSelfMessages: Schema.boolean().default(true).description('忽略机器人自身产生的消息事件。'),
  voiceTranscription: VoiceTranscription.default({ enabled: false, timeoutMs: 20_000 }).description('SnowLuma 语音转写：仅处理当前私聊 record 语音，并以文本形式进入现有剧本流程。'),
})

const ChatActions: Schema<ChatActionsConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('启用聊天动作能力层。关闭时不会向主模型增加任何动作字段。'),
  platforms: Schema.array(Schema.union(['qq', 'wechat'])).role('table').default(['qq']).description('允许使用聊天动作的平台，可同时选择。平台还必须有已注册、在线的能力连接器。'),
  quoteReply: Schema.boolean().default(true).description('允许主角引用当前上下文中的一条消息进行指定回复。'),
  messageReactions: Schema.boolean().default(true).description('允许主角给当前上下文中的消息贴一个表情回应；当前内置实现为 QQ 群聊。'),
  allowedReactions: Schema.array(Schema.union(['like', 'smile', 'laugh', 'heart', 'surprised', 'sad', 'angry'])).role('table')
    .default(['like', 'smile', 'laugh', 'heart'] as ChatReactionName[])
    .description('主模型可以选择的语义表情；平台连接器负责转换为实际表情编号。'),
  nativeFaces: Schema.boolean().default(true).description('允许主角在需要时发送 QQ 原生小表情。'),
  expressionThreshold: Schema.number().min(0).max(1).step(0.05).default(0.7).description('表情与本地表情包的最低表达意愿；低于此值只发送文字。'),
  allowedNativeFaces: Schema.array(Schema.union(['smile', 'laugh', 'sweat', 'awkward', 'heart', 'surprised', 'sad', 'angry'])).role('table')
    .default(['smile', 'laugh', 'sweat', 'awkward'] as NativeFaceSemantic[])
    .description('允许主模型使用的 QQ 原生表情语义。'),
})

const Stickers: Schema<StickerLibraryConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('启用本地表情包库。关闭时不扫描目录、不调用视觉模型，也不向主模型提供素材。'),
  directory: Schema.path({ allowCreate: true, filters: ['directory'] }).default('data/hds-interlude/stickers').description('本地表情包根目录；一级子文件夹会成为素材分组。'),
  maxFileSizeMB: Schema.natural().min(1).max(30).default(10).description('单个表情包允许扫描的最大体积，单位 MB。'),
  catalogLimit: Schema.natural().min(1).max(80).default(40).description('单次主模型最多读取多少条表情包描述。'),
})

const SharedStory: Schema<SharedStoryConfig> = Schema.object({
  autoEnrollParticipants: Schema.boolean().default(true).description('白名单用户首次私聊时是否自动加入主剧本。'),
  allowCrossConversationMessages: Schema.boolean().default(true).description('是否允许主模型向其它参与者生成跨账号消息。'),
  shareParticipantDetails: Schema.boolean().default(false).description('是否向模型提供其它参与者的历史剧本；关系字段始终匿名，涉及隐私请谨慎开启。'),
  maxCrossConversationActions: Schema.natural().min(0).max(5).default(1).description('单次主模型回合最多执行的跨账号投递动作。'),
  participantContextLimit: Schema.natural().min(1).max(20).default(6).description('单次请求附带的其它参与者上下文数量。'),
  managerAccounts: Schema.array(Schema.string()).role('table').default([]).description('可执行管理命令的 QQ；留空表示所有已授权用户。'),
})

export const Config: Schema<InterludeConfig> = Schema.object({
  blindMode: BlindMode,
  storyDefaults: StoryDefaults.description('1. 剧本起点：主角、世界、默认关系、地点、时区和叙事风格。'),
  model: Model.description('2. 模型：服务商、模型预设、主叙事、压缩、Embedding 与视觉输入。'),
  onebot: OneBot.description('3. OneBot/NapCat：机器人账号、私聊白名单和群聊白名单。'),
  chatActions: ChatActions.default({ enabled: false, platforms: ['qq'], quoteReply: true, messageReactions: true, allowedReactions: ['like', 'smile', 'laugh', 'heart'], nativeFaces: true, expressionThreshold: 0.7, allowedNativeFaces: ['smile', 'laugh', 'sweat', 'awkward'] }).description('4. 聊天动作：按平台启用指定回复与消息表情；只有已注册能力才进入提示词。'),
  stickers: Stickers.default({ enabled: false, directory: 'data/hds-interlude/stickers', maxFileSizeMB: 10, catalogLimit: 40 }).description('5. 本地表情包：每五分钟扫描新增素材，并由勾选 useForStickers 的视觉模型生成描述。'),
  sharedStory: SharedStory.description('6. 共享剧本：参与者加入、跨账号行为和管理员权限。'),
  runtime: Runtime.description('6. 对话与时间：消息合并、回复投递、失败重试和自动生活推进。'),
  agency: Agency.description('7. Agency Window：日程压力、隐私、设备可用性和生活来源的主动联系。'),
  memory: Memory.description('8. 连续性与记忆：场景压缩、事实召回、剧情余波和设定演化。'),
  alterSystem: AlterSystem.description('9. Alter System：低频氛围偏移、动态阈值、权重和侧端分析模型。'),
  browser: Browser.description('10. 网页观察：Puppeteer 只读浏览与安全边界。'),
  logging: Logging.description('11. 日志：级别、信息密度、布局和隐私预览。'),
})

export function apply(ctx: Context, config: InterludeConfig) {
  const startupLogger = ctx.logger('hds-interlude')
  const blindModeEnabled = config.blindMode?.enabled === true || config.blackBox?.enabled === true
  if (!blindModeEnabled) startupLogger.info('plugin load started version=%s', HDS_INTERLUDE_VERSION)
  const service = new InterludeService(ctx, config)
  if (blindModeEnabled) {
    // Registered commands from every plugin reach this hook before their
    // action runs. Returning an empty fragment consumes them silently.
    ctx.on('command/before-execute', () => '')
  } else {
    registerCommands(ctx, service)
  }

  ctx.middleware(async (session, next) => {
    if (!session.content?.trim() && !extractSessionVoiceCount(session)) return next()
    if (blindModeEnabled && looksLikeInterludeCommand(session.content)) return
    // Management commands must remain visible to Koishi's command parser,
    // including when they are sent inside an authorized group.
    if (config.runtime.ignoreCommandMessages && looksLikeInterludeCommand(session.content)) return next()
    if (!session.isDirect) {
      const consumed = await service.receiveGroup(session)
      return consumed ? undefined : next()
    }
    if (!config.runtime.captureDirectMessages) return next()
    const consumed = await service.receive(session)
    return consumed ? undefined : next()
  })
  if (!blindModeEnabled) startupLogger.info('plugin load completed')
}

function registerCommands(ctx: Context, service: InterludeService) {
  ctx.command('interlude', 'HDS Interlude：私聊故事测试与管理命令')

  const startStoryFromConsole = async (session: Session, legacyName?: string) => {
    if (!requireManager(service, session)) return '无权限：手动启动共享主剧本需要 HDSI 管理员权限。'
    const readiness = await service.storyStartReadiness(session)
    if (readiness.existing) return `当前已有 ${readiness.existing.setting.character.name} 的活动主剧本；请使用 interlude.status 查看状态。`
    if (!readiness.ready) return formatStoryStartReadiness(readiness, 'Console 档案尚未适合启动')
    const preview = readiness.preview
    const legacyNote = legacyName?.trim() ? `\n已忽略旧 init 的名称参数“${legacyName.trim()}”；角色名称以 Console 为准。` : ''
    const message = [
      '即将从当前 Console 档案启动故事：',
      `主角：${preview.characterName}`,
      `角色设定：${preview.characterProfile ? '已填写' : '未填写'}`,
      `Perspective：${preview.perspective ? '已填写' : '未填写'}`,
      `世界与地点：${preview.world ? '已填写' : '未填写'}`,
      `时区：${preview.timezone}`,
      `主模型：${preview.model}`,
      `自动创建：${preview.autoCreate ? '开启（首次私聊通常无需手动启动）' : '关闭'}`,
      ...readiness.warnings.map(warning => `提示：${warning}`),
      legacyNote,
    ].filter(Boolean).join('\n')
    if (!await askConfirmation(session, `${message}\n确认从此档案启动吗？(y/n)`)) return '操作已取消。'
    const story = await service.createStory(session)
    const participant = await service.findParticipant(session, story)
    return `已从 Console 档案启动 ${story.setting.character.name} 的共享主剧本，并加入 ${participant?.displayName || session.userId}。`
  }

  ctx.command('interlude.doctor', '检查当前 Console 档案、权限与模型是否适合启动故事')
    .action(async ({ session }) => formatStoryStartReadiness(await service.storyStartReadiness(session)))

  ctx.command('interlude.story.start', '管理员：从当前 Console 档案手动启动第一份运行中故事')
    .action(async ({ session }) => startStoryFromConsole(session))

  ctx.command('interlude.init [legacyName:text]', '兼容别名：请改用 interlude.story.start；名称参数已忽略')
    .action(async ({ session }, legacyName) => startStoryFromConsole(session, legacyName))

  ctx.command('interlude.setup <json:text>', '高级：用 JSON 单独修改当前故事设定；普通测试请优先在 Console 填 storyDefaults')
    .action(async ({ session }, json) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。请在 Console 的 sharedStory.managerAccounts 中添加此 QQ，或留空允许所有获授权账号。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      try {
        const patch = JSON.parse(json) as Partial<StorySetting>
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设定必须是 JSON 对象。普通测试无需使用此命令。')
        const updated = await service.updateSetting(story, patch)
        return `已保存 ${updated.setting.character.name} 的当前故事设定。`
      } catch (error) {
        return `JSON 格式不正确：${(error as Error).message}`
      }
    })

  ctx.command('interlude.status', '查看当前故事是否启用、主角、游标和主动消息开关')
    .action(async ({ session }) => {
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      return [
        `主角：${story.setting.character.name}`,
        `关系人数：${(await service.participants(story.id)).length}`,
        `故事状态：${story.status}`,
        `已写到：${story.cursorAt.toISOString()}`,
        `模型模式：${service.config.model.mode}`,
        `允许主动可见消息：${service.config.runtime.allowProactiveMessages ? '开启' : '关闭'}`,
        `Agency Window：${service.config.agency?.enabled === false ? '关闭' : '开启'}（${story.state.agencyWindow?.activityLoad || '尚未建立'}）`,
      ].join('\n')
    })

  ctx.command('interlude.pause', '暂停当前故事的自动处理，不删除任何记录')
    .action(async ({ session }) => changeStatus(service, session, 'paused'))

  ctx.command('interlude.resume', '恢复当前故事的自动处理')
    .action(async ({ session }) => changeStatus(service, session, 'active'))

  ctx.command('interlude.advance', '手动把故事补写到现在；用于测试自动生活推进')
    .action(async ({ session }) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const messages = await service.advanceStory(story)
      await service.deliverMessages(story, messages, session)
      return messages.length ? '剧本已补写到现在，并已发送其中已经发生的可见角色消息。' : '剧本已补写到现在；这次没有发生可见角色消息。'
    })

  ctx.command('interlude.timeline [limit:number]', '查看最近剧本记录；limit 为条数，默认 10')
    .action(async ({ session }, limit = 10) => {
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const participant = await service.findParticipant(session, story)
      const entries = (await service.recentEntries(story.id, Math.max(1, Math.min(limit * 3, 90))))
        .filter(entry => !entry.participantId || entry.participantId === participant?.id)
        .slice(-Math.max(1, Math.min(limit, 30)))
      if (!entries.length) return '当前故事还没有剧本记录。'
      return entries.map(entry => `[${entry.occurredAt.toISOString()}] ${entry.actor}/${entry.kind}: ${entry.content}`).join('\n')
    })

  ctx.command('interlude.memory [limit:number]', '查看主模型提取出的耐久记忆；limit 为条数，默认 10')
    .action(async ({ session }, limit = 10) => {
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const participant = await service.findParticipant(session, story)
      const memories = await service.memories(story.id, Math.max(1, Math.min(limit, 30)), participant?.id)
      if (!memories.length) return '暂时还没有提取出耐久记忆；多进行一些对话并等待后台整理后再看。'
      return memories.map(memory => `[${memory.category}/${memory.importance.toFixed(2)}] ${memory.content}`).join('\n')
    })

  ctx.command('interlude.context', '查看场景摘要、剧情弧线、人物变化覆写和长期事实')
    .action(async ({ session }) => {
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const participant = await service.findParticipant(session, story)
      const [scene, arc, facts] = await Promise.all([
        service.activeScene(story.id), service.activeArc(story.id), service.facts(story.id, 8, '', participant?.id),
      ])
      return [
        `场景引子：${scene?.hook || '尚未整理'}`,
        `场景摘要：${scene?.summary || '尚未整理'}`,
        `剧情弧线：${arc?.title || '开场'} — ${arc?.summary || '尚未整理'}`,
        `当前关系：${participant?.displayName || session.userId}（${participant?.relationship || '未填写'}）`,
        `当前关系状态：${JSON.stringify(participant?.state ?? {})}`,
        `主角个体价值观 / 看待世界的方式：${story.setting.perspective || '未填写'}（当前 overlay：${story.state.settingOverlay?.perspective || '未形成'}）`,
        `主角全局变化：${JSON.stringify(story.state.settingOverlay ?? {})}`,
        `主体行动窗口：${JSON.stringify(story.state.agencyWindow ?? null)}`,
        `长期事实：${facts.length ? facts.map(fact => `[${fact.scope}/${fact.importance.toFixed(2)}] ${fact.content}`).join(' | ') : '暂无'}`,
      ].join('\n')
    })

  ctx.command('interlude.compact', '立即整理一次当前故事的旧剧本；用于测试记忆压缩')
    .action(async ({ session }) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const compacted = await service.compactStory(story)
      return compacted ? '已完成一次连续性记忆整理。' : '当前还没有达到需要整理的剧本量。'
    })

  ctx.command('interlude.script [limit:number]', '管理员：查看当前主剧本的最近原始条目，默认 20 条')
    .action(async ({ session }, limit = 20) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const entries = await service.recentEntries(story.id, Math.max(1, Math.min(limit, 50)))
      if (!entries.length) return '当前主剧本还没有原始条目。'
      return entries.map(entry => `#${entry.id} [${entry.occurredAt.toISOString()}] ${entry.actor}/${entry.kind}${entry.participantId ? `/${entry.participantId}` : ''}\n${entry.content}`).join('\n\n')
    })

  ctx.command('interlude.script.note <content:text>', '管理员：向剧本写入一条人工注记，不伪装成模型输出')
    .action(async ({ session }, content) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      return await service.addAdminScriptNote(story, content) ? '已写入管理员注记，后续压缩会将其纳入连续性。' : '注记为空，未写入。'
    })

  ctx.command('interlude.memory.facts [limit:number]', '管理员：列出长期事实及其编号，默认 20 条')
    .action(async ({ session }, limit = 20) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const facts = await service.adminFacts(story.id, limit)
      if (!facts.length) return '当前没有有效的长期事实。'
      return facts.map(fact => `#${fact.id} [${fact.scope}] 重要度=${fact.importance.toFixed(2)} 置信度=${fact.confidence.toFixed(2)} 未解决=${fact.unresolved}\n${fact.content}`).join('\n\n')
    })

  ctx.command('interlude.memory.add <scope:string> <content:text>', '管理员：手动添加长期事实；scope 为 character/world/relationship/event/promise')
    .action(async ({ session }, scope, content) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      if (!isFactScope(scope)) return 'scope 必须是 character、world、relationship、event 或 promise。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      return await service.addAdminFact(story, scope, content) ? '已添加高置信度长期事实。' : '事实内容为空，未添加。'
    })

  ctx.command('interlude.memory.forget <id:number>', '管理员：将指定长期事实标记为已失效，可审计且不会物理删除')
    .action(async ({ session }, id) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      return await service.forgetAdminFact(story.id, id) ? `长期事实 #${id} 已标记为失效。` : `未找到有效的长期事实 #${id}。`
    })

  ctx.command('interlude.memory.intents [limit:number]', '管理员：查看等待中的计划、提醒、承诺与剧情余波')
    .action(async ({ session }, limit = 20) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const intents = await service.adminPendingIntents(story.id, limit)
      if (!intents.length) return '当前没有等待中的计划、提醒、承诺或剧情余波。'
      return intents.map(intent => {
        const active = intent.type === 'active-consequence' && intent.payload?.lifecycle === 'active'
        const timing = active
          ? `持续影响至=${String(intent.payload?.expiresAt || '未设置')}`
          : `最早执行=${intent.notBefore.toISOString()}`
        return `#${intent.id} [${intent.type}] 参与者=${intent.participantId || '全局'} ${timing}\n${intent.summary}`
      }).join('\n\n')
    })

  ctx.command('interlude.memory.cancel <id:number>', '管理员：取消指定的等待中意图或延迟消息')
    .action(async ({ session }, id) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      return await service.cancelAdminIntent(story.id, id) ? `意图 #${id} 已取消。` : `未找到等待中的意图 #${id}。`
    })

  ctx.command('interlude.memory.patches [limit:number]', '管理员：查看人物、关系和世界设定的演化提案')
    .action(async ({ session }, limit = 20) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const patches = await service.adminStatePatches(story.id, limit)
      if (!patches.length) return '当前没有设定演化提案。'
      return patches.map(patch => `#${patch.id} [${patch.status}/${patch.target}/${patch.impact}] 置信度=${patch.confidence.toFixed(2)}\n提案：${patch.proposedValue}\n证据：${patch.evidence}`).join('\n\n')
    })

  ctx.command('interlude.memory.reject <id:number>', '管理员：拒绝一条尚未应用的设定演化提案')
    .action(async ({ session }, id) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      return await service.rejectAdminStatePatch(story.id, id) ? `设定演化提案 #${id} 已拒绝。` : `未找到待审核的设定演化提案 #${id}。`
    })

  ctx.command('interlude.overlay.clear <target:string>', '管理员：只清理指定部分的设定演化 overlay，不删除剧本和记忆；执行前会询问 y/n')
    .action(async ({ session }, target) => {
      if (!requireManager(service, session)) return '无权限：当前账号不是 HDSI 管理员。'
      const normalized = String(target || '').trim().toLowerCase() as 'character' | 'perspective' | 'relationship' | 'world' | 'all'
      if (!['character', 'perspective', 'relationship', 'world', 'all'].includes(normalized)) return 'target 必须是 character、perspective、relationship、world 或 all。'
      if (!await askConfirmation(session, `即将清理 ${normalized} overlay；剧本和记忆不会删除。确认执行吗？(y/n)`)) return '操作已取消。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const result = await service.clearSettingOverlay(story, normalized)
      const participantNote = normalized === 'relationship' || normalized === 'all' ? `，已清理 ${result.participantCount} 个参与者关系 overlay` : ''
      return `已清理 ${normalized} overlay${participantNote}；剧本、长期事实和普通记忆均未删除。`
    })

  ctx.command('interlude.overlay.status', '管理员：查看当前 overlay、待积累提案和压缩归档状态')
    .action(async ({ session }) => {
      if (!requireManager(service, session)) return '无权限：当前账号不是 HDSI 管理员。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const status = await service.adminOverlayStatus(story.id)
      const overlay = JSON.stringify(status.state)
      return [
        `当前全局 overlay：${overlay === '{}' ? '空' : overlay}`,
        `待积累提案：${status.proposed.length} 条（需要跨多个剧本回合和日期后才会应用）`,
        `已应用/已归档提案：${status.applied.length} 条`,
        `已清理提案：${status.cleared.length} 条`,
        `overlay 压缩快照：${status.snapshots.length} 条`,
        `参与者关系 overlay：${status.participantOverlays.length} 个`,
      ].join('\n')
    })

  ctx.command('interlude.overlay.compact', '管理员：只合并和压缩已应用的 overlay，不整理普通剧本记忆')
    .action(async ({ session }) => {
      if (!requireManager(service, session)) return '无权限：当前账号不是 HDSI 管理员。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const changed = await service.compactOverlay(story)
      return changed ? 'overlay 合并和压缩完成。' : '没有需要合并或压缩的 overlay。'
    })

  ctx.command('interlude.database.clear', '管理员：清空 HDSI 自有 SQLite 数据表；不会删除 Koishi 用户和其它插件数据；执行前会询问 y/n')
    .action(async ({ session }) => {
      if (!requireManager(service, session)) return '无权限：当前账号不是 HDSI 管理员。'
      if (!await askConfirmation(session, '即将清空 HDSI 自有数据库，剧本、记忆和状态记录都会删除。确认执行吗？(y/n)')) return '操作已取消。'
      const result = await service.clearDatabase()
      return `HDSI 数据库清空完成：处理 ${result.removed} 条记录${result.logicallyCleared ? `，其中 ${result.logicallyCleared} 条因 SQLite 锁定改为逻辑清空` : ''}。`
    })

  ctx.command('interlude.purge.all', '管理员：彻底重置所有平台的剧本、记忆与 Canon；执行前会询问 y/n')
    .action(async ({ session }) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      if (!await askConfirmation(session, '即将删除所有平台的剧本、记忆、事实、意图和状态。确认执行吗？(y/n)')) return '操作已取消。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      await service.purgeAllData(story.id)
      return '已彻底重置所有平台：旧剧本、场景摘要、剧情弧线、长期事实、记忆、意图、状态演化和参与者关系状态均已清除；当前故事保留为空白的全局主剧本，Canon 已按当前 Console 配置重建。'
    })

  ctx.command('interlude.purge.platform <platform:string>', '管理员：删除指定平台的全部剧本和记忆；例如 sandbox 或 onebot；执行前会询问 y/n')
    .action(async ({ session }, platform) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      if (!await askConfirmation(session, `即将删除平台 ${platform} 的全部剧本和记忆。确认执行吗？(y/n)`)) return '操作已取消。'
      const normalized = String(platform ?? '').trim().toLowerCase()
      if (!normalized) return '请填写平台名，例如 sandbox 或 onebot。'
      const count = await service.purgePlatformData(normalized)
      return count
        ? `已清空并归档平台 ${normalized} 的 ${count} 部剧本；其它平台不受影响。`
        : `没有找到平台 ${normalized} 的 HDSI 剧本。`
    })

  // `text` 是 Koishi 的贪婪参数类型，会吞掉后续的结束时间；这里必须使用普通 string。
  ctx.command('interlude.purge.range <from:string> <to:string>', '管理员：删除时间范围内的剧本和关联记忆；时间使用 ISO-8601；执行前会询问 y/n')
    .action(async ({ session }, fromText, toText) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const from = new Date(String(fromText ?? '').trim())
      const to = new Date(String(toText ?? '').trim())
      if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) return '时间范围无效，请使用 ISO-8601，例如 2026-08-01T00:00:00+08:00。'
      if (!await askConfirmation(session, `即将删除 ${from.toISOString()} 至 ${to.toISOString()} 范围内的剧本和关联记忆。确认执行吗？(y/n)`)) return '操作已取消。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      await service.purgeStoryRange(story.id, from, to)
      return `已删除 ${from.toISOString()} 至 ${to.toISOString()} 范围内的剧本和关联记忆；Canon 与参与者身份未删除。`
    })
}

async function askConfirmation(session: Session, message: string) {
  await session.send(`${message}\n请在 60 秒内回复 y 或 n。`)
  const answer = await session.prompt(60_000)
  return /^(?:y|yes)$/i.test(String(answer ?? '').trim())
}

function formatStoryStartReadiness(readiness: import('./service').StoryStartReadiness, title = 'Console 档案检查') {
  const preview = readiness.preview
  return [
    title,
    `主角：${preview.characterName || '未填写'}`,
    `角色设定：${preview.characterProfile ? '已填写' : '未填写'}`,
    `Perspective：${preview.perspective ? '已填写' : '未填写'}`,
    `世界：${preview.world ? '已填写' : '未填写'}`,
    `时区：${preview.timezone}`,
    `主模型：${preview.model}`,
    `自动创建：${preview.autoCreate ? '开启' : '关闭'}`,
    ...(readiness.existing ? [`运行中故事：${readiness.existing.setting.character.name}（${readiness.existing.status}）`] : ['运行中故事：尚未创建']),
    ...readiness.blockers.map(item => `阻断：${item}`),
    ...readiness.warnings.map(item => `提示：${item}`),
    readiness.existing
      ? '结果：已有运行中故事，无需再次启动。'
      : readiness.ready ? '结果：可以启动。' : '结果：请先完成阻断项。',
  ].join('\n')
}

async function requireStory(service: InterludeService, session: Session) {
  if (!service.canHandleSession(session)) return '当前 QQ 账号未获 HDSI 互动授权。请在 Console 的“NapCat / OneBot QQ 账号控制”中检查机器人 QQ 号、用户 QQ 白名单和启用状态。'
  return await service.findStory(session) ?? '当前私聊还没有故事。请先在 Console 完成档案，然后执行 interlude.doctor；手动启动请使用 interlude.story.start，或开启 runtime.autoCreate 后直接发送第一条私聊。'
}

async function changeStatus(service: InterludeService, session: Session, status: 'active' | 'paused') {
  if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
  const story = await requireStory(service, session)
  if (typeof story === 'string') return story
  await service.setStatus(story, status)
  return status === 'active' ? '故事已恢复自动处理。' : '故事已暂停自动处理；已有记录不会删除。'
}

function requireManager(service: InterludeService, session: Session) { return service.canManageSession(session) }

function isFactScope(value: string): value is 'character' | 'world' | 'relationship' | 'event' | 'promise' {
  return ['character', 'world', 'relationship', 'event', 'promise'].includes(value)
}

function looksLikeInterludeCommand(content: string) { return /^[!/.]?interlude(?:\s|$)/i.test(content.trim()) }

export * from './narrator'
export * from './service'
export * from './types'
