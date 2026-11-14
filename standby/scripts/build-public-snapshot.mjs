import { promises as fs } from 'node:fs';
import path from 'node:path';

const inputPath = process.argv[2];
const outputPath = process.argv[3] || 'data/public-snapshot.json';
const mediaMapPath = process.argv[4] || 'data/media-map.json';
if (!inputPath) {
  process.stderr.write('Usage: node scripts/build-public-snapshot.mjs <private-export.json> [output.json]\n');
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
  const seen = new Set(); const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const key = item.file_unique_id ? `u:${item.file_unique_id}` : item.file_id ? `f:${item.file_id}` : '';
    if (!key || seen.has(key)) continue;
    seen.add(key); out.push(item);
  }
  return out;
}
function resolveLocalUrl(media, mediaMap) {
  const key = media.file_unique_id || media.file_id;
  const entry = key ? mediaMap[key] : null;
  const url = typeof entry === 'string' ? entry : entry?.url;
  if (typeof url !== 'string' || !/^\/media\/[a-zA-Z0-9._/-]+$/.test(url) || url.includes('..')) return null;
  return url;
}

const raw = JSON.parse(await fs.readFile(inputPath, 'utf8'));
const records = Array.isArray(raw.records) ? raw.records : [];
let mediaMap = raw.mediaMap && typeof raw.mediaMap === 'object' ? raw.mediaMap : {};
try {
  const externalMap = JSON.parse(await fs.readFile(mediaMapPath, 'utf8'));
  if (externalMap && typeof externalMap === 'object' && !Array.isArray(externalMap)) mediaMap = externalMap;
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const cars = [];
const reviews = [];
for (const record of records) {
  if (!record || typeof record.key !== 'string') continue;
  const isCar = record.key.startsWith('car_approved:');
  const isReview = record.key.startsWith('approved:');
  if (!isCar && !isReview) continue;
  const car = record.value && typeof record.value === 'string' ? JSON.parse(record.value) : record.value;
  if (!car) continue;
  if (isReview) {
    const text = cleanPublicationText(car.text);
    const reviewMedia = Array.isArray(car.mediaItems) && car.mediaItems.length
      ? car.mediaItems
      : [...(Array.isArray(car.photos) ? car.photos.map(p => ({ ...p, type:'photo' })) : []),
         ...(Array.isArray(car.videos) ? car.videos.map(v => ({ ...v, type:'video' })) : [])];
    if (!reviewMedia.length && car.fileId) reviewMedia.push({ file_id:car.fileId, type:car.kind === 'video' ? 'video' : 'photo' });
    let incompleteMedia = false;
    const mediaItems = uniqueMedia(reviewMedia).map(media => {
      const type = media.type || media.mediaType || (car.kind === 'video' ? 'video' : 'photo');
      if (!['photo', 'video'].includes(type)) return null;
      if (type === 'photo') {
        const mapped = mediaMap[media.file_unique_id || media.file_id];
        const w=Number(media.width)||Number(mapped?.width)||0,h=Number(media.height)||Number(mapped?.height)||0;
        if (!(w > 0 && h > 0 && Math.max(w,h) >= 1280 && w*h >= 900000)) return null;
      }
      const url = resolveLocalUrl(media,mediaMap);
      if (!url) { incompleteMedia = true; return null; }
      return { type, url };
    }).filter(Boolean);
    // Never publish a partial album: one missing eligible file excludes the entire record.
    if (text.length >= 12 && mediaItems.length && !incompleteMedia) reviews.push({ id:String(car.id || record.key.slice('approved:'.length)), kind:car.kind === 'video' ? 'video' : 'photo', text, mediaItems, createdAt:car.createdAt || car.publishedAt || null });
    continue;
  }
  if (!/^car_-?\d+_\d+$/.test(String(car.id || ''))) continue;
  const caption = cleanPublicationText(car.caption)
    .split('\n')
    .filter(line => !/^\s*(?:📲|📞|☎️?|👤|✉️?)?\s*(?:контакт|продавец|менеджер|связ|звон|позвон|тел\b|телефон|whats?app|viber|telegram|телеграм|написать|писать)/i.test(line))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (caption.length < 30) continue;
  const sourceMedia = Array.isArray(car.mediaItems) && car.mediaItems.length
    ? car.mediaItems
    : [...(Array.isArray(car.photos) ? car.photos.map(p => ({ ...p, type:'photo' })) : []),
       ...(Array.isArray(car.videos) ? car.videos.map(v => ({ ...v, type:'video' })) : [])];
  if (!sourceMedia.length && car.fileId) sourceMedia.push({ file_id:car.fileId, type:car.mediaType === 'video' ? 'video' : 'photo' });
  let incompleteMedia = false;
  const mediaItems = uniqueMedia(sourceMedia).map(media => {
    const type = media.type || media.mediaType || (car.mediaType === 'video' ? 'video' : 'photo');
    if (!['photo', 'video'].includes(type)) return null;
    if (type === 'photo') {
      const mapped = mediaMap[media.file_unique_id || media.file_id];
      const w=Number(media.width)||Number(mapped?.width)||0,h=Number(media.height)||Number(mapped?.height)||0;
      if (!(w > 0 && h > 0 && Math.max(w,h) >= 1280 && w*h >= 900000)) return null;
    }
    const url = resolveLocalUrl(media,mediaMap);
    if (!url) { incompleteMedia = true; return null; }
    return { type, url };
  }).filter(Boolean);
  // Never publish a partial album: one missing eligible file excludes the entire vehicle.
  if (!mediaItems.length || incompleteMedia) continue;
  cars.push({ id:String(car.id), caption, description:caption, mediaItems, publishedAt:car.publishedAt || null });
}
cars.sort((a,b)=>String(b.publishedAt||'').localeCompare(String(a.publishedAt||'')));
const output = { schemaVersion:1, updatedAt:new Date().toISOString(), cars, reviews };
await fs.mkdir(path.dirname(path.resolve(outputPath)),{recursive:true});
await fs.writeFile(outputPath,JSON.stringify(output,null,2)+'\n',{mode:0o600});
process.stdout.write(`Wrote ${cars.length} public cars and ${reviews.length} approved reviews to ${outputPath}\n`);
