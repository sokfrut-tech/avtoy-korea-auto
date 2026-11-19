// Smart vehicle & review text cleaner and structured metadata parser for AVTOY KOREA.

export function cleanCarDisplayCaption(raw) {
  const base = String(raw || "")
    .replace(/\r/g, "")
    .replace(/\*+/g, "")
    // Strip leftover Telegram contact tails ("Для заказа автомобиля обращайтесь: Владимир: +")
    .replace(/(?:^|\n)\s*Для заказа(?:\s+автомобиля|\s+аналогичного автомобиля)?\s+обращайтесь\s*:?[\s\S]*$/i, "")
    .replace(/(?:^|\n)\s*По актуальному курсу на сегодняшний день\s*/gi, "\n")
    .replace(/(?:^|\n)\s*Организуем доставку до Вас!?\s*/gi, "\n")
    .replace(/(?:^|\n)\s*(?:Владимир|Менеджер|Контакт|Продавец)\s*:\s*\+?\s*$/gim, "")
    .replace(/(?:^|\n)\s*\+\s*$/gm, "")
    .replace(/\s+,/g, ",")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*в\s+наличии\s*\n+/i, "")
    .replace(/^\s*в\s+наличии\s+/i, "")
    .trim();
  // Repair orphaned ". " list items left behind when keycap emojis (e.g. "2️⃣. ") were stripped
  let prevNum = 0;
  return base.split("\n").map(line => {
    const trimmed = line.replace(/^[\u2060\s]+/, "");
    const numMatch = trimmed.match(/^(\d+)\.\s+/);
    if (numMatch) {
      prevNum = Number(numMatch[1]);
      return trimmed;
    }
    if (/^\.\s+/.test(trimmed)) {
      if (prevNum > 0) {
        prevNum += 1;
        return `${prevNum}. ${trimmed.replace(/^\.\s+/, "")}`;
      }
      return `• ${trimmed.replace(/^\.\s+/, "")}`;
    }
    return line;
  }).join("\n");
}

const BRAND_ALIASES = [
  { canonical: "Kia", rx: /\b(?:kia|киа)\b/i },
  { canonical: "Hyundai", rx: /\b(?:hyundai|хендай|хёндай|solaris|sonata|avante|palisade|kona|creta)\b/i },
  { canonical: "Volkswagen", rx: /\b(?:volkswagen|фольксваген|vw|tharu|t-roc|t-cross|tacqua|bora|tiguan|tayron)\b/i },
  { canonical: "Mercedes-Benz", rx: /\b(?:mercedes(?:-benz)?|мерседес|glb|glc|gle)\b/i },
  { canonical: "Chevrolet", rx: /\b(?:chevrolet|shevrolet|шевроле|monza|trailblazer)\b/i },
  { canonical: "Geely", rx: /\b(?:geely|джили|coolray|monjaro|atlas)\b/i },
  { canonical: "Toyota", rx: /\b(?:toyota|тойота|rav4|camry|highlander)\b/i },
  { canonical: "Honda", rx: /\b(?:honda|хонда|crider|cr-v|vezel|breeze)\b/i },
  { canonical: "Mitsubishi", rx: /\b(?:mitsubishi|митсубиси|asx|outlander)\b/i },
  { canonical: "Skoda", rx: /\b(?:skoda|шкода|kamiq|karoq|kodiaq|octavia)\b/i },
  { canonical: "Haval", rx: /\b(?:haval|хавал|h6|jolion|dargo)\b/i },
  { canonical: "Zeekr", rx: /\b(?:zeekr|зикр)\b/i },
  { canonical: "KG Mobility", rx: /\b(?:kg[_\s-]*mobility|ssangyong|tiboli|tivoli|torres|korando)\b/i },
  { canonical: "BMW", rx: /\b(?:bmw|бмв)\b/i },
  { canonical: "Audi", rx: /\b(?:audi|ауди)\b/i },
  { canonical: "Changan", rx: /\b(?:changan|чанган)\b/i },
  { canonical: "Genesis", rx: /\b(?:genesis|генезис|gv70|gv80|g70|g80|g90)\b/i },
  { canonical: "LiXiang", rx: /\b(?:lixiang|li\s*auto|лисян|l6|l7|l8|l9)\b/i },
  { canonical: "Voyah", rx: /\b(?:voyah|войя|free|dream)\b/i },
  { canonical: "Tank", rx: /\b(?:tank|танк)\b/i },
  { canonical: "Chery", rx: /\b(?:chery|чери|tiggo)\b/i },
  { canonical: "Exeed", rx: /\b(?:exeed|эксид)\b/i },
  { canonical: "Jetour", rx: /\b(?:jetour|джетур|dashing)\b/i },
  { canonical: "Lexus", rx: /\b(?:lexus|лексус|rx\d*|lx\d*|nx\d*)\b/i },
  { canonical: "Porsche", rx: /\b(?:porsche|порше|cayenne|macan|panamera)\b/i },
  { canonical: "Land Rover", rx: /\b(?:land\s*rover|range\s*rover|ленд\s*ровер|рейндж\s*ровер|defender)\b/i },
  { canonical: "Mazda", rx: /\b(?:mazda|мазда|cx-\d+)\b/i },
  { canonical: "Nissan", rx: /\b(?:nissan|ниссан|x-trail|qashqai)\b/i }
];

export function parseVehicleCardData(car) {
  const cleaned = cleanCarDisplayCaption(car?.caption || "");
  const lines = cleaned
    .split("\n")
    .map(l => l.replace(/\u00a0/g, " ").trim())
    .filter(Boolean);

  // Drop promo lead-in lines like "встречайте новый" or "В НАЛИЧИИ НОВЫЙ ..."
  let titleLineIndex = 0;
  let promoBadge = "";
  if (lines.length > 1 && /^(?:встречайте(?:\s+новый)?|новинка|спецпредложение|в\s+наличии)$/i.test(lines[0])) {
    if (/в\s+наличии/i.test(lines[0])) promoBadge = "Под заказ";
    titleLineIndex = 1;
  }

  let rawTitle = (lines[titleLineIndex] || "").replace(/^(?:в\s+наличии\s+(?:новый\s+)?|новый\s+(?=[A-Za-z]))/i, match => {
    promoBadge = /новый/i.test(match) ? "Новый" : "Под заказ";
    return "";
  });
  rawTitle = rawTitle
    .replace(/KG_MOBILITY_SSANGYONG/gi, "KG Mobility (SsangYong)")
    .replace(/\bTIBOLI\b/gi, "Tivoli")
    .replace(/\bShevrolet\b/gi, "Chevrolet")
    .replace(/_/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Check if line right after title is an all-caps trim line (e.g. "SUPER PERFORMANCE" or "LUXURY EDITION")
  let extraTrimLine = "";
  if (
    lines[titleLineIndex + 1] &&
    !lines[titleLineIndex + 1].includes(":") &&
    /^[A-Z0-9\s-]{4,32}$/.test(lines[titleLineIndex + 1]) &&
    !/цена|год|пробег/i.test(lines[titleLineIndex + 1])
  ) {
    extraTrimLine = lines[titleLineIndex + 1];
  }

  const kvPairs = [];
  const features = [];
  let priceRub = null;
  let priceFormatted = "По запросу";
  let priceNote = "расчёт под ключ";

  for (let i = 0; i < lines.length; i++) {
    if (i === titleLineIndex || (extraTrimLine && i === titleLineIndex + 1)) continue;
    const line = lines[i];

    // Check price header + next line with number, or inline price
    if (/^цена(?:\s+под\s+ключ)?/i.test(line)) {
      const cityMatch = line.match(/до\s+([А-Яа-яЁёA-Za-z\s/-]+?)\s*:?$/i);
      if (cityMatch) priceNote = "под ключ до " + cityMatch[1].trim();
      const inlineNum = line.replace(/^.*?:/, "").trim();
      const candidate = /\d/.test(inlineNum) ? inlineNum : (lines[i + 1] || "");
      const digits = candidate.replace(/[^\d]/g, "");
      if (digits.length >= 6 && digits.length <= 9) {
        priceRub = Number(digits);
        priceFormatted = priceRub.toLocaleString("ru-RU") + " ₽";
        if (!/\d/.test(inlineNum)) i += 1;
      } else if (/по\s+запросу/i.test(line) || /по\s+запросу/i.test(candidate)) {
        priceFormatted = "По запросу";
      }
      continue;
    }

    // Standalone ruble price line
    if (/^[\d\s.,]{6,15}\s*₽$/.test(line)) {
      const digits = line.replace(/[^\d]/g, "");
      if (digits.length >= 6) {
        priceRub = Number(digits);
        priceFormatted = priceRub.toLocaleString("ru-RU") + " ₽";
        continue;
      }
    }

    if (/^цена\s+по\s+запросу$/i.test(line)) {
      priceFormatted = "По запросу";
      continue;
    }

    if (/^(?:характеристики|комплектация|описание|опции)\s*:?$/i.test(line)) {
      continue;
    }

    const colonIdx = line.indexOf(":") >= 0 ? line.indexOf(":") : line.indexOf("：");
    if (colonIdx >= 2 && colonIdx <= 32 && line.slice(colonIdx + 1).trim()) {
      const k = line.slice(0, colonIdx).trim();
      const v = line.slice(colonIdx + 1).trim().replace(/\bShevrolet\b/gi, "Chevrolet");
      kvPairs.push({ key: k, value: v });
      continue;
    }

    // Short keyless lines like "Год 2026/06", "Бензин 2л", "Пробег 0", "Мощность 1400лс"
    let m;
    if ((m = line.match(/^Год(?:\s+выпуска)?\s+(.+)$/i))) {
      kvPairs.push({ key: "Год выпуска", value: m[1] });
    } else if ((m = line.match(/^Пробег\s+(.+)$/i))) {
      kvPairs.push({ key: "Пробег", value: m[1] });
    } else if ((m = line.match(/^Мощность\s+(.+)$/i))) {
      kvPairs.push({ key: "Мощность", value: m[1] });
    } else if ((m = line.match(/^(Бензин|Дизель|Гибрид|Электро|Газ)\s+(.+)$/i))) {
      kvPairs.push({ key: "Топливо", value: m[1] });
      kvPairs.push({ key: "Двигатель", value: m[2] });
    } else if (line.length >= 3) {
      features.push(line.replace(/^[•●▪✓✔-]\s*/, ""));
    }
  }

  const findSpec = rx => kvPairs.find(p => rx.test(p.key))?.value || "";
  const yearRaw = findSpec(/^год/i);
  const yearMatch = yearRaw.match(/\b(20\d{2})\b/) || rawTitle.match(/\b(20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : (yearRaw || "");

  const mileageRaw = findSpec(/^пробег/i);
  let mileage = "";
  let isNew = false;
  if (/новый|^0(?:\s*км)?$/i.test(mileageRaw.trim())) {
    mileage = "Без пробега";
    isNew = true;
  } else if (mileageRaw) {
    const mDigits = mileageRaw.replace(/[^\d]/g, "");
    mileage = mDigits ? Number(mDigits).toLocaleString("ru-RU") + " км" : mileageRaw;
  }

  const engineVol = findSpec(/^двигатель/i);
  const fuel = findSpec(/^топливо/i);
  const powerRaw = findSpec(/^мощность/i);
  const driveRaw = findSpec(/^привод/i);

  let brand = "";
  const fullSearchText = `${rawTitle} ${findSpec(/^марка/i)} ${findSpec(/^модель/i)}`;
  for (const b of BRAND_ALIASES) {
    if (b.rx.test(fullSearchText)) {
      brand = b.canonical;
      break;
    }
  }

  const hasVideo = Array.isArray(car?.mediaItems) && car.mediaItems.some(m => m?.type === "video");
  if (!rawTitle) {
    rawTitle = hasVideo ? "Видеообзор автомобиля под заказ" : "Автомобиль из Южной Кореи";
  }

  // Filter redundant Марка / Модель out of displayed fullSpecs table
  const displaySpecs = kvPairs.filter(p => !/^(?:марка|модель)$/i.test(p.key));

  const engineChip = [engineVol ? (engineVol.includes("л") ? engineVol : engineVol + " л") : "", fuel]
    .filter(Boolean)
    .join(" · ");
  const powerChip = powerRaw ? (powerRaw.includes("л.с") || powerRaw.includes("лс") ? powerRaw.replace(/лс/i, " л.с.").replace(/\s+/g, " ") : powerRaw + " л.с.") : "";
  const driveChip = driveRaw ? driveRaw.replace(/\s*\(.*?\)/, "").trim() : "";

  return {
    id: car?.id || "",
    brand: brand || "Другие",
    title: rawTitle,
    trim: extraTrimLine || findSpec(/^комплектация/i) || "",
    promoBadge: promoBadge || (isNew ? "Новый" : ""),
    year: year ? year + " г." : "",
    mileage,
    engineChip,
    powerChip,
    driveChip,
    priceRub,
    priceFormatted,
    priceNote,
    hasVideo,
    isNew,
    displaySpecs,
    features,
    cleanedCaption: cleaned
  };
}

export function deduplicateMediaItems(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item) continue;
    const url = typeof item === "string" ? item : item.url;
    if (!url) continue;
    // Match trailing hash segment in migrated filenames like "-8c3245c8f1eb.jpg" or exact URL
    const hashMatch = String(url).match(/-([0-9a-f]{12})\.[a-z0-9]+$/i);
    const key = hashMatch ? `hash:${hashMatch[1].toLowerCase()}` : `url:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(typeof item === "string" ? { type: "photo", url } : item);
  }
  return out;
}

export function isMarketNewsRecord(record) {
  if (!record || typeof record !== "object") return false;
  const id = String(record.id || "");
  if (id.startsWith("news_") || record.category === "news" || record.kind === "news") return true;
  const text = String(record.text || record.caption || "");
  if (!text) return false;
  const hasMarketTopic = /(?:утильсбор|индексаци[яи]|растаможк|параллельн\w+\s+импорт|таможенн\w+\s+пошлин|изменени\w+\s+правил|ставк\w+\s+утиль)/i.test(text);
  const hasCustomerThanks = /(?:спасибо|благодар|довольного\s+клиента|довольных\s+клиентов|прилетел\s+отзыв|очередной\s+отзыв)/i.test(text);
  return hasMarketTopic && !hasCustomerThanks;
}

export function parseNewsCardData(item) {
  const raw = cleanCarDisplayCaption(item?.text || item?.caption || "");
  const lines = raw
    .split("\n")
    .map(l => l.replace(/\u00a0/g, " ").replace(/^[\u2060\s]+/, "").trim())
    .filter(Boolean);
  const title = (lines[0] || "Новость AVTOY KOREA").replace(/[!?.]+$/, "").trim();
  const bodyLines = lines.length > 1 ? lines.slice(1) : [];
  const isUrgent = /(?:утильсбор|срочно|подорожан|удорожан|закрыть|таких\s+цен.*не\s+будет|индексац)/i.test(raw);
  return {
    id: item?.id || "",
    title,
    bodyLines,
    fullText: raw,
    isUrgent,
    badge: isUrgent ? "⚡ Важная новость" : "📰 Новость"
  };
}

const DEDUP_STOP_WORDS = new Set([
  "встречайте", "новый", "новая", "новое", "под", "заказ", "наличии",
  "из", "кореи", "южной", "китая", "оаэ", "авто", "автомобиль", "автомобили"
]);

export function normalizePostDedupText(raw) {
  const cleaned = cleanCarDisplayCaption(raw || "")
    .replace(/^(?:\s*\[(?:MAX|TG|Telegram)\]\s*)+/i, "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bt\.me\/\S+/gi, " ")
    .replace(/\bmax\.ru\/\S+/gi, " ")
    .replace(/@[A-Za-z0-9_]{3,}/g, " ")
    .replace(/#[A-Za-zА-Яа-яЁё0-9_]+/g, " ")
    .replace(/(?:\+?\d[\s().-]*){7,}/g, " ");
  const tokens = cleaned.toLowerCase().match(/[a-zа-яё0-9]+/gi);
  return tokens ? tokens.join(" ") : "";
}

export function buildCarContentKeys(carOrCaption) {
  const rawCaption = typeof carOrCaption === "string"
    ? carOrCaption
    : String(carOrCaption?.caption || "");
  const keys = [];
  const normText = normalizePostDedupText(rawCaption);
  if (normText.length >= 24) keys.push("txt:" + normText);

  const meta = parseVehicleCardData({ caption: rawCaption });
  const yearNum = String(meta.year || "").match(/\b(20\d{2})\b/)?.[1] || "";
  const mileageNum = meta.isNew ? "new" : String(meta.mileage || "").replace(/[^\d]/g, "");
  const titleTokens = (String(meta.title || "").toLowerCase().match(/[a-zа-яё0-9]+/gi) || [])
    .filter(tok => !DEDUP_STOP_WORDS.has(tok));
  const modelTokens = titleTokens.slice(0, 3).join(" ");

  if (meta.brand !== "Другие" && yearNum && modelTokens) {
    const brandLower = meta.brand.toLowerCase();
    if (mileageNum && meta.priceRub) {
      keys.push("spec_full:" + [brandLower, modelTokens, yearNum, mileageNum, meta.priceRub].join("|"));
    }
    if (mileageNum && mileageNum !== "new" && mileageNum.length >= 3) {
      keys.push("spec_ym:" + [brandLower, modelTokens, yearNum, mileageNum].join("|"));
    }
    if (meta.isNew && meta.priceRub) {
      keys.push("spec_new:" + [brandLower, modelTokens, yearNum, meta.priceRub].join("|"));
    }
  }
  return [...new Set(keys)];
}

export function isCarListingPost({ text, hasMedia = true } = {}) {
  if (!hasMedia) return false;
  const rawText = String(text || "").trim();
  if (!rawText || rawText.toLowerCase() === "исправить") return false;
  if (isMarketNewsRecord({ text: rawText })) return false;
  if (/(?:спасибо|благодар|довольного\s+клиента|довольных\s+клиентов|прилетел\s+отзыв|очередной\s+отзыв)/i.test(rawText)) {
    return false;
  }
  const firstLine = cleanCarDisplayCaption(rawText)
    .split("\n")
    .map(l => l.trim())
    .find(Boolean) || "";
  if (
    /\?\s*$/.test(firstLine) ||
    /^(?:здравствуйте|добрый\s+(?:день|вечер)|всем\s+привет|подскажите|сколько\s+стоит|хочу\s+(?:заказать|купить)|ищу\s+|кто\s+может)/i.test(firstLine)
  ) {
    return false;
  }

  const meta = parseVehicleCardData({ caption: rawText });
  if (
    meta.brand !== "Другие" &&
    (Boolean(meta.year) ||
      Boolean(meta.mileage) ||
      Boolean(meta.priceRub) ||
      Boolean(meta.engineChip) ||
      Boolean(meta.powerChip) ||
      /(?:под\s+ключ|пробег|год\s+выпуска|двигател|мощност|привод|комплектаци)/i.test(rawText))
  ) {
    return true;
  }

  const specHits = [
    Boolean(meta.year),
    Boolean(meta.mileage),
    Boolean(meta.priceRub),
    /(?:двигател|топливо|мощност|привод)/i.test(rawText)
  ].filter(Boolean).length;
  return specHits >= 2;
}

