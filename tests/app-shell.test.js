import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';

async function loadDocument() {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  return parseHTML(html).document;
}

test('app shell exposes the core mobile chat controls with accessible labels', async () => {
  const document = await loadDocument();

  assert.ok(document.querySelector('meta[name="viewport"]')?.content.includes('viewport-fit=cover'));
  assert.ok(document.querySelector('meta[name="viewport"]')?.content.includes('interactive-widget=resizes-content'));
  assert.equal(document.querySelector('main')?.getAttribute('aria-label'), '聊天内容');
  assert.equal(document.querySelector('#message-input')?.getAttribute('aria-label'), '输入消息');
  assert.equal(document.querySelector('#send-button')?.textContent.trim(), '发送');
  assert.equal(document.querySelector('#new-chat-button')?.getAttribute('aria-label'), '新建对话');
  assert.equal(document.querySelector('#empty-state'), null);
  assert.equal(document.querySelectorAll('[data-suggestion]').length, 0);
  assert.ok(document.querySelector('#settings-dialog'));
  assert.ok(document.querySelector('#memory-dialog'));
  assert.equal(document.querySelector('link[rel="preconnect"]')?.href, 'https://jbb-grok-chat-proxy.inta95870.workers.dev');
});

test('app shell loads only local scripts and styles at runtime', async () => {
  const document = await loadDocument();
  const resourceUrls = [
    ...[...document.querySelectorAll('script[src]')].map((element) => element.getAttribute('src')),
    ...[...document.querySelectorAll('link[rel="stylesheet"]')].map((element) => element.getAttribute('href')),
  ];

  assert.ok(resourceUrls.length >= 2);
  assert.equal(resourceUrls.every((url) => url.startsWith('./')), true);
  assert.equal(document.querySelector('script[type="module"]')?.getAttribute('src'), './src/app.js');
});

test('content security policy denies arbitrary network and script origins', async () => {
  const document = await loadDocument();
  const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '';
  const config = await readFile(new URL('../src/config.js', import.meta.url), 'utf8');
  const workerUrl = config.match(/proxyBaseUrl:\s*'([^']+)'/)?.[1];

  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /script-src 'self'/);
  assert.ok(workerUrl);
  assert.ok(policy.includes(`connect-src 'self' ${workerUrl}`));
  assert.match(policy, /object-src 'none'/);
});
