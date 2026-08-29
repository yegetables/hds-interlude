/**
 * A deliberately small, model-free willingness layer for group chat. It is
 * inspired by the local score / decay / probability pattern used by YesImBot
 * v3, but remains scoped to one HDSI group and never affects private turns,
 * Agency Window, Alter, prompts, or durable story state.
 */
export interface GroupWillingnessConfig {
    enabled: boolean;
    maxScore: number;
    threshold: number;
    probabilityAmplifier: number;
    decayHalfLifeSeconds: number;
    replyCost: number;
    baseGain: number;
    quoteGain: number;
    keywordGain: number;
    keywords: string[];
}
export interface GroupWillingnessState {
    score: number;
    updatedAt: number;
}
export type GroupWillingnessReason = 'disabled' | 'forced-mention' | 'below-threshold' | 'probability-roll';
export interface GroupWillingnessDecision {
    state: GroupWillingnessState;
    shouldCall: boolean;
    probability: number;
    reason: GroupWillingnessReason;
}
export declare const DEFAULT_GROUP_WILLINGNESS: GroupWillingnessConfig;
export declare function resolveGroupWillingness(config?: Partial<GroupWillingnessConfig>): GroupWillingnessConfig;
export declare function evaluateGroupWillingness(previous: GroupWillingnessState | undefined, configInput: Partial<GroupWillingnessConfig> | undefined, input: {
    now: number;
    messageCount: number;
    content: string;
    quotedBot: boolean;
    mentionedBot: boolean;
    random?: number;
}): GroupWillingnessDecision;
export declare function consumeGroupWillingness(previous: GroupWillingnessState | undefined, configInput: Partial<GroupWillingnessConfig> | undefined, now: number): GroupWillingnessState;
