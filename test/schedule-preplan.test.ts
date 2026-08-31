import assert from 'node:assert/strict'
import test from 'node:test'
import { systemPrompt, toPromptPayload } from '../src/narrator'
import {
  applySchedulePreplanProposal, DEFAULT_SCHEDULE_PREPLAN_CONFIG, materializeSchedulePreplan,
  nextSchedulePreplanTransition, schedulePreplanNeedsModel, schedulePreplanReviewDue, schedulePreplanWindow,
} from '../src/schedule-preplan'
import { emptyStorySetting, emptyStoryState, NarrativeRequest, SchedulePreplanRecord, SchedulePreplanRegime, ScriptEntry } from '../src/types'

const regime: SchedulePreplanRegime = {
  id: 'summer', label: '暑假', from: '2026-08-01', to: '2026-09-02',
  weekly: {
    monday: [
      { id: 'class', start: '14:00', end: '17:00', label: '补课', kind: 'fixed' },
      { id: 'drawing', start: '20:00', end: '21:30', label: '画画', kind: 'flexible' },
    ],
    tuesday: [{ id: 'morning-rest', start: '09:00', end: '11:00', label: '休息', kind: 'open' }],
  },
}

function record(): SchedulePreplanRecord {
  const now = new Date('2026-08-30T00:00:00.000Z')
  return {
    storyId: 'story', revision: 2, timezone: 'Asia/Shanghai', validFrom: '2026-08-30', validThrough: '2026-09-12',
    lastReviewedLocalDate: '2026-08-30', lastEvidenceEntryId: 10, reviewReason: 'stable', regimes: [regime], exceptions: [],
    materializedDays: materializeSchedulePreplan([regime], [], '2026-08-30', 14), createdAt: now, updatedAt: now,
  }
}

test('Schedule Preplan expands recurring rules and applies dated exceptions deterministically', () => {
  const days = materializeSchedulePreplan([regime], [{
    date: '2026-08-31', mode: 'patch', reason: '停课', removeBlockIds: ['class'],
    blocks: [{ id: 'library', start: '15:00', end: '17:00', label: '图书馆', kind: 'flexible' }],
  }], '2026-08-31', 2)
  assert.deepEqual(days[0].blocks.map(item => item.id), ['library', 'drawing'])
  assert.deepEqual(days[1].blocks.map(item => item.id), ['morning-rest'])
})

test('life-stage boundaries switch from vacation to school without leaking the old weekly plan', () => {
  const school: SchedulePreplanRegime = {
    id: 'school-term', label: '开学后', from: '2026-09-01',
    weekly: { tuesday: [{ id: 'at-school', start: '07:20', end: '17:20', label: '在校', kind: 'fixed' }] },
  }
  const vacation = { ...regime, to: '2026-08-31' }
  const days = materializeSchedulePreplan([vacation, school], [], '2026-08-31', 2)
  assert.deepEqual(days[0].blocks.map(item => item.id), ['class', 'drawing'])
  assert.deepEqual(days[1].blocks.map(item => item.id), ['at-school'])
})

test('main narration receives only the coming twelve hours, not the stored multi-day horizon', () => {
  const current = record()
  const now = new Date('2026-08-31T04:00:00.000Z') // 12:00 Asia/Shanghai
  const window = schedulePreplanWindow(current, now, 'Asia/Shanghai', 12)
  assert.ok(window)
  assert.equal(window!.name, 'Schedule Preplan')
  assert.deepEqual(window!.blocks.map(item => item.id), ['class', 'drawing'])
  assert.equal(window!.blocks.some(item => item.date > '2026-08-31'), false)
  assert.match(systemPrompt('advance', '', '', '', '', '', false, false, false, false, false, undefined, false, undefined, true), /roughly twelve hours/)
})

test('daily review is once per local day and unchanged reviews preserve revision', () => {
  const current = record()
  assert.equal(schedulePreplanReviewDue(current, new Date('2026-08-30T18:30:00.000Z'), 'Asia/Shanghai', DEFAULT_SCHEDULE_PREPLAN_CONFIG), false)
  assert.equal(schedulePreplanReviewDue(current, new Date('2026-08-31T04:00:00.000Z'), 'Asia/Shanghai', DEFAULT_SCHEDULE_PREPLAN_CONFIG), true)
  const evidence = [{ id: 11 }] as ScriptEntry[]
  const next = applySchedulePreplanProposal(current, { outcome: 'unchanged', reason: '没有足以改变日程的新证据', sourceEntryIds: [11] }, evidence, '2026-08-31', 'Asia/Shanghai', DEFAULT_SCHEDULE_PREPLAN_CONFIG, new Date('2026-08-31T04:00:00.000Z'))!
  assert.equal(next.revision, current.revision)
  assert.equal(next.lastEvidenceEntryId, 11)
  assert.equal(next.lastReviewedLocalDate, '2026-08-31')
})

test('an evidence-free first review persists an explicit empty schedule instead of retrying forever', () => {
  const now = new Date('2026-08-31T04:00:00.000Z')
  const empty = applySchedulePreplanProposal(
    undefined,
    { outcome: 'replace', reason: '暂无可靠的重复日程证据', regimes: [], exceptions: [] },
    [], '2026-08-31', 'Asia/Shanghai', DEFAULT_SCHEDULE_PREPLAN_CONFIG, now,
  )
  assert.ok(empty)
  assert.deepEqual(empty!.regimes, [])
  assert.equal(empty!.lastReviewedLocalDate, '2026-08-31')
  assert.equal(schedulePreplanNeedsModel(empty, [], '2026-08-31', 'Asia/Shanghai', DEFAULT_SCHEDULE_PREPLAN_CONFIG), false)
})

test('Chinese stable ids from a Chinese compaction model remain distinct', () => {
  const evidence = [{ id: 11 }] as ScriptEntry[]
  const next = applySchedulePreplanProposal(undefined, {
    outcome: 'replace', reason: '根据明确剧本建立暑假日程', sourceEntryIds: [11],
    regimes: [{ id: '暑假安排', label: '暑假', from: '2026-08-31', weekly: { monday: [{ id: '下午补课', start: '14:00', end: '17:00', label: '补课', kind: 'fixed', sourceEntryIds: [11] }] }, sourceEntryIds: [11] }],
  }, evidence, '2026-08-31', 'Asia/Shanghai', DEFAULT_SCHEDULE_PREPLAN_CONFIG, new Date('2026-08-31T04:00:00.000Z'))!
  assert.equal(next.regimes[0].id, '暑假安排')
  assert.equal(next.regimes[0].weekly.monday?.[0].id, '下午补课')
})

test('fixed blocks can anchor automatic advance while flexible hobbies cannot', () => {
  const current = record()
  const now = new Date('2026-08-31T05:30:00.000Z') // 13:30 local
  assert.equal(nextSchedulePreplanTransition(current, now, 'Asia/Shanghai')?.toISOString(), '2026-08-31T06:00:00.000Z')
})

test('granular tentative blocks use a stable activation and reveal only their vague availability early', () => {
  const now = new Date('2026-08-31T04:00:00.000Z') // 12:00 Asia/Shanghai
  let current: SchedulePreplanRecord | undefined
  for (let index = 0; index < 40 && !current; index++) {
    const candidate: SchedulePreplanRegime = {
      id: `candidate-regime-${index}`, label: '近期节奏', from: '2026-08-01',
      weekly: { monday: [{ id: `candidate-${index}`, start: '20:00', end: '21:00', label: '社团活动调整', kind: 'flexible', tentative: true }] },
    }
    const draft = { ...record(), regimes: [candidate], materializedDays: materializeSchedulePreplan([candidate], [], '2026-08-31', 14) }
    if (schedulePreplanWindow(draft, now, 'Asia/Shanghai', 12, { candidateActivationProbability: 0.5, candidateRevealMinutes: 120 })?.blocks.length) current = draft
  }
  assert.ok(current)
  const far = schedulePreplanWindow(current, now, 'Asia/Shanghai', 12, { candidateActivationProbability: 0.5, candidateRevealMinutes: 120 })!
  assert.equal(far.blocks[0].label, '可能的个人安排')
  const near = schedulePreplanWindow(current, new Date('2026-08-31T10:30:00.000Z'), 'Asia/Shanghai', 3, { candidateActivationProbability: 0.5, candidateRevealMinutes: 120 })!
  assert.equal(near.blocks[0].label, '社团活动调整')
})

test('stable and contextual reviews reject model-proposed tentative blocks', () => {
  const evidence = [{ id: 11 }] as ScriptEntry[]
  const proposal = {
    outcome: 'replace', reason: '有规律的晚间活动', sourceEntryIds: [11],
    regimes: [{ id: 'weekly', label: '日常', from: '2026-08-31', sourceEntryIds: [11], weekly: { monday: [{ id: 'maybe', start: '20:00', end: '21:00', label: '可能活动', kind: 'flexible', tentative: true, sourceEntryIds: [11] }] } }],
  }
  const stable = applySchedulePreplanProposal(undefined, proposal, evidence, '2026-08-31', 'Asia/Shanghai', DEFAULT_SCHEDULE_PREPLAN_CONFIG, new Date(), 'stable')!
  assert.equal(stable.regimes[0].weekly.monday?.[0].tentative, undefined)
  const granular = applySchedulePreplanProposal(undefined, proposal, evidence, '2026-08-31', 'Asia/Shanghai', DEFAULT_SCHEDULE_PREPLAN_CONFIG, new Date(), 'granular')!
  assert.equal(granular.regimes[0].weekly.monday?.[0].tentative, true)
})

test('prompt payload exposes Schedule Preplan as planned structure separate from story state', () => {
  const now = new Date('2026-08-31T04:00:00.000Z')
  const story = { id: 'story', platform: 'onebot', selfId: 'bot', userId: '', channelId: '', status: 'active' as const, setting: emptyStorySetting(), state: emptyStoryState(), cursorAt: now, createdAt: now, updatedAt: now }
  story.setting.timezone = 'Asia/Shanghai'
  const request: NarrativeRequest = {
    phase: 'advance', story, from: now, now, participant: null, participants: [], shareParticipantDetails: false,
    dueIntents: [], activeConsequences: [], supersededIntents: [], recentEntries: [], memories: [],
    schedulePreplan: schedulePreplanWindow(record(), now, 'Asia/Shanghai', 12),
  }
  const payload = toPromptPayload(request) as any
  assert.equal(payload.schedulePreplan.plannedNotObserved, true)
  assert.equal(payload.state.schedulePreplan, undefined)
  assert.ok(payload.schedulePreplan.blocks.length <= 8)
})
