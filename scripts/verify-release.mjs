import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const pkgPath = resolve(projectRoot, 'package.json');
const sourceEntryPath = resolve(projectRoot, 'src', 'userscript-entry.js');
const loaderPath = resolve(projectRoot, 'loader.user.js');
const changelogPath = resolve(projectRoot, 'CHANGELOG_UI.md');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = String(pkg.version || '').trim();
const errors = [];

if (!/^\d+\.\d+\.\d+$/.test(version)) {
    errors.push(`package.json version is invalid: ${version || '<empty>'}`);
}

function checkUserScriptVersion(filePath, label) {
    const content = readFileSync(filePath, 'utf8');
    const match = content.match(/^\/\/\s*@version\s+(.+)$/m);
    if (!match) {
        errors.push(`${label} missing @version metadata`);
        return;
    }
    const scriptVersion = String(match[1]).trim();
    if (scriptVersion !== version) {
        errors.push(`${label} @version (${scriptVersion}) does not match package.json (${version})`);
    }
}

checkUserScriptVersion(loaderPath, 'loader.user.js');

if (!existsSync(sourceEntryPath)) {
    errors.push('src/userscript-entry.js does not exist');
}

if (!existsSync(changelogPath)) {
    errors.push('CHANGELOG_UI.md does not exist');
} else {
    const changelog = readFileSync(changelogPath, 'utf8');
    const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const versionHeading = new RegExp(`^##\\s*\\[${escapedVersion}\\]\\s*-\\s*`, 'm');
    if (!versionHeading.test(changelog)) {
        errors.push(`CHANGELOG_UI.md is missing a heading for version ${version}`);
    }
}

if (errors.length > 0) {
    console.error('[verify-release] validation failed:');
    errors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
}

console.log(`[verify-release] validation passed for version ${version}`);
