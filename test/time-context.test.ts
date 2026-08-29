import assert from 'node:assert/strict'
import test from 'node:test'
import { storyLocalTimeContext, toPromptPayload } from '../src/narrator'
import { normalizeDatabaseRow } from '../src/service'
import { formatLogTime, timeFormatterCacheSize } from '../src/time'
import { emptyParticipantState, emptyStorySetting, emptyStoryState, InterludeStory, NarrativeRequest } from '../src/types'

function requestAt(from: Date, now: Date): NarrativeRequest {
  const setting = emptyStorySetting()
  setting.timezone = 'Asia/Shanghai'
  const state = emptyStoryState()
  state.lastContinuityUpdateAt = from.toISOString()
  const story: InterludeStory = {
    id: 'story', platform: 'onebot', selfId: 'bot', userId: 'global', channelId: 'private:global',
    status: 'active', setting, state, cursorAt: from, createdAt: from, updatedAt: now,
  }
  return {
    phase: 'advance', story, from, now, participant: null, participants: [], shareParticipantDetails: false,
    dueIntents: [], activeConsequences: [], supersededIntents: [], recentEntries: [], memories: [],
  }
}

test('16:00 in Shanghai is an authoritative daylight afternoon', () => {
  const instant = new Date('2026-08-23T08:00:00.000Z')
  const local = storyLocalTimeContext(instant, 'Asia/Shanghai')
  assert.equal(local.local, '2026-08-23 16:00:00')
  assert.equal(local.hour, 16)
  assert.equal(local.period, 'afternoon')
  assert.equal(local.periodZh, '下午')
  assert.match(local.daylightExpectation, /normally daylight/)
})

test('long intervals expose both endpoint clocks and continuity age', () => {
  const from = new Date('2026-08-22T15:00:00.000Z') // Shanghai 23:00
  const now = new Date('2026-08-23T08:00:00.000Z') // Shanghai 16:00
  const payload = toPromptPayload(requestAt(from, now))
  assert.equal(payload.interval.fromLocal, '2026-08-22 23:00:00')
  assert.equal(payload.interval.nowLocal, '2026-08-23 16:00:00')
  assert.equal(payload.interval.nowLocalContext.period, 'afternoon')
  assert.equal(payload.interval.elapsedSeconds, 61_200)
  assert.equal(payload.continuitySnapshotAgeMinutes, 1_020)
})

test('reload-style ISO timestamp rows are materialized as Date objects', () => {
  const normalized = normalizeDatabaseRow('interlude_story', {
    id: 'story', state: emptyStoryState(),
    cursorAt: '2026-08-23T07:55:00.000Z',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-23T08:00:00.000Z',
  })
  assert.ok(normalized.cursorAt instanceof Date)
  assert.ok(normalized.createdAt instanceof Date)
  assert.ok(normalized.updatedAt instanceof Date)
  assert.equal(normalized.cursorAt.toISOString(), '2026-08-23T07:55:00.000Z')
  assert.equal(normalized.state.agencyWindow, undefined)
})

test('timezone formatters are reused instead of rebuilt on every turn', () => {
  const instant = new Date('2026-08-23T08:00:00.000Z')
  storyLocalTimeContext(instant, 'Asia/Shanghai')
  formatLogTime(instant, 'Asia/Shanghai')
  const warmed = timeFormatterCacheSize()
  for (let index = 0; index < 100; index++) {
    storyLocalTimeContext(instant, 'Asia/Shanghai')
    formatLogTime(instant, 'Asia/Shanghai')
  }
  assert.equal(timeFormatterCacheSize(), warmed)
  assert.equal(storyLocalTimeContext(instant, 'Not/A_Timezone').timezone, 'UTC')
})

test('recentScript payload carries derived ownership without changing stored entries', () => {
  const now = new Date('2026-08-23T08:00:00.000Z')
  const request = requestAt(now, now)
  request.recentEntries = [{
    id: 1, storyId: 'story', participantId: 'participant', kind: 'script', actor: 'narrator',
    content: '她觉得这件事有点奇怪，但没有说出口。', occurredAt: now, metadata: {}, createdAt: now,
  }]
  const payload = toPromptPayload(request)
  assert.equal(payload.recentScript[0].ownership, 'protagonist-narrative')
  assert.equal('ownership' in request.recentEntries[0], false)
})

test('background Agency payload includes relationship identity but not raw chat history', () => {
  const now = new Date('2026-08-24T08:00:00.000Z')
  const request = requestAt(now, now)
  request.agencyEnabled = true
  request.agencyWindow = null
  request.participants = [{
    id: 'friend', storyId: 'story', platform: 'onebot', selfId: 'bot', userId: 'user', channelId: 'private:user',
    personId: 'friend', displayName: '小桃', profile: '主角信任的朋友', relationship: '关系亲近',
    state: emptyParticipantState(), status: 'active', createdAt: now, updatedAt: now,
  }]
  const payload = toPromptPayload(request)
  assert.equal(payload.participants[0].displayName, '小桃')
  assert.equal(payload.participants[0].relationship, '关系亲近')
  assert.equal(payload.participants[0].profile, '主角信任的朋友')
  assert.equal(payload.recentScript.length, 0)
})
