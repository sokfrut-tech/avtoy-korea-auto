import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'pages');
const resourceAttrs = /<(?:img|video|audio|source|script|iframe|embed|object|link)\\b[^>]*?\\b(?:src|href|poster)\\s*=\\s*[\"']\\s*(?:https?:)?\\/\\//i;
const cssRemote = /url\\(\\s*[\"']?\\s*(?:https?:)?\\/\\//i;
const jsRemote = /\\b(?:fetch|import)\\s*\\(\\s*(['\\x22\\x60])\\s*(?:https?:)?\\/\\//i;
const jsSocket = /\\bnew\\s+(?:WebSocket|EventSource)\\s*\\(\\s*(['\\x22\\x60])\\s*(?:wss?:)?\\/\\//i;
const xhrRemote = /\\.open\\s*\\(\\s*['\\x22](?:GET|POST|PUT|PATCH|DELETE)['\\x22]\\s*,\\s*['\\x22]https?:\\/\\//i;
const forbidden = /(?:workers\\.dev|cloudflare(?:pages)?\\.dev|appdeploy\\.ai|appdeploy\\.com)/i;

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not allowed in static output: ' + full);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

const files = await walk(root);
if (!files.some(file => path.relative(root, file) === 'index.html')) throw new Error('Static output is missing index.html');
let checked = 0;
for (const file of files) {
  const ext = path.extname(file).toLowerCase();
  if (!['.html','.css','.js','.mjs','.json','.webmanifest','.xml','.txt'].includes(ext)) continue;
  const content = await fs.readFile(file, 'utf8');
  if (forbidden.test(content)) throw new Error('Forbidden Cloudflare/AppDeploy origin reference in ' + path.relative(root, file));
  if (ext === '.html' && resourceAttrs.test(content)) throw new Error('External resource URL in HTML critical path: ' + path.relative(root, file));
  if (ext === '.css' && cssRemote.test(content)) throw new Error('External CSS asset URL: ' + path.relative(root, file));
  if (['.js','.mjs'].includes(ext) && (jsRemote.test(content) || jsSocket.test(content) || xhrRemote.test(content))) {
    throw new Error('External runtime network dependency in JavaScript: ' + path.relative(root, file));
  }
  checked++;
}
process.stdout.write('Static origin check passed: ' + checked + ' text assets checked; no external resource origins found.\\n');
