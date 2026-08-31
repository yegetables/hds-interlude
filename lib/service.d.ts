import { Context, Service, Session } from 'koishi';
import { ModelConfig } from './narrator';
import { GroupWillingnessConfig } from './group-willingness';
import { SchedulePreplanConfig } from './schedule-preplan';
import { InterludeArc, InterludeScene, InterludeParticipant, InterludeStory, NarrativeDecision, NarrativeFact, NarrativeIntent, GroupContext, NarrativeProvider, NarrativeRequest, NarrativeCompactor, NarrativeEmbedder, OutgoingMessageDraft, ScriptEntry, StatePatchProposal, StorySetting, StoryState, OverlaySnapshot, AlterSystemConfig, AgencyConfig, ScenePresenceState, ChatActionCapabilities, ChatReactionName, MessageReactionDraft, NativeFaceSemantic, QuotedMessageContext, SchedulePreplanRecord, TimelinePlan, UserReportedTime } from './types';
/** Semantic recall is another view of raw history, so it must obey the same
 * private-branch boundary as recentScript. Group transcripts are deliberately
 * excluded from a private turn unless the owner opted into shared details. */
export declare function isHistoryEntryVisibleToParticipant(entry: Pick<ScriptEntry, 'participantId' | 'kind'>, participantId: string, shareParticipantDetails: boolean): boolean;
/** A turn needs a live query vector only for a feature that can actually use
 * it. An inactive or small sticker library must not silently turn ordinary
 * fact embedding into a per-message network request. */
export declare function shouldRequestTurnEmbedding(embedding: ModelConfig['embedding'] | undefined, stickerLibraryEnabled: boolean, stickerCount: number): boolean;
export interface Config {
    /** Immersive operation that suppresses HDSI visibility and Koishi commands. */
    blindMode?: BlindModeConfig;
    /** @deprecated Renamed to blindMode; retained for existing Console YAML. */
    blackBox?: BlindModeConfig;
    model: ModelConfig;
    runtime: RuntimeConfig;
    storyDefaults: StoryDefaults;
    logging: LoggingConfig;
    memory?: MemoryConfig;
    sharedStory?: SharedStoryConfig;
    /** Optional, read-only browser observations powered by koishi-plugin-puppeteer. */
    browser?: BrowserConfig;
    /** Optional OneBot/NapCat account gate. It only affects the onebot platform. */
    onebot?: OneBotNapCatConfig;
    /** Optional cross-platform chat gestures; runtime connector availability remains authoritative. */
    chatActions?: ChatActionsConfig;
    stickers?: StickerLibraryConfig;
    alterSystem?: AlterSystemConfig;
    agency?: AgencyConfig;
    schedulePreplan?: SchedulePreplanConfig;
}
export interface BlindModeConfig {
    enabled: boolean;
    /** Periodic, intentionally minimal health signal while all other HDSI logs stay hidden. */
    healthReportMinutes: number;
}
/** One row in the Console account tables. QQ ids are strings because QQ ids
 * can exceed JavaScript's safe integer range and Koishi exposes them as text. */
export interface OneBotAccountRule {
    qq: string;
    label: string;
    enabled: boolean;
    /** Optional identity fields for a whitelisted private-message user. */
    personId?: string;
    profile?: string;
    relationship?: string;
}
export interface OneBotNapCatConfig {
    /** When false (or omitted for old configurations), OneBot access is unchanged. */
    enabled: boolean;
    /** NapCat accounts that are allowed to send the character's messages. */
    botAccounts: OneBotAccountRule[];
    /** @deprecated Kept only so old YAML can still load; runtime is allowlist-only. */
    userMode?: 'allowlist' | 'blocklist';
    userAccounts: OneBotAccountRule[];
    /** Explicit OneBot group allowlist. Group members do not need DM whitelist access. */
    groupChats?: GroupChatRule[];
    /** Prevent an echoed self-message from entering the narrative. */
    ignoreSelfMessages: boolean;
    /** Optional SnowLuma record-to-text bridge for incoming private QQ voice messages. */
    voiceTranscription?: VoiceTranscriptionConfig;
}
export interface VoiceTranscriptionConfig {
    enabled: boolean;
    timeoutMs: number;
}
export interface ChatActionsConfig {
    enabled: boolean;
    platforms: Array<'qq' | 'wechat'>;
    quoteReply: boolean;
    messageReactions: boolean;
    allowedReactions: ChatReactionName[];
    nativeFaces: boolean;
    expressionThreshold: number;
    allowedNativeFaces: NativeFaceSemantic[];
}
export interface StickerLibraryConfig {
    enabled: boolean;
    directory: string;
    maxFileSizeMB: number;
    catalogLimit: number;
    /** API JSON mode is optional; prompt-only still asks for the compact JSON contract. */
    descriptionResponseFormat?: 'json-object' | 'prompt-only';
}
export interface GroupChatRule {
    groupId: string;
    label: string;
    enabled: boolean;
    purpose: string;
    characterRole: string;
    responseMode: 'mention-only' | 'always';
    contextLimit: number;
    debounceSeconds: number;
    cooldownSeconds: number;
    willingness?: Partial<GroupWillingnessConfig>;
}
export interface MemoryConfig {
    enabled: boolean;
    backgroundIntervalMinutes: number;
    maxStoriesPerCompactionRun: number;
    sceneEntryThreshold: number;
    sceneCharacterThreshold: number;
    compactionEntryLimit: number;
    compactionCharacterLimit: number;
    sceneHookCharacters: number;
    sceneSummaryCharacters: number;
    arcSummaryCharacters: number;
    /** How many immediately-preceding closed scene summaries join the prompt. */
    previousSceneSummaries: number;
    recentEntryLimit: number;
    factLimit: number;
    factContentCharacters: number;
    factImportanceWeight: number;
    factConfidenceWeight: number;
    factRecencyWeight: number;
    semanticWeight: number;
    unresolvedWeight: number;
    statePatchConfidenceThreshold: number;
    majorStatePatchConfidenceThreshold: number;
    statePatchMinEvidence: number;
    /** Minimum independent narrative turns for a minor overlay change. */
    statePatchMinTurns?: number;
    /** Minimum distinct calendar days represented by minor-patch evidence. */
    statePatchMinDays?: number;
    /** Cooldown between stable overlay changes on the same target/path. */
    statePatchCooldownHours?: number;
    autoApplyStatePatches: boolean;
    allowMajorStateChanges: boolean;
    maxFactsPerStory: number;
    /** Keep short-lived dramatic aftereffects as context for later writing. */
    activeConsequencesEnabled: boolean;
    /** Maximum active consequences carried into one main-narrative prompt. */
    activeConsequencePromptLimit: number;
    /** Longest permitted lifetime of one consequence; protects canon from drift. */
    activeConsequenceMaxDays: number;
    /** Used when the narrator omits a precise strength for a valid consequence. */
    activeConsequenceDefaultStrength: number;
    overlayCompressionEnabled?: boolean;
    overlayRecentDays?: number;
    overlayMonthlyAfterDays?: number;
    overlayWeeklyWindowDays?: number;
    overlayMonthlyWindowDays?: number;
    overlayWeeklySummaryCharacters?: number;
    overlayMonthlySummaryCharacters?: number;
}
export interface RuntimeConfig {
    captureDirectMessages: boolean;
    autoCreate: boolean;
    ignoreCommandMessages: boolean;
    allowProactiveMessages: boolean;
    /** Minimum narrator-declared willingness for a background-initiated contact. */
    proactiveWillingnessThreshold?: number;
    sweepIntervalMinutes: number;
    minimumAdvanceMinutes: number;
    maxStoriesPerSweep: number;
    contextEntryLimit: number;
    /** Preserve raw entries from this recent time window in addition to the count floor. */
    contextTimeWindowMinutes?: number;
    memoryLimit: number;
    maxScriptCharacters: number;
    maxMessageCharacters: number;
    minimumDelayedReplySeconds: number;
    maximumDelayedReplyMinutes: number;
    cancelDelayedRepliesOnUserMessage: boolean;
    /** Retry a user turn after a transient narrative-provider failure. */
    narrativeRetryDelaySeconds?: number;
    /** Maximum automatic retries per failed user turn; 0 disables retry. */
    narrativeRetryMaxAttempts?: number;
    /** Split model reply.content into multiple QQ messages at the configured separator. */
    splitReplyMessages?: boolean;
    messageSeparator?: string;
    typingBaseDelaySeconds?: number;
    typingCharactersPerSecond?: number;
    typingMaxDelaySeconds?: number;
    /** Random variation applied to simulated typing delays; 0 keeps deterministic timing. */
    typingJitterRatio?: number;
    /** Wait after the newest user message before starting a writing request. */
    userMessageDebounceSeconds?: number;
    /** @deprecated Ignored since 0.1.2; requests remain replaceable until the first reply is committed. */
    staleNarrativeRequestWindowSeconds?: number;
    /** 新版自动推进调度；旧版 minimumAdvanceMinutes 仍保留兼容。 */
    autoAdvanceEnabled?: boolean;
    autoAdvanceIntervalMinutes?: number;
    autoAdvanceJitterMinutes?: number;
    /** Short life-writing passes after a conversation, in minutes. */
    conversationFollowUpMinutes?: number[];
    /** Small random offset applied to each short conversation follow-up. */
    conversationFollowUpJitterMinutes?: number;
    restWindows?: RestWindow[];
}
export interface BrowserConfig {
    enabled: boolean;
    /** Immediate browsing is opt-in because it intentionally adds one more model/browser round trip. */
    mode: 'deferred-only' | 'allow-immediate';
    allowSearch: boolean;
    allowVisit: boolean;
    searchUrlTemplate: string;
    allowedDomains: string[];
    blockedDomains: string[];
    maxConcurrentPages: number;
    /** Bound work per background sweep so a backlog cannot hold the story queue for minutes. */
    maxResearchPerSweep: number;
    navigationTimeout: number;
    waitUntil: 'domcontentloaded' | 'networkidle2';
    maxTextCharacters: number;
    maxExcerptCharacters: number;
    maxObservationsInPrompt: number;
    cacheMinutes: number;
    allowGroupTriggeredResearch: boolean;
    logObservationPreview: boolean;
}
/** Console presets that turn QQ accounts into named relationship branches. */
export interface ParticipantPreset {
    qq: string;
    personId: string;
    label: string;
    profile: string;
    relationship: string;
    enabled: boolean;
}
export interface SharedStoryConfig {
    /** One main story per bot account. Kept configurable for a safe rollback. */
    enabled?: boolean;
    /** Enroll an allowed account into an existing main story on its first DM. */
    autoEnrollParticipants: boolean;
    /** Allow one incoming message to cause an explicitly justified message to another account. */
    allowCrossConversationMessages: boolean;
    /** Send other participants' relationship/profile details to the model provider. */
    shareParticipantDetails: boolean;
    /** Hard cap for cross-account messages produced by one narrative turn. */
    maxCrossConversationActions: number;
    /** Number of other relationship summaries sent to the main narrator. */
    participantContextLimit: number;
    /** Empty keeps legacy behaviour; otherwise only these QQs may run global management commands. */
    managerAccounts: string[];
    /** Optional QQ-to-person presets; accounts with the same personId share identity notes. */
    /** @deprecated Use onebot.userAccounts identity fields in new configs. */
    participantPresets?: ParticipantPreset[];
}
export interface RestWindow {
    enabled: boolean;
    label: string;
    start: string;
    end: string;
    minIntervalMinutes: number;
    maxIntervalMinutes: number;
}
export interface ExecutableMessageReaction extends MessageReactionDraft {
    messageId: string;
}
export interface ExecutableGroupChatActions {
    replyTo?: {
        messageRef: string;
        messageId: string;
    };
    reactions: ExecutableMessageReaction[];
}
export interface StoryDefaults {
    characterName: string;
    characterProfile: string;
    perspective: string;
    userProfile: string;
    relationship: string;
    world: string;
    supportingCast: string;
    location: string;
    style: string;
    timezone: string;
}
export interface LoggingConfig {
    level: 'silent' | 'error' | 'warn' | 'info' | 'debug';
    /** Controls how much normal operational activity is written at info level. */
    verbosity?: 'summary' | 'standard' | 'diagnostic';
    format: 'compact' | 'detailed' | 'layered';
    /** Apply semantic ANSI colors; Koishi Console and normal terminals render them. */
    colors?: boolean;
    /** Select a high-contrast ANSI palette for dark or light Console themes. */
    colorTheme?: 'dark' | 'light';
    /** Show fixed action kaomoji; false uses compact symbols instead. */
    kaomoji?: boolean;
    logScriptPreview: boolean;
    /** Emit user-visible incoming/outgoing message bodies to the plugin log. */
    logMessageContent?: boolean;
    previewLength: number;
}
export interface StoryStartReadiness {
    ready: boolean;
    existing?: InterludeStory;
    blockers: string[];
    warnings: string[];
    preview: {
        characterName: string;
        characterProfile: boolean;
        perspective: boolean;
        world: boolean;
        timezone: string;
        model: string;
        autoCreate: boolean;
    };
}
export declare class InterludeService extends Service {
    config: Config;
    static inject: string[];
    private narrator;
    private compactor;
    private embedder;
    private stickerDescriber;
    private visionDescriber;
    private stickerCatalog;
    /** Whole-table semantic recall cache, one map per story: entry id → vector +
     * minimal content. Loaded lazily on first recall and extended incrementally
     * by the background backfill; never persisted. */
    private historyVectors;
    private historyVectorsReady;
    /** Per-story retry-after timestamps for failed Schedule Preplan generations. */
    private schedulePreplanBackoff;
    private stickerById;
    private stickerScanRunning;
    /**
     * 同一故事的用户消息、到期意图和后台压缩必须串行。否则“用户新消息
     * 取消旧延迟回复”可能与定时发送同时发生，造成过期消息仍被发出。
     */
    private queues;
    private bufferedNarrativeTurns;
    private bufferedGroupTurns;
    /** Short-lived group-member display names. QQ number remains the stable key. */
    private groupMemberNameCache;
    private groupMemberNameLookups;
    /** Ephemeral, per-group willingness score. It never touches private turns or durable story state. */
    private groupWillingness;
    /** Earliest wake-up for persisted typing segments; one timer per story. */
    private dueIntentWakeTimers;
    /** Synchronously marks a relationship whose current typing chain was interrupted by new input. */
    private interruptedTypingParticipants;
    /** Prevent a background life turn from racing an unlocked live model call. */
    private narratingStories;
    private factBackfills;
    /** Coalesce repeated post-turn compaction requests into one queued pass. */
    private scheduledCompactions;
    /** Coalesce low-frequency atmosphere analysis without delaying the visible reply. */
    private scheduledAlterAnalyses;
    /** sql.js/SQLite has one writable connection; serialize writes globally. */
    private databaseWriteQueue;
    /** The browser is bounded separately from narrative work so a burst of
     * deferred intents cannot spawn an uncontrolled number of Chromium pages. */
    private browserActive;
    private browserWaiters;
    /** Use Koishi's context-bound logger so Console/runtime targets receive records. */
    private readonly serviceLogger;
    private backgroundStarted;
    private databaseResetting;
    private sweepRunning;
    private compactionSweepRunning;
    private blindModeHealthIssue;
    /** Console reload creates a new service instance, so normalized config can
     * be cached safely for the lifetime of this instance. */
    private cachedVoiceTranscriptionConfig?;
    private cachedStickerConfig?;
    private cachedAlterSystemConfig?;
    private cachedAgencyConfig?;
    private cachedSchedulePreplanConfig?;
    private cachedBlindModeConfig?;
    private cachedAutoAdvanceConfig?;
    private cachedSharedStoryConfig?;
    private cachedMemoryConfig?;
    private cachedBrowserConfig?;
    constructor(ctx: Context, config: Config);
    private startBackgroundTasks;
    setNarrator(provider: NarrativeProvider): void;
    getNarrator(): NarrativeProvider;
    setCompactor(provider: NarrativeCompactor): void;
    /** Allows a custom/local vector service without replacing the main narrator. */
    setEmbedder(provider: NarrativeEmbedder): void;
    /**
     * Returns whether this session is allowed to use HDSI. Koishi's OneBot
     * adapter uses `selfId` for the logged-in bot QQ and `userId` for the sender
     * QQ. Other adapters deliberately keep their old behaviour.
     */
    canHandleSession(session: Session): boolean;
    /** Group access uses an explicit group allowlist; group members do not need
     * to be present in the private-message user whitelist. */
    canHandleGroupSession(session: Session): boolean;
    private groupRule;
    /** Same account gate for direct-message work that already has a participant. */
    canHandleParticipant(participant: InterludeParticipant): boolean;
    canManageSession(session: Session): boolean;
    /** Background life updates only require the bot account to remain enabled. */
    canHandleStory(story: InterludeStory): boolean;
    findStory(session: Session): Promise<any>;
    /**
     * Resolve and enforce the one global active story. The preferred id wins
     * when present; otherwise the most recently updated row is retained and
     * every other active row is archived immediately.
     */
    private getCanonicalStory;
    findParticipant(session: Session, story?: InterludeStory): Promise<any>;
    participants(storyId: string, includePaused?: boolean): Promise<any[]>;
    createStory(session: Session, name?: string): Promise<any>;
    /** Read-only preflight for manually starting a runtime story from Console defaults. */
    storyStartReadiness(session: Session): Promise<StoryStartReadiness>;
    /**
     * Enrolls a QQ account as a relationship branch and synchronizes its Console
     * identity fields. Callers that already resolved the participant can pass it
     * in to avoid a second database read.
     */
    ensureParticipant(story: InterludeStory, session: Session, now?: Date, knownExisting?: InterludeParticipant): Promise<any>;
    updateSetting(story: InterludeStory, patch: Partial<StorySetting>): Promise<{
        setting: StorySetting;
        updatedAt: Date;
        id: string;
        platform: string;
        selfId: string;
        userId: string;
        channelId: string;
        status: import("./types").StoryStatus;
        state: StoryState;
        cursorAt: Date;
        createdAt: Date;
    }>;
    setStatus(story: InterludeStory, status: InterludeStory['status']): Promise<{
        status: import("./types").StoryStatus;
        updatedAt: Date;
        id: string;
        platform: string;
        selfId: string;
        userId: string;
        channelId: string;
        setting: StorySetting;
        state: StoryState;
        cursorAt: Date;
        createdAt: Date;
    }>;
    recentEntries(storyId: string, limit?: number): Promise<any[]>;
    /** Live narration keeps both a count floor and a recent wall-clock window.
     * A burst of conversation can therefore exceed the nominal turn count
     * without immediately erasing everything said earlier in the same hour. */
    private recentEntriesForPrompt;
    memories(storyId: string, limit?: number, participantId?: string): Promise<any[]>;
    /** Administrative view: includes global and participant-specific durable facts. */
    adminFacts(storyId: string, limit?: number): Promise<any[]>;
    adminPendingIntents(storyId: string, limit?: number): Promise<any[]>;
    adminStatePatches(storyId: string, limit?: number): Promise<any[]>;
    /** Adds an audit-visible system note without pretending it came from the model. */
    addAdminScriptNote(story: InterludeStory, content: string): Promise<boolean>;
    /** Adds a high-confidence fact for corrections that must survive compaction. */
    addAdminFact(story: InterludeStory, scope: NarrativeFact['scope'], content: string): Promise<boolean>;
    /** Reversible deletion: facts are retained as superseded rows for audit. */
    forgetAdminFact(storyId: string, id: number): Promise<boolean>;
    cancelAdminIntent(storyId: string, id: number): Promise<boolean>;
    rejectAdminStatePatch(storyId: string, id: number): Promise<boolean>;
    /** Clear only the evolving setting overlay; keep Canon, script and memories. */
    clearSettingOverlay(story: InterludeStory, target: 'character' | 'perspective' | 'relationship' | 'world' | 'all'): Promise<{
        participantCount: number;
    }>;
    /** Start a clean host-owned timeline without deleting the historical archive.
     * This is intended once after upgrading from prose-authoritative releases
     * whose active scene or scratchpad may already contain future contamination. */
    rebaseTimeline(story: InterludeStory): Promise<{
        at: Date;
        sceneReset: boolean;
    }>;
    private clearSettingOverlayUnlocked;
    /**
     * Destructive administrative operation. The caller must validate the
     * confirmation phrase. A full purge also rebuilds Canon from the current
     * Console configuration, so an old profile cannot survive in later prompts.
     */
    purgeAllStoryData(storyId: string): Promise<void>;
    /** Reset all platforms, retaining exactly one empty global canonical story. */
    purgeAllData(preferredStoryId?: string): Promise<any>;
    /** Delete one adapter/platform's records without touching other platforms. */
    purgePlatformData(platform: string): Promise<number>;
    /**
     * Clear only HDSI-owned tables. Koishi's users/channels and other plugins
     * are intentionally untouched; deleting the physical SQLite file from a
     * command would be unsafe while the driver is open.
     */
    clearDatabase(): Promise<{
        removed: number;
        logicallyCleared: number;
    }>;
    /** Remove script and derived memory records whose timestamps overlap a range. */
    purgeStoryRange(storyId: string, from: Date, to: Date): Promise<void>;
    /** Entry point for configured OneBot group chats. Group members do not need
     * private-message authorization; the group allowlist controls access. */
    receiveGroup(session: Session): Promise<boolean>;
    receive(session: Session): Promise<boolean>;
    private groupSenderName;
    private lookupGroupMemberName;
    private bufferGroupMessage;
    private flushGroupTurn;
    private groupMessages;
    private groupCooldownActive;
    private groupChatCapabilities;
    private privateChatCapabilities;
    private executeGroupReactions;
    private resolveSticker;
    private get expressionThreshold();
    private resolveNativeFace;
    private sendSticker;
    private sendNativeFace;
    private sendGroupMessage;
    /**
     * Persisted messages wait here briefly before they reach the narrator. This
     * makes “你好 / 在吗 / 我有件事想问” one event without risking message loss.
     */
    private bufferUserNarrative;
    private signalIncomingInterruption;
    /** Experimental streaming path: only a complete, validated private reply
     * may leave early. It commits the existing interruption boundary at the
     * same moment as ordinary first-message delivery. */
    private deliverEarlyPrivateReply;
    /** Extract structured image segments without treating them as a second event. */
    private get voiceTranscriptionConfig();
    private get stickerConfig();
    private describeUserEvent;
    private scanStickerLibrary;
    private refreshStickerCatalog;
    private semanticStickerEmbeddingEnabled;
    /** Vectorize described-but-unindexed sticker assets in the background. The
     * batch stays small so one scan cannot spend more than a handful of calls. */
    private backfillStickerEmbeddings;
    private stickerCatalogForSession;
    /** Semantically narrow the sticker catalog to the entries most relevant to the
     * live message. Falls back to the full catalog whenever the feature is off,
     * the turn has no query vector, or the catalog is below the limit. */
    private rankStickerAssets;
    private semanticTurnEmbeddingEnabled;
    /** Compact summaries of the scenes immediately before the active one. They
     * bridge the raw context window and the arc, where last-turn details used to
     * disappear from the prompt entirely. */
    private previousSceneSummaries;
    /** Drop expired scratchpad entries and cap the list; details only ever carry
     * small in-flight facts, so silence is the correct treatment for expiry. */
    private pruneWorkingDetails;
    /** Semantic recall over the story's whole raw history. Vectors are loaded
     * once per story into memory and extended incrementally by the backfill;
     * entries already inside recentScript are excluded by id. */
    private recallHistory;
    /** Load every embedded entry of one story into the recall cache. The load is
     * deliberately whole-table (no time window): older memories stay retrievable,
     * and the per-process cache makes the cost one-off per story. */
    private ensureHistoryVectors;
    /** Drop in-memory copies whenever their source rows are removed or redacted.
     * The next recall reloads only the surviving database rows. */
    private invalidateHistoryVectors;
    /** Background vectorization for semantic history recall. Newest entries go
     * first so live-recall quality ramps up quickly; the whole table is covered
     * gradually over successive maintenance passes. */
    private backfillHistoryEmbeddings;
    private transcribeVoiceEvent;
    private describeVisionEvent;
    private loadNativeImages;
    /** Sidecar vision mirrors native image acquisition, but sends only its
     * factual result into the text narrator's current event. */
    private describeCurrentImages;
    private fetchNativeImage;
    /** Convert adapter/fetched bytes into one bounded native-vision attachment.
     * Animated stickers are rendered to a representative PNG frame when the
     * optional Puppeteer service is available; otherwise the original image is
     * still passed through rather than inventing a description. */
    private imageBytesToNative;
    /** Re-render a static image through Puppeteer capped at the configured vision
     * dimension. Multimodal providers tile large images into many tokens, so a
     * bounded re-encode saves both upload time and per-turn token cost; the
     * browser also applies EXIF orientation, fixing rotated phone photos. */
    private downscaleImageForVision;
    private renderAnimatedImageFrame;
    /** Prevent timers or already-returning model calls from resurrecting data
     * after an administrator resets the story or clears HDSI tables. */
    private invalidateBufferedNarratives;
    /** True while a live or debounced conversation should take priority over background work. */
    private hasPendingNarrative;
    private flushBufferedNarrative;
    advanceStory(story: InterludeStory, force?: boolean): Promise<OutgoingMessageDraft[]>;
    /** Used by commands/tests to deliver a mixed set of account-targeted actions safely. */
    deliverMessages(story: InterludeStory, messages: OutgoingMessageDraft[], session?: Session): Promise<OutgoingMessageDraft[]>;
    compactStory(story: InterludeStory, force?: boolean): Promise<boolean>;
    /** Merge and compress already-applied overlay patches without running the
     * full scene/fact compaction pass. This is safe for manual maintenance. */
    compactOverlay(story: InterludeStory): Promise<boolean>;
    /** Administrative overlay view used by the Console command. */
    adminOverlayStatus(storyId: string): Promise<{
        state: any;
        proposed: StatePatchProposal[];
        applied: StatePatchProposal[];
        cleared: StatePatchProposal[];
        snapshots: OverlaySnapshot[];
        participantOverlays: any[];
    }>;
    sweep(): Promise<void>;
    private advanceUnlocked;
    private decide;
    /** Refresh continuity only on the first automatic pass or every fifteenth
     * successful narrative write. Ordinary turns reuse the last snapshot. */
    private shouldRefreshContinuity;
    /** Automatic prose no longer invents the world timeline by itself. The
     * compaction route first returns a tiny relative-time ledger; if it cannot,
     * preserving the current cursor is safer than writing an ungrounded future. */
    private planAutomaticTimeline;
    private tryDecide;
    private persistDecision;
    /** Keep the active-scene anchor in sync with the host ledger immediately,
     * rather than waiting for prose compaction to reconcile an already-completed
     * automatic window. */
    private persistTimelineSceneAnchor;
    adminSchedulePreplan(storyId: string): Promise<SchedulePreplanRecord>;
    requestSchedulePreplanRebuild(storyId: string): Promise<boolean>;
    private get alterSystemConfig();
    private get agencyConfig();
    private get schedulePreplanConfig();
    private get blindModeConfig();
    private emotionalOffsetForPrompt;
    private updateAlterSystem;
    private scheduleAlterAnalysis;
    private analyzeAlterSystem;
    private appendEntry;
    private appendMemory;
    /**
     * Retrieves the smallest useful slice of durable facts. When an embedding
     * model is available, semantic relevance is combined with narrative quality
     * signals instead of replacing them; a failed vector lookup simply has a
     * semantic score of zero for this turn.
     */
    facts(storyId: string, limit?: number, query?: string, participantId?: string, turnQueryEmbedding?: number[]): Promise<NarrativeFact[]>;
    /** Returns only observations that are safe for this narration branch. A
     * participant's browsing is not shown to another private participant unless
     * the owner has explicitly enabled shared relationship details. */
    private webObservations;
    activeScene(storyId: string): Promise<InterludeScene | null>;
    activeArc(storyId: string): Promise<InterludeArc | null>;
    private appendIntent;
    /** Active consequences share the intent table but are never scheduler work.
     * Their payload keeps the lifecycle explicit so old scheduled intents keep
     * their existing behaviour without a migration. */
    private activeConsequencesAndExpire;
    /** Only active consequences visible to the writer may be resolved. This
     * prevents a remote model from changing arbitrary future plans by id. */
    private applyIntentUpdates;
    /** Stores a narrator-proposed browser action as a future intent. The model
     * never writes page content directly; a separate Puppeteer task creates the
     * observation later. */
    private appendBrowserIntent;
    /** Executes a due browser intent once, records its bounded observation, and
     * marks the future plan complete regardless of success. A failed browser is
     * still an event (the character could not access the page), but it never
     * blocks later dialogue or background life updates. */
    private executeDeferredBrowserIntent;
    /** Read a page through Koishi Puppeteer. This is intentionally read-only:
     * it rejects non-public destinations, extracts visible text only, and closes
     * the page after every observation. */
    private collectWebObservation;
    private saveWebObservation;
    /** Immediate browser reads are intentionally held in memory until the
     * final narrator result survives the stale-request check. This prevents an
     * obsolete two-second message burst from leaving a durable web event behind. */
    private persistCollectedWebObservation;
    private findCachedWebObservation;
    private withBrowserSlot;
    /** Persist a bounded retry so a transient provider failure cannot strand a user turn. */
    private scheduleNarrativeRetry;
    private dueIntents;
    private upcomingNarrativeIntents;
    /** Wake the scheduler close to a short typing delay instead of waiting for
     * the normal background sweep. The due intent remains the source of truth. */
    private scheduleDueIntentWake;
    private scheduleNextSplitWake;
    /** Deliver already-decided <sep/> segments without invoking the narrator. */
    private deliverDueSplitSegments;
    /** Pending spoken promises are intentionally tiny and relationship-local. */
    private pendingFollowUpCommitments;
    private appendFollowUpCommitment;
    private applyFollowUpResolutions;
    private deferUnresolvedDueFollowUps;
    private appendProactiveCheck;
    private cancelPendingOutgoingMessages;
    private sendScheduledMessages;
    /**
     * Immediate replies may reuse the incoming Session; cross-account and timed
     * messages are delivered through the target participant's channel instead.
     * This is the boundary that prevents a shared story from accidentally
     * sending every reply back to the account that happened to trigger the turn.
     */
    private sendOutgoingMessages;
    /** Confirm visible delivery only after the platform accepted the message.
     * Failed attempts become explicit system evidence rather than fictional
     * character speech, and deliberately do not auto-retry to avoid duplicates
     * when an adapter fails after it has already accepted a request. */
    private confirmOutgoingDeliveries;
    private recordOutgoingDeliveryFailure;
    private resolveLiteralQuoteMessageId;
    /** Records only completed background deliveries. It is intentionally a
     * bounded action ledger, rather than a duplicate conversation transcript. */
    private recordAutomaticDelivery;
    private splitOutgoingMessage;
    private typingDelayMilliseconds;
    private findBotForParticipant;
    private get autoAdvanceConfig();
    private isAutomaticAdvancePaused;
    private dueConversationFollowUps;
    /** Remove elapsed short passes after their single writing turn. The next
     * remaining pass stays persisted, so reloads never restart the 10/20-minute
     * sequence or accidentally run both passes at once. */
    private completeConversationFollowUps;
    private isAutomaticAdvanceDue;
    private pauseAutomaticAdvanceAfterUserMessage;
    private pauseAutomaticAdvanceAfterDelayedReply;
    /** Schedule the 10/20-minute continuity passes from the actual endpoint of
     * a conversation. A delayed reply anchors them after its planned send time. */
    private scheduleConversationFollowUpsAfterTurn;
    private scheduleNextAutomaticAdvance;
    private schedulePreplanAnchoredTime;
    private get sharedStoryConfig();
    private mainModelLabel;
    private participantPreset;
    /** The clean Canon used both by story creation and a full administrative reset. */
    private initialStorySetting;
    /** Rebuild per-account relationship baselines and discard evolving state. */
    private resetParticipantCanon;
    private userAccountRule;
    private getParticipant;
    private recordIncomingMessage;
    private markParticipantSeen;
    private recordCharacterMessage;
    private updateParticipantState;
    /** Converts one old account-bound story into a bot-bound shared story once. */
    private migrateLegacyStory;
    /**
     * A deployment can contain several old per-account stories. Once the first
     * one created the shared story, fold later legacy branches into it as their
     * users return; otherwise their old active rows would keep being swept in
     * parallel and create a second life for the same character.
     */
    private migrateLegacyBranchIntoShared;
    private get memoryConfig();
    private get browserConfig();
    private ensureContinuity;
    private scheduleCompaction;
    private compactStories;
    private getSchedulePreplan;
    private schedulePreplanEvidence;
    private saveSchedulePreplan;
    private prepareSchedulePreplanReview;
    /** Preplan has one small independent request instead of competing with
     * scene/fact compression. One recovery retry is cheap and covers providers
     * that occasionally omit an otherwise valid JSON object. */
    private requestSchedulePreplan;
    private persistSchedulePreplanReview;
    /** A visible reply already reached the user, so this retry may write only
     * the missing life script. It must never create a second transport message. */
    private scheduleStreamScriptRecovery;
    private persistStreamScriptRecovery;
    private compactUnlocked;
    /** Everything up to the expensive compactor call: cheap reads plus the due
     * checks. Runs inside the story serial queue, but the model call itself must
     * not — a queued compactor request would delay the next live turn. */
    private prepareCompaction;
    /** Cheap DB persistence for one compaction decision. Re-acquires the story
     * serial queue in the caller so writes stay ordered with narrative turns. */
    private applyCompaction;
    /** Older state patches are compacted only by the background maintenance
     * lane. Live turns always retain the last few days as raw detail. */
    private compactOverlayUnlocked;
    private overlaySnapshotsForPrompt;
    /** Once a snapshot safely represents older changes, keep state.overlay as
     * the live (uncompacted) delta only. This is what actually reduces prompt
     * size; snapshots carry the older evolution separately. */
    private rebuildLiveOverlayState;
    private persistCompaction;
    private persistFact;
    private embedText;
    private scheduleFactEmbeddingBackfill;
    private backfillFactEmbeddings;
    private persistStatePatch;
    private report;
    /** Emit an operational record only when the selected verbosity includes it.
     * Summary is for outcomes, standard is for scheduler/model activity, and
     * diagnostic is for skip reasons and internal counters. */
    private reportOperation;
    private writeReport;
    private reportStandalone;
    /** One Koishi log line per model call: token counts, cache hit rate and
     * optional billing from the per-connection price fields. */
    private reportTokenUsage;
    private reportStandaloneOperation;
    private writeStandalone;
    private resolveCompactionFacts;
    private markContinuityDirty;
    private emitLog;
    private reportBlindModeHealth;
    private allowsVerbosity;
    private getStory;
    private serial;
    private dbWrite;
    /**
     * A SQLite/sql.js read can fail during the same short filesystem hiccup as a
     * write. Reads stay concurrent for normal performance; only transient driver
     * errors receive a small bounded retry instead of aborting a user turn.
     */
    private dbRead;
    private dbGet;
    /** Repair only a stale canonical story whose configured bot is no longer
     * online. A live OneBot session is stronger evidence than historical story
     * metadata, while a still-online story bot remains untouched. */
    private repairCanonicalOneBotStoryTransport;
    private retryDbWrite;
    private dbCreate;
    private findPossiblyCommittedCreate;
    private dbSet;
    private dbRemove;
    /**
     * SQLite/sql.js may fail physical DELETE when its backing file is locked.
     * Fall back to redaction so an administrative purge still completes and the
     * removed content is no longer exposed to prompts or management commands.
     */
    private purgeTable;
}
/** Detect record/audio segments from both Koishi elements and raw OneBot CQ
 * fallback without retaining the binary voice payload. */
export declare function extractSessionVoiceCount(session: Pick<Session, 'content'>): number;
/** Voice and typed text share one user event. The explicit marker lets the
 * narrator distinguish recognized speech from ordinary typed text. */
export declare function mergeUserMessageWithVoiceTranscripts(text: string, transcripts: string[], detected?: number): string;
/**
 * A model's willingness is an intent estimate, not a transport permission.
 * Native faces need a visible-text counterpart so a model cannot turn every
 * routine reply into a face merely by returning willingness=1. The 0.90 cap
 * deliberately makes thresholds above 0.90 an effective near-disable mode.
 */
export declare function calibratedNativeFaceWillingness(semantic: NativeFaceSemantic, willingness: unknown, replyContent: unknown): number;
/** The old punctuation-only id could collide (for example two filenames that
 * both normalize to bq--6-). Keep a readable path prefix, then append a
 * content hash fragment so every row is globally unique and stable for an
 * unchanged file. */
export declare function stableStickerAssetId(filePath: string, hash: string): string;
/** Extract only explicit clock statements from a live user message. This is a
 * small factual aid, not an attempt to infer every temporal expression. */
export declare function extractUserReportedTimes(content: string, now: Date, timezone: string): UserReportedTime[];
export declare function describeQuotedMessage(session: Session, characterName?: string): QuotedMessageContext | undefined;
export declare function normalizeQuotedMessageContent(value: unknown): string;
export declare function normalizeAllowedReactions(value: unknown): ChatReactionName[];
/** Parse only the narrow event ledger shape. Unknown model fields and empty
 * plans are discarded before they can become a source of world state. */
export declare function normalizeTimelinePlan(value: unknown): TimelinePlan | undefined;
/** Automatic script prose is a rendering, not the next turn's temporal source.
 * A compact host ledger retains the real sequence without letting a previous
 * paragraph be copied into a new time window. */
export declare function timelineEntryPromptProjection(entry: ScriptEntry): ScriptEntry;
export declare function normalizeGroupChatActions(decision: NarrativeDecision, capabilities: ChatActionCapabilities | undefined, context: GroupContext): ExecutableGroupChatActions;
export declare function formatGroupSpeaker(senderName: string, senderId: string): string;
export declare function normalizeGroupVisibleReply(raw: NarrativeDecision['groupReply'], interaction: NarrativeDecision['interaction'], maxCharacters: number): string;
export declare function visibleReplyMode(decision: NarrativeDecision, phase: NarrativeRequest['phase'], groupContext?: GroupContext): string;
export declare function hasRequiredNarrativeScript(value: NarrativeDecision | undefined | null): boolean;
export declare function resolveBlindModeConfig(value?: Partial<BlindModeConfig>): BlindModeConfig;
/** @deprecated Renamed to resolveBlindModeConfig. */
export declare const resolveBlackBoxConfig: typeof resolveBlindModeConfig;
/** Scene compaction may update a tiny roster only with explicit observed
 * evidence. This keeps named supporting cast available without treating them
 * as automatically present. */
export declare function normalizeScenePresenceDrafts(value: unknown, entries: ScriptEntry[], now?: Date): ScenePresenceState[];
/** Keeps a single due-turn private to one relationship while ensuring that
 * every plan that was already due at the start of the sweep gets a chance to
 * be judged before the next sweep interval. */
export declare function groupDueIntents(intents: NarrativeIntent[]): NarrativeIntent[][];
export declare function shouldSupersedeNarrativeRequest(inFlightRequestId: number | undefined, firstMessageCommittedRequestId: number | undefined, obsoleteRequestIds: ReadonlySet<number>): boolean;
/** Minato normally materializes timestamp columns as Date objects. Some
 * drivers and hot-reload paths can return ISO strings, so normalize every row
 * crossing the service boundary before time arithmetic or prompt building. */
export declare function normalizeDatabaseRow(table: string, value: unknown): any;
/** How many sticker descriptions a semantically filtered turn injects. */
export declare const SEMANTIC_STICKER_LIMIT = 12;
/** Pure ranking used by the semantic sticker filter. Assets without a vector
 * still fill remaining slots after the embedded ones so a half-indexed library
 * degrades gracefully instead of hiding entries. */
export declare function rankStickerCatalog<T extends {
    embedding?: number[];
}>(assets: T[], queryEmbedding: number[], limit: number): T[];
/** Only static raster images worth the re-render enter Puppeteer downscaling:
 * tiny images would not shrink further and animated ones have their own path. */
export declare function shouldDownscaleImage(mimeType: string, dataUri: string): boolean;
