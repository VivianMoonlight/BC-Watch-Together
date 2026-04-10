import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

for (const relative of ['dist', 'release']) {
    const target = resolve(projectRoot, relative);
    rmSync(target, { recursive: true, force: true });
    console.log(`[clean] removed ${relative}`);
}
