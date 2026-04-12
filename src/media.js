import { createBilibiliEmbed, computeBilibiliSyntheticState, isBilibiliUrl, parseBilibiliBvid } from './bilibili.js';
import { isYouTubeUrl, parseYouTubeVideoId } from './youtube.js';
import { logStatus, nowMs, state } from './state.js';

export function describeMediaElement(el, index) {
    const tag = el.tagName.toLowerCase();
    const label = el.currentSrc || el.src || 'no-src';
    const duration = Number.isFinite(el.duration) ? `/${Math.round(el.duration)}s` : '';
    return `${index + 1}. ${tag} ${label}${duration}`;
}

export function discoverMediaElements() {
    const nodes = Array.from(document.querySelectorAll('video, audio'));
    return nodes.filter((node) => node instanceof HTMLMediaElement && document.contains(node));
}

export function updateMediaSelectOptions() {
    const select = document.querySelector('#bclt-media-select');
    if (!select) return;

    const previousValue = select.value;
    select.innerHTML = '';

    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = state.mediaCandidates.length ? 'Auto-detect media' : 'No media found';
    select.appendChild(emptyOption);

    state.mediaCandidates.forEach((el, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = describeMediaElement(el, index);
        select.appendChild(option);
    });

    if (state.mediaEl) {
        const selectedIndex = state.mediaCandidates.indexOf(state.mediaEl);
        select.value = selectedIndex >= 0 ? String(selectedIndex) : '';
    } else if (previousValue) {
        select.value = previousValue;
    }
}

export function refreshMediaCandidates() {
    state.mediaCandidates = discoverMediaElements();
    if (state.mediaCandidates.length > 0) {
        const current = state.mediaEl && state.mediaCandidates.includes(state.mediaEl) ? state.mediaEl : state.mediaCandidates[0];
        state.mediaEl = current;
    }
    updateMediaSelectOptions();
    return state.mediaCandidates;
}

export function selectMediaElementByIndex(index) {
    refreshMediaCandidates();
    if (Number.isInteger(index) && index >= 0 && index < state.mediaCandidates.length) {
        state.mediaEl = state.mediaCandidates[index];
        return state.mediaEl;
    }
    state.mediaEl = state.mediaCandidates[0] || null;
    return state.mediaEl;
}

export function ensureMediaElement() {
    if (state.mediaEl && document.contains(state.mediaEl)) return state.mediaEl;

    refreshMediaCandidates();
    if (state.mediaEl) return state.mediaEl;

    const mediaUrl = state.settings.mediaUrl && state.settings.mediaUrl.trim();
    if (!mediaUrl) return null;

    if (isBilibiliUrl(mediaUrl) || parseBilibiliBvid(mediaUrl) || isYouTubeUrl(mediaUrl) || parseYouTubeVideoId(mediaUrl)) {
        // Legacy floating Bilibili dock is deprecated; do not auto-create it.
        return null;
    }

    const created = document.createElement(mediaUrl.match(/\.(mp4|webm|ogg)(\?|#|$)/i) ? 'video' : 'audio');
    created.controls = true;
    created.preload = 'metadata';
    created.src = mediaUrl;
    created.style.display = 'none';
    created.dataset.bcltInjected = '1';
    document.body.appendChild(created);
    state.mediaEl = created;
    state.mediaCandidates = [created];
    updateMediaSelectOptions();
    return created;
}

export function getCurrentMediaElement() {
    return ensureMediaElement();
}

export function readLocalMediaState() {
    const roomModalVideo = document.querySelector('#bclt-player-container video');
    if (roomModalVideo instanceof HTMLMediaElement) {
        const synthetic = computeBilibiliSyntheticState();
        const sourceUrl = String(synthetic.sourceUrl || roomModalVideo.currentSrc || roomModalVideo.src || '');
        return {
            mediaKind: synthetic.mediaKind,
            sourceUrl,
            bvid: synthetic.bvid,
            videoId: synthetic.videoId,
            currentTime: Number.isFinite(Number(roomModalVideo.currentTime)) ? Number(roomModalVideo.currentTime) : 0,
            paused: !!roomModalVideo.paused,
            playbackRate: Number.isFinite(Number(roomModalVideo.playbackRate)) && Number(roomModalVideo.playbackRate) > 0
                ? Number(roomModalVideo.playbackRate)
                : 1,
            src: sourceUrl,
            duration: Number.isFinite(Number(roomModalVideo.duration)) && Number(roomModalVideo.duration) > 0
                ? Number(roomModalVideo.duration)
                : (Number.isFinite(Number(synthetic.duration)) && Number(synthetic.duration) > 0 ? Number(synthetic.duration) : null),
        };
    }

    const roomModalIframe = document.querySelector('#bclt-player-container iframe');
    if (state.embedFrame || roomModalIframe) {
        return computeBilibiliSyntheticState();
    }

    const media = getCurrentMediaElement();
    if (!media) return null;

    return {
        currentTime: media.currentTime,
        paused: media.paused,
        playbackRate: media.playbackRate,
        src: media.currentSrc || media.src || '',
        duration: Number.isFinite(media.duration) ? media.duration : null,
    };
}

export function bindMediaHooks(publishMediaState) {
    const publishIfAllowed = async (event) => {
        const media = getCurrentMediaElement();
        if (!media || event.target !== media) return;
        if (!state.settings.isHost || nowMs() < state.remoteGuardUntil) return;
        if (typeof publishMediaState === 'function') {
            await publishMediaState();
        }
    };

    document.addEventListener('play', publishIfAllowed, true);
    document.addEventListener('pause', publishIfAllowed, true);
    document.addEventListener('ratechange', publishIfAllowed, true);
    document.addEventListener('seeked', publishIfAllowed, true);
}

export function openBilibiliFromSettings() {
    const mediaUrl = state.settings.mediaUrl && state.settings.mediaUrl.trim();
    if (!mediaUrl) {
        logStatus('No media URL or media element available');
        return false;
    }

    createBilibiliEmbed(mediaUrl);
    return true;
}
