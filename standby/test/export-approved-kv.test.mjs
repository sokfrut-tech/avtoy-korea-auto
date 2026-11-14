import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('approved KV exporter refuses to run without explicit confirmation and credentials', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'avtoy-kv-export-'));
  try {
    const output = path.join(dir, 'private-export.json');
    const env = { ...process.env };
    delete env.CF_ACCOUNT_ID;
    delete env.CF_KV_NAMESPACE_ID;
    delete env.CLOUDFLARE_API_TOKEN;
    const run = spawnSync(process.execPath, [path.join(root, 'scripts/export-approved-kv.mjs'), output], { encoding: 'utf8', env });
    assert.equal(run.status, 2);
    await assert.rejects(access(output));
    assert.match(run.stderr, /Refusing to export/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
