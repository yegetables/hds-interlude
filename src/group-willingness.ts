/**
 * A deliberately small, model-free willingness layer for group chat. It is
 * inspired by the local score / decay / probability pattern used by YesImBot
 * v3, but remains scoped to one HDSI group and never affects private turns,
 * Agency Window, Alter, prompts, or durable story state.
 */
export interface GroupWillingnessConfig {
  enabled: boolean
  maxScore: number
  threshold: number
  probabilityAmplifier: number
  decayHalfLifeSeconds: number
  replyCost: number
  baseGain: number
  quoteGain: number
  keywordGain: number
  keywords: string[]
}

export interface GroupWillingnessState {
  score: number
  updatedAt: number
}

export type GroupWillingnessReason = 'disabled' | 'forced-mention' | 'below-threshold' | 'probability-roll'

export interface GroupWillingnessDecision {
  state: GroupWillingnessState
  shouldCall: boolean
  probability: number
  reason: GroupWillingnessReason
}

export const DEFAULT_GROUP_WILLINGNESS: GroupWillingnessConfig = {
  enabled: false,
  maxScore: 1,
  threshold: 0.24,
  probabilityAmplifier: 1.3,
  decayHalfLifeSeconds: 180,
  replyCost: 0.55,
  baseGain: 0.12,
  quoteGain: 0.12,
  keywordGain: 0.18,
  keywords: [],
}

export function resolveGroupWillingness(config?: Partial<GroupWillingnessConfig>): GroupWillingnessConfig {
  return {
    ...DEFAULT_GROUP_WILLINGNESS,
    ...config,
    keywords: (config?.keywords ?? DEFAULT_GROUP_WILLINGNESS.keywords).map(item => String(item).trim()).filter(Boolean).slice(0, 30),
  }
}

export function evaluateGroupWillingness(
  previous: GroupWillingnessState | undefined,
  configInput: Partial<GroupWillingnessConfig> | undefined,
  input: { now: number; messageCount: number; content: string; quotedBot: boolean; mentionedBot: boolean; random?: number },
): GroupWillingnessDecision {
  const config = resolveGroupWillingness(configInput)
  const state = decay(previous, config, input.now)
  if (!config.enabled) return { state, shouldCall: true, probability: 1, reason: 'disabled' }

  const keywordHit = config.keywords.some(keyword => input.content.includes(keyword))
  const rawGain = config.baseGain * Math.max(1, Math.min(3, input.messageCount))
    + (input.quotedBot ? config.quoteGain : 0)
    + (keywordHit ? config.keywordGain : 0)
  const marginal = 1 - Math.min(1, state.score / config.maxScore) ** 2
  state.score = clamp(state.score + rawGain * Math.max(0, marginal), 0, config.maxScore)

  if (input.mentionedBot) return { state, shouldCall: true, probability: 1, reason: 'forced-mention' }
  if (state.score <= config.threshold) return { state, shouldCall: false, probability: 0, reason: 'below-threshold' }
  const probability = clamp((state.score - config.threshold) * config.probabilityAmplifier, 0, 1)
  return {
    state,
    shouldCall: (input.random ?? Math.random()) < probability,
    probability,
    reason: 'probability-roll',
  }
}

export function consumeGroupWillingness(
  previous: GroupWillingnessState | undefined,
  configInput: Partial<GroupWillingnessConfig> | undefined,
  now: number,
): GroupWillingnessState {
  const config = resolveGroupWillingness(configInput)
  const state = decay(previous, config, now)
  return { score: Math.max(0, state.score - config.replyCost), updatedAt: now }
}

function decay(previous: GroupWillingnessState | undefined, config: GroupWillingnessConfig, now: number): GroupWillingnessState {
  const score = previous?.score ?? 0
  const elapsedSeconds = Math.max(0, now - (previous?.updatedAt ?? now)) / 1_000
  const factor = 0.5 ** (elapsedSeconds / Math.max(1, config.decayHalfLifeSeconds))
  return { score: score * factor < 0.001 ? 0 : score * factor, updatedAt: now }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
