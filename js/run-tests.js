// `npm test`: node:test over every js/**/*.test.js. Node 20 can't expand the glob itself (21+ can), so the files
// are found here and handed to `node --test`.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

function find(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (e.name === 'vendor' ? [] : find(join(dir, e.name)))
      : e.name.endsWith('.test.js') ? [join(dir, e.name)] : []);
}

const files = find(root).sort().map(f => relative(process.cwd(), f));
const { status } = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(status ?? 1);
