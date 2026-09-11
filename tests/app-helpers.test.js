import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseModel,
  createFrameBatcher,
  createMessage,
  getVisibleViewportGeometry,
  hasMessageOutput,
  isNearScrollBottom,
  isProxyConfigured,
  normalizeLoadedConversation,
  prepareAssistantRetry,
  stopGenerationAndWait,
} from '../src/app-helpers.js';

test('getVisibleViewportGeometry tracks the keyboard-aware viewport height and offset', () => {
  assert.deepEqual(
    getVisibleViewportGeometry({ innerHeight: 844, visualViewport: { height: 508, offsetTop: 64 } }),
    { height: 508, offsetTop: 64 },
  );
  assert.deepEqual(getVisibleViewportGeometry({ innerHeight: 844 }), { height: 844, offsetTop: 0 });
});

test('createFrameBatcher renders only the latest state once per frame', () => {
  const frames = [];
  const rendered = [];
  const batch = createFrameBatcher((callback) => frames.push(callback));

  batch(() => rendered.push('旧内容'));
  batch(() => rendered.push('最新内容'));

  assert.equal(frames.length, 1);
  frames[0]();
  assert.deepEqual(rendered, ['最新内容']);
});

test('createFrameBatcher cancel prevents a stale queued frame from rendering', () => {
  const frames = [];
  const rendered = [];
  const batch = createFrameBatcher((callback) => frames.push(callback));

  batch(() => rendered.push('不应出现'));
  batch.cancel();
  frames[0]();

  assert.deepEqual(rendered, []);
});

test('createFrameBatcher flush renders the latest state immediately and invalidates the queued frame', () => {
  const frames = [];
  const rendered = [];
  const batch = createFrameBatcher((callback) => frames.push(callback));

  batch(() => rendered.push('旧内容'));
  batch(() => rendered.push('最终内容'));
  batch.flush();
  assert.deepEqual(rendered, ['最终内容']);

  frames[0]();
  assert.deepEqual(rendered, ['最终内容']);
});

test('isNearScrollBottom follows new content only while the reader stays near the bottom', () => {
  assert.equal(isNearScrollBottom({ scrollTop: 900, clientHeight: 500, scrollHeight: 1_480 }), true);
  assert.equal(isNearScrollBottom({ scrollTop: 700, clientHeight: 500, scrollHeight: 1_480 }), false);
  assert.equal(isNearScrollBottom({ scrollTop: 0, clientHeight: 500, scrollHeight: 400 }), true);
});

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
    reasoning: '',
  });
  assert.equal(createMessage('assistant', '', { id: 'm2' }).status, 'streaming');
});

test('hasMessageOutput keeps reasoning-only stopped responses', () => {
  assert.equal(hasMessageOutput({ content: '', reasoning: '已返回的推理摘要' }), true);
  assert.equal(hasMessageOutput({ content: '部分正文', reasoning: '' }), true);
  assert.equal(hasMessageOutput({ content: '', reasoning: '' }), false);
});

test('prepareAssistantRetry clears both the old answer and reasoning summary', () => {
  const message = { content: '旧回答', reasoning: '旧摘要', status: 'error' };

  assert.equal(prepareAssistantRetry(message), message);
  assert.deepEqual(message, { content: '', reasoning: '', status: 'streaming' });
});

test('normalizeLoadedConversation repairs interrupted streams and old records', () => {
  const conversation = normalizeLoadedConversation({
    id: 'old',
    title: '旧记录',
    messages: [{ id: 'a1', role: 'assistant', content: '部分回答', status: 'streaming' }],
  });

  assert.equal(conversation.messages[0].status, 'stopped');
  assert.equal(conversation.messages[0].reasoning, '');
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
