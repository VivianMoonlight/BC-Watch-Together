export function parseYouTubeVideoId(input) {
    if (!input) return null;
    const text = String(input).trim();
    if (!text) return null;

    const directMatch = text.match(/^[a-zA-Z0-9_-]{11}$/);
    if (directMatch) return directMatch[0];

    try {
        const url = new URL(text);
        const host = url.hostname.toLowerCase();

        if (host === 'youtu.be') {
            const id = url.pathname.replace(/^\//, '').split('/')[0];
            return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
        }

        if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
            const byQuery = url.searchParams.get('v');
            if (byQuery && /^[a-zA-Z0-9_-]{11}$/.test(byQuery)) return byQuery;

            const parts = url.pathname.split('/').filter(Boolean);
            const markerIndex = parts.findIndex((part) => ['embed', 'shorts', 'live', 'v'].includes(part));
            if (markerIndex >= 0) {
                const id = parts[markerIndex + 1] || '';
                return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
            }
        }
    } catch (error) {
        // Ignore URL parse errors.
    }

    const fuzzyMatch = text.match(/(?:v=|\/embed\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return fuzzyMatch ? fuzzyMatch[1] : null;
}

export function isYouTubeUrl(input) {
    if (!input) return false;
    return /youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(String(input));
}

function readStartSeconds(input) {
    try {
        const url = new URL(String(input || '').trim());
        const raw = url.searchParams.get('t') || url.searchParams.get('start') || '';
        if (!raw) return 1;
        const seconds = Number(String(raw).replace(/s$/i, ''));
        return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 1;
    } catch (error) {
        return 1;
    }
}

export function normalizeYouTubeSourceUrl(input) {
    const text = String(input || '').trim();
    if (!text) return '';

    const id = parseYouTubeVideoId(text);
    if (!id) return text;

    const url = new URL('https://www.youtube.com/watch');
    url.searchParams.set('v', id);
    const start = readStartSeconds(text);
    url.searchParams.set('t', String(Math.max(1, start)));
    return url.toString();
}

export function buildYouTubePlayerUrl(input, options = {}) {
    const { currentTime = 0, autoplay = false } = options;
    const id = parseYouTubeVideoId(input);
    if (!id) return null;

    const targetTime = Math.max(1, Math.floor(Number(currentTime) || 0));
    const params = new URLSearchParams({
        autoplay: autoplay ? '1' : '0',
        start: String(targetTime),
        rel: '0',
        modestbranding: '1',
        playsinline: '1',
    });

    return `https://www.youtube.com/embed/${id}?${params.toString()}`;
}

export function buildYouTubeWatchUrl(input, currentTime = 0, { autoplay = true } = {}) {
    const id = parseYouTubeVideoId(input);
    if (!id) return null;

    const url = new URL('https://www.youtube.com/watch');
    url.searchParams.set('v', id);
    url.searchParams.set('t', String(Math.max(1, Math.floor(Number(currentTime) || 0))));
    if (autoplay) {
        url.searchParams.set('autoplay', '1');
    }
    return url.toString();
}

const YOUTUBE_METADATA_API = 'https://yt.lemnoslife.com/noKey/videos';
const INVIDIOUS_INSTANCES_API = 'https://api.invidious.io/instances.json?sort_by=health';
const INVIDIOUS_FALLBACK_HOSTS = [
    'https://inv.thepixora.com',
    'https://invidious.privacyredirect.com',
    'https://invidious.jing.rocks',
];
const titleByVideoId = new Map();
const durationByVideoId = new Map();
const metadataPromiseByVideoId = new Map();
let invidiousHostsPromise = null;

async function fetchJsonWithTimeout(url, timeoutMs = 8000) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller
        ? window.setTimeout(() => controller.abort(), timeoutMs)
        : 0;

    try {
        const response = await fetch(url, {
            method: 'GET',
            mode: 'cors',
            credentials: 'omit',
            signal: controller ? controller.signal : undefined,
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return await response.json();
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

function parseIso8601DurationToSeconds(input) {
    const text = String(input || '').trim();
    if (!text) return null;

    const match = text.match(/^P(?:([0-9]+)D)?T?(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)S)?$/i);
    if (!match) return null;

    const days = Number(match[1] || 0);
    const hours = Number(match[2] || 0);
    const minutes = Number(match[3] || 0);
    const seconds = Number(match[4] || 0);
    const total = (days * 86400) + (hours * 3600) + (minutes * 60) + seconds;
    return Number.isFinite(total) && total > 0 ? Math.floor(total) : null;
}

function readMetadataFromNoKeyPayload(payload) {
    const item = Array.isArray(payload?.items) ? payload.items[0] : null;
    if (!item) return { title: null, duration: null };

    const title = String(item?.snippet?.title || '').trim() || null;
    const duration = parseIso8601DurationToSeconds(item?.contentDetails?.duration);
    return { title, duration };
}

async function fetchYouTubeTitleViaOEmbed(videoId) {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
    const response = await fetch(endpoint, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    return String(payload?.title || '').trim() || null;
}

async function getInvidiousHosts() {
    if (!invidiousHostsPromise) {
        invidiousHostsPromise = (async () => {
            try {
                const payload = await fetchJsonWithTimeout(INVIDIOUS_INSTANCES_API, 7000);
                if (!Array.isArray(payload)) {
                    return [...INVIDIOUS_FALLBACK_HOSTS];
                }

                const discovered = payload
                    .map((row) => {
                        const host = row && row[0] ? String(row[0]) : '';
                        const meta = row && row[1] && typeof row[1] === 'object' ? row[1] : null;
                        const isHttps = !!meta && meta.type === 'https';
                        const hasApi = !!meta && meta.api === true;
                        if (!host || !isHttps || !hasApi) return '';
                        return `https://${host}`;
                    })
                    .filter(Boolean);

                const unique = Array.from(new Set([...discovered, ...INVIDIOUS_FALLBACK_HOSTS]));
                return unique.length ? unique : [...INVIDIOUS_FALLBACK_HOSTS];
            } catch (error) {
                return [...INVIDIOUS_FALLBACK_HOSTS];
            }
        })();
    }

    return invidiousHostsPromise;
}

async function fetchYouTubeMetadataViaInvidious(videoId) {
    const hosts = await getInvidiousHosts();
    const cappedHosts = hosts.slice(0, 6);

    for (const host of cappedHosts) {
        try {
            const endpoint = `${host}/api/v1/videos/${encodeURIComponent(videoId)}`;
            const payload = await fetchJsonWithTimeout(endpoint, 7000);
            const title = String(payload?.title || '').trim() || null;
            const duration = Number(payload?.lengthSeconds);
            return {
                title,
                duration: Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : null,
            };
        } catch (error) {
            // Try next instance.
        }
    }

    return { title: null, duration: null };
}

export async function fetchYouTubeMetadataByVideoId(input) {
    const videoId = parseYouTubeVideoId(input);
    if (!videoId) {
        return { title: null, duration: null };
    }

    if (titleByVideoId.has(videoId) && durationByVideoId.has(videoId)) {
        return {
            title: titleByVideoId.get(videoId),
            duration: durationByVideoId.get(videoId),
        };
    }

    if (metadataPromiseByVideoId.has(videoId)) {
        return metadataPromiseByVideoId.get(videoId);
    }

    const task = (async () => {
        let title = titleByVideoId.get(videoId) || null;
        let duration = durationByVideoId.get(videoId) || null;

        try {
            const endpoint = `${YOUTUBE_METADATA_API}?part=snippet,contentDetails&id=${encodeURIComponent(videoId)}`;
            const payload = await fetchJsonWithTimeout(endpoint, 7000);
            const parsed = readMetadataFromNoKeyPayload(payload);
            if (parsed.title) title = parsed.title;
            if (Number.isFinite(parsed.duration) && parsed.duration > 0) duration = parsed.duration;
        } catch (error) {
            // Primary endpoint is optional; continue with fallbacks.
        }

        if (!title || !duration) {
            try {
                const fallback = await fetchYouTubeMetadataViaInvidious(videoId);
                if (!title && fallback.title) title = fallback.title;
                if ((!duration || duration <= 0) && Number.isFinite(fallback.duration) && fallback.duration > 0) {
                    duration = Math.floor(fallback.duration);
                }
            } catch (error) {
                // Ignore and continue.
            }
        }

        if (!title) {
            try {
                title = await fetchYouTubeTitleViaOEmbed(videoId);
            } catch (error) {
                // Keep title null and use fallback label on caller side.
            }
        }

        if (title) titleByVideoId.set(videoId, title);
        if (Number.isFinite(duration) && duration > 0) durationByVideoId.set(videoId, Math.floor(duration));

        return {
            title: title || null,
            duration: Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : null,
        };
    })();

    metadataPromiseByVideoId.set(videoId, task);
    try {
        return await task;
    } finally {
        metadataPromiseByVideoId.delete(videoId);
    }
}

export async function fetchYouTubeTitleByVideoId(input) {
    const videoId = parseYouTubeVideoId(input);
    if (!videoId) return '';

    if (titleByVideoId.has(videoId)) {
        return titleByVideoId.get(videoId);
    }

    const metadata = await fetchYouTubeMetadataByVideoId(videoId);
    return metadata.title || '';
}

export async function fetchYouTubeDurationByVideoId(input) {
    const videoId = parseYouTubeVideoId(input);
    if (!videoId) return null;

    if (durationByVideoId.has(videoId)) {
        return durationByVideoId.get(videoId);
    }

    const metadata = await fetchYouTubeMetadataByVideoId(videoId);
    return Number.isFinite(metadata.duration) && metadata.duration > 0
        ? Math.floor(metadata.duration)
        : null;
}
