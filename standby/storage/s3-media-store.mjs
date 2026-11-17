// Zero-dependency S3 client (AWS Signature V4) for Yandex Object Storage / Cloud.ru Free Tier.
import { createHash, createHmac } from 'node:crypto';

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function encodeS3Path(objectKey) {
  return String(objectKey)
    .split('/')
    .filter(Boolean)
    .map(part => encodeURIComponent(part))
    .join('/');
}

export function createS3MediaStore({
  endpoint = process.env.S3_ENDPOINT || 'https://storage.yandexcloud.net',
  region = process.env.S3_REGION || 'ru-central1',
  bucket = process.env.S3_BUCKET || '',
  accessKeyId = process.env.S3_ACCESS_KEY_ID || '',
  secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || '',
  publicBaseUrl = process.env.S3_PUBLIC_BASE_URL || '',
  fetchImpl = fetch
} = {}) {
  const cleanEndpoint = String(endpoint || '').replace(/\/+$/, '');
  const cleanBucket = String(bucket || '').trim();
  const configured = Boolean(cleanEndpoint && cleanBucket && accessKeyId && secretAccessKey);

  function signHeaders({ method, objectKey, payloadHash, extraHeaders = {}, now = new Date() }) {
    const url = new URL(`${cleanEndpoint}/${encodeURIComponent(cleanBucket)}/${encodeS3Path(objectKey)}`);
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const headers = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), String(v)]))
    };

    const sortedKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedKeys.map(k => `${k}:${headers[k].trim()}\n`).join('');
    const signedHeaders = sortedKeys.join(';');
    const canonicalRequest = [method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

    const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = hmac(kSigning, stringToSign, 'hex');

    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return { url: url.toString(), headers: { ...headers, authorization } };
  }

  function publicUrlFor(objectKey) {
    const base = String(publicBaseUrl || `${cleanEndpoint}/${encodeURIComponent(cleanBucket)}`).replace(/\/+$/, '');
    return `${base}/${encodeS3Path(objectKey)}`;
  }

  async function putVerifiedObject({ key, body, contentType }) {
    if (!configured) throw new Error('S3 media store is not configured');
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const expectedSha256 = sha256Hex(buffer);

    const putSigned = signHeaders({
      method: 'PUT',
      objectKey: key,
      payloadHash: expectedSha256,
      extraHeaders: {
        'content-type': contentType,
        'content-length': buffer.length,
        'cache-control': 'public, max-age=31536000, immutable'
      }
    });
    const putRes = await fetchImpl(putSigned.url, {
      method: 'PUT',
      headers: putSigned.headers,
      body: buffer
    });
    if (!putRes.ok) {
      throw new Error(`S3 PUT failed for ${key}: HTTP ${putRes.status}`);
    }

    // Read back from storage and verify actual stored bytes SHA-256 & byte length.
    const getSigned = signHeaders({
      method: 'GET',
      objectKey: key,
      payloadHash: sha256Hex('')
    });
    const getRes = await fetchImpl(getSigned.url, {
      method: 'GET',
      headers: getSigned.headers
    });
    if (!getRes.ok) {
      throw new Error(`S3 read-back verification failed for ${key}: HTTP ${getRes.status}`);
    }
    const storedBytes = Buffer.from(await getRes.arrayBuffer());
    const actualSha256 = sha256Hex(storedBytes);
    if (storedBytes.length !== buffer.length || actualSha256 !== expectedSha256) {
      throw new Error(`S3 integrity mismatch for ${key}: expected ${expectedSha256}, got ${actualSha256}`);
    }

    return {
      key,
      url: publicUrlFor(key),
      size: storedBytes.length,
      sha256: actualSha256,
      contentType
    };
  }

  return Object.freeze({ configured, publicUrlFor, putVerifiedObject });
}
