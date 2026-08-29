import { AlterHistoryEntry, AlterSystemConfig, AlterSystemState, EmotionalOffsetPrompt, NarrativePhase } from './types';
export declare const DEFAULT_ALTER_SYSTEM_CONFIG: AlterSystemConfig;
export interface AlterTurnResult {
    state: AlterSystemState;
    threshold: number;
    offsetExpired: boolean;
    thresholdReached: boolean;
}
export declare function resolveAlterSystemConfig(value?: Partial<AlterSystemConfig>): AlterSystemConfig;
export declare function normalizeAlterValue(value: unknown): number | undefined;
export declare function createAlterSystemState(now?: Date): AlterSystemState;
export declare function normalizeAlterSystemState(value: unknown): AlterSystemState | undefined;
export declare function calculateAlterThreshold(history: AlterHistoryEntry[], config: AlterSystemConfig, now?: Date): number;
export declare function adjustAlterWeight(weight: number, sameDirection: boolean, magnitude: number, config: AlterSystemConfig): number;
export declare function advanceAlterSystem(current: AlterSystemState | undefined, alter: number, phase: NarrativePhase, now: Date, config: AlterSystemConfig): AlterTurnResult;
export declare function completeAlterAnalysis(state: AlterSystemState, description: string, threshold: number, now: Date, config: AlterSystemConfig): {
    alterValue: number;
    alterWeight: number;
    lastTriggerDirection: 1 | -1;
    emotionalOffset: {
        direction: "serious" | "relaxed";
        description: string;
        intensity: number;
        generatedAt: string;
    };
    lastUpdatedAt: string;
    history: AlterHistoryEntry[];
    lastAnalysisAttemptAt?: string;
};
export declare function emotionalOffsetForPrompt(state: AlterSystemState | undefined, config: AlterSystemConfig): EmotionalOffsetPrompt | null;
export declare function alterAnalysisCoolingDown(state: AlterSystemState, now?: Date, cooldownMs?: number): boolean;
