import { Context, h, Logger, Service, Session, Time } from 'koishi'
import { registerTables } from './database'
import { readFile, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { configuredProviders, createCompactor, createEmbedder, createNarrator, createStickerDescriber, effectiveMainModelId, ModelConfig, StickerDescriber, usesRemoteProviders } from './narrator'
import {
  advanceAlterSystem, alterAnalysisCoolingDown, calculateAlterThreshold, completeAlterAnalysis,
  emotionalOffsetForPrompt, normalizeAlterSystemState, normalizeAlterValue, resolveAlterSystemConfig,
  AlterTurnResult,
} from './alter'
import {
  activeAgencyWindow, evaluateAgencyCapacity, normalizeAgencyWindowDraft, normalizeAgencyWindowState,
  normalizeProactiveContact, proactiveCandidateFingerprint, proactiveRecheckAt, resolveAgencyConfig,
} from './agency'
import { HDS_INTERLUDE_VERSION } from './meta'
import { formatLayeredLog, phaseLabel, renderLogMessage } from './logging'
import { calendarDayKey, formatLogTime, localClockMinutes } from './time'
import { consumeGroupWillingness, evaluateGroupWillingness, GroupWillingnessConfig, GroupWillingnessState } from './group-willingness'
import { normalizeQQNativeFaceSegments } from './qq-face'
import {
  CompactionDecision, emptyStorySetting, emptyStoryState, IntentDraft, InterludeArc, InterludeScene,
  InterludeParticipant, InterludeStory, MemoryDraft, NarrativeDecision, NarrativeFact, NarrativeIntent,
  GroupContext, GroupMessageContext, NarrativeInteraction, NarrativeProvider, NarrativeRequest, NarrativeCompactor,
  ContinuitySnapshot, NarrativeEmbedder, OutgoingMessageDraft, ParticipantState, ScriptEntry, ScriptEntryDraft, StatePatchDraft, StatePatchProposal, StorySetting, StoryState,
  BrowserIntentDraft, NarrativeImage, OverlaySnapshot, WebObservation, emptyParticipantState,
  AlterSystemState, AlterSystemConfig, EmotionalOffsetPrompt,
  AgencyConfig, AgencyWindowState, ProactiveContactDraft, AutomaticDeliverySummary, ScenePresenceDraft, ScenePresenceState,
  ChatActionCapabilities, ChatReactionName, FollowUpCommitmentDraft, FollowUpResolutionDraft, LocalMediaDraft, MessageReactionDraft, NativeFaceSemantic, StickerAsset, StickerCatalogEntry,
  IndexedQuotedMessageContext, QuotedMessageContext,
} from './types'

// Only QQ/OneBot CDN hosts are fetched in the native-vision path. This keeps
// arbitrary user-provided URLs from becoming an internal-network fetch proxy.
function isTrustedImageHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  const allowed = ['gchat.qpic.cn', 'c2cpicdw.qpic.cn', 'multimedia.nt.qq.com.cn', 'thirdqq.qlogo.cn', 'q.qlogo.cn']
  return allowed.some(domain => host === domain || host.endsWith(`.${domain}`))
}

export interface Config {
  /** Immersive operation that suppresses HDSI visibility and Koishi commands. */
  blindMode?: BlindModeConfig
  /** @deprecated Renamed to blindMode; retained for existing Console YAML. */
  blackBox?: BlindModeConfig
  model: ModelConfig
  runtime: RuntimeConfig
  storyDefaults: StoryDefaults
  logging: LoggingConfig
  memory?: MemoryConfig
  sharedStory?: SharedStoryConfig
  /** Optional, read-only browser observations powered by koishi-plugin-puppeteer. */
  browser?: BrowserConfig
  /** Optional OneBot/NapCat account gate. It only affects the onebot platform. */
  onebot?: OneBotNapCatConfig
  /** Optional cross-platform chat gestures; runtime connector availability remains authoritative. */
  chatActions?: ChatActionsConfig
  stickers?: StickerLibraryConfig
  alterSystem?: AlterSystemConfig
  agency?: AgencyConfig
}

export interface BlindModeConfig {
  enabled: boolean
  /** Periodic, intentionally minimal health signal while all other HDSI logs stay hidden. */
  healthReportMinutes: number
}

/** One row in the Console account tables. QQ ids are strings because QQ ids
 * can exceed JavaScript's safe integer range and Koishi exposes them as text. */
export interface OneBotAccountRule {
  qq: string
  label: string
  enabled: boolean
  /** Optional identity fields for a whitelisted private-message user. */
  personId?: string
  profile?: string
  relationship?: string
}

export interface OneBotNapCatConfig {
  /** When false (or omitted for old configurations), OneBot access is unchanged. */
  enabled: boolean
  /** NapCat accounts that are allowed to send the character's messages. */
  botAccounts: OneBotAccountRule[]
  /** @deprecated Kept only so old YAML can still load; runtime is allowlist-only. */
  userMode?: 'allowlist' | 'blocklist'
  userAccounts: OneBotAccountRule[]
  /** Explicit OneBot group allowlist. Group members do not need DM whitelist access. */
  groupChats?: GroupChatRule[]
  /** Prevent an echoed self-message from entering the narrative. */
  ignoreSelfMessages: boolean
  /** Optional SnowLuma record-to-text bridge for incoming private QQ voice messages. */
  voiceTranscription?: VoiceTranscriptionConfig
}

export interface VoiceTranscriptionConfig {
  enabled: boolean
  timeoutMs: number
}

export interface ChatActionsConfig {
  enabled: boolean
  platforms: Array<'qq' | 'wechat'>
  quoteReply: boolean
  messageReactions: boolean
  allowedReactions: ChatReactionName[]
  nativeFaces: boolean
  expressionThreshold: number
  allowedNativeFaces: NativeFaceSemantic[]
}

export interface StickerLibraryConfig {
  enabled: boolean
  directory: string
  maxFileSizeMB: number
  catalogLimit: number
}

export interface GroupChatRule {
  groupId: string
  label: string
  enabled: boolean
  purpose: string
  characterRole: string
  responseMode: 'mention-only' | 'always'
  contextLimit: number
  debounceSeconds: number
  cooldownSeconds: number
  willingness?: Partial<GroupWillingnessConfig>
}

export interface MemoryConfig {
  enabled: boolean
  backgroundIntervalMinutes: number
  maxStoriesPerCompactionRun: number
  sceneEntryThreshold: number
  sceneCharacterThreshold: number
  compactionEntryLimit: number
  compactionCharacterLimit: number
  sceneHookCharacters: number
  sceneSummaryCharacters: number
  arcSummaryCharacters: number
  recentEntryLimit: number
  factLimit: number
  factContentCharacters: number
  factImportanceWeight: number
  factConfidenceWeight: number
  factRecencyWeight: number
  semanticWeight: number
  unresolvedWeight: number
  statePatchConfidenceThreshold: number
  majorStatePatchConfidenceThreshold: number
  statePatchMinEvidence: number
  /** Minimum independent narrative turns for a minor overlay change. */
  statePatchMinTurns?: number
  /** Minimum distinct calendar days represented by minor-patch evidence. */
  statePatchMinDays?: number
  /** Cooldown between stable overlay changes on the same target/path. */
  statePatchCooldownHours?: number
  autoApplyStatePatches: boolean
  allowMajorStateChanges: boolean
  maxFactsPerStory: number
  /** Keep short-lived dramatic aftereffects as context for later writing. */
  activeConsequencesEnabled: boolean
  /** Maximum active consequences carried into one main-narrative prompt. */
  activeConsequencePromptLimit: number
  /** Longest permitted lifetime of one consequence; protects canon from drift. */
  activeConsequenceMaxDays: number
  /** Used when the narrator omits a precise strength for a valid consequence. */
  activeConsequenceDefaultStrength: number
  overlayCompressionEnabled?: boolean
  overlayRecentDays?: number
  overlayMonthlyAfterDays?: number
  overlayWeeklyWindowDays?: number
  overlayMonthlyWindowDays?: number
  overlayWeeklySummaryCharacters?: number
  overlayMonthlySummaryCharacters?: number
}

export interface RuntimeConfig {
  captureDirectMessages: boolean
  autoCreate: boolean
  ignoreCommandMessages: boolean
  allowProactiveMessages: boolean
  /** Minimum narrator-declared willingness for a background-initiated contact. */
  proactiveWillingnessThreshold?: number
  sweepIntervalMinutes: number
  minimumAdvanceMinutes: number
  maxStoriesPerSweep: number
  contextEntryLimit: number
  memoryLimit: number
  maxScriptCharacters: number
  maxMessageCharacters: number
  minimumDelayedReplySeconds: number
  maximumDelayedReplyMinutes: number
  cancelDelayedRepliesOnUserMessage: boolean
  /** Retry a user turn after a transient narrative-provider failure. */
  narrativeRetryDelaySeconds?: number
  /** Maximum automatic retries per failed user turn; 0 disables retry. */
  narrativeRetryMaxAttempts?: number
  /** Split model reply.content into multiple QQ messages at the configured separator. */
  splitReplyMessages?: boolean
  messageSeparator?: string
  typingBaseDelaySeconds?: number
  typingCharactersPerSecond?: number
  typingMaxDelaySeconds?: number
  /** Wait after the newest user message before starting a writing request. */
  userMessageDebounceSeconds?: number
  /** @deprecated Ignored since 0.1.2; requests remain replaceable until the first reply is committed. */
  staleNarrativeRequestWindowSeconds?: number
  /** 新版自动推进调度；旧版 minimumAdvanceMinutes 仍保留兼容。 */
  autoAdvanceEnabled?: boolean
  autoAdvanceIntervalMinutes?: number
  autoAdvanceJitterMinutes?: number
  /** Short life-writing passes after a conversation, in minutes. */
  conversationFollowUpMinutes?: number[]
  /** Small random offset applied to each short conversation follow-up. */
  conversationFollowUpJitterMinutes?: number
  restWindows?: RestWindow[]
}

export interface BrowserConfig {
  enabled: boolean
  /** Immediate browsing is opt-in because it intentionally adds one more model/browser round trip. */
  mode: 'deferred-only' | 'allow-immediate'
  allowSearch: boolean
  allowVisit: boolean
  searchUrlTemplate: string
  allowedDomains: string[]
  blockedDomains: string[]
  maxConcurrentPages: number
  /** Bound work per background sweep so a backlog cannot hold the story queue for minutes. */
  maxResearchPerSweep: number
  navigationTimeout: number
  waitUntil: 'domcontentloaded' | 'networkidle2'
  maxTextCharacters: number
  maxExcerptCharacters: number
  maxObservationsInPrompt: number
  cacheMinutes: number
  allowGroupTriggeredResearch: boolean
  logObservationPreview: boolean
}

/** Console presets that turn QQ accounts into named relationship branches. */
export interface ParticipantPreset {
  qq: string
  personId: string
  label: string
  profile: string
  relationship: string
  enabled: boolean
}

export interface SharedStoryConfig {
  /** One main story per bot account. Kept configurable for a safe rollback. */
  enabled?: boolean
  /** Enroll an allowed account into an existing main story on its first DM. */
  autoEnrollParticipants: boolean
  /** Allow one incoming message to cause an explicitly justified message to another account. */
  allowCrossConversationMessages: boolean
  /** Send other participants' relationship/profile details to the model provider. */
  shareParticipantDetails: boolean
  /** Hard cap for cross-account messages produced by one narrative turn. */
  maxCrossConversationActions: number
  /** Number of other relationship summaries sent to the main narrator. */
  participantContextLimit: number
  /** Empty keeps legacy behaviour; otherwise only these QQs may run global management commands. */
  managerAccounts: string[]
  /** Optional QQ-to-person presets; accounts with the same personId share identity notes. */
  /** @deprecated Use onebot.userAccounts identity fields in new configs. */
  participantPresets?: ParticipantPreset[]
}

export interface RestWindow {
  enabled: boolean
  label: string
  start: string
  end: string
  minIntervalMinutes: number
  maxIntervalMinutes: number
}

interface AutoAdvanceConfig {
  enabled: boolean
  intervalMinutes: number
  jitterMinutes: number
  followUpMinutes: number[]
  followUpJitterMinutes: number
  restWindows: RestWindow[]
}

interface BufferedUserMessage {
  content: string
  occurredAt: Date
  supersededIntents: NarrativeIntent[]
  quote?: QuotedMessageContext
  /** Short-lived source links only; never written to HDSI storage. */
  imageSources: string[]
}

/** A per-relationship input buffer. Messages are durable immediately, while
 * the narrator waits briefly for the user to finish a short burst. */
interface BufferedNarrativeTurn {
  storyId: string
  participantId: string
  messages: BufferedUserMessage[]
  latestSession?: Session
  /** Context timers return a disposer rather than Node's native Timeout. */
  timer?: () => void
  nextRevision: number
  inFlightRequestId?: number
  firstMessageCommittedRequestId?: number
  obsoleteRequestIds: Set<number>
}

interface BufferedGroupTurn {
  storyId: string
  groupId: string
  rule: GroupChatRule
  channelId: string
  latestSession?: Session
  messages: GroupMessageContext[]
  timer?: () => void
  revision: number
  mentionedBot: boolean
  quotedBot: boolean
}

export interface ExecutableMessageReaction extends MessageReactionDraft {
  messageId: string
}

export interface ExecutableGroupChatActions {
  replyTo?: { messageRef: string, messageId: string }
  reactions: ExecutableMessageReaction[]
}

interface DueIntentWake {
  cancel: () => void
  dueAt: number
}

export interface StoryDefaults {
  characterName: string
  characterProfile: string
  perspective: string
  userProfile: string
  relationship: string
  world: string
  supportingCast: string
  location: string
  style: string
  timezone: string
}

export interface LoggingConfig {
  level: 'silent' | 'error' | 'warn' | 'info' | 'debug'
  /** Controls how much normal operational activity is written at info level. */
  verbosity?: 'summary' | 'standard' | 'diagnostic'
  format: 'compact' | 'detailed' | 'layered'
  /** Apply semantic ANSI colors; Koishi Console and normal terminals render them. */
  colors?: boolean
  /** Select a high-contrast ANSI palette for dark or light Console themes. */
  colorTheme?: 'dark' | 'light'
  /** Show fixed action kaomoji; false uses compact symbols instead. */
  kaomoji?: boolean
  logScriptPreview: boolean
  /** Emit user-visible incoming/outgoing message bodies to the plugin log. */
  logMessageContent?: boolean
  previewLength: number
}

export interface StoryStartReadiness {
  ready: boolean
  existing?: InterludeStory
  blockers: string[]
  warnings: string[]
  preview: {
    characterName: string
    characterProfile: boolean
    perspective: boolean
    world: boolean
    timezone: string
    model: string
    autoCreate: boolean
  }
}

export class InterludeService extends Service {
  static inject = ['database', 'http']
  private narrator: NarrativeProvider
  private compactor: NarrativeCompactor
  private embedder: NarrativeEmbedder
  private stickerDescriber: StickerDescriber
  private stickerCatalog: StickerAsset[] = []
  private stickerById = new Map<string, StickerAsset>()
  private stickerScanRunning = false
  /**
   * 同一故事的用户消息、到期意图和后台压缩必须串行。否则“用户新消息
   * 取消旧延迟回复”可能与定时发送同时发生，造成过期消息仍被发出。
   */
  private queues = new Map<string, Promise<unknown>>()
  private bufferedNarrativeTurns = new Map<string, BufferedNarrativeTurn>()
  private bufferedGroupTurns = new Map<string, BufferedGroupTurn>()
  /** Short-lived group-member display names. QQ number remains the stable key. */
  private groupMemberNameCache = new Map<string, { name: string, expiresAt: number }>()
  private groupMemberNameLookups = new Map<string, Promise<string>>()
  /** Ephemeral, per-group willingness score. It never touches private turns or durable story state. */
  private groupWillingness = new Map<string, GroupWillingnessState>()
  /** Earliest wake-up for persisted typing segments; one timer per story. */
  private dueIntentWakeTimers = new Map<string, DueIntentWake>()
  /** Synchronously marks a relationship whose current typing chain was interrupted by new input. */
  private interruptedTypingParticipants = new Set<string>()
  /** Prevent a background life turn from racing an unlocked live model call. */
  private narratingStories = new Set<string>()
  private factBackfills = new Set<string>()
  /** Coalesce repeated post-turn compaction requests into one queued pass. */
  private scheduledCompactions = new Set<string>()
  /** Coalesce low-frequency atmosphere analysis without delaying the visible reply. */
  private scheduledAlterAnalyses = new Set<string>()
  /** sql.js/SQLite has one writable connection; serialize writes globally. */
  private databaseWriteQueue: Promise<unknown> = Promise.resolve()
  /** The browser is bounded separately from narrative work so a burst of
   * deferred intents cannot spawn an uncontrolled number of Chromium pages. */
  private browserActive = 0
  private browserWaiters: Array<() => void> = []
  /** Use Koishi's context-bound logger so Console/runtime targets receive records. */
  private readonly serviceLogger: Logger
  private backgroundStarted = false
  private databaseResetting = false
  private sweepRunning = false
  private compactionSweepRunning = false
  private blindModeHealthIssue = false

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'interlude')
    this.serviceLogger = ctx.logger('hds-interlude')
    registerTables(ctx)
    this.narrator = createNarrator(ctx, config.model, this.blindModeConfig.enabled)
    this.compactor = createCompactor(ctx, config.model, this.blindModeConfig.enabled)
    this.embedder = createEmbedder(ctx, config.model)
    this.stickerDescriber = createStickerDescriber(ctx, config.model, this.blindModeConfig.enabled)
    // Defer timer registration by one event-loop turn. This keeps Console
    // plugin load/reload responsive while preserving the same background work.
    ctx.setTimeout(() => this.startBackgroundTasks(), 0)
    // The logger target may not be installed yet during plugin construction;
    // emit a second lifecycle record after Koishi is ready so it is visible in
    // both the terminal and Console log panel.
    ctx.on('ready', () => this.reportStandaloneOperation('summary', 'info', '服务已就绪'))
    this.reportStandaloneOperation('summary', 'info', '服务初始化完成 模型连接=%s 共享主剧本=%s 自动推进=%s', usesRemoteProviders(config.model) ? '已配置' : '未配置', this.sharedStoryConfig.enabled, this.autoAdvanceConfig.enabled)
  }

  private startBackgroundTasks() {
    if (this.backgroundStarted) return
    this.backgroundStarted = true
    // Life advancement and memory compaction are both serialized per story.
    const sweepInterval = Math.max(1, this.config.runtime.sweepIntervalMinutes)
    this.ctx.setInterval(() => void this.sweep().catch(error => this.reportStandalone('warn', '后台推进失败 错误=%s', error)), sweepInterval * Time.minute)
    if (this.memoryConfig.enabled) this.ctx.setInterval(() => void this.compactStories().catch(error => this.reportStandalone('warn', '后台记忆整理失败 错误=%s', error)), Math.max(1, this.memoryConfig.backgroundIntervalMinutes) * Time.minute)
    if (this.blindModeConfig.enabled) {
      this.ctx.setInterval(() => this.reportBlindModeHealth(), this.blindModeConfig.healthReportMinutes * Time.minute)
    }
    if (this.stickerConfig.enabled) {
      this.ctx.setTimeout(() => void this.scanStickerLibrary(), 0)
      this.ctx.setInterval(() => void this.scanStickerLibrary(), 5 * Time.minute)
    }
    this.reportStandaloneOperation('standard', 'info', '后台调度已启动 剧本扫描=%d分钟 记忆扫描=%d分钟', sweepInterval, this.memoryConfig.backgroundIntervalMinutes)
  }

  setNarrator(provider: NarrativeProvider) { this.narrator = provider }
  getNarrator() { return this.narrator }
  setCompactor(provider: NarrativeCompactor) { this.compactor = provider }
  /** Allows a custom/local vector service without replacing the main narrator. */
  setEmbedder(provider: NarrativeEmbedder) { this.embedder = provider }

  /**
   * Returns whether this session is allowed to use HDSI. Koishi's OneBot
   * adapter uses `selfId` for the logged-in bot QQ and `userId` for the sender
   * QQ. Other adapters deliberately keep their old behaviour.
   */
  canHandleSession(session: Session): boolean {
    if (!isOneBotPlatform(session.platform)) return true
    const config = this.config.onebot
    // Backwards compatibility: an absent/disabled gate does not change old
    // installations. Once enabled, an empty list is intentionally deny-all.
    if (!config?.enabled) return true
    const selfId = normalizeAccountId(session.selfId)
    const userId = normalizeAccountId(session.userId)
    if (config.ignoreSelfMessages && selfId && selfId === userId) return false
    if (!isEnabledAccount(config.botAccounts, selfId)) {
      this.reportStandaloneOperation('diagnostic', 'debug', 'OneBot 白名单拒绝机器人账号 平台=%s 原始机器人ID=%s 规范化ID=%s', session.platform, session.selfId, selfId)
      return false
    }
    // HDSI deliberately uses an explicit allowlist.  A legacy userMode field
    // is ignored so an old `blocklist` value cannot silently open the bot to
    // every QQ account after an upgrade.
    const allowed = isEnabledAccount(config.userAccounts, userId)
    if (!allowed) this.reportStandaloneOperation('diagnostic', 'debug', 'OneBot 白名单拒绝用户账号 原始用户ID=%s 规范化ID=%s', session.userId, userId)
    return allowed
  }

  /** Group access uses an explicit group allowlist; group members do not need
   * to be present in the private-message user whitelist. */
  canHandleGroupSession(session: Session): boolean {
    if (!isOneBotPlatform(session.platform)) return false
    const config = this.config.onebot
    if (!config?.enabled) return false
    const selfId = normalizeAccountId(session.selfId)
    const userId = normalizeAccountId(session.userId)
    if (config.ignoreSelfMessages && selfId && selfId === userId) return false
    if (!isEnabledAccount(config.botAccounts, selfId)) return false
    const group = this.groupRule(sessionGroupId(session))
    return !!group?.enabled
  }

  private groupRule(groupId: string) {
    const normalized = normalizeGroupId(groupId)
    return (this.config.onebot?.groupChats ?? []).find(group => group.enabled !== false && normalizeGroupId(group.groupId) === normalized)
  }

  /** Same account gate for direct-message work that already has a participant. */
  canHandleParticipant(participant: InterludeParticipant): boolean {
    if (!isOneBotPlatform(participant.platform)) return true
    const config = this.config.onebot
    if (!config?.enabled) return true
    if (!isEnabledAccount(config.botAccounts, normalizeAccountId(participant.selfId))) return false
    return isEnabledAccount(config.userAccounts, normalizeAccountId(participant.userId))
  }

  canManageSession(session: Session): boolean {
    if (!this.canHandleSession(session)) {
      this.reportStandaloneOperation('diagnostic', 'debug', '私聊被 OneBot 白名单拦截 平台=%s 机器人ID=%s 用户ID=%s', session.platform, session.selfId, session.userId)
      return false
    }
    const managers = this.sharedStoryConfig.managerAccounts.map(value => String(value ?? '').trim()).filter(Boolean)
    return !managers.length || managers.some(value => normalizeAccountId(value) === normalizeAccountId(session.userId))
  }

  /** Background life updates only require the bot account to remain enabled. */
  canHandleStory(story: InterludeStory): boolean {
    if (!isOneBotPlatform(story.platform)) return true
    const config = this.config.onebot
    if (!config?.enabled) return true
    return isEnabledAccount(config.botAccounts, normalizeAccountId(story.selfId))
  }

  async findStory(session: Session) {
    if (this.sharedStoryConfig.enabled) {
      // Shared mode deliberately has one canonical active story in the whole
      // Koishi instance. Sandbox and OneBot must not run parallel lives.
      const existing = await this.getCanonicalStory(storyIdForCharacter(session.platform, session.selfId))
      if (existing) {
        const sharedId = storyIdForCharacter(session.platform, session.selfId)
        if (existing.platform === session.platform && existing.id !== sharedId) return this.migrateLegacyStory(existing, session)
        await this.migrateLegacyBranchIntoShared(existing, session)
        return existing
      }
    }
    const id = legacyStoryIdFor(session.platform, session.selfId, session.userId)
    const existing = (await this.dbGet('interlude_story', { id }))[0]
    if (existing || !this.sharedStoryConfig.enabled) return existing

    // Old beta versions used one story id per QQ. Migrate lazily when that QQ
    // first returns, so existing scripts become the first relationship branch
    // of the new shared story instead of silently disappearing.
    const legacyId = legacyStoryIdFor(session.platform, session.selfId, session.userId)
    const legacy = (await this.dbGet('interlude_story', { id: legacyId }))[0]
    return legacy ? this.migrateLegacyStory(legacy, session) : undefined
  }

  /**
   * Resolve and enforce the one global active story. The preferred id wins
   * when present; otherwise the most recently updated row is retained and
   * every other active row is archived immediately.
   */
  private async getCanonicalStory(preferredId?: string) {
    const active = await this.dbGet('interlude_story', { status: 'active' }, {
      sort: { updatedAt: 'desc' },
    })
    if (!active.length) return undefined
    const canonical = (preferredId && active.find(story => story.id === preferredId))
      ?? active.find(story => story.id.startsWith('character:'))
      ?? active[0]
    const now = new Date()
    for (const story of active) {
      if (story.id === canonical.id) continue
      await this.dbSet('interlude_story', { id: story.id }, { status: 'archived', updatedAt: now })
      this.reportStandalone('warn', '主剧本归档完成 原因=检测到多个活动故事 保留=%s 已归档=%s 范围=%s', canonical.id, story.id, '全局')
    }
    return canonical
  }

  async findParticipant(session: Session, story?: InterludeStory) {
    const resolved = story ?? await this.findStory(session)
    if (!resolved) return undefined
    // Participant ids from older betas were global to a bot/user pair.  Do
    // not trust that id alone: when shared mode is toggled or a legacy branch
    // is being migrated, the same pair can temporarily exist under another
    // story.  The story-bound lookup prevents accidentally moving or exposing
    // the wrong relationship branch.
    const rows = await this.dbGet('interlude_participant', { storyId: resolved.id })
    return rows.find(item => sameParticipantEndpoint(item, session))
  }

  async participants(storyId: string, includePaused = false) {
    const rows = await this.dbGet('interlude_participant', { storyId })
    return rows
      .filter(participant => includePaused || participant.status === 'active')
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  }

  async createStory(session: Session, name?: string) {
    if (!this.canHandleSession(session) && !this.canHandleGroupSession(session)) throw new Error('This session is not allowed to use HDS Interlude.')
    const existing = await this.findStory(session)
    if (existing) {
      if (session.isDirect) await this.ensureParticipant(existing, session)
      return existing
    }
    const now = new Date()
    const setting = this.initialStorySetting(name)
    const story: InterludeStory = {
      id: this.sharedStoryConfig.enabled
        ? storyIdForCharacter(session.platform, session.selfId)
        : legacyStoryIdFor(session.platform, session.selfId, session.userId),
      platform: session.platform, selfId: session.selfId, userId: '',
      channelId: '', status: 'active', setting, state: emptyStoryState(),
      cursorAt: now, createdAt: now, updatedAt: now,
    }
    try {
      await this.dbCreate('interlude_story', story)
    } catch (error) {
      // Two accounts can DM a newly started bot at almost the same time. The
      // database primary key is the final arbiter; join the winner instead of
      // failing one participant's first message.
      const raced = (await this.dbGet('interlude_story', { id: story.id }))[0]
      if (!raced) throw error
      await this.ensureContinuity(raced, now)
      await this.ensureParticipant(raced, session, now)
      return raced
    }
    await this.ensureContinuity(story, now)
    if (session.isDirect) await this.ensureParticipant(story, session, now)
    await this.appendEntry(story.id, {
      kind: 'setup', actor: 'system', content: `The story begins with ${setting.character.name}.`,
      occurredAt: now.toISOString(), metadata: {},
    }, now)
    await this.scheduleNextAutomaticAdvance(story.id, now)
    return story
  }

  /** Read-only preflight for manually starting a runtime story from Console defaults. */
  async storyStartReadiness(session: Session): Promise<StoryStartReadiness> {
    const setting = this.initialStorySetting()
    const blockers: string[] = []
    const warnings: string[] = []
    if (!this.canHandleSession(session)) blockers.push('当前机器人账号或用户账号未通过 OneBot 白名单。')
    if (!setting.character.name.trim()) blockers.push('storyDefaults.characterName 为空。')
    if (!setting.character.profile.trim()) blockers.push('storyDefaults.characterProfile 尚未填写。')
    try { new Intl.DateTimeFormat('en-US', { timeZone: setting.timezone }) } catch { blockers.push(`时区无效：${setting.timezone}`) }
    if (usesRemoteProviders(this.config.model)) {
      const providers = configuredProviders(this.config.model)
      const assigned = providers.find(item => item.enabled && item.endpoint && item.model && item.useForMain === true)
      const mainModelId = effectiveMainModelId(this.config.model)
      const route = mainModelId ? this.config.model.models?.find(model => model.enabled !== false && model.id === mainModelId) : undefined
      const provider = assigned ?? (route
        ? providers.find(item => item.enabled && item.id === route.providerId && item.endpoint && (route.model || item.model))
        : providers.find(item => item.enabled && item.endpoint && item.model))
      if (!provider) blockers.push('没有可用的主叙事模型：请在模型中心勾选一条“用作主叙事模型”。')
    } else {
      warnings.push('尚未配置启用的模型连接：可用于安装验证，但不会生成远程叙事。')
    }
    if (!setting.perspective.trim()) warnings.push('Perspective 尚未填写；主角将仅使用 Canon 与已有 Overlay。')
    if (!setting.world.trim()) warnings.push('world 尚未填写；建议在 Console 补充现实边界与地点背景。')
    const existing = await this.findStory(session)
    return {
      ready: blockers.length === 0,
      existing, blockers, warnings,
      preview: {
        characterName: setting.character.name,
        characterProfile: !!setting.character.profile.trim(),
        perspective: !!setting.perspective.trim(),
        world: !!setting.world.trim(),
        timezone: setting.timezone,
        model: this.mainModelLabel(),
        autoCreate: this.config.runtime.autoCreate !== false,
      },
    }
  }

  /**
   * Enrolls a QQ account as a relationship branch and synchronizes its Console
   * identity fields. Callers that already resolved the participant can pass it
   * in to avoid a second database read.
   */
  async ensureParticipant(story: InterludeStory, session: Session, now = new Date(), knownExisting?: InterludeParticipant) {
    const account = this.userAccountRule(session.userId)
    const preset = this.participantPreset(session.userId)
    const existing = knownExisting ?? await this.findParticipant(session, story)
    if (existing) {
      // Console edits to the whitelist are intentional identity changes.
      // Keep relationship evolution in participant.state.relationshipOverlay;
      // only this base profile/relationship is refreshed here.
      const personId = account?.personId?.trim() || preset?.personId?.trim() || existing.personId || session.userId
      const displayName = account?.label?.trim() || preset?.label?.trim() || existing.displayName || session.username || session.userId
      const profile = account?.profile?.trim() || preset?.profile?.trim() || existing.profile || this.config.storyDefaults.userProfile
      const relationship = account?.relationship?.trim() || preset?.relationship?.trim() || existing.relationship || this.config.storyDefaults.relationship
      const changed = existing.storyId !== story.id
        || existing.channelId !== session.channelId
        || existing.personId !== personId
        || existing.displayName !== displayName
        || existing.profile !== profile
        || existing.relationship !== relationship
      if (changed) {
        await this.dbSet('interlude_participant', { id: existing.id }, {
          storyId: story.id, channelId: session.channelId, personId, displayName, profile, relationship, updatedAt: now,
        })
        this.reportOperation('diagnostic', 'debug', story, 'user-message', '参与者资料已从 Console 同步 参与者=%s', existing.id)
      }
      return {
        ...existing, storyId: story.id, channelId: session.channelId, personId, displayName, profile, relationship,
        updatedAt: changed ? now : existing.updatedAt,
      }
    }
    const baseId = participantIdFor(session.platform, session.selfId, session.userId)
    // Keep the historical id whenever it is free.  If an old per-account
    // story still owns it, use a deterministic story suffix instead of
    // stealing that branch's primary key during rollback/migration.
    const globallyExisting = await this.getParticipant(baseId)
    const id = !globallyExisting || globallyExisting.storyId === story.id
      ? baseId
      : participantIdForStory(story.id, session.platform, session.selfId, session.userId)
    const participant: InterludeParticipant = {
      id, storyId: story.id, platform: session.platform, selfId: session.selfId,
      userId: session.userId, channelId: session.channelId,
      personId: account?.personId?.trim() || preset?.personId?.trim() || session.userId,
      displayName: account?.label?.trim() || preset?.label?.trim() || session.username || session.userId,
      profile: account?.profile?.trim() || preset?.profile?.trim() || this.config.storyDefaults.userProfile,
      relationship: account?.relationship?.trim() || preset?.relationship?.trim() || this.config.storyDefaults.relationship,
      state: emptyParticipantState(), status: 'active', createdAt: now, updatedAt: now,
    }
    try {
    await this.dbCreate('interlude_participant', participant)
    } catch (error) {
      // Two first private messages can arrive before either request enters the
      // story queue.  The primary key resolves that race; return the branch
      // created by the other request instead of failing one message.
      const raced = await this.findParticipant(session, story)
      if (!raced) throw error
      return raced
    }
    await this.appendEntry(story.id, {
      kind: 'participant-joined', actor: 'system',
      content: `${participant.displayName} entered the character's relationship network.`,
      occurredAt: now.toISOString(), metadata: { personId: participant.personId },
    }, now, participant.id)
    return participant
  }

  async updateSetting(story: InterludeStory, patch: Partial<StorySetting>) {
    const setting = mergeSetting(story.setting, patch)
    const now = new Date()
    await this.dbSet('interlude_story', { id: story.id }, { setting, updatedAt: now })
    return { ...story, setting, updatedAt: now }
  }

  async setStatus(story: InterludeStory, status: InterludeStory['status']) {
    const now = new Date()
    await this.dbSet('interlude_story', { id: story.id }, { status, updatedAt: now })
    return { ...story, status, updatedAt: now }
  }

  async recentEntries(storyId: string, limit = this.config.runtime.contextEntryLimit) {
    const bounded = Math.max(1, Math.min(limit, 200))
    const rows = await this.dbGet('interlude_script_entry', { storyId }, {
      limit: bounded,
      sort: { occurredAt: 'desc' },
    })
    return rows.reverse()
  }

  async memories(storyId: string, limit = this.config.runtime.memoryLimit, participantId?: string) {
    const bounded = Math.max(1, Math.min(limit * 4, 500))
    const rows = await this.dbGet('interlude_memory', { storyId, status: 'active' }, {
      limit: bounded,
      sort: { importance: 'desc', updatedAt: 'desc' },
    })
    return rows
      .filter(memory => participantId === undefined || !memory.participantId || memory.participantId === participantId)
      .sort((a, b) => b.importance - a.importance || b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit)
  }

  /** Administrative view: includes global and participant-specific durable facts. */
  async adminFacts(storyId: string, limit = 20) {
    return this.dbGet('interlude_fact', { storyId, status: 'active' }, {
      limit: Math.max(1, Math.min(limit, 100)),
      sort: { updatedAt: 'desc' },
    })
  }

  async adminPendingIntents(storyId: string, limit = 20) {
    return this.dbGet('interlude_intent', { storyId, status: 'pending' }, {
      limit: Math.max(1, Math.min(limit, 100)),
      sort: { notBefore: 'asc' },
    })
  }

  async adminStatePatches(storyId: string, limit = 20) {
    return this.dbGet('interlude_state_patch', { storyId }, {
      limit: Math.max(1, Math.min(limit, 100)),
      sort: { createdAt: 'desc' },
    })
  }

  /** Adds an audit-visible system note without pretending it came from the model. */
  async addAdminScriptNote(story: InterludeStory, content: string) {
    const text = clip(content, this.config.runtime.maxScriptCharacters)
    if (!text) return false
    const now = new Date()
    await this.appendEntry(story.id, {
      kind: 'admin-note', actor: 'system', content: `[管理员注记] ${text}`,
      occurredAt: now.toISOString(), metadata: { source: 'administrator' },
    }, now)
    this.scheduleCompaction(story.id)
    return true
  }

  /** Adds a high-confidence fact for corrections that must survive compaction. */
  async addAdminFact(story: InterludeStory, scope: NarrativeFact['scope'], content: string) {
    const text = clip(content, this.memoryConfig.factContentCharacters)
    if (!text) return false
    const now = new Date()
    await this.dbCreate('interlude_fact', {
      storyId: story.id, participantId: '', scope, content: text,
      importance: 0.8, confidence: 1, unresolved: false, embedding: await this.embedText(text),
      status: 'active', sourceEntryIds: [], lastSeenAt: now, createdAt: now, updatedAt: now,
    })
    return true
  }

  /** Reversible deletion: facts are retained as superseded rows for audit. */
  async forgetAdminFact(storyId: string, id: number) {
    const fact = (await this.dbGet('interlude_fact', { id, storyId, status: 'active' }))[0]
    if (!fact) return false
    await this.dbSet('interlude_fact', { id }, { status: 'superseded', updatedAt: new Date() })
    return true
  }

  async cancelAdminIntent(storyId: string, id: number) {
    const intent = (await this.dbGet('interlude_intent', { id, storyId, status: 'pending' }))[0]
    if (!intent) return false
    await this.dbSet('interlude_intent', { id }, { status: 'cancelled', updatedAt: new Date() })
    return true
  }

  async rejectAdminStatePatch(storyId: string, id: number) {
    const patch = (await this.dbGet('interlude_state_patch', { id, storyId, status: 'proposed' }))[0]
    if (!patch) return false
    await this.dbSet('interlude_state_patch', { id }, { status: 'rejected' })
    return true
  }

  /** Clear only the evolving setting overlay; keep Canon, script and memories. */
  async clearSettingOverlay(story: InterludeStory, target: 'character' | 'perspective' | 'relationship' | 'world' | 'all') {
    this.invalidateBufferedNarratives(story.id)
    return this.serial(story.id, async () => this.clearSettingOverlayUnlocked(await this.getStory(story.id), target))
  }

  private async clearSettingOverlayUnlocked(story: InterludeStory, target: 'character' | 'perspective' | 'relationship' | 'world' | 'all') {
    const now = new Date()
    const overlay = { ...(story.state.settingOverlay ?? {}) }
    if (target === 'character' || target === 'all') {
      delete overlay.characterProfile
      overlay.characterTraits = []
    }
    if (target === 'perspective' || target === 'all') delete overlay.perspective
    if (target === 'relationship' || target === 'all') delete overlay.relationship
    if (target === 'world' || target === 'all') delete overlay.world
    await this.dbSet('interlude_story', { id: story.id }, {
      state: { ...story.state, settingOverlay: overlay }, updatedAt: now,
    })

    let participantCount = 0
    if (target === 'relationship' || target === 'all') {
      const participants = await this.participants(story.id, true)
      for (const participant of participants) {
        const state = normalizeParticipantState(participant.state)
        if (!state.relationshipOverlay) continue
        participantCount++
        await this.dbSet('interlude_participant', { id: participant.id }, {
          state: { ...state, relationshipOverlay: undefined }, updatedAt: now,
        })
      }
    }

    // Preserve proposals for audit, but invalidate both active overlay rows and
    // pending candidates. Otherwise a candidate created before the clear could
    // be applied later and silently resurrect the old personality/relationship.
    const patches = await this.dbGet('interlude_state_patch', { storyId: story.id })
    for (const patch of patches) {
      if (!['proposed', 'applied', 'compacted'].includes(patch.status) || (target !== 'all' && patch.target !== target)) continue
      await this.dbSet('interlude_state_patch', { id: patch.id }, { status: 'cleared' })
    }
    const snapshots = await this.dbGet('interlude_overlay_snapshot', { storyId: story.id, status: 'active' }) as OverlaySnapshot[]
    for (const snapshot of snapshots) {
      if (target !== 'all' && snapshot.target !== target) continue
      await this.dbSet('interlude_overlay_snapshot', { id: snapshot.id }, { status: 'superseded', updatedAt: now })
    }
    return { participantCount }
  }

  /**
   * Destructive administrative operation. The caller must validate the
   * confirmation phrase. A full purge also rebuilds Canon from the current
   * Console configuration, so an old profile cannot survive in later prompts.
   */
  async purgeAllStoryData(storyId: string) {
    this.invalidateBufferedNarratives(storyId)
    await this.purgeTable('interlude_script_entry', { storyId }, {
      kind: 'redacted', actor: 'system', content: '[管理员已删除剧本内容]', metadata: { redacted: true },
    })
    await this.purgeTable('interlude_memory', { storyId }, { status: 'deleted', content: '[管理员已删除记忆]' })
    await this.purgeTable('interlude_intent', { storyId }, { status: 'cancelled', summary: '[管理员已取消意图]' })
    await this.purgeTable('interlude_scene', { storyId }, { status: 'closed', hook: '', summary: '', entryCount: 0 })
    await this.purgeTable('interlude_arc', { storyId }, { status: 'closed', summary: '', sceneCount: 0 })
    await this.purgeTable('interlude_fact', { storyId }, { status: 'superseded', content: '[管理员已删除事实]' })
    await this.purgeTable('interlude_state_patch', { storyId }, { status: 'rejected', proposedValue: '[管理员已删除提案]', evidence: '' })
    await this.purgeTable('interlude_overlay_snapshot', { storyId }, { status: 'superseded', summary: '[管理员已删除 overlay 归档]', majorEvents: [], sourcePatchIds: [] })
    await this.purgeTable('interlude_web_observation', { storyId }, { status: 'deleted', url: '', title: '', excerpt: '', summary: '[管理员已删除网页观察]' })
    const now = new Date()
    const story = await this.getStory(storyId)
    const setting = this.initialStorySetting()
    await this.dbSet('interlude_story', { id: storyId }, {
      setting, state: emptyStoryState(), cursorAt: now, updatedAt: now,
    })
    await this.resetParticipantCanon(storyId, now)
    await this.ensureContinuity({ ...story, setting, state: emptyStoryState(), cursorAt: now }, now)
  }

  /** Reset all platforms, retaining exactly one empty global canonical story. */
  async purgeAllData(preferredStoryId?: string) {
    const all = await this.dbGet('interlude_story', {}, { sort: { updatedAt: 'desc' } })
    const active = all.filter(story => story.status === 'active')
    if (!active.length) return undefined
    const canonical = (preferredStoryId && active.find(story => story.id === preferredStoryId)) ?? active[0]
    for (const story of all) await this.purgeAllStoryData(story.id)
    const now = new Date()
    for (const story of all) {
      if (story.id === canonical.id) continue
      await this.dbSet('interlude_story', { id: story.id }, { status: 'archived', updatedAt: now })
    }
    return canonical.id
  }

  /** Delete one adapter/platform's records without touching other platforms. */
  async purgePlatformData(platform: string) {
    const all = await this.dbGet('interlude_story', {}, { sort: { updatedAt: 'desc' } })
    const targets = all.filter(story => samePlatformFamily(story.platform, platform))
    for (const story of targets) {
      await this.purgeAllStoryData(story.id)
      await this.dbSet('interlude_story', { id: story.id }, { status: 'archived', updatedAt: new Date() })
    }
    return targets.length
  }

  /**
   * Clear only HDSI-owned tables. Koishi's users/channels and other plugins
   * are intentionally untouched; deleting the physical SQLite file from a
   * command would be unsafe while the driver is open.
   */
  async clearDatabase() {
    if (this.databaseResetting) throw new Error('HDSI 数据库清空已经在进行中。')
    this.databaseResetting = true
    this.invalidateBufferedNarratives()
    try {
    const tables = [
      'interlude_script_entry', 'interlude_memory', 'interlude_intent',
      'interlude_scene', 'interlude_arc', 'interlude_fact', 'interlude_state_patch', 'interlude_overlay_snapshot', 'interlude_web_observation',
      'interlude_participant', 'interlude_story',
    ] as const
    let removed = 0
    let logicallyCleared = 0
    for (const table of tables) {
      const rows = await this.dbGet(table, {})
      if (!rows.length) continue
      removed += rows.length
      try {
        await this.dbRemove(table, {})
      } catch (error) {
        // Preserve the established disk-I/O fallback: content is redacted and
        // stories are archived so a locked sql.js file cannot revive a story.
        this.reportStandalone('warn', 'SQLite 清空表失败，改用逻辑清空 表=%s 错误=%s', table, error)
        for (const row of rows) {
          const id = (row as any).id
          const fallback: any = table === 'interlude_story'
            ? { status: 'archived', setting: this.initialStorySetting(), state: emptyStoryState() }
            : table === 'interlude_participant'
              ? { status: 'paused', profile: '', relationship: '', state: emptyParticipantState() }
              : table === 'interlude_script_entry'
                ? { kind: 'redacted', actor: 'system', content: '[HDSI 数据库已清空]', metadata: { redacted: true } }
                : table === 'interlude_memory'
                  ? { status: 'deleted', content: '[HDSI 数据库已清空]' }
                  : table === 'interlude_intent'
                    ? { status: 'cancelled', summary: '[HDSI 数据库已清空]' }
                    : table === 'interlude_scene' || table === 'interlude_arc'
                      ? { status: 'closed', hook: '', summary: '', entryCount: 0, sceneCount: 0 }
                      : table === 'interlude_fact'
                        ? { status: 'superseded', content: '[HDSI 数据库已清空]' }
                        : table === 'interlude_web_observation'
                          ? { status: 'deleted', url: '', title: '', excerpt: '', summary: '[HDSI 数据库已清空]' }
                        : { status: 'rejected', proposedValue: '[HDSI 数据库已清空]', evidence: '' }
          await this.dbSet(table, { id }, fallback)
          logicallyCleared++
        }
      }
    }
    return { removed, logicallyCleared }
    } finally {
      this.databaseResetting = false
    }
  }

  /** Remove script and derived memory records whose timestamps overlap a range. */
  async purgeStoryRange(storyId: string, from: Date, to: Date) {
    this.invalidateBufferedNarratives(storyId)
    const inRange = (value: Date | null | undefined) => !!value && value >= from && value <= to
    const entries = await this.dbGet('interlude_script_entry', { storyId })
    const entryIds = new Set(entries.filter(entry => inRange(entry.occurredAt)).map(entry => entry.id))
    for (const entry of entries) if (entryIds.has(entry.id)) await this.purgeTable('interlude_script_entry', { id: entry.id }, {
      kind: 'redacted', actor: 'system', content: '[管理员已删除剧本内容]', metadata: { redacted: true },
    })

    const memories = await this.dbGet('interlude_memory', { storyId })
    for (const memory of memories) {
      if (inRange(memory.createdAt) || (memory.sourceEntryId != null && entryIds.has(memory.sourceEntryId))) {
        await this.purgeTable('interlude_memory', { id: memory.id }, { status: 'deleted', content: '[管理员已删除记忆]' })
      }
    }

    const facts = await this.dbGet('interlude_fact', { storyId })
    for (const fact of facts) {
      const sourced = (fact.sourceEntryIds ?? []).some(id => entryIds.has(id))
      if (inRange(fact.createdAt) || inRange(fact.updatedAt) || inRange(fact.lastSeenAt) || sourced) {
        await this.purgeTable('interlude_fact', { id: fact.id }, { status: 'superseded', content: '[管理员已删除事实]' })
      }
    }

    const intents = await this.dbGet('interlude_intent', { storyId })
    for (const intent of intents) {
      if (inRange(intent.createdAt) || inRange(intent.notBefore) || inRange(intent.updatedAt)) {
        await this.purgeTable('interlude_intent', { id: intent.id }, { status: 'cancelled', summary: '[管理员已取消意图]' })
      }
    }

    const scenes = await this.dbGet('interlude_scene', { storyId })
    for (const scene of scenes) {
      const overlaps = scene.startedAt <= to && (!scene.endedAt || scene.endedAt >= from)
      if (overlaps) await this.purgeTable('interlude_scene', { id: scene.id }, { status: 'closed', hook: '', summary: '', entryCount: 0 })
    }
    const arcs = await this.dbGet('interlude_arc', { storyId })
    for (const arc of arcs) if (inRange(arc.createdAt) || inRange(arc.updatedAt)) await this.purgeTable('interlude_arc', { id: arc.id }, { status: 'closed', summary: '', sceneCount: 0 })

    const patches = await this.dbGet('interlude_state_patch', { storyId })
    for (const patch of patches) if (inRange(patch.createdAt) || inRange(patch.appliedAt)) await this.purgeTable('interlude_state_patch', { id: patch.id }, { status: 'rejected', proposedValue: '[管理员已删除提案]', evidence: '' })

    const observations = await this.dbGet('interlude_web_observation', { storyId })
    for (const observation of observations) {
      if (inRange(observation.createdAt) || inRange(observation.accessedAt)) {
        await this.purgeTable('interlude_web_observation', { id: observation.id }, { status: 'deleted', url: '', title: '', excerpt: '', summary: '[管理员已删除网页观察]' })
      }
    }

    const story = await this.getStory(storyId)
    await this.ensureContinuity(story, new Date())
  }

  /** Entry point for configured OneBot group chats. Group members do not need
   * private-message authorization; the group allowlist controls access. */
  async receiveGroup(session: Session) {
    if (this.databaseResetting || !this.canHandleGroupSession(session)) return false
    const groupId = sessionGroupId(session)
    const rule = this.groupRule(groupId)
    if (!rule) return false
    const mentionedBot = mentionsBot(session)
    const quotedBot = quotesBot(session)
    if (rule.responseMode === 'mention-only' && !mentionedBot) return false
    let story = await this.findStory(session)
    if (!story && this.config.runtime.autoCreate) story = await this.createStory(session)
    if (!story || story.status !== 'active') return false
    const now = new Date()
    const senderId = normalizeAccountId(session.userId)
    const senderName = await this.groupSenderName(groupId, senderId, session)
    const quote = describeQuotedMessage(session, story.setting.character.name)
    const messageContent = normalizeQQNativeFaceSegments(session.content)
    const accepted = await this.serial(story.id, async () => {
      const current = await this.getStory(story!.id)
      const entry = await this.appendEntry(current.id, {
        kind: 'group-message', actor: 'user', content: messageContent,
        occurredAt: now.toISOString(),
        metadata: {
          groupId, senderId, senderName, channelId: session.channelId, messageId: session.messageId,
          ...(quote ? { quote } : {}),
        },
      }, now)
      await this.pauseAutomaticAdvanceAfterUserMessage(current.id, now)
      return entry
    })
    const messageId = targetableMessageId(session.messageId)
    this.bufferGroupMessage(story, rule, session, {
      senderId, senderName, speaker: formatGroupSpeaker(senderName, senderId),
      ...(messageId ? { messageId, messageRef: groupMessageRef(accepted.id) } : {}),
      ...(quote ? { quote } : {}),
      content: messageContent, occurredAt: now, direction: 'user',
    }, mentionedBot, quotedBot)
    this.reportOperation('summary', 'info', story, 'user-message', '收到群聊消息 群=%s 发送者=%s', groupId, senderId)
    return true
  }

  async receive(session: Session) {
    if (this.databaseResetting) return false
    // Check before find/create so an unauthorized QQ can neither trigger the
    // model nor create a persistent story by merely sending a private message.
    if (!this.canHandleSession(session)) return false
    let story = await this.findStory(session)
    if (!story && this.config.runtime.autoCreate) story = await this.createStory(session)
    if (!story || story.status !== 'active') {
      this.reportStandaloneOperation('diagnostic', 'debug', '私聊未处理：故事不存在或已暂停 平台=%s 机器人ID=%s 用户ID=%s', session.platform, session.selfId, session.userId)
      return false
    }
    let participant = await this.findParticipant(session, story)
    if (participant) {
      // A whitelist row can be edited after this QQ first joined the shared
      // story. Refresh the current branch before composing its model context.
      // ensureParticipant performs no write when nothing actually changed.
      participant = await this.ensureParticipant(story, session, new Date(), participant)
    } else if (this.config.runtime.autoCreate || this.sharedStoryConfig.autoEnrollParticipants) {
      participant = await this.ensureParticipant(story, session)
    }
    if (!participant || participant.status !== 'active') {
      this.reportOperation('diagnostic', 'debug', story, 'user-message', '私聊未处理：参与者不存在或已暂停 用户ID=%s', session.userId)
      return false
    }
    // Mark the relationship synchronously before waiting for the story queue.
    // This lets an arriving message invalidate a model request that is about
    // to persist, and lets a due split segment stop before transport begins.
    this.signalIncomingInterruption(story, participant)
    this.reportOperation('summary', 'info', story, 'user-message', '收到参与者私聊消息 参与者=%s', participant.id)
    const userInput = await this.describeUserEvent(story, session)
    if (this.config.logging?.logMessageContent) {
      this.reportOperation('diagnostic', 'info', story, 'user-message', '用户消息内容：%s', userInput.content.slice(0, this.config.logging.previewLength))
    }

    const accepted = await this.serial(story.id, async () => {
      const current = await this.getStory(story.id)
      const currentParticipant = await this.getParticipant(participant!.id)
      if (!currentParticipant || currentParticipant.status !== 'active') return undefined
      const now = new Date()
      const incomingParticipant = await this.recordIncomingMessage(currentParticipant, now)
      const superseded = await this.cancelPendingOutgoingMessages(
        current.id,
        incomingParticipant.id,
        now,
        this.config.runtime.cancelDelayedRepliesOnUserMessage,
      )
      await this.appendEntry(current.id, {
        kind: 'user-message', actor: 'user', content: userInput.content,
        occurredAt: now.toISOString(), metadata: {
          platform: session.platform, messageId: session.messageId, personId: incomingParticipant.personId,
          ...(userInput.quote ? { quote: userInput.quote } : {}),
          ...(userInput.voice.detected ? { voice: userInput.voice } : {}),
        },
      }, now, incomingParticipant.id)
      // Messages are persisted at arrival. The model request itself is
      // debounced below, so a burst can become one coherent writing turn.
      await this.pauseAutomaticAdvanceAfterUserMessage(current.id, now)
      return { story: current, participant: incomingParticipant, now, superseded }
    })
    if (!accepted) return false
    this.bufferUserNarrative(accepted.story, accepted.participant, session, accepted.now, accepted.superseded, userInput.content, userInput.sources, userInput.quote)
    if (userInput.sources.length) {
      this.reportOperation('standard', 'info', accepted.story, 'user-message', '当前事件包含图片附件 数量=%d 原生识图=%s', userInput.sources.length, this.config.model.vision?.enabled ? '开启' : '关闭')
    }
    if (userInput.voice.detected) {
      this.reportOperation('standard', 'info', accepted.story, 'user-message', '当前事件包含语音 消息段=%d 转写=%s', userInput.voice.detected, userInput.voice.transcribed ? '完成' : '未完成')
    }
    this.reportOperation('standard', 'info', accepted.story, 'user-message', '用户回合已入队 参与者=%s 已取消旧计划=%d', accepted.participant.id, accepted.superseded.length)
    return true
  }

  private async groupSenderName(groupId: string, userId: string, session: Session) {
    const account = this.userAccountRule(userId)
    const author = (session as any).author as { nick?: unknown, name?: unknown, username?: unknown } | undefined
    const observed = normalizeGroupDisplayName(account?.label, author?.nick, session.username, author?.name, author?.username)
    if (observed) return observed

    const key = `${normalizeGroupId(groupId)}:${userId}`
    const cached = this.groupMemberNameCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.name
    const pending = this.groupMemberNameLookups.get(key) ?? this.lookupGroupMemberName(key, groupId, userId, session.selfId)
    this.groupMemberNameLookups.set(key, pending)
    try { return await pending || userId }
    finally { this.groupMemberNameLookups.delete(key) }
  }

  private async lookupGroupMemberName(cacheKey: string, groupId: string, userId: string, selfId: string) {
    const bot = this.ctx.bots.find(item => String(item.selfId) === String(selfId)
      && (item.platform === 'onebot' || isOneBotPlatform(item.platform))) as any
    if (typeof bot?.getGuildMember !== 'function') return ''
    try {
      const member = await bot.getGuildMember(normalizeGroupId(groupId), userId)
      const name = normalizeGroupDisplayName(member?.nick, member?.name, member?.user?.name)
      if (!name) return ''
      this.groupMemberNameCache.set(cacheKey, { name, expiresAt: Date.now() + 12 * Time.hour })
      return name
    } catch {
      return ''
    }
  }

  private bufferGroupMessage(story: InterludeStory, rule: GroupChatRule, session: Session, message: GroupMessageContext, mentionedBot: boolean, quotedBot: boolean) {
    const key = `${story.id}:${normalizeGroupId(rule.groupId)}`
    const existing = this.bufferedGroupTurns.get(key)
    const turn: BufferedGroupTurn = existing ?? {
      storyId: story.id, groupId: normalizeGroupId(rule.groupId), rule,
      channelId: session.channelId, messages: [], revision: 0, mentionedBot: false, quotedBot: false,
    }
    if (turn.timer) turn.timer()
    turn.channelId = session.channelId
    turn.latestSession = session
    turn.messages.push(message)
    turn.mentionedBot ||= mentionedBot
    turn.quotedBot ||= quotedBot
    const revision = ++turn.revision
    const delay = Math.max(0, rule.debounceSeconds ?? 1) * Time.second
    turn.timer = this.ctx.setTimeout(() => void this.flushGroupTurn(key, revision), delay)
    this.bufferedGroupTurns.set(key, turn)
  }

  private async flushGroupTurn(key: string, revision: number) {
    const turn = this.bufferedGroupTurns.get(key)
    if (!turn || turn.revision !== revision || this.databaseResetting) return
    if (this.narratingStories.has(turn.storyId)) {
      turn.timer = this.ctx.setTimeout(() => void this.flushGroupTurn(key, revision), 250)
      return
    }
    turn.timer = undefined
    const batch = turn.messages.splice(0)
    if (!batch.length) {
      this.bufferedGroupTurns.delete(key)
      return
    }
    let story: InterludeStory
    try {
      story = await this.getStory(turn.storyId)
    } catch (error) {
      this.reportStandalone('warn', '群聊回合读取剧本失败，已放弃本批消息 故事=%s 错误=%s', turn.storyId, error)
      if (!turn.messages.length && !turn.timer) this.bufferedGroupTurns.delete(key)
      return
    }
    if (story.status !== 'active') {
      if (!turn.messages.length && !turn.timer) this.bufferedGroupTurns.delete(key)
      return
    }
    const willingness = evaluateGroupWillingness(this.groupWillingness.get(key), turn.rule.willingness, {
      now: Date.now(), messageCount: batch.length, content: batch.map(message => message.content).join('\n'),
      mentionedBot: turn.mentionedBot, quotedBot: turn.quotedBot,
    })
    this.groupWillingness.set(key, willingness.state)
    turn.mentionedBot = false
    turn.quotedBot = false
    if (!willingness.shouldCall) {
      this.reportOperation('diagnostic', 'debug', story, 'user-message',
        '群聊意愿未触发模型调用 群=%s 分数=%s 概率=%s 原因=%s', turn.groupId,
        willingness.state.score.toFixed(3), willingness.probability.toFixed(3), willingness.reason)
      if (!turn.messages.length && !turn.timer) this.bufferedGroupTurns.delete(key)
      return
    }
    if (await this.groupCooldownActive(story.id, turn.groupId, turn.rule.cooldownSeconds)) {
      this.reportOperation('diagnostic', 'debug', story, 'user-message', '群聊仍在冷却期，跳过群发言 群=%s', turn.groupId)
      if (!turn.messages.length && !turn.timer) this.bufferedGroupTurns.delete(key)
      return
    }
    this.reportOperation('standard', 'info', story, 'user-message', '群聊消息准备进入主叙事 群=%s 模式=%s 意愿=%s', turn.groupId, turn.rule.responseMode, willingness.state.score.toFixed(3))
    this.narratingStories.add(turn.storyId)
    try {
      const snapshot = await this.serial(story.id, async () => {
        const current = await this.getStory(story.id)
        const contextMessages = await this.groupMessages(current.id, turn.groupId, turn.rule.contextLimit)
        const now = new Date()
        return { story: current, from: narrativeCursor(current, now), now, contextMessages }
      })
      const groupContext: GroupContext = {
        groupId: turn.groupId, channelId: turn.channelId, label: turn.rule.label,
        purpose: turn.rule.purpose, characterRole: turn.rule.characterRole,
        messages: snapshot.contextMessages,
      }
      const chatCapabilities = this.groupChatCapabilities(turn.latestSession, groupContext.messages)
      const stickerCatalog = this.stickerCatalogForSession(turn.latestSession)
      const userMessage = batch.map((message, index) => `[群聊连续消息 ${index + 1}｜${message.speaker}]\n${message.content}`).join('\n\n')
      const { decision, succeeded } = await this.tryDecide(snapshot.story, null, 'user-message', snapshot.from, snapshot.now, userMessage, [], [], groupContext, [], chatCapabilities, [], stickerCatalog)
      const chatActions = normalizeGroupChatActions(decision, chatCapabilities, groupContext)
      const sticker = this.resolveSticker(decision.localMedia, stickerCatalog)
      const nativeFace = sticker ? undefined : this.resolveNativeFace(decision, chatCapabilities)
      const result = await this.serial(story.id, async () => {
        if (this.databaseResetting || !succeeded) return { content: '', messages: [] as OutgoingMessageDraft[], chatActions: { reactions: [] } as ExecutableGroupChatActions }
        const current = await this.getStory(story.id)
        const messages = await this.persistDecision(current, null, decision, snapshot.from, snapshot.now, false, 'user-message')
        const content = normalizeGroupVisibleReply(decision.groupReply, decision.interaction, this.config.runtime.maxMessageCharacters)
        if (content) {
          await this.appendEntry(current.id, {
            kind: 'character-group-message', actor: 'character', content,
            occurredAt: snapshot.now.toISOString(),
            metadata: {
              groupId: turn.groupId, channelId: turn.channelId,
              ...(chatActions.replyTo ? { replyTo: chatActions.replyTo.messageRef } : {}),
            },
          }, snapshot.now)
        }
        await this.dbSet('interlude_story', { id: current.id }, { cursorAt: snapshot.now, updatedAt: new Date() })
        if (succeeded) await this.scheduleConversationFollowUpsAfterTurn(current.id, snapshot.now, decision.interaction)
        return { content, messages, chatActions, sticker, nativeFace }
      })
      const completedReactions = result.chatActions.reactions.length && turn.latestSession
        ? await this.executeGroupReactions(snapshot.story, turn.latestSession, turn.groupId, result.chatActions.reactions)
        : 0
      if (result.content || completedReactions || result.sticker || result.nativeFace) {
        this.groupWillingness.set(key, consumeGroupWillingness(this.groupWillingness.get(key), turn.rule.willingness, Date.now()))
      }
      if (result.content) {
        await this.sendGroupMessage(snapshot.story, turn.channelId, result.content, result.chatActions.replyTo?.messageId)
      }
      if (result.sticker && turn.latestSession) await this.sendSticker(snapshot.story, turn.latestSession, turn.channelId, result.sticker)
      if (result.nativeFace && turn.latestSession) await this.sendNativeFace(snapshot.story, turn.latestSession, turn.channelId, result.nativeFace)
      this.scheduleCompaction(story.id)
    } catch (error) {
      this.report('warn', story, 'user-message', '群聊主叙事失败，保持静默 群=%s 错误=%s', turn.groupId, error)
    } finally {
      this.narratingStories.delete(turn.storyId)
      if (!turn.messages.length && !turn.timer) this.bufferedGroupTurns.delete(key)
    }
  }
  private async groupMessages(storyId: string, groupId: string, limit: number) {
    const rows = await this.dbGet('interlude_script_entry', { storyId }, {
      limit: Math.max(20, Math.min(200, limit * 8)), sort: { occurredAt: 'desc' },
    })
    return rows
      .filter(entry => ['group-message', 'character-group-message'].includes(entry.kind) && normalizeGroupId(String(entry.metadata?.groupId ?? '')) === normalizeGroupId(groupId))
      .slice(0, Math.max(1, limit))
      .reverse()
      .map(entry => ({
        senderId: String(entry.metadata?.senderId ?? (entry.actor === 'character' ? 'character' : 'unknown')),
        senderName: String(entry.metadata?.senderName ?? (entry.actor === 'character' ? '主角' : entry.metadata?.senderId ?? '群成员')),
        speaker: formatGroupSpeaker(
          String(entry.metadata?.senderName ?? (entry.actor === 'character' ? '主角' : entry.metadata?.senderId ?? '群成员')),
          String(entry.metadata?.senderId ?? (entry.actor === 'character' ? 'character' : 'unknown')),
        ),
        ...(targetableMessageId(entry.metadata?.messageId)
          ? { messageId: targetableMessageId(entry.metadata?.messageId), messageRef: groupMessageRef(entry.id) }
          : {}),
        ...(normalizeQuotedMessageContext(entry.metadata?.quote) ? { quote: normalizeQuotedMessageContext(entry.metadata?.quote) } : {}),
        content: entry.content, occurredAt: entry.occurredAt,
        direction: entry.actor === 'character' ? 'character' as const : 'user' as const,
      }))
  }

  private async groupCooldownActive(storyId: string, groupId: string, cooldownSeconds: number) {
    if (cooldownSeconds <= 0) return false
    const rows = await this.dbGet('interlude_script_entry', { storyId }, {
      limit: 100, sort: { occurredAt: 'desc' },
    })
    const latest = rows.find(entry => ['character-group-message', 'character-platform-action'].includes(entry.kind)
      && normalizeGroupId(String(entry.metadata?.groupId ?? '')) === normalizeGroupId(groupId))
    return !!latest && Date.now() - latest.occurredAt.getTime() < cooldownSeconds * Time.second
  }

  private groupChatCapabilities(session: Session | undefined, messages: GroupMessageContext[]): ChatActionCapabilities | undefined {
    const config = this.config.chatActions
    if (!config?.enabled || !session || !isOneBotPlatform(session.platform) || !config.platforms?.includes('qq')) return undefined
    if (!messages.some(message => !!message.messageRef && !!message.messageId)) return undefined
    const internal = (session as any).bot?.internal
    const quoteReply = config.quoteReply === true
    const reactions = config.messageReactions === true && typeof internal?.setMsgEmojiLike === 'function'
      ? normalizeAllowedReactions(config.allowedReactions)
      : []
    const nativeFaces = config.nativeFaces === true ? normalizeAllowedNativeFaces(config.allowedNativeFaces) : []
    if (!quoteReply && !reactions.length && !nativeFaces.length) return undefined
    return { platform: 'qq', quoteReply, reactions, nativeFaces, expressionThreshold: normalizeExpressionThreshold(config.expressionThreshold) }
  }

  private privateChatCapabilities(session: Session | undefined): ChatActionCapabilities | undefined {
    const config = this.config.chatActions
    if (!config?.enabled || !session || !isOneBotPlatform(session.platform) || !config.platforms?.includes('qq')) return undefined
    const nativeFaces = config.nativeFaces === true ? normalizeAllowedNativeFaces(config.allowedNativeFaces) : []
    if (!nativeFaces.length) return undefined
    return { platform: 'qq', quoteReply: false, reactions: [], nativeFaces, expressionThreshold: normalizeExpressionThreshold(config.expressionThreshold) }
  }

  private async executeGroupReactions(story: InterludeStory, session: Session, groupId: string, reactions: ExecutableMessageReaction[]) {
    const internal = (session as any).bot?.internal
    let completed = 0
    for (const reaction of reactions.slice(0, 1)) {
      try {
        const emojiId = QQ_REACTION_IDS[reaction.reaction]
        if (typeof internal?.setMsgEmojiLike !== 'function') continue
        await internal.setMsgEmojiLike(reaction.messageId, emojiId, true)
        const completedAt = new Date()
        await this.serial(story.id, async () => this.appendEntry(story.id, {
          kind: 'character-platform-action', actor: 'character',
          content: `主角给群消息 ${reaction.messageRef} 添加了 ${reaction.reaction} 表情回应。`,
          occurredAt: completedAt.toISOString(),
          metadata: { platform: 'qq', action: 'message-reaction', groupId, messageRef: reaction.messageRef, reaction: reaction.reaction },
        }, completedAt))
        completed += 1
        this.reportOperation('standard', 'info', story, 'user-message', '聊天动作完成 类型=消息表情 群=%s 目标=%s 表情=%s', groupId, reaction.messageRef, reaction.reaction)
      } catch (error) {
        this.report('warn', story, 'user-message', '聊天动作失败 类型=消息表情 群=%s 目标=%s 错误=%s', groupId, reaction.messageRef, error)
      }
    }
    return completed
  }

  private resolveSticker(draft: LocalMediaDraft | undefined, catalog: StickerCatalogEntry[]) {
    if (!draft || typeof draft.assetId !== 'string' || typeof draft.willingness !== 'number' || !catalog.some(item => item.assetId === draft.assetId)) return undefined
    if (normalizeExpressionThreshold(draft.willingness) < this.expressionThreshold) return undefined
    return this.stickerById.get(draft.assetId)
  }

  private get expressionThreshold() {
    return normalizeExpressionThreshold(this.config.chatActions?.expressionThreshold)
  }

  private resolveNativeFace(decision: NarrativeDecision, capabilities: ChatActionCapabilities | undefined): NativeFaceSemantic | undefined {
    const allowed = new Set(capabilities?.nativeFaces ?? [])
    if (!allowed.size) return undefined
    const draft = decision.nativeFace
    const replyContent = decision.groupReply?.content ?? decision.interaction?.reply?.content ?? ''
    if (draft && allowed.has(draft.semantic) && calibratedNativeFaceWillingness(draft.semantic, draft.willingness, replyContent) >= (capabilities?.expressionThreshold ?? this.expressionThreshold)) {
      return draft.semantic
    }
    // Legacy bracket labels are parsed out of visible text by the compatibility
    // layer, but have no declared willingness and therefore never bypass the
    // expression threshold.
    return undefined
  }

  private async sendSticker(story: InterludeStory, session: Session, channelId: string, asset: StickerAsset) {
    const root = resolve(this.ctx.baseDir, this.stickerConfig.directory)
    const file = resolve(root, asset.filePath)
    const relativePath = relative(root, file)
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || relativePath.includes(':')) return
    try {
      await session.bot.sendMessage(channelId, h('img', { src: pathToFileURL(file).href }))
      const now = new Date()
      await this.serial(story.id, async () => this.appendEntry(story.id, {
        kind: 'character-platform-action', actor: 'character',
        content: `主角发送了本地表情包：${asset.description}`,
        occurredAt: now.toISOString(),
        metadata: { platform: session.platform, action: 'local-sticker', assetId: asset.assetId, group: asset.group, animated: asset.animated },
      }, now))
      this.reportOperation('standard', 'info', story, 'user-message', '聊天动作完成 类型=本地表情包 素材=%s', asset.assetId)
    } catch (error) {
      this.report('warn', story, 'user-message', '聊天动作失败 类型=本地表情包 素材=%s 错误=%s', asset.assetId, error)
    }
  }

  private async sendNativeFace(story: InterludeStory, session: Session, channelId: string, semantic: NativeFaceSemantic) {
    try {
      await session.bot.sendMessage(channelId, h('face', { id: QQ_NATIVE_FACE_IDS[semantic] }))
      const now = new Date()
      await this.serial(story.id, async () => this.appendEntry(story.id, {
        kind: 'character-platform-action', actor: 'character', content: `主角发送了 ${semantic} 原生表情。`,
        occurredAt: now.toISOString(), metadata: { platform: session.platform, action: 'native-face', semantic },
      }, now))
      this.reportOperation('standard', 'info', story, 'user-message', '聊天动作完成 类型=原生表情 语义=%s', semantic)
    } catch (error) {
      this.report('warn', story, 'user-message', '聊天动作失败 类型=原生表情 语义=%s 错误=%s', semantic, error)
    }
  }

  private async sendGroupMessage(story: InterludeStory, channelId: string, content: string, replyToMessageId?: string) {
    const bot = this.ctx.bots.find(item => String(item.selfId) === String(story.selfId)
      && (item.platform === story.platform || isOneBotPlatform(item.platform) && isOneBotPlatform(story.platform)))
    if (!bot) {
      this.report('warn', story, 'user-message', '没有可用机器人账号投递群消息 群频道=%s', channelId)
      return
    }
    for (const [index, segment] of this.splitOutgoingMessage(content).entries()) {
      const outgoing = index === 0 && replyToMessageId
        ? [h('quote', { id: replyToMessageId }), segment]
        : segment
      try { await bot.sendMessage(channelId, outgoing) }
      catch (error) { this.report('warn', story, 'user-message', '群消息投递失败 群频道=%s 错误=%s', channelId, error) }
    }
  }

  /**
   * Persisted messages wait here briefly before they reach the narrator. This
   * makes “你好 / 在吗 / 我有件事想问” one event without risking message loss.
   */
  private bufferUserNarrative(story: InterludeStory, participant: InterludeParticipant, session: Session, now: Date, supersededIntents: NarrativeIntent[], content = String(session.content ?? ''), imageSources: string[] = [], quote?: QuotedMessageContext) {
    const key = participant.id
    const existing = this.bufferedNarrativeTurns.get(key)
    const turn: BufferedNarrativeTurn = existing ?? {
      storyId: story.id, participantId: participant.id, messages: [], nextRevision: 0, obsoleteRequestIds: new Set(),
    }
    if (shouldSupersedeNarrativeRequest(turn.inFlightRequestId, turn.firstMessageCommittedRequestId, turn.obsoleteRequestIds)) {
      turn.obsoleteRequestIds.add(turn.inFlightRequestId)
      this.reportOperation('standard', 'info', story, 'user-message', '新消息到达且首条回复尚未提交，放弃旧请求 参与者=%s 请求=%d', participant.id, turn.inFlightRequestId)
    }
    turn.messages.push({ content, occurredAt: now, supersededIntents, imageSources, ...(quote ? { quote } : {}) })
    turn.latestSession = session
    if (turn.timer) turn.timer()
    const revision = ++turn.nextRevision
    const delay = Math.max(0, this.config.runtime.userMessageDebounceSeconds ?? 2) * Time.second
    turn.timer = this.ctx.setTimeout(() => void this.flushBufferedNarrative(key, revision), delay)
    this.bufferedNarrativeTurns.set(key, turn)
    this.reportOperation('diagnostic', 'debug', story, 'user-message', '短时消息合并 参与者=%s 待处理=%d 等待=%dms', participant.id, turn.messages.length, delay)
  }

  private signalIncomingInterruption(story: InterludeStory, participant: InterludeParticipant) {
    this.interruptedTypingParticipants.add(participant.id)
    const turn = this.bufferedNarrativeTurns.get(participant.id)
    if (!turn || !shouldSupersedeNarrativeRequest(turn.inFlightRequestId, turn.firstMessageCommittedRequestId, turn.obsoleteRequestIds)) return
    turn.obsoleteRequestIds.add(turn.inFlightRequestId)
    this.reportOperation('standard', 'info', story, 'user-message',
      '新消息到达且首条回复尚未提交，放弃旧请求 参与者=%s 请求=%d', participant.id, turn.inFlightRequestId)
  }

  /** Extract structured image segments without treating them as a second event. */
  private get voiceTranscriptionConfig(): VoiceTranscriptionConfig {
    const configured = this.config.onebot?.voiceTranscription
    return {
      enabled: configured?.enabled === true,
      timeoutMs: Math.max(1_000, Math.min(60_000, Number(configured?.timeoutMs) || 20_000)),
    }
  }

  private get stickerConfig(): StickerLibraryConfig {
    const configured = this.config.stickers
    return {
      enabled: configured?.enabled === true,
      directory: String(configured?.directory || 'data/hds-interlude/stickers').trim(),
      maxFileSizeMB: Math.max(1, Math.min(30, Number(configured?.maxFileSizeMB) || 10)),
      catalogLimit: Math.max(1, Math.min(80, Math.floor(Number(configured?.catalogLimit) || 40))),
    }
  }

  private async describeUserEvent(story: InterludeStory, session: Session) {
    const visual = this.describeVisionEvent(session)
    const voice = await this.transcribeVoiceEvent(story, session)
    return {
      content: mergeUserMessageWithVoiceTranscripts(visual.content, voice.transcripts, voice.detected),
      sources: visual.sources,
      quote: describeQuotedMessage(session, story.setting.character.name),
      voice: { detected: voice.detected, transcribed: voice.transcripts.length > 0, provider: voice.provider },
    }
  }

  private async scanStickerLibrary() {
    const config = this.stickerConfig
    if (!config.enabled || this.stickerScanRunning) return
    this.stickerScanRunning = true
    try {
      const root = resolve(this.ctx.baseDir, config.directory)
      const files = await listStickerFiles(root)
      const existing = await this.dbGet('interlude_sticker', {}) as StickerAsset[]
      const byPath = new Map(existing.map(item => [item.filePath, item]))
      const seen = new Set<string>()
      const pending: Array<{ asset: StickerAsset, bytes: Buffer }> = []
      for (const file of files) {
        const filePath = relative(root, file).replace(/\\/g, '/')
        if (!filePath || filePath.startsWith('../')) continue
        seen.add(filePath)
        const info = await stat(file)
        if (info.size > config.maxFileSizeMB * 1024 * 1024) continue
        const bytes = await readFile(file)
        const hash = createHash('sha256').update(bytes).digest('hex')
        const prior = byPath.get(filePath)
        if (prior?.hash === hash && prior.status === 'active') continue
        const group = filePath.includes('/') ? filePath.split('/')[0] : 'default'
        const assetId = filePath.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9/_-]/g, '-').slice(0, 255)
        const now = new Date()
        const base = {
          assetId, filePath, group: group.slice(0, 128), mimeType: stickerMime(filePath), animated: /\.gif$/i.test(filePath),
          size: bytes.length, hash, description: '', aliases: [], status: 'pending' as const, updatedAt: now,
        }
        const asset = prior
          ? await this.dbSet('interlude_sticker', { id: prior.id }, base).then(() => ({ ...prior, ...base }))
          : await this.dbCreate('interlude_sticker', { ...base, createdAt: now }) as StickerAsset
        pending.push({ asset, bytes })
      }
      for (const asset of existing) {
        if (asset.status !== 'missing' && !seen.has(asset.filePath)) await this.dbSet('interlude_sticker', { id: asset.id }, { status: 'missing', updatedAt: new Date() })
      }
      if (pending.length && !this.stickerDescriber.available()) {
        this.reportStandalone('warn', '表情包库发现新素材，但没有配置 useForStickers 的视觉模型；已等待描述。')
      }
      for (const item of pending.slice(0, 5)) {
        if (!this.stickerDescriber.available()) break
        const visual = await this.imageBytesToNative(item.bytes, item.asset.mimeType)
        const description = visual && await this.stickerDescriber.describeSticker(visual.dataUri, visual.mimeType, item.asset.filePath, item.asset.animated)
        if (!description) continue
        await this.dbSet('interlude_sticker', { id: item.asset.id }, {
          description: description.description, aliases: description.aliases, status: 'active', updatedAt: new Date(),
        })
        this.reportStandaloneOperation('standard', 'info', '表情包描述完成 素材=%s 分组=%s', item.asset.assetId, item.asset.group)
      }
      await this.refreshStickerCatalog()
    } catch (error) {
      this.reportStandalone('warn', '表情包库扫描失败：%s', error)
    } finally {
      this.stickerScanRunning = false
    }
  }

  private async refreshStickerCatalog() {
    const rows = await this.dbGet('interlude_sticker', { status: 'active' }, { sort: { updatedAt: 'desc' } }) as StickerAsset[]
    this.stickerCatalog = rows
    this.stickerById = new Map(rows.map(item => [item.assetId, item]))
  }

  private stickerCatalogForSession(session: Session | undefined): StickerCatalogEntry[] {
    const config = this.stickerConfig
    if (!config.enabled || !session || !isOneBotPlatform(session.platform)) return []
    return this.stickerCatalog.slice(0, config.catalogLimit).map(asset => ({
      assetId: asset.assetId, group: asset.group, description: asset.description, aliases: Array.isArray(asset.aliases) ? asset.aliases : [], animated: asset.animated,
    }))
  }

  private async transcribeVoiceEvent(story: InterludeStory, session: Session) {
    const detected = extractSessionVoiceCount(session)
    const config = this.voiceTranscriptionConfig
    if (!detected || !config.enabled || !isOneBotPlatform(session.platform)) {
      return { detected, transcripts: [] as string[], provider: config.enabled ? 'unsupported' : 'disabled' }
    }
    const messageId = oneBotMessageId(session.messageId)
    const internal = (session as any).bot?.internal
    if (messageId == null || typeof internal?._request !== 'function') {
      this.reportOperation('diagnostic', 'warn', story, 'user-message', '语音转写跳过：当前 OneBot 适配器未提供 SnowLuma 原始动作通道')
      return { detected, transcripts: [] as string[], provider: 'unsupported' }
    }
    try {
      const response = await withTimeout(
        Promise.resolve(internal._request('fetch_ptt_text', { message_id: messageId })),
        config.timeoutMs,
      ) as any
      if (response?.retcode != null && Number(response.retcode) !== 0) throw new Error(String(response?.wording || response?.message || `retcode=${response.retcode}`))
      if (response?.status && response.status !== 'ok') throw new Error(String(response?.wording || response?.message || response.status))
      const data = response?.data ?? response
      const text = typeof data?.text === 'string' ? clip(data.text, 4_000) : ''
      if (!text) throw new Error('SnowLuma returned an empty transcription')
      return { detected, transcripts: [text], provider: 'snowluma' }
    } catch (error) {
      this.reportOperation('diagnostic', 'warn', story, 'user-message', '语音转写失败，已保留语音事实 错误=%s', error)
      return { detected, transcripts: [] as string[], provider: 'failed' }
    }
  }

  private describeVisionEvent(session: Session) {
    const raw = String(session.content ?? '')
    const sources = extractSessionImageSources(session)
    const text = normalizeQQNativeFaceSegments(raw)
      .replace(/<\/?(?:img|image|audio|record)\b[^>]*>/gi, '')
      .replace(/\[CQ:(?:image|record),[^\]]*\]/gi, '')
      .trim()
    // The attachment itself is passed through the native multimodal channel.
    // Keep ordinary text free of image placeholders: a failed/filtered fetch
    // must look like no visual input rather than an invitation to invent one.
    const content = text
    return { content, sources }
  }

  private async loadNativeImages(story: InterludeStory, sources: string[], session?: Session): Promise<NarrativeImage[]> {
    if (!this.config.model.vision?.enabled || !sources.length) return []
    const images: NarrativeImage[] = []
    for (const [index, source] of sources.slice(0, 3).entries()) {
      try {
        const image = await this.fetchNativeImage(source, (session as any)?.bot)
        if (image) images.push({ id: `turn-image-${index + 1}`, ...image })
      } catch (error) {
        this.report('warn', story, 'user-message', '图片读取失败，已继续处理文字消息 错误=%s', error)
      }
    }
    return images
  }

  private async fetchNativeImage(source: string, bot?: any, adapterProvided = false): Promise<{ mimeType: string, dataUri: string } | undefined> {
    const value = String(source ?? '').trim()
    if (value.startsWith('onebot-url:')) {
      const url = value.slice('onebot-url:'.length)
      return this.fetchNativeImage(url, bot, true)
    }
    if (value.startsWith('onebot-file:')) {
      const file = value.slice('onebot-file:'.length)
      if (!file || !bot?.getImage) return undefined
      const info = await bot.getImage(file)
      const candidates = [info?.url, info?.file, info?.path].map(item => String(item ?? '').trim()).filter(Boolean)
      for (const candidate of candidates) {
        if (/^https?:\/\//i.test(candidate)) {
          const image = await this.fetchNativeImage(candidate, undefined, true)
          if (image) return image
        } else {
          try {
            const bytes = await readFile(candidate)
            const image = await this.imageBytesToNative(bytes, guessImageMime(bytes, info?.type))
            if (image) return image
          } catch { /* adapter may return a non-local alias; try its next field */ }
        }
      }
      return undefined
    }
    if (/^data:image\//i.test(value)) {
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(value)
      if (!match) return undefined
      const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
      if (!bytes.length || bytes.length > 4 * 1024 * 1024) return undefined
      const mimeType = match[1].toLowerCase()
      return this.imageBytesToNative(bytes, mimeType)
    }
    let url: URL
    try { url = new URL(value) } catch { return undefined }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (!adapterProvided && !isTrustedImageHost(url.hostname)) return undefined
    const response = await this.ctx.http('GET', url.href, { responseType: 'arraybuffer', timeout: 10_000, redirect: 'error' })
    const bytes = Buffer.from(response.data)
    if (!bytes.length || bytes.length > 4 * 1024 * 1024) return undefined
    const mimeType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || guessImageMime(bytes)
    return this.imageBytesToNative(bytes, mimeType)
  }

  /** Convert adapter/fetched bytes into one bounded native-vision attachment.
   * Animated stickers are rendered to a representative PNG frame when the
   * optional Puppeteer service is available; otherwise the original image is
   * still passed through rather than inventing a description. */
  private async imageBytesToNative(bytes: Buffer, mimeType: string): Promise<{ mimeType: string, dataUri: string } | undefined> {
    const normalized = String(mimeType || guessImageMime(bytes) || '').toLowerCase()
    if (!normalized.startsWith('image/')) return undefined
    const dataUri = `data:${normalized};base64,${bytes.toString('base64')}`
    if (isAnimatedImageMime(normalized)) {
      const frame = await this.renderAnimatedImageFrame(dataUri)
      if (frame) return frame
      this.reportStandalone('warn', '动态图片未能抽帧，已使用原始图片输入；请启用 Puppeteer 以提高识别兼容性。')
    }
    return { mimeType: normalized, dataUri }
  }

  private async renderAnimatedImageFrame(dataUri: string) {
    const puppeteer = (this.ctx as any).puppeteer
    if (!puppeteer?.page) return undefined
    return this.withBrowserSlot(async () => {
      let page: any
      try {
        page = await puppeteer.page()
        await page.setContent(`<img id="hdsi-image" src="${dataUri}" style="display:block;max-width:4096px;max-height:4096px">`, { waitUntil: 'load', timeout: 10_000 })
        await page.evaluate(() => new Promise<void>(resolve => {
          const image = document.querySelector('#hdsi-image') as HTMLImageElement | null
          if (!image || image.complete) return resolve()
          image.addEventListener('load', () => resolve(), { once: true })
          image.addEventListener('error', () => resolve(), { once: true })
        }))
        const element = await page.$('#hdsi-image')
        if (!element) return undefined
        const buffer = Buffer.from(await element.screenshot({ type: 'png' }))
        if (!buffer.length || buffer.length > 4 * 1024 * 1024) return undefined
        return { mimeType: 'image/png', dataUri: `data:image/png;base64,${buffer.toString('base64')}` }
      } catch (error) {
        this.reportStandalone('debug', '动态图片抽帧失败：%s', error)
        return undefined
      } finally {
        if (page) await page.close().catch(() => undefined)
      }
    })
  }

  /** Prevent timers or already-returning model calls from resurrecting data
   * after an administrator resets the story or clears HDSI tables. */
  private invalidateBufferedNarratives(storyId?: string) {
    for (const [key, turn] of this.bufferedNarrativeTurns) {
      if (storyId && turn.storyId !== storyId) continue
      if (turn.timer) turn.timer()
      if (turn.inFlightRequestId) turn.obsoleteRequestIds.add(turn.inFlightRequestId)
      this.bufferedNarrativeTurns.delete(key)
    }
    // Group turns have their own debounce timers. They must be cancelled by
    // the same reset/purge path, otherwise an old buffered group message can
    // write a fresh entry after the administrator has cleared the story.
    for (const [key, turn] of this.bufferedGroupTurns) {
      if (storyId && turn.storyId !== storyId) continue
      if (turn.timer) turn.timer()
      this.bufferedGroupTurns.delete(key)
    }
    for (const key of this.groupWillingness.keys()) {
      if (!storyId || key.startsWith(`${storyId}:`)) this.groupWillingness.delete(key)
    }
    for (const [key, wake] of this.dueIntentWakeTimers) {
      if (storyId && key !== storyId) continue
      wake.cancel()
      this.dueIntentWakeTimers.delete(key)
    }
  }

  /** True while a live or debounced conversation should take priority over background work. */
  private hasPendingNarrative(storyId: string) {
    if (this.narratingStories.has(storyId)) return true
    for (const turn of this.bufferedNarrativeTurns.values()) {
      if (turn.storyId === storyId && (turn.messages.length || turn.timer || turn.inFlightRequestId)) return true
    }
    for (const turn of this.bufferedGroupTurns.values()) {
      if (turn.storyId === storyId && (turn.messages.length || turn.timer)) return true
    }
    return false
  }

  private async flushBufferedNarrative(key: string, revision: number) {
    if (this.databaseResetting) return
    const turn = this.bufferedNarrativeTurns.get(key)
    if (!turn || turn.nextRevision !== revision) return
    // One shared story has one narrator at a time. If another relationship is
    // currently waiting on the provider, keep this batch intact and retry
    // shortly instead of taking an inconsistent cursor snapshot.
    if (this.narratingStories.has(turn.storyId)) {
      turn.timer = this.ctx.setTimeout(() => void this.flushBufferedNarrative(key, revision), 250)
      return
    }
    this.narratingStories.add(turn.storyId)
    turn.timer = undefined
    const batch = turn.messages.splice(0)
    if (!batch.length) {
      this.narratingStories.delete(turn.storyId)
      return
    }
    const requestId = revision
    turn.inFlightRequestId = requestId
    try {
      // Snapshot only the lightweight decision inputs under the story lock.
      // The network request stays outside it, so a new user message can be
      // recorded immediately and invalidate this request when appropriate.
      const snapshot = await this.serial(turn.storyId, async () => {
        const story = await this.getStory(turn.storyId)
        const participant = await this.getParticipant(turn.participantId)
        if (!participant || participant.status !== 'active' || story.status !== 'active') return undefined
        const now = new Date()
        const due = (await this.dueIntents(story.id, now))
          .filter(intent => !intent.participantId || intent.participantId === participant.id)
        return { story, participant, from: narrativeCursor(story, now), now, due }
      })
      if (!snapshot) return

      const userMessage = formatBufferedUserMessages(batch)
      const quotedMessages: IndexedQuotedMessageContext[] = batch.flatMap((message, index) => message.quote
        ? [{ ...message.quote, messageIndex: index + 1 }]
        : [])
      const stickerCatalog = this.stickerCatalogForSession(turn.latestSession)
      const chatCapabilities = this.privateChatCapabilities(turn.latestSession)
      const imageSources = Array.from(new Set(batch.flatMap(message => message.imageSources))).slice(0, 3)
      const images = await this.loadNativeImages(snapshot.story, imageSources, turn.latestSession)
      // If another message arrived while an image was being downloaded, put
      // this batch back and let the newer revision compose one combined event.
      if (turn.nextRevision !== revision) {
        turn.messages.unshift(...batch)
        return
      }
      const superseded = batch.flatMap(message => message.supersededIntents)
      const { decision, succeeded, effectiveNow, immediateObservations } = await this.tryDecide(
        snapshot.story, snapshot.participant, 'user-message', snapshot.from, snapshot.now, userMessage, snapshot.due, superseded, undefined, images, chatCapabilities, quotedMessages, stickerCatalog,
      )

      const result = await this.serial(turn.storyId, async () => {
        if (this.databaseResetting) return { obsolete: true, requeue: false, messages: [] as OutgoingMessageDraft[] }
        if (turn.obsoleteRequestIds.has(requestId)) return { obsolete: true, requeue: true, messages: [] as OutgoingMessageDraft[] }
        const current = await this.getStory(turn.storyId)
        const currentParticipant = await this.getParticipant(turn.participantId)
        if (!currentParticipant || currentParticipant.status !== 'active' || current.status !== 'active') {
          return { obsolete: true, requeue: false, messages: [] as OutgoingMessageDraft[] }
        }
        const now = new Date()
        // Persist a successful/failed immediate observation only after this
        // request has survived debounce invalidation. This keeps an obsolete
        // result from contaminating the next combined user turn.
        for (const observation of immediateObservations) await this.persistCollectedWebObservation(observation)
        const commitsFirstReply = succeeded
          && decision.interaction?.reply?.mode === 'immediate'
          && typeof decision.interaction.reply.content === 'string'
          && !!decision.interaction.reply.content.trim()
        if (commitsFirstReply) turn.firstMessageCommittedRequestId = requestId
        const messages = await this.persistDecision(current, currentParticipant, decision, snapshot.from, effectiveNow, true, 'user-message')
        if (succeeded) {
          await this.dbSet('interlude_story', { id: current.id }, { cursorAt: effectiveNow, updatedAt: now })
          if (snapshot.due.length) await this.dbSet('interlude_intent', { id: { $in: snapshot.due.map(intent => intent.id) } }, { status: 'completed', updatedAt: now })
        } else {
          await this.scheduleNarrativeRetry(current.id, currentParticipant.id, now)
        }
        if (succeeded) await this.scheduleConversationFollowUpsAfterTurn(current.id, effectiveNow, decision.interaction, currentParticipant.id)
        this.reportOperation('diagnostic', 'debug', current, 'user-message', '写作回合统计 参与者=%s 合并消息=%d 成功=%s 可见消息=%d', currentParticipant.id, batch.length, succeeded, messages.length)
        return { obsolete: false, requeue: false, messages }
      })

      if (result.obsolete) {
        if (result.requeue) turn.messages.unshift(...batch)
        this.reportOperation('standard', 'info', snapshot.story, 'user-message', '已丢弃过期主模型结果 参与者=%s 请求=%d', snapshot.participant.id, requestId)
        return
      }
      if (this.canHandleParticipant(snapshot.participant)) {
        await this.sendOutgoingMessages(snapshot.story, result.messages, snapshot.participant, turn.latestSession)
        const sticker = this.resolveSticker(decision.localMedia, stickerCatalog)
        if (sticker && turn.latestSession) await this.sendSticker(snapshot.story, turn.latestSession, snapshot.participant.channelId, sticker)
        const nativeFace = sticker ? undefined : this.resolveNativeFace(decision, chatCapabilities)
        if (nativeFace && turn.latestSession) await this.sendNativeFace(snapshot.story, turn.latestSession, snapshot.participant.channelId, nativeFace)
      }
      this.scheduleCompaction(turn.storyId)
    } catch (error) {
      this.reportStandalone('warn', '合并写作任务失败：参与者=%s 错误=%s', turn.participantId, error)
    } finally {
      if (turn.inFlightRequestId === requestId) {
        turn.inFlightRequestId = undefined
        turn.firstMessageCommittedRequestId = undefined
        this.narratingStories.delete(turn.storyId)
      }
      turn.obsoleteRequestIds.delete(requestId)
      if (!turn.messages.length && !turn.timer && !turn.inFlightRequestId) this.bufferedNarrativeTurns.delete(key)
    }
  }

  async advanceStory(story: InterludeStory, force = true) {
    if (!this.canHandleStory(story)) return []
    const messages = await this.serial(story.id, async () => this.advanceUnlocked(await this.getStory(story.id), new Date(), force))
    if (force || messages.length) this.reportOperation('summary', 'info', story, 'advance', '剧本推进完成 可见消息=%d', messages.length)
    this.scheduleCompaction(story.id)
    return messages
  }

  /** Used by commands/tests to deliver a mixed set of account-targeted actions safely. */
  async deliverMessages(story: InterludeStory, messages: OutgoingMessageDraft[], session?: Session) {
    const participant = session ? await this.findParticipant(session, story) : undefined
    await this.sendOutgoingMessages(story, messages, participant, session)
  }

  async compactStory(story: InterludeStory, force = true) {
    if (!this.canHandleStory(story)) return false
    return this.serial(story.id, async () => this.compactUnlocked(await this.getStory(story.id), new Date(), force))
  }

  /** Merge and compress already-applied overlay patches without running the
   * full scene/fact compaction pass. This is safe for manual maintenance. */
  async compactOverlay(story: InterludeStory) {
    if (!this.canHandleStory(story)) return false
    return this.serial(story.id, async () => this.compactOverlayUnlocked(await this.getStory(story.id), new Date()))
  }

  /** Administrative overlay view used by the Console command. */
  async adminOverlayStatus(storyId: string) {
    const [story, patches, snapshots, participants] = await Promise.all([
      this.getStory(storyId),
      this.dbGet('interlude_state_patch', { storyId }, { sort: { createdAt: 'desc' } }) as Promise<StatePatchProposal[]>,
      this.dbGet('interlude_overlay_snapshot', { storyId, status: 'active' }, { sort: { periodEnd: 'desc' } }) as Promise<OverlaySnapshot[]>,
      this.participants(storyId, true),
    ])
    return {
      state: story.state.settingOverlay ?? {},
      proposed: patches.filter(patch => patch.status === 'proposed'),
      applied: patches.filter(patch => patch.status === 'applied' || patch.status === 'compacted'),
      cleared: patches.filter(patch => patch.status === 'cleared'),
      snapshots,
      participantOverlays: participants.filter(participant => !!normalizeParticipantState(participant.state).relationshipOverlay),
    }
  }

  async sweep() {
    if (this.databaseResetting || this.sweepRunning) return
    this.sweepRunning = true
    const startedAt = Date.now()
    try {
      const story = await this.getCanonicalStory()
      if (!story || !this.canHandleStory(story)) {
        this.reportStandaloneOperation('diagnostic', 'debug', '后台扫描跳过：没有可处理的活动主剧本')
        return
      }
      if (this.hasPendingNarrative(story.id)) {
        // A split-message is an already-decided typing fragment. It may start
        // transport while another relationship is waiting, but an incoming
        // message from its own participant still interrupts it first.
        const pendingDue = await this.dueIntents(story.id, new Date())
        const deliveryOnly = pendingDue.length > 0 && pendingDue.every(intent => intent.type === 'split-message')
        if (!deliveryOnly) {
          this.reportOperation('diagnostic', 'debug', story, 'advance', '后台扫描跳过：前台消息回合或合并计时器仍在处理中')
          return
        }
        this.reportOperation('diagnostic', 'debug', story, 'advance', '前台回合处理中，先投递已确定的分段消息 数量=%d', pendingDue.length)
      }
      this.reportOperation('diagnostic', 'debug', story, 'advance', '后台扫描开始 游标=%s 下次自动推进=%s',
        formatLogTime(story.cursorAt, story.setting.timezone), formatLogTime(toDate(story.state.automation?.nextAdvanceAt), story.setting.timezone))
      const messages = await this.advanceStory(story, false)
      if (messages.length) await this.sendScheduledMessages(story, messages)
      this.reportOperation('diagnostic', 'debug', story, 'advance', '后台扫描完成 耗时=%dms 已投递=%d', Date.now() - startedAt, messages.length)
    } finally {
      this.sweepRunning = false
    }
  }

  private async advanceUnlocked(story: InterludeStory, now: Date, force: boolean) {
    const from = narrativeCursor(story, now)
    const elapsed = Math.max(0, now.getTime() - from.getTime())
    let due = await this.dueIntents(story.id, now)
    const messages: OutgoingMessageDraft[] = []
    // Later <sep/> bubbles are delivery events, not new writing turns.  They
    // are persisted only at their actual send time, which also lets a newer
    // incoming message cancel them before the character "finishes typing".
    // Deliver at most one split segment per wake-up. If the scheduler was
    // blocked for a while, sending every overdue segment together would skip
    // the configured typing-time simulation.
    const splitSegments = due
      .filter(intent => intent.type === 'split-message')
      .sort((left, right) => left.notBefore.getTime() - right.notBefore.getTime())
      .slice(0, 1)
    let splitHandled = false
    for (const intent of splitSegments) {
      const content = clip(intent.payload?.content, this.config.runtime.maxMessageCharacters)
      const automaticDelivery = automaticDeliveryFromPayload(intent.payload)
      const participant = intent.participantId ? await this.getParticipant(intent.participantId) : undefined
      if (intent.participantId && this.interruptedTypingParticipants.has(intent.participantId)) continue
      splitHandled = true
      if (!content || !participant || participant.status !== 'active') {
        await this.dbSet('interlude_intent', { id: intent.id }, { status: 'cancelled', updatedAt: now })
        continue
      }
      const delivered = await this.sendOutgoingMessages(
        story,
        [{ participantId: participant.id, content, automaticDelivery }],
        undefined,
        undefined,
        target => this.interruptedTypingParticipants.has(target.id),
      )
      if (!delivered.length) {
        if (this.interruptedTypingParticipants.has(participant.id)) continue
        const retryAt = new Date(now.getTime() + 30 * Time.second)
        await this.dbSet('interlude_intent', { id: intent.id }, { notBefore: retryAt, updatedAt: now })
        this.scheduleDueIntentWake(story.id, retryAt)
        continue
      }
      await this.appendEntry(story.id, {
        kind: 'character-message', actor: 'character', content,
        occurredAt: now.toISOString(), metadata: { visible: true, splitSegment: true },
      }, now, participant.id)
      await this.recordCharacterMessage(participant, now)
      await this.dbSet('interlude_intent', { id: intent.id }, { status: 'completed', updatedAt: now })
    }
    if (splitHandled) await this.scheduleNextSplitWake(story.id)
    due = due.filter(intent => intent.type !== 'split-message')
    // Browser research is an external, already-happened observation once it
    // completes. It must never be handed to the narrator as an ordinary
    // future plan, otherwise the model could write as if it had read a page
    // before Puppeteer actually did so.
    // Keep a backlog of optional research from turning one background sweep
    // into several serial page loads. The remaining intents stay pending for
    // the next sweep and never block a live user turn for an unbounded time.
    const browserIntents = due
      .filter(intent => intent.type === 'browser-research')
      .slice(0, Math.max(1, this.browserConfig.maxResearchPerSweep))
    for (const intent of browserIntents) await this.executeDeferredBrowserIntent(story, intent, now)
    // Browser intents always complete (successfully or as a recorded failure)
    // in executeDeferredBrowserIntent(), so re-reading the whole pending list
    // here only adds a SQLite round trip to every background sweep.
    due = due.filter(intent => intent.type !== 'browser-research')
    // Turning off automatic advancement must suppress *every* background
    // writing path, including short plans that were persisted before the
    // owner disabled the feature. Manual `interlude.advance` still passes
    // `force` and remains available.
    const autoAdvanceEnabled = this.autoAdvanceConfig.enabled
    const dueFollowUps = autoAdvanceEnabled ? this.dueConversationFollowUps(story, now) : []
    const automaticDue = autoAdvanceEnabled && (dueFollowUps.length > 0 || this.isAutomaticAdvanceDue(story, now))
    const pausedForConversation = this.isAutomaticAdvancePaused(story, now)
    this.reportOperation('diagnostic', 'debug', story, 'advance',
      '后台状态 到期计划=%d 分段消息=%d 网页任务=%d 短期跟进=%d 自动推进到期=%s 对话暂停=%s',
      due.length, splitSegments.length, browserIntents.length, dueFollowUps.length, automaticDue, pausedForConversation)
    // A due typing segment can be delivered during the conversation pause;
    // it is already a committed message, not an automatic life update.
    if (!force && !due.length && (!automaticDue || pausedForConversation)) return messages

    // A manual advance may be queued behind a background pass. Do not open a
    // second narrator turn merely for a few seconds of empty time.
    const minimumManualAdvanceMs = Math.max(1, this.config.runtime.minimumAdvanceMinutes) * Time.minute
    const manualAdvanceTooSoon = force
      && !due.length
      && !dueFollowUps.length
      && elapsed < minimumManualAdvanceMs
    if (manualAdvanceTooSoon) {
      this.reportOperation('standard', 'info', story, 'advance',
        '手动推进跳过：游标距离现在不足 %d 分钟，且没有到期计划或对话后续任务', this.config.runtime.minimumAdvanceMinutes)
      return messages
    }

    let advanced = false
    let delayedReplyProcessed = false
    // A due plan is itself a complete writing turn: it fills the old cursor→now
    // gap and then decides the plan. Avoid a preceding ordinary advance, which
    // would make the next request write the same now→now moment again.
    const hasNarrativeDue = due.length > 0
    if (elapsed > 0 && !hasNarrativeDue && (force || (automaticDue && !pausedForConversation))) {
      const followUpParticipantId = dueFollowUps.length ? story.state.automation?.conversationFollowUpParticipantId : ''
      const followUpParticipant = followUpParticipantId ? await this.getParticipant(followUpParticipantId) : undefined
      const phase: NarrativeRequest['phase'] = followUpParticipant?.status === 'active'
        ? 'conversation-follow-up'
        : 'advance'
      this.reportOperation('standard', 'info', story, phase,
        '即将执行自动写作 类型=%s 时间段=%s→%s', phaseLabel(phase), formatLogTime(from, story.setting.timezone), formatLogTime(now, story.setting.timezone))
      const { decision, succeeded } = await this.tryDecide(story, followUpParticipant ?? null, phase, from, now, undefined, [])
      if (succeeded) {
        const permitMessages = phase === 'conversation-follow-up' || this.config.runtime.allowProactiveMessages
        messages.push(...await this.persistDecision(story, followUpParticipant ?? null, decision, from, now, permitMessages, phase))
        await this.dbSet('interlude_story', { id: story.id }, { cursorAt: now, updatedAt: now })
        advanced = true
      }
    }

    const dueBatches = groupDueIntents(due)
    // One shared story has one clock. Process one relationship branch per
    // sweep so another branch cannot trigger a duplicate now→now scene.
    const dueBatch = dueBatches[0]
    if (dueBatch) {
      const current = await this.getStory(story.id)
      // 如果本轮没有先做 automatic advance，到期意图也必须从故事游标
      // 补写到现在；否则“延迟回复到点”会漏掉中间这段角色生活。
      const dueFrom = narrativeCursor(current, now)
      // Each batch is one relationship branch. This keeps prompts private
      // while still draining every plan that was already due this sweep.
      const dueParticipantId = dueBatch[0]?.participantId || ''
      const dueParticipant = dueParticipantId ? await this.getParticipant(dueParticipantId) : undefined
      this.reportOperation('standard', 'info', current, 'intent-due',
        '即将处理到期计划 数量=%d 类型=%s 参与者=%s', dueBatch.length, Array.from(new Set(dueBatch.map(intent => intent.type))).join(','), dueParticipant?.id || '全局')
      const { decision, succeeded } = await this.tryDecide(current, dueParticipant ?? null, 'intent-due', dueFrom, now, undefined, dueBatch)
      const permitMessages = this.config.runtime.allowProactiveMessages || dueBatch.some(intent => intent.payload?.userInitiated === true)
      messages.push(...await this.persistDecision(current, dueParticipant ?? null, decision, dueFrom, now, permitMessages, 'intent-due', dueBatch))
      if (succeeded) {
        await this.dbSet('interlude_story', { id: current.id }, { cursorAt: now, updatedAt: now })
        const ordinaryDueIds = dueBatch.filter(intent => intent.type !== 'follow-up-commitment').map(intent => intent.id)
        if (ordinaryDueIds.length) await this.dbSet('interlude_intent', { id: { $in: ordinaryDueIds } }, { status: 'completed', updatedAt: now })
        if (dueBatch.some(intent => intent.type === 'delayed-reply')) {
          delayedReplyProcessed = true
          await this.pauseAutomaticAdvanceAfterDelayedReply(story.id, now, dueParticipant?.id ?? '')
        } else if (!advanced && !delayedReplyProcessed) {
          await this.scheduleNextAutomaticAdvance(story.id, now)
        }
      } else {
        // A failed user turn gets a persisted retry. Otherwise a transient
        // 403/5xx would leave its already-recorded incoming message waiting
        // forever for somebody to send another DM.
        const retries = dueBatch.filter(intent => intent.type === 'narrative-retry')
        if (retries.length) {
          const attempts = Math.max(...retries.map(intent => Number(intent.payload?.attempt) || 0))
          await this.dbSet('interlude_intent', { id: { $in: retries.map(intent => intent.id) } }, { status: 'cancelled', updatedAt: now })
          await this.scheduleNarrativeRetry(current.id, dueParticipant?.id ?? '', now, attempts)
        }
        // Keep ordinary delayed plans pending until the provider recovers.
      }
    }
    if (dueBatches.length > 1) {
      const current = await this.getStory(story.id)
      this.reportOperation('standard', 'info', current, 'intent-due',
        '其余 %d 组到期计划已保留，下一次扫描将按新的时间段继续处理', dueBatches.length - 1)
      this.scheduleDueIntentWake(story.id, new Date(now.getTime() + Math.max(Time.second, this.config.runtime.sweepIntervalMinutes * Time.minute)))
    }
    if (advanced && !delayedReplyProcessed) {
      const hasMoreFollowUps = dueFollowUps.length > 0 && await this.completeConversationFollowUps(story.id, now)
      if (!hasMoreFollowUps) await this.scheduleNextAutomaticAdvance(story.id, now)
    }
    return messages
  }

  private async decide(story: InterludeStory, participant: InterludeParticipant | null, phase: NarrativeRequest['phase'], from: Date, now: Date, userMessage: string | undefined, dueIntents: NarrativeIntent[], supersededIntents: NarrativeIntent[] = [], groupContext?: GroupContext, images: NarrativeImage[] = [], extraWebContext: WebObservation[] = [], outputRecovery = false, chatCapabilities?: ChatActionCapabilities, quotedMessages: IndexedQuotedMessageContext[] = [], stickerCatalog: StickerCatalogEntry[] = []) {
    // 这里是主模型上下文的唯一入口。recentEntries 保留近距离质感，场景、弧线和
    // facts 负责把很长的过去压缩成连续性线索。参与者摘要让模型知道角色
    // 同时还在与谁维系关系，而不是把每个 QQ 当成独立世界。
    // User and due-intent turns may arrive before the next background sweep.
    // Retire expired consequences here too, while keeping this a cheap local
    // database operation rather than a separate model request.
    await this.expireActiveConsequences(story.id, now)
    const factQuery = createFactQuery(participant, userMessage, dueIntents, supersededIntents)
    const [recentEntries, memories, scene, arc, facts, allParticipants, webContext, activeConsequences, overlaySnapshots, followUpCommitments] = await Promise.all([
      // Use the runtime limits on the live path.  They are the options shown
      // to testers as “上下文条目/长期事实”，and should be authoritative.
      this.recentEntries(story.id, this.config.runtime.contextEntryLimit),
      this.memories(story.id, this.config.runtime.memoryLimit, participant?.id),
      this.activeScene(story.id),
      this.activeArc(story.id),
      this.facts(story.id, this.config.runtime.memoryLimit, factQuery, participant?.id),
      this.participants(story.id),
      this.webObservations(story.id, participant?.id),
      this.activeConsequences(
        story.id,
        now,
        phase === 'advance' || this.sharedStoryConfig.shareParticipantDetails ? undefined : participant?.id,
      ),
      this.overlaySnapshotsForPrompt(story.id, participant?.id, phase === 'advance'),
      participant && (phase === 'user-message' || phase === 'intent-due')
        ? this.pendingFollowUpCommitments(story.id, participant.id)
        : Promise.resolve([] as NarrativeIntent[]),
    ])
    const visibleEntries = this.sharedStoryConfig.shareParticipantDetails
      ? recentEntries
      : recentEntries.filter(entry => {
        // Group transcripts are part of the shared life, but do not expose
        // their raw text to a private relationship unless the owner opts in.
        if (!groupContext && (entry.kind === 'group-message' || entry.kind === 'character-group-message')) return false
        return !entry.participantId || entry.participantId === participant?.id
      })
    // Background advancement is not a chat turn. It receives the ongoing
    // life script, scene and facts, but not raw private/group transcript rows
    // that a model could mistake for a message arriving right now.
    const turnEntries = phase === 'advance'
      ? visibleEntries.filter(entry => !['user-message', 'character-message', 'group-message', 'character-group-message'].includes(entry.kind))
      : visibleEntries
    // The turn's explicit event decides what is happening now. Historical
    // rows are context only and are never reinterpreted as a fresh message.
    const promptEntries = turnEntries.filter(entry => !!entry.content.trim())
    const participants = allParticipants
      .filter(item => item.id !== participant?.id && this.canHandleParticipant(item))
      .sort((left, right) => participantRelevance(right) - participantRelevance(left))
      .slice(0, this.sharedStoryConfig.participantContextLimit)
    const agencyEnabled = this.agencyConfig.enabled
      && this.config.runtime.allowProactiveMessages
      && (phase === 'advance' || phase === 'intent-due' && dueIntents.some(intent => intent.type === 'proactive-check'))
    const advanceCanContact = phase === 'advance' && this.config.runtime.allowProactiveMessages
    const visibleDueIntents = this.sharedStoryConfig.shareParticipantDetails
      ? dueIntents
      : dueIntents.filter(intent => !intent.participantId || intent.participantId === participant?.id)
    // A relationship consequence belongs to the protagonist's actual life.
    // Background writing therefore sees its compact effect even when raw
    // cross-participant chat history remains private. Live turns still see
    // only their own (and global) consequences unless sharing is enabled.
    const visibleConsequences = phase === 'advance' || this.sharedStoryConfig.shareParticipantDetails
      ? activeConsequences
      : activeConsequences.filter(intent => !intent.participantId || intent.participantId === participant?.id)
    const mergedWebContext = [...webContext, ...extraWebContext]
      .filter(observation => observation.status !== 'deleted')
      .sort((left, right) => left.accessedAt.getTime() - right.accessedAt.getTime())
      .slice(-Math.max(1, this.browserConfig.maxObservationsInPrompt))
    const refreshContinuity = this.shouldRefreshContinuity(story, phase)
    return this.narrator.decide({
      phase, refreshContinuity, outputRecovery, story, from, now, userMessage, images,
      participant: phase === 'advance' ? null : participant,
      // A background turn may see relationship state through these opaque
      // participant summaries and may proactively contact one account only
      // when the owner explicitly enables proactive messages.
      participants: phase === 'advance' && !advanceCanContact ? [] : participants,
      dueIntents: visibleDueIntents, activeConsequences: visibleConsequences, supersededIntents,
      shareParticipantDetails: this.sharedStoryConfig.shareParticipantDetails,
      recentEntries: promptEntries, memories, sceneContext: { scene, arc }, facts, groupContext, chatCapabilities,
      ...(quotedMessages.length ? { quotedMessages } : {}),
      ...(stickerCatalog.length && phase === 'user-message' ? { stickerCatalog } : {}),
      webContext: mergedWebContext, overlaySnapshots,
      alterEnabled: this.alterSystemConfig.enabled,
      emotionalOffset: this.emotionalOffsetForPrompt(story),
      agencyEnabled,
      agencyWindow: agencyEnabled ? activeAgencyWindow(story.state.agencyWindow, now) ?? null : null,
      automaticDeliverySummaries: isAutomaticNarrativePhase(phase)
        ? normalizeStoryState(story.state).automaticDeliverySummaries
        : [],
      followUpCommitments,
    })
  }

  /** Refresh continuity only on the first automatic pass or every fifteenth
   * successful narrative write. Ordinary turns reuse the last snapshot. */
  private shouldRefreshContinuity(story: InterludeStory, phase: NarrativeRequest['phase']) {
    const state = normalizeStoryState(story.state)
    if (phase === 'advance' && !state.continuitySnapshot) return true
    const count = Math.max(0, Math.floor(state.narrativeUpdateCount || 0))
    return (count + 1) % 15 === 0
  }

  private async tryDecide(story: InterludeStory, participant: InterludeParticipant | null, phase: NarrativeRequest['phase'], from: Date, now: Date, userMessage: string | undefined, dueIntents: NarrativeIntent[], supersededIntents: NarrativeIntent[] = [], groupContext?: GroupContext, images: NarrativeImage[] = [], chatCapabilities?: ChatActionCapabilities, quotedMessages: IndexedQuotedMessageContext[] = [], stickerCatalog: StickerCatalogEntry[] = []) {
    let immediateObservations: WebObservation[] = []
    let effectiveNow = now
    const startedAt = Date.now()
    this.reportOperation('standard', 'info', story, phase,
      '模型调用开始 任务=主叙事 模型=%s 参与者=%s 时间段=%s→%s 到期计划=%d',
      this.mainModelLabel(), participant?.id || '全局', formatLogTime(from, story.setting.timezone), formatLogTime(now, story.setting.timezone), dueIntents.length)
    try {
      let decision = await this.decide(story, participant, phase, from, effectiveNow, userMessage, dueIntents, supersededIntents, groupContext, images, [], false, chatCapabilities, quotedMessages, stickerCatalog)
      const immediate = phase === 'user-message' && participant && !groupContext && this.browserConfig.enabled && this.browserConfig.mode === 'allow-immediate'
        ? decision.browserIntents?.map(intent => normalizeBrowserIntentDraft(intent, this.browserConfig)).find(intent => intent?.timing === 'immediate')
        : undefined
      if (immediate) {
        // The first pass merely proposes the action. Do not persist its prose
        // or chat decision: after the real page read, ask the narrator once
        // more with the observation so the final script stays a single,
        // coherent piece of writing rather than two stitched tool calls.
        this.reportOperation('standard', 'info', story, phase, '即时网页观察开始 模式=%s', immediate.mode)
        const observation = await this.collectWebObservation(story, immediate, participant.id, null, new Date(), false)
        immediateObservations = [observation]
        effectiveNow = new Date()
        decision = await this.decide(story, participant, phase, from, effectiveNow, userMessage, dueIntents, supersededIntents, groupContext, images, immediateObservations, false, chatCapabilities, quotedMessages, stickerCatalog)
      }
      if (usesRemoteProviders(this.config.model) && requiresVisibleReplyRecovery(phase, groupContext, decision)) {
        this.reportOperation('standard', 'warn', story, phase,
          '结构化可见回复缺失，已抛弃本次未落库剧本并重新写作')
        decision = await this.decide(story, participant, phase, from, effectiveNow, userMessage, dueIntents, supersededIntents, groupContext, images, immediateObservations, true, chatCapabilities, quotedMessages, stickerCatalog)
        if (requiresVisibleReplyRecovery(phase, groupContext, decision)) {
          throw new Error('Narrative provider omitted the required visible-reply structure after one recovery attempt.')
        }
      }
      // The fixed narrative contract requires prose for every real model turn.
      // A syntactically valid object with an omitted/blank script used to be
      // treated as success, advancing the cursor while leaving a gap in the
      // life record. Treat it like a provider failure so live user turns use
      // the existing persisted retry path and background turns retain time for
      // their next attempt. Fallback is intentionally a no-network smoke mode.
      if (usesRemoteProviders(this.config.model) && !hasRequiredNarrativeScript(decision)) {
        throw new Error('Narrative provider returned no usable script.')
      }
      const result = {
        decision,
        succeeded: true,
        effectiveNow,
        immediateObservations,
      }
      if (this.config.logging?.logScriptPreview && result.decision.script) {
        this.report('info', story, phase, '当前剧本内容：\n%s', result.decision.script.slice(0, this.config.logging.previewLength))
      }
      this.reportOperation('standard', 'info', story, phase,
        '模型调用完成 任务=主叙事 耗时=%dms 剧本文字=%d 回复模式=%s',
        Date.now() - startedAt, result.decision.script?.length ?? 0, visibleReplyMode(result.decision, phase, groupContext))
      return result
    } catch (error) {
      this.report('warn', story, phase, '模型调用失败 任务=主叙事 耗时=%dms 错误=%s', Date.now() - startedAt, error)
      return { decision: {}, succeeded: false, effectiveNow, immediateObservations }
    }
  }

  private async persistDecision(
    story: InterludeStory,
    participant: InterludeParticipant | null,
    raw: NarrativeDecision,
    from: Date,
    now: Date,
    permitMessages: boolean,
    phase: NarrativeRequest['phase'],
    contextIntents: NarrativeIntent[] = [],
  ) {
    // 先规范化，再写库：不信任模型给出的时间、长度和结构，尤其不能让未来剧情落库。
    const allParticipants = await this.participants(story.id)
    const permittedParticipantIds = new Set(allParticipants.filter(item => this.canHandleParticipant(item)).map(item => item.id))
    const refreshContinuity = this.shouldRefreshContinuity(story, phase)
    const decision = normalizeDecision(
      raw, from, now, permitMessages, this.config.runtime, this.sharedStoryConfig,
      participant?.id ?? '', permittedParticipantIds, phase, this.memoryConfig, refreshContinuity,
    )
    let scriptEntry: ScriptEntry | undefined
    if (decision.script) {
      scriptEntry = await this.appendEntry(story.id, {
        kind: 'script',
        actor: 'narrator',
        content: decision.script,
        occurredAt: now.toISOString(),
        metadata: { phase, interaction: decision.interaction ?? null },
      }, now, participant?.id ?? '')
    }
    await this.applyIntentUpdates(story.id, decision.intentUpdates, now, participant?.id)
    for (const memory of decision.memories) await this.appendMemory(story.id, memory, now, memory.participantId ?? participant?.id ?? '')
    for (const intent of decision.intents) {
      // A reminder or promise created while handling a user's message is a
      // response to that relationship, even if it becomes due much later.
      // Carry that provenance into the shared intent ledger so its due-turn
      // is allowed to send the eventual message without enabling broad
      // background outreach.
      const payload = isRecord(intent.payload) ? intent.payload : {}
      await this.appendIntent(story.id, {
        ...intent,
        payload: phase === 'user-message' && participant
          ? { ...payload, userInitiated: payload.userInitiated !== false }
          : payload,
      }, now, intent.participantId ?? participant?.id ?? '')
    }
    const resolvedFollowUps = participant && (phase === 'user-message' || phase === 'intent-due')
      ? await this.applyFollowUpResolutions(story.id, participant.id, decision.followUpResolutions, decision.interaction, now)
      : new Set<number>()
    if (phase === 'user-message' && participant) {
      const inferred = !decision.followUpCommitment && interactionPromisesFollowUp(decision.interaction?.reply.content)
        ? inferredFollowUpCommitment(decision.interaction!.reply.content!, now)
        : undefined
      const commitment = decision.followUpCommitment ?? inferred
      if (commitment) await this.appendFollowUpCommitment(story, participant.id, commitment, scriptEntry?.id, now)
    }
    for (const browserIntent of decision.browserIntents) {
      // An immediate intent is handled before the final narrator pass when
      // enabled. If it reaches this point (disabled mode, group turn, or a
      // second consecutive request), safely downgrade it to deferred work.
      if (participant || phase !== 'user-message' || this.browserConfig.allowGroupTriggeredResearch) {
        await this.appendBrowserIntent(story.id, browserIntent, now, participant?.id ?? '')
      }
    }
    if (participant && decision.statePatch) await this.updateParticipantState(participant, decision.statePatch, now)

    const isAgencyCheck = contextIntents.length > 0 && contextIntents.every(intent => intent.type === 'proactive-check')
    let agencyCandidate: ProactiveContactDraft | undefined
    let agencyAllowsSend = false
    let agencyRecheck: { candidate: ProactiveContactDraft; window: AgencyWindowState; reason: string; at: Date } | undefined

    if (decision.script) {
      const state = normalizeStoryState(story.state)
      const nextCount = Math.max(0, Math.floor(state.narrativeUpdateCount || 0)) + 1
      const nextState: StoryState = { ...state, narrativeUpdateCount: nextCount }
      if (decision.continuity) {
        nextState.continuitySnapshot = decision.continuity
        nextState.lastContinuityUpdateAt = now.toISOString()
      }
      const alterTurn = this.updateAlterSystem(story, state.alterSystem, decision.alter, phase, now)
      nextState.alterSystem = alterTurn?.state ?? state.alterSystem
      if (this.agencyConfig.enabled && (phase === 'advance' || isAgencyCheck)) {
        const sourceEntries = decision.agencyWindow || decision.proactiveContact
          ? await this.recentEntries(story.id, Math.max(40, this.config.runtime.contextEntryLimit * 2))
          : []
        const validSourceEntryIds = new Set(sourceEntries.map(entry => entry.id))
        if (scriptEntry?.id) validSourceEntryIds.add(scriptEntry.id)
        const agencyWindow = normalizeAgencyWindowDraft(
          decision.agencyWindow,
          now,
          this.agencyConfig,
          validSourceEntryIds,
          scriptEntry?.id,
        ) ?? activeAgencyWindow(state.agencyWindow, now)
        nextState.agencyWindow = agencyWindow
        agencyCandidate = normalizeProactiveContact(
          decision.proactiveContact,
          now,
          this.agencyConfig,
          permittedParticipantIds,
          validSourceEntryIds,
          scriptEntry?.id,
        )
        if (isAgencyCheck && agencyCandidate?.participantId !== participant?.id) agencyCandidate = undefined
        if (agencyCandidate && agencyWindow) {
          const target = allParticipants.find(item => item.id === agencyCandidate!.participantId)
          const capacity = evaluateAgencyCapacity(
            agencyWindow,
            agencyCandidate,
            now,
            this.agencyConfig,
            target?.state.lastCharacterMessageAt,
          )
          const willingness = agencyCandidate.willingness ?? 0
          const willingnessPasses = willingness >= (this.config.runtime.proactiveWillingnessThreshold ?? 0.65)
          agencyAllowsSend = agencyCandidate.outcome === 'send-now' && capacity.allowed && willingnessPasses
          if (!agencyAllowsSend && agencyCandidate.outcome !== 'let-go' && willingnessPasses) {
            agencyRecheck = {
              candidate: agencyCandidate,
              window: agencyWindow,
              reason: capacity.allowed ? 'model-requested-recheck' : capacity.reason,
              at: proactiveRecheckAt(agencyCandidate, capacity, agencyWindow, now),
            }
          }
          this.reportOperation('standard', 'info', story, phase,
            'Agency 主动联系判断 参与者=%s 结果=%s 原因=%s 意愿=%s',
            agencyCandidate.participantId,
            agencyAllowsSend ? '立即联系' : agencyRecheck ? '稍后重查' : '自然放下',
            capacity.reason,
            willingness.toFixed(2))
        }
        if (agencyWindow) {
          this.reportOperation('diagnostic', 'debug', story, phase,
            'Agency Window 更新 负荷=%s 隐私=%s 设备=%s 有效至=%s',
            agencyWindow.activityLoad, agencyWindow.privacy, agencyWindow.deviceAccess,
            formatLogTime(toDate(agencyWindow.validUntil), story.setting.timezone))
        }
      }
      await this.dbSet('interlude_story', { id: story.id }, { state: nextState, updatedAt: now })
      if (alterTurn?.thresholdReached) this.scheduleAlterAnalysis(story.id, phase, participant?.id)
    }

    if (agencyRecheck) {
      await this.appendProactiveCheck(story, agencyRecheck.candidate, agencyRecheck.at, agencyRecheck.reason, now)
    }

    const messages: OutgoingMessageDraft[] = []
    const interaction = isAgencyCheck
      ? agencyAllowsSend && decision.interaction?.reply.mode === 'immediate' ? decision.interaction : undefined
      : decision.interaction
    if (phase === 'intent-due' && participant) {
      await this.deferUnresolvedDueFollowUps(story.id, participant.id, contextIntents, resolvedFollowUps, interaction, now)
    }
    const automaticDelivery = isAutomaticNarrativePhase(phase) && scriptEntry
      ? {
          summary: decision.automaticDeliverySummary || `Background delivery based on script #${scriptEntry.id}.`,
          sourceEntryId: scriptEntry.id,
        }
      : undefined
    if (participant && !isAgencyCheck && interaction?.seen) await this.markParticipantSeen(participant, now)
    if (participant && permitMessages && interaction?.reply.mode === 'immediate' && interaction.reply.content) {
      messages.push({ participantId: participant.id, content: interaction.reply.content, automaticDelivery })
    }
    if (participant && permitMessages && interaction?.reply.mode === 'delayed' && interaction.reply.content && interaction.reply.sendAt) {
      const sendAt = new Date(interaction.reply.sendAt)
      await this.appendIntent(story.id, {
        type: 'delayed-reply',
        summary: 'The character decided to send a delayed reply.',
        notBefore: interaction.reply.sendAt,
        payload: {
          content: interaction.reply.content,
          userInitiated: phase === 'user-message',
          interaction: true,
        },
      }, now, participant.id)
      this.scheduleDueIntentWake(story.id, sendAt)
    }

    // A cross-account message is itself proactive from the target's point of
    // view. Allow it during a live user event, or during background work only
    // when the global proactive-message switch is enabled.
    const crossActions = phase === 'user-message'
      ? decision.crossConversationActions
      : phase === 'advance' && !this.agencyConfig.enabled && this.config.runtime.allowProactiveMessages
        ? decision.crossConversationActions
      : phase === 'advance' && agencyAllowsSend && agencyCandidate
        ? decision.crossConversationActions.filter(action => action.participantId === agencyCandidate!.participantId && action.mode === 'immediate').slice(0, 1)
        : []
    if (phase === 'advance' && decision.crossConversationActions.length && !crossActions.length) {
      this.reportOperation('diagnostic', 'debug', story, phase,
        'Agency 拒绝未通过容量或来源验证的 crossConversationAction 数量=%d', decision.crossConversationActions.length)
    }
    const acceptedAutomaticOutgoingActions = phase === 'advance'
      ? crossActions
        .filter(action => action.mode === 'immediate')
        .map(action => ({ participantId: action.participantId, mode: action.mode }))
      : []
    // Keep a compact host-side receipt beside the life passage. It records
    // only actions that passed the actual delivery gate, without parsing or
    // rewriting the model's prose and without adding another model call.
    if (scriptEntry && acceptedAutomaticOutgoingActions.length) {
      await this.dbSet('interlude_script_entry', { id: scriptEntry.id }, {
        metadata: {
          ...scriptEntry.metadata,
          acceptedAutomaticOutgoingActions,
        },
      })
    }
    for (const action of crossActions) {
      if (action.mode === 'immediate') {
        messages.push({ participantId: action.participantId, content: action.content, automaticDelivery })
      } else {
        const sendAtValue = (action as { sendAt?: string }).sendAt
        if (action.mode !== 'delayed' || !sendAtValue) continue
        const sendAt = new Date(sendAtValue)
        await this.appendIntent(story.id, {
          type: 'cross-conversation-message', summary: 'The character planned a message to another relationship branch.',
          notBefore: sendAtValue, payload: { content: action.content, userInitiated: false, crossConversation: true, willingness: action.willingness, reason: action.reason },
        }, now, action.participantId)
        this.scheduleDueIntentWake(story.id, sendAt)
      }
    }

    for (const message of messages) {
      // <sep/> bubbles are not all visible at the same instant. Persist the
      // first one now; later bubbles become ordinary due intents so a new
      // incoming message can cancel them before they are actually sent.
      const [first, ...later] = this.splitOutgoingMessage(message.content)
      if (!first) continue
      message.content = first
      await this.appendEntry(story.id, {
        kind: 'character-message', actor: 'character', content: first,
        occurredAt: now.toISOString(), metadata: { visible: true, interaction: interaction ?? null },
      }, now, message.participantId)
      const target = allParticipants.find(item => item.id === message.participantId)
      if (target) await this.recordCharacterMessage(target, now)
      // The narrator may have spent tens of seconds generating before this
      // decision reaches the transport layer.  Typing begins when the first
      // bubble is actually committed, never from the earlier prompt time.
      const typingStartedAt = new Date()
      let delay = 0
      for (const content of later) {
        delay += this.typingDelayMilliseconds(content)
        const sendAt = new Date(typingStartedAt.getTime() + delay)
        await this.appendIntent(story.id, {
          type: 'split-message',
          summary: 'The character is still typing the next message segment.',
          notBefore: sendAt.toISOString(),
          payload: {
            content, visibleMessage: true, userInitiated: phase === 'user-message',
            ...(message.automaticDelivery ? { automaticDelivery: message.automaticDelivery } : {}),
          },
        }, typingStartedAt, message.participantId)
        this.scheduleDueIntentWake(story.id, sendAt)
      }
    }
    return messages
  }

  private get alterSystemConfig(): AlterSystemConfig {
    return resolveAlterSystemConfig(this.config.alterSystem)
  }

  private get agencyConfig(): AgencyConfig {
    return resolveAgencyConfig(this.config.agency)
  }

  private get blindModeConfig(): BlindModeConfig {
    return resolveBlindModeConfig(this.config.blindMode ?? this.config.blackBox)
  }

  private emotionalOffsetForPrompt(story: InterludeStory): EmotionalOffsetPrompt | null {
    return emotionalOffsetForPrompt(normalizeAlterSystemState(story.state.alterSystem), this.alterSystemConfig)
  }

  private updateAlterSystem(
    story: InterludeStory,
    current: AlterSystemState | undefined,
    alter: number | undefined,
    phase: NarrativeRequest['phase'],
    now: Date,
  ): AlterTurnResult | undefined {
    const config = this.alterSystemConfig
    if (!config.enabled || alter === undefined) return undefined
    const result = advanceAlterSystem(current, alter, phase, now, config)
    if (result.offsetExpired) this.reportOperation('standard', 'info', story, phase, 'Alter 情绪偏移已自然消退')
    this.reportOperation('diagnostic', 'debug', story, phase,
      'Alter 状态已更新 本轮=%s 累计=%s 阈值=%s 权重=%s', alter, result.state.alterValue, result.threshold.toFixed(2), result.state.alterWeight.toFixed(2))
    return result
  }

  private scheduleAlterAnalysis(storyId: string, phase: NarrativeRequest['phase'], participantId = '') {
    if (this.scheduledAlterAnalyses.has(storyId)) return
    this.scheduledAlterAnalyses.add(storyId)
    this.ctx.setTimeout(() => {
      void this.serial(storyId, () => this.analyzeAlterSystem(storyId, phase, participantId))
        .catch(error => this.reportStandalone('warn', 'Alter 后台分析任务失败 故事=%s 错误=%s', storyId, error))
        .finally(() => this.scheduledAlterAnalyses.delete(storyId))
    }, 0)
  }

  private async analyzeAlterSystem(storyId: string, phase: NarrativeRequest['phase'], participantId = '') {
    const config = this.alterSystemConfig
    if (!config.enabled) return
    const story = await this.getStory(storyId)
    const state = normalizeAlterSystemState(story.state.alterSystem)
    if (!state) return
    const now = new Date()
    const threshold = calculateAlterThreshold(state.history, config, now)
    if (Math.abs(state.alterValue) < threshold || alterAnalysisCoolingDown(state, now)) return
    state.lastAnalysisAttemptAt = now.toISOString()
    await this.dbSet('interlude_story', { id: story.id }, {
      state: { ...story.state, alterSystem: state }, updatedAt: now,
    })
    if (!this.narrator.analyzeAlter) {
      this.report('warn', story, phase, 'Alter 已达到阈值，但当前叙事服务不支持侧端分析；保留累计值等待重试')
      return
    }

    const triggerValue = state.alterValue
    const triggerDirection = Math.sign(triggerValue) as -1 | 1
    try {
      const scripts = (await this.recentEntries(story.id, 50))
        .filter(entry => entry.kind === 'script' && entry.content.trim() && (!entry.participantId || entry.participantId === participantId))
        .slice(-10)
        .map(entry => ({ content: entry.content.slice(0, 4_000), occurredAt: entry.occurredAt.toISOString() }))
      this.reportOperation('standard', 'info', story, phase,
        'Alter 累积触发 数值=%s 阈值=%s 方向=%s', signedNumber(triggerValue), threshold.toFixed(2), triggerDirection > 0 ? '严肃' : '放松')
      const result = await this.narrator.analyzeAlter({
        characterName: story.setting.character.name,
        triggerValue,
        threshold,
        direction: triggerDirection > 0 ? 'serious' : 'relaxed',
        recentScripts: scripts,
        history: state.history.slice(-10),
        settingOverlay: story.state.settingOverlay,
        currentOffset: state.emotionalOffset ? { ...state.emotionalOffset, weight: state.alterWeight } : null,
      }, config)
      const description = result.description.trim().slice(0, 800)
      if (!description) throw new Error('Alter analysis returned an empty description.')
      const completed = completeAlterAnalysis(state, description, threshold, now, config)
      await this.dbSet('interlude_story', { id: story.id }, {
        state: { ...story.state, alterSystem: completed }, updatedAt: now,
      })
      this.reportOperation('standard', 'info', story, phase,
        '情绪偏移生成完成 方向=%s 强度=%s 描述=%s', completed.emotionalOffset.direction, completed.emotionalOffset.intensity.toFixed(2), description)
      this.reportOperation('standard', 'info', story, phase, '情绪偏移已注入后续主提示词 权重=1.00')
    } catch (error) {
      this.report('warn', story, phase, 'Alter 分析失败，已保留累计值等待重试：%s', error)
    }
  }

  private async appendEntry(storyId: string, entry: ScriptEntryDraft, now: Date, participantId = '') {
    const occurredAt = toDate(entry.occurredAt) ?? now
    const created = await this.dbCreate('interlude_script_entry', {
      storyId, participantId, kind: clip(entry.kind, 32) || 'life', actor: clip(entry.actor ?? 'character', 32),
      content: clip(entry.content, 12_000), occurredAt,
      metadata: isRecord(entry.metadata) ? entry.metadata : {}, createdAt: now,
    })
    // Scene entry counts are derived during compaction. Avoiding a second
    // SQLite write here keeps every durable script append atomic and cheap.
    return normalizeDatabaseRow('interlude_script_entry', created) as ScriptEntry
  }

  private async appendMemory(storyId: string, memory: MemoryDraft, now: Date, participantId = '') {
    await this.dbCreate('interlude_memory', {
      storyId, participantId, category: clip(memory.category, 32) || 'fact', content: clip(memory.content, 4_000),
      importance: clampNumber(memory.importance, 0.5, 0, 1), status: 'active', sourceEntryId: null,
      createdAt: now, updatedAt: now,
    })
  }

  /**
   * Retrieves the smallest useful slice of durable facts. When an embedding
   * model is available, semantic relevance is combined with narrative quality
   * signals instead of replacing them; a failed vector lookup simply has a
   * semantic score of zero for this turn.
   */
  async facts(storyId: string, limit = this.memoryConfig.factLimit, query = '', participantId?: string) {
    // The previous floor of 50 caused every live turn to scan a large slice of
    // the facts table, even when the narrator only needed a handful of facts.
    // Keep enough candidates for semantic re-ranking without making the
    // latency-sensitive path do unnecessary database work.
    const candidateLimit = Math.max(20, Math.min(limit * 5, this.memoryConfig.maxFactsPerStory, 300))
    const rows = await this.dbGet('interlude_fact', { storyId, status: 'active' }, {
      limit: candidateLimit,
      sort: { importance: 'desc', updatedAt: 'desc' },
    })
    // Live embedding adds an extra HTTP request to every user turn. Keep it
    // opt-in; stored fact vectors and background backfill still work normally.
    const queryEmbedding = query.trim() && this.config.model.embedding?.liveQuery
      ? await this.embedText(query)
      : []
    return rows
      .filter(fact => participantId === undefined || !fact.participantId || fact.participantId === participantId)
      .map(fact => ({ fact, score: factScore(fact, this.memoryConfig, queryEmbedding) }))
      .sort((a, b) => b.score - a.score
        || b.fact.updatedAt.getTime() - a.fact.updatedAt.getTime()
        || b.fact.id - a.fact.id)
      .slice(0, limit)
      .map(item => item.fact)
  }

  /** Returns only observations that are safe for this narration branch. A
   * participant's browsing is not shown to another private participant unless
   * the owner has explicitly enabled shared relationship details. */
  private async webObservations(storyId: string, participantId?: string) {
    // Browsing is optional. Avoid a database read on every live turn when the
    // feature is disabled, which is the default for most installations.
    if (!this.browserConfig.enabled) return []
    const limit = Math.max(1, Math.min(this.browserConfig.maxObservationsInPrompt, 20))
    const rows = await this.dbGet('interlude_web_observation', { storyId }, {
      limit: Math.max(limit * 4, 20), sort: { accessedAt: 'desc' },
    })
    return rows
      // Failed/blocked attempts already have a terse script event. Keeping
      // their error text in every later prompt wastes tokens and can crowd
      // out useful successful observations.
      .filter(observation => observation.status === 'success')
      .filter(observation => this.sharedStoryConfig.shareParticipantDetails
        || !observation.participantId || observation.participantId === (participantId ?? ''))
      .slice(0, limit)
      .reverse()
  }

  async activeScene(storyId: string): Promise<InterludeScene | null> {
    const rows = await this.dbGet('interlude_scene', { storyId, status: 'active' }, {
      limit: 1,
      sort: { updatedAt: 'desc' },
    })
    return rows[0] ?? null
  }

  async activeArc(storyId: string): Promise<InterludeArc | null> {
    const rows = await this.dbGet('interlude_arc', { storyId, status: 'active' }, {
      limit: 1,
      sort: { updatedAt: 'desc' },
    })
    return rows[0] ?? null
  }

  private async appendIntent(storyId: string, intent: IntentDraft, now: Date, participantId = '') {
    const notBefore = toDate(intent.notBefore)
    const payload = isRecord(intent.payload) ? intent.payload : {}
    const activeConsequence = isActiveConsequenceDraft(intent)
    if (activeConsequence && !this.memoryConfig.activeConsequencesEnabled) return
    const requestedExpiresAt = activeConsequence ? consequenceExpiresAt(payload) : undefined
    const maxLifetime = Math.max(1, this.memoryConfig.activeConsequenceMaxDays) * Time.day
    const expiresAt = requestedExpiresAt && requestedExpiresAt > now
      ? new Date(Math.min(requestedExpiresAt.getTime(), now.getTime() + maxLifetime))
      : undefined
    // Scheduled plans always remain future-facing. An active consequence is
    // different: it is a present condition caused by something already in
    // the script, so it begins at now and only needs a bounded expiry.
    if (!notBefore || (!activeConsequence && notBefore <= now) || (activeConsequence && !expiresAt)) return
    const normalizedPayload = activeConsequence ? {
      ...payload,
      strength: consequenceStrength(payload, this.memoryConfig.activeConsequenceDefaultStrength),
      expiresAt: expiresAt!.toISOString(),
    } : payload
    await this.dbCreate('interlude_intent', {
      storyId, participantId, type: clip(intent.type, 32) || 'follow-up', summary: clip(intent.summary, 4_000), notBefore,
      status: 'pending', payload: normalizedPayload, createdAt: now, updatedAt: now,
    })
  }

  /** Active consequences share the intent table but are never scheduler work.
   * Their payload keeps the lifecycle explicit so old scheduled intents keep
   * their existing behaviour without a migration. */
  private async activeConsequences(storyId: string, now: Date, participantId?: string) {
    if (!this.memoryConfig.activeConsequencesEnabled) return []
    const rows = await this.dbGet('interlude_intent', { storyId, status: 'pending' }, {
      limit: 100, sort: { updatedAt: 'desc' },
    })
    return rows
      .filter(isActiveConsequence)
      .filter(intent => intent.notBefore <= now)
      .filter(intent => {
        const expiresAt = consequenceExpiresAt(intent.payload)
        return !!expiresAt && expiresAt > now
      })
      .filter(intent => participantId === undefined || !intent.participantId || intent.participantId === participantId)
      .sort((left, right) => consequenceStrength(right.payload) - consequenceStrength(left.payload)
        || right.updatedAt.getTime() - left.updatedAt.getTime())
      .slice(0, Math.max(1, this.memoryConfig.activeConsequencePromptLimit))
  }

  private async expireActiveConsequences(storyId: string, now: Date) {
    if (!this.memoryConfig.activeConsequencesEnabled) return
    const rows = await this.dbGet('interlude_intent', { storyId, status: 'pending' }, {
      limit: 100, sort: { updatedAt: 'asc' },
    })
    const expired = rows.filter(intent => isActiveConsequence(intent) && (consequenceExpiresAt(intent.payload)?.getTime() ?? 0) <= now.getTime())
    if (expired.length) {
      await this.dbSet('interlude_intent', { id: { $in: expired.map(intent => intent.id) } }, { status: 'completed', updatedAt: now })
    }
  }

  /** Only active consequences visible to the writer may be resolved. This
   * prevents a remote model from changing arbitrary future plans by id. */
  private async applyIntentUpdates(storyId: string, updates: ReturnType<typeof normalizeIntentUpdates>, now: Date, participantId?: string) {
    if (!updates.length) return
    const ids = updates.map(update => update.id)
    const rows = await this.dbGet('interlude_intent', { storyId, id: { $in: ids }, status: 'pending' })
    const allowed = new Map(rows
      .filter(isActiveConsequence)
      .filter(intent => !participantId || !intent.participantId || intent.participantId === participantId)
      .map(intent => [intent.id, intent]))
    for (const update of updates) {
      const intent = allowed.get(update.id)
      if (!intent) continue
      const payload = {
        ...intent.payload,
        ...(update.resolution ? { resolution: update.resolution } : {}),
      }
      await this.dbSet('interlude_intent', { id: intent.id }, { status: update.status, payload, updatedAt: now })
    }
  }

  /** Stores a narrator-proposed browser action as a future intent. The model
   * never writes page content directly; a separate Puppeteer task creates the
   * observation later. */
  private async appendBrowserIntent(storyId: string, draft: BrowserIntentDraft, now: Date, fallbackParticipantId = '') {
    const config = this.browserConfig
    if (!config.enabled) return
    const normalized = normalizeBrowserIntentDraft(draft, config)
    if (!normalized) return
    // A model may describe a reason involving another person, but it may not
    // silently attach a web observation to another relationship branch. The
    // active participant owns a live-turn browse; unattended life browsing is
    // world-level. This is both a privacy boundary and a simpler mental model.
    const participantId = fallbackParticipantId
    const allowedParticipant = participantId ? await this.getParticipant(participantId) : undefined
    if (participantId && (!allowedParticipant || !this.canHandleParticipant(allowedParticipant))) return
    const notBefore = new Date(now.getTime() + Time.second)
    await this.appendIntent(storyId, {
      type: 'browser-research',
      summary: clip(normalized.purpose, 500) || 'The character planned to read a public web page.',
      notBefore: notBefore.toISOString(),
      payload: {
        mode: normalized.mode,
        query: normalized.query ?? '',
        url: normalized.url ?? '',
        purpose: normalized.purpose,
      },
    }, now, participantId)
    this.reportStandaloneOperation('diagnostic', 'debug', '已创建网页浏览意图：故事=%s 模式=%s', storyId, normalized.mode)
  }

  /** Executes a due browser intent once, records its bounded observation, and
   * marks the future plan complete regardless of success. A failed browser is
   * still an event (the character could not access the page), but it never
   * blocks later dialogue or background life updates. */
  private async executeDeferredBrowserIntent(story: InterludeStory, intent: NarrativeIntent, now: Date) {
    const payload = browserIntentFromPayload(intent.payload)
    const observation = await this.collectWebObservation(story, payload, intent.participantId, intent.id, now)
    await this.dbSet('interlude_intent', { id: intent.id }, { status: 'completed', updatedAt: new Date() })
    return observation
  }

  /** Read a page through Koishi Puppeteer. This is intentionally read-only:
   * it rejects non-public destinations, extracts visible text only, and closes
   * the page after every observation. */
  private async collectWebObservation(story: InterludeStory, draft: BrowserIntentDraft | null, participantId: string, intentId: number | null, now: Date, persist = true): Promise<WebObservation> {
    const config = this.browserConfig
    const normalized = draft ? normalizeBrowserIntentDraft(draft, config) : undefined
    if (!normalized || !config.enabled) {
      return this.saveWebObservation(story.id, participantId, intentId, normalized?.mode ?? 'visit', normalized?.query ?? '', normalized?.url ?? '', '', '', '浏览未执行：功能未启用或请求不符合安全规则。', 'blocked', now, persist)
    }

    const target = resolveBrowserTarget(normalized, config)
    if (!target) {
      this.report('warn', story, 'intent-due', '网页浏览被安全策略拦截：模式=%s', normalized.mode)
      return this.saveWebObservation(story.id, participantId, intentId, normalized.mode, normalized.query ?? '', normalized.url ?? '', '', '', '浏览目标未通过公开网页安全校验。', 'blocked', now, persist)
    }

    const cached = await this.findCachedWebObservation(story.id, participantId, normalized, now)
    if (cached) {
      if (!persist) return { ...cached, id: 0, intentId, accessedAt: now, createdAt: now }
      await this.appendEntry(story.id, {
        kind: 'web-observation', actor: 'system',
        content: `The character revisited a recent web observation: ${cached.title || cached.url}.`,
        occurredAt: now.toISOString(), metadata: { observationId: cached.id, cached: true, status: cached.status },
      }, now, participantId)
      return cached
    }

    const puppeteer = (this.ctx as any).puppeteer
    if (!puppeteer?.page) {
      this.report('warn', story, 'intent-due', '网页浏览服务不可用：请安装并启用 koishi-plugin-puppeteer。')
      return this.saveWebObservation(story.id, participantId, intentId, normalized.mode, normalized.query ?? '', target, '', '', '浏览器服务不可用。', 'failed', now, persist)
    }

    return this.withBrowserSlot(async () => {
      let page: any
      try {
        page = await puppeteer.page()
        await page.setUserAgent(`Mozilla/5.0 (compatible; HDS-Interlude/${HDS_INTERLUDE_VERSION}; +https://koishi.chat/)`)
        await page.setRequestInterception(true)
        page.on('request', (request: any) => {
          const resourceType = request.resourceType?.() ?? 'document'
          const requestUrl = request.url?.() ?? ''
          const allowedResource = ['document', 'stylesheet', 'script', 'xhr', 'fetch', 'image'].includes(resourceType)
          const allowedUrl = isSafePublicWebUrl(requestUrl, config)
          const operation = allowedResource && allowedUrl ? request.continue() : request.abort('blocked')
          void Promise.resolve(operation).catch(() => undefined)
        })
        page.on('popup', (popup: any) => void popup.close().catch(() => undefined))
        await page.goto(target, { waitUntil: config.waitUntil, timeout: config.navigationTimeout })
        const finalUrl = String(page.url?.() ?? target)
        if (!isSafePublicWebUrl(finalUrl, config)) throw new Error('页面重定向到了不允许的地址。')
        const result = await page.evaluate(() => ({
          title: String(document.title || '').trim(),
          text: String(document.body?.innerText || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim(),
        }))
        const text = clip(String(result?.text ?? ''), config.maxTextCharacters)
        const title = clip(String(result?.title ?? ''), 500)
        const excerpt = clip(text, config.maxExcerptCharacters)
        const summary = clip(`${title ? `${title}。` : ''}${excerpt}`, config.maxExcerptCharacters)
        const observation = await this.saveWebObservation(story.id, participantId, intentId, normalized.mode, normalized.query ?? '', finalUrl, title, excerpt, summary || '页面没有可提取的正文。', 'success', new Date(), persist)
        this.reportOperation('standard', 'info', story, 'intent-due', '网页读取完成 标题=%s 正文=%d字', title || '未命名页面', text.length)
        if (config.logObservationPreview) this.report('debug', story, 'intent-due', '网页观察节选：%s', excerpt)
        return observation
      } catch (error) {
        this.report('warn', story, 'intent-due', '网页读取失败：%s', error)
        return this.saveWebObservation(story.id, participantId, intentId, normalized.mode, normalized.query ?? '', target, '', '', `网页读取失败：${clip(String(error instanceof Error ? error.message : error), 500)}`, 'failed', new Date(), persist)
      } finally {
        if (page) await page.close().catch(() => undefined)
      }
    })
  }

  private async saveWebObservation(storyId: string, participantId: string, intentId: number | null, mode: 'search' | 'visit', query: string, url: string, title: string, excerpt: string, summary: string, status: WebObservation['status'], now: Date, persist = true): Promise<WebObservation> {
    const candidate: WebObservation = {
      id: 0, storyId, participantId, intentId, mode, query: clip(query, 500), url: clip(url, 2_000), title: clip(title, 500),
      excerpt: clip(excerpt, this.browserConfig.maxExcerptCharacters), summary: clip(summary, this.browserConfig.maxExcerptCharacters),
      status, accessedAt: now, createdAt: now,
    }
    if (!persist) return candidate
    const observation = await this.dbCreate('interlude_web_observation', candidate) as WebObservation
    await this.appendEntry(storyId, {
      kind: 'web-observation', actor: 'system',
      content: webObservationEntryContent(observation), occurredAt: now.toISOString(),
      metadata: { observationId: observation.id, status, mode, url: observation.url },
    }, now, participantId)
    return observation
  }

  /** Immediate browser reads are intentionally held in memory until the
   * final narrator result survives the stale-request check. This prevents an
   * obsolete two-second message burst from leaving a durable web event behind. */
  private async persistCollectedWebObservation(observation: WebObservation) {
    return this.saveWebObservation(
      observation.storyId, observation.participantId, observation.intentId, observation.mode,
      observation.query, observation.url, observation.title, observation.excerpt, observation.summary,
      observation.status, observation.accessedAt,
    )
  }

  private async findCachedWebObservation(storyId: string, participantId: string, draft: BrowserIntentDraft, now: Date) {
    const minutes = this.browserConfig.cacheMinutes
    if (minutes <= 0) return undefined
    const cutoff = new Date(now.getTime() - minutes * Time.minute)
    const rows = await this.dbGet('interlude_web_observation', { storyId, participantId, status: 'success' }, {
      limit: 20, sort: { accessedAt: 'desc' },
    })
    return rows.find(observation => observation.accessedAt >= cutoff
      && observation.mode === draft.mode
      && (draft.mode === 'search' ? observation.query === (draft.query ?? '') : observation.url === (draft.url ?? '')))
  }

  private async withBrowserSlot<T>(task: () => Promise<T>) {
    const max = Math.max(1, this.browserConfig.maxConcurrentPages)
    if (this.browserActive >= max) await new Promise<void>(resolve => this.browserWaiters.push(resolve))
    this.browserActive++
    try {
      return await task()
    } finally {
      this.browserActive--
      this.browserWaiters.shift()?.()
    }
  }

  /** Persist a bounded retry so a transient provider failure cannot strand a user turn. */
  private async scheduleNarrativeRetry(storyId: string, participantId: string, now: Date, previousAttempts = 0) {
    const delaySeconds = Math.max(5, this.config.runtime.narrativeRetryDelaySeconds ?? 60)
    const maxAttempts = Math.max(0, this.config.runtime.narrativeRetryMaxAttempts ?? 6)
    const pending = await this.dbGet('interlude_intent', { storyId, participantId, status: 'pending' })
    const existing = pending.filter(intent => intent.type === 'narrative-retry')
    if (existing.length) await this.dbSet('interlude_intent', { id: { $in: existing.map(intent => intent.id) } }, { status: 'cancelled', updatedAt: now })
    if (!participantId || previousAttempts >= maxAttempts) {
      this.reportStandalone('warn', '叙事模型自动重试已停止 故事=%s 参与者=%s 已尝试=%d 上限=%d', storyId, participantId || '全局', previousAttempts, maxAttempts)
      return false
    }
    const attempt = previousAttempts + 1
    const notBefore = new Date(now.getTime() + delaySeconds * Time.second)
    await this.appendIntent(storyId, {
      type: 'narrative-retry',
      summary: `Retry the interrupted narrative turn after provider failure (attempt ${attempt}/${maxAttempts}).`,
      notBefore: notBefore.toISOString(),
      payload: { narrativeRetry: true, userInitiated: true, attempt },
    }, now, participantId)
    this.reportStandalone('warn', '叙事模型请求失败，已安排自动重试 故事=%s 参与者=%s 次数=%d/%d 等待=%d秒', storyId, participantId, attempt, maxAttempts, delaySeconds)
    return true
  }

  private async dueIntents(storyId: string, now: Date) {
    const intents = await this.dbGet('interlude_intent', { storyId, status: 'pending', notBefore: { $lte: now } }, {
      sort: { notBefore: 'asc' },
    })
    const expiredAgency = intents.filter(intent => intent.type === 'proactive-check'
      && (!this.agencyConfig.enabled || !toDate(intent.payload?.expiresAt) || toDate(intent.payload?.expiresAt)! <= now))
    if (expiredAgency.length) {
      await this.dbSet('interlude_intent', { id: { $in: expiredAgency.map(intent => intent.id) } }, { status: 'cancelled', updatedAt: now })
    }
    const expiredIds = new Set(expiredAgency.map(intent => intent.id))
    return intents.filter(intent => !expiredIds.has(intent.id) && !isActiveConsequence(intent))
  }

  /** Wake the scheduler close to a short typing delay instead of waiting for
   * the normal background sweep. The due intent remains the source of truth. */
  private scheduleDueIntentWake(storyId: string, notBefore: Date) {
    const delay = Math.max(0, notBefore.getTime() - Date.now())
    const existing = this.dueIntentWakeTimers.get(storyId)
    // Several <sep/> segments can be scheduled at once. Keep the earliest
    // wake-up; the next due segment schedules the following wake as needed.
    if (existing && existing.dueAt <= notBefore.getTime()) return
    if (existing) existing.cancel()
    const wake = () => {
      this.dueIntentWakeTimers.delete(storyId)
      // A long narrative request can overlap the simulated typing delay. Keep
      // the intent pending and retry shortly after the scheduler is free,
      // rather than waiting for the next normal sweep.
      if (this.databaseResetting) return
      void (async () => {
        const due = await this.dueIntents(storyId, new Date())
        // Split segments are already committed transport events. Deliver them
        // through the story queue directly; do not make them wait for the
        // five-minute sweep or start another narrator request.
        if (due.length && due.every(intent => intent.type === 'split-message')) {
          await this.deliverDueSplitSegments(storyId)
          return
        }
        if (this.sweepRunning || this.hasPendingNarrative(storyId)) {
          const retryAt = Date.now() + Time.second
          const retry = this.ctx.setTimeout(wake, Time.second)
          this.dueIntentWakeTimers.set(storyId, { cancel: retry, dueAt: retryAt })
          return
        }
        await this.sweep()
      })().catch(error => this.reportStandaloneOperation('diagnostic', 'debug', '到期消息唤醒失败 错误=%s', error))
    }
    const timer = this.ctx.setTimeout(wake, delay)
    this.dueIntentWakeTimers.set(storyId, { cancel: timer, dueAt: notBefore.getTime() })
    this.reportStandaloneOperation('diagnostic', 'debug', '已设置到期计时器 故事=%s 触发时间=%s 等待=%dms', storyId, formatLogTime(notBefore, 'Asia/Shanghai'), delay)
  }

  private async scheduleNextSplitWake(storyId: string) {
    const pending = await this.dbGet('interlude_intent', { storyId, status: 'pending', type: 'split-message' }, {
      sort: { notBefore: 'asc' }, limit: 1,
    })
    const next = pending[0]
    if (next) this.scheduleDueIntentWake(storyId, next.notBefore)
  }

  /** Deliver already-decided <sep/> segments without invoking the narrator. */
  private async deliverDueSplitSegments(storyId: string) {
    await this.serial(storyId, async () => {
      const story = await this.getStory(storyId)
      const now = new Date()
      const due = await this.dbGet('interlude_intent', {
        storyId, status: 'pending', type: 'split-message', notBefore: { $lte: now },
      }, { sort: { notBefore: 'asc' }, limit: 20 })
      const next = due[0]
      if (next) {
        const intent = next
          const content = clip(intent.payload?.content, this.config.runtime.maxMessageCharacters)
          const automaticDelivery = automaticDeliveryFromPayload(intent.payload)
        const participant = intent.participantId ? await this.getParticipant(intent.participantId) : undefined
        if (intent.participantId && this.interruptedTypingParticipants.has(intent.participantId)) {
          // The incoming-message transaction is queued behind this one. Leave
          // every split intent pending so it can cancel them and carry their
          // exact draft contents into the replacement writing request.
          return
        }
        if (!content || !participant || participant.status !== 'active') {
          await this.dbSet('interlude_intent', { id: intent.id }, { status: 'cancelled', updatedAt: now })
        } else {
          // Start transport while still holding the story queue. Input that
          // arrived before this point sets interruptedTypingParticipants and
          // cancels the chain; input after this point cannot retract a message
          // whose adapter send has already begun.
          const delivered = await this.sendOutgoingMessages(
            story,
            [{ participantId: participant.id, content, automaticDelivery }],
            undefined,
            undefined,
            target => this.interruptedTypingParticipants.has(target.id),
          )
          if (!delivered.length) {
            if (this.interruptedTypingParticipants.has(participant.id)) return
            const retryAt = new Date(now.getTime() + 30 * Time.second)
            await this.dbSet('interlude_intent', { id: intent.id }, { notBefore: retryAt, updatedAt: now })
            this.scheduleDueIntentWake(storyId, retryAt)
            return
          }
          await this.appendEntry(storyId, {
            kind: 'character-message', actor: 'character', content,
            occurredAt: now.toISOString(), metadata: { visible: true, splitSegment: true },
          }, now, participant.id)
          await this.recordCharacterMessage(participant, now)
          await this.dbSet('interlude_intent', { id: intent.id }, { status: 'completed', updatedAt: now })
        }
      }
      // When several segments became overdue together, restore a fresh
      // typing interval instead of immediately draining the backlog.
      const remaining = due.slice(1)
      if (remaining.length) {
        const following = remaining[0]
        if (following.notBefore <= now) {
          const followingContent = clip(following.payload?.content, this.config.runtime.maxMessageCharacters)
          if (followingContent) {
            await this.dbSet('interlude_intent', { id: following.id }, {
              notBefore: new Date(now.getTime() + this.typingDelayMilliseconds(followingContent)), updatedAt: now,
            })
          }
        }
      }
      await this.scheduleNextSplitWake(storyId)
    })
  }

  /** Pending spoken promises are intentionally tiny and relationship-local. */
  private async pendingFollowUpCommitments(storyId: string, participantId: string) {
    return this.dbGet('interlude_intent', {
      storyId, participantId, type: 'follow-up-commitment', status: 'pending',
    }, { limit: 2, sort: { notBefore: 'asc' } }) as Promise<NarrativeIntent[]>
  }

  private async appendFollowUpCommitment(
    story: InterludeStory,
    participantId: string,
    draft: FollowUpCommitmentDraft,
    fallbackSourceEntryId: number | undefined,
    now: Date,
  ) {
    const pending = await this.dbGet('interlude_intent', {
      storyId: story.id, participantId, type: 'follow-up-commitment', status: 'pending',
    }, { limit: 3, sort: { notBefore: 'asc' } }) as NarrativeIntent[]
    const key = normalizeFollowUpSummary(draft.summary)
    const duplicate = pending.find(intent => normalizeFollowUpSummary(intent.summary) === key)
    if (duplicate || pending.length >= 2) {
      this.reportOperation('diagnostic', 'debug', story, 'user-message',
        '承诺回访未重复创建 参与者=%s 原因=%s', participantId, duplicate ? '同一事项待处理' : '待处理上限')
      return
    }
    const sourceEntryIds = [
      ...(draft.sourceEntryIds ?? []).filter(id => Number.isSafeInteger(id) && id > 0),
      ...(fallbackSourceEntryId ? [fallbackSourceEntryId] : []),
    ].slice(-4)
    const expiresAt = followUpExpiresAt(draft.expiresAt, now)
    await this.appendIntent(story.id, {
      type: 'follow-up-commitment', summary: draft.summary, notBefore: draft.notBefore,
      payload: {
        kind: draft.kind, sourceEntryIds, expiresAt: expiresAt.toISOString(),
        requiresVisibleOutcome: true, userInitiated: true,
      },
    }, now, participantId)
    this.scheduleDueIntentWake(story.id, new Date(draft.notBefore))
    this.reportOperation('standard', 'info', story, 'user-message',
      '已登记承诺回访 参与者=%s 类型=%s 到期=%s', participantId, draft.kind, formatLogTime(new Date(draft.notBefore), story.setting.timezone))
  }

  private async applyFollowUpResolutions(
    storyId: string,
    participantId: string,
    resolutions: FollowUpResolutionDraft[],
    interaction: NarrativeInteraction | undefined,
    now: Date,
  ) {
    if (!resolutions.length || interaction?.reply.mode !== 'immediate' || !interaction.reply.content?.trim()) return new Set<number>()
    const ids = resolutions.map(item => item.id)
    const rows = await this.dbGet('interlude_intent', {
      storyId, participantId, type: 'follow-up-commitment', status: 'pending', id: { $in: ids },
    }) as NarrativeIntent[]
    const resolved = new Set<number>()
    for (const resolution of resolutions) {
      const intent = rows.find(item => item.id === resolution.id)
      if (!intent) continue
      if (resolution.outcome === 'rescheduled') {
        const nextAt = toDate(resolution.notBefore)
        if (!nextAt || nextAt <= now || nextAt.getTime() - now.getTime() > 12 * Time.hour) continue
        await this.dbSet('interlude_intent', { id: intent.id }, {
          notBefore: nextAt, payload: { ...intent.payload, reschedules: Number(intent.payload.reschedules ?? 0) + 1 }, updatedAt: now,
        })
        this.scheduleDueIntentWake(storyId, nextAt)
      } else {
        await this.dbSet('interlude_intent', { id: intent.id }, {
          status: resolution.outcome === 'cancelled' ? 'cancelled' : 'completed', updatedAt: now,
        })
      }
      resolved.add(intent.id)
    }
    return resolved
  }

  private async deferUnresolvedDueFollowUps(
    storyId: string,
    participantId: string,
    contextIntents: NarrativeIntent[],
    resolvedIds: Set<number>,
    interaction: NarrativeInteraction | undefined,
    now: Date,
  ) {
    const due = contextIntents.filter(intent => intent.type === 'follow-up-commitment' && intent.participantId === participantId)
    if (!due.length) return
    for (const intent of due) {
      if (resolvedIds.has(intent.id)) continue
      if (interaction?.reply.mode === 'immediate' && interaction.reply.content?.trim()) {
        await this.dbSet('interlude_intent', { id: intent.id }, { status: 'completed', updatedAt: now })
        continue
      }
      const retryAt = new Date(now.getTime() + 20 * Time.minute)
      await this.dbSet('interlude_intent', { id: intent.id }, {
        notBefore: retryAt,
        payload: { ...intent.payload, deferredChecks: Number(intent.payload.deferredChecks ?? 0) + 1 },
        updatedAt: now,
      })
      this.scheduleDueIntentWake(storyId, retryAt)
      this.reportOperation('standard', 'warn', await this.getStory(storyId), 'intent-due',
        '承诺回访尚未给出可见结果，已保留重查 参与者=%s', participantId)
    }
  }

  private async appendProactiveCheck(
    story: InterludeStory,
    candidate: ProactiveContactDraft,
    notBefore: Date,
    reason: string,
    now: Date,
  ) {
    const expiresAt = toDate(candidate.expiresAt)
    if (!expiresAt || expiresAt <= now || notBefore >= expiresAt) return
    const fingerprint = proactiveCandidateFingerprint(candidate)
    const pending = await this.dbGet('interlude_intent', {
      storyId: story.id,
      participantId: candidate.participantId,
      status: 'pending',
      type: 'proactive-check',
    })
    if (pending.some(intent => intent.payload?.fingerprint === fingerprint)) {
      this.reportOperation('diagnostic', 'debug', story, 'advance',
        'Agency 主动联系候选去重 参与者=%s 指纹=%s', candidate.participantId, fingerprint)
      return
    }
    await this.appendIntent(story.id, {
      type: 'proactive-check',
      summary: `Re-evaluate a life-grounded contact motive: ${candidate.motive}`,
      notBefore: notBefore.toISOString(),
      participantId: candidate.participantId,
      payload: {
        origin: candidate.origin,
        motive: candidate.motive,
        disclosure: candidate.disclosure,
        sourceEntryIds: candidate.sourceEntryIds ?? [],
        willingness: candidate.willingness,
        expiresAt: candidate.expiresAt,
        fingerprint,
        agencyReason: reason,
        userInitiated: false,
      },
    }, now, candidate.participantId)
    this.scheduleDueIntentWake(story.id, notBefore)
    this.reportOperation('standard', 'info', story, 'advance',
      'Agency 已安排主动联系重查 参与者=%s 时间=%s 原因=%s',
      candidate.participantId, formatLogTime(notBefore, story.setting.timezone), reason)
  }

  private async cancelPendingOutgoingMessages(storyId: string, participantId: string, now: Date, cancelPlanned = true) {
    let completed = false
    try {
      const intents = await this.dbGet('interlude_intent', { storyId, participantId, status: 'pending' })
      const matching = intents.filter(intent => intent.participantId === participantId && (
        intent.type === 'split-message'
        || cancelPlanned && (intent.type === 'delayed-reply' || intent.type === 'cross-conversation-message')
      ))
      if (!matching.length) {
        completed = true
        return matching
      }

      await this.dbSet('interlude_intent', { id: { $in: matching.map(intent => intent.id) } }, {
        status: 'cancelled',
        updatedAt: now,
      })
      const wake = this.dueIntentWakeTimers.get(storyId)
      if (wake) {
        wake.cancel()
        this.dueIntentWakeTimers.delete(storyId)
      }
      await this.scheduleNextSplitWake(storyId)
      const interruptedDrafts = matching
        .filter(intent => intent.type === 'split-message')
        .map(intent => clip(intent.payload?.content, this.config.runtime.maxMessageCharacters))
        .filter(Boolean)
      const content = interruptedDrafts.length
        ? `The protagonist wanted to send ${interruptedDrafts.map(draft => JSON.stringify(draft)).join(' and ')}, but had not finished typing before the user's new message arrived.`
        : 'A newer user message superseded a planned outgoing message before it was sent.'
      await this.appendEntry(storyId, {
        kind: 'intent-cancelled',
        actor: 'system',
        content,
        occurredAt: now.toISOString(),
        metadata: { intentIds: matching.map(intent => intent.id), interruptedDrafts },
      }, now, participantId)
      completed = true
      return matching
    } finally {
      if (completed) this.interruptedTypingParticipants.delete(participantId)
    }
  }

  private async sendScheduledMessages(story: InterludeStory, messages: OutgoingMessageDraft[]) {
    return this.sendOutgoingMessages(story, messages)
  }

  /**
   * Immediate replies may reuse the incoming Session; cross-account and timed
   * messages are delivered through the target participant's channel instead.
   * This is the boundary that prevents a shared story from accidentally
   * sending every reply back to the account that happened to trigger the turn.
   */
  private async sendOutgoingMessages(
    story: InterludeStory,
    messages: OutgoingMessageDraft[],
    current?: InterludeParticipant,
    session?: Session,
    shouldCancel?: (target: InterludeParticipant) => boolean,
  ) {
    const delivered: OutgoingMessageDraft[] = []
    if (!messages.length) return delivered
    const ids = Array.from(new Set(messages.map(message => message.participantId).filter(Boolean)))
    const byId = new Map<string, InterludeParticipant>()
    if (current && ids.includes(current.id)) byId.set(current.id, current)
    const missingIds = ids.filter(id => !byId.has(id))
    const participants = await Promise.all(missingIds.map(id => this.getParticipant(id)))
    for (const participant of participants) if (participant) byId.set(participant.id, participant)
    for (const message of messages) {
      const target = byId.get(message.participantId)
      if (!target) {
        this.report('warn', story, 'intent-due', '无法投递消息：参与者不存在 %s', message.participantId)
        continue
      }
      if (!this.canHandleParticipant(target)) {
        this.report('warn', story, 'intent-due', '消息被当前账号白名单拦截 参与者=%s', target.id)
        continue
      }
      if (shouldCancel?.(target)) {
        this.reportOperation('standard', 'info', story, 'user-message', '新消息打断主角输入，停止发送后续分段 参与者=%s', target.id)
        continue
      }
      try {
        this.reportOperation('standard', 'info', story, 'intent-due', '消息投递开始 参与者=%s', target.id)
        const literalQuoteMessageId = await this.resolveLiteralQuoteMessageId(story.id, target.id, message.content)
        const literalQuoteOnly = isLiteralQuoteOnly(message.content)
        if (literalQuoteOnly && !literalQuoteMessageId) {
          this.report('warn', story, 'intent-due', '已阻止无法映射的伪引用文本 参与者=%s', target.id)
          continue
        }
        if (literalQuoteMessageId) await this.recordLiteralQuoteTransport(story.id, target.id, message.content, literalQuoteMessageId)
        const outgoingContent = literalQuoteMessageId
          ? [h('quote', { id: literalQuoteMessageId }), '\u200b']
          : message.content
        if (this.config.logging?.logMessageContent) {
          this.report('info', story, 'intent-due', '主角消息内容：%s', message.content.slice(0, this.config.logging.previewLength))
        }
        if (session && current?.id === target.id) {
          await session.send(outgoingContent)
          delivered.push(message)
          if (message.automaticDelivery) await this.recordAutomaticDelivery(story.id, target.id, message.automaticDelivery, new Date())
          continue
        }
        const bot = this.findBotForParticipant(target)
        if (!bot) {
          this.report('warn', story, 'intent-due', '没有可用机器人账号投递消息 参与者=%s', target.id)
          continue
        }
        await bot.sendMessage(target.channelId, outgoingContent)
        delivered.push(message)
        if (message.automaticDelivery) await this.recordAutomaticDelivery(story.id, target.id, message.automaticDelivery, new Date())
      } catch (error) {
          this.report('warn', story, 'intent-due', '消息投递失败 参与者=%s 错误=%s', target.id, error)
      }
    }
    return delivered
  }

  private async resolveLiteralQuoteMessageId(storyId: string, participantId: string, content: string) {
    const quoted = literalQuoteText(content)
    if (!quoted) return undefined
    const entries = await this.dbGet('interlude_script_entry', { storyId, participantId }, {
      limit: 120, sort: { occurredAt: 'desc' },
    }) as ScriptEntry[]
    const matched = entries.find(entry => entry.content.trim() === quoted && targetableMessageId(entry.metadata?.messageId))
    return matched ? targetableMessageId(matched.metadata?.messageId) : undefined
  }

  private async recordLiteralQuoteTransport(storyId: string, participantId: string, content: string, messageId: string) {
    const entries = await this.dbGet('interlude_script_entry', {
      storyId, participantId, kind: 'character-message', content,
    }, { limit: 3, sort: { createdAt: 'desc' } }) as ScriptEntry[]
    const entry = entries[0]
    if (!entry) return
    await this.dbSet('interlude_script_entry', { id: entry.id }, {
      content: '[主角引用了此前的一条消息]',
      metadata: { ...entry.metadata, visible: true, quoteMessageId: messageId, quoteTransport: true },
    })
  }

  /** Records only completed background deliveries. It is intentionally a
   * bounded action ledger, rather than a duplicate conversation transcript. */
  private async recordAutomaticDelivery(
    storyId: string,
    participantId: string,
    delivery: NonNullable<OutgoingMessageDraft['automaticDelivery']>,
    now: Date,
  ) {
    const story = await this.getStory(storyId)
    const state = normalizeStoryState(story.state)
    const summary = clip(delivery.summary, 240).trim()
    if (!summary) return
    const prior = state.automaticDeliverySummaries ?? []
    const same = prior.find(item => item.participantId === participantId && item.sourceEntryId === delivery.sourceEntryId)
    const next: AutomaticDeliverySummary = {
      participantId, summary: same ? mergeDeliverySummary(same.summary, summary) : summary,
      ...(delivery.sourceEntryId ? { sourceEntryId: delivery.sourceEntryId } : {}),
      deliveredAt: now.toISOString(),
    }
    const retained = prior.filter(item => item !== same)
    retained.push(next)
    await this.dbSet('interlude_story', { id: story.id }, {
      state: { ...state, automaticDeliverySummaries: retained.slice(-6) }, updatedAt: now,
    })
  }

  private splitOutgoingMessage(content: string) {
    if (this.config.runtime.splitReplyMessages === false) return [content]
    const separator = this.config.runtime.messageSeparator?.trim() || '<sep/>'
    if (!separator || !content.includes(separator)) return [content]
    return content.split(separator).map(part => part.trim()).filter(Boolean)
  }

  private typingDelayMilliseconds(nextSegment: string) {
    const baseSeconds = Math.max(0, this.config.runtime.typingBaseDelaySeconds ?? 1)
    const charactersPerSecond = Math.max(1, this.config.runtime.typingCharactersPerSecond ?? 8)
    const maximumSeconds = Math.max(baseSeconds, this.config.runtime.typingMaxDelaySeconds ?? 12)
    const seconds = Math.min(maximumSeconds, baseSeconds + Math.ceil(nextSegment.length / charactersPerSecond))
    return seconds * Time.second
  }

  private findBotForParticipant(participant: InterludeParticipant) {
    return this.ctx.bots.find(bot =>
      String(bot.selfId) === String(participant.selfId)
      && (bot.platform === participant.platform || isOneBotPlatform(bot.platform) && isOneBotPlatform(participant.platform)))
  }

  private get autoAdvanceConfig(): AutoAdvanceConfig {
    const runtime = this.config.runtime
    return {
      enabled: runtime.autoAdvanceEnabled ?? true,
      intervalMinutes: Math.max(1, runtime.autoAdvanceIntervalMinutes ?? 40),
      jitterMinutes: Math.max(0, runtime.autoAdvanceJitterMinutes ?? 5),
      followUpMinutes: normalizeFollowUpMinutes(runtime.conversationFollowUpMinutes),
      followUpJitterMinutes: Math.max(0, Math.min(10, runtime.conversationFollowUpJitterMinutes ?? 1)),
      restWindows: runtime.restWindows ?? [{
        enabled: true, label: 'night sleep', start: '23:00', end: '07:00',
        minIntervalMinutes: 120, maxIntervalMinutes: 240,
      }],
    }
  }

  private isAutomaticAdvancePaused(story: InterludeStory, now: Date) {
    const quietUntil = toDate(story.state.automation?.quietUntil)
    return !!quietUntil && quietUntil > now
  }

  private dueConversationFollowUps(story: InterludeStory, now: Date) {
    const planned = (story.state.automation?.conversationFollowUpAt ?? [])
      .map(toDate)
      .filter((value): value is Date => !!value)
      .sort((left, right) => left.getTime() - right.getTime())
    return planned.filter(value => value <= now)
  }

  /** Remove elapsed short passes after their single writing turn. The next
   * remaining pass stays persisted, so reloads never restart the 10/20-minute
   * sequence or accidentally run both passes at once. */
  private async completeConversationFollowUps(storyId: string, now: Date) {
    const story = await this.getStory(storyId)
    const remaining = (story.state.automation?.conversationFollowUpAt ?? [])
      .map(toDate)
      .filter((value): value is Date => !!value && value > now)
      .sort((left, right) => left.getTime() - right.getTime())
    const automation = {
      ...(story.state.automation ?? {}),
      conversationFollowUpAt: remaining.map(value => value.toISOString()),
      ...(remaining.length ? {} : { conversationFollowUpParticipantId: undefined }),
      nextAdvanceAt: remaining[0]?.toISOString(),
    }
    await this.dbSet('interlude_story', { id: story.id }, { state: { ...story.state, automation }, updatedAt: now })
    return remaining.length > 0
  }

  private isAutomaticAdvanceDue(story: InterludeStory, now: Date) {
    const config = this.autoAdvanceConfig
    if (!config.enabled) return false
    const scheduled = toDate(story.state.automation?.nextAdvanceAt)
    if (scheduled) return scheduled <= now
    // Stories created before this scheduler existed have no persisted next time.
    // Use the normal cadence once, then persist a randomized schedule afterwards.
    return now.getTime() - story.cursorAt.getTime() >= config.intervalMinutes * Time.minute
  }

  private async pauseAutomaticAdvanceAfterUserMessage(storyId: string, now: Date) {
    // Cancel the old post-conversation cadence as soon as a new message
    // arrives. The new cadence is set after this turn has actually decided
    // whether it replies now, later, or not at all.
    const story = await this.getStory(storyId)
    const fallbackNext = new Date(now.getTime() + automaticIntervalMinutes(story, now, this.autoAdvanceConfig) * Time.minute)
    const automation = {
      ...(story.state.automation ?? {}),
      conversationFollowUpAt: [],
      conversationFollowUpParticipantId: undefined,
      quietUntil: undefined,
      lastUserMessageAt: now.toISOString(),
      // Covers group-gate silence and provider failures: no old short timer
      // may fire while this fresh conversation event is still unresolved.
      nextAdvanceAt: fallbackNext.toISOString(),
    }
    await this.dbSet('interlude_story', { id: story.id }, { state: { ...story.state, automation }, updatedAt: now })
  }

  private async pauseAutomaticAdvanceAfterDelayedReply(storyId: string, now: Date, participantId = '') {
    await this.scheduleConversationFollowUpsAfterTurn(storyId, now, undefined, participantId)
  }

  /** Schedule the 10/20-minute continuity passes from the actual endpoint of
   * a conversation. A delayed reply anchors them after its planned send time. */
  private async scheduleConversationFollowUpsAfterTurn(storyId: string, now: Date, rawInteraction?: NarrativeInteraction, participantId = '') {
    const config = this.autoAdvanceConfig
    if (!config.enabled) return
    const story = await this.getStory(storyId)
    const interaction = rawInteraction ? normalizeInteraction(rawInteraction, now, this.config.runtime) : undefined
    const delayedUntil = interaction?.reply.mode === 'delayed' ? toDate(interaction.reply.sendAt) : undefined
    const anchor = delayedUntil && delayedUntil > now ? delayedUntil : now
    // Sleep/rest windows keep their low-frequency cadence: do not wake the
    // story twice in twenty minutes merely because a conversation ended near
    // bedtime.
    const followUps = activeRestWindow(config.restWindows, story.setting.timezone, anchor)
      ? []
      : scheduleConversationFollowUps(anchor, config)
    const normalNext = followUps.at(-1) ?? new Date(anchor.getTime() + automaticIntervalMinutes(story, anchor, config) * Time.minute)
    const automation = {
      ...(story.state.automation ?? {}),
      // Follow-ups are the only special post-conversation schedule. Regular
      // 40-minute cadence resumes after the final short pass, not from every
      // incoming message.
      quietUntil: undefined,
      conversationFollowUpAt: followUps.map(value => value.toISOString()),
      conversationFollowUpParticipantId: followUps.length ? participantId || undefined : undefined,
      nextAdvanceAt: normalNext.toISOString(),
    }
    await this.dbSet('interlude_story', { id: story.id }, { state: { ...story.state, automation }, updatedAt: now })
    this.reportOperation('standard', 'info', story, 'conversation-follow-up', '已更新对话后续计划 短期补写=%s 常规推进=%s',
      followUps.length ? followUps.map(value => formatLogTime(value, story.setting.timezone)).join('、') : '无',
      formatLogTime(normalNext, story.setting.timezone))
  }

  private async scheduleNextAutomaticAdvance(storyId: string, now: Date) {
    const config = this.autoAdvanceConfig
    if (!config.enabled) return
    const story = await this.getStory(storyId)
    const intervalMinutes = automaticIntervalMinutes(story, now, config)
    const nextAdvanceAt = new Date(now.getTime() + intervalMinutes * Time.minute)
    const automation = {
      ...(story.state.automation ?? {}),
      quietUntil: undefined,
      conversationFollowUpAt: [],
      conversationFollowUpParticipantId: undefined,
      lastAutoAdvanceAt: now.toISOString(),
      nextAdvanceAt: nextAdvanceAt.toISOString(),
    }
    await this.dbSet('interlude_story', { id: story.id }, { state: { ...story.state, automation }, updatedAt: now })
    this.reportOperation('standard', 'info', story, 'advance', '已设置下次自动推进 时间=%s 间隔=%d分钟', formatLogTime(nextAdvanceAt, story.setting.timezone), intervalMinutes)
  }

  private get sharedStoryConfig(): SharedStoryConfig {
    const { enabled: _legacyEnabled, ...overrides } = this.config.sharedStory ?? {}
    return {
      // Beta2 deliberately keeps the single-story guard hard-enabled. Older
      // builds exposed a rollback switch here, but turning it off could create
      // fresh per-account stories that a later background sweep would revive.
      enabled: true,
      autoEnrollParticipants: true,
      allowCrossConversationMessages: true,
      shareParticipantDetails: false,
      maxCrossConversationActions: 1,
      participantContextLimit: 6,
      managerAccounts: [],
      participantPresets: [],
      ...overrides,
    }
  }

  private mainModelLabel() {
    const providers = configuredProviders(this.config.model)
    const assigned = providers.find(item => item.enabled && item.endpoint && item.model && item.useForMain === true)
    const modelId = effectiveMainModelId(this.config.model)
    const profile = modelId ? this.config.model.models?.find(item => item.enabled !== false && item.id === modelId) : undefined
    const provider = assigned ?? (profile
      ? providers.find(item => item.id === profile.providerId)
      : providers.find(item => item.enabled))
    const providerLabel = provider?.label?.trim() || provider?.id || ''
    const model = assigned?.label?.trim() || assigned?.model || profile?.label?.trim() || profile?.model || provider?.model || '未配置'
    return providerLabel ? `${providerLabel}/${model}` : model
  }

  private participantPreset(userId: string) {
    return (this.sharedStoryConfig.participantPresets ?? []).find(preset =>
      preset.enabled !== false && normalizeAccountId(preset.qq) === normalizeAccountId(userId))
  }

  /** The clean Canon used both by story creation and a full administrative reset. */
  private initialStorySetting(name?: string): StorySetting {
    const setting = emptyStorySetting()
    const defaults = this.config.storyDefaults
    setting.character.name = name?.trim() || defaults.characterName || setting.character.name
    setting.character.profile = defaults.characterProfile
    setting.user.displayName = 'Multiple participants'
    setting.user.profile = defaults.userProfile
    setting.relationship = defaults.relationship
    setting.world = defaults.world
    setting.perspective = clip(defaults.perspective, 1_200)
    setting.supportingCast = defaults.supportingCast
    setting.location = defaults.location
    setting.style = defaults.style || setting.style
    setting.timezone = defaults.timezone || setting.timezone
    return setting
  }

  /** Rebuild per-account relationship baselines and discard evolving state. */
  private async resetParticipantCanon(storyId: string, now: Date) {
    const participants = await this.dbGet('interlude_participant', { storyId })
    for (const participant of participants) {
      const account = this.userAccountRule(participant.userId)
      const preset = this.participantPreset(participant.userId)
      await this.dbSet('interlude_participant', { id: participant.id }, {
        personId: account?.personId?.trim() || preset?.personId?.trim() || participant.personId || participant.userId,
        displayName: account?.label?.trim() || preset?.label?.trim() || participant.displayName || participant.userId,
        profile: account?.profile?.trim() || preset?.profile?.trim() || this.config.storyDefaults.userProfile,
        relationship: account?.relationship?.trim() || preset?.relationship?.trim() || this.config.storyDefaults.relationship,
        state: emptyParticipantState(),
        updatedAt: now,
      })
    }
  }

  private userAccountRule(userId: string) {
    const accounts = this.config.onebot?.userAccounts ?? []
    const normalized = normalizeAccountId(userId)
    return accounts.find(account => account.enabled !== false && normalizeAccountId(account.qq) === normalized)
  }

  private async getParticipant(id: string) {
    return (await this.dbGet('interlude_participant', { id }))[0]
  }

  private async recordIncomingMessage(participant: InterludeParticipant, now: Date) {
    const current = normalizeParticipantState(participant.state)
    const state: ParticipantState = {
      ...current,
      unreadMessageCount: current.unreadMessageCount + 1,
      pendingReplyCount: current.pendingReplyCount + 1,
      lastUserMessageAt: now.toISOString(),
    }
    await this.dbSet('interlude_participant', { id: participant.id }, { state, updatedAt: now })
    return { ...participant, state, updatedAt: now }
  }

  private async markParticipantSeen(participant: InterludeParticipant, now: Date) {
    const current = normalizeParticipantState(participant.state)
    const state: ParticipantState = { ...current, unreadMessageCount: 0 }
    await this.dbSet('interlude_participant', { id: participant.id }, { state, updatedAt: now })
    return { ...participant, state, updatedAt: now }
  }

  private async recordCharacterMessage(participant: InterludeParticipant, now: Date) {
    const current = normalizeParticipantState(participant.state)
    const state: ParticipantState = {
      ...current, unreadMessageCount: 0, pendingReplyCount: 0,
      lastCharacterMessageAt: now.toISOString(),
    }
    await this.dbSet('interlude_participant', { id: participant.id }, { state, updatedAt: now })
    return { ...participant, state, updatedAt: now }
  }

  private async updateParticipantState(participant: InterludeParticipant, patch: Partial<ParticipantState>, now: Date) {
    const state = mergeParticipantState(normalizeParticipantState(participant.state), patch)
    await this.dbSet('interlude_participant', { id: participant.id }, { state, updatedAt: now })
    return { ...participant, state, updatedAt: now }
  }

  /** Converts one old account-bound story into a bot-bound shared story once. */
  private async migrateLegacyStory(legacy: InterludeStory, session: Session) {
    const now = new Date()
    const id = storyIdForCharacter(session.platform, session.selfId)
    const existing = (await this.dbGet('interlude_story', { id }))[0]
    if (existing) {
      await this.migrateLegacyBranchIntoShared(existing, session)
      await this.ensureContinuity(existing, now)
      return existing
    }
    const story: InterludeStory = {
      ...legacy,
      id,
      platform: session.platform,
      selfId: session.selfId,
      userId: '',
      channelId: '',
      state: normalizeStoryState(legacy.state),
      updatedAt: now,
    }
    try {
      await this.dbCreate('interlude_story', story)
    } catch (error) {
      // Concurrent first visits from two legacy accounts can both decide that
      // no shared row exists.  Join the row that won the primary-key race and
      // merge this branch into it instead of leaving an active legacy copy.
      const raced = (await this.dbGet('interlude_story', { id }))[0]
      if (!raced) throw error
      await this.migrateLegacyBranchIntoShared(raced, session)
      await this.ensureContinuity(raced, now)
      return raced
    }
    const participant = await this.ensureParticipant(story, session, now)
    const tables = [
      'interlude_script_entry', 'interlude_memory', 'interlude_intent',
      'interlude_scene', 'interlude_arc', 'interlude_fact', 'interlude_state_patch', 'interlude_overlay_snapshot', 'interlude_web_observation',
    ] as const
    for (const table of tables) await this.dbSet(table, { storyId: legacy.id }, { storyId: story.id } as any)
    // The old story only had one user, so account-bound records can safely be
    // attached to that initial relationship branch during migration.
    for (const table of ['interlude_script_entry', 'interlude_memory', 'interlude_intent', 'interlude_fact', 'interlude_state_patch', 'interlude_overlay_snapshot', 'interlude_web_observation'] as const) {
      await this.dbSet(table, { storyId: story.id }, { participantId: participant.id } as any)
    }
    await this.dbSet('interlude_story', { id: legacy.id }, { status: 'archived', updatedAt: now })
    await this.ensureContinuity(story, now)
    return story
  }

  /**
   * A deployment can contain several old per-account stories. Once the first
   * one created the shared story, fold later legacy branches into it as their
   * users return; otherwise their old active rows would keep being swept in
   * parallel and create a second life for the same character.
   */
  private async migrateLegacyBranchIntoShared(story: InterludeStory, session: Session) {
    const legacyId = legacyStoryIdFor(session.platform, session.selfId, session.userId)
    if (legacyId === story.id) return
    const legacy = (await this.dbGet('interlude_story', { id: legacyId }))[0]
    if (!legacy || legacy.status === 'archived') return
    const now = new Date()
    const participant = await this.ensureParticipant(story, session, now)
    for (const table of ['interlude_script_entry', 'interlude_memory', 'interlude_intent', 'interlude_fact', 'interlude_state_patch', 'interlude_overlay_snapshot', 'interlude_web_observation'] as const) {
      await this.dbSet(table, { storyId: legacy.id }, { storyId: story.id, participantId: participant.id } as any)
    }
    await this.dbSet('interlude_story', { id: legacy.id }, { status: 'archived', updatedAt: now })
    await this.appendEntry(story.id, {
      kind: 'legacy-branch-merged', actor: 'system',
      content: `Earlier account-specific history for ${participant.displayName} was merged into the shared story.`,
      occurredAt: now.toISOString(), metadata: { legacyStoryId: legacy.id },
    }, now, participant.id)
    await this.ensureContinuity(story, now)
  }

  private get memoryConfig(): MemoryConfig {
    // 保持 memory 为可选配置，方便从旧版本配置平滑升级；未填写时使用保守默认值。
    return {
      enabled: true,
      backgroundIntervalMinutes: 10,
      maxStoriesPerCompactionRun: this.config.runtime.maxStoriesPerSweep,
      sceneEntryThreshold: 16,
      sceneCharacterThreshold: 10_000,
      compactionEntryLimit: 80,
      compactionCharacterLimit: 32_000,
      sceneHookCharacters: 2_000,
      sceneSummaryCharacters: 8_000,
      arcSummaryCharacters: 12_000,
      recentEntryLimit: this.config.runtime.contextEntryLimit,
      factLimit: this.config.runtime.memoryLimit,
      factContentCharacters: 4_000,
      factImportanceWeight: 0.5,
      factConfidenceWeight: 0.35,
      factRecencyWeight: 0.15,
      semanticWeight: 0.55,
      unresolvedWeight: 0.2,
      statePatchConfidenceThreshold: 0.82,
      majorStatePatchConfidenceThreshold: 0.95,
      statePatchMinEvidence: 3,
      statePatchMinTurns: 3,
      statePatchMinDays: 2,
      statePatchCooldownHours: 72,
      autoApplyStatePatches: true,
      allowMajorStateChanges: true,
      maxFactsPerStory: 200,
      activeConsequencesEnabled: true,
      activeConsequencePromptLimit: 6,
      activeConsequenceMaxDays: 7,
      activeConsequenceDefaultStrength: 0.55,
      overlayCompressionEnabled: true,
      overlayRecentDays: 2,
      overlayMonthlyAfterDays: 10,
      overlayWeeklyWindowDays: 5,
      overlayMonthlyWindowDays: 10,
      overlayWeeklySummaryCharacters: 1_600,
      overlayMonthlySummaryCharacters: 2_400,
      ...(this.config.memory ?? {}),
    }
  }

  private get browserConfig(): BrowserConfig {
    const merged: BrowserConfig = {
      enabled: false,
      mode: 'deferred-only',
      allowSearch: true,
      allowVisit: true,
      searchUrlTemplate: 'https://html.duckduckgo.com/html/?q={query}',
      allowedDomains: [],
      blockedDomains: [],
      maxConcurrentPages: 1,
      maxResearchPerSweep: 1,
      navigationTimeout: 15_000,
      waitUntil: 'domcontentloaded',
      maxTextCharacters: 12_000,
      maxExcerptCharacters: 3_000,
      maxObservationsInPrompt: 4,
      cacheMinutes: 30,
      allowGroupTriggeredResearch: false,
      logObservationPreview: false,
      ...(this.config.browser ?? {}),
    }
    // Schema defaults cover Console input, but old YAML and programmatic
    // callers can still provide undefined/invalid numeric fields. Normalise
    // here so one malformed browser option cannot silently disable all due
    // research or break the page semaphore.
    return {
      ...merged,
      maxConcurrentPages: Math.max(1, Math.min(4, Number(merged.maxConcurrentPages) || 1)),
      maxResearchPerSweep: Math.max(1, Math.min(20, Number(merged.maxResearchPerSweep) || 1)),
      navigationTimeout: Math.max(1_000, Number(merged.navigationTimeout) || 15_000),
      maxTextCharacters: Math.max(500, Number(merged.maxTextCharacters) || 12_000),
      maxExcerptCharacters: Math.max(200, Number(merged.maxExcerptCharacters) || 3_000),
      maxObservationsInPrompt: Math.max(1, Math.min(20, Number(merged.maxObservationsInPrompt) || 4)),
      cacheMinutes: Math.max(0, Number(merged.cacheMinutes) || 0),
    }
  }

  private async ensureContinuity(story: InterludeStory, now: Date) {
    // 每个故事始终应有一个活动场景和一个活动弧线。旧数据升级或手动关闭场景后，
    // 此方法负责补齐它们，并把 id 缓存在 story.state 供 Console/外部工具查看。
    let arc = await this.activeArc(story.id)
    if (!arc) {
      await this.dbCreate('interlude_arc', {
        storyId: story.id, status: 'active', title: 'Beginning', summary: '', sceneCount: 0,
        createdAt: now, updatedAt: now,
      })
      arc = await this.activeArc(story.id)
    }
    let scene = await this.activeScene(story.id)
    if (!scene) {
      await this.dbCreate('interlude_scene', {
        storyId: story.id, status: 'active', startedAt: now, endedAt: null,
        hook: '', summary: '', entryCount: 0, lastEntryId: null, createdAt: now, updatedAt: now,
      })
      scene = await this.activeScene(story.id)
      if (arc) await this.dbSet('interlude_arc', { id: arc.id }, { sceneCount: arc.sceneCount + 1, updatedAt: now })
    }
    if (arc && scene && (story.state.activeArcId !== arc.id || story.state.activeSceneId !== scene.id)) {
      const state = { ...story.state, activeArcId: arc.id, activeSceneId: scene.id }
      await this.dbSet('interlude_story', { id: story.id }, { state, updatedAt: now })
    }
  }

  private scheduleCompaction(storyId: string) {
    if (!this.memoryConfig.enabled || this.scheduledCompactions.has(storyId)) return
    this.scheduledCompactions.add(storyId)
    this.reportStandaloneOperation('diagnostic', 'debug', '记忆整理已排队 故事=%s', storyId)
    const run = () => {
      if (this.databaseResetting) {
        this.scheduledCompactions.delete(storyId)
        return
      }
      // Let an active or debounced user turn go first. This keeps compaction
      // fully off the latency-sensitive path even during a busy conversation.
      if (this.hasPendingNarrative(storyId)) {
        this.reportStandaloneOperation('diagnostic', 'debug', '记忆整理等待前台回合结束 故事=%s', storyId)
        this.ctx.setTimeout(run, 500)
        return
      }
      void this.serial(storyId, async () => {
        if (this.hasPendingNarrative(storyId)) return
        await this.compactUnlocked(await this.getStory(storyId), new Date(), false)
      }).catch(error => this.reportStandaloneOperation('diagnostic', 'debug', '记忆压缩跳过 错误=%s', error))
        .finally(() => this.scheduledCompactions.delete(storyId))
    }
    run()
  }

  private async compactStories() {
    if (!this.memoryConfig.enabled || this.compactionSweepRunning) return
    this.compactionSweepRunning = true
    try {
      const story = await this.getCanonicalStory()
      if (!story || !this.canHandleStory(story)) return
      this.scheduleFactEmbeddingBackfill(story.id)
      this.scheduleCompaction(story.id)
    } finally {
      this.compactionSweepRunning = false
    }
  }

  private async compactUnlocked(story: InterludeStory, now: Date, force: boolean) {
    await this.ensureContinuity(story, now)
    const overlayCompacted = await this.compactOverlayUnlocked(story, now)
    const scene = await this.activeScene(story.id)
    if (!scene) return overlayCompacted
    // lastEntryId 将场景摘要变成增量检查点：已经压缩过的原文不再重复传给模型。
    const entryFilter: any = { storyId: story.id, occurredAt: { $gte: scene.startedAt } }
    if (scene.lastEntryId != null) entryFilter.id = { $gt: scene.lastEntryId }
    const entries = await this.dbGet('interlude_script_entry', entryFilter, {
      limit: Math.max(this.memoryConfig.compactionEntryLimit * 2, this.memoryConfig.compactionEntryLimit),
      sort: { occurredAt: 'asc' },
    })
    const sceneEntries = limitEntriesByCharacters(entries, this.memoryConfig.compactionCharacterLimit)
    const chars = sceneEntries.reduce((sum, entry) => sum + entry.content.length, 0)
    // 任一阈值达到即可压缩；手动命令可以 force，用于调试或故事阶段转换。
    if (!force && sceneEntries.length < this.memoryConfig.sceneEntryThreshold && chars < this.memoryConfig.sceneCharacterThreshold) {
      this.reportOperation('diagnostic', 'debug', story, 'advance', '记忆整理跳过：未达到阈值 条目=%d/%d 字符=%d/%d', sceneEntries.length, this.memoryConfig.sceneEntryThreshold, chars, this.memoryConfig.sceneCharacterThreshold)
      return overlayCompacted
    }
    const current = await this.getStory(story.id)
    const participants = await this.participants(story.id)
    const visibleCompactionEntries = (this.sharedStoryConfig.shareParticipantDetails
      ? sceneEntries
      : sceneEntries.map(entry => entry.participantId
        ? { ...entry, participantId: '', content: '[participant-specific conversation omitted by privacy setting]' }
        : entry))
      .filter(entry => !!entry.content.trim())
    const visibleCompactionFacts = this.sharedStoryConfig.shareParticipantDetails
      ? await this.facts(story.id, this.memoryConfig.maxFactsPerStory)
      : (await this.facts(story.id, this.memoryConfig.maxFactsPerStory)).filter(fact => !fact.participantId)
    let decision: CompactionDecision = {}
    const startedAt = Date.now()
    this.reportOperation('standard', 'info', story, 'advance', '记忆整理开始 条目=%d 字符=%d 强制=%s', sceneEntries.length, chars, force)
    try {
      decision = await this.compactor.compact({
        story: current, from: scene.startedAt, now, entries: visibleCompactionEntries,
        scene, arc: await this.activeArc(story.id), participants,
        facts: visibleCompactionFacts,
      })
    } catch (error) {
      this.report('warn', story, 'advance', '记忆压缩失败：%s', error)
      return false
    }
    await this.persistCompaction(current, scene, decision, sceneEntries, now)
    this.reportOperation('standard', 'info', story, 'advance', '记忆整理完成 耗时=%dms 剧本条目=%d 长期事实=%d 状态变更=%d', Date.now() - startedAt, sceneEntries.length, decision.facts?.length ?? 0, decision.statePatches?.length ?? 0)
    return true
  }

  /** Older state patches are compacted only by the background maintenance
   * lane. Live turns always retain the last few days as raw detail. */
  private async compactOverlayUnlocked(story: InterludeStory, now: Date) {
    const config = this.memoryConfig
    if (!config.overlayCompressionEnabled) return false
    try {
    const recentCutoff = new Date(now.getTime() - (config.overlayRecentDays ?? 2) * Time.day)
    const monthlyCutoff = new Date(now.getTime() - (config.overlayMonthlyAfterDays ?? 10) * Time.day)
    const applied = await this.dbGet('interlude_state_patch', { storyId: story.id, status: 'applied' }, { sort: { appliedAt: 'asc' } }) as StatePatchProposal[]
    const weekly = applied.filter(patch => (patch.appliedAt ?? patch.createdAt) <= recentCutoff)
    let changed = false
    for (const group of groupOverlayPatches(weekly, config.overlayWeeklyWindowDays ?? 5)) {
      const existing = (await this.dbGet('interlude_overlay_snapshot', {
        storyId: story.id, participantId: group.participantId, target: group.target, tier: 'weekly', periodStart: group.from,
      }))[0] as OverlaySnapshot | undefined
      if (existing) continue
      const participant = group.participantId ? await this.getParticipant(group.participantId) : undefined
      const decision = await this.compactor.compactOverlay({ story, participant, target: group.target, tier: 'weekly', from: group.from, to: group.to, patches: group.patches })
      const summary = clip(decision.summary, config.overlayWeeklySummaryCharacters ?? 1_600)
      if (!summary) continue
      await this.dbCreate('interlude_overlay_snapshot', {
        storyId: story.id, participantId: group.participantId, target: group.target, tier: 'weekly', periodStart: group.from, periodEnd: group.to,
        summary, majorEvents: normalizeMajorEvents(decision.majorEvents, group.patches), sourcePatchIds: group.patches.map(patch => patch.id), status: 'active', createdAt: now, updatedAt: now,
      })
      for (const patch of group.patches) await this.dbSet('interlude_state_patch', { id: patch.id }, { status: 'compacted' })
      changed = true
    }

    const snapshots = await this.dbGet('interlude_overlay_snapshot', { storyId: story.id, tier: 'weekly', status: 'active' }, { sort: { periodEnd: 'asc' } }) as OverlaySnapshot[]
    for (const group of groupOverlaySnapshots(snapshots.filter(snapshot => snapshot.periodEnd <= monthlyCutoff), config.overlayMonthlyWindowDays ?? 10)) {
      const existing = (await this.dbGet('interlude_overlay_snapshot', {
        storyId: story.id, participantId: group.participantId, target: group.target, tier: 'monthly', periodStart: group.from,
      }))[0] as OverlaySnapshot | undefined
      if (existing) continue
      const participant = group.participantId ? await this.getParticipant(group.participantId) : undefined
      const decision = await this.compactor.compactOverlay({ story, participant, target: group.target, tier: 'monthly', from: group.from, to: group.to, patches: [], snapshots: group.snapshots })
      const summary = clip(decision.summary, config.overlayMonthlySummaryCharacters ?? 2_400)
      if (!summary) continue
      await this.dbCreate('interlude_overlay_snapshot', {
        storyId: story.id, participantId: group.participantId, target: group.target, tier: 'monthly', periodStart: group.from, periodEnd: group.to,
        summary, majorEvents: normalizeMajorEvents(decision.majorEvents, [], group.snapshots), sourcePatchIds: group.snapshots.flatMap(snapshot => snapshot.sourcePatchIds), status: 'active', createdAt: now, updatedAt: now,
      })
      for (const snapshot of group.snapshots) await this.dbSet('interlude_overlay_snapshot', { id: snapshot.id }, { status: 'superseded', updatedAt: now })
      changed = true
    }
    if (changed) {
      await this.rebuildLiveOverlayState(story, now)
      this.reportOperation('standard', 'info', story, 'advance', 'Overlay 分层归档完成：最近 %d 天保留原始补丁，短期窗口=%d天，长期窗口=%d天', config.overlayRecentDays ?? 2, config.overlayWeeklyWindowDays ?? 5, config.overlayMonthlyWindowDays ?? 10)
    }
    return changed
    } catch (error) {
      // Overlay maintenance is optional background work. A bad compression
      // response must leave raw patches untouched and never block narration.
      this.reportOperation('standard', 'warn', story, 'advance', 'Overlay 分层归档跳过：%s', error)
      return false
    }
  }

  private async overlaySnapshotsForPrompt(storyId: string, participantId?: string, background = false) {
    if (!this.memoryConfig.overlayCompressionEnabled) return [] as OverlaySnapshot[]
    const rows = await this.dbGet('interlude_overlay_snapshot', { storyId, status: 'active' }, { sort: { periodEnd: 'desc' } }) as OverlaySnapshot[]
    const visible = rows.filter(snapshot => !snapshot.participantId || (background ? this.sharedStoryConfig.shareParticipantDetails : snapshot.participantId === participantId))
    // Current long-term state plus recent short-window deltas is sufficient; older
    // snapshots remain searchable/auditable without permanently taxing prompts.
    const result: OverlaySnapshot[] = []
    for (const target of ['character', 'perspective', 'world', 'relationship'] as const) {
      const matches = visible.filter(snapshot => snapshot.target === target)
      const monthly = matches.find(snapshot => snapshot.tier === 'monthly')
      if (monthly) result.push(monthly)
      result.push(...matches.filter(snapshot => snapshot.tier === 'weekly').slice(0, 4))
    }
    return result
  }

  /** Once a snapshot safely represents older changes, keep state.overlay as
   * the live (uncompacted) delta only. This is what actually reduces prompt
   * size; snapshots carry the older evolution separately. */
  private async rebuildLiveOverlayState(story: InterludeStory, now: Date) {
    const [applied, snapshots] = await Promise.all([
      this.dbGet('interlude_state_patch', { storyId: story.id, status: 'applied' }) as Promise<StatePatchProposal[]>,
      this.dbGet('interlude_overlay_snapshot', { storyId: story.id, status: 'active' }) as Promise<OverlaySnapshot[]>,
    ])
    const overlay = { ...(story.state.settingOverlay ?? {}) }
    const hasGlobalHistory = (target: StatePatchProposal['target']) => snapshots.some(snapshot => snapshot.target === target && !snapshot.participantId)
    if (hasGlobalHistory('character')) {
      overlay.characterProfile = undefined
      overlay.characterTraits = []
      for (const patch of applied.filter(item => !item.participantId && item.target === 'character')) {
        if (patch.path.includes('trait')) overlay.characterTraits.push(clip(patch.proposedValue, 500))
        else overlay.characterProfile = mergeNote(overlay.characterProfile, patch.proposedValue)
      }
      overlay.characterTraits = Array.from(new Set(overlay.characterTraits)).slice(-30)
    }
    if (hasGlobalHistory('perspective')) {
      overlay.perspective = undefined
      for (const patch of applied.filter(item => !item.participantId && item.target === 'perspective')) {
        overlay.perspective = mergeNote(overlay.perspective, patch.proposedValue)
      }
    }
    if (hasGlobalHistory('world')) {
      overlay.world = undefined
      for (const patch of applied.filter(item => !item.participantId && item.target === 'world')) overlay.world = mergeNote(overlay.world, patch.proposedValue)
    }
    if (hasGlobalHistory('relationship')) {
      overlay.relationship = undefined
      for (const patch of applied.filter(item => !item.participantId && item.target === 'relationship')) overlay.relationship = mergeNote(overlay.relationship, patch.proposedValue)
    }
    await this.dbSet('interlude_story', { id: story.id }, { state: { ...story.state, settingOverlay: overlay }, updatedAt: now })

    const participantIds = Array.from(new Set(snapshots.filter(snapshot => snapshot.target === 'relationship' && !!snapshot.participantId).map(snapshot => snapshot.participantId)))
    for (const participantId of participantIds) {
      const participant = await this.getParticipant(participantId)
      if (!participant) continue
      const state = normalizeParticipantState(participant.state)
      state.relationshipOverlay = undefined
      for (const patch of applied.filter(item => item.target === 'relationship' && item.participantId === participantId)) {
        state.relationshipOverlay = mergeNote(state.relationshipOverlay, patch.proposedValue)
      }
      await this.dbSet('interlude_participant', { id: participant.id }, { state, updatedAt: now })
    }
  }

  private async persistCompaction(story: InterludeStory, scene: InterludeScene, decision: CompactionDecision, entries: ScriptEntry[], now: Date) {
    // 摘要更新成功后才移动 lastEntryId，确保失败时原始条目仍会在下次被重新处理。
    const scenePatch = decision.scene ?? {}
    await this.dbSet('interlude_scene', { id: scene.id }, {
      hook: clip(scenePatch.hook ?? scene.hook, this.memoryConfig.sceneHookCharacters),
      summary: clip(scenePatch.summary ?? scene.summary, this.memoryConfig.sceneSummaryCharacters),
      entryCount: 0, lastEntryId: entries.at(-1)?.id ?? scene.lastEntryId, updatedAt: now,
    })
    if (scenePatch.close) {
      await this.dbSet('interlude_scene', { id: scene.id }, { status: 'closed', endedAt: now, updatedAt: now })
      await this.ensureContinuity(story, now)
    }
    const presenceUpdates = normalizeScenePresenceDrafts(scenePatch.presence, entries, now)
    if (presenceUpdates.length) {
      const current = await this.getStory(story.id)
      const state = normalizeStoryState(current.state)
      const byName = new Map(state.scenePresence.map(item => [item.name, item]))
      for (const update of presenceUpdates) byName.set(update.name, update)
      await this.dbSet('interlude_story', { id: current.id }, {
        state: { ...state, scenePresence: [...byName.values()].slice(-8) }, updatedAt: now,
      })
    }
    const arc = await this.activeArc(story.id)
    if (arc && decision.arc) {
      await this.dbSet('interlude_arc', { id: arc.id }, {
        title: clip(decision.arc.title ?? arc.title, 255), summary: clip(decision.arc.summary ?? arc.summary, this.memoryConfig.arcSummaryCharacters), updatedAt: now,
      })
    }
    for (const fact of decision.facts ?? []) {
      if (!hasCompactionEvidence(fact.sourceEntryIds, entries)) continue
      await this.persistFact(story.id, fact, entries, now)
    }
    for (const patch of decision.statePatches ?? []) {
      if (!hasCompactionEvidence(patch.sourceEntryIds, entries)) continue
      await this.persistStatePatch(story, patch, entries, now)
    }
  }

  private async persistFact(storyId: string, draft: { scope: NarrativeFact['scope']; content: string; participantId?: string; importance?: number; confidence?: number; unresolved?: boolean; sourceEntryIds?: number[] }, entries: ScriptEntry[], now: Date) {
    const content = clip(draft.content, this.memoryConfig.factContentCharacters)
    if (!content) return
    const participantId = resolveParticipantId(draft.participantId, draft.sourceEntryIds, entries)
    const existing = await this.dbGet('interlude_fact', { storyId, status: 'active' })
    // 当前先做完全规范化匹配的去重；更复杂的语义去重可在检索层升级时替换。
    const same = existing.find(fact => normalizeFact(fact.content) === normalizeFact(content) && (!fact.participantId || fact.participantId === participantId))
    const sourceEntryIds = (draft.sourceEntryIds ?? []).filter(id => entries.some(entry => entry.id === id)).slice(0, 20)
    // Promise facts are unresolved by default, unless the compactor explicitly
    // says that the promise has already been fulfilled or closed.
    const unresolved = draft.unresolved === true || (draft.unresolved === undefined && draft.scope === 'promise')
    if (same) {
      const embedding = same.embedding?.length ? same.embedding : await this.embedText(content)
      await this.dbSet('interlude_fact', { id: same.id }, {
        importance: Math.max(same.importance, clampNumber(draft.importance, same.importance, 0, 1)),
        confidence: Math.max(same.confidence, clampNumber(draft.confidence, same.confidence, 0, 1)),
        unresolved: same.unresolved || unresolved,
        ...(embedding.length ? { embedding } : {}),
        sourceEntryIds: Array.from(new Set([...same.sourceEntryIds, ...sourceEntryIds])), lastSeenAt: now, updatedAt: now,
      })
      return
    }
    if (existing.length >= this.memoryConfig.maxFactsPerStory) {
      const oldest = existing.sort((a, b) => (a.importance * a.confidence) - (b.importance * b.confidence))[0]
      if (oldest) await this.dbSet('interlude_fact', { id: oldest.id }, { status: 'superseded', updatedAt: now })
    }
    await this.dbCreate('interlude_fact', {
      storyId, participantId, scope: draft.scope, content, importance: clampNumber(draft.importance, 0.5, 0, 1),
      confidence: clampNumber(draft.confidence, 0.5, 0, 1), unresolved,
      embedding: await this.embedText(content), status: 'active', sourceEntryIds,
      lastSeenAt: now, createdAt: now, updatedAt: now,
    })
  }

  private async embedText(value: string) {
    try {
      return await this.embedder.embed(value)
    } catch (error) {
      // Embeddings improve recall but must never make a private-message turn fail.
      this.reportStandaloneOperation('diagnostic', 'debug', 'Embedding 请求跳过 错误=%s', error)
      return []
    }
  }

  private scheduleFactEmbeddingBackfill(storyId: string) {
    const embedding = this.config.model.embedding
    const batchSize = embedding?.backfillBatchSize ?? 5
    if (!embedding?.enabled || !embedding.model?.trim() || batchSize <= 0) return
    if (this.factBackfills.has(storyId)) return
    this.factBackfills.add(storyId)
    // This maintenance task deliberately stays out of the narrative serial queue:
    // it only fills an optional index column and must not delay a new user event.
    void this.backfillFactEmbeddings(storyId, batchSize)
      .catch(error => this.reportStandaloneOperation('diagnostic', 'debug', '长期事实向量补齐跳过 错误=%s', error))
      .finally(() => this.factBackfills.delete(storyId))
  }

  private async backfillFactEmbeddings(storyId: string, batchSize: number) {
    const facts = await this.dbGet('interlude_fact', { storyId, status: 'active' })
    const missing = facts
      .filter(fact => !fact.embedding?.length)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, Math.max(0, batchSize))
    for (const fact of missing) {
      const embedding = await this.embedText(fact.content)
      if (embedding.length) await this.dbSet('interlude_fact', { id: fact.id }, { embedding, updatedAt: new Date() })
    }
  }

  private async persistStatePatch(story: InterludeStory, draft: StatePatchDraft, entries: ScriptEntry[], now: Date) {
    const confidence = clampNumber(draft.confidence, 0, 0, 1)
    const participantId = draft.target === 'perspective' ? '' : resolveParticipantId(draft.participantId, draft.sourceEntryIds, entries)
    const path = clip(draft.path, 255)
    const sourceEntryIds = (draft.sourceEntryIds ?? []).filter(id => entries.some(entry => entry.id === id)).slice(0, 20)
    const proposedValue = clip(draft.proposedValue, 4_000)
    const impact = draft.impact === 'major' ? 'major' : 'minor'
    if (!path || !proposedValue || !sourceEntryIds.length) return

    // Merge repeated proposals for one setting path before evaluating them.
    const candidates = await this.dbGet('interlude_state_patch', {
      storyId: story.id, participantId, target: draft.target, path,
    }) as StatePatchProposal[]
    const matching = candidates.filter(candidate => patchClaimsMatch(candidate.proposedValue, proposedValue))
    if (matching.some(candidate => candidate.status === 'applied' || candidate.status === 'compacted')) return
    const candidate = matching.find(item => item.status === 'proposed')
    const mergedSourceEntryIds = Array.from(new Set([
      ...(candidate?.sourceEntryIds ?? []), ...sourceEntryIds,
    ])).slice(0, 80)
    const sourceRows = await this.dbGet('interlude_script_entry', {
      storyId: story.id, id: { $in: mergedSourceEntryIds },
    }) as ScriptEntry[]
    const evidence = statePatchEvidence(sourceRows, story.setting.timezone)
    const minimumTurns = Math.max(3, this.memoryConfig.statePatchMinTurns ?? this.memoryConfig.statePatchMinEvidence)
    const minimumDays = Math.max(1, this.memoryConfig.statePatchMinDays ?? 2)
    const minimum = impact === 'major' ? this.memoryConfig.majorStatePatchConfidenceThreshold : this.memoryConfig.statePatchConfidenceThreshold
    const mergedConfidence = Math.max(candidate?.confidence ?? 0, confidence)
    const mergedEvidenceText = mergeNote(candidate?.evidence, draft.evidence)
    const proposal = candidate ?? await this.dbCreate('interlude_state_patch', {
      storyId: story.id, participantId, target: draft.target, path, proposedValue,
      evidence: clip(mergedEvidenceText, 4_000), confidence: mergedConfidence, impact,
      status: 'proposed', sourceEntryIds: mergedSourceEntryIds, createdAt: now, appliedAt: null,
    })
    if (candidate?.id) {
      await this.dbSet('interlude_state_patch', { id: candidate.id }, {
        evidence: clip(mergedEvidenceText, 4_000), confidence: mergedConfidence, impact: candidate.impact === 'major' || impact === 'major' ? 'major' : 'minor', sourceEntryIds: mergedSourceEntryIds,
      })
    }

    // Ordinary changes require independent narrative turns on different days.
    if (!this.memoryConfig.autoApplyStatePatches || (impact === 'major' && !this.memoryConfig.allowMajorStateChanges)) return
    const stableEvidence = impact === 'major'
      ? mergedConfidence >= minimum
      : mergedConfidence >= minimum && evidence.turns >= minimumTurns && evidence.days >= minimumDays
    if (!stableEvidence) {
      this.reportOperation('diagnostic', 'debug', story, 'advance',
        'Overlay 候选继续累计 目标=%s/%s 回合=%d/%d 日期=%d/%d', draft.target, path, evidence.turns, minimumTurns, evidence.days, minimumDays)
      return
    }

    const cooldownHours = Math.max(1, this.memoryConfig.statePatchCooldownHours ?? 72)
    const recentApplied = candidates
      .filter(item => item.status === 'applied' || item.status === 'compacted')
      .map(item => item.appliedAt ?? item.createdAt)
      .sort((left, right) => right.getTime() - left.getTime())[0]
    if (recentApplied && now.getTime() - recentApplied.getTime() < cooldownHours * Time.hour) {
      this.reportOperation('diagnostic', 'debug', story, 'advance',
        'Overlay 冷却中，候选保留 目标=%s/%s 冷却=%d小时', draft.target, path, cooldownHours)
      return
    }

    const overlay = { ...(story.state.settingOverlay ?? {}) }
    if (draft.target === 'character') {
      if (draft.path.includes('trait')) overlay.characterTraits = Array.from(new Set([...(overlay.characterTraits ?? []), clip(draft.proposedValue, 500)])).slice(-30)
      else overlay.characterProfile = mergeNote(overlay.characterProfile, draft.proposedValue)
    } else if (draft.target === 'perspective') {
      overlay.perspective = mergeNote(overlay.perspective, clip(draft.proposedValue, 1_000))
    } else if (draft.target === 'relationship' && participantId) {
      const participant = await this.getParticipant(participantId)
      if (participant) {
        const state = normalizeParticipantState(participant.state)
        await this.dbSet('interlude_participant', { id: participant.id }, {
          state: { ...state, relationshipOverlay: mergeNote(state.relationshipOverlay, draft.proposedValue) }, updatedAt: now,
        })
      }
    } else if (draft.target === 'relationship') overlay.relationship = mergeNote(overlay.relationship, draft.proposedValue)
    else overlay.world = mergeNote(overlay.world, draft.proposedValue)
    if (draft.target !== 'relationship' || !participantId) {
      const state = { ...story.state, settingOverlay: overlay }
      await this.dbSet('interlude_story', { id: story.id }, { state, updatedAt: now })
    }
    if (proposal?.id) await this.dbSet('interlude_state_patch', { id: proposal.id }, { status: 'applied', appliedAt: now })
  }

  private report(level: 'error' | 'warn' | 'info' | 'debug', story: InterludeStory, phase: NarrativeRequest['phase'], message: string, ...args: unknown[]) {
    this.writeReport(level, story, phase, message, args)
  }

  /** Emit an operational record only when the selected verbosity includes it.
   * Summary is for outcomes, standard is for scheduler/model activity, and
   * diagnostic is for skip reasons and internal counters. */
  private reportOperation(verbosity: 'summary' | 'standard' | 'diagnostic', level: 'error' | 'warn' | 'info' | 'debug', story: InterludeStory, phase: NarrativeRequest['phase'], message: string, ...args: unknown[]) {
    if (!this.allowsVerbosity(verbosity)) return
    this.writeReport(level, story, phase, message, args)
  }

  private writeReport(level: 'error' | 'warn' | 'info' | 'debug', story: InterludeStory, phase: NarrativeRequest['phase'], message: string, args: unknown[]) {
    if (this.blindModeConfig.enabled) {
      if (level === 'error' || level === 'warn') this.blindModeHealthIssue = true
      return
    }
    const rank = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }
    const logging = this.config.logging ?? { level: 'info' as const, format: 'layered' as const, colors: true, colorTheme: 'dark' as const, kaomoji: true, logScriptPreview: false, previewLength: 500 }
    if (rank[logging.level] < rank[level]) return
    const rendered = renderLogMessage(message, args)
    const storyDetail = (logging.verbosity ?? 'standard') === 'diagnostic' ? ` 故事=${story.id}` : ''
    const output = logging.format === 'layered'
      ? formatLayeredLog({
        level, phase, protagonist: story.setting.character.name, message, args,
        colors: logging.colors !== false, colorTheme: logging.colorTheme ?? 'dark', kaomoji: logging.kaomoji !== false,
      })
      : logging.format === 'compact'
        ? `[${phaseLabel(phase)}] ${story.setting.character.name} ${rendered}${storyDetail}`
        : `[${phaseLabel(phase)}] ${story.setting.character.name}\n事件：${rendered}${storyDetail}`
    this.emitLog(level, output)
  }

  private reportStandalone(level: 'error' | 'warn' | 'info' | 'debug', message: string, ...args: unknown[]) {
    this.writeStandalone(level, message, args)
  }

  private reportStandaloneOperation(verbosity: 'summary' | 'standard' | 'diagnostic', level: 'error' | 'warn' | 'info' | 'debug', message: string, ...args: unknown[]) {
    if (!this.allowsVerbosity(verbosity)) return
    this.writeStandalone(level, message, args)
  }

  private writeStandalone(level: 'error' | 'warn' | 'info' | 'debug', message: string, args: unknown[]) {
    if (this.blindModeConfig.enabled) {
      if (level === 'error' || level === 'warn') this.blindModeHealthIssue = true
      return
    }
    const rank = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }
    const logging = this.config.logging ?? { level: 'info' as const, format: 'layered' as const, colors: true, colorTheme: 'dark' as const, kaomoji: true }
    if (rank[logging.level] < rank[level]) return
    const output = logging.format === 'layered'
      ? formatLayeredLog({
        level, protagonist: 'HDSI', message, args, standalone: true,
        colors: logging.colors !== false, colorTheme: logging.colorTheme ?? 'dark', kaomoji: logging.kaomoji !== false,
      })
      : `[系统] ${renderLogMessage(message, args)}`
    this.emitLog(level, output)
  }

  private emitLog(level: 'error' | 'warn' | 'info' | 'debug', output: string) {
    if (level === 'error') this.serviceLogger.error(output)
    else if (level === 'warn') this.serviceLogger.warn(output)
    else if (level === 'info') this.serviceLogger.info(output)
    else this.serviceLogger.debug(output)
  }

  private reportBlindModeHealth() {
    const status = this.blindModeHealthIssue || this.databaseResetting ? '需关注' : '正常'
    const scheduler = this.backgroundStarted ? '运行中' : '未就绪'
    // This is the sole HDSI record emitted in Blind Mode. It deliberately
    // carries no story, account, model, message, or failure-detail content.
    this.serviceLogger.info(`[失明模式] 运行状态=${status} 后台任务=${scheduler}`)
    this.blindModeHealthIssue = false
  }

  private allowsVerbosity(required: 'summary' | 'standard' | 'diagnostic') {
    const rank = { summary: 1, standard: 2, diagnostic: 3 }
    const configured = this.config.logging?.verbosity ?? 'standard'
    return rank[configured] >= rank[required]
  }

  private async getStory(id: string) {
    const story = (await this.dbGet('interlude_story', { id }))[0]
    if (!story) throw new Error(`Interlude story not found: ${id}`)
    return story
  }

  private serial<T>(id: string, task: () => Promise<T>) {
    // catch 保证前一次失败不会永久堵住同一故事；finally 语义通过 then 的两个分支释放队列。
    const previous = this.queues.get(id) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(task)
    this.queues.set(id, current)
    void current.then(
      () => { if (this.queues.get(id) === current) this.queues.delete(id) },
      () => { if (this.queues.get(id) === current) this.queues.delete(id) },
    )
    return current
  }

  private dbWrite<T>(task: () => Promise<T>) {
    const run = this.databaseWriteQueue.then(() => this.retryDbWrite(task), () => this.retryDbWrite(task))
    this.databaseWriteQueue = run.catch(() => undefined)
    return run
  }

  /**
   * A SQLite/sql.js read can fail during the same short filesystem hiccup as a
   * write. Reads stay concurrent for normal performance; only transient driver
   * errors receive a small bounded retry instead of aborting a user turn.
   */
  private async dbRead<T>(task: () => Promise<T>) {
    const delays = [50, 125, 250]
    for (let attempt = 0; ; attempt++) {
      try {
        return await task()
      } catch (error) {
        if (attempt >= delays.length || !isTransientDatabaseError(error)) {
          if (isTransientDatabaseError(error)) {
            this.reportStandalone('warn', 'SQLite 读取连续失败，已停止重试 错误=%s', error)
          }
          throw error
        }
        const delay = delays[attempt] + Math.floor(Math.random() * 25)
        this.reportStandaloneOperation('diagnostic', 'debug', 'SQLite 读取暂时失败，准备重试 等待=%dms 次数=%d 错误=%s', delay, attempt + 1, error)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  private dbGet(table: string, query: unknown, options?: unknown): Promise<any[]> {
    return this.dbRead(async () => {
      const rows = await this.ctx.database.get(table as never, query as never, options as never) as any[]
      return rows.map(row => normalizeDatabaseRow(table, row))
    })
  }

  private async retryDbWrite<T>(task: () => Promise<T>) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await task()
      } catch (error) {
        // sql.js/SQLite may briefly report disk I/O or locking errors while
        // Koishi flushes its in-memory database. A short retry is useful, but
        // logging every transient attempt as a warning makes normal file
        // flush contention look like a fatal HDSI failure. Keep the retry
        // bounded, add a little jitter, and only warn on the final failure.
        if (attempt >= 7 || !isTransientDatabaseError(error)) {
          if (isTransientDatabaseError(error)) {
            this.reportStandalone('warn', 'SQLite 写入连续失败，已停止重试 错误=%s', error)
          }
          throw error
        }
        const delays = [100, 250, 500, 1_000, 2_000, 3_000, 5_000]
        const baseDelay = delays[attempt] ?? 5_000
        const delay = baseDelay + Math.floor(Math.random() * Math.min(250, baseDelay / 4))
        this.reportStandaloneOperation('diagnostic', 'debug', 'SQLite 写入暂时失败，准备重试 等待=%dms 次数=%d 错误=%s', delay, attempt + 1, error)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  private dbCreate(table: string, data: unknown): Promise<any> {
    return this.dbWrite(async () => {
      try {
        return await this.ctx.database.create(table as never, data as never)
      } catch (error) {
        // sql.js can report disk I/O after SQLite has already committed an
        // INSERT. Before retrying, look for the same logical row; this keeps a
        // transient flush error from creating duplicate split-message intents,
        // script entries, or memories.
        if (!isTransientDatabaseError(error)) throw error
        const existing = await this.findPossiblyCommittedCreate(table, data)
        if (existing) return existing
        throw error
      }
    })
  }

  private async findPossiblyCommittedCreate(table: string, data: unknown) {
    if (!isRecord(data)) return undefined
    const storyId = typeof data.storyId === 'string' ? data.storyId : ''
    if (!storyId) return undefined
    const rows = await this.dbGet(table, { storyId }, { limit: 100 })
    return rows.find(row => {
      if (table === 'interlude_intent') {
        return row.participantId === data.participantId
          && row.type === data.type
          && row.summary === data.summary
          && sameTimestamp(row.notBefore, data.notBefore)
          && JSON.stringify(row.payload ?? {}) === JSON.stringify(data.payload ?? {})
      }
      if (table === 'interlude_script_entry') {
        return row.participantId === data.participantId
          && row.kind === data.kind
          && row.actor === data.actor
          && row.content === data.content
          && sameTimestamp(row.occurredAt, data.occurredAt)
      }
      if (table === 'interlude_memory') {
        return row.participantId === data.participantId
          && row.category === data.category
          && row.content === data.content
          && sameTimestamp(row.createdAt, data.createdAt)
      }
      return typeof data.id === 'string' && row.id === data.id
    })
  }

  private dbSet(table: string, query: unknown, data: unknown): Promise<any> {
    return this.dbWrite(() => this.ctx.database.set(table as never, query as never, data as never))
  }

  private dbRemove(table: string, query: unknown): Promise<any> {
    return this.dbWrite(() => this.ctx.database.remove(table as never, query as never))
  }

  /**
   * SQLite/sql.js may fail physical DELETE when its backing file is locked.
   * Fall back to redaction so an administrative purge still completes and the
   * removed content is no longer exposed to prompts or management commands.
   */
  private async purgeTable(table: string, query: unknown, fallback: unknown) {
    try {
      await this.dbRemove(table, query)
    } catch (error) {
      this.reportStandalone('warn', 'SQLite 物理删除失败，改用逻辑删除 表=%s 错误=%s', table, error)
      await this.dbSet(table, query, fallback)
    }
  }
}

function storyIdForCharacter(platform: string, selfId: string) { return `character:${platform}:${selfId}` }

function legacyStoryIdFor(platform: string, selfId: string, userId: string) { return `${platform}:${selfId}:${userId}` }

function participantIdFor(platform: string, selfId: string, userId: string) { return `${platform}:${selfId}:${userId}` }

function participantIdForStory(storyId: string, platform: string, selfId: string, userId: string) {
  return `${participantIdFor(platform, selfId, userId)}:${storyId}`.slice(0, 255)
}

function sameParticipantEndpoint(participant: InterludeParticipant, session: Session) {
  const onebotPair = isOneBotPlatform(participant.platform) && isOneBotPlatform(session.platform)
  return (participant.platform === session.platform || onebotPair)
    && normalizeAccountId(participant.selfId) === normalizeAccountId(session.selfId)
    && normalizeAccountId(participant.userId) === normalizeAccountId(session.userId)
}

function isOneBotPlatform(platform: string | undefined) {
  const value = String(platform ?? '').toLowerCase()
  return value === 'onebot'
    || value.startsWith('onebot:')
    || value === 'napcat'
    || value.startsWith('napcat:')
    || value === 'qq:onebot'
    || value.startsWith('qq:onebot:')
}

function extractSessionImageSources(session: Session) {
  const raw = String(session.content ?? '')
  const sources: string[] = []
  const add = (value: unknown, kind: 'url' | 'file' | 'adapter-url' = 'url') => {
    const source = String(value ?? '').trim()
    if (!source || sources.includes(source)) return
    if (source.length > 8 * 1024 * 1024) return
    if (/^https?:\/\//i.test(source)) sources.push(kind === 'adapter-url' ? `onebot-url:${source}` : source)
    else if (/^data:image\//i.test(source)) sources.push(source)
    else if (kind === 'file') sources.push(`onebot-file:${source}`)
  }
  const visit = (element: any) => {
    if (!element) return
    const type = String(element.type ?? '').toLowerCase()
    if (type === 'img' || type === 'image') {
      const src = element.attrs?.src ?? element.attrs?.url ?? element.data?.src ?? element.data?.url
      if (src) add(src)
      else add(element.attrs?.file ?? element.data?.file, 'file')
    }
    for (const child of element.children ?? []) visit(child)
  }
  // Session.elements is adapter-owned and can be reused or enriched by other
  // middleware. Parse this message's raw content only, otherwise an old image
  // element may be accidentally attached to a later text-only turn.
  try { for (const element of h.parse(raw) as any[]) visit(element) } catch {}
  if (!sources.length) {
    const pattern = /<(?:img|image)\b[^>]*(?:src|url)=["']([^"']+)["'][^>]*>/gi
    for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) add(match[1])
  }
  // OneBot/NapCat may leave a CQ image segment in the raw message instead of
  // converting it to an HTML image element. Prefer its CDN URL; if only the
  // file token is present, keep that token so the current bot can call
  // get_image(file) without trusting arbitrary user URLs.
  const cqPattern = /\[CQ:image,([^\]]+)\]/gi
  for (let match = cqPattern.exec(raw); match; match = cqPattern.exec(raw)) {
    const fields: Record<string, string> = {}
    for (const part of match[1].split(',')) {
      const index = part.indexOf('=')
      if (index > 0) fields[part.slice(0, index).trim().toLowerCase()] = part.slice(index + 1).trim()
    }
    add(fields.url || fields.cache_url, 'adapter-url')
    if (!fields.url && !fields.cache_url) add(fields.file, 'file')
  }
  return sources
}

/** Detect record/audio segments from both Koishi elements and raw OneBot CQ
 * fallback without retaining the binary voice payload. */
export function extractSessionVoiceCount(session: Pick<Session, 'content'>) {
  const raw = String(session.content ?? '')
  let count = 0
  const visit = (element: any) => {
    if (!element) return
    const type = String(element.type ?? '').toLowerCase()
    if (type === 'audio' || type === 'record') count++
    for (const child of element.children ?? []) visit(child)
  }
  try { for (const element of h.parse(raw) as any[]) visit(element) } catch {}
  if (count) return count
  return (raw.match(/\[CQ:record,[^\]]*\]/gi) ?? []).length
}

/** Voice and typed text share one user event. The explicit marker lets the
 * narrator distinguish recognized speech from ordinary typed text. */
export function mergeUserMessageWithVoiceTranscripts(text: string, transcripts: string[], detected = 0) {
  const parts = [clip(text, 8_000)]
  for (const [index, transcript] of transcripts.slice(0, 1).entries()) {
    const value = clip(transcript, 4_000)
    if (value) parts.push(`[用户语音转写 ${index + 1}]\n${value}`)
  }
  if (detected > 0 && transcripts.length === 0) parts.push('[用户发送了一段语音；未能转写其内容。]')
  return parts.filter(Boolean).join('\n\n') || '[用户发送了一个非文本消息。]'
}

function oneBotMessageId(value: unknown): string | number | undefined {
  const text = String(value ?? '').trim()
  if (!text || !/^-?\d+$/.test(text)) return undefined
  const number = Number(text)
  return Number.isSafeInteger(number) ? number : text
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

function guessImageMime(bytes: Buffer, hinted?: unknown) {
  const hint = String(hinted ?? '').toLowerCase()
  if (hint.startsWith('image/')) return hint
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString() === 'GIF87a' || bytes.subarray(0, 6).toString() === 'GIF89a')) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  return ''
}

function isAnimatedImageMime(mime: string) {
  return mime === 'image/gif' || mime === 'image/webp' || mime === 'image/apng'
}

function sessionGroupId(session: Session) {
  const raw = String((session as any).guildId || session.channelId || '')
  return normalizeGroupId(raw)
}

function normalizeGroupId(value: string) {
  return String(value || '').trim().replace(/^(?:group|guild):/i, '')
}

const CHAT_REACTION_NAMES: ChatReactionName[] = ['like', 'smile', 'laugh', 'heart', 'surprised', 'sad', 'angry']

const QQ_REACTION_IDS: Record<ChatReactionName, string> = {
  like: '76', smile: '14', laugh: '182', heart: '66', surprised: '0', sad: '5', angry: '106',
}

const NATIVE_FACE_SEMANTICS: NativeFaceSemantic[] = ['smile', 'laugh', 'sweat', 'awkward', 'heart', 'surprised', 'sad', 'angry']
const QQ_NATIVE_FACE_IDS: Record<NativeFaceSemantic, string> = {
  smile: '14', laugh: '182', sweat: '27', awkward: '111', heart: '66', surprised: '0', sad: '5', angry: '106',
}

function normalizeAllowedNativeFaces(value: unknown): NativeFaceSemantic[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.filter((item): item is NativeFaceSemantic => NATIVE_FACE_SEMANTICS.includes(item as NativeFaceSemantic)))).slice(0, NATIVE_FACE_SEMANTICS.length)
}

function normalizeExpressionThreshold(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0.7
}

/**
 * A model's willingness is an intent estimate, not a transport permission.
 * Native faces need a visible-text counterpart so a model cannot turn every
 * routine reply into a face merely by returning willingness=1. The 0.90 cap
 * deliberately makes thresholds above 0.90 an effective near-disable mode.
 */
export function calibratedNativeFaceWillingness(semantic: NativeFaceSemantic, willingness: unknown, replyContent: unknown) {
  const text = String(replyContent ?? '').replace(/<sep\/>/g, ' ').trim()
  if (!text) return 0
  const patterns: Record<NativeFaceSemantic, RegExp> = {
    smile: /(?:微笑|开心|高兴|谢谢|好耶|好呀|可以|行吧|嘿|哈哈)/i,
    laugh: /(?:哈{2,}|笑死|好笑|乐|绷不住|蚌埠|草|救命)/i,
    sweat: /(?:流汗|尴尬|无语|服了|麻了|救命|离谱|完了|累|忙|不知道怎么说)/i,
    awkward: /(?:尴尬|那个|呃|emm|……|\.{3,}|我真的|怎么说呢)/i,
    heart: /(?:喜欢|爱你|抱抱|可爱|谢谢|好耶|开心|高兴)/i,
    surprised: /(?:不会吧|真的假的|居然|什么|怎么会|\?{1,}|？{1,}|!{1,}|！{1,})/i,
    sad: /(?:难过|哭|委屈|可怜|遗憾|心疼|唉)/i,
    angry: /(?:生气|气死|烦|闭嘴|别[再乱闹说]|离谱|过分|你.*(?:啊|吧|？|!|！))/i,
  }
  const semanticMatch = patterns[semantic].test(text)
  const evidence = semanticMatch ? 0.9 : 0.2
  return Math.min(0.9, normalizeExpressionThreshold(willingness) * (0.25 + evidence * 0.75))
}

function targetableMessageId(value: unknown) {
  const id = String(value ?? '').trim()
  return /^-?\d+$/.test(id) && id !== '0' ? id : undefined
}

function groupMessageRef(entryId: number) {
  return `msg-${Math.max(0, Math.floor(entryId))}`
}

async function listStickerFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 3) return
    let entries: Awaited<ReturnType<typeof readdir>>
    try { entries = await readdir(directory, { withFileTypes: true }) as any } catch { return }
    for (const entry of entries as any[]) {
      const full = resolve(directory, entry.name)
      if (entry.isDirectory()) await visit(full, depth + 1)
      else if (entry.isFile() && /\.(?:png|jpe?g|webp|gif)$/i.test(entry.name)) files.push(full)
    }
  }
  await visit(root, 0)
  return files.sort()
}

function stickerMime(filePath: string) {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.gif') return 'image/gif'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  return 'image/png'
}

export function describeQuotedMessage(session: Session, characterName = '主角'): QuotedMessageContext | undefined {
  const quote = session.quote as any
  if (!quote) return undefined
  const content = normalizeQuotedMessageContent(quote.content)
  if (!content) return undefined
  const senderId = String(quote.user?.id ?? '').trim()
  const isCharacter = !!senderId && senderId === String(session.selfId ?? '')
  const senderName = isCharacter
    ? String(characterName || '主角').trim() || '主角'
    : normalizeGroupDisplayName(quote.member?.nick, quote.member?.name, quote.user?.nick, quote.user?.name, senderId) || '未知发送者'
  const speaker = isCharacter
    ? `主角「${senderName}」`
    : senderId
      ? `消息发送者「${senderName}」（ID：${senderId}）`
      : `消息发送者「${senderName}」`
  return { senderId, senderName, speaker, content }
}

export function normalizeQuotedMessageContent(value: unknown) {
  const raw = normalizeQQNativeFaceSegments(value)
  const content = raw
    .replace(/<(?:img|image)\b[^>]*\/?>(?:<\/(?:img|image)>)?/gi, '[图片]')
    .replace(/<(?:audio|record)\b[^>]*\/?>(?:<\/(?:audio|record)>)?/gi, '[语音]')
    .replace(/<video\b[^>]*\/?>(?:<\/video>)?/gi, '[视频]')
    .replace(/<(?:face|mface)\b[^>]*\/?>(?:<\/(?:face|mface)>)?/gi, '[表情]')
    .replace(/<at\b[^>]*(?:name|id)=["']?([^\s"'>]+)[^>]*\/?>(?:<\/at>)?/gi, '[@$1]')
    .replace(/\[CQ:image,[^\]]*\]/gi, '[图片]')
    .replace(/\[CQ:record,[^\]]*\]/gi, '[语音]')
    .replace(/\[CQ:video,[^\]]*\]/gi, '[视频]')
    .replace(/\[CQ:face,[^\]]*\]/gi, '[表情]')
    .replace(/<[^>]+>/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return clip(content, 1_500)
}

function normalizeQuotedMessageContext(value: unknown): QuotedMessageContext | undefined {
  if (!isRecord(value)) return undefined
  const content = normalizeQuotedMessageContent(value.content)
  if (!content) return undefined
  const senderId = clip(String(value.senderId ?? ''), 127)
  const senderName = clip(String(value.senderName ?? ''), 255) || '未知发送者'
  const speaker = clip(String(value.speaker ?? ''), 500) || (senderId ? `消息发送者「${senderName}」（ID：${senderId}）` : `消息发送者「${senderName}」`)
  return { senderId, senderName, speaker, content }
}

export function normalizeAllowedReactions(value: unknown): ChatReactionName[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.filter((item): item is ChatReactionName => CHAT_REACTION_NAMES.includes(item as ChatReactionName)))).slice(0, CHAT_REACTION_NAMES.length)
}

export function normalizeGroupChatActions(
  decision: NarrativeDecision,
  capabilities: ChatActionCapabilities | undefined,
  context: GroupContext,
): ExecutableGroupChatActions {
  if (!capabilities) return { reactions: [] }
  const targets = new Map(context.messages
    .filter(message => !!message.messageRef && !!message.messageId)
    .map(message => [message.messageRef!, message.messageId!]))

  const rawReplyTo = decision.groupReply?.mode === 'immediate'
    ? decision.groupReply.replyTo
    : decision.interaction?.reply.mode === 'immediate'
      ? decision.interaction.reply.replyTo
      : undefined
  const replyMessageId = capabilities.quoteReply && typeof rawReplyTo === 'string' ? targets.get(rawReplyTo) : undefined
  const replyTo = replyMessageId ? { messageRef: rawReplyTo!, messageId: replyMessageId } : undefined

  const allowed = new Set(capabilities.reactions)
  const reactions = Array.isArray(decision.messageReactions)
    ? decision.messageReactions
      .filter(item => isRecord(item) && typeof item.messageRef === 'string' && typeof item.reaction === 'string')
      .map(item => ({
        messageRef: String(item.messageRef),
        reaction: String(item.reaction) as ChatReactionName,
        messageId: targets.get(String(item.messageRef)) ?? '',
      }))
      .filter(item => !!item.messageId && allowed.has(item.reaction))
      .slice(0, 1)
    : []
  return { ...(replyTo ? { replyTo } : {}), reactions }
}

export function formatGroupSpeaker(senderName: string, senderId: string) {
  const id = String(senderId || 'unknown').trim() || 'unknown'
  const name = String(senderName || '').replace(/[\r\n]/g, ' ').trim() || id
  return name === id ? `群成员（QQ：${id}）` : `群成员「${name}」（QQ：${id}）`
}

function normalizeGroupDisplayName(...candidates: unknown[]) {
  for (const candidate of candidates) {
    const name = String(candidate ?? '').replace(/[\r\n]/g, ' ').trim()
    if (name) return name.slice(0, 80)
  }
  return ''
}

function mentionsBot(session: Session) {
  const selfId = normalizeAccountId(session.selfId)
  const content = String(session.content || '')
  if (!selfId) return false
  return content.includes(selfId) || new RegExp(`<at[^>]+id=["']?${selfId}["']?`, 'i').test(content)
}

export function normalizeGroupVisibleReply(raw: NarrativeDecision['groupReply'], interaction: NarrativeDecision['interaction'], maxCharacters: number) {
  return normalizeGroupReply(raw, maxCharacters) || normalizeGroupInteractionReply(interaction, maxCharacters)
}

function requiresVisibleReplyRecovery(phase: NarrativeRequest['phase'], groupContext: GroupContext | undefined, decision: NarrativeDecision) {
  if (phase !== 'user-message') return false
  return groupContext ? !hasStructuredGroupReply(decision) : !hasStructuredInteraction(decision.interaction)
}

export function visibleReplyMode(decision: NarrativeDecision, phase: NarrativeRequest['phase'], groupContext?: GroupContext) {
  if (phase === 'advance') {
    if (decision.crossConversationActions?.some(action => action.mode === 'immediate')) return '主动联系'
    if (decision.crossConversationActions?.some(action => action.mode === 'delayed')) return '计划联系'
    return '无可见投递'
  }
  if (phase === 'conversation-follow-up' || phase === 'intent-due') {
    if (hasStructuredInteraction(decision.interaction)) return decision.interaction!.reply.mode
    if (decision.crossConversationActions?.some(action => action.mode === 'immediate')) return '主动联系'
    return '无可见投递'
  }
  if (!groupContext) return hasStructuredInteraction(decision.interaction) ? decision.interaction!.reply.mode : '未提供或无效'
  if (hasStructuredGroupReplyField(decision.groupReply)) return `group:${decision.groupReply!.mode}`
  if (hasStructuredInteraction(decision.interaction)) return `group-fallback:${decision.interaction!.reply.mode}`
  return '未提供或无效'
}

function hasStructuredGroupReply(decision: NarrativeDecision) {
  return hasStructuredGroupReplyField(decision.groupReply) || hasStructuredInteraction(decision.interaction)
}

function hasStructuredGroupReplyField(value: unknown) {
  if (!isRecord(value) || (value.mode !== 'none' && value.mode !== 'immediate')) return false
  return value.mode === 'none' || typeof value.content === 'string' && !!value.content.trim()
}

function hasStructuredInteraction(value: unknown) {
  if (!isRecord(value) || typeof value.seen !== 'boolean' || !isRecord(value.reply)) return false
  const mode = value.reply.mode
  if (mode !== 'none' && mode !== 'immediate' && mode !== 'delayed') return false
  if (mode === 'none') return true
  if (typeof value.reply.content !== 'string' || !value.reply.content.trim()) return false
  return mode === 'immediate' || typeof value.reply.sendAt === 'string' && !!value.reply.sendAt.trim()
}

function normalizeGroupReply(raw: NarrativeDecision['groupReply'], maxCharacters: number) {
  if (!raw || raw.mode !== 'immediate') return ''
  return normalizeVisibleMessageContent(raw.content, maxCharacters)
}

function normalizeGroupInteractionReply(raw: NarrativeDecision['interaction'], maxCharacters: number) {
  if (!raw || raw.reply.mode !== 'immediate') return ''
  return normalizeVisibleMessageContent(raw.reply.content, maxCharacters)
}

function normalizeVisibleMessageContent(value: unknown, maxCharacters: number) {
  return String(value ?? '')
    .replace(/[\[【](?:表情包?|图片|动图|GIF)[\]】]/gi, '')
    .replace(/[\[【](?:流汗|微笑|笑哭|尴尬|爱心|惊讶|流泪|委屈)[\]】]/gi, '')
    .trim()
    .slice(0, Math.max(1, maxCharacters))
}

function literalQuoteText(value: unknown) {
  const match = /^\s*[「\[]引用[:：]\s*(.*?)\s*[」\]]\s*$/.exec(String(value ?? ''))
  return match?.[1]?.trim() || ''
}

function isLiteralQuoteOnly(value: unknown) {
  return !!literalQuoteText(value)
}


/** Treat OneBot transport aliases as one administrator-facing platform family. */
function samePlatformFamily(left: string | undefined, right: string | undefined) {
  if (isOneBotPlatform(left) && isOneBotPlatform(right)) return true
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase()
}

/** Normalize transport-qualified QQ ids such as private:123 or onebot:123. */
function normalizeAccountId(value: unknown) {
  let normalized = String(value ?? '').trim().toLowerCase()
  for (let index = 0; index < 3; index++) {
    const next = normalized.replace(/^(?:private|user|onebot|napcat|qq):/i, '').trim()
    if (next === normalized) break
    normalized = next
  }
  return normalized
}

function signedNumber(value: number) {
  return `${value > 0 ? '+' : ''}${Number.isInteger(value) ? value : value.toFixed(2)}`
}

function quotesBot(session: Session) {
  return String((session as any).quote?.user?.id ?? '') === String(session.selfId ?? '')
}

function isTransientDatabaseError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /disk\s*i\/o|database is locked|busy|unable to open/i.test(message)
}

function isEnabledAccount(accounts: OneBotAccountRule[] | undefined, qq: string) {
  const normalized = normalizeAccountId(qq)
  if (!normalized) return false
  return (accounts ?? []).some(account => account.enabled !== false && normalizeAccountId(account.qq) === normalized)
}

export function hasRequiredNarrativeScript(value: NarrativeDecision | undefined | null) {
  return typeof value?.script === 'string' && value.script.trim().length > 0
}

export function resolveBlindModeConfig(value?: Partial<BlindModeConfig>): BlindModeConfig {
  return {
    enabled: value?.enabled === true,
    healthReportMinutes: Math.max(1, Math.min(1_440, Math.floor(value?.healthReportMinutes ?? 10))),
  }
}

/** @deprecated Renamed to resolveBlindModeConfig. */
export const resolveBlackBoxConfig = resolveBlindModeConfig

function isAutomaticNarrativePhase(phase: NarrativeRequest['phase']) {
  return phase === 'advance' || phase === 'conversation-follow-up'
}

function normalizeAutomaticDeliverySummary(value: unknown) {
  return typeof value === 'string' ? clip(value, 240).trim() : ''
}

function normalizeFollowUpSummary(value: unknown) {
  return typeof value === 'string' ? clip(value, 360).trim().replace(/\s+/g, ' ').toLowerCase() : ''
}

function followUpExpiresAt(value: unknown, now: Date) {
  const requested = toDate(value)
  const maximum = new Date(now.getTime() + 24 * Time.hour)
  if (!requested || requested <= now) return maximum
  return requested < maximum ? requested : maximum
}

function normalizeFollowUpCommitment(value: unknown, now: Date): FollowUpCommitmentDraft | undefined {
  if (!isRecord(value)) return undefined
  const kind = value.kind === 'thinking' || value.kind === 'checking' || value.kind === 'decision' || value.kind === 'emotional-settle'
    ? value.kind
    : undefined
  const summary = typeof value.summary === 'string' ? clip(value.summary, 360).trim() : ''
  const notBefore = toDate(value.notBefore)
  if (!kind || !summary || !notBefore || notBefore.getTime() - now.getTime() < 5 * Time.minute || notBefore.getTime() - now.getTime() > 12 * Time.hour) return undefined
  const sourceEntryIds = Array.isArray(value.sourceEntryIds)
    ? value.sourceEntryIds.filter(id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0).slice(0, 4)
    : []
  const expiresAt = toDate(value.expiresAt)
  return {
    kind, summary, notBefore: notBefore.toISOString(),
    ...(expiresAt && expiresAt > notBefore ? { expiresAt: expiresAt.toISOString() } : {}),
    ...(sourceEntryIds.length ? { sourceEntryIds } : {}),
  }
}

function inferredFollowUpCommitment(content: string, now: Date): FollowUpCommitmentDraft {
  return {
    kind: 'thinking', summary: clip(`The character promised to return after thinking: ${content}`, 360),
    notBefore: new Date(now.getTime() + 20 * Time.minute).toISOString(),
  }
}

function interactionPromisesFollowUp(content: unknown) {
  if (typeof content !== 'string') return false
  return /我(?:先)?想想|我去(?:想想|看看|查查|确认)|晚点(?:回|说|告诉)|之后(?:回|说|告诉)|等我.{0,12}(?:回|说|告诉)|整理.{0,12}(?:回|说|告诉)/.test(content)
}

function normalizeFollowUpResolutions(value: unknown): FollowUpResolutionDraft[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item)
      && typeof item.id === 'number' && Number.isInteger(item.id) && item.id > 0
      && (item.outcome === 'fulfilled' || item.outcome === 'rescheduled' || item.outcome === 'cancelled'))
    .map(item => ({
      id: item.id as number,
      outcome: item.outcome as FollowUpResolutionDraft['outcome'],
      ...(typeof item.notBefore === 'string' ? { notBefore: item.notBefore } : {}),
    }))
    .slice(0, 2)
}

function automaticDeliveryFromPayload(value: unknown): OutgoingMessageDraft['automaticDelivery'] | undefined {
  const record = isRecord(value) && isRecord(value.automaticDelivery) ? value.automaticDelivery : undefined
  const summary = normalizeAutomaticDeliverySummary(record?.summary)
  const sourceEntryId = typeof record?.sourceEntryId === 'number' && Number.isSafeInteger(record.sourceEntryId)
    ? record.sourceEntryId
    : undefined
  return summary ? { summary, ...(sourceEntryId ? { sourceEntryId } : {}) } : undefined
}

function mergeDeliverySummary(left: string, right: string) {
  if (!left || left === right || left.includes(right)) return left || right
  if (right.includes(left)) return right
  return clip(`${left}；${right}`, 240)
}

function normalizeAutomaticDeliverySummaries(value: unknown): AutomaticDeliverySummary[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const normalized: AutomaticDeliverySummary[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const participantId = typeof item.participantId === 'string' ? clip(item.participantId, 255) : ''
    const summary = normalizeAutomaticDeliverySummary(item.summary)
    const deliveredAt = typeof item.deliveredAt === 'string' && !Number.isNaN(new Date(item.deliveredAt).getTime())
      ? item.deliveredAt
      : ''
    const sourceEntryId = typeof item.sourceEntryId === 'number' && Number.isSafeInteger(item.sourceEntryId)
      ? item.sourceEntryId
      : undefined
    const key = `${participantId}|${sourceEntryId ?? 0}|${summary}`
    if (!participantId || !summary || !deliveredAt || seen.has(key)) continue
    seen.add(key)
    normalized.push({ participantId, summary, ...(sourceEntryId ? { sourceEntryId } : {}), deliveredAt })
  }
  return normalized.slice(-6)
}

function normalizeScenePresenceState(value: unknown): ScenePresenceState[] {
  if (!Array.isArray(value)) return []
  const latest = new Map<string, ScenePresenceState>()
  for (const item of value) {
    if (!isRecord(item)) continue
    const name = typeof item.name === 'string' ? clip(item.name, 80).trim() : ''
    const status = item.status === 'present' || item.status === 'off-scene' || item.status === 'expected'
      ? item.status
      : undefined
    const basis = typeof item.basis === 'string' ? clip(item.basis, 300).trim() : ''
    const sourceEntryIds = Array.isArray(item.sourceEntryIds)
      ? item.sourceEntryIds.filter(id => typeof id === 'number' && Number.isSafeInteger(id)).slice(0, 8)
      : []
    const updatedAt = typeof item.updatedAt === 'string' && !Number.isNaN(new Date(item.updatedAt).getTime())
      ? item.updatedAt
      : ''
    if (!name || !status || !basis || !sourceEntryIds.length || !updatedAt) continue
    latest.set(name, { name, status, basis, sourceEntryIds, updatedAt })
  }
  return [...latest.values()].slice(-8)
}

/** Scene compaction may update a tiny roster only with explicit observed
 * evidence. This keeps named supporting cast available without treating them
 * as automatically present. */
export function normalizeScenePresenceDrafts(value: unknown, entries: ScriptEntry[], now = new Date()): ScenePresenceState[] {
  if (!Array.isArray(value)) return []
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const next: ScenePresenceState[] = []
  for (const item of value as ScenePresenceDraft[]) {
    if (!isRecord(item)) continue
    const name = typeof item.name === 'string' ? clip(item.name, 80).trim() : ''
    const status = item.status === 'present' || item.status === 'off-scene' || item.status === 'expected'
      ? item.status
      : undefined
    const basis = typeof item.basis === 'string' ? clip(item.basis, 300).trim() : ''
    const sourceEntryIds = Array.isArray(item.sourceEntryIds)
      ? item.sourceEntryIds.filter(id => typeof id === 'number' && byId.has(id)).slice(0, 8)
      : []
    const evidence = sourceEntryIds.map(id => byId.get(id)!).filter(entry => entry.content.includes(name))
    if (!name || !status || !basis || !evidence.length || !hasExplicitPresenceEvidence(status, evidence)) continue
    next.push({ name, status, basis, sourceEntryIds, updatedAt: now.toISOString() })
  }
  return normalizeScenePresenceState(next)
}

function hasExplicitPresenceEvidence(status: ScenePresenceState['status'], entries: ScriptEntry[]) {
  const text = entries.map(entry => entry.content).join('\n')
  if (status === 'off-scene') return /告别|道别|分别|先走|离开|离去|回家|回去了|独自|分开|告辞/.test(text)
  if (status === 'expected') return /约好|约在|等会|稍后|会来|准备来|约见/.test(text)
  return /一起|同行|身边|来到|抵达|进入|走进|拉着|坐在|站在|陪着/.test(text)
}

function normalizeDecision(raw: NarrativeDecision, from: Date, now: Date, permitMessages: boolean, runtime: RuntimeConfig, shared: SharedStoryConfig, currentParticipantId: string, permittedParticipantIds: Set<string>, phase: NarrativeRequest['phase'] = 'advance', memory?: MemoryConfig, refreshContinuity = false) {
  const script = typeof raw?.script === 'string'
    ? raw.script.trim().slice(0, runtime.maxScriptCharacters)
    : ''
  // The only channel for a private reply is interaction. Automatic life
  // passes have no live participant event, so they cannot emit it at all.
  const interaction = phase === 'advance' ? undefined : normalizeInteraction(raw?.interaction, now, runtime)
  // Optional memories are model suggestions, not a source of truth.  Never
  // let a model turn an invented online contact into durable retrieval data.
  const memories = Array.isArray(raw?.memories)
    ? raw.memories.filter(validMemory).map(memory => ({ ...memory, participantId: permittedOrGlobal(memory.participantId, currentParticipantId, permittedParticipantIds) }))
    : []
  const intents = Array.isArray(raw?.intents) ? raw.intents
    .filter(intent => !isRecord(intent) || intent.type !== 'follow-up-commitment')
    .filter(intent => validIntent(intent, from, now, memory))
    .map(intent => ({ ...intent, participantId: permittedOrGlobal(intent.participantId, currentParticipantId, permittedParticipantIds) }))
    .slice(0, 8)
    : []
  const intentUpdates = normalizeIntentUpdates(raw?.intentUpdates)
  const browserIntents = Array.isArray(raw?.browserIntents)
    ? raw.browserIntents.map(normalizeBrowserIntentDraftLoose).filter((intent): intent is BrowserIntentDraft => !!intent).slice(0, 1)
    : []
  const proactive = phase === 'advance'
  const agencyGatedProactive = proactive && !isRecord(raw?.proactiveContact)
  const crossConversationActions = permitMessages && shared.allowCrossConversationMessages && Array.isArray(raw?.crossConversationActions)
    ? raw.crossConversationActions
      .map(action => normalizeConversationAction(action, runtime, permittedParticipantIds, currentParticipantId, now, agencyGatedProactive))
      .filter((action): action is NonNullable<ReturnType<typeof normalizeConversationAction>> => !!action)
      .slice(0, Math.max(0, shared.maxCrossConversationActions))
    : []
  const statePatch = isRecord(raw?.statePatch) ? pickParticipantStatePatch(raw.statePatch) : undefined
  const continuity = refreshContinuity ? normalizeContinuitySnapshot(raw?.continuity) : undefined
  const alter = normalizeAlterValue(raw?.alter)
  const automaticDeliverySummary = isAutomaticNarrativePhase(phase)
    ? normalizeAutomaticDeliverySummary(raw?.automaticDeliverySummary) || undefined
    : undefined
  const followUpCommitment = phase === 'user-message' ? normalizeFollowUpCommitment(raw?.followUpCommitment, now) : undefined
  const followUpResolutions = phase === 'user-message' || phase === 'intent-due'
    ? normalizeFollowUpResolutions(raw?.followUpResolutions)
    : []
  const agencyWindow = isRecord(raw?.agencyWindow) ? raw.agencyWindow : undefined
  const proactiveContact = isRecord(raw?.proactiveContact) ? raw.proactiveContact : undefined
  return { script, alter, agencyWindow, proactiveContact, interaction, automaticDeliverySummary, followUpCommitment, followUpResolutions, continuity, memories, intents, intentUpdates, browserIntents, statePatch, crossConversationActions }
}

function normalizeContinuitySnapshot(value: unknown): ContinuitySnapshot | undefined {
  if (!isRecord(value)) return undefined
  const text = (item: unknown, limit: number) => typeof item === 'string' ? clip(item, limit).trim() : ''
  const list = (item: unknown, limit: number) => Array.isArray(item)
    ? item.map(value => text(value, limit)).filter(Boolean).slice(0, 5)
    : []
  const current = text(value.current, 500)
  const next = list(value.next, 300).slice(0, 3)
  const recent = list(value.recent, 300)
  const salient = list(value.salient, 400)
  if (!current && !next.length && !recent.length && !salient.length) return undefined
  return { current, next, recent, salient }
}

function normalizeBrowserIntentDraftLoose(value: unknown): BrowserIntentDraft | undefined {
  if (!isRecord(value) || (value.mode !== 'search' && value.mode !== 'visit') || typeof value.purpose !== 'string') return undefined
  const query = typeof value.query === 'string' ? clip(value.query, 500) : ''
  const url = typeof value.url === 'string' ? clip(value.url, 2_000) : ''
  if (value.mode === 'search' && !query) return undefined
  if (value.mode === 'visit' && !url) return undefined
  return {
    mode: value.mode,
    ...(query ? { query } : {}), ...(url ? { url } : {}),
    purpose: clip(value.purpose, 500),
    timing: value.timing === 'immediate' ? 'immediate' : 'deferred',
    ...(typeof value.participantId === 'string' ? { participantId: value.participantId.trim() } : {}),
  }
}

function normalizeBrowserIntentDraft(draft: BrowserIntentDraft, config: BrowserConfig): BrowserIntentDraft | undefined {
  const normalized = normalizeBrowserIntentDraftLoose(draft)
  if (!normalized) return undefined
  if (normalized.mode === 'search' && !config.allowSearch) return undefined
  if (normalized.mode === 'visit' && !config.allowVisit) return undefined
  return normalized
}

function browserIntentFromPayload(payload: Record<string, unknown>): BrowserIntentDraft | null {
  return normalizeBrowserIntentDraftLoose({
    mode: payload?.mode,
    query: payload?.query,
    url: payload?.url,
    purpose: payload?.purpose || 'The character planned to read a public web page.',
    timing: 'deferred',
  }) ?? null
}

function resolveBrowserTarget(draft: BrowserIntentDraft, config: BrowserConfig) {
  if (draft.mode === 'search') {
    const template = config.searchUrlTemplate?.trim()
    if (!template || !template.includes('{query}')) return undefined
    const target = template.replaceAll('{query}', encodeURIComponent(draft.query ?? ''))
    return isSafePublicWebUrl(target, config) ? target : undefined
  }
  return draft.url && isSafePublicWebUrl(draft.url, config) ? draft.url : undefined
}

function isSafePublicWebUrl(value: string, config: BrowserConfig) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    if (url.username || url.password) return false
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host === '::1') return false
    if (isPrivateHost(host)) return false
    const blocked = normalizeDomains(config.blockedDomains)
    const allowed = normalizeDomains(config.allowedDomains)
    if (blocked.some(domain => domainMatches(host, domain))) return false
    return !allowed.length || allowed.some(domain => domainMatches(host, domain))
  } catch {
    return false
  }
}

function normalizeDomains(values: string[] | undefined) {
  return (values ?? []).map(value => String(value ?? '').trim().toLowerCase().replace(/^\.+|\.+$/g, '')).filter(Boolean)
}

function domainMatches(host: string, domain: string) { return host === domain || host.endsWith(`.${domain}`) }

function isPrivateHost(host: string) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
  }
  // Literal IPv6 and IPv4-mapped addresses are not needed for public-web
  // narration and are safest treated as local/private destinations.
  return host.includes(':')
}

function webObservationEntryContent(observation: WebObservation) {
  if (observation.status === 'success') {
    const source = observation.title || observation.url || 'a public web page'
    // The full bounded excerpt is supplied through webContext. Keeping it out
    // of the ordinary script stream avoids duplicating tokens and prevents
    // page text from being mistaken for a first-party narrative instruction.
    return `The character read a public web page: ${source}.`
  }
  return `The character's attempted web lookup did not complete: ${clip(observation.summary, 800)}`
}

function normalizeInteraction(value: unknown, now: Date, runtime: RuntimeConfig): NarrativeInteraction | undefined {
  if (!isRecord(value) || typeof value.seen !== 'boolean' || !isRecord(value.reply)) return undefined
  const mode = value.reply.mode
  if (mode !== 'none' && mode !== 'immediate' && mode !== 'delayed') return undefined
  const content = typeof value.reply.content === 'string' ? normalizeVisibleMessageContent(value.reply.content, runtime.maxMessageCharacters) : undefined
  const sendAt = toDate(value.reply.sendAt)

  if (!value.seen) return { seen: false, reply: { mode: 'none' } }
  if (mode === 'none') return { seen: true, reply: { mode: 'none' } }
  if (!content) return { seen: true, reply: { mode: 'none' } }
  if (mode === 'immediate') return { seen: true, reply: { mode, content } }
  const delay = sendAt?.getTime() - now.getTime()
  if (!sendAt || delay < runtime.minimumDelayedReplySeconds * 1_000 || delay > runtime.maximumDelayedReplyMinutes * Time.minute) return { seen: true, reply: { mode: 'none' } }
  return { seen: true, reply: { mode, content, sendAt: sendAt.toISOString() } }
}

function validMemory(value: unknown): value is MemoryDraft {
  return isRecord(value) && typeof value.category === 'string' && typeof value.content === 'string' && !!value.content.trim()
}

function validIntent(value: unknown, from: Date, now: Date, memory?: MemoryConfig): value is IntentDraft {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.summary !== 'string') return false
  const notBefore = toDate(value.notBefore)
  if (!notBefore) return false
  if (!isActiveConsequenceDraft(value)) return notBefore > now
  const expiresAt = consequenceExpiresAt(value.payload)
  const payload = value.payload
  const effect = isRecord(payload) && typeof payload.effect === 'string' ? payload.effect.trim() : ''
  const strength = isRecord(payload) ? payload.strength : undefined
  // Consequences are intentionally short-to-medium-lived story pressure,
  // not a backdoor for permanently rewriting canon. Keep the source time
  // close to this writing turn and cap their natural lifetime at 30 days.
  const maximumLifetime = Math.max(1, memory?.activeConsequenceMaxDays ?? 7) * Time.day
  return !!memory?.activeConsequencesEnabled && !!effect
    && (strength === undefined || typeof strength === 'number' && Number.isFinite(strength) && strength >= 0 && strength <= 1)
    && notBefore <= now && notBefore >= from
    && !!expiresAt && expiresAt > now && expiresAt.getTime() - now.getTime() <= maximumLifetime
}

type NormalizedIntentUpdate = { id: number; status: 'completed' | 'cancelled'; resolution?: string }

function normalizeIntentUpdates(value: unknown): NormalizedIntentUpdate[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item) && Number.isInteger(item.id) && Number(item.id) > 0 && (item.status === 'completed' || item.status === 'cancelled'))
    .map(item => ({
      id: Number(item.id), status: item.status as 'completed' | 'cancelled',
      ...(typeof item.resolution === 'string' && item.resolution.trim() ? { resolution: clip(item.resolution, 1_000) } : {}),
    }))
    .slice(0, 8)
}

function isActiveConsequence(intent: NarrativeIntent) {
  return intent.type === 'active-consequence' && isRecord(intent.payload) && intent.payload.lifecycle === 'active'
}

function isActiveConsequenceDraft(intent: Pick<IntentDraft, 'type' | 'payload'> | Record<string, unknown>) {
  return intent.type === 'active-consequence' && isRecord(intent.payload) && intent.payload.lifecycle === 'active'
}

function consequenceExpiresAt(payload: unknown) {
  if (!isRecord(payload)) return undefined
  return toDate(payload.expiresAt)
}

function consequenceStrength(payload: unknown, fallback = 0.55) {
  return clampNumber(isRecord(payload) ? payload.strength : undefined, fallback, 0, 1)
}

function hasCompactionEvidence(sourceEntryIds: number[] | undefined, entries: ScriptEntry[]) {
  if (!Array.isArray(sourceEntryIds) || sourceEntryIds.length === 0) return false
  const ids = new Set(entries.map(entry => entry.id))
  return sourceEntryIds.some(id => ids.has(id))
}

function normalizeConversationAction(value: unknown, runtime: RuntimeConfig, permittedParticipantIds: Set<string>, currentParticipantId: string, now = new Date(), proactive = false) {
  if (!isRecord(value) || typeof value.participantId !== 'string' || !value.participantId || value.participantId === currentParticipantId) return undefined
  if (!permittedParticipantIds.has(value.participantId) || (value.mode !== 'immediate' && value.mode !== 'delayed')) return undefined
  const content = typeof value.content === 'string' ? value.content.trim().slice(0, runtime.maxMessageCharacters) : ''
  if (!content) return undefined
  const willingness = typeof value.willingness === 'number' && Number.isFinite(value.willingness)
    ? clampNumber(value.willingness, 0, 0, 1)
    : undefined
  if (proactive && (willingness === undefined || willingness < (runtime.proactiveWillingnessThreshold ?? 0.65))) return undefined
  const reason = typeof value.reason === 'string' ? clip(value.reason, 300) : undefined
  if (value.mode === 'immediate') return { participantId: value.participantId, mode: value.mode, content, ...(willingness === undefined ? {} : { willingness }), ...(reason ? { reason } : {}) }
  const sendAt = toDate(value.sendAt)
  const delay = sendAt?.getTime() - now.getTime()
  if (!sendAt || delay < runtime.minimumDelayedReplySeconds * 1_000 || delay > runtime.maximumDelayedReplyMinutes * Time.minute) return undefined
  return { participantId: value.participantId, mode: value.mode, content, sendAt: sendAt.toISOString(), ...(willingness === undefined ? {} : { willingness }), ...(reason ? { reason } : {}) }
}

function permittedOrGlobal(value: unknown, fallback: string, permittedParticipantIds: Set<string>) {
  const candidate = typeof value === 'string' ? value.trim() : ''
  if (candidate && permittedParticipantIds.has(candidate)) return candidate
  return fallback && permittedParticipantIds.has(fallback) ? fallback : ''
}

function pickParticipantStatePatch(value: Record<string, unknown>): Partial<ParticipantState> {
  const patch: Partial<ParticipantState> = {}
  if (Array.isArray(value.openThreads) && value.openThreads.every(item => typeof item === 'string')) patch.openThreads = value.openThreads.map(item => clip(item, 500)).slice(0, 50)
  if (Array.isArray(value.relationshipNotes) && value.relationshipNotes.every(item => typeof item === 'string')) patch.relationshipNotes = value.relationshipNotes.map(item => clip(item, 500)).slice(0, 50)
  return patch
}

function mergeSetting(base: StorySetting, patch: Partial<StorySetting>): StorySetting {
  return { ...base, ...patch, character: { ...base.character, ...patch.character }, user: { ...base.user, ...patch.user } }
}

function mergeParticipantState(base: ParticipantState, patch: Partial<ParticipantState>): ParticipantState {
  return {
    ...base, ...patch,
    openThreads: Array.isArray(patch.openThreads) ? patch.openThreads : base.openThreads,
    relationshipNotes: Array.isArray(patch.relationshipNotes) ? patch.relationshipNotes : base.relationshipNotes,
  }
}

function normalizeParticipantState(value: unknown): ParticipantState {
  const record = isRecord(value) ? value : {}
  return {
    openThreads: Array.isArray(record.openThreads) ? record.openThreads.filter(item => typeof item === 'string').map(item => clip(item, 500)).slice(0, 50) : [],
    relationshipNotes: Array.isArray(record.relationshipNotes) ? record.relationshipNotes.filter(item => typeof item === 'string').map(item => clip(item, 500)).slice(0, 50) : [],
    relationshipOverlay: typeof record.relationshipOverlay === 'string' ? clip(record.relationshipOverlay, 4_000) : undefined,
    unreadMessageCount: Math.max(0, Math.floor(typeof record.unreadMessageCount === 'number' ? record.unreadMessageCount : 0)),
    pendingReplyCount: Math.max(0, Math.floor(typeof record.pendingReplyCount === 'number' ? record.pendingReplyCount : 0)),
    lastUserMessageAt: typeof record.lastUserMessageAt === 'string' ? record.lastUserMessageAt : undefined,
    lastCharacterMessageAt: typeof record.lastCharacterMessageAt === 'string' ? record.lastCharacterMessageAt : undefined,
  }
}

function normalizeStoryState(value: unknown): StoryState {
  const record = isRecord(value) ? value : {}
  const overlay = isRecord(record.settingOverlay) ? record.settingOverlay : {}
  const automation = isRecord(record.automation) ? record.automation : {}
  const continuity = isRecord(record.continuitySnapshot) ? normalizeContinuitySnapshot(record.continuitySnapshot) : undefined
  return {
    settingOverlay: {
      characterProfile: typeof overlay.characterProfile === 'string' ? overlay.characterProfile : undefined,
      perspective: typeof overlay.perspective === 'string' ? clip(overlay.perspective, 1_000) : undefined,
      relationship: typeof overlay.relationship === 'string' ? overlay.relationship : undefined,
      world: typeof overlay.world === 'string' ? overlay.world : undefined,
      supportingCast: typeof overlay.supportingCast === 'string' ? overlay.supportingCast : undefined,
      location: typeof overlay.location === 'string' ? overlay.location : undefined,
      characterTraits: Array.isArray(overlay.characterTraits) ? overlay.characterTraits.filter(item => typeof item === 'string') : [],
    },
    activeSceneId: typeof record.activeSceneId === 'number' ? record.activeSceneId : undefined,
    activeArcId: typeof record.activeArcId === 'number' ? record.activeArcId : undefined,
    continuitySnapshot: continuity,
    narrativeUpdateCount: Math.max(0, Math.floor(typeof record.narrativeUpdateCount === 'number' ? record.narrativeUpdateCount : 0)),
    lastContinuityUpdateAt: typeof record.lastContinuityUpdateAt === 'string' ? record.lastContinuityUpdateAt : undefined,
    alterSystem: normalizeAlterSystemState(record.alterSystem),
    agencyWindow: normalizeAgencyWindowState(record.agencyWindow),
    scenePresence: normalizeScenePresenceState(record.scenePresence),
    automaticDeliverySummaries: normalizeAutomaticDeliverySummaries(record.automaticDeliverySummaries),
    automation: {
      quietUntil: typeof automation.quietUntil === 'string' ? automation.quietUntil : undefined,
      nextAdvanceAt: typeof automation.nextAdvanceAt === 'string' ? automation.nextAdvanceAt : undefined,
      lastAutoAdvanceAt: typeof automation.lastAutoAdvanceAt === 'string' ? automation.lastAutoAdvanceAt : undefined,
      lastUserMessageAt: typeof automation.lastUserMessageAt === 'string' ? automation.lastUserMessageAt : undefined,
      conversationFollowUpAt: Array.isArray(automation.conversationFollowUpAt)
        ? automation.conversationFollowUpAt.filter(item => typeof item === 'string').slice(0, 8)
        : [],
      conversationFollowUpParticipantId: typeof automation.conversationFollowUpParticipantId === 'string'
        ? clip(automation.conversationFollowUpParticipantId, 255)
        : undefined,
    },
  }
}

function participantRelevance(participant: InterludeParticipant) {
  const state = normalizeParticipantState(participant.state)
  const pending = state.pendingReplyCount * 2 + state.unreadMessageCount
  const last = toDate(state.lastUserMessageAt)?.getTime() ?? participant.updatedAt.getTime()
  return pending * 1_000_000_000 + last
}

/** Keeps a single due-turn private to one relationship while ensuring that
 * every plan that was already due at the start of the sweep gets a chance to
 * be judged before the next sweep interval. */
export function groupDueIntents(intents: NarrativeIntent[]) {
  const batches = new Map<string, NarrativeIntent[]>()
  for (const intent of [...intents].sort((left, right) => left.notBefore.getTime() - right.notBefore.getTime() || left.id - right.id)) {
    const family = intent.type === 'proactive-check' ? 'agency' : 'normal'
    const key = `${intent.participantId || '__global__'}|${family}`
    const batch = batches.get(key) ?? []
    batch.push(intent)
    batches.set(key, batch)
  }
  return [...batches.values()]
}

function resolveParticipantId(explicit: string | undefined, sourceEntryIds: number[] | undefined, entries: ScriptEntry[]) {
  if (explicit?.trim()) return explicit.trim()
  const ids = (sourceEntryIds ?? []).map(id => entries.find(entry => entry.id === id)?.participantId).filter(Boolean)
  return ids[0] ?? ''
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }

export function shouldSupersedeNarrativeRequest(
  inFlightRequestId: number | undefined,
  firstMessageCommittedRequestId: number | undefined,
  obsoleteRequestIds: ReadonlySet<number>,
) {
  return !!inFlightRequestId
    && firstMessageCommittedRequestId !== inFlightRequestId
    && !obsoleteRequestIds.has(inFlightRequestId)
}

function toDate(value: unknown) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

const DATABASE_DATE_FIELDS: Record<string, string[]> = {
  interlude_story: ['cursorAt', 'createdAt', 'updatedAt'],
  interlude_participant: ['createdAt', 'updatedAt'],
  interlude_script_entry: ['occurredAt', 'createdAt'],
  interlude_memory: ['createdAt', 'updatedAt'],
  interlude_intent: ['notBefore', 'createdAt', 'updatedAt'],
  interlude_scene: ['startedAt', 'endedAt', 'createdAt', 'updatedAt'],
  interlude_arc: ['createdAt', 'updatedAt'],
  interlude_fact: ['lastSeenAt', 'createdAt', 'updatedAt'],
  interlude_state_patch: ['createdAt', 'appliedAt'],
  interlude_overlay_snapshot: ['periodStart', 'periodEnd', 'createdAt', 'updatedAt'],
  interlude_sticker: ['createdAt', 'updatedAt'],
  interlude_web_observation: ['accessedAt', 'createdAt'],
}

/** Minato normally materializes timestamp columns as Date objects. Some
 * drivers and hot-reload paths can return ISO strings, so normalize every row
 * crossing the service boundary before time arithmetic or prompt building. */
export function normalizeDatabaseRow(table: string, value: unknown): any {
  if (!isRecord(value)) return value
  const row: Record<string, unknown> = { ...value }
  for (const field of DATABASE_DATE_FIELDS[table] ?? []) {
    if (row[field] === null || row[field] === undefined) continue
    row[field] = toDate(row[field])
  }
  if (table === 'interlude_story') {
    const createdAt = toDate(row.createdAt) ?? new Date()
    const updatedAt = toDate(row.updatedAt) ?? createdAt
    row.createdAt = createdAt
    row.updatedAt = updatedAt
    row.cursorAt = toDate(row.cursorAt) ?? updatedAt
    row.state = normalizeStoryState(row.state)
  } else if (table === 'interlude_participant') {
    row.createdAt = toDate(row.createdAt) ?? new Date()
    row.updatedAt = toDate(row.updatedAt) ?? row.createdAt
    row.state = normalizeParticipantState(row.state)
  }
  return row
}

function sameTimestamp(left: unknown, right: unknown) {
  const a = toDate(left)
  const b = toDate(right)
  return !!a && !!b && Math.abs(a.getTime() - b.getTime()) < 2_000
}

/** A corrupted/future cursor must never make the narrator "fill in" time
 * backwards. Clamp only the prompt interval; normal successful persistence
 * still advances the stored cursor to the actual wall-clock time. */
function narrativeCursor(story: InterludeStory, now: Date) {
  const cursor = toDate(story.cursorAt) ?? now
  return cursor > now ? now : cursor
}

function clip(value: unknown, length: number) { return typeof value === 'string' ? value.trim().slice(0, length) : '' }

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

function normalizeFact(value: string) { return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ') }

function limitEntriesByCharacters(entries: ScriptEntry[], limit: number) {
  if (limit <= 0) return []
  let used = 0
  const selected: ScriptEntry[] = []
  // 从最新条目向前保留，保证压缩请求优先看到场景接续点。
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (selected.length && used + entry.content.length > limit) break
    selected.unshift(entry)
    used += entry.content.length
  }
  return selected
}

function factScore(fact: NarrativeFact, config: MemoryConfig, queryEmbedding: number[] = []) {
  const ageDays = Math.max(0, (Date.now() - fact.lastSeenAt.getTime()) / (24 * Time.hour))
  const recency = Math.exp(-ageDays / 30)
  const similarity = cosineSimilarity(queryEmbedding, fact.embedding ?? [])
  // Negative similarity is treated as no semantic support. This prevents an
  // unrelated fact from receiving a half-score merely because cosine values
  // mathematically range from -1 to 1.
  const semantic = similarity == null ? 0 : Math.max(0, similarity)
  return fact.importance * config.factImportanceWeight
    + fact.confidence * config.factConfidenceWeight
    + recency * config.factRecencyWeight
    + semantic * config.semanticWeight
    + (fact.unresolved ? 1 : 0) * config.unresolvedWeight
}

function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) return undefined
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index]
    leftMagnitude += left[index] * left[index]
    rightMagnitude += right[index] * right[index]
  }
  if (!leftMagnitude || !rightMagnitude) return undefined
  return dot / Math.sqrt(leftMagnitude * rightMagnitude)
}

function createFactQuery(participant: InterludeParticipant | null, userMessage: string | undefined, dueIntents: NarrativeIntent[], supersededIntents: NarrativeIntent[]) {
  const state = participant ? normalizeParticipantState(participant.state) : undefined
  return [
    userMessage ? `Current user message: ${userMessage}` : '',
    ...(state?.openThreads ?? []).map(thread => `Open thread: ${thread}`),
    ...(state?.relationshipNotes ?? []).map(note => `Relationship note: ${note}`),
    ...dueIntents.map(intent => `Due intent: ${intent.summary}`),
    ...supersededIntents.map(intent => `Superseded plan: ${intent.summary}`),
  ].filter(Boolean).join('\n')
}

function formatBufferedUserMessages(messages: BufferedUserMessage[]) {
  if (messages.length === 1) return messages[0].content
  return messages.map((message, index) => {
    const time = message.occurredAt.toISOString()
    return `[连续消息 ${index + 1}，收到时间 ${time}]\n${message.content}`
  }).join('\n\n')
}

function automaticIntervalMinutes(story: InterludeStory, now: Date, config: AutoAdvanceConfig) {
  const restWindow = activeRestWindow(config.restWindows, story.setting.timezone, now)
  if (restWindow) return randomInteger(restWindow.minIntervalMinutes, restWindow.maxIntervalMinutes)
  return Math.max(1, config.intervalMinutes + randomInteger(-config.jitterMinutes, config.jitterMinutes))
}

function normalizeFollowUpMinutes(values: number[] | undefined) {
  const defaults = [10, 20]
  const normalized = (Array.isArray(values) ? values : defaults)
    .map(value => Math.floor(Number(value)))
    .filter(value => Number.isFinite(value) && value >= 1 && value <= 240)
  return Array.from(new Set(normalized)).sort((left, right) => left - right).slice(0, 6)
}

function scheduleConversationFollowUps(anchor: Date, config: AutoAdvanceConfig) {
  let previous = anchor.getTime()
  return config.followUpMinutes.map(minutes => {
    const jitter = config.followUpJitterMinutes
      ? randomInteger(-config.followUpJitterMinutes, config.followUpJitterMinutes)
      : 0
    // Never place a later configured pass before an earlier one, even when
    // jitter is enabled or the owner provides a close custom sequence.
    const at = Math.max(previous + 1_000, anchor.getTime() + Math.max(1, minutes + jitter) * Time.minute)
    previous = at
    return new Date(at)
  })
}

function activeRestWindow(windows: RestWindow[], timezone: string, now: Date) {
  const localMinutes = localClockMinutes(now, timezone)
  return windows.find(window => {
    if (!window.enabled) return false
    const start = clockMinutes(window.start)
    const end = clockMinutes(window.end)
    if (start == null || end == null) return false
    return start <= end
      ? localMinutes >= start && localMinutes < end
      : localMinutes >= start || localMinutes < end
  })
}

function clockMinutes(value: string) {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(value?.trim())
  if (!matched) return undefined
  const hour = Number(matched[1])
  const minute = Number(matched[2])
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? hour * 60 + minute : undefined
}

function randomInteger(min: number, max: number) {
  const lower = Math.floor(Math.min(min, max))
  const upper = Math.floor(Math.max(min, max))
  return lower + Math.floor(Math.random() * (upper - lower + 1))
}

function mergeNote(existing: string | undefined, next: string) {
  const value = clip(next, 2_000)
  if (!value) return existing
  if (!existing) return value
  if (normalizeFact(existing).includes(normalizeFact(value))) return existing
  return `${existing}\n${value}`.slice(-6_000)
}

function patchClaimsMatch(left: string, right: string) {
  const a = normalizeFact(left).replace(/[，。！？、,.!?；;:：]/g, '')
  const b = normalizeFact(right).replace(/[，。！？、,.!?；;:：]/g, '')
  if (!a || !b) return false
  if (a === b) return true
  // Allow small wording variations, while avoiding very short claims that
  // could incorrectly merge contradictory changes.
  return Math.min(a.length, b.length) >= 8 && (a.includes(b) || b.includes(a))
}

function statePatchEvidence(entries: ScriptEntry[], timezone: string) {
  const narrative = entries.filter(entry => entry.kind === 'script' || entry.actor === 'narrator')
  // Use the narrative timestamp as the turn key. Duplicate rows created at
  // the same instant must not count as independent evidence.
  const turns = new Set(narrative.map(entry => entry.occurredAt.getTime())).size
  const days = new Set(narrative.map(entry => calendarDayKey(entry.occurredAt, timezone))).size
  return { turns, days }
}

function startOfUtcWindow(value: Date, windowDays: number) {
  const size = Math.max(1, Math.floor(windowDays))
  const epochDay = Math.floor(value.getTime() / Time.day)
  return new Date(Math.floor(epochDay / size) * size * Time.day)
}

function groupOverlayPatches(patches: StatePatchProposal[], windowDays = 5) {
  const groups = new Map<string, { participantId: string; target: StatePatchProposal['target']; from: Date; to: Date; patches: StatePatchProposal[] }>()
  for (const patch of patches) {
    const from = startOfUtcWindow(patch.appliedAt ?? patch.createdAt, windowDays)
    const key = `${patch.participantId}|${patch.target}|${from.toISOString()}`
    const group = groups.get(key) ?? { participantId: patch.participantId, target: patch.target, from, to: new Date(from.getTime() + windowDays * Time.day), patches: [] }
    group.patches.push(patch)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function groupOverlaySnapshots(snapshots: OverlaySnapshot[], windowDays = 10) {
  const groups = new Map<string, { participantId: string; target: OverlaySnapshot['target']; from: Date; to: Date; snapshots: OverlaySnapshot[] }>()
  for (const snapshot of snapshots) {
    const from = startOfUtcWindow(snapshot.periodEnd, windowDays)
    const key = `${snapshot.participantId}|${snapshot.target}|${from.toISOString()}`
    const group = groups.get(key) ?? { participantId: snapshot.participantId, target: snapshot.target, from, to: new Date(from.getTime() + windowDays * Time.day), snapshots: [] }
    group.snapshots.push(snapshot)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function normalizeMajorEvents(value: unknown, patches: StatePatchProposal[], snapshots: OverlaySnapshot[] = []) {
  const modelEvents = Array.isArray(value) ? value.filter(item => typeof item === 'string').map(item => clip(item, 600)) : []
  const retained = [
    ...snapshots.flatMap(snapshot => snapshot.majorEvents ?? []),
    ...patches.filter(patch => patch.impact === 'major').map(patch => clip(patch.proposedValue || patch.evidence, 600)),
  ]
  return Array.from(new Set([...retained, ...modelEvents].filter(Boolean))).slice(-20)
}
