// Incremental batched push helper for publishing standby/public to GitVerse Pages.
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(SCRIPT_DIR, '..', 'public');
const MAX_BATCH_BYTES = 18 * 1024 * 1024; // 18 MB ceiling to avoid HTTP 413 on GitVerse

function gitExec(args, extraArgs = []) {
  return execFileSync('git', [...extraArgs, ...args], {
    cwd: PUBLIC_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function buildAuthArgs() {
  const token = String(process.env.GITVERSE_TOKEN || '').trim();
  if (!token) return [];
  const user = String(process.env.GITVERSE_USER || 'opus_pampus').trim();
  const b64 = Buffer.from(`${user}:${token}`, 'utf8').toString('base64');
  return [
    '-c', 'credential.helper=',
    '-c', `http.https://gitverse.ru/.extraheader=Authorization: Basic ${b64}`
  ];
}

async function main() {
  const authArgs = buildAuthArgs();
  const statusOut = gitExec(['-c', 'core.quotePath=false', 'status', '--porcelain', '-u']);
  if (!statusOut) {
    console.log('Зеркало GitVerse не требует коммита (изменений нет).');
    return;
  }

  gitExec(['config', 'user.name', 'AVTOY KOREA AutoSync']);
  gitExec(['config', 'user.email', 'noreply@avtoykorea.local']);

  const deleted = [];
  const upserted = [];
  for (const line of statusOut.split(/\r?\n/)) {
    if (!line) continue;
    const code = line.slice(0, 2);
    let rel = line.slice(3).trim();
    if (rel.startsWith('"') && rel.endsWith('"')) {
      rel = rel.slice(1, -1);
    }
    if (rel.includes(' -> ')) rel = rel.split(' -> ').pop().trim();
    if (!rel) continue;
    if (code.includes('D')) {
      deleted.push(rel);
      continue;
    }
    try {
      const st = await fs.stat(path.join(PUBLIC_DIR, rel));
      if (st.isFile()) upserted.push({ rel, size: st.size });
    } catch {
      deleted.push(rel);
    }
  }

  if (deleted.length) {
    gitExec(['rm', '-q', '--ignore-unmatch', '--', ...deleted]);
    const stAfterRm = gitExec(['diff', '--cached', '--name-only']);
    if (stAfterRm) {
      gitExec(['commit', '-q', '-m', 'chore: prune unpublished showcase media & pages']);
      gitExec(['push', 'origin', 'main'], authArgs);
    }
  }

  if (!upserted.length) {
    console.log('Синхронизация GitVerse завершена (удаления применены).');
    return;
  }

  upserted.sort((a, b) => a.size - b.size);
  const batches = [];
  let cur = [];
  let curBytes = 0;
  for (const item of upserted) {
    if (cur.length > 0 && curBytes + item.size > MAX_BATCH_BYTES) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(item.rel);
    curBytes += item.size;
  }
  if (cur.length > 0) batches.push(cur);

  for (let i = 0; i < batches.length; i++) {
    gitExec(['add', '--', ...batches[i]]);
    const staged = gitExec(['diff', '--cached', '--name-only']);
    if (!staged) continue;
    gitExec(['commit', '-q', '-m', `chore: auto-sync showcase batch ${i + 1}/${batches.length}`]);
    gitExec(['push', 'origin', 'main'], authArgs);
  }
  console.log(`Зеркало GitVerse обновлено (${batches.length} пакет(а), файлов: ${upserted.length}).`);
}

main().catch(err => {
  console.error('Ошибка отправки в GitVerse:', err.stderr ? String(err.stderr) : (err.message || err));
  process.exitCode = 1;
});
