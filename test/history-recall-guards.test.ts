import assert from 'node:assert/strict'
import test from 'node:test'
import { isHistoryEntryVisibleToParticipant, shouldRequestTurnEmbedding } from '../src/service'

test('semantic history recall keeps private branches and group transcripts out of another participant prompt', () => {
  assert.equal(isHistoryEntryVisibleToParticipant({ participantId: 'a', kind: 'user-message' }, 'a', false), true)
  assert.equal(isHistoryEntryVisibleToParticipant({ participantId: 'a', kind: 'character-message' }, 'b', false), false)
  assert.equal(isHistoryEntryVisibleToParticipant({ participantId: '', kind: 'script' }, 'b', false), true)
  assert.equal(isHistoryEntryVisibleToParticipant({ participantId: '', kind: 'group-message' }, 'b', false), false)
  assert.equal(isHistoryEntryVisibleToParticipant({ participantId: 'a', kind: 'user-message' }, 'b', true), true)
})

test('sticker filtering requests a live vector only for an active oversized library', () => {
  const base = { enabled: true, liveQuery: false, semanticHistory: false, semanticStickerFilter: true }
  assert.equal(shouldRequestTurnEmbedding(base, false, 100), false)
  assert.equal(shouldRequestTurnEmbedding(base, true, 12), false)
  assert.equal(shouldRequestTurnEmbedding(base, true, 13), true)
  assert.equal(shouldRequestTurnEmbedding({ ...base, semanticHistory: true }, false, 0), true)
  assert.equal(shouldRequestTurnEmbedding({ ...base, enabled: false }, true, 100), false)
})
