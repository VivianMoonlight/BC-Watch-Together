import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const targets = ['dist'];
if (process.env.CLEAN_RELEASE === '1') {
    targets.push('release');
}

for (const relative of targets) {
    const target = resolve(projectRoot, relative);
    try {
        rmSync(target, { recursive: true, force: true });
        console.log(`[clean] removed ${relative}`);
    } catch (error) {
        if (error && error.code === 'EPERM' && relative === 'release') {
            console.warn('[clean] skipped release cleanup due to EPERM (set CLEAN_RELEASE=1 and retry when unlocked).');
            continue;
        }
        throw error;
    }
}
