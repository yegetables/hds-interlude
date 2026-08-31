import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenAICompatibleNarrator } from '../src/narrator'
import { normalizeTimelinePlan, timelineEntryPromptProjection } from '../src/service'
import { emptyStorySetting, emptyStoryState, InterludeStory, ScriptEntry, TimelinePlanRequest } from '../src/types'

const now = new Date('2026-08-31T08:37:00.000Z')

test('timeline director accepts only bounded relative beats and discards malformed output', () => {
  const plan = normalizeTimelinePlan({
    beats: [
      { at: 0.7, kind: 'thought', summary: '短暂想到中午的约定' },
      { at: 0, kind: 'activity', summary: '继续完成随堂练习' },
      { at: 2, kind: 'state', summary: '窗口结束时仍在课堂' },
      { at: 0.3, kind: 'teleport', summary: '无效节点' },
    ],
    carry: ['午间验收仍未发生'],
  })
  assert.deepEqual(plan?.beats.map(beat => beat.at), [0, 0.7, 1])
  assert.equal(plan?.carry?.[0], '午间验收仍未发生')
  assert.equal(normalizeTimelinePlan({ beats: [] }), undefined)
})

test('automatic script entries project to their host timeline ledger on later turns', () => {
  const entry: ScriptEntry = {
    id: 1, storyId: 'story', participantId: '', kind: 'script', actor: 'narrator',
    content: '八点十六分到八点三十七分之间，她在课堂上，随后却被错误写到了中午。',
    occurredAt: now, createdAt: now,
    metadata: { timelinePlan: { beats: [{ at: 0, kind: 'activity', summary: '完成课堂练习' }, { at: 1, kind: 'state', summary: '仍在课堂' }] } },
  }
  const projected = timelineEntryPromptProjection(entry)
  assert.notEqual(projected.content, entry.content)
  assert.match(projected.content, /Host timeline ledger/)
  assert.doesNotMatch(projected.content, /中午/)
})

test('timeline director reuses the compaction route and requests a small JSON ledger', async () => {
  const calls: any[] = []
  const ctx = { http: { post: async (_url: string, body: any) => {
    calls.push(body)
    return { choices: [{ message: { content: '{"beats":[{"at":0,"kind":"activity","summary":"继续课堂练习"}]}' } }] }
  } } }
  const narrator = new OpenAICompatibleNarrator(ctx as any, {
    providers: [{ label: 'Compact', enabled: true, endpoint: 'https://example.test/chat', model: 'compact-model', temperature: 0.8, topP: 1, maxTokens: 4096, timeout: 10_000, responseFormat: 'json-object', extraHeaders: '', extraBody: '', useForCompaction: true }],
    compaction: { enabled: true, providerId: '', model: '', temperature: 0.3, topP: 1, maxTokens: 2048, timeout: 10_000, responseFormat: 'json-object', fixedPrompt: '', stylePrompt: '' },
    failover: { enabled: true, strategy: 'priority', maxAttemptsPerProvider: 1, cooldownMinutes: 5 },
  } as any, true)
  const story: InterludeStory = { id: 'story', platform: 'onebot', selfId: 'bot', userId: '', channelId: '', status: 'active', setting: emptyStorySetting(), state: emptyStoryState(), cursorAt: now, createdAt: now, updatedAt: now }
  const request: TimelinePlanRequest = { story, participant: null, phase: 'advance', from: new Date(now.getTime() - 20 * 60_000), now, scene: null, facts: [], recentEntries: [], dueIntents: [], schedulePreplan: null }
  const plan = await narrator.planTimeline(request)
  assert.equal(plan?.beats[0]?.summary, '继续课堂练习')
  assert.equal(calls[0].temperature, 0.3)
  assert.equal(calls[0].max_tokens, 480)
  assert.equal(calls[0].response_format.type, 'json_object')
})
