import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'));

export default defineConfig({
    server: {
        host: '127.0.0.1',
        port: 5180,
        strictPort: true,
        cors: true,
    },
    plugins: [
        monkey({
            entry: 'src/userscript-entry.js',
            userscript: {
                name: 'BC Watch Together',
                namespace: 'https://github.com/VivianMoonlight',
                version: packageJson.version,
                description: 'Watch together in BC chat rooms via Supabase Realtime.',
                author: 'VivianMoonlight',
                match: [
                    'https://bondageprojects.elementfx.com/*',
                    'https://www.bondageprojects.elementfx.com/*',
                    'https://bondage-europe.com/*',
                    'https://www.bondage-europe.com/*',
                    'https://bondageprojects.com/*',
                    'https://www.bondageprojects.com/*',
                    'https://www.bondage-asia.com/club/R*',
                ],
                grant: ['none'],
                runAt: 'document-idle',
            },
            build: {
                fileName: 'BCWatchTogether.user.js',
            },
        }),
    ],
});
