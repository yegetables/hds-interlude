import { Context } from 'koishi';
import { AlterAnalysisDecision, AlterAnalysisRequest, AlterSystemConfig, ChatActionCapabilities, CompactionDecision, CompactionRequest, NarrativeDecision, NarrativeProvider, OverlayCompactionDecision, OverlayCompactionRequest, EarlyNarrativeReply, NarrativeCompactor, NarrativeEmbedder, NarrativeImage, NarrativeRequest, SchedulePreplanProposal, SchedulePreplanReviewRequest, StickerCatalogEntry, TimelinePlan, TimelinePlanRequest } from './types';
export { storyLocalTimeContext } from './time';
export type ProviderResponseFormat = 'json-object' | 'prompt-only';
export type ProviderStrategy = 'priority' | 'round-robin';
export type ZhipuReasoningEffort = 'low' | 'high' | 'max';
export type DeepSeekThinkingMode = 'disabled' | 'enabled';
export type ProviderMode = 'openai-compatible' | 'zhipu-official' | 'openai-official' | 'deepseek-official' | 'moonshot-official' | 'dashscope-official' | 'siliconflow-official' | 'openrouter' | 'gemini-openai';
export declare const ZHIPU_OFFICIAL_CHAT_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
export declare const ZHIPU_FIRST_VISIBLE_TOKEN_TIMEOUT = 45000;
export interface StickerDescription {
    description: string;
    aliases: string[];
}
export interface StickerDescriber {
    available(): boolean;
    describeSticker(dataUri: string, mimeType: string, fileName: string, animated: boolean, responseFormat?: ProviderResponseFormat): Promise<StickerDescription | undefined>;
}
/** Converts current user images into factual text for a text-only main narrator.
 * Results are transient and deliberately have no memory API. */
export interface VisionDescriber {
    available(): boolean;
    describeImages(images: NarrativeImage[], userText?: string, detail?: VisionDetail): Promise<string[] | undefined>;
}
export interface ProviderConfig {
    /** Legacy internal identifier. New Console rows derive identity from the model connection. */
    id?: string;
    label: string;
    enabled: boolean;
    endpoint: string;
    apiKey: string;
    model: string;
    temperature: number;
    topP: number;
    maxTokens: number;
    timeout: number;
    responseFormat: ProviderResponseFormat;
    extraHeaders: string;
    extraBody: string;
    mode?: ProviderMode;
    /** One model connection can be assigned directly to each HDSI task. */
    useForMain?: boolean;
    useForCompaction?: boolean;
    useForAlter?: boolean;
    useForEmbedding?: boolean;
    useForStickers?: boolean;
    useForVision?: boolean;
    zhipuOfficial?: boolean;
    reasoningEffort?: ZhipuReasoningEffort;
    deepseekOfficial?: boolean;
    deepseekThinking?: DeepSeekThinkingMode;
    deepseekReasoningEffort?: ZhipuReasoningEffort;
    dashscopeRegion?: 'beijing' | 'singapore' | 'us';
    /** Optional billing prices per one million tokens; 0 disables cost logging. */
    priceInput?: number;
    priceOutput?: number;
    priceCachedInput?: number;
}
export interface FailoverConfig {
    enabled: boolean;
    strategy: ProviderStrategy;
    maxAttemptsPerProvider: number;
    cooldownMinutes: number;
}
export interface ModelConfig {
    /** @deprecated Remote mode is inferred from enabled provider rows. */
    mode?: 'fallback' | 'openai-compatible';
    providers: ProviderConfig[];
    failover: FailoverConfig;
    mainPrompt?: string;
    formatPrompt?: string;
    fixedPrompt: string;
    stylePrompt: string;
    /** Central model catalogue. Task-specific settings may reference an entry by id. */
    models?: ModelProfile[];
    mainModelId?: string;
    mainTemperature?: number;
    mainTopP?: number;
    mainMaxTokens?: number;
    mainTimeout?: number;
    mainResponseFormat?: ProviderResponseFormat;
    /** Manual opt-in for streaming JSON transport; unavailable providers remain on full-response mode. */
    mainStreamingMode?: 'off' | 'experimental';
    /** cache-first reorders the user payload so stable blocks (history, memory layers) precede
     * per-turn fields, letting provider prefix caches hit across consecutive turns. */
    mainPayloadOrder?: 'legacy' | 'cache-first';
    compaction?: CompactionConfig;
    embedding?: EmbeddingConfig;
    /** OpenAI-compatible native image inputs for the current private-message turn. */
    vision?: VisionConfig;
}
export interface VisionConfig {
    enabled: boolean;
    /** native passes image_url to main narration; sidecar makes temporary factual observations. */
    mode?: 'native' | 'sidecar';
    detail?: VisionDetail;
    /** Longest allowed image edge for native vision inputs; 0 disables downscaling.
     * Downscaling re-renders the image through the optional Puppeteer service and
     * silently passes the original through when Puppeteer is unavailable. */
    maxImageDimension?: 0 | 512 | 768 | 1024;
}
export type VisionDetail = 'low' | 'high' | 'auto';
export interface ModelProfile {
    id: string;
    label: string;
    enabled?: boolean;
    providerId: string;
    model: string;
    maxTokens: number;
    timeout: number;
    responseFormat: ProviderResponseFormat;
}
export interface CompactionConfig {
    enabled: boolean;
    modelId?: string;
    providerId: string;
    model: string;
    temperature: number;
    topP: number;
    maxTokens: number;
    timeout: number;
    responseFormat: ProviderResponseFormat;
    mainPrompt?: string;
    fixedPrompt: string;
    stylePrompt: string;
}
/**
 * Embedding is deliberately configured separately from chat generation. A single
 * provider can be reused for its credentials, while the endpoint and model may
 * point at a cheaper or local vector model.
 */
export interface EmbeddingConfig {
    enabled: boolean;
    /** Enable semantic query embedding on the latency-sensitive live turn. */
    liveQuery?: boolean;
    /** Filter the sticker catalog to the most semantically relevant entries before injection. */
    semanticStickerFilter?: boolean;
    /** Vectorize raw history entries and recall the most relevant older moments per turn. */
    semanticHistory?: boolean;
    /** Reuses apiKey and extraHeaders from a configured chat provider. */
    providerId: string;
    modelId?: string;
    /** OpenAI-compatible /embeddings endpoint. Leave empty to derive it from the chat endpoint. */
    endpoint: string;
    model: string;
    /** 0 omits the optional OpenAI dimensions parameter. */
    dimensions: number;
    timeout: number;
    maxInputCharacters: number;
    /** Number of legacy facts to vectorize in each background maintenance pass. */
    backfillBatchSize: number;
}
export declare class SilentNarrator implements NarrativeProvider {
    decide(): Promise<NarrativeDecision>;
}
export declare class SilentCompactor implements NarrativeCompactor {
    compact(): Promise<CompactionDecision>;
    compactOverlay(): Promise<OverlayCompactionDecision>;
    planSchedulePreplan(): Promise<SchedulePreplanProposal | undefined>;
    planTimeline(): Promise<TimelinePlan | undefined>;
}
/** A no-op embedder lets memory retrieval fall back to rule-based ranking. */
export declare class SilentEmbedder implements NarrativeEmbedder {
    embed(): Promise<number[]>;
}
/**
 * Minimal OpenAI-compatible embedding client. It intentionally performs no
 * chat-provider failover: an embedding failure is non-fatal and the caller
 * simply uses importance/confidence/recency ranking for that turn.
 */
export declare class OpenAICompatibleEmbedder implements NarrativeEmbedder {
    private ctx;
    private config;
    private readonly providers;
    constructor(ctx: Context, config: ModelConfig);
    embed(input: string): Promise<number[]>;
    private selectProvider;
}
export declare class OpenAICompatibleNarrator implements NarrativeProvider {
    private ctx;
    private config;
    private onUsage?;
    /**
     * 主写作与压缩共用服务商选择、冷却和 OpenAI 兼容协议；二者的提示词和
     * token/temperature 配置不同，因此同一个实例可承担两个接口。
     */
    private cooldownUntil;
    private roundRobinOffset;
    private readonly logger?;
    private readonly providers;
    constructor(ctx: Context, config: ModelConfig, silentLogs?: boolean, onUsage?: (record: TokenUsageRecord) => void);
    private assignedProviders;
    available(): boolean;
    visionAvailable(): boolean;
    decide(request: NarrativeRequest): Promise<NarrativeDecision>;
    compact(request: CompactionRequest): Promise<CompactionDecision>;
    planTimeline(request: TimelinePlanRequest): Promise<TimelinePlan | undefined>;
    planSchedulePreplan(request: SchedulePreplanReviewRequest): Promise<SchedulePreplanProposal | undefined>;
    compactOverlay(request: OverlayCompactionRequest): Promise<OverlayCompactionDecision>;
    analyzeAlter(request: AlterAnalysisRequest, alterConfig: AlterSystemConfig): Promise<AlterAnalysisDecision>;
    describeSticker(dataUri: string, mimeType: string, fileName: string, animated: boolean, responseFormat?: ProviderResponseFormat): Promise<StickerDescription | undefined>;
    describeImages(images: NarrativeImage[], userText?: string, detail?: VisionDetail): Promise<string[] | undefined>;
    /** Record one provider response's token usage (if the provider reports any). */
    private collectUsage;
    private emitUsage;
    private selectProviders;
    private requestProvider;
}
export declare function createNarrator(ctx: Context, config: ModelConfig, silentLogs?: boolean, onUsage?: (record: TokenUsageRecord) => void): NarrativeProvider;
export declare function createStickerDescriber(ctx: Context, config: ModelConfig, silentLogs?: boolean, onUsage?: (record: TokenUsageRecord) => void): StickerDescriber;
export declare function createVisionDescriber(ctx: Context, config: ModelConfig, silentLogs?: boolean, onUsage?: (record: TokenUsageRecord) => void): VisionDescriber;
/** A single enabled model preset is the natural main narrator. This keeps the
 * Console configuration linear while preserving explicit selection for
 * installations that deliberately configure several models. */
export declare function effectiveMainModelId(config: ModelConfig): string;
export declare function configuredProviders(config: ModelConfig): ProviderConfig[];
export declare function usesRemoteProviders(config: ModelConfig): boolean;
export declare function createCompactor(ctx: Context, config: ModelConfig, silentLogs?: boolean, onUsage?: (record: TokenUsageRecord) => void): NarrativeCompactor;
export declare function createEmbedder(ctx: Context, config: ModelConfig): NarrativeEmbedder;
/** Returns the first complete transport object while the rest of the JSON is
 * still arriving. The contract asks for this field first, but scanning only
 * accepts a fully closed top-level value and never sends partial text. */
export declare function extractEarlyNarrativeReply(raw: string, group: boolean): EarlyNarrativeReply | undefined;
/** Normalized token accounting for one provider response. `cachedInputTokens`
 * is the provider-reported subset of input tokens served from prefix cache. */
export interface TokenUsageRecord {
    task: string;
    providerLabel: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    /** Prices per one million tokens; 0/undefined disables cost reporting. */
    priceInput?: number;
    priceOutput?: number;
    priceCachedInput?: number;
}
/** Accepts the OpenAI `usage` shape, DeepSeek's legacy cache fields, or anything
 * providers invent; unknown shapes simply yield an empty record. */
export declare function parseTokenUsage(usage: unknown): {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
};
/** Sum usage across attempts (failover/recovery each consume tokens); identity
 * and pricing come from the last record, i.e. the attempt that produced the
 * final answer. */
export declare function aggregateTokenUsages(records: TokenUsageRecord[]): TokenUsageRecord | undefined;
/** Billing for one record. Cached tokens are a subset of input tokens and are
 * billed at the cache price; everything else at the plain input price. */
export declare function computeTokenCost(record: TokenUsageRecord): {
    inputCost: number;
    outputCost: number;
    total: number;
    saved: number;
} | undefined;
/** One human-readable log line: usage numbers, cache hit rate, and optional
 * billing. Absent fields are simply omitted instead of printed as zero. */
export declare function formatTokenUsageLine(record: TokenUsageRecord): string;
export declare function systemPrompt(phase: NarrativeRequest['phase'], mainPrompt: string | undefined, formatPrompt: string | undefined, fixedPrompt: string, baseStylePrompt: string, storyStylePrompt: string, _refreshContinuity?: boolean, alterEnabled?: boolean, agencyEnabled?: boolean, perspectiveEnabled?: boolean, outputRecovery?: boolean, chatCapabilities?: ChatActionCapabilities, hasQuotedMessage?: boolean, stickerCatalog?: StickerCatalogEntry[], schedulePreplanEnabled?: boolean, streamingReplyFirst?: boolean, cacheFirstPayload?: boolean): string;
export declare function storyStateForPrompt(state: NarrativeRequest['story']['state']): {
    settingOverlay: import("./types").StorySettingOverlay;
    activeSceneId?: number;
    activeArcId?: number;
    narrativeUpdateCount: number;
    lastContinuityUpdateAt?: string;
    automation: import("./types").StoryAutomationState;
    scenePresence?: import("./types").ScenePresenceState[];
};
export type RecentScriptOwnership = 'protagonist-narrative' | 'user-delivered-message' | 'protagonist-delivered-message' | 'external-group-message' | 'system-event';
export declare function recentScriptOwnership(entry: Pick<NarrativeRequest['recentEntries'][number], 'kind' | 'actor'>): RecentScriptOwnership;
export declare function toPromptPayload(request: NarrativeRequest, options?: {
    cacheFirst?: boolean;
}): {
    dueIntents: {
        type: string;
        participantId: string;
        summary: string;
        notBefore: string;
        payload: Record<string, unknown>;
    }[];
    upcomingPlans: {
        id: number;
        type: string;
        participantId: string;
        summary: string;
        notBefore: string;
    }[];
    followUpCommitments: {
        id: number;
        kind: unknown;
        summary: string;
        notBefore: string;
        expiresAt: string;
        sourceEntryIds: any[];
    }[];
    activeConsequences: {
        id: number;
        participantId: string;
        summary: string;
        startedAt: string;
        effect: string;
        strength: number;
        expiresAt: string;
    }[];
    workingDetails: {
        expiresAt?: string;
        label: string;
        value: string;
    }[];
    recalledHistory: {
        id: number;
        occurredAt: string;
        content: string;
    }[];
    interruptedOutgoingDrafts: {
        participantId: string;
        content: string;
        narrativeContext: string;
        interruptedAt: string;
    }[];
    supersededDelayedReplies: {
        participantId: string;
        summary: string;
        notBefore: string;
        payload: Record<string, unknown>;
    }[];
    memories: {
        participantId: string;
        category: string;
        content: string;
        importance: number;
    }[];
    durableFacts: {
        participantId: string;
        scope: "character" | "relationship" | "world" | "event" | "promise";
        content: string;
        importance: number;
        confidence: number;
    }[];
    overlayEvolution: {
        content: string;
        target: import("./types").StatePatchTarget;
        tier: "weekly" | "monthly";
        participantId: string;
        periodStart: string;
        periodEnd: string;
        majorEvents: string[];
    }[];
    webContext: {
        mode: "search" | "visit";
        query: string;
        url: string;
        title: string;
        excerpt: string;
        summary: string;
        status: "success" | "failed" | "blocked" | "deleted";
        accessedAt: string;
    }[];
    recentScript: {
        id: number;
        participantId: string;
        kind: string;
        actor: string;
        ownership: RecentScriptOwnership;
        content: string;
        occurredAt: string;
        occurredAtLocal: string;
    }[];
    stickerCatalog?: StickerCatalogEntry[];
    chatCapabilities?: ChatActionCapabilities;
    phase: import("./types").NarrativePhase;
    refreshContinuity: boolean;
    outputRecovery: boolean;
    interval: {
        from: string;
        now: string;
        storyTimezone: string;
        fromLocal: string;
        nowLocal: string;
        fromLocalContext: {
            timezone: string;
            utc: string;
            local: string;
            date: string;
            time: string;
            hour: number;
            weekday: string;
            offset: string;
            period: string;
            periodZh: "上午" | "下午" | "傍晚/晚上" | "夜间";
            daylightExpectation: string;
        };
        nowLocalContext: {
            timezone: string;
            utc: string;
            local: string;
            date: string;
            time: string;
            hour: number;
            weekday: string;
            offset: string;
            period: string;
            periodZh: "上午" | "下午" | "傍晚/晚上" | "夜间";
            daylightExpectation: string;
        };
        elapsedSeconds: number;
    };
    timelinePlan: {
        carry?: string[];
        beats: {
            at: number;
            kind: import("./types").TimelineBeatKind;
            summary: string;
        }[];
    };
    timelineCarry: string[];
    setting: {
        perspective: string;
        user: {
            displayName: string;
            profile: string;
        };
        relationship: string;
        character: import("./types").CharacterSetting;
        world: string;
        supportingCast: string;
        location: string;
        style: string;
        timezone: string;
    };
    state: {
        settingOverlay: import("./types").StorySettingOverlay;
        activeSceneId?: number;
        activeArcId?: number;
        narrativeUpdateCount: number;
        lastContinuityUpdateAt?: string;
        automation: import("./types").StoryAutomationState;
        scenePresence?: import("./types").ScenePresenceState[];
    };
    continuitySnapshot: {
        next: any[];
        current: string;
        recent: string[];
        salient: string[];
    };
    continuitySnapshotAgeMinutes: number;
    emotionalOffset: import("./types").EmotionalOffsetPrompt;
    agencyWindow: import("./types").AgencyWindowState;
    schedulePreplan: import("./types").SchedulePreplanWindow;
    automaticDeliverySummaries: {
        participantId: string;
        summary: string;
        sourceEntryId: number;
        deliveredAt: string;
    }[];
    currentParticipant: {
        unreadMessageCount: number;
        pendingReplyCount: number;
        updatedAt: string;
        personId?: string;
        openThreads?: string[];
        relationshipNotes?: string[];
        displayName?: string;
        profile?: string;
        relationship?: string;
        relationshipOverlay?: string;
        lastUserMessageAt?: string;
        lastCharacterMessageAt?: string;
        id: string;
    };
    participants: {
        unreadMessageCount: number;
        pendingReplyCount: number;
        updatedAt: string;
        personId?: string;
        openThreads?: string[];
        relationshipNotes?: string[];
        displayName?: string;
        profile?: string;
        relationship?: string;
        relationshipOverlay?: string;
        lastUserMessageAt?: string;
        lastCharacterMessageAt?: string;
        id: string;
    }[];
    sceneContext: import("./types").SceneContext;
    currentEvent: {
        type: string;
    } | {
        quotedMessages?: import("./types").IndexedQuotedMessageContext[];
        visualObservations?: string[];
        userReportedTimes?: import("./types").UserReportedTime[];
        type: string;
        content: string;
        imageCount: number;
        observedAt: string;
        observedAtLocal: string;
    };
    groupContext: {
        messages: {
            occurredAt: string;
            direction: "character" | "user";
            quote?: import("./types").QuotedMessageContext;
            senderId: string;
            senderName: string;
            content: string;
            messageRef?: string;
            speaker: string;
        }[];
        groupId: string;
        channelId: string;
        label: string;
        purpose: string;
        characterRole: string;
    };
} | {
    phase: import("./types").NarrativePhase;
    refreshContinuity: boolean;
    outputRecovery: boolean;
    interval: {
        from: string;
        now: string;
        storyTimezone: string;
        fromLocal: string;
        nowLocal: string;
        fromLocalContext: {
            timezone: string;
            utc: string;
            local: string;
            date: string;
            time: string;
            hour: number;
            weekday: string;
            offset: string;
            period: string;
            periodZh: "上午" | "下午" | "傍晚/晚上" | "夜间";
            daylightExpectation: string;
        };
        nowLocalContext: {
            timezone: string;
            utc: string;
            local: string;
            date: string;
            time: string;
            hour: number;
            weekday: string;
            offset: string;
            period: string;
            periodZh: "上午" | "下午" | "傍晚/晚上" | "夜间";
            daylightExpectation: string;
        };
        elapsedSeconds: number;
    };
    continuitySnapshotAgeMinutes: number;
    recalledHistory: {
        id: number;
        occurredAt: string;
        content: string;
    }[];
    currentEvent: {
        type: string;
    } | {
        quotedMessages?: import("./types").IndexedQuotedMessageContext[];
        visualObservations?: string[];
        userReportedTimes?: import("./types").UserReportedTime[];
        type: string;
        content: string;
        imageCount: number;
        observedAt: string;
        observedAtLocal: string;
    };
    recentExchange: {
        tag: string;
        content: string;
    }[];
    chatCapabilities?: ChatActionCapabilities;
    sceneContext: import("./types").SceneContext;
    continuitySnapshot: {
        next: any[];
        current: string;
        recent: string[];
        salient: string[];
    };
    workingDetails: {
        expiresAt?: string;
        label: string;
        value: string;
    }[];
    schedulePreplan: import("./types").SchedulePreplanWindow;
    webContext: {
        mode: "search" | "visit";
        query: string;
        url: string;
        title: string;
        excerpt: string;
        summary: string;
        status: "success" | "failed" | "blocked" | "deleted";
        accessedAt: string;
    }[];
    currentParticipant: {
        unreadMessageCount: number;
        pendingReplyCount: number;
        updatedAt: string;
        personId?: string;
        openThreads?: string[];
        relationshipNotes?: string[];
        displayName?: string;
        profile?: string;
        relationship?: string;
        relationshipOverlay?: string;
        lastUserMessageAt?: string;
        lastCharacterMessageAt?: string;
        id: string;
    };
    participants: {
        unreadMessageCount: number;
        pendingReplyCount: number;
        updatedAt: string;
        personId?: string;
        openThreads?: string[];
        relationshipNotes?: string[];
        displayName?: string;
        profile?: string;
        relationship?: string;
        relationshipOverlay?: string;
        lastUserMessageAt?: string;
        lastCharacterMessageAt?: string;
        id: string;
    }[];
    state: {
        settingOverlay: import("./types").StorySettingOverlay;
        activeSceneId?: number;
        activeArcId?: number;
        narrativeUpdateCount: number;
        lastContinuityUpdateAt?: string;
        automation: import("./types").StoryAutomationState;
        scenePresence?: import("./types").ScenePresenceState[];
    };
    emotionalOffset: import("./types").EmotionalOffsetPrompt;
    agencyWindow: import("./types").AgencyWindowState;
    automaticDeliverySummaries: {
        participantId: string;
        summary: string;
        sourceEntryId: number;
        deliveredAt: string;
    }[];
    followUpCommitments: {
        id: number;
        kind: unknown;
        summary: string;
        notBefore: string;
        expiresAt: string;
        sourceEntryIds: any[];
    }[];
    dueIntents: {
        type: string;
        participantId: string;
        summary: string;
        notBefore: string;
        payload: Record<string, unknown>;
    }[];
    upcomingPlans: {
        id: number;
        type: string;
        participantId: string;
        summary: string;
        notBefore: string;
    }[];
    activeConsequences: {
        id: number;
        participantId: string;
        summary: string;
        startedAt: string;
        effect: string;
        strength: number;
        expiresAt: string;
    }[];
    interruptedOutgoingDrafts: {
        participantId: string;
        content: string;
        narrativeContext: string;
        interruptedAt: string;
    }[];
    supersededDelayedReplies: {
        participantId: string;
        summary: string;
        notBefore: string;
        payload: Record<string, unknown>;
    }[];
    groupContext: {
        messages: {
            occurredAt: string;
            direction: "character" | "user";
            quote?: import("./types").QuotedMessageContext;
            senderId: string;
            senderName: string;
            content: string;
            messageRef?: string;
            speaker: string;
        }[];
        groupId: string;
        channelId: string;
        label: string;
        purpose: string;
        characterRole: string;
    };
    stickerCatalog?: StickerCatalogEntry[];
    setting: {
        perspective: string;
        user: {
            displayName: string;
            profile: string;
        };
        relationship: string;
        character: import("./types").CharacterSetting;
        world: string;
        supportingCast: string;
        location: string;
        style: string;
        timezone: string;
    };
    recentScript: {
        content: string;
        occurredAt: string;
        occurredAtLocal: string;
        participantId?: string;
        id: number;
        tag: string;
    }[];
    durableFacts: {
        participantId: string;
        scope: "character" | "relationship" | "world" | "event" | "promise";
        content: string;
        importance: number;
        confidence: number;
    }[];
    memories: {
        participantId: string;
        category: string;
        content: string;
        importance: number;
    }[];
    overlayEvolution: {
        content: string;
        target: import("./types").StatePatchTarget;
        tier: "weekly" | "monthly";
        participantId: string;
        periodStart: string;
        periodEnd: string;
        majorEvents: string[];
    }[];
};
/** Compact ownership tags for cache-first payloads: one short label replaces the
 * kind/actor/participantId triple. Distinctions the ownership label alone would
 * lose (group posting, platform actions) survive as suffixes. */
export declare function compactScriptTag(kind: string, actor: string): "system" | "user" | "protagonist(group)" | "protagonist(action)" | "protagonist" | "protagonist-narration" | "group-member";
export declare function promptVisibleMessageContent(content: string, ownership: RecentScriptOwnership): string;
