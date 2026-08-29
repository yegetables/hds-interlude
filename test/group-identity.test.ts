import assert from 'node:assert/strict'
import test from 'node:test'
import { systemPrompt, toPromptPayload } from '../src/narrator'
import { calibratedNativeFaceWillingness, describeQuotedMessage, formatGroupSpeaker, normalizeAllowedReactions, normalizeGroupChatActions, normalizeQuotedMessageContent } from '../src/service'
import { ChatActionCapabilities, emptyStorySetting, emptyStoryState, GroupContext, InterludeStory, NarrativeDecision, NarrativeRequest } from '../src/types'

test('group speaker labels retain both display name and stable QQ identity', () => {
  assert.equal(formatGroupSpeaker('渔社', '2171322646'), '群成员「渔社」（QQ：2171322646）')
  assert.equal(formatGroupSpeaker('', '2171322646'), '群成员（QQ：2171322646）')
})

const context: GroupContext = {
  groupId: '100', channelId: 'group:100', label: '测试群', purpose: '', characterRole: '',
  messages: [{
    senderId: '200', senderName: '成员', speaker: '群成员「成员」（QQ：200）',
    messageRef: 'msg-7', messageId: '-12345', content: '这条消息可以被操作',
    occurredAt: new Date('2026-08-28T00:00:00.000Z'), direction: 'user',
  }],
}

const capabilities: ChatActionCapabilities = {
  platform: 'qq', quoteReply: true, reactions: ['like', 'heart'],
}

test('chat action validation accepts only advertised actions and supplied message references', () => {
  const valid: NarrativeDecision = {
    groupReply: { mode: 'immediate', content: '指定回复', replyTo: 'msg-7' },
    messageReactions: [{ messageRef: 'msg-7', reaction: 'heart' }],
  }
  assert.deepEqual(normalizeGroupChatActions(valid, capabilities, context), {
    replyTo: { messageRef: 'msg-7', messageId: '-12345' },
    reactions: [{ messageRef: 'msg-7', messageId: '-12345', reaction: 'heart' }],
  })

  const invalid = normalizeGroupChatActions({
    groupReply: { mode: 'immediate', content: '越界回复', replyTo: 'msg-999' },
    messageReactions: [{ messageRef: 'msg-7', reaction: 'angry' }],
  }, capabilities, context)
  assert.deepEqual(invalid, { reactions: [] })
  assert.deepEqual(normalizeGroupChatActions(valid, undefined, context), { reactions: [] })
})

test('reaction allowlist is semantic, deduplicated and bounded', () => {
  assert.deepEqual(normalizeAllowedReactions(['like', 'like', 'unknown', 'heart']), ['like', 'heart'])
})

test('native-face threshold is calibrated against reply meaning instead of a model-declared maximum', () => {
  assert.ok(calibratedNativeFaceWillingness('sweat', 1, '你还好意思问咋了') < 0.95)
  assert.ok(calibratedNativeFaceWillingness('laugh', 1, '哈哈哈你也太离谱了') < 0.95)
  assert.ok(calibratedNativeFaceWillingness('laugh', 1, '哈哈哈你也太离谱了') >= 0.7)
})

test('prompt payload hides message references until chat capabilities are active', () => {
  const now = new Date('2026-08-28T00:00:00.000Z')
  const story: InterludeStory = {
    id: 'story', platform: 'onebot', selfId: 'bot', userId: '', channelId: 'group:100', status: 'active',
    setting: emptyStorySetting(), state: emptyStoryState(), cursorAt: now, createdAt: now, updatedAt: now,
  }
  const base: NarrativeRequest = {
    phase: 'user-message', story, from: now, now, participant: null, participants: [], shareParticipantDetails: false,
    dueIntents: [], activeConsequences: [], supersededIntents: [], recentEntries: [], memories: [], groupContext: context,
  }
  const hidden = toPromptPayload(base) as Record<string, any>
  const visible = toPromptPayload({ ...base, chatCapabilities: capabilities }) as Record<string, any>
  assert.equal(hidden.chatCapabilities, undefined)
  assert.equal(hidden.groupContext.messages[0].messageRef, undefined)
  assert.equal(hidden.groupContext.messages[0].messageId, undefined)
  assert.equal(visible.groupContext.messages[0].messageRef, 'msg-7')
  assert.equal(visible.groupContext.messages[0].messageId, undefined)
})

test('quoted messages retain author ownership and bounded readable content', () => {
  assert.equal(normalizeQuotedMessageContent('看这个<image src="x"/><record src="y"/>'), '看这个[图片][语音]')
  const quote = describeQuotedMessage({
    selfId: '100',
    quote: { user: { id: '100', name: '机器人旧名' }, content: '这是主角之前说的话' },
  } as any, 'Yukiyo')
  assert.deepEqual(quote, {
    senderId: '100', senderName: 'Yukiyo', speaker: '主角「Yukiyo」', content: '这是主角之前说的话',
  })
})

test('quoted context is conditional and remains separate from the new message', () => {
  const now = new Date('2026-08-28T00:00:00.000Z')
  const story: InterludeStory = {
    id: 'story', platform: 'onebot', selfId: 'bot', userId: '', channelId: 'private:200', status: 'active',
    setting: emptyStorySetting(), state: emptyStoryState(), cursorAt: now, createdAt: now, updatedAt: now,
  }
  const base: NarrativeRequest = {
    phase: 'user-message', story, from: now, now, userMessage: '你这句话是什么意思', participant: null,
    participants: [], shareParticipantDetails: false, dueIntents: [], activeConsequences: [],
    supersededIntents: [], recentEntries: [], memories: [],
  }
  const withoutQuote = toPromptPayload(base) as Record<string, any>
  const withQuote = toPromptPayload({
    ...base,
    quotedMessages: [{ messageIndex: 1, senderId: 'bot', senderName: 'Yukiyo', speaker: '主角「Yukiyo」', content: '早点休息。' }],
  }) as Record<string, any>
  assert.equal(withoutQuote.currentEvent.quotedMessages, undefined)
  assert.equal(withQuote.currentEvent.content, '你这句话是什么意思')
  assert.equal(withQuote.currentEvent.quotedMessages[0].content, '早点休息。')

  const ordinaryPrompt = systemPrompt('user-message', '', '', '', '', '')
  const quotedPrompt = systemPrompt('user-message', '', '', '', '', '', false, false, false, false, false, undefined, true)
  assert.doesNotMatch(ordinaryPrompt, /CURRENT EVENT QUOTE/)
  assert.match(quotedPrompt, /quoted text as a second incoming message/)
  assert.match(quotedPrompt, /never change its author/)
})
