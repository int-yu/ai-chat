import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MessageTooLongError,
  prepareConversationContext,
} from '../src/context-manager.js';
import { createConversation } from '../src/storage.js';

function tenShortTurns() {
  return Array.from({ length: 10 }, (_, index) => [
    { id: `u${index}`, role: 'user', content: `问题 ${index}`, status: 'complete' },
    { id: `a${index}`, role: 'assistant', content: `回答 ${index}`, status: 'complete' },
  ]).flat();
}

test('prepareConversationContext compacts older turns and keeps eight recent turns verbatim', async () => {
  const conversation = {
    ...createConversation({ id: 'chat', modelId: 'grok-4', contextWindow: 100 }),
    messages: tenShortTurns(),
  };
  let summaryRequest;
  const client = {
    summarize: async (request) => {
      summaryRequest = request;
      return '## 用户目标\n保留目标';
    },
  };

  const result = await prepareConversationContext({
    conversation,
    client,
    apiKey: 'key',
    model: { id: 'grok-4', context_window: 100 },
    outputReserve: 10,
  });

  assert.equal(result.compacted, true);
  assert.equal(result.conversation.compactedMessageCount, 4);
  assert.equal(result.conversation.compactionCount, 1);
  assert.match(result.conversation.memorySummary, /保留目标/);
  assert.equal(result.apiMessages[0].role, 'system');
  assert.deepEqual(result.apiMessages.slice(1).map(({ content }) => content), tenShortTurns().slice(4).map(({ content }) => content));
  assert.match(summaryRequest.messages[1].content, /问题 0/);
  assert.doesNotMatch(summaryRequest.messages[1].content, /问题 2/);
});

test('prepareConversationContext leaves short conversations unchanged', async () => {
  const conversation = {
    ...createConversation({ id: 'chat', modelId: 'grok-4' }),
    messages: [{ id: 'u1', role: 'user', content: '你好', status: 'complete' }],
  };
  let summarizeCalls = 0;

  const result = await prepareConversationContext({
    conversation,
    client: { summarize: async () => { summarizeCalls += 1; } },
    apiKey: 'key',
    model: { id: 'grok-4' },
  });

  assert.equal(result.compacted, false);
  assert.equal(summarizeCalls, 0);
  assert.equal(result.apiMessages[0].content, '你好');
  assert.equal(result.conversation, conversation);
});

test('forced compaction runs below the automatic threshold when older turns exist', async () => {
  const conversation = {
    ...createConversation({ id: 'chat', modelId: 'grok-4' }),
    messages: tenShortTurns(),
  };

  const result = await prepareConversationContext({
    conversation,
    client: { summarize: async () => '强制摘要' },
    apiKey: 'key',
    model: { id: 'grok-4' },
    force: true,
  });

  assert.equal(result.compacted, true);
  assert.equal(result.conversation.compactedMessageCount, 4);
});

test('a later compaction merges prior memory and advances from the previous boundary', async () => {
  const conversation = {
    ...createConversation({ id: 'chat', modelId: 'grok-4' }),
    memorySummary: '第一版摘要',
    compactedMessageCount: 4,
    compactionCount: 1,
    messages: [...tenShortTurns(),
      { id: 'u10', role: 'user', content: '问题 10', status: 'complete' },
      { id: 'a10', role: 'assistant', content: '回答 10', status: 'complete' },
    ],
  };
  let summaryBody = '';

  const result = await prepareConversationContext({
    conversation,
    client: { summarize: async ({ messages }) => {
      summaryBody = messages[1].content;
      return '第二版摘要';
    } },
    apiKey: 'key',
    model: { id: 'grok-4' },
    force: true,
  });

  assert.match(summaryBody, /第一版摘要/);
  assert.match(summaryBody, /问题 2/);
  assert.doesNotMatch(summaryBody, /问题 0/);
  assert.equal(result.conversation.compactedMessageCount, 6);
  assert.equal(result.conversation.compactionCount, 2);
});

test('summary failure leaves the original conversation untouched', async () => {
  const conversation = {
    ...createConversation({ id: 'chat', modelId: 'grok-4' }),
    messages: tenShortTurns(),
  };
  const snapshot = structuredClone(conversation);

  await assert.rejects(() => prepareConversationContext({
    conversation,
    client: { summarize: async () => { throw new Error('summary failed'); } },
    apiKey: 'key',
    model: { id: 'grok-4' },
    force: true,
  }), /summary failed/);

  assert.deepEqual(conversation, snapshot);
});

test('one message larger than the usable context is rejected without truncation', async () => {
  const conversation = {
    ...createConversation({ id: 'chat', modelId: 'grok-4', contextWindow: 100 }),
    messages: [{ id: 'u1', role: 'user', content: '你'.repeat(95), status: 'complete' }],
  };

  await assert.rejects(() => prepareConversationContext({
    conversation,
    client: { summarize: async () => 'unused' },
    apiKey: 'key',
    model: { id: 'grok-4', context_window: 100 },
    outputReserve: 10,
  }), (error) => error instanceof MessageTooLongError);
});
