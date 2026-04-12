import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const targetVersion = String(process.argv[2] || '').trim();
if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) {
    console.error('[prepare-release] Usage: npm run release:prepare -- <x.y.z>');
    console.error(`[prepare-release] Invalid version: ${targetVersion || '<empty>'}`);
    process.exit(1);
}

const pkgPath = resolve(projectRoot, 'package.json');
const loaderPath = resolve(projectRoot, 'loader.user.js');
const changelogPath = resolve(projectRoot, 'CHANGELOG_UI.md');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = targetVersion;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

const loaderContent = readFileSync(loaderPath, 'utf8');
if (!/^\/\/\s*@version\s+/m.test(loaderContent)) {
    console.error('[prepare-release] loader.user.js missing @version metadata');
    process.exit(1);
}
const updatedLoader = loaderContent.replace(
    /(^\/\/\s*@version\s+).+$/m,
    `$1${targetVersion}`,
);
writeFileSync(loaderPath, updatedLoader, 'utf8');

const changelogContent = readFileSync(changelogPath, 'utf8');
const escapedVersion = targetVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasHeading = new RegExp(`^##\\s*\\[${escapedVersion}\\]\\s*-\\s*`, 'm').test(changelogContent);

if (!hasHeading) {
    const lineBreak = changelogContent.includes('\r\n') ? '\r\n' : '\n';
    const today = new Date().toISOString().slice(0, 10);
    const template = [
        `## [${targetVersion}] - ${today}`,
        '',
        '### Changed',
        '- Add release notes here.',
        '',
    ].join(lineBreak);

    const titleMatch = changelogContent.match(/^#.*(?:\r?\n){1,2}/);
    const insertIndex = titleMatch ? titleMatch[0].length : 0;
    const nextContent = `${changelogContent.slice(0, insertIndex)}${template}${changelogContent.slice(insertIndex)}`;
    writeFileSync(changelogPath, nextContent, 'utf8');
    console.log(`[prepare-release] Added CHANGELOG_UI.md heading for ${targetVersion}`);
} else {
    console.log(`[prepare-release] CHANGELOG_UI.md already has heading for ${targetVersion}`);
}

console.log(`[prepare-release] Updated package.json and loader.user.js to ${targetVersion}`);
