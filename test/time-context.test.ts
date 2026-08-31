import assert from 'node:assert/strict'
import test from 'node:test'
import { storyLocalTimeContext, toPromptPayload } from '../src/narrator'
import { extractUserReportedTimes, normalizeDatabaseRow } from '../src/service'
import { formatLogTime, formatStoryDisplayTime, timeFormatterCacheSize } from '../src/time'
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

test('timeline display uses the story timezone and prints its GMT offset', () => {
  assert.equal(formatStoryDisplayTime(new Date('2026-08-31T00:37:00.000Z'), 'Asia/Shanghai'), '2026-08-31 08:37:00 GMT+8')
})

test('explicit user-reported clocks stay distinct from the message receive time', () => {
  const facts = extractUserReportedTimes('我 6.30 开始吃，刚吃完', new Date('2026-08-31T11:36:00.000Z'), 'Asia/Shanghai')
  assert.deepEqual(facts, [{ localTime: '2026-08-31 18:30', relation: 'past', statement: '我 6.30 开始吃，刚吃完' }])
})

test('prompt payload keeps receive time and user-reported action time as separate fields', () => {
  const now = new Date('2026-08-31T11:36:00.000Z')
  const request = requestAt(now, now)
  request.phase = 'user-message'
  request.userMessage = '我 6.30 开始吃，刚吃完'
  request.userReportedTimes = extractUserReportedTimes(request.userMessage, now, 'Asia/Shanghai')
  const payload = toPromptPayload(request)
  assert.equal(payload.currentEvent.observedAtLocal, '2026-08-31 19:36:00')
  assert.deepEqual(payload.currentEvent.userReportedTimes, [{ localTime: '2026-08-31 18:30', relation: 'past', statement: '我 6.30 开始吃，刚吃完' }])
})

test('the current user message remains both a durable event and the explicit currentEvent', () => {
  const now = new Date('2026-08-23T08:00:00.000Z')
  const request = requestAt(now, now)
  request.phase = 'user-message'
  request.userMessage = '现在发生的这一条消息'
  request.recentEntries = [{
    id: 2, storyId: 'story', participantId: 'participant', kind: 'user-message', actor: 'user',
    content: '现在发生的这一条消息', occurredAt: now, metadata: {}, createdAt: now,
  }]
  const payload = toPromptPayload(request)
  assert.equal(payload.currentEvent.content, '现在发生的这一条消息')
  assert.equal(payload.recentScript[0].content, '现在发生的这一条消息')
  assert.equal(payload.recentScript[0].ownership, 'user-delivered-message')
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
