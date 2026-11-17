// Yandex SEO engine for AVTOY KOREA: SSR catalog preview, landing pages, Schema.org JSON-LD,
// robots.txt, sitemap.xml, and YML product feed for Yandex Search / Yandex Market Goods.
import { cleanCarDisplayCaption, parseNewsCardData, parseVehicleCardData } from "./catalog-formatter.js";

const WARRANTY_STEM_RX = new RegExp("\\u0433\\u0430\\u0440\\u0430\\u043d\\u0442[^\\s<,\"']*", "gi");

function scrubHomepageText(value) {
  return String(value || "").replace(WARRANTY_STEM_RX, "подтверждение");
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]
  ));
}

export function escapeXml(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[&<>"']/g, ch => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]
    ));
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "https://avtoy-korea-auto.sokfrut.workers.dev").replace(/\/+$/, "");
}

function toAbsoluteUrl(baseUrl, rawUrl) {
  const cleanBase = normalizeBaseUrl(baseUrl);
  const val = String(rawUrl || "").trim();
  if (!val) return `${cleanBase}/assets/logo.jpg`;
  if (/^https?:\/\//i.test(val)) return val;
  if (val.startsWith("./")) return `${cleanBase}/${val.slice(2)}`;
  if (val.startsWith("/")) return `${cleanBase}${val}`;
  return `${cleanBase}/${val}`;
}

function toMirrorSubpageMedia(rawUrl, isStaticMirror) {
  const val = String(rawUrl || "").trim();
  if (!val) return "";
  if (/^https?:\/\//i.test(val)) return val;
  if (!isStaticMirror) return val;
  if (val.startsWith("./")) return `../${val.slice(2)}`;
  if (val.startsWith("/")) return `..${val}`;
  return `../${val}`;
}

function isVideoMediaItem(item) {
  const type = String(item?.type || "").toLowerCase();
  if (type === "video") return true;
  const u = String(item?.url || item || "").split(/[?#]/)[0].toLowerCase();
  return /\.(mp4|m4v|mov|webm|ogv)$/i.test(u) || u.includes("/video/");
}

function collectMediaItems(record) {
  const rawList = Array.isArray(record?.mediaItems) && record.mediaItems.length
    ? record.mediaItems
    : (record?.media ? [{ url: record.media, type: record.mediaType || (record.kind === "video" ? "video" : "photo") }] : []);
  const seen = new Set();
  const out = [];
  for (const it of rawList) {
    const url = typeof it === "string" ? it : String(it?.url || it?.src || "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, type: isVideoMediaItem(it) ? "video" : "photo" });
  }
  return out;
}

function carPagePath(id, useHtmlExt) {
  const safe = encodeURIComponent(String(id || ""));
  return useHtmlExt ? `./cars/${safe}.html` : `/cars/${safe}`;
}

function newsPagePath(id, useHtmlExt) {
  const safe = encodeURIComponent(String(id || ""));
  return useHtmlExt ? `./news/${safe}.html` : `/news/${safe}`;
}

function carAbsoluteUrl(baseUrl, id, useHtmlExt) {
  const cleanBase = normalizeBaseUrl(baseUrl);
  const safe = encodeURIComponent(String(id || ""));
  return useHtmlExt ? `${cleanBase}/cars/${safe}.html` : `${cleanBase}/cars/${safe}`;
}

function newsAbsoluteUrl(baseUrl, id, useHtmlExt) {
  const cleanBase = normalizeBaseUrl(baseUrl);
  const safe = encodeURIComponent(String(id || ""));
  return useHtmlExt ? `${cleanBase}/news/${safe}.html` : `${cleanBase}/news/${safe}`;
}

function isPlaceholderCar(car) {
  return String(car?.caption || "").trim().toLowerCase() === "исправить";
}

export const SEO_FAQS = [
  {
    q: "Как заказать автомобиль из Южной Кореи, Китая или ОАЭ под ключ?",
    a: "Выберите подходящий автомобиль в каталоге на сайте или оставьте заявку с маркой, моделью и желаемым бюджетом. Менеджер свяжется с вами в MAX, Telegram или по телефону, подберёт актуальные варианты на аукционах и площадках, проведёт осмотр и рассчитает итоговую цену доставки."
  },
  {
    q: "Что входит в стоимость автомобиля под ключ до Москвы и регионов РФ?",
    a: "В предварительный и итоговый расчёт включаются стоимость выкупа автомобиля за рубежом, экспортные и логистические расходы, фрахт, таможенное оформление на физическое лицо, списание коммерческого или льготного утильсбора и оформление СБКТС и ЭПТС."
  },
  {
    q: "Сколько времени занимает доставка автомобиля из Кореи и Китая?",
    a: "В среднем доставка от момента выкупа и погрузки на судно до прибытия во Владивосток и прохождения таможни занимает от 3 до 6 недель в зависимости от страны отправки и выбранной логистической схемы до вашего города."
  },
  {
    q: "Как проверяется техническое состояние и реальный пробег перед покупкой?",
    a: "До оплаты мы запрашиваем страховую и сервисную историю (Encar, CarHistory), проводим детальный фото- и видеоосмотр кузова толщиномером, двигателя, салона и электроники, чтобы вы видели реальное состояние автомобиля до сделки."
  },
  {
    q: "Как рассчитывается утильсбор при ввозе автомобиля на физическое лицо?",
    a: "Размер утилизационного сбора зависит от объёма и мощности двигателя, а также возраста автомобиля. Актуальные ставки, поправки и сравнительную таблицу платежей мы публикуем в разделе «Новости и изменения рынка» прямо на сайте."
  },
  {
    q: "Можно ли подобрать комплектацию и цвет, которых сейчас нет в каталоге на сайте?",
    a: "Да, на сайте представлена только часть проверенных предложений. Оставьте заявку в форме на странице или напишите в бот MAX / Telegram — мы сделаем индивидуальный подбор под ваш бюджет, цвет, привод и комплектацию."
  }
];

export function buildHomepageJsonLd({ baseUrl, cars = [], news = [] } = {}) {
  const cleanBase = normalizeBaseUrl(baseUrl);
  const useHtmlExt = !cleanBase.includes("workers.dev");
  const validCars = (Array.isArray(cars) ? cars : []).filter(c => c && c.id && !isPlaceholderCar(c)).slice(0, 25);

  const itemListElements = validCars.map((car, index) => {
    const media = collectMediaItems(car);
    const meta = parseVehicleCardData({ ...car, mediaItems: media });
    const firstPhoto = media.find(m => m.type === "photo") || media[0];
    const imageUrl = firstPhoto ? toAbsoluteUrl(cleanBase, firstPhoto.url) : `${cleanBase}/assets/logo.jpg`;
    const carUrl = carAbsoluteUrl(cleanBase, car.id, useHtmlExt);
    const offer = {
      "@type": "Offer",
      priceCurrency: "RUB",
      availability: "https://schema.org/InStock",
      url: carUrl
    };
    if (meta.priceRub) offer.price = String(meta.priceRub);
    return {
      "@type": "ListItem",
      position: index + 1,
      item: {
        "@type": "Product",
        name: scrubHomepageText([meta.title, meta.trim, meta.year].filter(Boolean).join(" ").slice(0, 140)),
        brand: { "@type": "Brand", name: scrubHomepageText(meta.brand) },
        description: scrubHomepageText([meta.year, meta.mileage, meta.engineChip, meta.powerChip, meta.driveChip, meta.priceNote].filter(Boolean).join(", ") || "Автомобиль под заказ из Кореи и Китая"),
        image: imageUrl,
        url: carUrl,
        offers: offer
      }
    };
  });

  const graph = [
    {
      "@type": "AutoDealer",
      name: "AVTOY KOREA",
      url: `${cleanBase}/`,
      logo: `${cleanBase}/assets/logo.jpg`,
      description: scrubHomepageText("Подбор, проверка и доставка автомобилей из Южной Кореи, Китая и ОАЭ под заказ под ключ по всей России."),
      currenciesAccepted: "RUB",
      areaServed: { "@type": "Country", name: "Россия" },
      sameAs: ["https://t.me/avtoYkorea"]
    },
    {
      "@type": "ItemList",
      name: "Каталог автомобилей под заказ AVTOY KOREA",
      numberOfItems: itemListElements.length,
      itemListElement: itemListElements
    },
    {
      "@type": "FAQPage",
      mainEntity: SEO_FAQS.map(item => ({
        "@type": "Question",
        name: scrubHomepageText(item.q),
        acceptedAnswer: {
          "@type": "Answer",
          text: scrubHomepageText(item.a)
        }
      }))
    }
  ];

  if (Array.isArray(news) && news.length) {
    const firstNews = parseNewsCardData(news[0]);
    graph.push({
      "@type": "NewsArticle",
      headline: scrubHomepageText(firstNews.title),
      url: newsAbsoluteUrl(cleanBase, news[0].id, useHtmlExt),
      publisher: { "@type": "Organization", name: "AVTOY KOREA" }
    });
  }

  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
}

export function renderServerCatalogPreviewHtml(cars = [], { useHtmlExt = false } = {}) {
  const validCars = (Array.isArray(cars) ? cars : []).filter(c => c && c.id && !isPlaceholderCar(c));
  if (!validCars.length) {
    return '<article class="card dashed"><div class="car-body">Загружаем актуальные предложения…</div></article>';
  }
  return validCars.slice(0, 30).map(car => {
    const media = collectMediaItems(car);
    const meta = parseVehicleCardData({ ...car, mediaItems: media });
    const firstPhoto = media.find(m => m.type === "photo");
    const href = carPagePath(car.id, useHtmlExt);
    const chips = [meta.year, meta.mileage, meta.engineChip, meta.powerChip, meta.driveChip].filter(Boolean);
    const title = scrubHomepageText(meta.title || "Автомобиль из Кореи");
    const imgTag = firstPhoto
      ? `<div class="car-gallery"><div class="car-gallery-stage"><img class="car-gallery-main" src="${escapeHtml(firstPhoto.url)}" alt="${escapeHtml(title)}" loading="lazy"></div></div>`
      : "";
    const chipsHtml = chips.length
      ? `<div class="car-chips">${chips.map(c => `<span class="car-chip">${escapeHtml(scrubHomepageText(c))}</span>`).join("")}</div>`
      : "";
    return `<article class="card car-card">${imgTag}<div class="car-body">${meta.trim ? `<div class="car-trim">${escapeHtml(scrubHomepageText(meta.trim))}</div>` : ""}<h3><a href="${escapeHtml(href)}">${escapeHtml(title)}</a></h3>${chipsHtml}<div class="car-Card-pricebox"><div class="car-price-val">${escapeHtml(meta.priceFormatted)}</div><div class="car-price-note">${escapeHtml(scrubHomepageText(meta.priceNote))}</div></div><a class="car-link" href="${escapeHtml(href)}">Подробнее об автомобиле →</a></div></article>`;
  }).join("");
}

export function renderFaqAndDirectoryHtml(cars = [], news = [], { useHtmlExt = false } = {}) {
  const validCars = (Array.isArray(cars) ? cars : []).filter(c => c && c.id && !isPlaceholderCar(c));
  const validNews = Array.isArray(news) ? news.filter(n => n && n.id) : [];

  const faqHtml = SEO_FAQS.map((item, idx) => (
    `<details class="faq-item"${idx === 0 ? " open" : ""}><summary>${escapeHtml(scrubHomepageText(item.q))}</summary><p>${escapeHtml(scrubHomepageText(item.a))}</p></details>`
  )).join("");

  const carLinks = validCars.slice(0, 30).map(car => {
    const meta = parseVehicleCardData(car);
    const label = [meta.title, meta.year, meta.priceRub ? meta.priceFormatted : ""].filter(Boolean).join(" · ");
    return `<a href="${escapeHtml(carPagePath(car.id, useHtmlExt))}">${escapeHtml(scrubHomepageText(label))}</a>`;
  }).join("");

  const newsLinks = validNews.slice(0, 10).map(item => {
    const parsed = parseNewsCardData(item);
    return `<a href="${escapeHtml(newsPagePath(item.id, useHtmlExt))}">📰 ${escapeHtml(scrubHomepageText(parsed.title))}</a>`;
  }).join("");

  const linksSection = (carLinks || newsLinks)
    ? `<div class="seo-links-box"><h3>Прямые страницы автомобилей и обзоров</h3><nav class="seo-links-nav" aria-label="Страницы автомобилей и новостей">${carLinks}${newsLinks}</nav></div>`
    : "";

  return `<section class="wrap section" id="faq" style="padding-top:24px"><div class="eyebrow">Вопросы и ответы</div><h2>Покупка и доставка авто из Кореи и Китая</h2><p class="sub">Прозрачные условия подбора, проверки истории, таможенного оформления и доставки под ключ.</p><div class="faq-list">${faqHtml}</div>${linksSection}</section>`;
}

export function renderCarLandingHtml(car, { baseUrl, isStaticMirror = false, maxBotUrl = "" } = {}) {
  const cleanBase = normalizeBaseUrl(baseUrl);
  const media = collectMediaItems(car);
  const meta = parseVehicleCardData({ ...car, mediaItems: media });
  const homeHref = isStaticMirror ? "../index.html" : "/";
  const carsHref = isStaticMirror ? "../index.html#cars" : "/#cars";
  const reqHref = isStaticMirror ? "../index.html#request" : "/#request";
  const logoSrc = isStaticMirror ? "../assets/logo.jpg" : "/assets/logo.jpg";
  const canonical = carAbsoluteUrl(cleanBase, car.id, isStaticMirror);
  const firstPhoto = media.find(m => m.type === "photo") || media[0];
  const ogImage = firstPhoto ? toAbsoluteUrl(cleanBase, firstPhoto.url) : `${cleanBase}/assets/logo.jpg`;

  const seoTitle = [meta.title, meta.trim, meta.year].filter(Boolean).join(" ")
    + (meta.priceRub ? ` — купить под заказ за ${meta.priceFormatted} под ключ` : " — купить под заказ из Кореи")
    + " | AVTOY KOREA";
  const seoDesc = [
    meta.title,
    meta.trim,
    meta.year,
    meta.mileage,
    meta.engineChip,
    meta.powerChip,
    meta.driveChip,
    meta.priceRub ? `Цена ${meta.priceFormatted} (${meta.priceNote})` : "Расчёт под ключ"
  ].filter(Boolean).join(" · ").slice(0, 220) + ". Подбор, проверка и доставка в Россию от AVTOY KOREA.";

  const ldJson = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "AVTOY KOREA", item: `${cleanBase}/` },
          { "@type": "ListItem", position: 2, name: "Каталог", item: `${cleanBase}/#cars` },
          { "@type": "ListItem", position: 3, name: meta.title, item: canonical }
        ]
      },
      {
        "@type": "Product",
        name: [meta.title, meta.trim, meta.year].filter(Boolean).join(" "),
        brand: { "@type": "Brand", name: meta.brand },
        description: seoDesc,
        image: media.filter(m => m.type === "photo").slice(0, 6).map(m => toAbsoluteUrl(cleanBase, m.url)),
        url: canonical,
        offers: {
          "@type": "Offer",
          priceCurrency: "RUB",
          ...(meta.priceRub ? { price: String(meta.priceRub) } : {}),
          availability: "https://schema.org/InStock",
          url: canonical,
          seller: { "@type": "Organization", name: "AVTOY KOREA" }
        }
      }
    ]
  }).replace(/</g, "\\u003c");

  const galleryHtml = media.length
    ? `<div class="gallery-grid">${media.map((m, idx) => {
      const src = escapeHtml(toMirrorSubpageMedia(m.url, isStaticMirror));
      return m.type === "video"
        ? `<div class="media-card"><video src="${src}" controls playsinline preload="metadata"></video></div>`
        : `<a class="media-card" href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="${escapeHtml(meta.title)} — фото ${idx + 1}" loading="${idx < 2 ? "eager" : "lazy"}"></a>`;
    }).join("")}</div>`
    : "";

  const specsHtml = meta.displaySpecs.length
    ? `<div class="specs-box">${meta.displaySpecs.map(s => `<div class="spec-row"><strong>${escapeHtml(s.key)}</strong><span>${escapeHtml(s.value)}</span></div>`).join("")}</div>`
    : "";

  const featuresHtml = meta.features.length
    ? `<div class="features-box"><h2>Комплектация и особенности</h2><ul>${meta.features.map(f => `<li>${escapeHtml(f)}</li>`).join("")}</ul></div>`
    : "";

  const maxLink = maxBotUrl && /^https:\/\/max\.ru\//.test(maxBotUrl) ? maxBotUrl : reqHref;

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#070c14">
<title>${escapeHtml(seoTitle)}</title>
<meta name="description" content="${escapeHtml(seoDesc)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta property="og:type" content="product">
<meta property="og:title" content="${escapeHtml(seoTitle)}">
<meta property="og:description" content="${escapeHtml(seoDesc)}">
<meta property="og:image" content="${escapeHtml(ogImage)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<script type="application/ld+json">${ldJson}</script>
<style>
:root{color-scheme:dark;--bg:#070c14;--panel:#101723;--line:#253247;--text:#f4f7fc;--muted:#9fb0c7;--red:#f12f38}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(ellipse at 78% 0%,#16253b 0,transparent 40%),var(--bg);color:var(--text);font:15px/1.6 Inter,system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
a{color:inherit;text-decoration:none}
.wrap{width:min(1180px,calc(100% - 32px));margin:0 auto}
header{border-bottom:1px solid #ffffff16;background:#071321f0;padding:14px 0;position:sticky;top:0;z-index:10;backdrop-filter:blur(12px)}
.nav{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.logo{width:170px;height:auto;display:block}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 20px;border-radius:12px;font-weight:800;font-size:14px;background:var(--red);color:#fff}
.btn-max{background:linear-gradient(135deg,#6d28d9,#2563eb);border:1px solid #a78bfa80}
.btn-tg{background:#0b121e;border:1px solid #2b3a52}
.crumbs{display:flex;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--muted);margin:20px 0 12px}
.crumbs a:hover{color:#fff}
.hero-card{display:grid;grid-template-columns:1.15fr .85fr;gap:24px;background:linear-gradient(155deg,#151f30,#0d1420);border:1px solid var(--line);border-radius:22px;padding:22px;margin-bottom:24px}
.trim{color:#ff806e;font-weight:800;font-size:11px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:6px}
h1{margin:0 0 12px;font-size:clamp(24px,3.2vw,34px);line-height:1.15}
.price-box{padding:16px;border-radius:14px;background:#080e18;border:1px solid #273750;margin-bottom:16px}
.price-val{font-size:28px;font-weight:900;color:#fff;line-height:1.1}
.price-note{font-size:13px;color:var(--muted);margin-top:4px}
.specs-box{display:grid;gap:8px;margin-bottom:16px}
.spec-row{display:flex;justify-content:space-between;gap:12px;padding:9px 12px;border-radius:10px;background:#09101b;border:1px solid #223047}
.spec-row strong{color:var(--muted);font-weight:600}
.spec-row span{font-weight:700;text-align:right}
.cta-col{display:grid;gap:10px}
.gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.media-card{display:block;border-radius:14px;overflow:hidden;border:1px solid #253247;background:#060a11;aspect-ratio:16/10}
.media-card img,.media-card video{width:100%;height:100%;object-fit:cover;display:block}
.features-box{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:20px;margin-top:16px}
.features-box h2{margin:0 0 12px;font-size:19px}
.features-box ul{margin:0;padding-left:20px;display:grid;gap:6px;color:#d6e0ee}
footer{border-top:1px solid var(--line);margin-top:42px;padding:22px 0;color:var(--muted);font-size:13px;text-align:center}
@media(max-width:860px){.hero-card{grid-template-columns:1fr}}
</style>
</head>
<body>
<header><div class="wrap nav">
  <a href="${escapeHtml(homeHref)}"><img class="logo" src="${escapeHtml(logoSrc)}" alt="AVTOY KOREA"></a>
  <div style="display:flex;gap:10px;flex-wrap:wrap">
    <a class="btn btn-tg" href="${escapeHtml(carsHref)}">← Весь каталог</a>
    <a class="btn" href="${escapeHtml(reqHref)}">Заказать расчёт →</a>
  </div>
</div></header>
<main class="wrap">
  <nav class="crumbs" aria-label="Навигация">
    <a href="${escapeHtml(homeHref)}">Главная</a><span>›</span>
    <a href="${escapeHtml(carsHref)}">Каталог авто</a><span>›</span>
    <span>${escapeHtml(meta.title)}</span>
  </nav>
  <section class="hero-card">
    <div>${galleryHtml}</div>
    <div>
      ${meta.trim ? `<div class="trim">${escapeHtml(meta.trim)}</div>` : ""}
      <h1>${escapeHtml(meta.title)}</h1>
      <div class="price-box">
        <div class="price-val">${escapeHtml(meta.priceFormatted)}</div>
        <div class="price-note">${escapeHtml(meta.priceNote)} · под ключ с проверкой перед покупкой</div>
      </div>
      ${specsHtml}
      <div class="cta-col">
        <a class="btn" href="${escapeHtml(reqHref)}">Оставить заявку на этот автомобиль →</a>
        <a class="btn btn-max" href="${escapeHtml(maxLink)}">M Написать в бот MAX</a>
        <a class="btn btn-tg" href="https://t.me/avtoYkorea" target="_blank" rel="noopener">Канал Telegram (@avtoYkorea) ↗</a>
      </div>
    </div>
  </section>
  ${featuresHtml}
</main>
<footer><div class="wrap">AVTOY KOREA — подбор и доставка проверенных автомобилей из Южной Кореи, Китая и ОАЭ</div></footer>
</body>
</html>`;
}

export function renderNewsLandingHtml(newsItem, { baseUrl, isStaticMirror = false, maxBotUrl = "" } = {}) {
  const cleanBase = normalizeBaseUrl(baseUrl);
  const parsed = parseNewsCardData(newsItem);
  const media = collectMediaItems(newsItem);
  const homeHref = isStaticMirror ? "../index.html" : "/";
  const newsHref = isStaticMirror ? "../index.html#news" : "/#news";
  const reqHref = isStaticMirror ? "../index.html#request" : "/#request";
  const logoSrc = isStaticMirror ? "../assets/logo.jpg" : "/assets/logo.jpg";
  const canonical = newsAbsoluteUrl(cleanBase, newsItem.id, isStaticMirror);
  const firstPhoto = media.find(m => m.type === "photo");
  const ogImage = firstPhoto ? toAbsoluteUrl(cleanBase, firstPhoto.url) : `${cleanBase}/assets/logo.jpg`;
  const maxLink = maxBotUrl && /^https:\/\/max\.ru\//.test(maxBotUrl) ? maxBotUrl : reqHref;
  const desc = (parsed.bodyLines.join(" ") || parsed.title).slice(0, 220);

  const ldJson = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: parsed.title,
    description: desc,
    image: ogImage,
    url: canonical,
    publisher: { "@type": "Organization", name: "AVTOY KOREA" }
  }).replace(/</g, "\\u003c");

  const mediaHtml = media.map(m => {
    const src = escapeHtml(toMirrorSubpageMedia(m.url, isStaticMirror));
    return m.type === "video"
      ? `<video src="${src}" controls playsinline preload="metadata" style="width:100%;max-height:540px;border-radius:14px;background:#05080f"></video>`
      : `<img src="${src}" alt="${escapeHtml(parsed.title)}" style="width:100%;height:auto;border-radius:14px;border:1px solid #253247">`;
  }).join("");

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(parsed.title)} — Новости авторынка | AVTOY KOREA</title>
<meta name="description" content="${escapeHtml(desc)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtml(parsed.title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:image" content="${escapeHtml(ogImage)}">
<script type="application/ld+json">${ldJson}</script>
<style>
:root{color-scheme:dark;--bg:#070c14;--panel:#101723;--line:#253247;--text:#f4f7fc;--muted:#9fb0c7;--red:#f12f38}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(ellipse at 78% 0%,#16253b 0,transparent 40%),var(--bg);color:var(--text);font:16px/1.65 Inter,system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
a{color:inherit;text-decoration:none}
.wrap{width:min(960px,calc(100% - 32px));margin:0 auto}
header{border-bottom:1px solid #ffffff16;background:#071321f0;padding:14px 0}
.nav{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.logo{width:170px;height:auto;display:block}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 20px;border-radius:12px;font-weight:800;font-size:14px;background:var(--red);color:#fff}
.btn-max{background:linear-gradient(135deg,#6d28d9,#2563eb);border:1px solid #a78bfa80}
.article{background:linear-gradient(155deg,#151f30,#0d1420);border:1px solid var(--line);border-radius:22px;padding:26px;margin:26px 0}
h1{margin:10px 0 16px;font-size:clamp(24px,3.2vw,34px);line-height:1.2}
.badge{display:inline-block;padding:5px 12px;border-radius:999px;font-size:12px;font-weight:800;background:#7c2d1266;border:1px solid #f9731680;color:#fed7aa}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}
</style>
</head>
<body>
<header><div class="wrap nav">
  <a href="${escapeHtml(homeHref)}"><img class="logo" src="${escapeHtml(logoSrc)}" alt="AVTOY KOREA"></a>
  <a class="btn" style="background:#0b121e;border:1px solid #2b3a52" href="${escapeHtml(newsHref)}">← Ко всем новостям</a>
</div></header>
<main class="wrap">
  <article class="article">
    <span class="badge">${escapeHtml(parsed.badge)}</span>
    <h1>${escapeHtml(parsed.title)}</h1>
    ${parsed.bodyLines.map(p => `<p>${escapeHtml(p)}</p>`).join("")}
    <div style="margin-top:18px;display:grid;gap:14px">${mediaHtml}</div>
    <div class="actions">
      <a class="btn" href="${escapeHtml(reqHref)}">Рассчитать автомобиль по актуальным условиям →</a>
      <a class="btn btn-max" href="${escapeHtml(maxLink)}">M Написать в бот MAX</a>
    </div>
  </article>
</main>
</body>
</html>`;
}

export function buildRobotsTxt({ baseUrl } = {}) {
  const cleanBase = normalizeBaseUrl(baseUrl);
  return [
    "User-agent: Yandex",
    "Allow: /",
    "Disallow: /admin",
    "Disallow: /ops",
    "Clean-param: utm_source&utm_medium&utm_campaign&utm_content&utm_term&yclid&gclid",
    "",
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin",
    "Disallow: /ops",
    "",
    `Sitemap: ${cleanBase}/sitemap.xml`,
    ""
  ].join("\n");
}

export function buildSitemapXml({ baseUrl, cars = [], news = [], useHtmlExt = false, updatedAt = new Date().toISOString() } = {}) {
  const cleanBase = normalizeBaseUrl(baseUrl);
  const lastModDay = String(updatedAt || new Date().toISOString()).slice(0, 10);
  const urls = [
    { loc: `${cleanBase}/`, lastmod: lastModDay, changefreq: "daily", priority: "1.0" }
  ];

  for (const car of Array.isArray(cars) ? cars : []) {
    if (!car || !car.id || isPlaceholderCar(car)) continue;
    urls.push({
      loc: carAbsoluteUrl(cleanBase, car.id, useHtmlExt),
      lastmod: String(car.publishedAt || lastModDay).slice(0, 10),
      changefreq: "weekly",
      priority: "0.8"
    });
  }

  for (const n of Array.isArray(news) ? news : []) {
    if (!n || !n.id) continue;
    urls.push({
      loc: newsAbsoluteUrl(cleanBase, n.id, useHtmlExt),
      lastmod: String(n.publishedAt || lastModDay).slice(0, 10),
      changefreq: "weekly",
      priority: "0.7"
    });
  }

  const body = urls.map(u => (
    `  <url>\n    <loc>${escapeXml(u.loc)}</loc>\n    <lastmod>${escapeXml(u.lastmod)}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
  )).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export function buildYandexMarketYml({ baseUrl, cars = [], useHtmlExt = false, updatedAt = new Date().toISOString() } = {}) {
  const cleanBase = normalizeBaseUrl(baseUrl);
  const formattedDate = String(updatedAt || new Date().toISOString()).replace(/\.\d{3}Z$/, "+00:00");
  const validCars = (Array.isArray(cars) ? cars : []).filter(c => c && c.id && !isPlaceholderCar(c));

  const offers = [];
  for (const car of validCars) {
    const media = collectMediaItems(car);
    const meta = parseVehicleCardData({ ...car, mediaItems: media });
    if (!meta.priceRub || meta.priceRub < 300000) continue;

    const pictures = media.filter(m => m.type === "photo").slice(0, 10).map(m => toAbsoluteUrl(cleanBase, m.url));
    const picTags = (pictures.length ? pictures : [`${cleanBase}/assets/logo.jpg`])
      .map(u => `        <picture>${escapeXml(u)}</picture>`)
      .join("\n");

    const params = [];
    if (meta.year) params.push(`        <param name="Год выпуска">${escapeXml(meta.year.replace(/\s*г\.?$/, ""))}</param>`);
    if (meta.mileage) params.push(`        <param name="Пробег">${escapeXml(meta.mileage)}</param>`);
    if (meta.engineChip) params.push(`        <param name="Двигатель">${escapeXml(meta.engineChip)}</param>`);
    if (meta.powerChip) params.push(`        <param name="Мощность">${escapeXml(meta.powerChip)}</param>`);
    if (meta.driveChip) params.push(`        <param name="Привод">${escapeXml(meta.driveChip)}</param>`);

    const offerId = String(car.id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    const name = [meta.title, meta.trim, meta.year].filter(Boolean).join(" ").slice(0, 120);
    const desc = cleanCarDisplayCaption(car.caption || "").replace(/\s+/g, " ").trim().slice(0, 2500);

    offers.push([
      `      <offer id="${escapeXml(offerId)}" available="true">`,
      `        <url>${escapeXml(carAbsoluteUrl(cleanBase, car.id, useHtmlExt))}</url>`,
      `        <price>${meta.priceRub}</price>`,
      `        <currencyId>RUR</currencyId>`,
      `        <categoryId>1</categoryId>`,
      picTags,
      `        <vendor>${escapeXml(meta.brand)}</vendor>`,
      `        <name>${escapeXml(name)}</name>`,
      `        <description>${escapeXml(desc)}</description>`,
      ...params,
      `      </offer>`
    ].join("\n"));
  }

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<yml_catalog date="${escapeXml(formattedDate)}">`,
    `  <shop>`,
    `    <name>AVTOY KOREA</name>`,
    `    <company>AVTOY KOREA — подбор и доставка автомобилей под заказ</company>`,
    `    <url>${escapeXml(cleanBase)}/</url>`,
    `    <currencies>`,
    `      <currency id="RUR" rate="1"/>`,
    `    </currencies>`,
    `    <categories>`,
    `      <category id="1">Автомобили под заказ из Южной Кореи, Китая и ОАЭ</category>`,
    `    </categories>`,
    `    <offers>`,
    offers.join("\n"),
    `    </offers>`,
    `  </shop>`,
    `</yml_catalog>`,
    ``
  ].join("\n");
}
