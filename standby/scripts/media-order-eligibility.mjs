export function assertPublicCarMediaOrder(car) {
  if (car?.mediaOrderKnown === false) {
    throw new Error('Public Worker API reports incomplete or ambiguous source media; use the approved-KV export path');
  }
  const items = Array.isArray(car?.mediaItems) ? car.mediaItems : [];
  const hasPhoto = items.some(item => (typeof item === 'object' ? item.type : '') === 'photo');
  const hasVideo = items.some(item => (typeof item === 'object' ? item.type : '') === 'video');
  if (hasPhoto && hasVideo && car.mediaOrderKnown !== true) {
    throw new Error('Mixed photo/video album has no explicit source-order proof; use the approved-KV export path');
  }
  return true;
}
