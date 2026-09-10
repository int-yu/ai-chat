import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildApiMessages,
  buildSummaryMessages,
  estimateMessagesTokens,
  estimateTextTokens,
  getCompactionThreshold,
  resolveContextWindow,
  splitForCompaction,
  shouldCompact,
} from '../src/context.js';

test('estimateTextTokens counts CJK conservatively and groups ASCII', () => {
  assert.equal(estimateTextTokens('你好abcde'), 4);
  assert.equal(estimateTextTokens('abcdefgh'), 2);
});

test('estimateMessagesTokens includes per-message and reply overhead', () => {
  const messages = [
    { role: 'user', content: 'abcdefgh' },
    { role: 'assistant', content: '你好' },
  ];

  assert.equal(estimateMessagesTokens(messages), 14);
});

test('compaction threshold reserves output and triggers at seventy percent', () => {
  assert.equal(getCompactionThreshold(128_000, 8_192), 83_865);
  assert.equal(shouldCompact(83_864, 128_000, 8_192), false);
  assert.equal(shouldCompact(83_865, 128_000, 8_192), true);
});

test('resolveContextWindow prefers valid model metadata and otherwise uses default', () => {
  assert.equal(resolveContextWindow({ context_window: 262_144 }), 262_144);
  assert.equal(resolveContextWindow({ context_length: 131_072 }), 131_072);
  assert.equal(resolveContextWindow({ context_window: 'huge' }), 128_000);
});

test('splitForCompaction retains the latest eight complete turns', () => {
  const messages = Array.from({ length: 10 }, (_, index) => [
    { role: 'user', content: `u${index}` },
    { role: 'assistant', content: `a${index}` },
  ]).flat();

  const { older, recent } = splitForCompaction(messages, 8);

  assert.deepEqual(older.map((message) => message.content), ['u0', 'a0', 'u1', 'a1']);
  assert.equal(recent.length, 16);
  assert.equal(recent[0].content, 'u2');
});

test('splitForCompaction does not separate a user message from its answer', () => {
  const messages = [
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'new question' },
  ];

  const { older, recent } = splitForCompaction(messages, 1);

  assert.deepEqual(older.map((message) => message.content), ['old question', 'old answer']);
  assert.deepEqual(recent.map((message) => message.content), ['new question']);
});

test('buildApiMessages places guarded memory before recent original messages', () => {
  const messages = buildApiMessages('用户偏好简洁回答', [
    { role: 'user', content: '继续' },
  ]);

  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /仅作为历史参考/);
  assert.match(messages[0].content, /用户偏好简洁回答/);
  assert.deepEqual(messages[1], { role: 'user', content: '继续' });
});

test('buildSummaryMessages includes prior memory and messages to compact', () => {
  const messages = buildSummaryMessages('旧摘要', [
    { role: 'user', content: '项目代号是 Orion' },
    { role: 'assistant', content: '已记录' },
  ]);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[1].content, /旧摘要/);
  assert.match(messages[1].content, /项目代号是 Orion/);
  assert.match(messages[0].content, /未解决事项/);
});
