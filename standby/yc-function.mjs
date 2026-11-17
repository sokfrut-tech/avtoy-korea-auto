// Yandex Cloud Functions HTTP adapter (Always Free 0 RUB/month — .zip deployment, no Docker Registry cost).
import { Readable } from 'node:stream';
import { createStandbyApp } from './server.mjs';

let cachedAppPromise = null;

async function getApp() {
  if (!cachedAppPromise) {
    cachedAppPromise = (async () => {
      let requestStore = null;
      if (process.env.YDB_CONNECTION_STRING && process.env.INBOX_STORE === 'v2') {
        const [{ Driver }, { query }, { MetadataCredentialsProvider }, { createYdbRequestStore }] = await Promise.all([
          import('@ydbjs/core'),
          import('@ydbjs/query'),
          import('@ydbjs/auth/metadata'),
          import('./storage/ydb-request-store.mjs')
        ]);
        const driver = new Driver(process.env.YDB_CONNECTION_STRING, {
          credentialsProvider: new MetadataCredentialsProvider()
        });
        await driver.ready();
        requestStore = createYdbRequestStore({ sql: query(driver), schemaManagedExternally: false });
        await requestStore.ensureMaxWebhookSchema();
        await requestStore.ensureMaxCommandReplySchema();
        await requestStore.ensureOperatorAuditSchema();
      }
      return createStandbyApp({ requestStore });
    })();
  }
  return cachedAppPromise;
}

export async function handler(event) {
  const app = await getApp();
  const method = String(event?.httpMethod || 'GET').toUpperCase();
  const rawPath = String(event?.url || event?.path || '/');
  const queryParams = event?.queryStringParameters || {};
  const qs = new URLSearchParams(queryParams).toString();
  const fullUrl = rawPath.includes('?') || !qs ? rawPath : `${rawPath}?${qs}`;

  const rawHeaders = event?.headers || {};
  const normalizedHeaders = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    normalizedHeaders[String(k).toLowerCase()] = String(v ?? '');
  }

  const bodyBuf = event?.body
    ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8')
    : Buffer.alloc(0);

  const req = Readable.from(bodyBuf.length ? [bodyBuf] : []);
  req.method = method;
  req.url = fullUrl;
  req.headers = normalizedHeaders;
  req.socket = { remoteAddress: event?.requestContext?.identity?.sourceIp || '127.0.0.1' };

  return new Promise(resolve => {
    let statusCode = 200;
    const resHeaders = {};
    const chunks = [];

    const res = {
      headersSent: false,
      writeHead(code, hdrs = {}) {
        statusCode = code;
        res.headersSent = true;
        for (const [k, v] of Object.entries(hdrs)) {
          resHeaders[String(k).toLowerCase()] = String(v);
        }
        return res;
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        const out = Buffer.concat(chunks);
        const ct = String(resHeaders['content-type'] || '');
        const isText = /^(text\/|application\/(json|xml|javascript))/.test(ct);
        resolve({
          statusCode,
          headers: resHeaders,
          body: isText ? out.toString('utf8') : out.toString('base64'),
          isBase64Encoded: !isText
        });
      },
      destroy() {
        resolve({ statusCode: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"Internal error"}', isBase64Encoded: false });
      }
    };

    app(req, res);
  });
}
