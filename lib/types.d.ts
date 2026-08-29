export type StoryStatus = 'active' | 'paused' | 'archived';
export interface CharacterSetting {
    name: string;
    profile: string;
}
export interface StorySetting {
    /**
     * 初始 canon：只由显式配置修改。模型引起的长期变化应写入
     * StoryState.settingOverlay，避免一次生成把人物设定直接改写。
     */
    character: CharacterSetting;
    user: {
        displayName: string;
        profile: string;
    };
    relationship: string;
    world: string;
    /** Independent outer layer: the protagonist's values and way of seeing the world. */
    perspective: string;
    supportingCast: string;
    location: string;
    style: string;
    timezone: string;
}
export interface StoryState {
    /** Evolving overlay. The original setting remains the story's canon/base. */
    settingOverlay: StorySettingOverlay;
    activeSceneId?: number;
    activeArcId?: number;
    /** Low-frequency continuity note refreshed on the first auto pass and then after every 15 successful narrative updates. */
    continuitySnapshot?: ContinuitySnapshot;
    narrativeUpdateCount: number;
    lastContinuityUpdateAt?: string;
    /** 自动推进时钟；ISO 字符串便于跨进程/数据库 JSON 持久化。 */
    automation: StoryAutomationState;
    alterSystem?: AlterSystemState;
    agencyWindow?: AgencyWindowState;
    /** Small, evidence-backed roster emitted only by scene compaction. */
    scenePresence?: ScenePresenceState[];
    /** Recent completed background deliveries; hidden from live user turns. */
    automaticDeliverySummaries?: AutomaticDeliverySummary[];
}
export type ScenePresenceStatus = 'present' | 'off-scene' | 'expected';
export interface ScenePresenceState {
    name: string;
    status: ScenePresenceStatus;
    basis: string;
    sourceEntryIds: number[];
    updatedAt: string;
}
/** A bounded action-level reminder, never a second copy of chat history. */
export interface AutomaticDeliverySummary {
    participantId: string;
    summary: string;
    sourceEntryId?: number;
    deliveredAt: string;
}
/** Compact replace-in-place reminder of the protagonist's current state and notable threads. */
export interface ContinuitySnapshot {
    current: string;
    next: string[];
    recent: string[];
    salient: string[];
}
/**
 * One character can maintain several relationships in the same main story.
 * This state belongs to one real person / account, rather than to the whole
 * world, so one conversation cannot accidentally overwrite another person's
 * relationship notes or pending messages.
 */
export interface ParticipantState {
    openThreads: string[];
    relationshipNotes: string[];
    relationshipOverlay?: string;
    unreadMessageCount: number;
    pendingReplyCount: number;
    lastUserMessageAt?: string;
    lastCharacterMessageAt?: string;
}
export interface StoryAutomationState {
    /** 对话活跃期结束时间；在此之前只处理必要的到期意图，不补写日常生活。 */
    quietUntil?: string;
    /** 下一次自动生活补写的最早时间。 */
    nextAdvanceAt?: string;
    lastAutoAdvanceAt?: string;
    lastUserMessageAt?: string;
    /** Short continuity passes scheduled from the latest conversation endpoint. */
    conversationFollowUpAt?: string[];
    /** Relationship branch whose recent conversation supplies the 10/20-minute
     * continuity context. Omitted for ordinary background advancement. */
    conversationFollowUpParticipantId?: string;
}
export type AgencyActivityLoad = 'free' | 'occupied' | 'overloaded';
export type AgencyPrivacy = 'private' | 'shared' | 'public';
export type AgencyDeviceAccess = 'available' | 'limited' | 'unavailable';
export interface AgencyWindowState {
    activityLoad: AgencyActivityLoad;
    privacy: AgencyPrivacy;
    deviceAccess: AgencyDeviceAccess;
    nextOpportunityAt?: string;
    validUntil: string;
    basis: string;
    sourceEntryIds: number[];
    updatedAt: string;
}
export type ProactiveContactOrigin = 'life-event' | 'promise' | 'practical-update' | 'relationship-follow-up';
export type ProactiveDisclosure = 'ordinary' | 'personal';
export type ProactiveOutcome = 'send-now' | 'recheck-later' | 'let-go';
export interface ProactiveContactDraft {
    participantId: string;
    origin: ProactiveContactOrigin;
    motive: string;
    disclosure: ProactiveDisclosure;
    sourceEntryIds?: number[];
    willingness?: number;
    outcome: ProactiveOutcome;
    notBefore?: string;
    expiresAt?: string;
}
export interface AgencyConfig {
    enabled: boolean;
    maxWindowMinutes: number;
    minimumProactiveIntervalMinutes: number;
    maxCandidateHours: number;
}
export interface StorySettingOverlay {
    characterProfile?: string;
    /** Current accumulated expression of the separate perspective layer. */
    perspective?: string;
    relationship?: string;
    world?: string;
    supportingCast?: string;
    location?: string;
    /** Small, accumulated trait changes expressed as evidence-backed notes. */
    characterTraits?: string[];
}
export interface InterludeStory {
    id: string;
    platform: string;
    selfId: string;
    userId: string;
    channelId: string;
    status: StoryStatus;
    setting: StorySetting;
    state: StoryState;
    cursorAt: Date;
    createdAt: Date;
    updatedAt: Date;
}
/** A private-message endpoint and its relationship branch inside one story. */
export interface InterludeParticipant {
    id: string;
    storyId: string;
    platform: string;
    selfId: string;
    userId: string;
    channelId: string;
    /** Multiple accounts may deliberately share the same real-person id. */
    personId: string;
    displayName: string;
    profile: string;
    relationship: string;
    state: ParticipantState;
    status: 'active' | 'paused';
    createdAt: Date;
    updatedAt: Date;
}
export interface ScriptEntry {
    id: number;
    storyId: string;
    /** Empty for world/system events; otherwise identifies the involved account. */
    participantId: string;
    kind: string;
    actor: string;
    content: string;
    occurredAt: Date;
    metadata: Record<string, unknown>;
    createdAt: Date;
}
export interface NarrativeMemory {
    id: number;
    storyId: string;
    participantId: string;
    category: string;
    content: string;
    importance: number;
    status: string;
    sourceEntryId: number | null;
    createdAt: Date;
    updatedAt: Date;
}
export type SceneStatus = 'active' | 'closed';
export interface InterludeScene {
    id: number;
    storyId: string;
    status: SceneStatus;
    startedAt: Date;
    endedAt: Date | null;
    hook: string;
    summary: string;
    entryCount: number;
    /** 最近一次已经被写入场景摘要的条目；下一轮只压缩它之后的新内容。 */
    lastEntryId: number | null;
    createdAt: Date;
    updatedAt: Date;
}
export interface InterludeArc {
    id: number;
    storyId: string;
    status: 'active' | 'closed';
    title: string;
    summary: string;
    sceneCount: number;
    createdAt: Date;
    updatedAt: Date;
}
export type StatePatchTarget = 'character' | 'perspective' | 'world' | 'relationship';
export type StatePatchStatus = 'proposed' | 'applied' | 'compacted' | 'rejected' | 'cleared';
export interface StatePatchProposal {
    /**
     * 压缩器提出、插件审核的变化，而不是对 canon 的直接写入。
     * 保留证据和状态可支持审计、人工确认与日后的重新评估。
     */
    id: number;
    storyId: string;
    participantId: string;
    target: StatePatchTarget;
    path: string;
    proposedValue: string;
    evidence: string;
    confidence: number;
    impact: 'minor' | 'major';
    status: StatePatchStatus;
    sourceEntryIds: number[];
    createdAt: Date;
    appliedAt: Date | null;
}
/** A compressed, auditable layer of setting evolution. Raw applied patches
 * remain intact and are only marked compacted after a snapshot is stored. */
export interface OverlaySnapshot {
    id: number;
    storyId: string;
    participantId: string;
    target: StatePatchTarget;
    /** Kept as weekly/monthly for database compatibility; runtime windows are
     * five days and ten days respectively. */
    tier: 'weekly' | 'monthly';
    periodStart: Date;
    periodEnd: Date;
    summary: string;
    majorEvents: string[];
    sourcePatchIds: number[];
    status: 'active' | 'superseded';
    createdAt: Date;
    updatedAt: Date;
}
export interface NarrativeFact {
    id: number;
    storyId: string;
    /** Empty means a world-wide fact; otherwise it is relationship-specific. */
    participantId: string;
    scope: 'character' | 'world' | 'relationship' | 'event' | 'promise';
    content: string;
    importance: number;
    confidence: number;
    unresolved: boolean;
    embedding?: number[];
    status: 'active' | 'superseded';
    sourceEntryIds: number[];
    lastSeenAt: Date;
    createdAt: Date;
    updatedAt: Date;
}
export type IntentStatus = 'pending' | 'completed' | 'cancelled';
export interface NarrativeIntent {
    id: number;
    storyId: string;
    /** Target private-message relationship for a future contact. */
    participantId: string;
    type: string;
    summary: string;
    notBefore: Date;
    status: IntentStatus;
    payload: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
}
/** A bounded, read-only observation collected through Koishi Puppeteer.
 * Web pages are untrusted source material: only the extracted text below is
 * sent back to the narrator, never page HTML, scripts, cookies, or actions. */
export interface WebObservation {
    id: number;
    storyId: string;
    /** Empty means a world-level observation; otherwise it belongs to one relationship. */
    participantId: string;
    intentId: number | null;
    mode: 'search' | 'visit';
    query: string;
    url: string;
    title: string;
    excerpt: string;
    summary: string;
    status: 'success' | 'failed' | 'blocked' | 'deleted';
    accessedAt: Date;
    createdAt: Date;
}
export interface ScriptEntryDraft {
    kind: string;
    actor?: string;
    content: string;
    occurredAt?: string;
    metadata?: Record<string, unknown>;
}
export interface MemoryDraft {
    category: string;
    content: string;
    importance?: number;
    participantId?: string;
}
export interface IntentDraft {
    type: string;
    summary: string;
    notBefore: string;
    payload?: Record<string, unknown>;
    participantId?: string;
}
/** A narrator may close an active narrative consequence once the script has
 * naturally absorbed it. Scheduled intents complete through their due-turn
 * path, so this is deliberately limited to existing persistent context. */
export interface IntentUpdateDraft {
    id: number;
    status: 'completed' | 'cancelled';
    resolution?: string;
}
export interface OutgoingMessageDraft {
    participantId: string;
    content: string;
    /** Attached only to no-current-user background deliveries. */
    automaticDelivery?: Pick<AutomaticDeliverySummary, 'summary' | 'sourceEntryId'>;
}
/** A future browsing action proposed by the narrator. It is not an observed
 * fact until Puppeteer finishes and produces a WebObservation. */
export interface BrowserIntentDraft {
    mode: 'search' | 'visit';
    query?: string;
    url?: string;
    purpose: string;
    timing?: 'deferred' | 'immediate';
    participantId?: string;
}
/** Browser actions available for this single narrative turn. Omitted when the
 * configured Puppeteer service is unavailable, so the model never plans an
 * action that cannot execute. */
export interface BrowserCapabilities {
    search: boolean;
    visit: boolean;
    immediate: boolean;
}
/** A message to another relationship branch generated in the same writing turn. */
export interface ConversationActionDraft {
    participantId: string;
    mode: 'immediate' | 'delayed';
    content: string;
    sendAt?: string;
    /** 0..1: how strongly the protagonist actually wants to initiate contact now. */
    willingness?: number;
    /** Short audit note explaining the concrete reason for this contact. */
    reason?: string;
}
export type InteractionReplyMode = 'none' | 'immediate' | 'delayed';
export interface NarrativeInteraction {
    seen: boolean;
    reply: {
        mode: InteractionReplyMode;
        content?: string;
        sendAt?: string;
        /** Opaque current-turn message reference; accepted only when the host advertises quote reply. */
        replyTo?: string;
    };
}
export type ChatReactionName = 'like' | 'smile' | 'laugh' | 'heart' | 'surprised' | 'sad' | 'angry';
export type NativeFaceSemantic = 'smile' | 'laugh' | 'sweat' | 'awkward' | 'heart' | 'surprised' | 'sad' | 'angry';
/** Capabilities are transient and appear in a prompt only after both Console
 * configuration and a live platform connector allow them. */
export interface ChatActionCapabilities {
    platform: 'qq' | 'wechat';
    quoteReply: boolean;
    reactions: ChatReactionName[];
    nativeFaces?: NativeFaceSemantic[];
    expressionThreshold?: number;
}
export interface MessageReactionDraft {
    messageRef: string;
    reaction: ChatReactionName;
}
export interface StickerCatalogEntry {
    assetId: string;
    group: string;
    description: string;
    aliases: string[];
    animated: boolean;
}
export interface LocalMediaDraft {
    assetId: string;
    placement?: 'standalone' | 'after-text';
    willingness?: number;
}
export interface NativeFaceDraft {
    semantic: NativeFaceSemantic;
    willingness: number;
}
export interface StickerAsset {
    id: number;
    assetId: string;
    filePath: string;
    group: string;
    mimeType: string;
    animated: boolean;
    size: number;
    hash: string;
    description: string;
    aliases: string[];
    status: 'pending' | 'active' | 'missing';
    createdAt: Date;
    updatedAt: Date;
}
/** A bounded snapshot of the message explicitly quoted by the incoming turn. */
export interface QuotedMessageContext {
    senderId: string;
    senderName: string;
    speaker: string;
    content: string;
}
export interface IndexedQuotedMessageContext extends QuotedMessageContext {
    messageIndex: number;
}
export type FollowUpCommitmentKind = 'thinking' | 'checking' | 'decision' | 'emotional-settle';
/** A user-facing promise to return with an answer; persisted as an existing intent row. */
export interface FollowUpCommitmentDraft {
    kind: FollowUpCommitmentKind;
    summary: string;
    notBefore: string;
    expiresAt?: string;
    sourceEntryIds?: number[];
}
export interface FollowUpResolutionDraft {
    id: number;
    outcome: 'fulfilled' | 'rescheduled' | 'cancelled';
    notBefore?: string;
}
export interface NarrativeDecision {
    /** The continuous prose written by the main narrative model. */
    script?: string;
    /** Net atmosphere movement introduced by this turn: -5 relaxed, +5 serious. */
    alter?: number;
    /** Optional external-action capacity update; it never controls prose style. */
    agencyWindow?: Partial<AgencyWindowState>;
    /** Optional life-grounded contact decision for advance/proactive-check turns. */
    proactiveContact?: ProactiveContactDraft;
    /** Present only when the request explicitly asks for a low-frequency continuity refresh. */
    continuity?: ContinuitySnapshot;
    /** The machine-readable result placed after the prose. */
    interaction?: NarrativeInteraction;
    /** Required when a visible user-turn reply promises a later answer. */
    followUpCommitment?: FollowUpCommitmentDraft;
    /** Resolves a visible pending commitment on a live or due turn. */
    followUpResolutions?: FollowUpResolutionDraft[];
    /** Required only for an immediate background delivery; it records the newly communicated delta. */
    automaticDeliverySummary?: string;
    memories?: MemoryDraft[];
    intents?: IntentDraft[];
    /** Resolves existing active-consequence intents visible in this turn. */
    intentUpdates?: IntentUpdateDraft[];
    browserIntents?: BrowserIntentDraft[];
    /** Applies to the current participant only; world state uses compaction proposals. */
    statePatch?: Partial<ParticipantState>;
    /** Optional outbound actions aimed at other accounts in the same main story. */
    crossConversationActions?: ConversationActionDraft[];
    /** Optional visible reply to the configured OneBot group that caused this turn. */
    groupReply?: {
        mode: 'none' | 'immediate';
        content?: string;
        /** Opaque reference selected from the current groupContext only. */
        replyTo?: string;
    };
    /** At most one validated reaction is executed in the current implementation. */
    messageReactions?: MessageReactionDraft[];
    /** Exact local sticker selected from the transient catalog for this live turn. */
    localMedia?: LocalMediaDraft;
    /** One optional semantic QQ native-face expression for the current live reply. */
    nativeFace?: NativeFaceDraft;
}
export type NarrativePhase = 'advance' | 'conversation-follow-up' | 'user-message' | 'intent-due';
/** A transient native-vision attachment for the current private-message turn.
 * It is intentionally never persisted in script entries, memories, or facts. */
export interface NarrativeImage {
    id: string;
    mimeType: string;
    dataUri: string;
}
export interface NarrativeRequest {
    /** 主模型只读取经过预算控制的连续性包，不读取完整历史。 */
    phase: NarrativePhase;
    /** Refresh the compact continuity note on this turn. */
    refreshContinuity?: boolean;
    /** A prior unpublished draft omitted its required visible-reply structure. */
    outputRecovery?: boolean;
    story: InterludeStory;
    from: Date;
    now: Date;
    userMessage?: string;
    /** Native image inputs observed in this one incoming user event only. */
    images?: NarrativeImage[];
    /** The relationship that caused this turn; null for unattended life updates. */
    participant: InterludeParticipant | null;
    /** Other currently enrolled relationship branches, ordered by relevance. */
    participants: InterludeParticipant[];
    /** Sensitive details of other participants are opt-in because the model may be remote. */
    shareParticipantDetails: boolean;
    dueIntents: NarrativeIntent[];
    /** Consequences already in motion. They are context, never newly due events. */
    activeConsequences: NarrativeIntent[];
    supersededIntents: NarrativeIntent[];
    recentEntries: ScriptEntry[];
    memories: NarrativeMemory[];
    sceneContext?: SceneContext;
    facts?: NarrativeFact[];
    /** Older setting evolution, separated from the live three-day overlay. */
    overlaySnapshots?: OverlaySnapshot[];
    /** Recent, safety-filtered web observations available as narrative context. */
    webContext?: WebObservation[];
    /** Present only for a group-scene turn; private-message privacy remains unchanged. */
    groupContext?: GroupContext;
    /** Present only when one or more messages in the current private batch quote earlier content. */
    quotedMessages?: IndexedQuotedMessageContext[];
    /** Omitted entirely unless the active platform has registered, enabled actions. */
    chatCapabilities?: ChatActionCapabilities;
    /** Omitted unless the local sticker library is enabled, populated and usable on this turn. */
    stickerCatalog?: StickerCatalogEntry[];
    /** Omitted unless read-only Puppeteer research is usable on this turn. */
    browserCapabilities?: BrowserCapabilities;
    alterEnabled?: boolean;
    emotionalOffset?: EmotionalOffsetPrompt | null;
    agencyEnabled?: boolean;
    agencyWindow?: AgencyWindowState | null;
    /** Present only for background advance/follow-up turns. */
    automaticDeliverySummaries?: AutomaticDeliverySummary[];
    /** At most two relationship-local promises, included only on live/due turns. */
    followUpCommitments?: NarrativeIntent[];
}
export interface GroupMessageContext {
    senderId: string;
    senderName: string;
    /** A human-readable, stable identity label for prompt rendering. */
    speaker: string;
    /** Opaque prompt-safe reference. Undefined when the adapter supplied no targetable message id. */
    messageRef?: string;
    /** Runtime-only adapter id; never serialized into the model prompt. */
    messageId?: string;
    /** Present only when this incoming group message explicitly quotes another message. */
    quote?: QuotedMessageContext;
    content: string;
    occurredAt: Date;
    direction?: 'user' | 'character';
}
export interface GroupContext {
    groupId: string;
    channelId: string;
    label: string;
    purpose: string;
    characterRole: string;
    messages: GroupMessageContext[];
}
export interface NarrativeProvider {
    decide(request: NarrativeRequest): Promise<NarrativeDecision>;
    /** A low-frequency side analysis; absent providers leave the trigger pending. */
    analyzeAlter?(request: AlterAnalysisRequest, config: AlterSystemConfig): Promise<AlterAnalysisDecision>;
}
export declare const emptyStorySetting: () => StorySetting;
export declare const emptyStoryState: () => StoryState;
export declare const emptyParticipantState: () => ParticipantState;
export interface SceneContext {
    scene: InterludeScene | null;
    arc: InterludeArc | null;
}
export interface CompactionRequest {
    /**
     * 后台压缩只处理已发生、且尚未写进当前场景摘要的原始条目。
     * 它与主叙事回合分离，不能增加用户发送消息时的等待时间。
     */
    story: InterludeStory;
    from: Date;
    now: Date;
    entries: ScriptEntry[];
    scene: InterludeScene | null;
    arc: InterludeArc | null;
    participants: InterludeParticipant[];
    facts: NarrativeFact[];
}
export interface FactDraft {
    scope: NarrativeFact['scope'];
    participantId?: string;
    content: string;
    importance?: number;
    confidence?: number;
    unresolved?: boolean;
    sourceEntryIds?: number[];
}
export interface StatePatchDraft {
    target: StatePatchTarget;
    participantId?: string;
    path: string;
    proposedValue: string;
    evidence: string;
    confidence?: number;
    impact?: 'minor' | 'major';
    sourceEntryIds?: number[];
}
export interface ScenePresenceDraft {
    name: string;
    status: ScenePresenceStatus;
    basis: string;
    sourceEntryIds: number[];
}
export interface CompactionDecision {
    scene?: {
        hook?: string;
        summary?: string;
        close?: boolean;
        presence?: ScenePresenceDraft[];
    };
    arc?: {
        title?: string;
        summary?: string;
    };
    facts?: FactDraft[];
    statePatches?: StatePatchDraft[];
}
export interface OverlayCompactionRequest {
    story: InterludeStory;
    participant?: InterludeParticipant;
    target: StatePatchTarget;
    tier: OverlaySnapshot['tier'];
    from: Date;
    to: Date;
    patches: StatePatchProposal[];
    snapshots?: OverlaySnapshot[];
}
export interface OverlayCompactionDecision {
    summary: string;
    majorEvents?: string[];
}
export interface NarrativeCompactor {
    compact(request: CompactionRequest): Promise<CompactionDecision>;
    compactOverlay(request: OverlayCompactionRequest): Promise<OverlayCompactionDecision>;
}
export interface NarrativeEmbedder {
    embed(input: string): Promise<number[]>;
}
export interface AlterSystemState {
    alterValue: number;
    alterWeight: number;
    lastTriggerDirection: -1 | 0 | 1;
    emotionalOffset: EmotionalOffset | null;
    history: AlterHistoryEntry[];
    lastUpdatedAt: string;
    lastAnalysisAttemptAt?: string;
}
export interface EmotionalOffset {
    direction: 'serious' | 'relaxed';
    description: string;
    intensity: number;
    generatedAt: string;
}
export interface EmotionalOffsetPrompt extends EmotionalOffset {
    weight: number;
}
export interface AlterHistoryEntry {
    turn: number;
    phase: NarrativePhase;
    alter: number;
    alterValue: number;
    timestamp: string;
}
export interface AlterAnalysisRequest {
    characterName: string;
    triggerValue: number;
    threshold: number;
    direction: 'serious' | 'relaxed';
    recentScripts: Array<{
        content: string;
        occurredAt: string;
    }>;
    history: AlterHistoryEntry[];
    settingOverlay: StorySettingOverlay;
    currentOffset: EmotionalOffsetPrompt | null;
}
export interface AlterAnalysisDecision {
    description: string;
}
export interface AlterSystemConfig {
    enabled: boolean;
    baseThreshold: number;
    densityFactor: number;
    sameDirectionBoost: number;
    oppositeDecay: number;
    minWeight: number;
    maxIntensity: number;
    modelId?: string;
    providerId?: string;
    model?: string;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    timeout?: number;
    prompt?: string;
}
