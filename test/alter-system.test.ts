import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adjustAlterWeight, advanceAlterSystem, calculateAlterThreshold, completeAlterAnalysis,
  createAlterSystemState, emotionalOffsetForPrompt, normalizeAlterSystemState, normalizeAlterValue,
} from '../src/alter'
import { AlterHistoryEntry, AlterSystemConfig } from '../src/types'

const config: AlterSystemConfig = {
  enabled: true,
  baseThreshold: 10,
  densityFactor: 0.3,
  sameDirectionBoost: 0.05,
  oppositeDecay: 0.15,
  minWeight: 0.2,
  maxIntensity: 2,
}

test('model Alter values are bounded integers and invalid values are ignored', () => {
  assert.equal(normalizeAlterValue(3.4), 3)
  assert.equal(normalizeAlterValue(20), 5)
  assert.equal(normalizeAlterValue(-20), -5)
  assert.equal(normalizeAlterValue(Number.NaN), undefined)
  assert.equal(normalizeAlterValue('3'), undefined)
})

test('dynamic threshold moves gradually from ten to seven under dense narration', () => {
  const now = new Date('2026-08-22T12:00:00.000Z')
  const entry = (turn: number): AlterHistoryEntry => ({
    turn,
    phase: 'user-message',
    alter: 1,
    alterValue: turn,
    timestamp: new Date(now.getTime() - turn * 1_000).toISOString(),
  })
  assert.equal(calculateAlterThreshold([], config, now), 10)
  assert.equal(calculateAlterThreshold(Array.from({ length: 5 }, (_, index) => entry(index + 1)), config, now), 8.5)
  assert.equal(calculateAlterThreshold(Array.from({ length: 20 }, (_, index) => entry(index + 1)), config, now), 7)
})

test('same-direction movement strengthens while opposite movement decays', () => {
  assert.equal(adjustAlterWeight(0.6, true, 2, config), 0.7)
  assert.ok(Math.abs(adjustAlterWeight(0.6, false, 2, config) - 0.3) < 1e-9)
  assert.equal(adjustAlterWeight(0.95, true, 5, config), 1)
  assert.equal(adjustAlterWeight(0.2, false, 5, config), 0)
})

test('a trigger is completed only after a valid side-model description', () => {
  const now = new Date('2026-08-22T12:00:00.000Z')
  const state = createAlterSystemState(now)
  state.alterValue = 8
  const turn = advanceAlterSystem(state, 3, 'user-message', now, config)
  assert.equal(turn.thresholdReached, true)
  assert.equal(turn.state.alterValue, 11)

  const completed = completeAlterAnalysis(turn.state, '氛围开始转向更谨慎、私密的交流。', turn.threshold, now, config)
  assert.equal(completed.alterValue, 0)
  assert.equal(completed.alterWeight, 1)
  assert.equal(completed.lastTriggerDirection, 1)
  assert.equal(completed.emotionalOffset?.direction, 'serious')
  assert.ok((completed.emotionalOffset?.intensity ?? 0) >= 1)
})

test('legacy persisted Alter state is normalized without exposing duplicate weight', () => {
  const normalized = normalizeAlterSystemState({
    alterValue: -4,
    alterWeight: 0.75,
    lastTriggerAlter: -12,
    emotionalOffset: {
      direction: 'relaxed', description: '较轻松', intensity: 1.2,
      generatedAt: 1787400000000, weight: 0.1,
    },
    history: [],
    lastUpdatedAt: 1787400000000,
  })
  assert.equal(normalized?.lastTriggerDirection, -1)
  assert.equal(normalized?.alterWeight, 0.75)
  const prompt = emotionalOffsetForPrompt(normalized, config)
  assert.equal(prompt?.weight, 0.75)
  assert.equal('weight' in (normalized?.emotionalOffset ?? {}), false)
})
