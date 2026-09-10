import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_PATTERN = /https:\/\/jbb-grok-chat-proxy\.[A-Za-z0-9.-]+\.workers\.dev\/?/g;

export function normalizeWorkerUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error('Worker 地址不是有效的网址。');
  }
  if (url.protocol !== 'https:') throw new Error('Worker 地址必须使用 HTTPS。');
  if (!url.hostname.endsWith('.workers.dev')) throw new Error('请输入 Cloudflare 返回的 workers.dev 地址。');
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

export function replaceWorkerUrl(content, value) {
  const workerUrl = normalizeWorkerUrl(value);
  if (!WORKER_PATTERN.test(content)) {
    WORKER_PATTERN.lastIndex = 0;
    throw new Error('文件中没有找到可替换的 Worker 地址。');
  }
  WORKER_PATTERN.lastIndex = 0;
  return content.replace(WORKER_PATTERN, workerUrl);
}

async function main() {
  const workerUrl = normalizeWorkerUrl(process.argv[2]);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const paths = [resolve(root, 'src/config.js'), resolve(root, 'index.html')];

  for (const path of paths) {
    const content = await readFile(path, 'utf8');
    await writeFile(path, replaceWorkerUrl(content, workerUrl), 'utf8');
  }

  process.stdout.write(`已写入 Worker 地址：${workerUrl}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
