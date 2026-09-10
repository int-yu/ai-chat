import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

import { renderMarkdown } from '../src/render.js';

function render(markdown) {
  const { document } = parseHTML('<main id="output"></main>');
  const output = document.querySelector('#output');
  renderMarkdown(output, markdown);
  return output;
}

test('renderMarkdown treats raw HTML as text rather than executable markup', () => {
  const output = render('<img src=x onerror="alert(1)">');

  assert.equal(output.querySelector('img'), null);
  assert.equal(output.textContent, '<img src=x onerror="alert(1)">');
});

test('renderMarkdown creates headings, lists and fenced code blocks', () => {
  const output = render('# 标题\n\n- 第一项\n- 第二项\n\n```js\nconst value = 1 < 2;\n```');

  assert.equal(output.querySelector('h1').textContent, '标题');
  assert.deepEqual([...output.querySelectorAll('li')].map((item) => item.textContent), ['第一项', '第二项']);
  assert.equal(output.querySelector('code.language-js').textContent, 'const value = 1 < 2;');
});

test('renderMarkdown supports safe links and refuses javascript URLs', () => {
  const output = render('[官网](https://example.com) [危险](javascript:alert(1))');
  const links = [...output.querySelectorAll('a')];

  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://example.com/');
  assert.equal(links[0].target, '_blank');
  assert.equal(links[0].rel, 'noopener noreferrer');
  assert.match(output.textContent, /危险/);
});

test('renderMarkdown supports emphasis and inline code without interpreting their contents', () => {
  const output = render('**重要**、*提示*、`<script>`');

  assert.equal(output.querySelector('strong').textContent, '重要');
  assert.equal(output.querySelector('em').textContent, '提示');
  assert.equal(output.querySelector('code').textContent, '<script>');
  assert.equal(output.querySelector('script'), null);
});
