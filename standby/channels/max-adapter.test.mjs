import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaxAdapter, MAX_API_BASE } from './max-adapter.mjs';

const item = { id: 'abcd1234-0000-0000-0000-000000000000', name: 'Private Name', contact: '+7 999 123-45-67', model: 'Kia Sportage', comment: 'Private comment' };

test('MAX sends only to the configured operator group with Authorization header', async () => {
  let request;
  const adapter = createMaxAdapter({
    token: 'secret-token',
    operatorChatId: '123456789',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ message: { body: { mid: 'm1' } } }), { status: 200 });
    }
  });
  const result = await adapter.sendOperatorNotification(item);
  assert.deepEqual(result, { ok: true, retryable: false, receiptId: 'max:123456789' });
  assert.equal(request.url, MAX_API_BASE + '/messages?chat_id=123456789');
  assert.equal(request.options.headers.Authorization, 'secret-token');
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.notify, true);
  assert.match(payload.text, /Kia Sportage/);
  assert.doesNotMatch(payload.text, /Private Name|999 123|Private comment/);
});

test('MAX refuses missing token or invalid configured group without network calls', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('must not run'); };
  assert.equal((await createMaxAdapter({ operatorChatId: '123', fetchImpl }).sendOperatorNotification(item)).reason, 'max_not_configured');
  assert.equal((await createMaxAdapter({ token: 't', operatorChatId: '123?x=1', fetchImpl }).sendOperatorNotification(item)).reason, 'max_operator_chat_not_configured');
  assert.equal(calls, 0);
});

test('MAX classifies rate limits and server failures as retryable', async () => {
  for (const [status, retryable] of [[429, true], [503, true], [401, false], [400, false]]) {
    const adapter = createMaxAdapter({ token: 't', operatorChatId: '123', fetchImpl: async () => new Response('{}', { status }) });
    const result = await adapter.sendOperatorNotification(item);
    assert.equal(result.ok, false);
    assert.equal(result.retryable, retryable);
  }
});

test('MAX network errors and timeouts remain retryable and do not expose credentials', async () => {
  const adapter = createMaxAdapter({ token: 'sensitive-token', operatorChatId: '123', fetchImpl: async () => { throw new Error('sensitive-token network failure'); } });
  const result = await adapter.sendOperatorNotification(item);
  assert.deepEqual(result, { ok: false, retryable: true, reason: 'max_network_error' });
  assert.equal(JSON.stringify(result).includes('sensitive-token'), false);
});

test('MAX rejects malformed request IDs without calling the API', async () => {
  let calls = 0;
  const adapter = createMaxAdapter({ token: 't', operatorChatId: '123', fetchImpl: async () => { calls += 1; } });
  const result = await adapter.sendOperatorNotification({ ...item, id: 'bad' });
  assert.equal(result.reason, 'max_request_invalid');
  assert.equal(calls, 0);
});
