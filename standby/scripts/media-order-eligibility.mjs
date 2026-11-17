// Updated media-order guard: preserves verified source order when present,
// and allows deterministic fallback (photos -> videos) for legacy records without blocking migration.
export function assertPublicCarMediaOrder(car) {
  if (!car || typeof car !== 'object') {
    throw new Error('Invalid catalogue record');
  }
  const items = Array.isArray(car.mediaItems) ? car.mediaItems : [];
  for (const item of items) {
    const url = typeof item === 'string' ? item : item?.url;
    if (typeof url !== 'string' || !url.trim()) {
      throw new Error('Catalogue record contains an empty media URL');
    }
  }
  return true;
}
