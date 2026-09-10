import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeWorkerUrl, replaceWorkerUrl } from '../scripts/configure-worker.js';

test('normalizeWorkerUrl accepts HTTPS workers.dev URLs and removes trailing slashes', () => {
  assert.equal(
    normalizeWorkerUrl(' https://jbb-grok-chat-proxy.example.workers.dev/ '),
    'https://jbb-grok-chat-proxy.example.workers.dev',
  );
});

test('normalizeWorkerUrl rejects insecure and unrelated hosts', () => {
  assert.throws(() => normalizeWorkerUrl('http://demo.workers.dev'), /HTTPS/);
  assert.throws(() => normalizeWorkerUrl('https://example.com'), /workers\.dev/);
});

test('replaceWorkerUrl updates either the placeholder or a previous deployment URL', () => {
  const next = 'https://jbb-grok-chat-proxy.my-account.workers.dev';
  assert.equal(
    replaceWorkerUrl("proxyBaseUrl: 'https://jbb-grok-chat-proxy.REPLACE-ME.workers.dev'", next),
    `proxyBaseUrl: '${next}'`,
  );
  assert.equal(
    replaceWorkerUrl('connect-src https://jbb-grok-chat-proxy.old-account.workers.dev;', next),
    `connect-src ${next};`,
  );
});

test('replaceWorkerUrl refuses content without a replaceable worker URL', () => {
  assert.throws(() => replaceWorkerUrl('no worker here', 'https://proxy.demo.workers.dev'), /没有找到/);
});
