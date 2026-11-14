import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('public manifest hashes snapshot and every referenced media file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'avtoy-manifest-'));
  try {
    const mediaDir = path.join(dir, 'media');
    await mkdir(mediaDir);
    const media = Buffer.from('public image bytes');
    await writeFile(path.join(mediaDir, 'car.jpg'), media);
    const snapshot = { schemaVersion: 1, cars: [{ id: 'car_1', mediaItems: [{ type: 'photo', url: '/media/car.jpg' }] }], reviews: [] };
    const snapshotPath = path.join(dir, 'snapshot.json');
    const manifestPath = path.join(dir, 'manifest.json');
    await writeFile(snapshotPath, JSON.stringify(snapshot));
    const run = spawnSync(process.execPath, [path.join(root, 'scripts/create-public-manifest.mjs'), snapshotPath, mediaDir, manifestPath], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.deepEqual(manifest.counts, { cars: 1, reviews: 0, mediaFiles: 1 });
    assert.equal(manifest.mediaBytes, media.length);
    assert.equal(manifest.media[0].sha256, createHash('sha256').update(media).digest('hex'));
    assert.equal(manifest.snapshot.sha256, createHash('sha256').update(await readFile(snapshotPath)).digest('hex'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('public manifest refuses missing media instead of silently accepting an incomplete mirror', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'avtoy-manifest-missing-'));
  try {
    const mediaDir = path.join(dir, 'media'); await mkdir(mediaDir);
    const snapshotPath = path.join(dir, 'snapshot.json');
    await writeFile(snapshotPath, JSON.stringify({ schemaVersion: 1, cars: [{ mediaItems: [{ type: 'photo', url: '/media/missing.jpg' }] }], reviews: [] }));
    const run = spawnSync(process.execPath, [path.join(root, 'scripts/create-public-manifest.mjs'), snapshotPath, mediaDir, path.join(dir, 'manifest.json')], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
