import test from 'node:test';
import assert from 'node:assert/strict';

import { ApiError, createApiClient, isContextOverflowError } from '../src/api.js';

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('listModels sends the bearer key to the proxy and returns normalized data', async () => {
  let capturedRequest;
  const client = createApiClient({
    baseUrl: 'https://proxy.example',
    fetchImpl: async (request) => {
      capturedRequest = request;
      return jsonResponse({ data: [{ id: 'grok-4' }] });
    },
  });

  const models = await client.listModels('sk-secret');

  assert.deepEqual(models, [{ id: 'grok-4' }]);
  assert.equal(capturedRequest.url, 'https://proxy.example/v1/models');
  assert.equal(capturedRequest.method, 'GET');
  assert.equal(capturedRequest.headers.get('authorization'), 'Bearer sk-secret');
});

test('streamChat emits streamed content and sends only the OpenAI-compatible fields', async () => {
  let capturedBody;
  const encoder = new TextEncoder();
  const client = createApiClient({
    baseUrl: 'https://proxy.example/',
    fetchImpl: async (request) => {
      capturedBody = await request.json();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"回答"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const deltas = [];

  const text = await client.streamChat({
    apiKey: 'key',
    model: 'grok-4',
    messages: [{ role: 'user', content: '问题' }],
    onDelta: (delta) => deltas.push(delta),
  });

  assert.equal(text, '回答');
  assert.deepEqual(deltas, ['回答']);
  assert.deepEqual(capturedBody, {
    model: 'grok-4',
    messages: [{ role: 'user', content: '问题' }],
    stream: true,
  });
});

test('summarize returns assistant content from a non-stream response', async () => {
  const client = createApiClient({
    baseUrl: 'https://proxy.example',
    fetchImpl: async () => jsonResponse({
      choices: [{ message: { content: '## 用户目标\n完成项目' } }],
    }),
  });

  const summary = await client.summarize({
    apiKey: 'key',
    model: 'grok-4',
    messages: [{ role: 'user', content: '历史' }],
  });

  assert.equal(summary, '## 用户目标\n完成项目');
});

test('API errors expose safe provider messages and status codes', async () => {
  const client = createApiClient({
    baseUrl: 'https://proxy.example',
    fetchImpl: async () => jsonResponse(
      { error: { message: 'Invalid token', code: 'invalid_api_key' } },
      { status: 401 },
    ),
  });

  await assert.rejects(
    () => client.listModels('bad-key'),
    (error) => error instanceof ApiError
      && error.status === 401
      && error.code === 'invalid_api_key'
      && error.message === '密钥无效或已过期，请重新检查。',
  );
});

test('rate limits and server failures use concise Chinese messages', async () => {
  const responses = [
    jsonResponse({ error: { message: 'rate limit' } }, { status: 429 }),
    jsonResponse({ error: { message: 'upstream unavailable' } }, { status: 503 }),
  ];
  const client = createApiClient({
    baseUrl: 'https://proxy.example',
    fetchImpl: async () => responses.shift(),
  });

  await assert.rejects(() => client.listModels('key'), /请求过于频繁或账户额度不足/);
  await assert.rejects(() => client.listModels('key'), /服务暂时不可用/);
});

test('network failures are reported without leaking low-level details', async () => {
  const client = createApiClient({
    baseUrl: 'https://proxy.example',
    fetchImpl: async () => { throw new Error('ECONNRESET internal-host'); },
  });

  await assert.rejects(
    () => client.listModels('key'),
    (error) => error instanceof ApiError
      && error.status === 0
      && error.message === '网络连接失败，请检查网络或 Worker 地址。'
      && !error.message.includes('internal-host'),
  );
});

test('isContextOverflowError recognizes provider variants without matching unrelated errors', () => {
  assert.equal(isContextOverflowError(new ApiError('maximum context length exceeded', 400)), true);
  assert.equal(isContextOverflowError(new ApiError('请求太长', 400, 'context_length_exceeded')), true);
  assert.equal(isContextOverflowError(new ApiError('余额不足', 400)), false);
});
