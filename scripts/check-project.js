import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const modules = [
  'src/api.js',
  'src/app-helpers.js',
  'src/app.js',
  'src/config.js',
  'src/context-manager.js',
  'src/context.js',
  'src/models.js',
  'src/render.js',
  'src/sse.js',
  'src/storage.js',
  'scripts/check-project.js',
  'scripts/configure-worker.js',
  'worker/src/index.js',
];

for (const path of modules) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

const [html, config] = await Promise.all([
  readFile('index.html', 'utf8'),
  readFile('src/config.js', 'utf8'),
]);
const workerUrl = config.match(/proxyBaseUrl:\s*'([^']+)'/)?.[1];
if (!workerUrl || !html.includes(workerUrl)) {
  throw new Error('index.html 的 CSP 与 src/config.js 中的 Worker 地址不一致。');
}

if (workerUrl.includes('REPLACE-ME')) {
  process.stdout.write('检查通过；部署前仍需写入实际 Worker 地址。\n');
} else {
  process.stdout.write('检查通过；Worker 地址已配置。\n');
}
