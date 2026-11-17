// Restores public/assets/logo.jpg and kia-sportage.jpg with SHA-256 verification before Wrangler deploy.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(ROOT, 'public/assets');
const srcDir = path.join(ROOT, 'assets-src');

fs.mkdirSync(outDir, { recursive: true });
const files = fs.existsSync(srcDir) ? fs.readdirSync(srcDir).sort() : [];

function readB64(prefixes) {
  const matches = files.filter(f => prefixes.some(p => f.startsWith(p)));
  if (!matches.length) throw new Error('Missing asset source: ' + prefixes.join(', '));
  return matches.map(f => fs.readFileSync(path.join(srcDir, f), 'utf8')).join('').replace(/\s+/g, '');
}

const targets = [
  { prefixes: ['logo'], dest: path.join(outDir, 'logo.jpg'), size: 18979, sha: '2aa1fa2840857b09eff4a78b63935abeaaa692bef4801f87ce37b972d01fc453' },
  { prefixes: ['kia-sportage', 'sportage'], dest: path.join(outDir, 'kia-sportage.jpg'), size: 16326, sha: 'd3bb08643743f759b1aedf87456fb7cae8dff550db285814d94cdc924459ee92' }
];

for (const a of targets) {
  const b = Buffer.from(readB64(a.prefixes), 'base64');
  const h = crypto.createHash('sha256').update(b).digest('hex');
  if (b.length !== a.size || h !== a.sha) throw new Error('Asset verification failed: ' + a.dest);
  fs.writeFileSync(a.dest, b);
  console.log(`Restored ${path.basename(a.dest)} (${b.length} bytes, SHA-256 OK)`);
}
