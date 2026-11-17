// Complete batch migration & Russian mirror builder for AVTOY KOREA.
// Downloads all approved cars, reviews, photos, videos and hero assets,
// verifies stored bytes with read-back SHA-256 checks, skips broken 404 items safely,
// and outputs a ready-to-host Russian build (works on 0 RUB GitVerse Pages AND Yandex Cloud Free Tier).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createS3MediaStore } from '../storage/s3-media-store.mjs';
import { cleanCarDisplayCaption, deduplicateMediaItems, isMarketNewsRecord } from '../../catalog-formatter.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STANDBY_DIR = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(STANDBY_DIR, '..');

const SOURCE_BASE = new URL(process.env.SOURCE_WORKER_URL || 'https://avtoy-korea-auto.sokfrut.workers.dev/');
const PUBLIC_DIR = path.join(STANDBY_DIR, 'public');
const DATA_DIR = path.join(STANDBY_DIR, 'data');
const MEDIA_DIR = path.join(PUBLIC_DIR, 'media');
const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets');
const API_STATIC_DIR = path.join(PUBLIC_DIR, 'api');
const MAX_MEDIA_BYTES = 50 * 1024 * 1024; // 50 MB safety cap

const ALLOWED_MIME = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
  ['video/quicktime', 'mov']
]);

const HERO_SLIDES = [
  {
    url: 'https://images.carexpert.com.au/resize/1920/-/cms/v1/media/2025-11-2026-250924kia-sportage-sxstill-7.jpg',
    localFile: 'hero-1.jpg',
    fallbackB64Prefix: 'kia-sportage'
  },
  {
    url: 'https://vehicle-images.carscommerce.inc/c296-18004034/KNAG64J7XT5407697/f77dca20312f1d8e2fc1db6f7841acfb.jpg',
    localFile: 'hero-2.jpg',
    fallbackB64Prefix: 'kia-sportage'
  },
  {
    url: 'https://media.whichcar.com.au/uploads/2025/11/2026-Toyota-RAV4-1-1920x1280.jpeg',
    localFile: 'hero-3.jpg',
    fallbackB64Prefix: 'kia-sportage'
  }
];

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function writeAndVerifyFile(destPath, buffer) {
  const expectedHash = sha256(buffer);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, buffer);
  // Read back actual stored bytes from disk to guarantee integrity
  const stored = await fs.readFile(destPath);
  const actualHash = sha256(stored);
  if (stored.length !== buffer.length || actualHash !== expectedHash) {
    throw new Error(`Integrity check failed for ${destPath}: expected ${expectedHash}, got ${actualHash}`);
  }
  return { size: stored.length, sha256: actualHash };
}

async function readB64Asset(prefix) {
  const assetsSrc = path.join(REPO_ROOT, 'assets-src');
  const files = (await fs.readdir(assetsSrc)).filter(f => f.startsWith(prefix)).sort();
  if (!files.length) throw new Error(`Missing assets-src file for prefix: ${prefix}`);
  const parts = await Promise.all(files.map(f => fs.readFile(path.join(assetsSrc, f), 'utf8')));
  return Buffer.from(parts.join('').replace(/\s+/g, ''), 'base64');
}

async function downloadBuffer(url, maxBytes = MAX_MEDIA_BYTES, timeoutMs = 60_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (!buf.length) throw new Error('Empty media body');
  if (buf.length > maxBytes) throw new Error(`Exceeds max size (${buf.length} > ${maxBytes})`);
  return { buf, mime };
}

async function extractFrontendHtmlFromWorker({ maxBotUrl = process.env.MAX_BOT_URL || '', workerApiOrigin = SOURCE_BASE.origin }) {
  const workerSource = await fs.readFile(path.join(REPO_ROOT, 'worker.js'), 'utf8');
  const startMarker = 'const html = `<!doctype html>';
  const endMarker = '</html>`;';
  const startIdx = workerSource.indexOf(startMarker);
  const endIdx = workerSource.indexOf(endMarker, startIdx);
  if (startIdx < 0 || endIdx < 0) {
    throw new Error('Could not locate HTML template inside worker.js');
  }
  let html = workerSource.slice(startIdx + 'const html = `'.length, endIdx + '</html>'.length);

  // Replace dynamic template interpolation for MAX buttons
  const validMax = maxBotUrl && /^https:\/\/max\.ru\/[A-Za-z0-9_./?=-]+$/.test(maxBotUrl.trim()) ? maxBotUrl.trim() : '';
  const safeMaxHrefAttr = validMax ? `href="${validMax}" target="_blank" rel="noopener"` : 'href="#max-bot"';
  html = html.replaceAll('${maxHrefAttr}', safeMaxHrefAttr);

  // Unescape template literal double-backslashes from worker.js (e.g. \\s -> \s, \\d -> \d, \\. -> \.)
  html = html.replace(/\\\\([bdswBDSW.nrt+?*()[\]{}|^$/])/g, '\\$1');

  // Localize logo and hero slides so zero foreign image CDNs are queried by Russian visitors
  html = html.replace('src="/assets/logo.jpg"', 'src="./assets/logo.jpg"');
  for (const slide of HERO_SLIDES) {
    html = html.replace(slide.url, `./assets/${slide.localFile}`);
  }

  // Upgrade API calls in the Russian build so it works seamlessly BOTH:
  // 1) on a dynamic Russian server (Yandex Cloud / standby server: ./api/cars, ./api/reviews, ./api/request)
  // 2) on 100% free cardless static hosting (GitVerse Pages: ./api/cars.json, ./api/reviews.json + direct compact request fallback + 1-click MAX/Telegram buttons)
  html = html.replace(
    "fetch('/api/public-config',{cache:'no-store'}).then(function(r){return r.ok?r.json():null;})",
    `fetch('./api/public-config',{cache:'no-store'}).then(function(r){if(r.ok)return r.json();return fetch('${workerApiOrigin}/api/public-config',{cache:'no-store'}).then(function(r2){return r2.ok?r2.json():null;});})`
  );
  html = html.replace(
    "fetch('/api/news',{cache:'no-store'}).then(function(r){return r.ok?r.json():{news:[]};})",
    "fetch('./api/news',{cache:'no-store'}).then(function(r){if(r.ok)return r.json();return fetch('./api/news.json',{cache:'no-store'}).then(function(r2){return r2.ok?r2.json():{news:[]};});})"
  );
  html = html.replace(
    "fetch('/api/reviews',{cache:'no-store'}).then(function(r){return r.json()})",
    "fetch('./api/reviews',{cache:'no-store'}).then(function(r){if(r.ok)return r.json();return fetch('./api/reviews.json',{cache:'no-store'}).then(function(r2){return r2.json()});})"
  );
  html = html.replace(
    "fetch('/api/cars',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})",
    "fetch('./api/cars',{cache:'no-store'}).then(function(r){if(r.ok)return r.json();return fetch('./api/cars.json',{cache:'no-store'}).then(function(r2){if(!r2.ok)throw new Error('HTTP '+r2.status);return r2.json()});})"
  );

  // Upgrade form submission to try local ./api/request first, then Worker API, and offer 1-click messenger fallback if ISP blocks cross-origin POST
  const originalFetchLine = "const r=await fetch('/api/request',{method:'POST',headers:{'content-type':'application/json','accept':'application/json','idempotency-key':window.requestIdempotencyKey},body:JSON.stringify(data)});";
  const resilientFetchBlock = [
    "const reqInit={method:'POST',headers:{'content-type':'application/json','accept':'application/json','idempotency-key':window.requestIdempotencyKey},body:JSON.stringify(data)};",
    `let r=await fetch('./api/request',reqInit).catch(function(){return null;});`,
    `if(!r||r.status===404||r.status===405){r=await fetch('${workerApiOrigin}/api/request',reqInit);}`
  ].join('');
  html = html.replace(originalFetchLine, resilientFetchBlock);

  const originalCatchLine = "showFormStatus(err.message||'Не удалось отправить заявку. Проверьте соединение и попробуйте ещё раз.',true);";
  const resilientCatchBlock = [
    "showFormStatus((err.message||'Не удалось отправить заявку автоматически.')+' Вы можете отправить уже заполненную заявку в один клик:',true);",
    "var quickText=['Заявка с сайта AVTOY KOREA','Имя: '+(data.name||''),'Контакт: '+(data.contact||''),data.model?'Модель: '+data.model:'',data.budget?'Бюджет: '+data.budget:'',data.country?'Страна: '+data.country:'',data.details?'Пожелания: '+data.details:''].filter(Boolean).join('\\n');",
    "var fallbackWrap=document.createElement('div');fallbackWrap.style.marginTop='10px';fallbackWrap.style.display='flex';fallbackWrap.style.gap='12px';fallbackWrap.style.flexWrap='wrap';",
    maxBotUrl ? `var maxLink=document.createElement('a');maxLink.href='${maxBotUrl.trim()}';maxLink.target='_blank';maxLink.rel='noopener';maxLink.textContent='Открыть бот в MAX →';fallbackWrap.appendChild(maxLink);` : "",
    "var tgShare=document.createElement('a');tgShare.href='https://t.me/avtoYkorea';tgShare.target='_blank';tgShare.rel='noopener';tgShare.textContent='Написать в Telegram (@avtoYkorea) →';fallbackWrap.appendChild(tgShare);",
    "statusEl.appendChild(fallbackWrap);"
  ].filter(Boolean).join('');
  html = html.replace(originalCatchLine, resilientCatchBlock);

  return html;
}

export async function runMigration() {
  const s3 = createS3MediaStore();
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  await fs.mkdir(ASSETS_DIR, { recursive: true });
  await fs.mkdir(API_STATIC_DIR, { recursive: true });
  await fs.mkdir(DATA_DIR, { recursive: true });

  const manifestEntries = [];
  const skippedBrokenMedia = [];
  let totalBytes = 0;

  // 1. Restore verified brand logo
  const logoBuf = await readB64Asset('logo');
  const logoCheck = await writeAndVerifyFile(path.join(ASSETS_DIR, 'logo.jpg'), logoBuf);
  if (logoCheck.sha256 !== '2aa1fa2840857b09eff4a78b63935abeaaa692bef4801f87ce37b972d01fc453') {
    throw new Error('Brand logo SHA-256 verification failed');
  }
  totalBytes += logoCheck.size;

  // 2. Localize hero banner images
  const fallbackHero = await readB64Asset('kia-sportage');
  for (const slide of HERO_SLIDES) {
    let buf = fallbackHero;
    try {
      const downloaded = await downloadBuffer(slide.url, 10 * 1024 * 1024, 15_000);
      if (downloaded.mime.startsWith('image/')) buf = downloaded.buf;
    } catch {
      // Keep local embedded Sportage fallback if external automotive site is unreachable
    }
    const check = await writeAndVerifyFile(path.join(ASSETS_DIR, slide.localFile), buf);
    totalBytes += check.size;
  }

  // 3. Fetch live catalogue, news & reviews
  const [carsRes, newsRes, reviewsRes] = await Promise.all([
    fetch(new URL('/api/cars', SOURCE_BASE), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) }),
    fetch(new URL('/api/news', SOURCE_BASE), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) }).catch(() => null),
    fetch(new URL('/api/reviews', SOURCE_BASE), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
  ]);
  if (!carsRes.ok) throw new Error(`Failed to fetch /api/cars: HTTP ${carsRes.status}`);
  if (!reviewsRes.ok) throw new Error(`Failed to fetch /api/reviews: HTTP ${reviewsRes.status}`);

  const carsPayload = await carsRes.json();
  const newsPayload = newsRes && newsRes.ok ? await newsRes.json().catch(() => ({ news: [] })) : { news: [] };
  const reviewsPayload = await reviewsRes.json();

  async function mirrorMediaList(recordId, kind, items) {
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const raw = items[i];
      const relUrl = typeof raw === 'string' ? raw : raw?.url;
      if (!relUrl || typeof relUrl !== 'string') continue;
      const fullSourceUrl = new URL(relUrl, SOURCE_BASE).toString();

      let downloaded;
      try {
        downloaded = await downloadBuffer(fullSourceUrl);
      } catch (err) {
        skippedBrokenMedia.push({
          recordId,
          kind,
          index: i,
          sourceUrl: relUrl,
          reason: err.message || 'download_failed'
        });
        continue;
      }

      const ext = ALLOWED_MIME.get(downloaded.mime) || (raw?.type === 'video' ? 'mp4' : 'jpg');
      const mediaType = downloaded.mime.startsWith('video/') || ext === 'mp4' || ext === 'webm' || ext === 'mov' ? 'video' : 'photo';
      const safeId = String(recordId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileHashShort = sha256(downloaded.buf).slice(0, 12);
      const filename = `${kind}-${safeId}-${String(i + 1).padStart(2, '0')}-${fileHashShort}.${ext}`;
      const localPath = path.join(MEDIA_DIR, filename);

      const diskVerified = await writeAndVerifyFile(localPath, downloaded.buf);
      totalBytes += diskVerified.size;

      let publicUrl = `./media/${filename}`;
      if (s3.configured) {
        const s3Verified = await s3.putVerifiedObject({
          key: `media/${filename}`,
          body: downloaded.buf,
          contentType: downloaded.mime || (mediaType === 'video' ? 'video/mp4' : 'image/jpeg')
        });
        publicUrl = s3Verified.url;
      }

      manifestEntries.push({
        recordId,
        kind,
        filename,
        type: mediaType,
        mime: downloaded.mime,
        size: diskVerified.size,
        sha256: diskVerified.sha256,
        url: publicUrl
      });

      out.push({ type: mediaType, url: publicUrl });
    }
    return out;
  }

  const migratedCars = [];
  const skippedCars = [];
  for (const car of carsPayload.cars || []) {
    const rawItems = Array.isArray(car.mediaItems) && car.mediaItems.length
      ? car.mediaItems
      : (car.media ? [{ url: car.media, type: car.mediaType || 'photo' }] : []);
    const rawMediaItems = await mirrorMediaList(car.id, 'car', rawItems);
    const mediaItems = deduplicateMediaItems(rawMediaItems);
    if (!mediaItems.length) {
      skippedCars.push({ id: car.id, caption: String(car.caption || '').slice(0, 80), reason: 'all_media_unavailable_404' });
      continue;
    }
    migratedCars.push({
      id: car.id,
      caption: cleanCarDisplayCaption(car.caption || ''),
      media: mediaItems[0].url,
      mediaItems,
      mediaOrderKnown: Boolean(car.mediaOrderKnown),
      mediaType: mediaItems.some(m => m.type === 'video') && mediaItems[0].type === 'video' ? 'video' : 'photo',
      publishedAt: car.publishedAt || ''
    });
  }

  const migratedNews = [];
  const seenNewsBaseIds = new Set();
  for (const nw of newsPayload.news || []) {
    const rawItems = Array.isArray(nw.mediaItems) && nw.mediaItems.length
      ? nw.mediaItems
      : (nw.media ? [{ url: nw.media, type: nw.kind === 'video' ? 'video' : 'photo' }] : []);
    const mediaItems = await mirrorMediaList(nw.id, 'news', rawItems);
    const cleaned = cleanCarDisplayCaption(nw.text || nw.caption || '');
    if (!mediaItems.length && !cleaned) continue;
    seenNewsBaseIds.add(String(nw.id || '').replace(/^news_/, '').replace(/^-/, ''));
    migratedNews.push({
      id: nw.id,
      kind: 'news',
      text: cleaned,
      media: mediaItems[0]?.url || null,
      mediaItems,
      publishedAt: nw.publishedAt || ''
    });
  }

  const migratedReviews = [];
  for (const rv of reviewsPayload.reviews || []) {
    const rawItems = Array.isArray(rv.mediaItems) && rv.mediaItems.length
      ? rv.mediaItems
      : (rv.media ? [{ url: rv.media, type: rv.kind === 'video' ? 'video' : 'photo' }] : []);
    const mediaItems = await mirrorMediaList(rv.id, 'review', rawItems);
    if (!mediaItems.length && !String(rv.text || '').trim()) continue;
    if (isMarketNewsRecord(rv)) {
      const baseId = String(rv.id || '').replace(/^-/, '');
      if (!seenNewsBaseIds.has(baseId)) {
        seenNewsBaseIds.add(baseId);
        migratedNews.push({
          id: 'news_' + baseId,
          kind: 'news',
          text: cleanCarDisplayCaption(rv.text || ''),
          media: mediaItems[0]?.url || null,
          mediaItems,
          publishedAt: rv.publishedAt || ''
        });
      }
      continue;
    }
    migratedReviews.push({
      id: rv.id,
      kind: rv.kind || (mediaItems[0]?.type === 'video' ? 'video' : 'text'),
      text: rv.text || 'Отзыв клиента AVTOY KOREA',
      media: mediaItems[0]?.url || null,
      mediaItems,
      mediaOrderKnown: Boolean(rv.mediaOrderKnown)
    });
  }

  const updatedAt = new Date().toISOString();
  const snapshot = {
    schemaVersion: 2,
    updatedAt,
    cars: migratedCars,
    news: migratedNews,
    reviews: migratedReviews
  };

  // Write server snapshot + static JSON endpoints + integrity manifest
  await writeAndVerifyFile(path.join(DATA_DIR, 'public-snapshot.json'), Buffer.from(JSON.stringify(snapshot, null, 2) + '\n'));
  await writeAndVerifyFile(path.join(API_STATIC_DIR, 'cars.json'), Buffer.from(JSON.stringify({ cars: migratedCars, updatedAt }) + '\n'));
  await writeAndVerifyFile(path.join(API_STATIC_DIR, 'news.json'), Buffer.from(JSON.stringify({ news: migratedNews, updatedAt }) + '\n'));
  await writeAndVerifyFile(path.join(API_STATIC_DIR, 'reviews.json'), Buffer.from(JSON.stringify({ reviews: migratedReviews, updatedAt }) + '\n'));

  const indexHtml = await extractFrontendHtmlFromWorker({});
  await writeAndVerifyFile(path.join(PUBLIC_DIR, 'index.html'), Buffer.from(indexHtml, 'utf8'));
  await writeAndVerifyFile(path.join(PUBLIC_DIR, '.nojekyll'), Buffer.from(''));

  const report = {
    completedAt: updatedAt,
    s3Uploaded: s3.configured,
    carsSourceCount: (carsPayload.cars || []).length,
    carsMigratedCount: migratedCars.length,
    carsSkipped: skippedCars,
    newsMigratedCount: migratedNews.length,
    reviewsMigratedCount: migratedReviews.length,
    mediaVerifiedCount: manifestEntries.length,
    totalMediaMegabytes: Number((totalBytes / (1024 * 1024)).toFixed(2)),
    skippedBrokenMedia,
    manifest: manifestEntries
  };
  await writeAndVerifyFile(path.join(DATA_DIR, 'migration-report.json'), Buffer.from(JSON.stringify(report, null, 2) + '\n'));

  return report;
}

export async function rebuildLocalBundle() {
  const snapPath = path.join(DATA_DIR, 'public-snapshot.json');
  const snap = JSON.parse(await fs.readFile(snapPath, 'utf8'));
  const updatedAt = new Date().toISOString();
  snap.updatedAt = updatedAt;
  snap.cars = (snap.cars || []).map(car => {
    const mediaItems = deduplicateMediaItems(car.mediaItems || []);
    return {
      ...car,
      caption: cleanCarDisplayCaption(car.caption || ''),
      media: mediaItems[0]?.url || car.media,
      mediaItems
    };
  });
  const existingNews = (Array.isArray(snap.news) ? snap.news : []).map(n => ({ ...n, text: cleanCarDisplayCaption(n.text || '') }));
  const seenBase = new Set(existingNews.map(n => String(n.id || '').replace(/^news_/, '').replace(/^-/, '')));
  const keptReviews = [];
  for (const rv of snap.reviews || []) {
    if (isMarketNewsRecord(rv)) {
      const baseId = String(rv.id || '').replace(/^-/, '');
      if (!seenBase.has(baseId)) {
        seenBase.add(baseId);
        existingNews.unshift({
          id: 'news_' + baseId,
          kind: 'news',
          text: cleanCarDisplayCaption(rv.text || ''),
          media: rv.media || rv.mediaItems?.[0]?.url || null,
          mediaItems: Array.isArray(rv.mediaItems) ? rv.mediaItems : (rv.media ? [{ type: 'photo', url: rv.media }] : []),
          publishedAt: rv.publishedAt || updatedAt
        });
      }
    } else {
      keptReviews.push(rv);
    }
  }
  snap.news = existingNews;
  snap.reviews = keptReviews;

  await writeAndVerifyFile(snapPath, Buffer.from(JSON.stringify(snap, null, 2) + '\n'));
  await writeAndVerifyFile(path.join(API_STATIC_DIR, 'cars.json'), Buffer.from(JSON.stringify({ cars: snap.cars, updatedAt }) + '\n'));
  await writeAndVerifyFile(path.join(API_STATIC_DIR, 'news.json'), Buffer.from(JSON.stringify({ news: snap.news, updatedAt }) + '\n'));
  await writeAndVerifyFile(path.join(API_STATIC_DIR, 'reviews.json'), Buffer.from(JSON.stringify({ reviews: snap.reviews, updatedAt }) + '\n'));
  const indexHtml = await extractFrontendHtmlFromWorker({});
  await writeAndVerifyFile(path.join(PUBLIC_DIR, 'index.html'), Buffer.from(indexHtml, 'utf8'));
  return { cars: snap.cars.length, news: snap.news.length, reviews: snap.reviews.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--fast-rebuild')) {
    rebuildLocalBundle()
      .then(r => console.log(`Локальная витрина пересобрана: авто ${r.cars}, новостей ${r.news}, отзывов ${r.reviews}`))
      .catch(err => { console.error(err); process.exitCode = 1; });
  } else {
  runMigration()
    .then(report => {
      console.log('=== МИГРАЦИЯ КАТАЛОГА AVTOY KOREA УСПЕШНО ЗАВЕРШЕНА ===');
      console.log(`Автомобилей перенесено: ${report.carsMigratedCount} из ${report.carsSourceCount}`);
      console.log(`Новостей перенесено:    ${report.newsMigratedCount}`);
      console.log(`Отзывов перенесено:     ${report.reviewsMigratedCount}`);
      console.log(`Файлов скачано и проверено по SHA-256: ${report.mediaVerifiedCount}`);
      console.log(`Общий объём всех фото и видео:         ${report.totalMediaMegabytes} МБ`);
      if (report.carsSkipped.length) {
        console.log('Пропущены битые карточки (404 в источнике):', JSON.stringify(report.carsSkipped));
      }
    })
    .catch(err => {
      console.error('Ошибка миграции:', err);
      process.exitCode = 1;
    });
  }
}
