import { assertPublicCarMediaOrder } from './media-order-eligibility.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const base = new URL(process.env.SOURCE_WORKER_URL || 'https://avtoy-korea-auto.sokfrut.workers.dev/');
if (base.protocol !== 'https:' || base.hostname !== 'avtoy-korea-auto.sokfrut.workers.dev') throw new Error('Unexpected public source host');
const mediaRoot = path.resolve('public/media');
const stageRoot = await fs.mkdtemp(path.join(path.dirname(mediaRoot), '.media-staging-'));
const backupRoot = mediaRoot + '.backup-' + process.pid + '-' + Date.now();
let previousMoved = false;
let published = false;

async function readLimited(response, maxBytes) {
  if (!response.body) throw new Error('Media response has no body');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Media item exceeds 25 MB safety limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

try {
  const getJson = async route => {
    const response = await fetch(new URL(route, base), { headers:{ accept:'application/json' }, signal:AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Public catalogue API failed: ' + route + ' HTTP ' + response.status);
    return response.json();
  };
  const carsData = await getJson('/api/cars');
  const reviewsData = await getJson('/api/reviews');
  if (!Array.isArray(carsData.cars) || !Array.isArray(reviewsData.reviews)) throw new Error('Public catalogue API returned an unexpected schema');
  let mediaCount = 0;
  async function localize(items, prefix) {
    if (!Array.isArray(items)) throw new Error('Invalid public media list');
    const localized = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const sourcePath = typeof item === 'string' ? item : item?.url;
      if (typeof sourcePath !== 'string' || !sourcePath.startsWith('/api/')) throw new Error('Refusing non-local public media URL');
      const response = await fetch(new URL(sourcePath, base), { signal:AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error('Media download failed: HTTP ' + response.status);
      const mime = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
      const allowed = new Map([
        ['image/jpeg','jpg'],['image/png','png'],['image/webp','webp'],['image/gif','gif'],
        ['video/mp4','mp4'],['video/webm','webm'],['video/quicktime','mov']
      ]);
      const ext = allowed.get(mime);
      if (!ext) throw new Error('Unsupported media type: ' + mime);
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > 25000000) throw new Error('Media item exceeds 25 MB safety limit');
      const bytes = await readLimited(response, 25000000);
      if (!bytes.length) throw new Error('Empty media response');
      const filename = prefix + '-' + String(index + 1).padStart(3,'0') + '.' + ext;
      await fs.writeFile(path.join(stageRoot, filename), bytes, { flag:'wx' });
      mediaCount++;
      localized.push({ type:mime.startsWith('video/') ? 'video' : 'photo', url:'/media/' + filename });
    }
    return localized;
  }
  const cars = [];
  for (const car of carsData.cars) {
    if (!car || typeof car.id !== 'string' || typeof car.caption !== 'string' || !Array.isArray(car.mediaItems) || !car.mediaItems.length) throw new Error('Incomplete approved car record; export stopped');
    assertPublicCarMediaOrder(car);
    const mediaItems = await localize(car.mediaItems, 'car-' + car.id.replace(/[^a-zA-Z0-9_-]/g,'_'));
    cars.push({ id:car.id, caption:car.caption, publishedAt:String(car.publishedAt || ''), mediaItems });
  }
  const reviews = [];
  for (const review of reviewsData.reviews) {
    if (!review || typeof review.id !== 'string' || !Array.isArray(review.mediaItems)) throw new Error('Invalid approved review record; export stopped');
    assertPublicCarMediaOrder(review);
    const mediaItems = await localize(review.mediaItems, 'review-' + review.id.replace(/[^a-zA-Z0-9_-]/g,'_'));
    reviews.push({ id:review.id, text:String(review.text || ''), mediaItems });
  }
  const snapshot = { schemaVersion:1, updatedAt:new Date().toISOString(), cars, reviews };
  await fs.mkdir('data', { recursive:true });
  const snapshotPath = path.resolve('data/public-snapshot.json');
  const tempSnapshot = snapshotPath + '.tmp-' + process.pid;
  await fs.writeFile(tempSnapshot, JSON.stringify(snapshot, null, 2) + '\n', { mode:0o600, flag:'wx' });
  try {
    try {
      await fs.rename(mediaRoot, backupRoot);
      previousMoved = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await fs.rename(stageRoot, mediaRoot);
    published = true;
    await fs.rename(tempSnapshot, snapshotPath);
  } catch (error) {
    if (published) await fs.rm(mediaRoot, { recursive:true, force:true });
    if (previousMoved) await fs.rename(backupRoot, mediaRoot);
    await fs.rm(tempSnapshot, { force:true });
    throw error;
  }
  if (previousMoved) await fs.rm(backupRoot, { recursive:true, force:true }).catch(() => {});
  process.stdout.write('Exported ' + cars.length + ' cars, ' + reviews.length + ' reviews and ' + mediaCount + ' approved media files.\n');
} finally {
  await fs.rm(stageRoot, { recursive:true, force:true });
}
