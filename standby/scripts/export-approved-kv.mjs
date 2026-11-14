import { promises as fs } from 'node:fs';
import path from 'node:path';

const accountId = process.env.CF_ACCOUNT_ID;
const namespaceId = process.env.CF_KV_NAMESPACE_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const outputPath = process.argv[2] || 'data/private-approved-export.json';
const confirmed = process.argv.includes('--confirm-approved-public-export');
const prefixes = ['car_approved:', 'approved:'];
const base = 'https://api.cloudflare.com/client/v4';

if (!accountId || !namespaceId || !token || !confirmed) {
  process.stderr.write(
    'Refusing to export. Set CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID, CLOUDFLARE_API_TOKEN and pass --confirm-approved-public-export.\n' +
    'Usage: node scripts/export-approved-kv.mjs [private-output.json] --confirm-approved-public-export\n'
  );
  process.exit(2);
}
if (!/^[a-f0-9]{32}$/i.test(accountId) || !/^[a-f0-9]{32}$/i.test(namespaceId)) {
  throw new Error('Cloudflare account and KV namespace IDs must be 32-character hexadecimal IDs');
}
if (path.resolve(outputPath).startsWith(path.resolve('public') + path.sep)) {
  throw new Error('Private export must not be written inside the public directory');
}
const headers = { Authorization: 'Bearer ' + token };
async function api(url) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  const body = await response.json();
  if (!response.ok || body?.success !== true) {
    throw new Error('Cloudflare API request failed (' + response.status + '): ' +
      (Array.isArray(body?.errors) ? body.errors.map(e => e.code).join(',') : 'unknown'));
  }
  return body;
}
async function listPrefix(prefix) {
  const keys = [];
  let cursor = '';
  do {
    const params = new URLSearchParams({ limit: '1000', prefix });
    if (cursor) params.set('cursor', cursor);
    const body = await api(base + '/accounts/' + accountId + '/storage/kv/namespaces/' +
      namespaceId + '/keys?' + params.toString());
    const page = Array.isArray(body.result) ? body.result : [];
    for (const item of page) {
      if (typeof item?.name !== 'string' || !item.name.startsWith(prefix)) {
        throw new Error('KV returned a key outside the requested approved prefix');
      }
      keys.push(item.name);
    }
    cursor = typeof body.result_info?.cursor === 'string' ? body.result_info.cursor : '';
  } while (cursor);
  return keys;
}
const names = [...new Set((await Promise.all(prefixes.map(listPrefix))).flat())].sort();
const records = [];
for (let offset = 0; offset < names.length; offset += 4) {
  const batch = await Promise.all(names.slice(offset, offset + 4).map(async key => {
    const url = base + '/accounts/' + accountId + '/storage/kv/namespaces/' +
      namespaceId + '/values/' + encodeURIComponent(key);
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Could not read an approved KV value (HTTP ' + response.status + ')');
    const valueText = await response.text();
    let value;
    try { value = JSON.parse(valueText); }
    catch { throw new Error('Approved KV value is not valid JSON; export aborted'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Approved KV record has an unsupported value; export aborted');
    }
    return { key, value };
  }));
  records.push(...batch);
}
const exportData = { exportSchemaVersion: 1, records };
await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
const tempPath = path.resolve(outputPath) + '.tmp';
await fs.writeFile(tempPath, JSON.stringify(exportData, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
await fs.rename(tempPath, path.resolve(outputPath));
process.stdout.write('Private approved-record export written: ' + records.length +
  ' records. Only approved car/review prefixes were requested. Protect and delete this private file after the mirror is verified.\n');
