export async function runRetry(env, fetcher = fetch) {
  const base = String(env.STANDBY_RETRY_URL || '').trim();
  const token = String(env.STANDBY_ADMIN_TOKEN || '');
  if (!base || token.length < 32) {
    throw new Error('Retry scheduler configuration is incomplete');
  }

  let endpoint;
  try {
    endpoint = new URL(base);
  } catch {
    throw new Error('Retry endpoint URL is invalid');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Retry endpoint must be a clean HTTPS base URL');
  }
  const basePathSegments = endpoint.pathname.split('/').filter(Boolean);
  endpoint.pathname = '/' + [...basePathSegments, 'ops', 'retry'].join('/');

  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/json'
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    throw new Error('Standby retry endpoint returned HTTP ' + response.status);
  }
  const result = await response.json();
  if (!result || !Array.isArray(result.results) || typeof result.processed !== 'number') {
    throw new Error('Standby retry endpoint returned an invalid response');
  }
  return result;
}

export default {
  async scheduled(_controller, env, context) {
    context.waitUntil(runRetry(env).catch(() => {
      console.error('Standby retry cycle failed; check scheduler and standby health.');
    }));
  }
};
