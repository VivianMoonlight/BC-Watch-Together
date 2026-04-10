export const STORAGE_KEY = 'bclt.settings.v1';
export const APP_ID = 'bclt-root';
export const CHANNEL_PREFIX = 'bclt-room-';

export const DEFAULT_SETTINGS = {
    language: 'zh',
    roomId: '',
    roomName: '',
    roomHostMemberId: '',
    roomPasscode: '',
    displayName: '',
    mediaUrl: '',
    isHost: false,
    driftThresholdMs: 800,
    syncPlaybackProgress: true,
    playbackMode: 'list',
    highQualityTabMode: false,
};

export const state = {
    settings: loadSettings(),
    supabase: null,
    channel: null,
    connected: false,
    currentRoomHostName: '',
    roomAdminMemberIds: [],
    seq: 0,
    remoteGuardUntil: 0,
    mediaEl: null,
    mediaCandidates: [],
    bilibili: {
        sourceUrl: '',
        bvid: '',
        currentTime: 0,
        duration: null,
        paused: true,
        playbackRate: 1,
        startedAt: 0,
        lastSyncReason: 'init',
    },
    embedFrame: null,
    heartbeatTimer: null,
    syncTimer: null,
    statusLogger: null,
    localChangeNotifier: null,
    onRemoteVideoShared: null,
    onRemoteMediaState: null,
    onRemotePlaylistState: null,
    onRemotePlaylistRequest: null,
    onRemoteRoomControl: null,
    onRoomConnected: null,
};

export function loadSettings() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULT_SETTINGS };
        const parsed = JSON.parse(raw);
        const { supabaseUrl, supabaseAnonKey, ...rest } = parsed || {};
        return { ...DEFAULT_SETTINGS, ...rest };
    } catch (error) {
        console.warn('[BCLT] loadSettings failed:', error);
        return { ...DEFAULT_SETTINGS };
    }
}

export function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
}

export function nowMs() {
    return Date.now();
}

export function memberId() {
    const player = window.Player;
    return player && player.MemberNumber ? String(player.MemberNumber) : 'unknown';
}

export function effectiveDisplayName() {
    if (window.Player && typeof window.Player.Nickname === 'string' && window.Player.Nickname.trim()) {
        return window.Player.Nickname.trim();
    }
    if (window.Player && typeof window.Player.Name === 'string' && window.Player.Name.trim()) {
        return window.Player.Name.trim();
    }
    if (state.settings.displayName && state.settings.displayName.trim()) return state.settings.displayName.trim();
    return `Member-${memberId()}`;
}

export function setStatusLogger(logger) {
    state.statusLogger = typeof logger === 'function' ? logger : null;
}

export function logStatus(text) {
    const el = document.querySelector('#bclt-status');
    if (el) el.textContent = text;
    console.log('[BCLT]', text);
    if (state.statusLogger) state.statusLogger(text);
}

export function setLocalChangeNotifier(notifier) {
    state.localChangeNotifier = typeof notifier === 'function' ? notifier : null;
}

export async function notifyLocalChange() {
    if (state.localChangeNotifier) {
        await state.localChangeNotifier();
    }
}
