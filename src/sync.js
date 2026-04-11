import { applyBilibiliRemoteSync } from './bilibili.js';
import { getCurrentMediaElement, readLocalMediaState } from './media.js';
import { CHANNEL_PREFIX, effectiveDisplayName, logStatus, memberId, nowMs, saveSettings, state } from './state.js';

const HARDWIRED_SUPABASE_URL = 'https://ikzntirwphumwkekflek.supabase.co';
const HARDWIRED_SUPABASE_ANON_KEY = 'sb_publishable_0cwF0A-zVDkg0IGRQYrUSQ_nEIPsFBU';
let lastPasscodeMismatchWarnAt = 0;
let hostOfflineFallbackInFlight = false;
let hostOfflineFallbackLastAttemptAt = 0;
let joinSessionNonce = 0;

const HOST_OFFLINE_FALLBACK_MS = 30000;
const HOST_FALLBACK_ACTIVE_WINDOW_MS = 60000;
const HOST_FALLBACK_COOLDOWN_MS = 12000;
const ACTIVE_MEMBER_WINDOW_MS = 60 * 1000;
const ROOM_ORPHAN_CLEANUP_MS = 90 * 1000;

function buildChannelTopicRoomPart(roomId) {
    const raw = String(roomId || '').trim();
    if (!raw) return 'room';
    // Keep channel topic ASCII-safe to avoid provider-side topic parsing issues.
    return encodeURIComponent(raw).replace(/%/g, '_');
}

function parseTimestampMs(value) {
    const ts = new Date(value || '').getTime();
    return Number.isFinite(ts) ? ts : NaN;
}

function isRecentActivity(lastSeenAt, activeWindowMs = ACTIVE_MEMBER_WINDOW_MS) {
    const ts = parseTimestampMs(lastSeenAt);
    if (!Number.isFinite(ts)) return false;
    return ts >= Date.now() - Math.max(5000, Number(activeWindowMs) || ACTIVE_MEMBER_WINDOW_MS);
}

function shouldCleanupOrphanRoom(room) {
    const updatedAtMs = parseTimestampMs(room?.updated_at) || parseTimestampMs(room?.created_at);
    if (!Number.isFinite(updatedAtMs)) return false;
    return Date.now() - updatedAtMs > ROOM_ORPHAN_CLEANUP_MS;
}

const SUPABASE_UMD_URLS = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
    'https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.min.js',
];

function appendScript(url) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.async = false;
        script.crossOrigin = 'anonymous';
        script.onload = () => {
            script.remove();
            resolve();
        };
        script.onerror = () => {
            script.remove();
            reject(new Error(`Failed to load ${url}`));
        };
        document.head.appendChild(script);
    });
}

async function ensureSupabaseRuntime() {
    if (globalThis.supabase && typeof globalThis.supabase.createClient === 'function') {
        return globalThis.supabase;
    }

    for (const url of SUPABASE_UMD_URLS) {
        try {
            await appendScript(url);
            if (globalThis.supabase && typeof globalThis.supabase.createClient === 'function') {
                return globalThis.supabase;
            }
        } catch (error) {
            console.warn('[BCWT] Failed to load Supabase runtime from', url, error);
        }
    }

    throw new Error('Supabase runtime failed to load from all sources.');
}

export async function getSupabaseClient() {
    if (state.supabase) return state.supabase;

    const supabaseRuntime = await ensureSupabaseRuntime();
    state.supabase = supabaseRuntime.createClient(HARDWIRED_SUPABASE_URL, HARDWIRED_SUPABASE_ANON_KEY, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
        realtime: {
            params: {
                eventsPerSecond: 8,
            },
        },
    });
    return state.supabase;
}

export function buildEnvelope(type, payload) {
    state.seq += 1;
    return {
        type,
        version: 1,
        roomId: state.settings.roomId,
        roomPasscode: state.settings.roomPasscode,
        senderId: memberId(),
        senderName: effectiveDisplayName(),
        seq: state.seq,
        clientTs: nowMs(),
        payload,
    };
}

export async function publish(type, payload) {
    if (!state.connected || !state.channel) return;
    if (type === 'media_state' && state.settings.syncPlaybackProgress === false) return;

    let normalizedPayload = payload;
    if (type === 'media_state' && payload && typeof payload === 'object') {
        normalizedPayload = {
            ...payload,
            syncProgress: !!state.settings.syncPlaybackProgress,
            playbackMode: state.settings.playbackMode || 'list',
        };
    }

    if (type === 'video_shared') {
        const eventPayload = {
            ...normalizedPayload,
            roomId: state.settings.roomId,
            roomPasscode: state.settings.roomPasscode,
            senderId: memberId(),
            senderName: effectiveDisplayName(),
            clientTs: nowMs(),
        };

        await state.channel.send({
            type: 'broadcast',
            event: 'video_shared',
            payload: eventPayload,
        });
        return;
    }

    const envelope = buildEnvelope(type, normalizedPayload);
    await state.channel.send({
        type: 'broadcast',
        event: 'sync',
        payload: envelope,
    });
}

export function shouldIgnoreEnvelope(envelope) {
    if (!envelope || envelope.roomId !== state.settings.roomId) return true;
    if (envelope.roomPasscode !== state.settings.roomPasscode) {
        const now = nowMs();
        if (now - lastPasscodeMismatchWarnAt > 5000) {
            lastPasscodeMismatchWarnAt = now;
            logStatus('Room passcode mismatch detected. Please leave and rejoin the room.');
        }
        return true;
    }
    if (envelope.senderId === memberId()) return true;
    return false;
}

export async function applyRemoteSync(envelope) {
    if (shouldIgnoreEnvelope(envelope)) return;

    const payload = envelope.payload || {};

    if (envelope.type === 'media_state'
        && (state.settings.syncPlaybackProgress === false || payload.syncProgress === false)) {
        return;
    }

    if (envelope.type === 'playlist_request' && state.onRemotePlaylistRequest) {
        const handled = await state.onRemotePlaylistRequest(payload, envelope);
        if (handled) return;
    }

    if (envelope.type === 'playlist_state' && state.onRemotePlaylistState) {
        const handled = await state.onRemotePlaylistState(payload, envelope);
        if (handled) return;
    }

    if (envelope.type === 'media_state' && state.onRemoteMediaState) {
        const handled = await state.onRemoteMediaState(payload, envelope);
        if (handled) return;
    }

    if (envelope.type === 'room_control' && state.onRemoteRoomControl) {
        const handled = await state.onRemoteRoomControl(payload, envelope);
        if (handled) return;
    }

    if (payload.mediaKind === 'bilibili' || state.embedFrame) {
        const applied = applyBilibiliRemoteSync({
            sourceUrl: payload.sourceUrl || state.settings.mediaUrl || state.bilibili.sourceUrl,
            currentTime: payload.currentTime,
            duration: payload.duration,
            paused: payload.paused,
            playbackRate: payload.playbackRate,
        }, 'remote-sync');

        if (applied) {
            logStatus(`Synced Bilibili from ${envelope.senderName || envelope.senderId}`);
            return;
        }
    }

    const media = getCurrentMediaElement();
    if (!media) {
        logStatus('No media element found on page.');
        return;
    }

    state.remoteGuardUntil = nowMs() + 600;

    if (envelope.type === 'media_state') {
        const p = payload;
        const targetTime = Number(p.currentTime || 0);
        const localTime = Number(media.currentTime || 0);
        const driftMs = Math.abs(targetTime - localTime) * 1000;

        if (Number.isFinite(p.playbackRate) && p.playbackRate > 0 && media.playbackRate !== p.playbackRate) {
            media.playbackRate = p.playbackRate;
        }

        if (driftMs > Number(state.settings.driftThresholdMs || 800)) {
            media.currentTime = targetTime;
        }

        if (typeof p.paused === 'boolean') {
            if (p.paused && !media.paused) {
                await media.pause();
            }
            if (!p.paused && media.paused) {
                try {
                    await media.play();
                } catch (error) {
                    console.warn('[BCLT] media.play() blocked:', error);
                }
            }
        }

        logStatus(`Synced from ${envelope.senderName || envelope.senderId}`);
    }
}

export async function syncSnapshotToTable(client) {
    const mediaState = readLocalMediaState();
    if (!mediaState) return;

    const mediaSrc = mediaState.sourceUrl || mediaState.src || null;

    const row = {
        room_id: state.settings.roomId,
        room_passcode: state.settings.roomPasscode,
        host_member_id: memberId(),
        media_src: mediaSrc,
        media_current_time: mediaState.currentTime,
        paused: mediaState.paused,
        playback_rate: mediaState.playbackRate,
        seq: state.seq,
        updated_at: new Date().toISOString(),
    };

    const { error } = await client.from('bclt_room_states').upsert(row, { onConflict: 'room_id' });
    if (error) {
        console.warn('[BCLT] upsert room state failed:', error.message);
    }

    await touchRoom(client);
}

async function touchRoom(client) {
    const { error } = await client
        .from('bclt_rooms')
        .update({ updated_at: new Date().toISOString() })
        .eq('room_id', state.settings.roomId);

    if (error) {
        console.warn('[BCLT] touch room failed:', error.message);
    }
}

async function upsertRoomMember(client) {
    const row = {
        room_id: state.settings.roomId,
        member_id: memberId(),
        display_name: effectiveDisplayName(),
        is_host: !!state.settings.isHost,
        last_seen_at: new Date().toISOString(),
    };

    const { error } = await client.from('bclt_room_members').upsert(row, { onConflict: 'room_id,member_id' });
    if (error) {
        console.warn('[BCLT] upsert room member failed:', error.message);
    }
}

async function deleteRoomCascade(client, roomId) {
    const normalizedRoomId = String(roomId || '').trim();
    if (!normalizedRoomId) return false;

    const { error: clearMembersError } = await client
        .from('bclt_room_members')
        .delete()
        .eq('room_id', normalizedRoomId);
    if (clearMembersError) {
        console.warn('[BCLT] delete room members failed:', clearMembersError.message);
        return false;
    }

    const { error: clearStateError } = await client
        .from('bclt_room_states')
        .delete()
        .eq('room_id', normalizedRoomId);
    if (clearStateError) {
        console.warn('[BCLT] delete room state failed:', clearStateError.message);
    }

    const { error: deleteRoomError } = await client
        .from('bclt_rooms')
        .delete()
        .eq('room_id', normalizedRoomId);
    if (deleteRoomError) {
        console.warn('[BCLT] delete room failed:', deleteRoomError.message);
        return false;
    }

    return true;
}

async function cleanupRoomIfNoActiveMembers(client, roomId, activeWindowMs = ACTIVE_MEMBER_WINDOW_MS) {
    const normalizedRoomId = String(roomId || '').trim();
    if (!normalizedRoomId) return false;

    const { data: members, error: membersError } = await client
        .from('bclt_room_members')
        .select('member_id, last_seen_at')
        .eq('room_id', normalizedRoomId);

    if (membersError) {
        console.warn('[BCLT] read room members for cleanup failed:', membersError.message);
        return false;
    }

    const rows = Array.isArray(members) ? members : [];
    const hasActiveMember = rows.some((row) => isRecentActivity(row.last_seen_at, activeWindowMs));
    if (hasActiveMember) {
        return false;
    }

    return deleteRoomCascade(client, normalizedRoomId);
}

async function cleanupOrphanRooms(client, rooms, activeMemberCounts) {
    if (!Array.isArray(rooms) || rooms.length === 0) return;

    const candidates = rooms
        .filter((room) => (activeMemberCounts.get(room.room_id) || 0) === 0)
        .filter((room) => shouldCleanupOrphanRoom(room))
        .map((room) => room.room_id)
        .filter((id) => !!String(id || '').trim())
        .slice(0, 8);

    for (const roomId of candidates) {
        await cleanupRoomIfNoActiveMembers(client, roomId, ACTIVE_MEMBER_WINDOW_MS);
    }
}

export async function createRoomRecord() {
    if (!state.settings.roomId) {
        throw new Error('Missing room ID');
    }

    const client = await getSupabaseClient();
    const nowIso = new Date().toISOString();
    const normalizedPasscode = String(state.settings.roomPasscode || '').trim();
    state.settings.roomPasscode = normalizedPasscode;

    const roomRow = {
        room_id: state.settings.roomId,
        room_passcode: normalizedPasscode,
        host_member_id: memberId(),
        created_by: effectiveDisplayName(),
        updated_at: nowIso,
    };

    const { error: roomError } = await client.from('bclt_rooms').insert(roomRow);
    if (roomError) {
        const normalizedCode = String(roomError.code || '');
        if (normalizedCode === '23505') {
            const { data: existingMembers, error: existingMembersError } = await client
                .from('bclt_room_members')
                .select('member_id, last_seen_at')
                .eq('room_id', state.settings.roomId);

            if (existingMembersError) {
                throw new Error(`Create room failed: ${existingMembersError.message}`);
            }

            const rows = Array.isArray(existingMembers) ? existingMembers : [];
            const hasActiveMember = rows.some((row) => isRecentActivity(row.last_seen_at, ACTIVE_MEMBER_WINDOW_MS));
            if (hasActiveMember) {
                throw new Error('Room name already exists. Please choose another room name.');
            }

            const { error: clearMembersError } = await client
                .from('bclt_room_members')
                .delete()
                .eq('room_id', state.settings.roomId);

            if (clearMembersError) {
                throw new Error(`Replace empty room failed: ${clearMembersError.message}`);
            }

            const { error: replaceRoomError } = await client.from('bclt_rooms').upsert(roomRow, { onConflict: 'room_id' });
            if (replaceRoomError) {
                throw new Error(`Replace empty room failed: ${replaceRoomError.message}`);
            }
        } else {
            throw new Error(`Create room failed: ${roomError.message}`);
        }
    }

    const roomStateRow = {
        room_id: state.settings.roomId,
        room_passcode: normalizedPasscode,
        host_member_id: memberId(),
        media_src: null,
        media_current_time: 0,
        paused: true,
        playback_rate: 1,
        seq: state.seq,
        updated_at: nowIso,
    };

    const { error: roomStateError } = await client.from('bclt_room_states').upsert(roomStateRow, { onConflict: 'room_id' });
    if (roomStateError) {
        throw new Error(`Create room state failed: ${roomStateError.message}`);
    }

    await upsertRoomMember(client);
}

export async function fetchAvailableRooms() {
    const client = await getSupabaseClient();

    const { data: rooms, error } = await client
        .from('bclt_rooms')
        .select('room_id, room_passcode, host_member_id, created_by, updated_at, created_at')
        .order('updated_at', { ascending: false })
        .limit(50);

    if (error) {
        throw new Error(`Load rooms failed: ${error.message}`);
    }

    const roomIds = (rooms || []).map((room) => room.room_id);
    const memberCounts = new Map();
    const hostDisplayNames = new Map();

    if (roomIds.length > 0) {
        const { data: members, error: memberError } = await client
            .from('bclt_room_members')
            .select('room_id, member_id, display_name, is_host, last_seen_at')
            .in('room_id', roomIds);

        if (!memberError && members) {
            members.forEach((m) => {
                if (!isRecentActivity(m.last_seen_at, ACTIVE_MEMBER_WINDOW_MS)) return;
                memberCounts.set(m.room_id, (memberCounts.get(m.room_id) || 0) + 1);
                if (m.is_host && m.display_name && !hostDisplayNames.has(m.room_id)) {
                    hostDisplayNames.set(m.room_id, m.display_name);
                }
            });
        }
    }

    await cleanupOrphanRooms(client, rooms || [], memberCounts);

    return (rooms || [])
        .filter((room) => (memberCounts.get(room.room_id) || 0) > 0)
        .map((room) => {
        const roomLabel = String(room.room_id || '').trim() || 'Unnamed Room';
        const hostName = hostDisplayNames.get(room.room_id) || room.created_by || room.host_member_id;
        const isLocked = !!String(room.room_passcode || '').trim();
        return {
            id: room.room_id,
            roomName: roomLabel,
            displayName: roomLabel,
            name: roomLabel,
            members: memberCounts.get(room.room_id) || 0,
            hostMemberId: room.host_member_id,
            host: hostName,
            isLocked,
            updatedAt: room.updated_at,
        };
    });
}

export async function fetchCurrentRoomPlaybackState() {
    if (!state.settings.roomId) return null;

    const client = await getSupabaseClient();
    const { data, error } = await client
        .from('bclt_room_states')
        .select('room_id, room_passcode, media_src, media_current_time, paused, playback_rate, seq, updated_at')
        .eq('room_id', state.settings.roomId)
        .maybeSingle();

    if (error) {
        throw new Error(`Load room playback state failed: ${error.message}`);
    }

    const normalizedPasscode = String(state.settings.roomPasscode || '').trim();
    const requiredPasscode = String((data && data.room_passcode) || '').trim();
    if (!data) return null;
    if (requiredPasscode && requiredPasscode !== normalizedPasscode) return null;
    if (!data.media_src) return null;

    return {
        sourceUrl: data.media_src,
        currentTime: Number(data.media_current_time || 0),
        paused: !!data.paused,
        playbackRate: Number(data.playback_rate || 1),
        seq: Number(data.seq || 0),
        updatedAt: data.updated_at,
    };
}

export async function joinRoom() {
    if (!state.settings.roomId) {
        alert('Please select a room.');
        return;
    }

    try {
        const sessionNonce = ++joinSessionNonce;
        const client = await getSupabaseClient();

        if (state.channel && state.supabase) {
            try {
                await state.supabase.removeChannel(state.channel);
            } catch (error) {
                console.warn('[BCLT] pre-join removeChannel failed:', error);
            }
        }
        state.channel = null;
        state.connected = false;

        const { data: roomRecord, error: roomError } = await client
            .from('bclt_rooms')
            .select('room_id, room_passcode, host_member_id')
            .eq('room_id', state.settings.roomId)
            .maybeSingle();

        if (roomError) {
            throw new Error(`Read room failed: ${roomError.message}`);
        }

        if (!roomRecord) {
            throw new Error('Room does not exist. Please refresh and create or select an existing room.');
        }

        const normalizedPasscode = String(state.settings.roomPasscode || '').trim();
        const requiredPasscode = String((roomRecord && roomRecord.room_passcode) || '').trim();
        if (requiredPasscode && requiredPasscode !== normalizedPasscode) {
            throw new Error('Incorrect room passcode.');
        }

        const roomHostId = roomRecord && roomRecord.host_member_id ? String(roomRecord.host_member_id) : '';
        state.settings.roomHostMemberId = roomHostId;
        state.settings.isHost = roomHostId === memberId();

        const channelName = `${CHANNEL_PREFIX}${buildChannelTopicRoomPart(state.settings.roomId)}`;
        const channel = client.channel(channelName, {
            config: {
                broadcast: { self: false },
                presence: { key: memberId() },
            },
        });

        channel.on('broadcast', { event: 'sync' }, async ({ payload }) => {
            if (sessionNonce !== joinSessionNonce) return;
            await applyRemoteSync(payload);
        });

        channel.on('broadcast', { event: 'video_shared' }, async ({ payload }) => {
            if (sessionNonce !== joinSessionNonce) return;
            // Backward compatible: accept both direct payload and envelope payload.
            const normalized = payload && payload.payload && payload.type === 'video_shared'
                ? {
                    ...payload.payload,
                    roomId: payload.roomId,
                    roomPasscode: payload.roomPasscode,
                    senderId: payload.senderId,
                    senderName: payload.senderName,
                    clientTs: payload.clientTs,
                }
                : payload;

            if (!normalized) return;
            if (normalized.roomId && normalized.roomId !== state.settings.roomId) return;
            if (normalized.roomPasscode && normalized.roomPasscode !== state.settings.roomPasscode) return;
            if (normalized.senderId && normalized.senderId === memberId()) return;

            if (state.onRemoteVideoShared) {
                await state.onRemoteVideoShared(normalized);
            }
        });

        channel.on('presence', { event: 'sync' }, () => {
            if (sessionNonce !== joinSessionNonce) return;
            logStatus('Presence updated');
        });

        channel.subscribe(async (status) => {
            if (sessionNonce !== joinSessionNonce) return;
            if (status === 'SUBSCRIBED') {
                lastPasscodeMismatchWarnAt = 0;
                state.connected = true;
                state.channel = channel;

                await channel.track({
                    id: memberId(),
                    name: effectiveDisplayName(),
                    isHost: !!state.settings.isHost,
                    at: nowMs(),
                });

                await upsertRoomMember(client);

                logStatus(`Connected: ${channelName}`);

                if (state.onRoomConnected) {
                    try {
                        await state.onRoomConnected({ channelName });
                    } catch (error) {
                        console.warn('[BCLT] onRoomConnected failed:', error);
                    }
                }
            }
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                if (state.channel !== channel) return;
                state.connected = false;
                logStatus(`Channel status: ${status}`);
            }
        });

        startRuntimeLoops(client);
    } catch (error) {
        console.error('[BCLT] joinRoom failed:', error);
        logStatus(`Connect failed: ${error.message}`);
    }
}

export async function leaveRoom() {
    stopRuntimeLoops();
    lastPasscodeMismatchWarnAt = 0;

    const client = state.supabase || await getSupabaseClient();

    try {
        let hostTransferred = false;
        if (state.settings.roomId) {
            if (state.settings.isHost) {
                hostTransferred = await transferOwnershipOnHostLeave();
            }

            await removeCurrentMemberRecord(client);

            if (!hostTransferred) {
                await cleanupRoomIfNoActiveMembers(client, state.settings.roomId, ACTIVE_MEMBER_WINDOW_MS);
            }
        }
    } catch (error) {
        console.warn('[BCLT] leaveRoom ownership cleanup failed:', error);
    }

    if (state.channel && state.supabase) {
        try {
            await state.supabase.removeChannel(state.channel);
        } catch (error) {
            console.warn('[BCLT] removeChannel failed:', error);
        }
    }

    state.channel = null;
    state.connected = false;
    state.settings.isHost = false;
    state.settings.roomHostMemberId = '';
    state.roomAdminMemberIds = [];
    logStatus('Disconnected');
}

async function removeCurrentMemberRecord(client) {
    if (!state.settings.roomId) return;
    const { error } = await client
        .from('bclt_room_members')
        .delete()
        .eq('room_id', state.settings.roomId)
        .eq('member_id', memberId());

    if (error) {
        console.warn('[BCLT] remove current member failed:', error.message);
    }
}

export async function fetchRoomMembers(options = {}) {
    if (!state.settings.roomId) return [];

    const {
        includeStale = false,
        excludeSelf = false,
        activeWindowMs = 60 * 1000,
    } = options;

    const client = await getSupabaseClient();
    const { data, error } = await client
        .from('bclt_room_members')
        .select('room_id, member_id, display_name, is_host, last_seen_at')
        .eq('room_id', state.settings.roomId)
        .order('last_seen_at', { ascending: false });

    if (error) {
        throw new Error(`Load room members failed: ${error.message}`);
    }

    const staleCutoff = Date.now() - Math.max(5000, Number(activeWindowMs) || 60000);
    const selfId = memberId();

    return (Array.isArray(data) ? data : [])
        .filter((row) => {
            if (!includeStale) {
                const ts = new Date(row.last_seen_at).getTime();
                if (!Number.isFinite(ts) || ts < staleCutoff) return false;
            }
            if (excludeSelf && String(row.member_id) === selfId) return false;
            return true;
        })
        .map((row) => ({
            memberId: String(row.member_id),
            displayName: String(row.display_name || row.member_id),
            isHost: !!row.is_host,
            lastSeenAt: row.last_seen_at,
        }));
}

export async function transferRoomOwnership(nextHostMemberId, options = {}) {
    if (!state.settings.roomId) {
        throw new Error('Missing room ID');
    }

    const candidateId = String(nextHostMemberId || '').trim();
    if (!candidateId) {
        throw new Error('Missing target member ID');
    }

    if (!state.settings.isHost) {
        throw new Error('Only host can transfer room ownership');
    }

    const client = await getSupabaseClient();
    const members = await fetchRoomMembers({ includeStale: false });
    const target = members.find((m) => m.memberId === candidateId);
    if (!target) {
        throw new Error('Target member is not active in room');
    }

    const nowIso = new Date().toISOString();

    const { error: roomError } = await client
        .from('bclt_rooms')
        .update({
            host_member_id: candidateId,
            updated_at: nowIso,
        })
        .eq('room_id', state.settings.roomId);

    if (roomError) {
        throw new Error(`Transfer ownership failed: ${roomError.message}`);
    }

    const { error: roomStateError } = await client
        .from('bclt_room_states')
        .update({ host_member_id: candidateId, updated_at: nowIso })
        .eq('room_id', state.settings.roomId);

    if (roomStateError) {
        throw new Error(`Update room state host failed: ${roomStateError.message}`);
    }

    const { error: clearHostError } = await client
        .from('bclt_room_members')
        .update({ is_host: false })
        .eq('room_id', state.settings.roomId);

    if (clearHostError) {
        throw new Error(`Clear previous host failed: ${clearHostError.message}`);
    }

    const { error: setHostError } = await client
        .from('bclt_room_members')
        .update({ is_host: true, last_seen_at: nowIso })
        .eq('room_id', state.settings.roomId)
        .eq('member_id', candidateId);

    if (setHostError) {
        throw new Error(`Set new host failed: ${setHostError.message}`);
    }

    const explicitAdminIds = Array.isArray(options.adminMemberIds)
        ? options.adminMemberIds
        : state.roomAdminMemberIds;
    const nextAdminIds = explicitAdminIds
        .map((id) => String(id || '').trim())
        .filter((id) => !!id && id !== candidateId);

    await publish('room_control', {
        action: 'ownership_transferred',
        roomId: state.settings.roomId,
        previousHostMemberId: memberId(),
        newHostMemberId: candidateId,
        newHostDisplayName: target.displayName,
        adminMemberIds: nextAdminIds,
        at: Date.now(),
    });

    state.roomAdminMemberIds = nextAdminIds;
    state.settings.roomHostMemberId = candidateId;
    state.settings.isHost = false;
}

async function transferOwnershipOnHostLeave() {
    const candidates = await fetchRoomMembers({ includeStale: false, excludeSelf: true });
    if (candidates.length > 0) {
        const fallbackTarget = candidates[0];
        try {
            await transferRoomOwnership(fallbackTarget.memberId);
            return true;
        } catch (error) {
            console.warn('[BCLT] transfer ownership fallback failed:', error);
        }
    }
    return false;
}

function readMemberLastSeenMs(member) {
    const ts = new Date(member?.lastSeenAt || '').getTime();
    return Number.isFinite(ts) ? ts : NaN;
}

function sortFallbackCandidates(a, b) {
    const aIsAdmin = state.roomAdminMemberIds.includes(a.memberId) ? 1 : 0;
    const bIsAdmin = state.roomAdminMemberIds.includes(b.memberId) ? 1 : 0;
    if (aIsAdmin !== bIsAdmin) return bIsAdmin - aIsAdmin;
    if (a.lastSeenMs !== b.lastSeenMs) return b.lastSeenMs - a.lastSeenMs;
    return String(a.memberId).localeCompare(String(b.memberId));
}

async function maybePromoteSelfOnHostOffline(client) {
    if (state.settings.isHost) return;
    if (!state.settings.roomId || !state.connected || !state.channel) return;

    const now = Date.now();
    if (hostOfflineFallbackInFlight) return;
    if (now - hostOfflineFallbackLastAttemptAt < HOST_FALLBACK_COOLDOWN_MS) return;

    const currentHostId = String(state.settings.roomHostMemberId || '').trim();
    if (!currentHostId) return;

    hostOfflineFallbackInFlight = true;
    hostOfflineFallbackLastAttemptAt = now;
    try {
        const allMembers = await fetchRoomMembers({
            includeStale: true,
            excludeSelf: false,
            activeWindowMs: HOST_FALLBACK_ACTIVE_WINDOW_MS,
        });

        const hostMember = allMembers.find((member) => member.memberId === currentHostId);
        const hostLastSeenMs = readMemberLastSeenMs(hostMember);
        const hostLooksOffline = !hostMember
            || !Number.isFinite(hostLastSeenMs)
            || now - hostLastSeenMs > HOST_OFFLINE_FALLBACK_MS;
        if (!hostLooksOffline) return;

        const activeCutoff = now - HOST_FALLBACK_ACTIVE_WINDOW_MS;
        const activeCandidates = allMembers
            .map((member) => ({ ...member, lastSeenMs: readMemberLastSeenMs(member) }))
            .filter((member) => Number.isFinite(member.lastSeenMs) && member.lastSeenMs >= activeCutoff)
            .sort(sortFallbackCandidates);

        if (!activeCandidates.length) return;
        const electedCandidate = activeCandidates[0];
        if (!electedCandidate || electedCandidate.memberId !== memberId()) return;

        const selfId = memberId();
        const nowIso = new Date().toISOString();

        const { data: claimRows, error: claimError } = await client
            .from('bclt_rooms')
            .update({
                host_member_id: selfId,
                updated_at: nowIso,
            })
            .eq('room_id', state.settings.roomId)
            .eq('host_member_id', currentHostId)
            .select('room_id, host_member_id');

        if (claimError) {
            console.warn('[BCLT] host offline fallback claim failed:', claimError.message);
            return;
        }
        if (!Array.isArray(claimRows) || claimRows.length === 0) {
            return;
        }

        const { error: roomStateError } = await client
            .from('bclt_room_states')
            .update({ host_member_id: selfId, updated_at: nowIso })
            .eq('room_id', state.settings.roomId)
            .eq('host_member_id', currentHostId);
        if (roomStateError) {
            console.warn('[BCLT] host offline fallback room state update failed:', roomStateError.message);
        }

        const { error: clearHostError } = await client
            .from('bclt_room_members')
            .update({ is_host: false })
            .eq('room_id', state.settings.roomId);
        if (clearHostError) {
            console.warn('[BCLT] host offline fallback clear host flag failed:', clearHostError.message);
        }

        const { error: setHostError } = await client
            .from('bclt_room_members')
            .update({ is_host: true, last_seen_at: nowIso })
            .eq('room_id', state.settings.roomId)
            .eq('member_id', selfId);
        if (setHostError) {
            console.warn('[BCLT] host offline fallback set host flag failed:', setHostError.message);
        }

        state.settings.roomHostMemberId = selfId;
        state.settings.isHost = true;
        state.currentRoomHostName = effectiveDisplayName();
        state.roomAdminMemberIds = state.roomAdminMemberIds.filter((id) => String(id || '').trim() !== selfId);
        saveSettings();

        await publish('room_control', {
            action: 'ownership_transferred',
            roomId: state.settings.roomId,
            previousHostMemberId: currentHostId,
            newHostMemberId: selfId,
            newHostDisplayName: effectiveDisplayName(),
            adminMemberIds: [...state.roomAdminMemberIds],
            at: Date.now(),
        });

        logStatus('Host offline detected. Fallback promoted you to host.');
    } catch (error) {
        console.warn('[BCLT] host offline fallback failed:', error);
    } finally {
        hostOfflineFallbackInFlight = false;
    }
}

export function startRuntimeLoops(client) {
    stopRuntimeLoops();

    state.syncTimer = window.setInterval(async () => {
        if (!state.connected || !state.settings.isHost) return;
        if (state.settings.syncPlaybackProgress === false) return;
        const mediaState = readLocalMediaState();
        if (!mediaState) return;
        await publish('media_state', mediaState);
        await syncSnapshotToTable(client);
    }, 1000);

    state.heartbeatTimer = window.setInterval(async () => {
        if (!state.connected || !state.channel) return;
        await state.channel.track({
            id: memberId(),
            name: effectiveDisplayName(),
            isHost: !!state.settings.isHost,
            at: nowMs(),
        });

        await upsertRoomMember(client);

        if (state.settings.isHost) {
            await touchRoom(client);
        } else {
            await maybePromoteSelfOnHostOffline(client);
        }
    }, 10000);
}

export function stopRuntimeLoops() {
    if (state.syncTimer) {
        clearInterval(state.syncTimer);
        state.syncTimer = null;
    }
    if (state.heartbeatTimer) {
        clearInterval(state.heartbeatTimer);
        state.heartbeatTimer = null;
    }
}
