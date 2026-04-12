import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const targetVersion = String(process.argv[2] || '').trim();

function runNpm(args) {
    const result = process.platform === 'win32'
        ? spawnSync(
            process.env.ComSpec || 'cmd.exe',
            ['/d', '/s', '/c', `npm ${args.join(' ')}`],
            {
                cwd: projectRoot,
                stdio: 'inherit',
            },
        )
        : spawnSync('npm', args, {
            cwd: projectRoot,
            stdio: 'inherit',
        });

    if (typeof result.status === 'number' && result.status !== 0) {
        process.exit(result.status);
    }

    if (result.error) {
        console.error('[release-local] Failed to run command:', args.join(' '));
        console.error(result.error);
        process.exit(1);
    }
}

if (targetVersion) {
    runNpm(['run', 'release:prepare', '--', targetVersion]);
}

runNpm(['run', 'pack:local']);
