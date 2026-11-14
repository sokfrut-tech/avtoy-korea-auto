import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'dist');
const MAX_TOTAL_BYTES = 140 * 1024 * 1024;
const MAX_FILES = 1800;
const files = [];
async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes:true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symlinks are forbidden in deployment output');
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile()) {
      const stat = await fs.stat(full);
      if (!stat.size) throw new Error('Empty deployment file: ' + path.relative(root, full));
      files.push({ path:path.relative(root, full), bytes:stat.size });
    }
  }
}
await walk(root);
const total = files.reduce((sum, file) => sum + file.bytes, 0);
if (files.length > MAX_FILES) throw new Error('Static output exceeds safe file-count budget: ' + files.length);
if (total > MAX_TOTAL_BYTES) throw new Error('Static output exceeds 140 MiB safety budget for Tuqo Free (150 MB quota); refusing deploy');
process.stdout.write('Static output within safety budget: ' + files.length + ' files, ' + (total / 1048576).toFixed(2) + ' MiB.\n');
