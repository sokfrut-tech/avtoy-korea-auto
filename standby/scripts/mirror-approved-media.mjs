import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { imageDimensionsFromBytes } from './image-metadata.mjs';

const inputPath = process.argv[2];
const mapPath = process.argv[3] || 'data/media-map.json';
const mediaDir = process.argv[4] || 'public/media';
const token = process.env.TELEGRAM_BOT_TOKEN;
const MAX_BYTES = 20 * 1024 * 1024;
if (!inputPath || !token) {
  process.stderr.write('Usage: TELEGRAM_BOT_TOKEN=<secret> node scripts/mirror-approved-media.mjs <private-export.json> [data/media-map.json] [public/media]\n');
  process.exit(2);
}

function cleanPublicationText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/(?:^|\n)\s*(?:Источник|Переслано от|Forwarded from|Просмотры|Комментарии|Реакции)\s*[:：]?.*$/gim, '')
    .replace(/(?:^|\n)\s*Для заказа аналогичного автомобиля обращайтесь\s*:?[^]*$/i, '')
    .replace(/(?:https?:\/\/)?t\.me\/[\w+/?=&%-]+/gi, '')
    .replace(/^\s*@[\w]{3,}\s*$/gm, '')
    .replace(/^\s*#[\p{L}\p{N}_]+(?:\s+#[\p{L}\p{N}_]+)*\s*$/gmu, '')
    .replace(/(?<!\d)(?:\+?7|8)[\s().-]*\d(?:[\s().-]*\d){9}(?!\d)|(?<!\d)9(?:[\s().-]*\d){9}(?!\d)/g, '')
    .replace(/(?<!\d)(?:\+\s?\d{1,3}|00\s?\d{1,3})[\s().-]*\d(?:[\s().-]*\d){6,13}(?!\d)/g, '')
    .replace(/^\s*(?:тел(?:ефон)?|whats?app(?:\s*\/\s*telegram)?|telegram|телеграм|контакт|продавец|менеджер|связь)\s*[:：]?.*$/gim, '')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
    .replace(/^\s*Видео\s*$/gim, '')
    .replace(/^\s*[-–—|,;:·•]+\s*$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function uniqueMedia(items) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const key = item.file_unique_id || item.file_id || '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function isPublicPhoto(item) {
  const width = Number(item?.width) || 0;
  const height = Number(item?.height) || 0;
  if (!item?.file_id) return false;
  if (width > 0 && height > 0) return Math.max(width, height) >= 1280 && width * height >= 900000;
  // Telegram image documents preserve original bytes but often have no dimensions in the update.
  return /^image\/(jpeg|png|webp|gif)$/i.test(String(item.mime_type || ''));
}

const raw = JSON.parse(await fs.readFile(inputPath, 'utf8'));
const records = Array.isArray(raw.records) ? raw.records : [];
const unique = new Map();

for (const record of records) {
  if (!record || typeof record.key !== 'string') continue;
  const isCar = record.key.startsWith('car_approved:');
  const isReview = record.key.startsWith('approved:');
  if (!isCar && !isReview) continue;

  const item = typeof record.value === 'string' ? JSON.parse(record.value) : record.value;
  if (!item) continue;
  if (isCar && !/^car_-?\d+_\d+$/.test(String(item.id || ''))) continue;

  const text = cleanPublicationText(isCar ? item.caption : item.text);
  if (text.length < (isCar ? 30 : 12)) continue;

  const legacyPhotos = Array.isArray(item.photos) ? item.photos : [];
  const legacyVideos = Array.isArray(item.videos) ? item.videos : [];
  const ordered = Array.isArray(item.mediaItems) && item.mediaItems.length
    ? item.mediaItems
    : [...legacyPhotos.map(media => ({ ...media, type: 'photo' })),
       ...legacyVideos.map(media => ({ ...media, type: 'video' }))];
  if (!ordered.length && item.fileId) ordered.push({
    file_id: item.fileId,
    type: (isCar ? item.mediaType : item.kind) === 'video' ? 'video' : 'photo'
  });
  const seenRecord = new Set();
  const mediaItems = [];
  for (const media of ordered) {
    if (!media || typeof media !== 'object' || !media.file_id) continue;
    const type = media.type || media.mediaType || (media.is_video ? 'video' : 'photo');
    if (type !== 'photo' && type !== 'video') continue;
    const key = media.file_unique_id || media.file_id;
    if (seenRecord.has(key)) continue;
    seenRecord.add(key);
    if (type === 'photo' && !isPublicPhoto(media)) continue;
    mediaItems.push({ ...media, mediaType: type });
  }

  // Keep album order when the source has an ordered mediaItems array.
  // Download each Telegram unique file only once across all approved records.
  if (!mediaItems.length) continue;
  for (const media of mediaItems) {
    const key = media.file_unique_id || media.file_id;
    if (!unique.has(key)) unique.set(key, media);
  }
}

await fs.mkdir(mediaDir, { recursive: true });
const mediaMap = {};
let saved = 0, skipped = 0;
for (const [key, item] of unique) {
  try {
    const fileInfoResponse = await fetch('https://api.telegram.org/bot' + token + '/getFile?file_id=' + encodeURIComponent(item.file_id));
    if (!fileInfoResponse.ok) { skipped++; continue; }
    const fileInfo = await fileInfoResponse.json();
    const filePath = fileInfo?.result?.file_path;
    if (fileInfo?.ok !== true || typeof filePath !== 'string' || filePath.includes('..')) { skipped++; continue; }
    const extCandidate = path.extname(filePath).toLowerCase();
    const mimeExt = ({'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif'})[String(item.mime_type || '').toLowerCase()];
    const ext = item.mediaType === 'video' ? (extCandidate === '.mp4' ? '.mp4' : '.mp4')
      : (mimeExt || (['.jpg','.jpeg','.png','.webp','.gif'].includes(extCandidate) ? extCandidate : '.jpg'));
    const downloadPath = filePath.split('/').map(encodeURIComponent).join('/');
    const downloadResponse = await fetch('https://api.telegram.org/file/bot' + token + '/' + downloadPath);
    if (!downloadResponse.ok) { skipped++; continue; }
    const declaredSize = Number(downloadResponse.headers.get('content-length') || item.file_size || 0);
    if (declaredSize > MAX_BYTES) { skipped++; continue; }
    const bytes = new Uint8Array(await downloadResponse.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES) { skipped++; continue; }
    let verifiedDimensions = null;
    if (item.mediaType === 'photo') {
      const dimensions = imageDimensionsFromBytes(bytes);
      verifiedDimensions = dimensions;
      const width = Number(item.width) || dimensions?.width || 0;
      const height = Number(item.height) || dimensions?.height || 0;
      if (!dimensions || !(width > 0 && height > 0 && Math.max(width,height) >= 1280 && width*height >= 900000)) {
        skipped++; continue;
      }
    }
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 24);
    const filename = digest + ext;
    try {
      await fs.writeFile(path.join(mediaDir, filename), bytes, { mode: 0o644, flag: 'wx' });
    } catch (writeError) {
      if (writeError?.code !== 'EEXIST') throw writeError;
    }
    const localUrl = '/media/' + filename;
    const mapValue = item.mediaType === 'photo' && verifiedDimensions && !(Number(item.width) > 0 && Number(item.height) > 0)
      ? { url: localUrl, width: verifiedDimensions.width, height: verifiedDimensions.height }
      : localUrl;
    mediaMap[key] = mapValue;
    if (item.file_unique_id) mediaMap[item.file_unique_id] = mapValue;
    if (item.file_id) mediaMap[item.file_id] = mapValue;
    saved++;
  } catch {
    skipped++;
  }
}
await fs.mkdir(path.dirname(path.resolve(mapPath)), { recursive: true });
await fs.writeFile(mapPath, JSON.stringify(mediaMap, null, 2) + '\n', { mode: 0o600 });
await fs.chmod(mapPath, 0o600);
process.stdout.write('Mirrored ' + saved + ' eligible public media files; skipped ' + skipped + '. Private media map: ' + mapPath + '\n');
