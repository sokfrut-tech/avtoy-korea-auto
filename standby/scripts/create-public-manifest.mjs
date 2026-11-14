import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [snapshotPath, mediaDir = 'public/media', outputPath = 'data/public-manifest.json'] = process.argv.slice(2);
if (!snapshotPath) {
  process.stderr.write('Usage: node scripts/create-public-manifest.mjs <public-snapshot.json> [public/media] [manifest.json]\n');
  process.exit(2);
}
const snapshotBytes = await fs.readFile(snapshotPath);
const snapshot = JSON.parse(snapshotBytes.toString('utf8'));
if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.cars) || !Array.isArray(snapshot.reviews)) {
  throw new Error('Unsupported public snapshot schema');
}
const referenced = new Set();
for (const record of [...snapshot.cars, ...snapshot.reviews]) {
  if (!Array.isArray(record.mediaItems)) throw new Error('Record has no mediaItems array');
  for (const media of record.mediaItems) {
    if (!media || !['photo', 'video'].includes(media.type) || typeof media.url !== 'string' ||
        !/^\/media\/[a-zA-Z0-9._-]+$/.test(media.url)) {
      throw new Error('Unsafe or unsupported public media URL');
    }
    referenced.add(media.url.slice('/media/'.length));
  }
}
const files = [];
let totalBytes = 0;
for (const filename of [...referenced].sort()) {
  if (filename === '.' || filename === '..') throw new Error('Unsafe public media filename');
  const filePath = path.join(mediaDir, filename);
  const bytes = await fs.readFile(filePath);
  if (!bytes.length) throw new Error('Empty public media file: ' + filename);
  totalBytes += bytes.length;
  files.push({ path: '/media/' + filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const manifest = {
  manifestVersion: 1,
  snapshot: {
    schemaVersion: snapshot.schemaVersion,
    sha256: createHash('sha256').update(snapshotBytes).digest('hex'),
    bytes: snapshotBytes.length
  },
  counts: { cars: snapshot.cars.length, reviews: snapshot.reviews.length, mediaFiles: files.length },
  mediaBytes: totalBytes,
  media: files
};
await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
process.stdout.write('Manifest verified: ' + manifest.counts.cars + ' cars, ' + manifest.counts.reviews +
  ' reviews, ' + files.length + ' media files, ' + totalBytes + ' media bytes\n');
