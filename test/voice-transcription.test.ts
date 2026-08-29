import assert from 'node:assert/strict'
import test from 'node:test'
import { extractSessionVoiceCount, mergeUserMessageWithVoiceTranscripts } from '../src/service'

test('OneBot record CQ segments are recognized as incoming voice', () => {
  assert.equal(extractSessionVoiceCount({ content: '[CQ:record,file=voice.amr]' } as any), 1)
  assert.equal(extractSessionVoiceCount({ content: '普通文字' } as any), 0)
})

test('voice transcription joins typed text into one explicit user event', () => {
  assert.equal(
    mergeUserMessageWithVoiceTranscripts('我补充一句', ['这是语音里说的内容。'], 1),
    '我补充一句\n\n[用户语音转写 1]\n这是语音里说的内容。',
  )
  assert.equal(
    mergeUserMessageWithVoiceTranscripts('', [], 1),
    '[用户发送了一段语音；未能转写其内容。]',
  )
})
