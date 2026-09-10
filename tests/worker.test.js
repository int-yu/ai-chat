import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkerHandler, MAX_REQUEST_BYTES } from '../worker/src/index.js';

const origin = 'https://int-yu.github.io';

function makeHandler(fetchImpl) {
  return createWorkerHandler({
    fetchImpl,
    upstreamBase: 'https://jbbtoken.pages.dev',
    allowedOrigins: [origin],
  });
}

test('allowed CORS preflight returns the required headers', async () => {
  const handler = makeHandler(async () => {
    throw new Error('upstream must not be called');
  });
  const response = await handler(new Request('https://worker.example/v1/chat/completions', {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  }));

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.match(response.headers.get('access-control-allow-headers'), /Authorization/i);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('requests from other browser origins are rejected', async () => {
  const handler = makeHandler(async () => new Response('unexpected'));
  const response = await handler(new Request('https://worker.example/v1/models', {
    headers: { origin: 'https://evil.example', authorization: 'Bearer key' },
  }));

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: { message: '不允许的请求来源' } });
});

test('model listing forwards authorization but strips browser cookies', async () => {
  let upstreamRequest;
  const handler = makeHandler(async (request) => {
    upstreamRequest = request;
    return new Response(JSON.stringify({ data: [{ id: 'grok-4' }] }), {
      headers: { 'content-type': 'application/json', 'x-upstream-secret': 'hidden' },
    });
  });
  const response = await handler(new Request('https://worker.example/v1/models?ignored=yes', {
    headers: {
      origin,
      authorization: 'Bearer key',
      cookie: 'session=private',
    },
  }));

  assert.equal(upstreamRequest.url, 'https://jbbtoken.pages.dev/v1/models');
  assert.equal(upstreamRequest.headers.get('authorization'), 'Bearer key');
  assert.equal(upstreamRequest.headers.get('cookie'), null);
  assert.equal(response.headers.get('x-upstream-secret'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { data: [{ id: 'grok-4' }] });
});

test('chat completion rejects non-Grok models before contacting upstream', async () => {
  let upstreamCalled = false;
  const handler = makeHandler(async () => {
    upstreamCalled = true;
    return new Response();
  });
  const response = await handler(new Request('https://worker.example/v1/chat/completions', {
    method: 'POST',
    headers: { origin, authorization: 'Bearer key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5', messages: [], stream: true }),
  }));

  assert.equal(response.status, 400);
  assert.equal(upstreamCalled, false);
  assert.match((await response.json()).error.message, /Grok/);
});

test('chat completion rejects non-JSON and oversized requests', async () => {
  const handler = makeHandler(async () => new Response('unexpected'));
  const wrongType = await handler(new Request('https://worker.example/v1/chat/completions', {
    method: 'POST',
    headers: { origin, authorization: 'Bearer key', 'content-type': 'text/plain' },
    body: 'hello',
  }));
  const oversized = await handler(new Request('https://worker.example/v1/chat/completions', {
    method: 'POST',
    headers: {
      origin,
      authorization: 'Bearer key',
      'content-type': 'application/json',
      'content-length': String(MAX_REQUEST_BYTES + 1),
    },
    body: '{}',
  }));

  assert.equal(wrongType.status, 415);
  assert.equal(oversized.status, 413);
});

test('chat completion rejects malformed JSON without contacting upstream', async () => {
  let upstreamCalled = false;
  const handler = makeHandler(async () => {
    upstreamCalled = true;
    return new Response();
  });
  const response = await handler(new Request('https://worker.example/v1/chat/completions', {
    method: 'POST',
    headers: { origin, authorization: 'Bearer key', 'content-type': 'application/json' },
    body: '{not-json',
  }));

  assert.equal(response.status, 400);
  assert.equal(upstreamCalled, false);
  assert.match((await response.json()).error.message, /JSON/);
});

test('chat completion preserves the upstream event stream body', async () => {
  const encoder = new TextEncoder();
  const handler = makeHandler(async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[]}\n\n'));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  ));
  const response = await handler(new Request('https://worker.example/v1/chat/completions', {
    method: 'POST',
    headers: { origin, authorization: 'Bearer key', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-4',
      messages: [{ role: 'user', content: '你好' }],
      stream: true,
    }),
  }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(await response.text(), 'data: {"choices":[]}\n\n');
});

test('unknown paths and missing authorization are rejected', async () => {
  const handler = makeHandler(async () => new Response('unexpected'));
  const missingPath = await handler(new Request('https://worker.example/v1/responses', {
    headers: { origin, authorization: 'Bearer key' },
  }));
  const missingKey = await handler(new Request('https://worker.example/v1/models', {
    headers: { origin },
  }));

  assert.equal(missingPath.status, 404);
  assert.equal(missingKey.status, 401);
});
