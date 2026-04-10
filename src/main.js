import { setLocalChangeNotifier, logStatus } from './state.js';
import { bindMediaHooks, readLocalMediaState } from './media.js';
import { createUI } from './ui.js';
import { publish } from './sync.js';

function waitForGameReady() {
    return new Promise((resolve) => {
        const timer = setInterval(() => {
            if (Player && ChatRoomData) {
                clearInterval(timer);
                resolve();
            }
        }, 500);
    });
}

async function publishLocalMediaState() {
    const mediaState = readLocalMediaState();
    if (!mediaState) return;
    await publish('media_state', mediaState);
}

async function start() {
    await waitForGameReady();
    setLocalChangeNotifier(async () => {
        await publishLocalMediaState();
    });
    createUI();
    bindMediaHooks(publishLocalMediaState);
    logStatus('Ready');
}

start().catch((error) => {
    console.error('[BCLT] fatal start error:', error);
});
