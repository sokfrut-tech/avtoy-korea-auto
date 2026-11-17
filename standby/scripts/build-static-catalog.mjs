import { promises as fs } from 'node:fs';
import path from 'node:path';

const [snapshotPath, mediaDir = 'public/media', outputDir = 'pages'] = process.argv.slice(2);
if (!snapshotPath) {
  process.stderr.write('Usage: node scripts/build-static-catalog.mjs <public-snapshot.json> [media-dir] [output-dir]\n');
  process.exit(2);
}
const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.cars) || !Array.isArray(snapshot.reviews)) throw new Error('Unsupported public snapshot schema');
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
const mediaNames = new Set();
for (const [kind, records] of [['car', snapshot.cars], ['review', snapshot.reviews]]) {
  for (const record of records) {
    if (!Array.isArray(record.mediaItems)) throw new Error('Missing media list: ' + String(record.id));
    if (kind === 'car' && record.mediaItems.length === 0) throw new Error('Car has no approved media: ' + String(record.id));
    for (const item of record.mediaItems) {
      if (!item || !['photo','video'].includes(item.type) || typeof item.url !== 'string' || !item.url.startsWith('/media/') || !/^[a-zA-Z0-9._-]+$/.test(item.url.slice(7))) throw new Error('Unsafe or unsupported media URL');
      mediaNames.add(item.url.slice(7));
    }
  }
}
const out = path.resolve(outputDir);
const cwd = path.resolve('.');
if (out === cwd || !out.startsWith(cwd + path.sep)) throw new Error('Refusing to replace an output directory outside the repository workspace');
await fs.rm(out, { recursive:true, force:true });
await fs.mkdir(path.join(out, 'media'), { recursive:true });
for (const name of mediaNames) {
  const source = path.resolve(mediaDir, name);
  if (!source.startsWith(path.resolve(mediaDir) + path.sep)) throw new Error('Media path escaped media directory');
  const stat = await fs.stat(source);
  if (!stat.isFile() || stat.size === 0) throw new Error('Missing or empty media file: ' + name);
  await fs.copyFile(source, path.join(out, 'media', name));
}
const renderMedia = items => items.map((item, index) => item.type === 'video'
  ? '<video controls preload="metadata" src="' + esc(item.url) + '"></video>'
  : '<a href="' + esc(item.url) + '"><img loading="lazy" src="' + esc(item.url) + '" alt="Фото ' + (index + 1) + '"></a>').join('');
const carCards = snapshot.cars.map(car => '<article class="card"><h2>' + esc(car.caption || car.description || 'Автомобиль') + '</h2><div class="media">' + renderMedia(car.mediaItems) + '</div><p class="muted">' + esc(car.publishedAt || '') + '</p></article>').join('');
const reviewCards = snapshot.reviews.map(review => '<article class="card"><h2>Отзыв</h2><p>' + esc(review.text || '') + '</p><div class="media">' + renderMedia(review.mediaItems) + '</div></article>').join('');
const css = 'body{margin:0;background:#101820;color:#f4f6f8;font:16px/1.5 system-ui,sans-serif}header,main,footer{max-width:1100px;margin:auto;padding:20px}header,footer{border-bottom:1px solid #34424c}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.card{background:#1b2933;border:1px solid #34424c;border-radius:14px;padding:14px;min-width:0}.media{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}.media img,.media video{width:100%;height:190px;object-fit:cover;border-radius:8px;background:#000}.media video{object-fit:contain}.muted{color:#aab7c1;font-size:.9em}a{color:#9bd4ff}@media(max-width:520px){header,main,footer{padding:14px}.media img,.media video{height:150px}}';
const html = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Каталог автомобилей из Кореи и отзывы клиентов AVTOY KOREA"><meta name="robots" content="index,follow"><title>Автомобили из Кореи — AVTOY KOREA</title><link rel="stylesheet" href="./style.css"></head><body><header><p>AVTOY KOREA</p><h1>Автомобили из Кореи</h1><p>Каталог одобренных автомобилей и отзывы клиентов</p><nav><a href="#cars">Автомобили</a> · <a href="#reviews">Отзывы</a> · <a href="https://t.me/avtoYkorea">Связаться в Telegram</a></nav></header><main><section id="cars"><h2>Каталог автомобилей (' + snapshot.cars.length + ')</h2><div class="grid">' + carCards + '</div></section><section id="reviews"><h2>Отзывы (' + snapshot.reviews.length + ')</h2><div class="grid">' + reviewCards + '</div></section></main><footer>Резервный статический каталог. Связь — через Telegram. Обновлено: ' + esc(snapshot.updatedAt || '') + '</footer></body></html>';
await fs.writeFile(path.join(out, 'index.html'), html + '\n');
await fs.writeFile(path.join(out, 'style.css'), css + '\n');
await fs.writeFile(path.join(out, 'robots.txt'), 'User-agent: *\nAllow: /\n');
process.stdout.write('Built static catalogue: ' + snapshot.cars.length + ' cars, ' + snapshot.reviews.length + ' reviews, ' + mediaNames.size + ' media files\n');
