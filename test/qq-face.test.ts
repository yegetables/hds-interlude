import assert from 'node:assert/strict'
import test from 'node:test'
import { describeQQNativeFace, normalizeQQNativeFaceSegments, qqNativeFaceName } from '../src/qq-face'

test('known QQ system faces are translated into stable incoming semantics', () => {
  assert.equal(qqNativeFaceName('14'), '微笑')
  assert.equal(qqNativeFaceName('182'), '笑哭')
  assert.equal(qqNativeFaceName('427'), '偷感')
  assert.equal(normalizeQQNativeFaceSegments('<face id="427" platform="onebot"></face>'), '[QQ 原生表情：偷感（ID: 427）]')
  assert.equal(normalizeQQNativeFaceSegments('好吧[CQ:face,id=182]'), '好吧[QQ 原生表情：笑哭（ID: 182）]')
})

test('unknown QQ face IDs remain explicit rather than guessed', () => {
  assert.equal(describeQQNativeFace('9999'), '[QQ 原生表情（ID: 9999；名称未收录）]')
})
