import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();

const distScript = resolve(projectRoot, 'dist', 'BCWatchTogether.user.js');
const loaderScript = resolve(projectRoot, 'loader.user.js');
if (!existsSync(distScript)) {
    console.error('[pack-release] missing dist/BCWatchTogether.user.js. Run build first.');
    process.exit(1);
}

const releaseDir = resolve(projectRoot, 'release', `v${version}`);
mkdirSync(releaseDir, { recursive: true });

const publishedScriptPath = resolve(projectRoot, 'BCWatchTogether.user.js');
const releaseScriptPath = resolve(releaseDir, `BCWatchTogether-v${version}.user.js`);
const releaseLoaderPath = resolve(releaseDir, `BCWatchTogetherLoader-v${version}.user.js`);
copyFileSync(distScript, publishedScriptPath);
copyFileSync(distScript, releaseScriptPath);
copyFileSync(loaderScript, releaseLoaderPath);

const hash = createHash('sha256').update(readFileSync(releaseScriptPath)).digest('hex');
const checksumPath = resolve(releaseDir, 'SHA256SUMS.txt');
writeFileSync(
    checksumPath,
    `${hash}  BCWatchTogether-v${version}.user.js\n`,
    'utf8'
);

const manifestPath = resolve(releaseDir, 'release-manifest.json');
writeFileSync(
    manifestPath,
    JSON.stringify(
        {
            name: 'bc-watch-together',
            version,
            generatedAt: new Date().toISOString(),
            artifacts: [
                `BCWatchTogether-v${version}.user.js`,
                `BCWatchTogetherLoader-v${version}.user.js`,
                'SHA256SUMS.txt',
            ],
        },
        null,
        2,
    ),
    'utf8',
);

console.log(`[pack-release] release artifacts generated in ${releaseDir}`);
