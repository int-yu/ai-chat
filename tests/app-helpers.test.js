import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseModel,
  createMessage,
  isProxyConfigured,
  normalizeLoadedConversation,
  stopGenerationAndWait,
} from '../src/app-helpers.js';

test('chooseModel preserves a valid selection and otherwise chooses the first Grok model', () => {
  const models = [{ id: 'grok-4' }, { id: 'grok-code-fast-1' }];

  assert.equal(chooseModel(models, 'grok-code-fast-1', ''), 'grok-code-fast-1');
  assert.equal(chooseModel(models, 'missing', ''), 'grok-4');
  assert.equal(chooseModel([], '', 'custom-grok-model'), 'custom-grok-model');
  assert.equal(chooseModel([], '', 'gpt-5'), '');
});

test('createMessage creates the expected persisted message shape', () => {
  assert.deepEqual(createMessage('user', '你好', { id: 'm1', now: 123 }), {
    id: 'm1',
    role: 'user',
    content: '你好',
    createdAt: 123,
    status: 'complete',
  });
  assert.equal(createMessage('assistant', '', { id: 'm2' }).status, 'streaming');
});

test('normalizeLoadedConversation repairs interrupted streams and old records', () => {
  const conversation = normalizeLoadedConversation({
    id: 'old',
    title: '旧记录',
    messages: [{ id: 'a1', role: 'assistant', content: '部分回答', status: 'streaming' }],
  });

  assert.equal(conversation.messages[0].status, 'stopped');
  assert.equal(conversation.compactedMessageCount, 0);
  assert.equal(conversation.compactionCount, 0);
  assert.equal(conversation.contextWindow, 128_000);
});

test('isProxyConfigured rejects the shipped placeholder and accepts HTTPS workers URLs', () => {
  assert.equal(isProxyConfigured('https://jbb-grok-chat-proxy.REPLACE-ME.workers.dev'), false);
  assert.equal(isProxyConfigured('http://proxy.example'), false);
  assert.equal(isProxyConfigured('https://jbb-grok-chat-proxy.example.workers.dev'), true);
});

test('stopGenerationAndWait aborts first and waits for generation cleanup', async () => {
  const events = [];
  const controller = { abort: () => events.push('abort') };
  const generation = Promise.resolve().then(() => events.push('settled'));

  await stopGenerationAndWait(controller, generation);

  assert.deepEqual(events, ['abort', 'settled']);
});
