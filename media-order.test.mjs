import test from "node:test";
import assert from "node:assert/strict";
import { mediaItemsFromTelegramMessage, mergeOrderedMediaItems, orderedMediaFromRecord } from "./media-order.js";

const photo = (id, unique, width = 1600, height = 900) => ({
  file_id: id, file_unique_id: unique, width, height, type: "photo"
});

test("photo-video-photo album is ordered by Telegram source message ID", () => {
  const parts = [
    mediaItemsFromTelegramMessage({ message_id: 103, video: { file_id: "v", file_unique_id: "uv" } }),
    mediaItemsFromTelegramMessage({ message_id: 101, photo: [{ file_id: "p-small", file_unique_id: "up" }, { file_id: "p", file_unique_id: "up", width: 2000, height: 1200 }] }),
    mediaItemsFromTelegramMessage({ message_id: 105, photo: [{ file_id: "p2", file_unique_id: "up2" }] })
  ];
  const result = mergeOrderedMediaItems(parts[0], [...parts[1], ...parts[2]]);
  assert.deepEqual(result.mediaItems.map(item => item.file_id), ["p", "v", "p2"]);
  assert.deepEqual(result.mediaItems.map(item => item.type), ["photo", "video", "photo"]);
  assert.equal(result.mediaOrderKnown, true);
});

test("out-of-order webhook delivery still sorts by source message ID", () => {
  const result = mergeOrderedMediaItems(
    [{ ...photo("late", "late"), sourceMessageId: 300 }],
    [{ ...photo("early", "early"), sourceMessageId: 299 }]
  );
  assert.deepEqual(result.mediaItems.map(item => item.file_id), ["early", "late"]);
});

test("duplicate webhook retries are idempotent and retain earliest source ID", () => {
  const first = { ...photo("same", "stable"), sourceMessageId: 50 };
  const retry = { ...photo("same", "stable", 2000, 1200), sourceMessageId: 50 };
  const result = mergeOrderedMediaItems([first], [retry]);
  assert.equal(result.mediaItems.length, 1);
  assert.equal(result.mediaItems[0].sourceMessageId, 50);
  assert.equal(result.mediaOrderKnown, true);
});

test("missing source IDs never produce a verified order", () => {
  const result = mergeOrderedMediaItems([{ ...photo("legacy", "legacy") }], [{ ...photo("new", "new"), sourceMessageId: 90 }]);
  assert.equal(result.mediaOrderKnown, false);
});

test("legacy split photo/video arrays are not silently assigned an order", () => {
  const result = orderedMediaFromRecord({ photos: [photo("p", "p")], videos: [{ file_id: "v" }] });
  assert.deepEqual(result, { mediaItems: [], mediaOrderKnown: false });
});

test("photo-only records remain orderable when source IDs are present", () => {
  const result = mergeOrderedMediaItems([], [
    { ...photo("p2", "p2"), sourceMessageId: 12 },
    { ...photo("p1", "p1"), sourceMessageId: 11 }
  ]);
  assert.deepEqual(result.mediaItems.map(item => item.file_id), ["p1", "p2"]);
  assert.equal(result.mediaOrderKnown, true);
});

test("separate album accumulators remain isolated", () => {
  const albumA = mergeOrderedMediaItems([], [{ ...photo("a1", "a1"), sourceMessageId: 10 }]);
  const albumB = mergeOrderedMediaItems([], [{ ...photo("b1", "b1"), sourceMessageId: 10 }]);
  assert.deepEqual(albumA.mediaItems.map(item => item.file_id), ["a1"]);
  assert.deepEqual(albumB.mediaItems.map(item => item.file_id), ["b1"]);
});

test("image documents keep their type and source position", () => {
  const items = mediaItemsFromTelegramMessage({
    message_id: 77,
    document: { file_id: "doc", file_unique_id: "udoc", mime_type: "image/jpeg" }
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "document");
  assert.equal(items[0].sourceMessageId, 77);
});
