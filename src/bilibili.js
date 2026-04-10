import { nowMs, notifyLocalChange, state } from './state.js';

export function parseBilibiliBvid(input) {
    if (!input) return null;
    const text = String(input).trim();
    const bvidMatch = text.match(/(BV[0-9A-Za-z]{10,})/i);
    if (bvidMatch) return bvidMatch[1];

    const urlMatch = text.match(/[?&]bvid=(BV[0-9A-Za-z]{10,})/i);
    if (urlMatch) return urlMatch[1];

    return null;
}

export function isBilibiliUrl(input) {
    if (!input) return false;
    return /bilibili\.com|b23\.tv/i.test(String(input));
}

export function secondsToHms(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
}

export function buildBilibiliPlayerUrl(input, options = {}) {
    const { currentTime = 0, autoplay = false } = options;
    const targetTime = Math.max(0, Math.floor(Number(currentTime) || 0));
    const text = String(input || '').trim();
    const bvid = parseBilibiliBvid(text);
    if (bvid) {
        const params = new URLSearchParams({
            bvid,
            page: '1',
            as_wide: '1',
            high_quality: '1',
            autoplay: autoplay ? '1' : '0',
            t: String(targetTime),
        });
        return `https://player.bilibili.com/player.html?${params.toString()}`;
    }

    if (isBilibiliUrl(text)) {
        try {
            const url = new URL(text);
            const candidate = url.searchParams.get('bvid');
            if (candidate) {
                return buildBilibiliPlayerUrl(candidate, options);
            }
            const aid = url.searchParams.get('aid');
            const page = url.searchParams.get('p') || '1';
            if (aid) {
                const params = new URLSearchParams({
                    aid,
                    page,
                    as_wide: '1',
                    high_quality: '1',
                    autoplay: autoplay ? '1' : '0',
                    t: String(targetTime),
                });
                return `https://player.bilibili.com/player.html?${params.toString()}`;
            }
        } catch (error) {
            // Ignore URL parse errors and fall through.
        }
    }

    return null;
}

export function removeBilibiliEmbed() {
    if (state.embedFrame && state.embedFrame.parentElement) {
        state.embedFrame.parentElement.remove();
    }
    state.embedFrame = null;
}

export function getBilibiliEmbedIframe() {
    return document.querySelector('#bclt-bilibili-dock iframe');
}

const BILIBILI_VIEW_API = 'https://api.bilibili.com/x/web-interface/view';
const durationPromiseByBvid = new Map();
const durationByBvid = new Map();

function readPageIndexFromSource(input) {
    const text = String(input || '').trim();
    if (!text) return 1;
    try {
        const parsed = new URL(text);
        const fromQuery = Number(parsed.searchParams.get('p') || 1);
        return Number.isFinite(fromQuery) && fromQuery > 0 ? Math.floor(fromQuery) : 1;
    } catch (error) {
        return 1;
    }
}

function extractDurationSecondsFromViewPayload(payload, sourceUrl) {
    const data = payload && payload.data ? payload.data : null;
    if (!data) return null;

    const pageIndex = readPageIndexFromSource(sourceUrl);
    const pageDuration = Array.isArray(data.pages) && data.pages.length >= pageIndex
        ? Number(data.pages[pageIndex - 1]?.duration)
        : NaN;

    if (Number.isFinite(pageDuration) && pageDuration > 0) {
        return Math.max(1, Math.floor(pageDuration));
    }

    const duration = Number(data.duration);
    if (Number.isFinite(duration) && duration > 0) {
        return Math.max(1, Math.floor(duration));
    }

    return null;
}

async function fetchBilibiliDurationViaHttp(bvid, sourceUrl) {
    const url = `${BILIBILI_VIEW_API}?bvid=${encodeURIComponent(bvid)}`;
    const response = await fetch(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const duration = extractDurationSecondsFromViewPayload(payload, sourceUrl);
    if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error('Duration missing in view payload');
    }

    return duration;
}

function fetchBilibiliDurationViaJsonp(bvid, sourceUrl) {
    return new Promise((resolve, reject) => {
        const callbackName = `__bclt_duration_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const script = document.createElement('script');
        const timeoutMs = 8000;
        let timeoutId = 0;

        const cleanup = () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            if (script.parentElement) {
                script.parentElement.removeChild(script);
            }
            try {
                delete window[callbackName];
            } catch (error) {
                window[callbackName] = undefined;
            }
        };

        window[callbackName] = (payload) => {
            try {
                const duration = extractDurationSecondsFromViewPayload(payload, sourceUrl);
                cleanup();
                if (Number.isFinite(duration) && duration > 0) {
                    resolve(duration);
                    return;
                }
                reject(new Error('Duration missing in JSONP payload'));
            } catch (error) {
                cleanup();
                reject(error);
            }
        };

        script.onerror = () => {
            cleanup();
            reject(new Error('JSONP request failed'));
        };

        timeoutId = window.setTimeout(() => {
            cleanup();
            reject(new Error('JSONP request timed out'));
        }, timeoutMs);

        const callbackParam = encodeURIComponent(callbackName);
        script.src = `${BILIBILI_VIEW_API}?bvid=${encodeURIComponent(bvid)}&jsonp=jsonp&callback=${callbackParam}`;
        document.head.appendChild(script);
    });
}

async function fetchBilibiliDuration(bvid, sourceUrl) {
    if (durationByBvid.has(bvid)) {
        return durationByBvid.get(bvid);
    }

    if (durationPromiseByBvid.has(bvid)) {
        return durationPromiseByBvid.get(bvid);
    }

    const task = (async () => {
        try {
            // Prefer JSONP first to avoid noisy CORS errors from fetch in cross-origin userscript contexts.
            const duration = await fetchBilibiliDurationViaJsonp(bvid, sourceUrl);
            durationByBvid.set(bvid, duration);
            return duration;
        } catch (jsonpError) {
            const duration = await fetchBilibiliDurationViaHttp(bvid, sourceUrl);
            durationByBvid.set(bvid, duration);
            return duration;
        }
    })();

    durationPromiseByBvid.set(bvid, task);

    try {
        return await task;
    } finally {
        durationPromiseByBvid.delete(bvid);
    }
}

export async function hydrateBilibiliDuration(sourceUrl) {
    const bvid = parseBilibiliBvid(sourceUrl);
    if (!bvid) return null;

    const duration = await fetchBilibiliDuration(bvid, sourceUrl);
    if (sourceUrl === state.bilibili.sourceUrl && Number.isFinite(duration) && duration > 0) {
        state.bilibili.duration = Math.max(1, Math.floor(duration));
    }

    return duration;
}

export function computeBilibiliSyntheticState() {
    const elapsedSeconds = state.bilibili.paused || !state.bilibili.startedAt
        ? 0
        : ((nowMs() - state.bilibili.startedAt) / 1000) * state.bilibili.playbackRate;

    return {
        mediaKind: 'bilibili',
        sourceUrl: state.bilibili.sourceUrl || state.settings.mediaUrl || '',
        bvid: state.bilibili.bvid || parseBilibiliBvid(state.bilibili.sourceUrl || state.settings.mediaUrl || '') || '',
        currentTime: state.bilibili.currentTime + elapsedSeconds,
        paused: state.bilibili.paused,
        playbackRate: state.bilibili.playbackRate,
        duration: Number.isFinite(Number(state.bilibili.duration)) && Number(state.bilibili.duration) > 0
            ? Number(state.bilibili.duration)
            : null,
    };
}

export function updateBilibiliDockStatus() {
    const status = document.querySelector('#bclt-bilibili-status');
    if (!status) return;
    const current = computeBilibiliSyntheticState();
    status.textContent = `${current.paused ? 'Paused' : 'Playing'} @ ${secondsToHms(current.currentTime)}`;
}

export function setBilibiliSyntheticState(nextState, reason = 'sync') {
    const sourceUrl = nextState.sourceUrl || state.bilibili.sourceUrl || state.settings.mediaUrl;
    if (!sourceUrl) return false;

    const sourceChanged = sourceUrl !== state.bilibili.sourceUrl;
    const currentTime = Number.isFinite(Number(nextState.currentTime)) ? Number(nextState.currentTime) : state.bilibili.currentTime;
    const duration = Number.isFinite(Number(nextState.duration)) && Number(nextState.duration) > 0
        ? Math.max(1, Math.floor(Number(nextState.duration)))
        : null;
    const paused = typeof nextState.paused === 'boolean' ? nextState.paused : state.bilibili.paused;
    const playbackRate = Number.isFinite(Number(nextState.playbackRate)) && Number(nextState.playbackRate) > 0
        ? Number(nextState.playbackRate)
        : state.bilibili.playbackRate;

    state.bilibili.sourceUrl = sourceUrl;
    state.bilibili.bvid = parseBilibiliBvid(sourceUrl) || state.bilibili.bvid;
    state.bilibili.currentTime = Math.max(0, currentTime);
    if (duration !== null) {
        state.bilibili.duration = duration;
    } else if (sourceChanged) {
        state.bilibili.duration = null;
    }
    state.bilibili.paused = !!paused;
    state.bilibili.playbackRate = playbackRate;
    state.bilibili.startedAt = paused ? 0 : nowMs();
    state.bilibili.lastSyncReason = reason;

    return true;
}

export function reloadBilibiliEmbed(nextState, reason = 'sync') {
    const applied = setBilibiliSyntheticState(nextState, reason);
    if (!applied) return false;

    const iframe = getBilibiliEmbedIframe();
    if (!iframe) return false;

    iframe.src = buildBilibiliPlayerUrl(state.bilibili.sourceUrl, {
        currentTime: state.bilibili.currentTime,
        autoplay: !state.bilibili.paused,
    });

    updateBilibiliDockStatus();
    return true;
}

export function createBilibiliEmbed(input) {
    const playerUrl = buildBilibiliPlayerUrl(input, {
        currentTime: state.bilibili.currentTime,
        autoplay: !state.bilibili.paused,
    });
    if (!playerUrl) return null;

    removeBilibiliEmbed();

    state.bilibili.sourceUrl = input;
    state.bilibili.bvid = parseBilibiliBvid(input) || '';
    state.bilibili.currentTime = state.bilibili.currentTime || 0;
    state.bilibili.duration = null;
    state.bilibili.paused = true;
    state.bilibili.playbackRate = 1;
    state.bilibili.startedAt = 0;

    const dock = document.createElement('div');
    dock.id = 'bclt-bilibili-dock';
    dock.style.position = 'fixed';
    dock.style.left = '16px';
    dock.style.bottom = '16px';
    dock.style.zIndex = '99999';
    dock.style.width = '560px';
    dock.style.maxWidth = 'calc(100vw - 32px)';
    dock.style.background = 'rgba(15, 23, 42, 0.96)';
    dock.style.border = '1px solid rgba(255,255,255,0.18)';
    dock.style.borderRadius = '12px';
    dock.style.boxShadow = '0 16px 36px rgba(0,0,0,0.42)';
    dock.style.overflow = 'hidden';

    const header = document.createElement('div');
    header.textContent = 'Bilibili Embedded Player';
    header.style.padding = '10px 12px';
    header.style.font = '700 13px Segoe UI, Tahoma, sans-serif';
    header.style.color = '#f3f7ff';
    header.style.borderBottom = '1px solid rgba(255,255,255,0.12)';

    const controls = document.createElement('div');
    controls.style.display = 'grid';
    controls.style.gridTemplateColumns = 'repeat(5, minmax(0, 1fr))';
    controls.style.gap = '6px';
    controls.style.padding = '10px 12px 0';

    const makeButton = (label, handler, color = '#2563eb') => {
        const button = document.createElement('button');
        button.textContent = label;
        button.style.border = '0';
        button.style.borderRadius = '8px';
        button.style.padding = '8px 6px';
        button.style.cursor = 'pointer';
        button.style.font = '700 12px Segoe UI, Tahoma, sans-serif';
        button.style.background = color;
        button.style.color = '#fff';
        button.addEventListener('click', handler);
        return button;
    };

    const command = (action, value) => {
        bilibiliCommand(action, value);
    };

    controls.appendChild(makeButton('Play', () => command('play')));
    controls.appendChild(makeButton('Pause', () => command('pause'), '#475569'));
    controls.appendChild(makeButton('-10s', () => command('step', -10), '#7c3aed'));
    controls.appendChild(makeButton('+10s', () => command('step', 10), '#7c3aed'));
    controls.appendChild(makeButton('Sync Now', () => command('sync-now'), '#0f766e'));

    const timeBar = document.createElement('div');
    timeBar.style.display = 'grid';
    timeBar.style.gridTemplateColumns = '1fr auto';
    timeBar.style.gap = '8px';
    timeBar.style.padding = '10px 12px 0';

    const seekInput = document.createElement('input');
    seekInput.type = 'number';
    seekInput.min = '0';
    seekInput.step = '1';
    seekInput.placeholder = 'Seek seconds';
    seekInput.style.width = '100%';
    seekInput.style.boxSizing = 'border-box';
    seekInput.style.border = '1px solid rgba(255,255,255,0.18)';
    seekInput.style.borderRadius = '8px';
    seekInput.style.padding = '8px 10px';
    seekInput.style.background = 'rgba(255,255,255,0.08)';
    seekInput.style.color = '#fff';

    const seekButton = document.createElement('button');
    seekButton.textContent = 'Seek';
    seekButton.style.border = '0';
    seekButton.style.borderRadius = '8px';
    seekButton.style.padding = '8px 12px';
    seekButton.style.cursor = 'pointer';
    seekButton.style.font = '700 12px Segoe UI, Tahoma, sans-serif';
    seekButton.style.background = '#0f766e';
    seekButton.style.color = '#fff';
    seekButton.addEventListener('click', () => {
        command('seek', Number(seekInput.value || 0));
    });

    timeBar.appendChild(seekInput);
    timeBar.appendChild(seekButton);

    const statusLine = document.createElement('div');
    statusLine.id = 'bclt-bilibili-status';
    statusLine.style.padding = '8px 12px 0';
    statusLine.style.color = 'rgba(243, 247, 255, 0.92)';
    statusLine.style.font = '12px Segoe UI, Tahoma, sans-serif';
    statusLine.textContent = 'Paused @ 0:00';

    const iframe = document.createElement('iframe');
    iframe.src = playerUrl;
    iframe.allow = 'autoplay; fullscreen; picture-in-picture';
    iframe.referrerPolicy = 'no-referrer-when-downgrade';
    iframe.style.display = 'block';
    iframe.style.width = '100%';
    iframe.style.aspectRatio = '16 / 9';
    iframe.style.border = '0';
    iframe.style.background = '#000';

    const footer = document.createElement('div');
    footer.textContent = 'Visible Bilibili iframe player. Playback sync for cross-origin iframe is limited unless the platform exposes a player API.';
    footer.style.padding = '8px 12px 10px';
    footer.style.color = 'rgba(243, 247, 255, 0.82)';
    footer.style.font = '12px Segoe UI, Tahoma, sans-serif';

    dock.appendChild(header);
    dock.appendChild(controls);
    dock.appendChild(timeBar);
    dock.appendChild(statusLine);
    dock.appendChild(iframe);
    dock.appendChild(footer);
    document.body.appendChild(dock);

    state.embedFrame = dock;
    void hydrateBilibiliDuration(input).catch((error) => {
        console.warn('[BCLT] failed to hydrate Bilibili duration:', error);
    });
    return iframe;
}

export async function bilibiliCommand(action, value) {
    const current = computeBilibiliSyntheticState();
    switch (action) {
        case 'play':
            reloadBilibiliEmbed({ ...current, paused: false }, 'local-play');
            break;
        case 'pause':
            reloadBilibiliEmbed({ ...current, paused: true }, 'local-pause');
            break;
        case 'seek':
            reloadBilibiliEmbed({ ...current, currentTime: Math.max(0, Number(value) || 0) }, 'local-seek');
            break;
        case 'step':
            reloadBilibiliEmbed({ ...current, currentTime: Math.max(0, current.currentTime + (Number(value) || 0)) }, 'local-step');
            break;
        case 'sync-now':
            reloadBilibiliEmbed(current, 'manual-sync');
            break;
        default:
            break;
    }

    await notifyLocalChange();
}

export function applyBilibiliRemoteSync(nextState, reason = 'remote-sync') {
    const sourceUrl = nextState.sourceUrl || state.bilibili.sourceUrl || state.settings.mediaUrl;
    if (!sourceUrl) return false;

    if (!getBilibiliEmbedIframe()) {
        // Legacy floating Bilibili dock is deprecated; skip remote-sync fallback.
        return false;
    }

    const current = computeBilibiliSyntheticState();
    const incomingTime = Number.isFinite(Number(nextState.currentTime)) ? Number(nextState.currentTime) : current.currentTime;
    const incomingPaused = typeof nextState.paused === 'boolean' ? nextState.paused : current.paused;
    const incomingRate = Number.isFinite(Number(nextState.playbackRate)) && Number(nextState.playbackRate) > 0
        ? Number(nextState.playbackRate)
        : current.playbackRate;
    const thresholdSeconds = Math.max(0.1, Number(state.settings.driftThresholdMs || 800) / 1000);
    const driftSeconds = Math.abs(incomingTime - current.currentTime);
    const sourceChanged = sourceUrl !== current.sourceUrl;
    const pausedChanged = incomingPaused !== current.paused;
    const rateChanged = incomingRate !== current.playbackRate;
    const shouldReload = sourceChanged || pausedChanged || rateChanged || driftSeconds > thresholdSeconds;

    if (shouldReload) {
        return reloadBilibiliEmbed({
            sourceUrl,
            currentTime: incomingTime,
            duration: nextState.duration,
            paused: incomingPaused,
            playbackRate: incomingRate,
        }, reason);
    }

    const incomingDuration = Number.isFinite(Number(nextState.duration)) && Number(nextState.duration) > 0
        ? Math.max(1, Math.floor(Number(nextState.duration)))
        : null;

    state.bilibili.sourceUrl = sourceUrl;
    state.bilibili.bvid = parseBilibiliBvid(sourceUrl) || state.bilibili.bvid;
    state.bilibili.currentTime = Math.max(0, incomingTime);
    if (incomingDuration !== null) {
        state.bilibili.duration = incomingDuration;
    }
    state.bilibili.paused = incomingPaused;
    state.bilibili.playbackRate = incomingRate;
    state.bilibili.startedAt = incomingPaused ? 0 : nowMs();
    state.bilibili.lastSyncReason = reason;

    if (incomingDuration === null && sourceChanged) {
        state.bilibili.duration = null;
        void hydrateBilibiliDuration(sourceUrl).catch((error) => {
            console.warn('[BCLT] failed to hydrate Bilibili duration:', error);
        });
    }

    updateBilibiliDockStatus();
    return true;
}
