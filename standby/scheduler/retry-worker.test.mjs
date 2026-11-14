import test from 'node:test';
import assert from 'node:assert/strict';
import { runRetry } from '../retry-worker.mjs';

test('scheduler calls only the protected HTTPS retry endpoint', async () => {
  let requested;
  const result = await runRetry({
    STANDBY_RETRY_URL: 'https://standby.example',
    STANDBY_ADMIN_TOKEN: 'x'.repeat(40)
  }, async (url, options) => {
    requested = { url: String(url), options };
    return new Response(JSON.stringify({ processed: 2, results: [{ id: 'a', status: 'delivered' }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  });
  assert.equal(requested.url, 'https://standby.example/ops/retry');
  assert.equal(requested.options.method, 'POST');
  assert.equal(requested.options.headers.authorization, 'Bearer ' + 'x'.repeat(40));
  assert.deepEqual(result.results[0], { id: 'a', status: 'delivered' });
});

test('scheduler refuses non-HTTPS or credential-bearing endpoints', async () => {
  await assert.rejects(() => runRetry({
    STANDBY_RETRY_URL: 'http://standby.example',
    STANDBY_ADMIN_TOKEN: 'x'.repeat(40)
  }), /clean HTTPS/);
  await assert.rejects(() => runRetry({
    STANDBY_RETRY_URL: 'https://user:pass@standby.example',
    STANDBY_ADMIN_TOKEN: 'x'.repeat(40)
  }), /clean HTTPS/);
});

test('scheduler requires a long admin token and validates endpoint response', async () => {
  await assert.rejects(() => runRetry({
    STANDBY_RETRY_URL: 'https://standby.example',
    STANDBY_ADMIN_TOKEN: 'short'
  }), /configuration/);
  await assert.rejects(() => runRetry({
    STANDBY_RETRY_URL: 'https://standby.example',
    STANDBY_ADMIN_TOKEN: 'x'.repeat(40)
  }, async () => new Response('{}', { status: 200 })), /invalid response/);
});
