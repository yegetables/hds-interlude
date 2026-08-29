import {
  AlterHistoryEntry, AlterSystemConfig, AlterSystemState, EmotionalOffsetPrompt, NarrativePhase,
} from './types'

const HOUR = 60 * 60 * 1000
const HISTORY_LIMIT = 50

export const DEFAULT_ALTER_SYSTEM_CONFIG: AlterSystemConfig = {
  enabled: false,
  baseThreshold: 10,
  densityFactor: 0.3,
  sameDirectionBoost: 0.05,
  oppositeDecay: 0.15,
  minWeight: 0.2,
  maxIntensity: 2,
  modelId: '',
  providerId: '',
  model: '',
  temperature: 0.3,
  topP: 1,
  maxTokens: 400,
  timeout: 30_000,
  prompt: '',
}

export interface AlterTurnResult {
  state: AlterSystemState
  threshold: number
  offsetExpired: boolean
  thresholdReached: boolean
}

export function resolveAlterSystemConfig(value?: Partial<AlterSystemConfig>): AlterSystemConfig {
  return { ...DEFAULT_ALTER_SYSTEM_CONFIG, ...value }
}

export function normalizeAlterValue(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(-5, Math.min(5, Math.round(value)))
}

export function createAlterSystemState(now = new Date()): AlterSystemState {
  return {
    alterValue: 0,
    alterWeight: 0,
    lastTriggerDirection: 0,
    emotionalOffset: null,
    history: [],
    lastUpdatedAt: now.toISOString(),
  }
}

export function normalizeAlterSystemState(value: unknown): AlterSystemState | undefined {
  if (!isRecord(value)) return undefined
  const history: AlterHistoryEntry[] = Array.isArray(value.history)
    ? value.history.filter(isRecord).map((entry, index) => ({
      turn: Math.max(1, Math.floor(finiteNumber(entry.turn, index + 1))),
      phase: normalizePhase(entry.phase),
      alter: normalizeAlterValue(entry.alter) ?? 0,
      alterValue: clamp(finiteNumber(entry.alterValue, 0), -1_000, 1_000),
      timestamp: normalizedIso(entry.timestamp) ?? new Date(0).toISOString(),
    })).slice(-HISTORY_LIMIT)
    : []
  const emotionalOffset = isRecord(value.emotionalOffset) && typeof value.emotionalOffset.description === 'string'
    ? {
      direction: value.emotionalOffset.direction === 'relaxed' ? 'relaxed' as const : 'serious' as const,
      description: value.emotionalOffset.description.trim().slice(0, 800),
      intensity: clamp(finiteNumber(value.emotionalOffset.intensity, 1), 0, 3),
      generatedAt: normalizedIso(value.emotionalOffset.generatedAt) ?? new Date(0).toISOString(),
    }
    : null
  const legacyDirection = Math.sign(finiteNumber(value.lastTriggerAlter, 0))
  const direction = Math.sign(finiteNumber(value.lastTriggerDirection, legacyDirection)) as -1 | 0 | 1
  return {
    alterValue: clamp(finiteNumber(value.alterValue, 0), -1_000, 1_000),
    alterWeight: clamp(finiteNumber(value.alterWeight, 0), 0, 1),
    lastTriggerDirection: direction,
    emotionalOffset,
    history,
    lastUpdatedAt: normalizedIso(value.lastUpdatedAt) ?? new Date(0).toISOString(),
    lastAnalysisAttemptAt: normalizedIso(value.lastAnalysisAttemptAt),
  }
}

export function calculateAlterThreshold(history: AlterHistoryEntry[], config: AlterSystemConfig, now = new Date()) {
  const oneHourAgo = now.getTime() - HOUR
  const turns = history.filter(entry => (dateValue(entry.timestamp)?.getTime() ?? 0) >= oneHourAgo).length
  const density = Math.min(turns / 10, 1)
  const base = Math.max(1, finiteNumber(config.baseThreshold, 10))
  const factor = clamp(finiteNumber(config.densityFactor, 0.3), 0, 1)
  return Math.max(base * 0.5, base * (1 - density * factor))
}

export function adjustAlterWeight(weight: number, sameDirection: boolean, magnitude: number, config: AlterSystemConfig) {
  const rate = sameDirection ? config.sameDirectionBoost : -config.oppositeDecay
  return clamp(weight + Math.max(0, magnitude) * finiteNumber(rate, 0), 0, 1)
}

export function advanceAlterSystem(
  current: AlterSystemState | undefined,
  alter: number,
  phase: NarrativePhase,
  now: Date,
  config: AlterSystemConfig,
): AlterTurnResult {
  const state = current
    ? { ...current, history: [...current.history] }
    : createAlterSystemState(now)
  state.alterValue = clamp(state.alterValue + alter, -1_000, 1_000)
  const direction = Math.sign(alter)
  let offsetExpired = false
  if (state.emotionalOffset && direction) {
    state.alterWeight = adjustAlterWeight(
      state.alterWeight,
      direction === state.lastTriggerDirection,
      Math.abs(alter),
      config,
    )
    if (state.alterWeight < config.minWeight) {
      state.emotionalOffset = null
      state.alterWeight = 0
      offsetExpired = true
    }
  }
  state.history.push({
    turn: (state.history.at(-1)?.turn ?? 0) + 1,
    phase,
    alter,
    alterValue: state.alterValue,
    timestamp: now.toISOString(),
  })
  state.history = state.history.slice(-HISTORY_LIMIT)
  state.lastUpdatedAt = now.toISOString()
  const threshold = calculateAlterThreshold(state.history, config, now)
  return { state, threshold, offsetExpired, thresholdReached: Math.abs(state.alterValue) >= threshold }
}

export function completeAlterAnalysis(
  state: AlterSystemState,
  description: string,
  threshold: number,
  now: Date,
  config: AlterSystemConfig,
) {
  const triggerValue = state.alterValue
  const direction = Math.sign(triggerValue) as -1 | 1
  return {
    ...state,
    alterValue: 0,
    alterWeight: 1,
    lastTriggerDirection: direction,
    emotionalOffset: {
      direction: direction > 0 ? 'serious' as const : 'relaxed' as const,
      description: description.trim().slice(0, 800),
      intensity: Math.min(Math.abs(triggerValue) / Math.max(1, threshold), config.maxIntensity),
      generatedAt: now.toISOString(),
    },
    lastUpdatedAt: now.toISOString(),
  }
}

export function emotionalOffsetForPrompt(
  state: AlterSystemState | undefined,
  config: AlterSystemConfig,
): EmotionalOffsetPrompt | null {
  if (!config.enabled || !state?.emotionalOffset || state.alterWeight < config.minWeight) return null
  return { ...state.emotionalOffset, weight: state.alterWeight }
}

export function alterAnalysisCoolingDown(state: AlterSystemState, now = new Date(), cooldownMs = 5 * 60 * 1000) {
  const lastAttempt = dateValue(state.lastAnalysisAttemptAt)
  return !!lastAttempt && now.getTime() - lastAttempt.getTime() < cooldownMs
}

function normalizePhase(value: unknown): NarrativePhase {
  return ['advance', 'conversation-follow-up', 'user-message', 'intent-due'].includes(String(value))
    ? value as NarrativePhase
    : 'user-message'
}

function normalizedIso(value: unknown) {
  return dateValue(value)?.toISOString()
}

function dateValue(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return undefined
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
