import { Context } from 'koishi';
import { AlterAnalysisDecision, AlterAnalysisRequest, AlterSystemConfig, ChatActionCapabilities, CompactionDecision, CompactionRequest, NarrativeDecision, NarrativeProvider, OverlayCompactionDecision, OverlayCompactionRequest, NarrativeCompactor, NarrativeEmbedder, NarrativeRequest, StickerCatalogEntry } from './types';
export { storyLocalTimeContext } from './time';
export type ProviderResponseFormat = 'json-object' | 'prompt-only';
export type ProviderStrategy = 'priority' | 'round-robin';
export type ZhipuReasoningEffort = 'low' | 'high' | 'max';
export type ProviderMode = 'openai-compatible' | 'zhipu-official' | 'openai-official' | 'deepseek-official' | 'moonshot-official' | 'dashscope-official' | 'siliconflow-official' | 'openrouter' | 'gemini-openai';
export declare const ZHIPU_OFFICIAL_CHAT_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
export declare const ZHIPU_FIRST_VISIBLE_TOKEN_TIMEOUT = 45000;
export interface StickerDescription {
    description: string;
    aliases: string[];
}
export interface StickerDescriber {
    available(): boolean;
    describeSticker(dataUri: string, mimeType: string, fileName: string, animated: boolean): Promise<StickerDescription | undefined>;
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
    zhipuOfficial?: boolean;
    reasoningEffort?: ZhipuReasoningEffort;
    dashscopeRegion?: 'beijing' | 'singapore' | 'us';
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
    compaction?: CompactionConfig;
    embedding?: EmbeddingConfig;
    /** OpenAI-compatible native image inputs for the current private-message turn. */
    vision?: VisionConfig;
}
export interface VisionConfig {
    enabled: boolean;
}
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
    constructor(ctx: Context, config: ModelConfig);
    embed(input: string): Promise<number[]>;
    private selectProvider;
}
export declare class OpenAICompatibleNarrator implements NarrativeProvider {
    private ctx;
    private config;
    /**
     * 主写作与压缩共用服务商选择、冷却和 OpenAI 兼容协议；二者的提示词和
     * token/temperature 配置不同，因此同一个实例可承担两个接口。
     */
    private cooldownUntil;
    private roundRobinOffset;
    private readonly logger?;
    constructor(ctx: Context, config: ModelConfig, silentLogs?: boolean);
    private assignedProviders;
    available(): boolean;
    decide(request: NarrativeRequest): Promise<NarrativeDecision>;
    compact(request: CompactionRequest): Promise<CompactionDecision>;
    compactOverlay(request: OverlayCompactionRequest): Promise<OverlayCompactionDecision>;
    analyzeAlter(request: AlterAnalysisRequest, alterConfig: AlterSystemConfig): Promise<AlterAnalysisDecision>;
    describeSticker(dataUri: string, mimeType: string, fileName: string, animated: boolean): Promise<StickerDescription | undefined>;
    private selectProviders;
    private requestProvider;
}
export declare function createNarrator(ctx: Context, config: ModelConfig, silentLogs?: boolean): NarrativeProvider;
export declare function createStickerDescriber(ctx: Context, config: ModelConfig, silentLogs?: boolean): StickerDescriber;
/** A single enabled model preset is the natural main narrator. This keeps the
 * Console configuration linear while preserving explicit selection for
 * installations that deliberately configure several models. */
export declare function effectiveMainModelId(config: ModelConfig): string;
export declare function configuredProviders(config: ModelConfig): ProviderConfig[];
export declare function usesRemoteProviders(config: ModelConfig): boolean;
export declare function createCompactor(ctx: Context, config: ModelConfig, silentLogs?: boolean): NarrativeCompactor;
export declare function createEmbedder(ctx: Context, config: ModelConfig): NarrativeEmbedder;
export declare function systemPrompt(phase: NarrativeRequest['phase'], mainPrompt: string | undefined, formatPrompt: string | undefined, fixedPrompt: string, baseStylePrompt: string, storyStylePrompt: string, refreshContinuity?: boolean, alterEnabled?: boolean, agencyEnabled?: boolean, perspectiveEnabled?: boolean, outputRecovery?: boolean, chatCapabilities?: ChatActionCapabilities, hasQuotedMessage?: boolean, stickerCatalog?: StickerCatalogEntry[]): string;
export declare function storyStateForPrompt(state: NarrativeRequest['story']['state']): {
    settingOverlay: import("./types").StorySettingOverlay;
    activeSceneId?: number;
    activeArcId?: number;
    continuitySnapshot?: import("./types").ContinuitySnapshot;
    narrativeUpdateCount: number;
    lastContinuityUpdateAt?: string;
    automation: import("./types").StoryAutomationState;
    scenePresence?: import("./types").ScenePresenceState[];
};
export type RecentScriptOwnership = 'protagonist-narrative' | 'user-delivered-message' | 'protagonist-delivered-message' | 'external-group-message' | 'system-event';
export declare function recentScriptOwnership(entry: Pick<NarrativeRequest['recentEntries'][number], 'kind' | 'actor'>): RecentScriptOwnership;
export declare function toPromptPayload(request: NarrativeRequest): {
    dueIntents: {
        type: string;
        participantId: string;
        summary: string;
        notBefore: string;
        payload: Record<string, unknown>;
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
        scope: "character" | "world" | "relationship" | "event" | "promise";
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
        continuitySnapshot?: import("./types").ContinuitySnapshot;
        narrativeUpdateCount: number;
        lastContinuityUpdateAt?: string;
        automation: import("./types").StoryAutomationState;
        scenePresence?: import("./types").ScenePresenceState[];
    };
    continuitySnapshot: import("./types").ContinuitySnapshot;
    continuitySnapshotAgeMinutes: number;
    emotionalOffset: import("./types").EmotionalOffsetPrompt;
    agencyWindow: import("./types").AgencyWindowState;
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
        type: string;
        content: string;
        imageCount: number;
    };
    groupContext: {
        messages: {
            occurredAt: string;
            direction: "user" | "character";
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
};
export declare function promptVisibleMessageContent(content: string, ownership: RecentScriptOwnership): string;
