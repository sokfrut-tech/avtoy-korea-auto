// Canonical Telegram album ordering helpers. This module is deliberately pure:
// it never guesses order for legacy records that lack source message IDs.

function fileIdentity(item) {
  if (!item || typeof item !== "object") return "";
  return String(item.file_unique_id || item.file_id || "");
}

function largestPhoto(photoSizes) {
  if (!Array.isArray(photoSizes) || !photoSizes.length) return null;
  return photoSizes.reduce((best, item) => {
    if (!item || !item.file_id) return best;
    if (!best) return item;
    const area = (Number(item.width) || 0) * (Number(item.height) || 0);
    const bestArea = (Number(best.width) || 0) * (Number(best.height) || 0);
    return area > bestArea || (area === bestArea && (Number(item.file_size) || 0) > (Number(best.file_size) || 0)) ? item : best;
  }, null);
}

export function mediaItemsFromTelegramMessage(message) {
  if (!message || typeof message !== "object") return [];
  const sourceMessageId = Number.isSafeInteger(Number(message.message_id)) && Number(message.message_id) > 0
    ? Number(message.message_id) : null;
  const items = [];
  const photo = largestPhoto(message.photo);
  if (photo) items.push({ ...photo, type: "photo", sourceMessageId });
  const document = message.document;
  if (document && document.file_id && /^image\//i.test(String(document.mime_type || ""))) {
    items.push({ ...document, type: "document", sourceMessageId });
  }
  const video = message.video;
  if (video && video.file_id) items.push({ ...video, type: "video", sourceMessageId });
  return items;
}

export function mergeOrderedMediaItems(existing, incoming) {
  const candidates = [
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(incoming) ? incoming : [])
  ];
  const byIdentity = new Map();
  for (const raw of candidates) {
    if (!raw || typeof raw !== "object" || !fileIdentity(raw)) continue;
    const item = { ...raw };
    const identity = fileIdentity(item);
    const previous = byIdentity.get(identity);
    if (!previous) {
      byIdentity.set(identity, item);
      continue;
    }
    // A retry may carry richer metadata; retain it while keeping the earliest
    // trustworthy source message ID for this same Telegram media object.
    const oldId = Number(previous.sourceMessageId);
    const newId = Number(item.sourceMessageId);
    const sourceMessageId = Number.isSafeInteger(oldId) && oldId > 0
      ? oldId
      : (Number.isSafeInteger(newId) && newId > 0 ? newId : null);
    byIdentity.set(identity, { ...previous, ...item, sourceMessageId });
  }
  const mediaItems = [...byIdentity.values()].sort((a, b) => {
    const ai = Number(a.sourceMessageId), bi = Number(b.sourceMessageId);
    const av = Number.isSafeInteger(ai) && ai > 0, bv = Number.isSafeInteger(bi) && bi > 0;
    if (av && bv) return ai - bi;
    if (av !== bv) return av ? -1 : 1;
    return 0;
  });
  const mediaOrderKnown = mediaItems.length > 0 &&
    mediaItems.every(item => Number.isSafeInteger(Number(item.sourceMessageId)) && Number(item.sourceMessageId) > 0);
  return { mediaItems, mediaOrderKnown };
}

export function orderedMediaFromRecord(record) {
  if (!record || !Array.isArray(record.mediaItems) || !record.mediaItems.length) {
    return { mediaItems: [], mediaOrderKnown: false };
  }
  const merged = mergeOrderedMediaItems([], record.mediaItems);
  // Never promote a legacy/partially migrated record to a verified order.
  const declaredKnown = record.mediaOrderKnown === true;
  return {
    mediaItems: merged.mediaItems,
    mediaOrderKnown: declaredKnown && merged.mediaOrderKnown
  };
}
