import test from 'node:test';
import assert from 'node:assert/strict';

import { createSseParser, readChatStream } from '../src/sse.js';

test('createSseParser handles events split across arbitrary chunks', () => {
  const events = [];
  const parser = createSseParser((data) => events.push(data));

  parser.push('data: {"choices":[{"delta":{"con');
  parser.push('tent":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n');
  parser.push('\ndata: [DONE]\n\n');
  parser.finish();

  assert.deepEqual(events, [
    '{"choices":[{"delta":{"content":"你"}}]}',
    '{"choices":[{"delta":{"content":"好"}}]}',
    '[DONE]',
  ]);
});

test('createSseParser joins multiple data lines in one event', () => {
  const events = [];
  const parser = createSseParser((data) => events.push(data));

  parser.push('data: first\ndata: second\n\n');
  parser.finish();

  assert.deepEqual(events, ['first\nsecond']);
});

test('readChatStream emits text deltas and usage from a real stream', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"好"}}],"usage":{"prompt_tokens":12}}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  const deltas = [];
  let usage = null;

  const result = await readChatStream(stream, {
    onDelta: (text) => deltas.push(text),
    onUsage: (value) => {
      usage = value;
    },
  });

  assert.deepEqual(deltas, ['你', '好']);
  assert.deepEqual(usage, { prompt_tokens: 12 });
  assert.equal(result, '你好');
});

test('readChatStream emits reasoning summaries separately from answer text', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"先构思人物"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"故事开始"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  const reasoning = [];
  const answers = [];

  const result = await readChatStream(stream, {
    onReasoningDelta: (text) => reasoning.push(text),
    onDelta: (text) => answers.push(text),
  });

  assert.deepEqual(reasoning, ['先构思人物']);
  assert.deepEqual(answers, ['故事开始']);
  assert.equal(result, '故事开始');
});

test('readChatStream falls back to a string reasoning field when reasoning_content is not text', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":{"unexpected":true},"reasoning":"兼容摘要"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  const reasoning = [];

  await readChatStream(stream, { onReasoningDelta: (text) => reasoning.push(text) });

  assert.deepEqual(reasoning, ['兼容摘要']);
});

test('readChatStream surfaces an error event from the provider', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"error":{"message":"余额不足"}}\n\n'));
      controller.close();
    },
  });

  await assert.rejects(() => readChatStream(stream), /余额不足/);
});

test('readChatStream stops when the supplied signal is aborted', async () => {
  const controller = new AbortController();
  const stream = new ReadableStream({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n'));
    },
    cancel() {},
  });
  controller.abort();

  await assert.rejects(
    () => readChatStream(stream, { signal: controller.signal }),
    (error) => error?.name === 'AbortError',
  );
});
