// ==UserScript==
// @name         BC Watch Together
// @namespace    https://github.com/VivianMoonlight
// @version      0.4.0
// @author       VivianMoonlight
// @description  Watch together in BC chat rooms via Supabase Realtime.
// @match        https://bondageprojects.elementfx.com/*
// @match        https://www.bondageprojects.elementfx.com/*
// @match        https://bondage-europe.com/*
// @match        https://www.bondage-europe.com/*
// @match        https://bondageprojects.com/*
// @match        https://www.bondageprojects.com/*
// @match        https://www.bondage-asia.com/club/R*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = "bclt.settings.v1";
  const MEDIA_URL_MIGRATION_KEY = "bclt.migrate.clear-media-url.v1";
  const APP_ID = "bclt-root";
  const CHANNEL_PREFIX = "bclt-room-";
  const DEFAULT_SETTINGS = {
    language: "zh",
    roomId: "",
    roomName: "",
    roomHostMemberId: "",
    roomPasscode: "",
    displayName: "",
    mediaUrl: "",
    isHost: false,
    driftThresholdMs: 800,
    syncPlaybackProgress: true,
    playbackMode: "list",
    highQualityTabMode: false
  };
  const state = {
    settings: loadSettings(),
    supabase: null,
    channel: null,
    connected: false,
    currentRoomHostName: "",
    roomAdminMemberIds: [],
    seq: 0,
    remoteGuardUntil: 0,
    mediaEl: null,
    mediaCandidates: [],
    bilibili: {
      sourceUrl: "",
      bvid: "",
      currentTime: 0,
      duration: null,
      paused: true,
      playbackRate: 1,
      startedAt: 0,
      lastSyncReason: "init"
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
    onRoomConnected: null
  };
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = JSON.parse(raw);
      const { supabaseUrl, supabaseAnonKey, ...rest } = parsed || {};
      const merged = { ...DEFAULT_SETTINGS, ...rest };
      const migrated = localStorage.getItem(MEDIA_URL_MIGRATION_KEY) === "1";
      if (!migrated) {
        merged.mediaUrl = "";
        localStorage.setItem(MEDIA_URL_MIGRATION_KEY, "1");
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      }
      return merged;
    } catch (error) {
      console.warn("[BCLT] loadSettings failed:", error);
      return { ...DEFAULT_SETTINGS };
    }
  }
  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  }
  function nowMs() {
    return Date.now();
  }
  function memberId() {
    const player = window.Player;
    return player && player.MemberNumber ? String(player.MemberNumber) : "unknown";
  }
  function effectiveDisplayName() {
    if (window.Player && typeof window.Player.Nickname === "string" && window.Player.Nickname.trim()) {
      return window.Player.Nickname.trim();
    }
    if (window.Player && typeof window.Player.Name === "string" && window.Player.Name.trim()) {
      return window.Player.Name.trim();
    }
    if (state.settings.displayName && state.settings.displayName.trim()) return state.settings.displayName.trim();
    return `Member-${memberId()}`;
  }
  function logStatus(text) {
    const el = document.querySelector("#bclt-status");
    if (el) el.textContent = text;
    console.log("[BCLT]", text);
    if (state.statusLogger) state.statusLogger(text);
  }
  function setLocalChangeNotifier(notifier) {
    state.localChangeNotifier = typeof notifier === "function" ? notifier : null;
  }
  function parseYouTubeVideoId(input) {
    if (!input) return null;
    const text = String(input).trim();
    if (!text) return null;
    const directMatch = text.match(/^[a-zA-Z0-9_-]{11}$/);
    if (directMatch) return directMatch[0];
    try {
      const url = new URL(text);
      const host = url.hostname.toLowerCase();
      if (host === "youtu.be") {
        const id = url.pathname.replace(/^\//, "").split("/")[0];
        return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
      }
      if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
        const byQuery = url.searchParams.get("v");
        if (byQuery && /^[a-zA-Z0-9_-]{11}$/.test(byQuery)) return byQuery;
        const parts = url.pathname.split("/").filter(Boolean);
        const markerIndex = parts.findIndex((part) => ["embed", "shorts", "live", "v"].includes(part));
        if (markerIndex >= 0) {
          const id = parts[markerIndex + 1] || "";
          return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
        }
      }
    } catch (error) {
    }
    const fuzzyMatch = text.match(/(?:v=|\/embed\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return fuzzyMatch ? fuzzyMatch[1] : null;
  }
  function isYouTubeUrl(input) {
    if (!input) return false;
    return /youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(String(input));
  }
  function readStartSeconds(input) {
    try {
      const url = new URL(String(input || "").trim());
      const raw = url.searchParams.get("t") || url.searchParams.get("start") || "";
      if (!raw) return 1;
      const seconds = Number(String(raw).replace(/s$/i, ""));
      return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 1;
    } catch (error) {
      return 1;
    }
  }
  function normalizeYouTubeSourceUrl(input) {
    const text = String(input || "").trim();
    if (!text) return "";
    const id = parseYouTubeVideoId(text);
    if (!id) return text;
    const url = new URL("https://www.youtube.com/watch");
    url.searchParams.set("v", id);
    const start2 = readStartSeconds(text);
    url.searchParams.set("t", String(Math.max(1, start2)));
    return url.toString();
  }
  function buildYouTubePlayerUrl(input, options = {}) {
    const { currentTime = 0, autoplay = false } = options;
    const id = parseYouTubeVideoId(input);
    if (!id) return null;
    const targetTime = Math.max(1, Math.floor(Number(currentTime) || 0));
    const params = new URLSearchParams({
      autoplay: autoplay ? "1" : "0",
      start: String(targetTime),
      rel: "0",
      modestbranding: "1",
      playsinline: "1"
    });
    return `https://www.youtube.com/embed/${id}?${params.toString()}`;
  }
  function buildYouTubeWatchUrl(input, currentTime = 0, { autoplay = true } = {}) {
    const id = parseYouTubeVideoId(input);
    if (!id) return null;
    const url = new URL("https://www.youtube.com/watch");
    url.searchParams.set("v", id);
    url.searchParams.set("t", String(Math.max(1, Math.floor(Number(currentTime) || 0))));
    if (autoplay) {
      url.searchParams.set("autoplay", "1");
    }
    return url.toString();
  }
  const YOUTUBE_METADATA_API = "https://yt.lemnoslife.com/noKey/videos";
  const INVIDIOUS_INSTANCES_API = "https://api.invidious.io/instances.json?sort_by=health";
  const INVIDIOUS_FALLBACK_HOSTS = [
    "https://inv.thepixora.com",
    "https://invidious.privacyredirect.com",
    "https://invidious.jing.rocks"
  ];
  const titleByVideoId = /* @__PURE__ */ new Map();
  const durationByVideoId = /* @__PURE__ */ new Map();
  const metadataPromiseByVideoId = /* @__PURE__ */ new Map();
  let invidiousHostsPromise = null;
  async function fetchJsonWithTimeout(url, timeoutMs = 8e3) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeoutId = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : 0;
    try {
      const response = await fetch(url, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        signal: controller ? controller.signal : void 0
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
    const text = String(input || "").trim();
    if (!text) return null;
    const match = text.match(/^P(?:([0-9]+)D)?T?(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)S)?$/i);
    if (!match) return null;
    const days = Number(match[1] || 0);
    const hours = Number(match[2] || 0);
    const minutes = Number(match[3] || 0);
    const seconds = Number(match[4] || 0);
    const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
    return Number.isFinite(total) && total > 0 ? Math.floor(total) : null;
  }
  function readMetadataFromNoKeyPayload(payload) {
    var _a, _b;
    const item = Array.isArray(payload == null ? void 0 : payload.items) ? payload.items[0] : null;
    if (!item) return { title: null, duration: null };
    const title = String(((_a = item == null ? void 0 : item.snippet) == null ? void 0 : _a.title) || "").trim() || null;
    const duration = parseIso8601DurationToSeconds((_b = item == null ? void 0 : item.contentDetails) == null ? void 0 : _b.duration);
    return { title, duration };
  }
  async function fetchYouTubeTitleViaOEmbed(videoId) {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
    const response = await fetch(endpoint, {
      method: "GET",
      mode: "cors",
      credentials: "omit"
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    return String((payload == null ? void 0 : payload.title) || "").trim() || null;
  }
  async function getInvidiousHosts() {
    if (!invidiousHostsPromise) {
      invidiousHostsPromise = (async () => {
        try {
          const payload = await fetchJsonWithTimeout(INVIDIOUS_INSTANCES_API, 7e3);
          if (!Array.isArray(payload)) {
            return [...INVIDIOUS_FALLBACK_HOSTS];
          }
          const discovered = payload.map((row) => {
            const host = row && row[0] ? String(row[0]) : "";
            const meta = row && row[1] && typeof row[1] === "object" ? row[1] : null;
            const isHttps = !!meta && meta.type === "https";
            const hasApi = !!meta && meta.api === true;
            if (!host || !isHttps || !hasApi) return "";
            return `https://${host}`;
          }).filter(Boolean);
          const unique = Array.from(/* @__PURE__ */ new Set([...discovered, ...INVIDIOUS_FALLBACK_HOSTS]));
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
        const payload = await fetchJsonWithTimeout(endpoint, 7e3);
        const title = String((payload == null ? void 0 : payload.title) || "").trim() || null;
        const duration = Number(payload == null ? void 0 : payload.lengthSeconds);
        return {
          title,
          duration: Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : null
        };
      } catch (error) {
      }
    }
    return { title: null, duration: null };
  }
  async function fetchYouTubeMetadataByVideoId(input) {
    const videoId = parseYouTubeVideoId(input);
    if (!videoId) {
      return { title: null, duration: null };
    }
    if (titleByVideoId.has(videoId) && durationByVideoId.has(videoId)) {
      return {
        title: titleByVideoId.get(videoId),
        duration: durationByVideoId.get(videoId)
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
        const payload = await fetchJsonWithTimeout(endpoint, 7e3);
        const parsed = readMetadataFromNoKeyPayload(payload);
        if (parsed.title) title = parsed.title;
        if (Number.isFinite(parsed.duration) && parsed.duration > 0) duration = parsed.duration;
      } catch (error) {
      }
      if (!title || !duration) {
        try {
          const fallback = await fetchYouTubeMetadataViaInvidious(videoId);
          if (!title && fallback.title) title = fallback.title;
          if ((!duration || duration <= 0) && Number.isFinite(fallback.duration) && fallback.duration > 0) {
            duration = Math.floor(fallback.duration);
          }
        } catch (error) {
        }
      }
      if (!title) {
        try {
          title = await fetchYouTubeTitleViaOEmbed(videoId);
        } catch (error) {
        }
      }
      if (title) titleByVideoId.set(videoId, title);
      if (Number.isFinite(duration) && duration > 0) durationByVideoId.set(videoId, Math.floor(duration));
      return {
        title: title || null,
        duration: Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : null
      };
    })();
    metadataPromiseByVideoId.set(videoId, task);
    try {
      return await task;
    } finally {
      metadataPromiseByVideoId.delete(videoId);
    }
  }
  async function fetchYouTubeTitleByVideoId(input) {
    const videoId = parseYouTubeVideoId(input);
    if (!videoId) return "";
    if (titleByVideoId.has(videoId)) {
      return titleByVideoId.get(videoId);
    }
    const metadata = await fetchYouTubeMetadataByVideoId(videoId);
    return metadata.title || "";
  }
  async function fetchYouTubeDurationByVideoId(input) {
    const videoId = parseYouTubeVideoId(input);
    if (!videoId) return null;
    if (durationByVideoId.has(videoId)) {
      return durationByVideoId.get(videoId);
    }
    const metadata = await fetchYouTubeMetadataByVideoId(videoId);
    return Number.isFinite(metadata.duration) && metadata.duration > 0 ? Math.floor(metadata.duration) : null;
  }
  function parseBilibiliBvid(input) {
    if (!input) return null;
    const text = String(input).trim();
    const bvidMatch = text.match(/(BV[0-9A-Za-z]{10,})/i);
    if (bvidMatch) return bvidMatch[1];
    const urlMatch = text.match(/[?&]bvid=(BV[0-9A-Za-z]{10,})/i);
    if (urlMatch) return urlMatch[1];
    return null;
  }
  function isBilibiliUrl(input) {
    if (!input) return false;
    return /bilibili\.com|b23\.tv/i.test(String(input));
  }
  const DIRECT_MEDIA_URL_RE$1 = /\.(mp4|webm|ogg|m3u8|mkv|mov|flv|mp3|m4a|aac|wav|flac|opus|oga|weba)(\?|#|$)/i;
  function isDirectMediaUrl$1(sourceUrl) {
    const source = String(sourceUrl || "").trim();
    if (!source) return false;
    return DIRECT_MEDIA_URL_RE$1.test(source);
  }
  function secondsToHms(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total % 3600 / 60);
    const secs = total % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
    return `${minutes}:${String(secs).padStart(2, "0")}`;
  }
  function buildBilibiliPlayerUrl(input, options = {}) {
    const { currentTime = 0, autoplay = false } = options;
    const targetTime = Math.max(1, Math.floor(Number(currentTime) || 0));
    const text = String(input || "").trim();
    const bvid = parseBilibiliBvid(text);
    if (bvid) {
      const params = new URLSearchParams({
        bvid,
        page: "1",
        as_wide: "1",
        high_quality: "1",
        autoplay: autoplay ? "1" : "0",
        t: String(targetTime)
      });
      return `https://player.bilibili.com/player.html?${params.toString()}`;
    }
    if (isBilibiliUrl(text)) {
      try {
        const url = new URL(text);
        const candidate = url.searchParams.get("bvid");
        if (candidate) {
          return buildBilibiliPlayerUrl(candidate, options);
        }
        const aid = url.searchParams.get("aid");
        const page = url.searchParams.get("p") || "1";
        if (aid) {
          const params = new URLSearchParams({
            aid,
            page,
            as_wide: "1",
            high_quality: "1",
            autoplay: autoplay ? "1" : "0",
            t: String(targetTime)
          });
          return `https://player.bilibili.com/player.html?${params.toString()}`;
        }
      } catch (error) {
      }
    }
    return null;
  }
  function removeBilibiliEmbed() {
    if (state.embedFrame && state.embedFrame.parentElement) {
      state.embedFrame.parentElement.remove();
    }
    state.embedFrame = null;
  }
  function getBilibiliEmbedIframe() {
    return document.querySelector("#bclt-bilibili-dock iframe");
  }
  const BILIBILI_VIEW_API = "https://api.bilibili.com/x/web-interface/view";
  const durationPromiseByBvid = /* @__PURE__ */ new Map();
  const durationByBvid = /* @__PURE__ */ new Map();
  function readPageIndexFromSource(input) {
    const text = String(input || "").trim();
    if (!text) return 1;
    try {
      const parsed = new URL(text);
      const fromQuery = Number(parsed.searchParams.get("p") || 1);
      return Number.isFinite(fromQuery) && fromQuery > 0 ? Math.floor(fromQuery) : 1;
    } catch (error) {
      return 1;
    }
  }
  function normalizeBilibiliSourceUrl(input) {
    const text = String(input || "").trim();
    if (!text) return "";
    if (isYouTubeUrl(text) || parseYouTubeVideoId(text)) {
      return normalizeYouTubeSourceUrl(text);
    }
    const bvid = parseBilibiliBvid(text);
    if (bvid) {
      const page = readPageIndexFromSource(text);
      const url = new URL(`https://www.bilibili.com/video/${String(bvid)}/`);
      if (page > 1) {
        url.searchParams.set("p", String(page));
      }
      url.searchParams.set("t", "1");
      return url.toString();
    }
    if (!isBilibiliUrl(text)) {
      return text;
    }
    try {
      const url = new URL(text);
      ["autoplay", "vd_source", "spm_id_from", "from_spmid", "share_source", "share_medium"].forEach((key) => {
        url.searchParams.delete(key);
      });
      url.searchParams.set("t", "1");
      url.hash = "";
      return url.toString();
    } catch (error) {
      return text;
    }
  }
  function extractDurationSecondsFromViewPayload(payload, sourceUrl) {
    var _a;
    const data = payload && payload.data ? payload.data : null;
    if (!data) return null;
    const pageIndex = readPageIndexFromSource(sourceUrl);
    const pageDuration = Array.isArray(data.pages) && data.pages.length >= pageIndex ? Number((_a = data.pages[pageIndex - 1]) == null ? void 0 : _a.duration) : NaN;
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
      method: "GET",
      mode: "cors",
      credentials: "omit"
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    const duration = extractDurationSecondsFromViewPayload(payload, sourceUrl);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Duration missing in view payload");
    }
    return duration;
  }
  function fetchBilibiliDurationViaJsonp(bvid, sourceUrl) {
    return new Promise((resolve, reject) => {
      const callbackName = `__bclt_duration_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const script = document.createElement("script");
      const timeoutMs = 8e3;
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
          window[callbackName] = void 0;
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
          reject(new Error("Duration missing in JSONP payload"));
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      script.onerror = () => {
        cleanup();
        reject(new Error("JSONP request failed"));
      };
      timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error("JSONP request timed out"));
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
  async function fetchVideoDuration(sourceUrl) {
    return new Promise((resolve) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      let timeoutId = setTimeout(() => {
        video.onloadedmetadata = null;
        video.onerror = null;
        resolve(null);
      }, 1e4);
      video.onloadedmetadata = () => {
        clearTimeout(timeoutId);
        resolve(video.duration);
      };
      video.onerror = () => {
        clearTimeout(timeoutId);
        resolve(null);
      };
      video.src = sourceUrl;
    });
  }
  async function hydrateBilibiliDuration(sourceUrl) {
    const normalizedSource = normalizeBilibiliSourceUrl(sourceUrl);
    const youtubeId = parseYouTubeVideoId(normalizedSource);
    if (youtubeId) {
      const duration2 = await fetchYouTubeDurationByVideoId(youtubeId);
      if (normalizedSource === state.bilibili.sourceUrl && Number.isFinite(duration2) && duration2 > 0) {
        state.bilibili.duration = Math.max(1, Math.floor(duration2));
      }
      return Number.isFinite(duration2) && duration2 > 0 ? Math.max(1, Math.floor(duration2)) : null;
    }
    const isVideoURL = isDirectMediaUrl$1(normalizedSource);
    if (isVideoURL) {
      const duration2 = await fetchVideoDuration(normalizedSource);
      if (normalizedSource === state.bilibili.sourceUrl && Number.isFinite(duration2) && duration2 > 0) {
        state.bilibili.duration = Math.max(1, Math.floor(duration2));
      }
      return Number.isFinite(duration2) && duration2 > 0 ? Math.max(1, Math.floor(duration2)) : null;
    }
    const bvid = parseBilibiliBvid(normalizedSource);
    if (!bvid) return null;
    const duration = await fetchBilibiliDuration(bvid, normalizedSource);
    if (normalizedSource === state.bilibili.sourceUrl && Number.isFinite(duration) && duration > 0) {
      state.bilibili.duration = Math.max(1, Math.floor(duration));
    }
    return duration;
  }
  function computeBilibiliSyntheticState() {
    const elapsedSeconds = state.bilibili.paused || !state.bilibili.startedAt ? 0 : (nowMs() - state.bilibili.startedAt) / 1e3 * state.bilibili.playbackRate;
    const sourceUrl = state.bilibili.sourceUrl || state.settings.mediaUrl || "";
    const isLocalVideo = sourceUrl.startsWith("local://");
    const isVideoURL = isDirectMediaUrl$1(sourceUrl);
    const youtubeId = parseYouTubeVideoId(sourceUrl);
    const bvid = state.bilibili.bvid || parseBilibiliBvid(sourceUrl) || "";
    const mediaKind = isLocalVideo ? "local_video" : youtubeId ? "youtube" : isVideoURL ? "video" : "bilibili";
    return {
      mediaKind,
      sourceUrl,
      bvid,
      videoId: youtubeId || "",
      currentTime: state.bilibili.currentTime + elapsedSeconds,
      paused: state.bilibili.paused,
      playbackRate: state.bilibili.playbackRate,
      duration: Number.isFinite(Number(state.bilibili.duration)) && Number(state.bilibili.duration) > 0 ? Number(state.bilibili.duration) : null
    };
  }
  function updateBilibiliDockStatus() {
    const status = document.querySelector("#bclt-bilibili-status");
    if (!status) return;
    const current = computeBilibiliSyntheticState();
    status.textContent = `${current.paused ? "Paused" : "Playing"} @ ${secondsToHms(current.currentTime)}`;
  }
  function setBilibiliSyntheticState(nextState, reason = "sync") {
    const sourceUrl = normalizeBilibiliSourceUrl(nextState.sourceUrl || state.bilibili.sourceUrl || state.settings.mediaUrl);
    if (!sourceUrl) return false;
    const sourceChanged = sourceUrl !== state.bilibili.sourceUrl;
    const currentTime = Number.isFinite(Number(nextState.currentTime)) ? Number(nextState.currentTime) : state.bilibili.currentTime;
    const duration = Number.isFinite(Number(nextState.duration)) && Number(nextState.duration) > 0 ? Math.max(1, Math.floor(Number(nextState.duration))) : null;
    const paused = typeof nextState.paused === "boolean" ? nextState.paused : state.bilibili.paused;
    const playbackRate = Number.isFinite(Number(nextState.playbackRate)) && Number(nextState.playbackRate) > 0 ? Number(nextState.playbackRate) : state.bilibili.playbackRate;
    state.bilibili.sourceUrl = sourceUrl;
    state.bilibili.bvid = parseBilibiliBvid(sourceUrl) || "";
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
  function reloadBilibiliEmbed(nextState, reason = "sync") {
    const applied = setBilibiliSyntheticState(nextState, reason);
    if (!applied) return false;
    const iframe = getBilibiliEmbedIframe();
    if (!iframe) return false;
    iframe.src = buildBilibiliPlayerUrl(state.bilibili.sourceUrl, {
      currentTime: state.bilibili.currentTime,
      autoplay: !state.bilibili.paused
    });
    updateBilibiliDockStatus();
    return true;
  }
  function applyBilibiliRemoteSync(nextState, reason = "remote-sync") {
    const sourceUrl = normalizeBilibiliSourceUrl(nextState.sourceUrl || state.bilibili.sourceUrl || state.settings.mediaUrl);
    if (!sourceUrl) return false;
    if (!getBilibiliEmbedIframe()) {
      return false;
    }
    const current = computeBilibiliSyntheticState();
    const incomingTime = Number.isFinite(Number(nextState.currentTime)) ? Number(nextState.currentTime) : current.currentTime;
    const incomingPaused = typeof nextState.paused === "boolean" ? nextState.paused : current.paused;
    const incomingRate = Number.isFinite(Number(nextState.playbackRate)) && Number(nextState.playbackRate) > 0 ? Number(nextState.playbackRate) : current.playbackRate;
    const thresholdSeconds = Math.max(0.1, Number(state.settings.driftThresholdMs || 800) / 1e3);
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
        playbackRate: incomingRate
      }, reason);
    }
    const incomingDuration = Number.isFinite(Number(nextState.duration)) && Number(nextState.duration) > 0 ? Math.max(1, Math.floor(Number(nextState.duration))) : null;
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
        console.warn("[BCLT] failed to hydrate Bilibili duration:", error);
      });
    }
    updateBilibiliDockStatus();
    return true;
  }
  function describeMediaElement(el, index) {
    const tag = el.tagName.toLowerCase();
    const label = el.currentSrc || el.src || "no-src";
    const duration = Number.isFinite(el.duration) ? `/${Math.round(el.duration)}s` : "";
    return `${index + 1}. ${tag} ${label}${duration}`;
  }
  function discoverMediaElements() {
    const nodes = Array.from(document.querySelectorAll("video, audio"));
    return nodes.filter((node) => node instanceof HTMLMediaElement && document.contains(node));
  }
  function updateMediaSelectOptions() {
    const select = document.querySelector("#bclt-media-select");
    if (!select) return;
    const previousValue = select.value;
    select.innerHTML = "";
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = state.mediaCandidates.length ? "Auto-detect media" : "No media found";
    select.appendChild(emptyOption);
    state.mediaCandidates.forEach((el, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = describeMediaElement(el, index);
      select.appendChild(option);
    });
    if (state.mediaEl) {
      const selectedIndex = state.mediaCandidates.indexOf(state.mediaEl);
      select.value = selectedIndex >= 0 ? String(selectedIndex) : "";
    } else if (previousValue) {
      select.value = previousValue;
    }
  }
  function refreshMediaCandidates() {
    state.mediaCandidates = discoverMediaElements();
    if (state.mediaCandidates.length > 0) {
      const current = state.mediaEl && state.mediaCandidates.includes(state.mediaEl) ? state.mediaEl : state.mediaCandidates[0];
      state.mediaEl = current;
    }
    updateMediaSelectOptions();
    return state.mediaCandidates;
  }
  function ensureMediaElement() {
    if (state.mediaEl && document.contains(state.mediaEl)) return state.mediaEl;
    refreshMediaCandidates();
    if (state.mediaEl) return state.mediaEl;
    const mediaUrl = state.settings.mediaUrl && state.settings.mediaUrl.trim();
    if (!mediaUrl) return null;
    if (isBilibiliUrl(mediaUrl) || parseBilibiliBvid(mediaUrl) || isYouTubeUrl(mediaUrl) || parseYouTubeVideoId(mediaUrl)) {
      return null;
    }
    const created = document.createElement(mediaUrl.match(/\.(mp4|webm|ogg)(\?|#|$)/i) ? "video" : "audio");
    created.controls = true;
    created.preload = "metadata";
    created.src = mediaUrl;
    created.style.display = "none";
    created.dataset.bcltInjected = "1";
    document.body.appendChild(created);
    state.mediaEl = created;
    state.mediaCandidates = [created];
    updateMediaSelectOptions();
    return created;
  }
  function getCurrentMediaElement() {
    return ensureMediaElement();
  }
  function readLocalMediaState() {
    const roomModalVideo = document.querySelector("#bclt-player-container video");
    if (roomModalVideo instanceof HTMLMediaElement) {
      const synthetic = computeBilibiliSyntheticState();
      const sourceUrl = String(synthetic.sourceUrl || roomModalVideo.currentSrc || roomModalVideo.src || "");
      return {
        mediaKind: synthetic.mediaKind,
        sourceUrl,
        bvid: synthetic.bvid,
        videoId: synthetic.videoId,
        currentTime: Number.isFinite(Number(roomModalVideo.currentTime)) ? Number(roomModalVideo.currentTime) : 0,
        paused: !!roomModalVideo.paused,
        playbackRate: Number.isFinite(Number(roomModalVideo.playbackRate)) && Number(roomModalVideo.playbackRate) > 0 ? Number(roomModalVideo.playbackRate) : 1,
        src: sourceUrl,
        duration: Number.isFinite(Number(roomModalVideo.duration)) && Number(roomModalVideo.duration) > 0 ? Number(roomModalVideo.duration) : Number.isFinite(Number(synthetic.duration)) && Number(synthetic.duration) > 0 ? Number(synthetic.duration) : null
      };
    }
    const roomModalIframe = document.querySelector("#bclt-player-container iframe");
    if (state.embedFrame || roomModalIframe) {
      return computeBilibiliSyntheticState();
    }
    const media = getCurrentMediaElement();
    if (!media) return null;
    return {
      currentTime: media.currentTime,
      paused: media.paused,
      playbackRate: media.playbackRate,
      src: media.currentSrc || media.src || "",
      duration: Number.isFinite(media.duration) ? media.duration : null
    };
  }
  function bindMediaHooks(publishMediaState) {
    const publishIfAllowed = async (event) => {
      const media = getCurrentMediaElement();
      if (!media || event.target !== media) return;
      if (!state.settings.isHost || nowMs() < state.remoteGuardUntil) return;
      if (typeof publishMediaState === "function") {
        await publishMediaState();
      }
    };
    document.addEventListener("play", publishIfAllowed, true);
    document.addEventListener("pause", publishIfAllowed, true);
    document.addEventListener("ratechange", publishIfAllowed, true);
    document.addEventListener("seeked", publishIfAllowed, true);
  }
  const HARDWIRED_SUPABASE_URL = "https://ikzntirwphumwkekflek.supabase.co";
  const HARDWIRED_SUPABASE_ANON_KEY = "sb_publishable_0cwF0A-zVDkg0IGRQYrUSQ_nEIPsFBU";
  let lastPasscodeMismatchWarnAt = 0;
  let hostOfflineFallbackInFlight = false;
  let hostOfflineFallbackLastAttemptAt = 0;
  let joinSessionNonce = 0;
  const HOST_OFFLINE_FALLBACK_MS = 2e4;
  const HOST_FALLBACK_ACTIVE_WINDOW_MS = 6e4;
  const HOST_FALLBACK_COOLDOWN_MS = 12e3;
  const ACTIVE_MEMBER_WINDOW_MS = 60 * 1e3;
  const ROOM_ORPHAN_CLEANUP_MS = 90 * 1e3;
  function buildChannelTopicRoomPart(roomId) {
    const raw = String(roomId || "").trim();
    if (!raw) return "room";
    return encodeURIComponent(raw).replace(/%/g, "_");
  }
  function parseTimestampMs(value) {
    const ts = new Date(value || "").getTime();
    return Number.isFinite(ts) ? ts : NaN;
  }
  function isRecentActivity(lastSeenAt, activeWindowMs = ACTIVE_MEMBER_WINDOW_MS) {
    const ts = parseTimestampMs(lastSeenAt);
    if (!Number.isFinite(ts)) return false;
    return ts >= Date.now() - Math.max(5e3, Number(activeWindowMs) || ACTIVE_MEMBER_WINDOW_MS);
  }
  function shouldCleanupOrphanRoom(room) {
    const updatedAtMs = parseTimestampMs(room == null ? void 0 : room.updated_at) || parseTimestampMs(room == null ? void 0 : room.created_at);
    if (!Number.isFinite(updatedAtMs)) return false;
    return Date.now() - updatedAtMs > ROOM_ORPHAN_CLEANUP_MS;
  }
  const SUPABASE_UMD_URLS = [
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js",
    "https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.min.js"
  ];
  function appendScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.async = false;
      script.crossOrigin = "anonymous";
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
    if (globalThis.supabase && typeof globalThis.supabase.createClient === "function") {
      return globalThis.supabase;
    }
    for (const url of SUPABASE_UMD_URLS) {
      try {
        await appendScript(url);
        if (globalThis.supabase && typeof globalThis.supabase.createClient === "function") {
          return globalThis.supabase;
        }
      } catch (error) {
        console.warn("[BCWT] Failed to load Supabase runtime from", url, error);
      }
    }
    throw new Error("Supabase runtime failed to load from all sources.");
  }
  async function getSupabaseClient() {
    if (state.supabase) return state.supabase;
    const supabaseRuntime = await ensureSupabaseRuntime();
    state.supabase = supabaseRuntime.createClient(HARDWIRED_SUPABASE_URL, HARDWIRED_SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      },
      realtime: {
        params: {
          eventsPerSecond: 8
        }
      }
    });
    return state.supabase;
  }
  function buildEnvelope(type, payload) {
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
      payload
    };
  }
  async function publish(type, payload) {
    if (!state.connected || !state.channel) return;
    if (type === "media_state" && state.settings.syncPlaybackProgress === false) return;
    let normalizedPayload = payload;
    if (type === "media_state" && payload && typeof payload === "object") {
      normalizedPayload = {
        ...payload,
        syncProgress: !!state.settings.syncPlaybackProgress,
        playbackMode: state.settings.playbackMode || "list"
      };
    }
    if (type === "video_shared") {
      const eventPayload = {
        ...normalizedPayload,
        roomId: state.settings.roomId,
        roomPasscode: state.settings.roomPasscode,
        senderId: memberId(),
        senderName: effectiveDisplayName(),
        clientTs: nowMs()
      };
      await state.channel.send({
        type: "broadcast",
        event: "video_shared",
        payload: eventPayload
      });
      return;
    }
    const envelope = buildEnvelope(type, normalizedPayload);
    await state.channel.send({
      type: "broadcast",
      event: "sync",
      payload: envelope
    });
  }
  function shouldIgnoreEnvelope(envelope) {
    if (!envelope || envelope.roomId !== state.settings.roomId) return true;
    if (envelope.roomPasscode !== state.settings.roomPasscode) {
      const now = nowMs();
      if (now - lastPasscodeMismatchWarnAt > 5e3) {
        lastPasscodeMismatchWarnAt = now;
        logStatus("Room passcode mismatch detected. Please leave and rejoin the room.");
      }
      return true;
    }
    if (envelope.senderId === memberId()) return true;
    return false;
  }
  async function applyRemoteSync(envelope) {
    if (shouldIgnoreEnvelope(envelope)) return;
    const payload = envelope.payload || {};
    if (envelope.type === "media_state" && (state.settings.syncPlaybackProgress === false || payload.syncProgress === false)) {
      return;
    }
    if (envelope.type === "playlist_request" && state.onRemotePlaylistRequest) {
      const handled = await state.onRemotePlaylistRequest(payload, envelope);
      if (handled) return;
    }
    if (envelope.type === "playlist_state" && state.onRemotePlaylistState) {
      const handled = await state.onRemotePlaylistState(payload, envelope);
      if (handled) return;
    }
    if (envelope.type === "media_state" && state.onRemoteMediaState) {
      const handled = await state.onRemoteMediaState(payload, envelope);
      if (handled) return;
    }
    if (envelope.type === "room_control" && state.onRemoteRoomControl) {
      const handled = await state.onRemoteRoomControl(payload, envelope);
      if (handled) return;
    }
    if (payload.mediaKind === "bilibili" || payload.mediaKind === "youtube" || state.embedFrame) {
      const applied = applyBilibiliRemoteSync({
        sourceUrl: payload.sourceUrl || state.settings.mediaUrl || state.bilibili.sourceUrl,
        currentTime: payload.currentTime,
        duration: payload.duration,
        paused: payload.paused,
        playbackRate: payload.playbackRate
      }, "remote-sync");
      if (applied) {
        logStatus(`Synced embedded media from ${envelope.senderName || envelope.senderId}`);
        return;
      }
    }
    const media = getCurrentMediaElement();
    if (!media) {
      logStatus("No media element found on page.");
      return;
    }
    state.remoteGuardUntil = nowMs() + 600;
    if (envelope.type === "media_state") {
      const p = payload;
      const targetTime = Number(p.currentTime || 0);
      const localTime = Number(media.currentTime || 0);
      const driftMs = Math.abs(targetTime - localTime) * 1e3;
      if (Number.isFinite(p.playbackRate) && p.playbackRate > 0 && media.playbackRate !== p.playbackRate) {
        media.playbackRate = p.playbackRate;
      }
      if (driftMs > Number(state.settings.driftThresholdMs || 800)) {
        media.currentTime = targetTime;
      }
      if (typeof p.paused === "boolean") {
        if (p.paused && !media.paused) {
          await media.pause();
        }
        if (!p.paused && media.paused) {
          try {
            await media.play();
          } catch (error) {
            console.warn("[BCLT] media.play() blocked:", error);
          }
        }
      }
      logStatus(`Synced from ${envelope.senderName || envelope.senderId}`);
    }
  }
  async function syncSnapshotToTable(client) {
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
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    const { error } = await client.from("bclt_room_states").upsert(row, { onConflict: "room_id" });
    if (error) {
      console.warn("[BCLT] upsert room state failed:", error.message);
    }
    await touchRoom(client);
  }
  async function touchRoom(client) {
    const { data: updated, error } = await client.from("bclt_rooms").update({ updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("room_id", state.settings.roomId).eq("host_member_id", memberId()).select("host_member_id");
    if (error) {
      console.warn("[BCLT] touch room failed:", error.message);
    } else if (Array.isArray(updated) && updated.length === 0) {
      console.warn("[BCLT] Host heartbeat rejected: usurped while offline. Stepping down.");
      state.settings.isHost = false;
      const { data: currentRoom } = await client.from("bclt_rooms").select("host_member_id").eq("room_id", state.settings.roomId).maybeSingle();
      if (currentRoom && currentRoom.host_member_id) {
        state.settings.roomHostMemberId = currentRoom.host_member_id;
        saveSettings();
        if (state.onRemoteRoomControl) {
          await state.onRemoteRoomControl({
            action: "ownership_transferred",
            roomId: state.settings.roomId,
            previousHostMemberId: memberId(),
            newHostMemberId: currentRoom.host_member_id,
            newHostDisplayName: "...",
            adminMemberIds: state.roomAdminMemberIds || []
          });
        }
      }
    }
  }
  async function upsertRoomMember(client) {
    const row = {
      room_id: state.settings.roomId,
      member_id: memberId(),
      display_name: effectiveDisplayName(),
      is_host: !!state.settings.isHost,
      last_seen_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    const { error } = await client.from("bclt_room_members").upsert(row, { onConflict: "room_id,member_id" });
    if (error) {
      console.warn("[BCLT] upsert room member failed:", error.message);
    }
  }
  async function deleteRoomCascade(client, roomId) {
    const normalizedRoomId = String(roomId || "").trim();
    if (!normalizedRoomId) return false;
    const { error: clearMembersError } = await client.from("bclt_room_members").delete().eq("room_id", normalizedRoomId);
    if (clearMembersError) {
      console.warn("[BCLT] delete room members failed:", clearMembersError.message);
      return false;
    }
    const { error: clearStateError } = await client.from("bclt_room_states").delete().eq("room_id", normalizedRoomId);
    if (clearStateError) {
      console.warn("[BCLT] delete room state failed:", clearStateError.message);
    }
    const { error: deleteRoomError } = await client.from("bclt_rooms").delete().eq("room_id", normalizedRoomId);
    if (deleteRoomError) {
      console.warn("[BCLT] delete room failed:", deleteRoomError.message);
      return false;
    }
    return true;
  }
  async function cleanupRoomIfNoActiveMembers(client, roomId, activeWindowMs = ACTIVE_MEMBER_WINDOW_MS) {
    const normalizedRoomId = String(roomId || "").trim();
    if (!normalizedRoomId) return false;
    const { data: members, error: membersError } = await client.from("bclt_room_members").select("member_id, last_seen_at").eq("room_id", normalizedRoomId);
    if (membersError) {
      console.warn("[BCLT] read room members for cleanup failed:", membersError.message);
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
    const candidates = rooms.filter((room) => (activeMemberCounts.get(room.room_id) || 0) === 0).filter((room) => shouldCleanupOrphanRoom(room)).map((room) => room.room_id).filter((id) => !!String(id || "").trim()).slice(0, 8);
    for (const roomId of candidates) {
      await cleanupRoomIfNoActiveMembers(client, roomId, ACTIVE_MEMBER_WINDOW_MS);
    }
  }
  async function createRoomRecord() {
    if (!state.settings.roomId) {
      throw new Error("Missing room ID");
    }
    const client = await getSupabaseClient();
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    const normalizedPasscode = String(state.settings.roomPasscode || "").trim();
    state.settings.roomPasscode = normalizedPasscode;
    const roomRow = {
      room_id: state.settings.roomId,
      room_passcode: normalizedPasscode,
      host_member_id: memberId(),
      created_by: effectiveDisplayName(),
      updated_at: nowIso
    };
    const { error: roomError } = await client.from("bclt_rooms").insert(roomRow);
    if (roomError) {
      const normalizedCode = String(roomError.code || "");
      if (normalizedCode === "23505") {
        const { data: existingMembers, error: existingMembersError } = await client.from("bclt_room_members").select("member_id, last_seen_at").eq("room_id", state.settings.roomId);
        if (existingMembersError) {
          throw new Error(`Create room failed: ${existingMembersError.message}`);
        }
        const rows = Array.isArray(existingMembers) ? existingMembers : [];
        const selfMemberId = memberId();
        const hasOtherActiveMember = rows.some((row) => {
          if (!isRecentActivity(row.last_seen_at, ACTIVE_MEMBER_WINDOW_MS)) return false;
          return String(row.member_id || "") !== selfMemberId;
        });
        if (hasOtherActiveMember) {
          throw new Error("Room name already exists. Please choose another room name.");
        }
        const { error: clearMembersError } = await client.from("bclt_room_members").delete().eq("room_id", state.settings.roomId);
        if (clearMembersError) {
          throw new Error(`Replace empty room failed: ${clearMembersError.message}`);
        }
        const { error: replaceRoomError } = await client.from("bclt_rooms").upsert(roomRow, { onConflict: "room_id" });
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
      updated_at: nowIso
    };
    const { error: roomStateError } = await client.from("bclt_room_states").upsert(roomStateRow, { onConflict: "room_id" });
    if (roomStateError) {
      throw new Error(`Create room state failed: ${roomStateError.message}`);
    }
    await upsertRoomMember(client);
  }
  async function fetchAvailableRooms() {
    const client = await getSupabaseClient();
    const { data: rooms, error } = await client.from("bclt_rooms").select("room_id, room_passcode, host_member_id, created_by, updated_at, created_at").order("updated_at", { ascending: false }).limit(50);
    if (error) {
      throw new Error(`Load rooms failed: ${error.message}`);
    }
    const roomIds = (rooms || []).map((room) => room.room_id);
    const memberCounts = /* @__PURE__ */ new Map();
    const hostDisplayNames = /* @__PURE__ */ new Map();
    if (roomIds.length > 0) {
      const { data: members, error: memberError } = await client.from("bclt_room_members").select("room_id, member_id, display_name, is_host, last_seen_at").in("room_id", roomIds);
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
    return (rooms || []).filter((room) => (memberCounts.get(room.room_id) || 0) > 0).map((room) => {
      const roomLabel = String(room.room_id || "").trim() || "Unnamed Room";
      const hostName = hostDisplayNames.get(room.room_id) || room.created_by || room.host_member_id;
      const isLocked = !!String(room.room_passcode || "").trim();
      return {
        id: room.room_id,
        roomName: roomLabel,
        displayName: roomLabel,
        name: roomLabel,
        members: memberCounts.get(room.room_id) || 0,
        hostMemberId: room.host_member_id,
        host: hostName,
        isLocked,
        updatedAt: room.updated_at
      };
    });
  }
  async function fetchCurrentRoomPlaybackState() {
    if (!state.settings.roomId) return null;
    const client = await getSupabaseClient();
    const { data, error } = await client.from("bclt_room_states").select("room_id, room_passcode, media_src, media_current_time, paused, playback_rate, seq, updated_at").eq("room_id", state.settings.roomId).maybeSingle();
    if (error) {
      throw new Error(`Load room playback state failed: ${error.message}`);
    }
    const normalizedPasscode = String(state.settings.roomPasscode || "").trim();
    const requiredPasscode = String(data && data.room_passcode || "").trim();
    if (!data) return null;
    if (requiredPasscode && requiredPasscode !== normalizedPasscode) return null;
    if (!data.media_src) return null;
    return {
      sourceUrl: data.media_src,
      currentTime: Number(data.media_current_time || 0),
      paused: !!data.paused,
      playbackRate: Number(data.playback_rate || 1),
      seq: Number(data.seq || 0),
      updatedAt: data.updated_at
    };
  }
  async function joinRoom() {
    if (!state.settings.roomId) {
      alert("Please select a room.");
      return;
    }
    try {
      const sessionNonce = ++joinSessionNonce;
      const client = await getSupabaseClient();
      if (state.channel && state.supabase) {
        try {
          await state.supabase.removeChannel(state.channel);
        } catch (error) {
          console.warn("[BCLT] pre-join removeChannel failed:", error);
        }
      }
      state.channel = null;
      state.connected = false;
      const { data: roomRecord, error: roomError } = await client.from("bclt_rooms").select("room_id, room_passcode, host_member_id").eq("room_id", state.settings.roomId).maybeSingle();
      if (roomError) {
        throw new Error(`Read room failed: ${roomError.message}`);
      }
      if (!roomRecord) {
        throw new Error("Room does not exist. Please refresh and create or select an existing room.");
      }
      const normalizedPasscode = String(state.settings.roomPasscode || "").trim();
      const requiredPasscode = String(roomRecord && roomRecord.room_passcode || "").trim();
      if (requiredPasscode && requiredPasscode !== normalizedPasscode) {
        throw new Error("Incorrect room passcode.");
      }
      const roomHostId = roomRecord && roomRecord.host_member_id ? String(roomRecord.host_member_id) : "";
      state.settings.roomHostMemberId = roomHostId;
      state.settings.isHost = roomHostId === memberId();
      const channelName = `${CHANNEL_PREFIX}${buildChannelTopicRoomPart(state.settings.roomId)}`;
      const channel = client.channel(channelName, {
        config: {
          broadcast: { self: false },
          presence: { key: memberId() }
        }
      });
      channel.on("broadcast", { event: "sync" }, async ({ payload }) => {
        if (sessionNonce !== joinSessionNonce) return;
        await applyRemoteSync(payload);
      });
      channel.on("broadcast", { event: "video_shared" }, async ({ payload }) => {
        if (sessionNonce !== joinSessionNonce) return;
        const normalized = payload && payload.payload && payload.type === "video_shared" ? {
          ...payload.payload,
          roomId: payload.roomId,
          roomPasscode: payload.roomPasscode,
          senderId: payload.senderId,
          senderName: payload.senderName,
          clientTs: payload.clientTs
        } : payload;
        if (!normalized) return;
        if (normalized.roomId && normalized.roomId !== state.settings.roomId) return;
        if (normalized.roomPasscode && normalized.roomPasscode !== state.settings.roomPasscode) return;
        if (normalized.senderId && normalized.senderId === memberId()) return;
        if (state.onRemoteVideoShared) {
          await state.onRemoteVideoShared(normalized);
        }
      });
      channel.on("presence", { event: "sync" }, () => {
        if (sessionNonce !== joinSessionNonce) return;
        logStatus("Presence updated");
      });
      channel.subscribe(async (status) => {
        if (sessionNonce !== joinSessionNonce) return;
        if (status === "SUBSCRIBED") {
          lastPasscodeMismatchWarnAt = 0;
          state.connected = true;
          state.channel = channel;
          await channel.track({
            id: memberId(),
            name: effectiveDisplayName(),
            isHost: !!state.settings.isHost,
            at: nowMs()
          });
          await upsertRoomMember(client);
          logStatus(`Connected: ${channelName}`);
          if (state.onRoomConnected) {
            try {
              await state.onRoomConnected({ channelName });
            } catch (error) {
              console.warn("[BCLT] onRoomConnected failed:", error);
            }
          }
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          if (state.channel !== channel) return;
          state.connected = false;
          logStatus(`Channel status: ${status}`);
        }
      });
      startRuntimeLoops(client);
    } catch (error) {
      console.error("[BCLT] joinRoom failed:", error);
      logStatus(`Connect failed: ${error.message}`);
    }
  }
  async function leaveRoom() {
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
      console.warn("[BCLT] leaveRoom ownership cleanup failed:", error);
    }
    if (state.channel && state.supabase) {
      try {
        await state.supabase.removeChannel(state.channel);
      } catch (error) {
        console.warn("[BCLT] removeChannel failed:", error);
      }
    }
    state.channel = null;
    state.connected = false;
    state.settings.isHost = false;
    state.settings.roomHostMemberId = "";
    state.roomAdminMemberIds = [];
    logStatus("Disconnected");
  }
  async function removeCurrentMemberRecord(client) {
    if (!state.settings.roomId) return;
    const { error } = await client.from("bclt_room_members").delete().eq("room_id", state.settings.roomId).eq("member_id", memberId());
    if (error) {
      console.warn("[BCLT] remove current member failed:", error.message);
    }
  }
  async function fetchRoomMembers(options = {}) {
    if (!state.settings.roomId) return [];
    const {
      includeStale = false,
      excludeSelf = false,
      activeWindowMs = 60 * 1e3
    } = options;
    const client = await getSupabaseClient();
    const { data, error } = await client.from("bclt_room_members").select("room_id, member_id, display_name, is_host, last_seen_at").eq("room_id", state.settings.roomId).order("last_seen_at", { ascending: false });
    if (error) {
      throw new Error(`Load room members failed: ${error.message}`);
    }
    const staleCutoff = Date.now() - Math.max(5e3, Number(activeWindowMs) || 6e4);
    const selfId = memberId();
    return (Array.isArray(data) ? data : []).filter((row) => {
      if (!includeStale) {
        const ts = new Date(row.last_seen_at).getTime();
        if (!Number.isFinite(ts) || ts < staleCutoff) return false;
      }
      if (excludeSelf && String(row.member_id) === selfId) return false;
      return true;
    }).map((row) => ({
      memberId: String(row.member_id),
      displayName: String(row.display_name || row.member_id),
      isHost: !!row.is_host,
      lastSeenAt: row.last_seen_at
    }));
  }
  async function transferRoomOwnership(nextHostMemberId, options = {}) {
    if (!state.settings.roomId) {
      throw new Error("Missing room ID");
    }
    const candidateId = String(nextHostMemberId || "").trim();
    if (!candidateId) {
      throw new Error("Missing target member ID");
    }
    if (!state.settings.isHost) {
      throw new Error("Only host can transfer room ownership");
    }
    const client = await getSupabaseClient();
    const members = await fetchRoomMembers({ includeStale: false });
    const target = members.find((m) => m.memberId === candidateId);
    if (!target) {
      throw new Error("Target member is not active in room");
    }
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    const { error: roomError } = await client.from("bclt_rooms").update({
      host_member_id: candidateId,
      updated_at: nowIso
    }).eq("room_id", state.settings.roomId);
    if (roomError) {
      throw new Error(`Transfer ownership failed: ${roomError.message}`);
    }
    const { error: roomStateError } = await client.from("bclt_room_states").update({ host_member_id: candidateId, updated_at: nowIso }).eq("room_id", state.settings.roomId);
    if (roomStateError) {
      throw new Error(`Update room state host failed: ${roomStateError.message}`);
    }
    const { error: clearHostError } = await client.from("bclt_room_members").update({ is_host: false }).eq("room_id", state.settings.roomId);
    if (clearHostError) {
      throw new Error(`Clear previous host failed: ${clearHostError.message}`);
    }
    const { error: setHostError } = await client.from("bclt_room_members").update({ is_host: true, last_seen_at: nowIso }).eq("room_id", state.settings.roomId).eq("member_id", candidateId);
    if (setHostError) {
      throw new Error(`Set new host failed: ${setHostError.message}`);
    }
    const explicitAdminIds = Array.isArray(options.adminMemberIds) ? options.adminMemberIds : state.roomAdminMemberIds;
    const nextAdminIds = explicitAdminIds.map((id) => String(id || "").trim()).filter((id) => !!id && id !== candidateId);
    await publish("room_control", {
      action: "ownership_transferred",
      roomId: state.settings.roomId,
      previousHostMemberId: memberId(),
      newHostMemberId: candidateId,
      newHostDisplayName: target.displayName,
      adminMemberIds: nextAdminIds,
      at: Date.now()
    });
    state.roomAdminMemberIds = nextAdminIds;
    state.settings.roomHostMemberId = candidateId;
    state.settings.isHost = false;
  }
  async function transferOwnershipOnHostLeave() {
    const members = await fetchRoomMembers({ includeStale: false, excludeSelf: true });
    const candidates = members.map((member) => ({ ...member, lastSeenMs: readMemberLastSeenMs(member) })).filter((member) => Number.isFinite(member.lastSeenMs)).sort(sortFallbackCandidates);
    if (candidates.length > 0) {
      const fallbackTarget = candidates[0];
      try {
        await transferRoomOwnership(fallbackTarget.memberId);
        return true;
      } catch (error) {
        console.warn("[BCLT] transfer ownership fallback failed:", error);
      }
    }
    return false;
  }
  function readMemberLastSeenMs(member) {
    const ts = new Date((member == null ? void 0 : member.lastSeenAt) || "").getTime();
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
    const currentHostId = String(state.settings.roomHostMemberId || "").trim();
    if (!currentHostId) return;
    hostOfflineFallbackInFlight = true;
    hostOfflineFallbackLastAttemptAt = now;
    try {
      const allMembers = await fetchRoomMembers({
        includeStale: true,
        excludeSelf: false,
        activeWindowMs: HOST_FALLBACK_ACTIVE_WINDOW_MS
      });
      const hostMember = allMembers.find((member) => member.memberId === currentHostId);
      const hostLastSeenMs = readMemberLastSeenMs(hostMember);
      const hostLooksOffline = !hostMember || !Number.isFinite(hostLastSeenMs) || now - hostLastSeenMs > HOST_OFFLINE_FALLBACK_MS;
      if (!hostLooksOffline) return;
      const activeCutoff = now - HOST_FALLBACK_ACTIVE_WINDOW_MS;
      const activeCandidates = allMembers.map((member) => ({ ...member, lastSeenMs: readMemberLastSeenMs(member) })).filter((member) => Number.isFinite(member.lastSeenMs) && member.lastSeenMs >= activeCutoff).sort(sortFallbackCandidates);
      if (!activeCandidates.length) return;
      const electedCandidate = activeCandidates[0];
      if (!electedCandidate || electedCandidate.memberId !== memberId()) return;
      const selfId = memberId();
      const nowIso = (/* @__PURE__ */ new Date()).toISOString();
      const { data: claimRows, error: claimError } = await client.from("bclt_rooms").update({
        host_member_id: selfId,
        updated_at: nowIso
      }).eq("room_id", state.settings.roomId).eq("host_member_id", currentHostId).select("room_id, host_member_id");
      if (claimError) {
        console.warn("[BCLT] host offline fallback claim failed:", claimError.message);
        return;
      }
      if (!Array.isArray(claimRows) || claimRows.length === 0) {
        return;
      }
      const { error: roomStateError } = await client.from("bclt_room_states").update({ host_member_id: selfId, updated_at: nowIso }).eq("room_id", state.settings.roomId).eq("host_member_id", currentHostId);
      if (roomStateError) {
        console.warn("[BCLT] host offline fallback room state update failed:", roomStateError.message);
      }
      const { error: clearHostError } = await client.from("bclt_room_members").update({ is_host: false }).eq("room_id", state.settings.roomId);
      if (clearHostError) {
        console.warn("[BCLT] host offline fallback clear host flag failed:", clearHostError.message);
      }
      const { error: setHostError } = await client.from("bclt_room_members").update({ is_host: true, last_seen_at: nowIso }).eq("room_id", state.settings.roomId).eq("member_id", selfId);
      if (setHostError) {
        console.warn("[BCLT] host offline fallback set host flag failed:", setHostError.message);
      }
      state.settings.roomHostMemberId = selfId;
      state.settings.isHost = true;
      state.currentRoomHostName = effectiveDisplayName();
      state.roomAdminMemberIds = state.roomAdminMemberIds.filter((id) => String(id || "").trim() !== selfId);
      saveSettings();
      await publish("room_control", {
        action: "ownership_transferred",
        roomId: state.settings.roomId,
        previousHostMemberId: currentHostId,
        newHostMemberId: selfId,
        newHostDisplayName: effectiveDisplayName(),
        adminMemberIds: [...state.roomAdminMemberIds],
        at: Date.now()
      });
      logStatus("Host offline detected. Fallback promoted you to host.");
    } catch (error) {
      console.warn("[BCLT] host offline fallback failed:", error);
    } finally {
      hostOfflineFallbackInFlight = false;
    }
  }
  function startRuntimeLoops(client) {
    stopRuntimeLoops();
    state.syncTimer = window.setInterval(async () => {
      if (!state.connected || !state.settings.isHost) return;
      if (state.settings.syncPlaybackProgress === false) return;
      const mediaState = readLocalMediaState();
      if (!mediaState) return;
      await publish("media_state", mediaState);
      await syncSnapshotToTable(client);
    }, 1e3);
    state.heartbeatTimer = window.setInterval(async () => {
      if (!state.connected || !state.channel) return;
      await state.channel.track({
        id: memberId(),
        name: effectiveDisplayName(),
        isHost: !!state.settings.isHost,
        at: nowMs()
      });
      await upsertRoomMember(client);
      if (state.settings.isHost) {
        await touchRoom(client);
      } else {
        await maybePromoteSelfOnHostOffline(client);
      }
    }, 1e4);
  }
  function stopRuntimeLoops() {
    if (state.syncTimer) {
      clearInterval(state.syncTimer);
      state.syncTimer = null;
    }
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  }
  class DraggableWindow {
    constructor(options = {}) {
      this.title = options.title || "Window";
      this.width = options.width || 800;
      this.height = options.height || 600;
      this.minWidth = options.minWidth || 360;
      this.minHeight = options.minHeight || 280;
      this.x = options.x || 100;
      this.y = options.y || 100;
      this.isDragging = false;
      this.isResizing = false;
      this.isMinimized = false;
      this.dragOffsetX = 0;
      this.dragOffsetY = 0;
      this.resizeStartX = 0;
      this.resizeStartY = 0;
      this.resizeStartWidth = this.width;
      this.resizeStartHeight = this.height;
      this.container = null;
      this.content = null;
      this.headerEl = null;
      this.resizerEl = null;
      this.onMinimizeChanged = typeof options.onMinimizeChanged === "function" ? options.onMinimizeChanged : null;
    }
    clampPosition() {
      if (!this.container) return;
      const viewportPadding = 16;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const rect = this.container.getBoundingClientRect();
      const containerWidth = rect.width || this.width;
      const containerHeight = rect.height || this.height;
      this.x = Math.min(Math.max(this.x, viewportPadding), Math.max(viewportPadding, viewportWidth - containerWidth - viewportPadding));
      this.y = Math.min(Math.max(this.y, viewportPadding), Math.max(viewportPadding, viewportHeight - containerHeight - viewportPadding));
      this.container.style.left = this.x + "px";
      this.container.style.top = this.y + "px";
    }
    create() {
      this.container = document.createElement("div");
      this.container.id = "bclt-window";
      this.container.className = "bclt-shell";
      const viewportPadding = 16;
      const maxWidth = Math.max(320, window.innerWidth - viewportPadding * 2);
      const maxHeight = Math.max(320, window.innerHeight - viewportPadding * 2);
      this.width = Math.min(this.width, maxWidth);
      this.height = Math.min(this.height, maxHeight);
      this.container.style.position = "fixed";
      this.container.style.left = this.x + "px";
      this.container.style.top = this.y + "px";
      this.container.style.width = this.width + "px";
      this.container.style.height = this.height + "px";
      this.container.style.zIndex = "100000";
      this.container.style.background = "var(--bclt-surface)";
      this.container.style.border = "1px solid var(--bclt-border)";
      this.container.style.borderRadius = "18px";
      this.container.style.boxShadow = "0 22px 48px rgba(6, 12, 24, 0.56)";
      this.container.style.color = "var(--bclt-text-main)";
      this.container.style.fontFamily = "'Sora', 'Avenir Next', 'Noto Sans SC', 'Microsoft YaHei UI', sans-serif";
      this.container.style.display = "flex";
      this.container.style.flexDirection = "column";
      this.container.style.overflow = "hidden";
      this.container.style.backdropFilter = "blur(14px)";
      this.container.style.animation = "bclt-window-enter 220ms ease-out";
      this.container.style.minWidth = this.minWidth + "px";
      this.container.style.minHeight = this.minHeight + "px";
      this.headerEl = document.createElement("div");
      this.headerEl.className = "bclt-window-header";
      this.headerEl.style.padding = "14px 16px";
      this.headerEl.style.display = "flex";
      this.headerEl.style.alignItems = "center";
      this.headerEl.style.justifyContent = "space-between";
      this.headerEl.style.borderBottom = "1px solid var(--bclt-border-soft)";
      this.headerEl.style.fontSize = "14px";
      this.headerEl.style.fontWeight = "800";
      this.headerEl.style.cursor = "move";
      this.headerEl.style.userSelect = "none";
      const title = document.createElement("span");
      title.className = "bclt-window-title";
      title.textContent = this.title;
      this.headerEl.appendChild(title);
      const actions = document.createElement("div");
      actions.className = "bclt-window-actions";
      actions.style.display = "flex";
      actions.style.alignItems = "center";
      actions.style.gap = "8px";
      const languageSelect = document.createElement("select");
      languageSelect.id = "bclt-language-select";
      languageSelect.className = "bclt-language-select";
      languageSelect.title = t("language_label");
      languageSelect.style.height = "30px";
      languageSelect.style.borderRadius = "8px";
      languageSelect.style.border = "1px solid rgba(255,255,255,0.18)";
      languageSelect.style.background = "rgba(255,255,255,0.05)";
      languageSelect.style.color = "var(--bclt-text-main)";
      languageSelect.style.padding = "0 8px";
      languageSelect.style.fontSize = "12px";
      languageSelect.style.cursor = "pointer";
      Object.entries(SUPPORTED_LANGS).forEach(([lang, label]) => {
        const option = document.createElement("option");
        option.value = lang;
        option.textContent = label;
        option.style.color = "#0f172a";
        languageSelect.appendChild(option);
      });
      languageSelect.value = getLanguage();
      languageSelect.addEventListener("change", () => {
        applyLanguage(languageSelect.value);
      });
      actions.appendChild(languageSelect);
      const closeBtn = document.createElement("button");
      closeBtn.className = "bclt-close-btn";
      closeBtn.textContent = "×";
      closeBtn.type = "button";
      closeBtn.onclick = () => this.close();
      const minimizeBtn = document.createElement("button");
      minimizeBtn.className = "bclt-minimize-btn";
      minimizeBtn.id = "bclt-minimize-btn";
      minimizeBtn.textContent = "−";
      minimizeBtn.type = "button";
      minimizeBtn.onclick = () => this.toggleMinimize();
      actions.appendChild(minimizeBtn);
      actions.appendChild(closeBtn);
      this.headerEl.appendChild(actions);
      this.container.appendChild(this.headerEl);
      this.content = document.createElement("div");
      this.content.className = "bclt-window-content";
      this.content.style.flex = "1";
      this.content.style.overflow = "auto";
      this.content.style.padding = "14px";
      this.container.appendChild(this.content);
      this.resizerEl = document.createElement("div");
      this.resizerEl.className = "bclt-window-resizer";
      this.container.appendChild(this.resizerEl);
      this.headerEl.addEventListener("mousedown", (e) => this.onDragStart(e));
      this.resizerEl.addEventListener("mousedown", (e) => this.onResizeStart(e));
      document.addEventListener("mousemove", (e) => this.onDragMove(e));
      document.addEventListener("mousemove", (e) => this.onResizeMove(e));
      document.addEventListener("mouseup", () => this.onDragEnd());
      document.addEventListener("mouseup", () => this.onResizeEnd());
      return this.container;
    }
    onDragStart(e) {
      if (this.isResizing || this.isMinimized) return;
      if (e.target && typeof e.target.closest === "function" && (e.target.closest(".bclt-close-btn") || e.target.closest(".bclt-minimize-btn") || e.target.closest(".bclt-language-select"))) return;
      this.isDragging = true;
      this.dragOffsetX = e.clientX - this.x;
      this.dragOffsetY = e.clientY - this.y;
      this.container.classList.add("dragging");
    }
    onDragMove(e) {
      if (!this.isDragging || !this.container || this.isResizing) return;
      this.x = e.clientX - this.dragOffsetX;
      this.y = e.clientY - this.dragOffsetY;
      this.clampPosition();
    }
    onDragEnd() {
      this.isDragging = false;
      if (this.container) {
        this.container.classList.remove("dragging");
        this.clampPosition();
      }
    }
    onResizeStart(e) {
      if (!this.container || this.isMinimized) return;
      e.preventDefault();
      e.stopPropagation();
      this.isResizing = true;
      this.resizeStartX = e.clientX;
      this.resizeStartY = e.clientY;
      this.resizeStartWidth = this.container.offsetWidth;
      this.resizeStartHeight = this.container.offsetHeight;
      this.container.classList.add("resizing");
    }
    onResizeMove(e) {
      if (!this.isResizing || !this.container) return;
      const viewportPadding = 16;
      const maxWidth = Math.max(this.minWidth, window.innerWidth - this.x - viewportPadding);
      const maxHeight = Math.max(this.minHeight, window.innerHeight - this.y - viewportPadding);
      const nextWidth = this.resizeStartWidth + (e.clientX - this.resizeStartX);
      const nextHeight = this.resizeStartHeight + (e.clientY - this.resizeStartY);
      this.width = Math.min(Math.max(this.minWidth, nextWidth), maxWidth);
      this.height = Math.min(Math.max(this.minHeight, nextHeight), maxHeight);
      this.container.style.width = this.width + "px";
      this.container.style.height = this.height + "px";
      this.clampPosition();
    }
    onResizeEnd() {
      if (!this.isResizing) return;
      this.isResizing = false;
      if (this.container) {
        this.container.classList.remove("resizing");
        this.clampPosition();
      }
    }
    setMinimized(nextMinimized) {
      var _a;
      const shouldMinimize = !!nextMinimized;
      if (!this.container || shouldMinimize === this.isMinimized) return;
      this.isMinimized = shouldMinimize;
      this.container.classList.toggle("is-minimized", shouldMinimize);
      this.container.style.display = shouldMinimize ? "none" : "flex";
      const minimizeBtn = (_a = this.headerEl) == null ? void 0 : _a.querySelector("#bclt-minimize-btn");
      if (minimizeBtn) {
        minimizeBtn.title = shouldMinimize ? t("window_restore") : t("window_minimize");
      }
      if (this.onMinimizeChanged) {
        this.onMinimizeChanged(shouldMinimize);
      }
    }
    toggleMinimize() {
      this.setMinimized(!this.isMinimized);
    }
    setContent(html) {
      if (this.content) {
        this.content.innerHTML = html;
      }
    }
    setTitle(nextTitle) {
      var _a, _b;
      this.title = nextTitle;
      const titleEl = ((_a = this.headerEl) == null ? void 0 : _a.querySelector(".bclt-window-title")) || ((_b = this.headerEl) == null ? void 0 : _b.querySelector("span"));
      if (titleEl) {
        titleEl.textContent = nextTitle;
      }
    }
    show() {
      if (!this.container) return;
      if (this.container.parentNode === null) {
        document.body.appendChild(this.container);
      }
      this.setMinimized(false);
      this.clampPosition();
    }
    close() {
      if (this.container && this.container.parentNode) {
        this.setMinimized(false);
        this.container.parentNode.removeChild(this.container);
      }
    }
  }
  let windowInstance = null;
  let buttonElement = null;
  let activeVideos = [];
  let playbackUiTimer = null;
  let playbackSeekMaxSeconds = 3600;
  let autoAdvanceTriggerToken = "";
  let autoAdvanceInFlight = false;
  let highQualityPlaybackTab = null;
  let highQualityTabSessionOpened = false;
  let highQualityTabLastSyncAt = 0;
  let nowPlayingHighlightToken = "";
  const bilibiliVideoTitleTaskByBvid = /* @__PURE__ */ new Map();
  let isDraggingMainButton = false;
  let suppressNextMainButtonClick = false;
  const mainButtonDragState = {
    dragging: false,
    moved: false,
    startX: 0,
    startY: 0,
    startLeft: 0,
    startTop: 0
  };
  const SUPPORTED_LANGS = {
    zh: "中文",
    en: "EN"
  };
  const HQ_TAB_REMOTE_DRIFT_THRESHOLD_SECONDS = 12;
  const HQ_TAB_REMOTE_SYNC_COOLDOWN_MS = 1e4;
  const HQ_TAB_WINDOW_NAME = "bclt_hq_player";
  const HQ_TAB_WINDOW_FEATURES = "width=1280,height=720,left=100,top=100,resizable=yes,scrollbars=yes";
  const PLAYLIST_REQUEST_RETRY_DELAY_MS = 1500;
  const PLAYLIST_REQUEST_RETRY_MAX_ATTEMPTS = 5;
  let playlistSnapshotPending = false;
  let playlistRequestRetryTimer = null;
  let playlistRequestAttempts = 0;
  const I18N = {
    zh: {
      mode_list_loop: "列表循环",
      mode_single_loop: "单曲循环",
      mode_shuffle: "随机播放",
      role_host: "房主",
      role_admin: "管理员",
      role_member: "成员",
      window_rooms_title: "BC 一起听 - 房间",
      window_player_title: "BC 一起听 - 播放器",
      hq_placeholder: "已启用高画质标签页模式。播放会在 Bilibili 标签页中进行。",
      language_label: "语言",
      window_minimize: "最小化",
      window_restore: "还原",
      host_only_change_mode: "仅房主可切换播放模式",
      host_only_permission: "仅房主可管理房主/管理员权限",
      host_admin_add_video: "仅房主/管理员可添加视频",
      host_admin_import_playlist: "仅房主/管理员可导入歌单",
      host_only_skip: "仅房主可切歌",
      skip_to_next: "切到下一首",
      failed_build_watch_url: "构建 Bilibili 播放链接失败。",
      popup_blocked: "无法打开窗口（可能被浏览器拦截弹窗），请允许当前站点弹窗。",
      room_available_rooms: "可用房间",
      room_refresh: "刷新",
      room_create_room: "创建房间",
      room_host_badge: "房主",
      room_name_label: "房间名（房间 ID）",
      room_name_placeholder: "请输入唯一房间名",
      room_passcode_label: "房间密码（可选）",
      room_passcode_placeholder: "可选密码",
      room_create_btn: "创建房间",
      room_loading: "正在加载房间...",
      room_none: "暂无可用房间",
      room_loaded_count: "已加载 {count} 个房间",
      room_load_error: "加载房间失败",
      room_locked: "加锁房间",
      room_host_prefix: "房主",
      room_online_count: "{count} 人在线",
      passcode_prompt: "请输入房间密码：{roomName}",
      passcode_required: "该房间已加锁，必须输入密码。",
      unknown_room: "未知房间",
      toolbar_host: "房主",
      alert_enter_room_name: "请输入房间名称。",
      create_room_failed: "创建房间失败：{message}",
      no_active_members: "当前房间没有活跃成员。",
      select_one_host: "请选择一位房主。",
      permissions_updated_transferred: "权限已更新并已转移房主",
      admin_permissions_updated: "管理员权限已更新",
      ownership_transferred_to: "房主已转移给 {name}",
      player_no_video_playing: "当前未播放视频",
      player_sync_progress: "同步播放进度",
      player_hq_mode: "高画质标签页模式（GM_openInTab）",
      player_immersive_mode: "沉浸模式（仅播放器）",
      immersive_exit: "退出沉浸",
      immersive_mode_on: "沉浸模式已开启",
      immersive_mode_off: "沉浸模式已关闭",
      player_status_ready: "准备就绪",
      player_shared_videos: "共享视频",
      player_add_placeholder: "粘贴 Bilibili 链接或 BV 号",
      player_add_btn: "+ 添加",
      player_add_local_btn: "添加本地视频",
      player_import_btn: "导入 JSON",
      player_export_btn: "导出 JSON",
      player_register_local_btn: "注册本地视频",
      player_mode_title: "播放模式",
      player_manage_permissions: "房主/管理员权限",
      permission_modal_sub: "活跃成员（包含你自己）。房主为单选，管理员为多选。",
      permission_close: "关闭",
      permission_cancel: "取消",
      permission_save: "保存更改",
      permission_note: "显示名 = 成员记录中的注册显示名。",
      leave: "离开",
      only_host_manage_permissions: "仅房主可管理权限。",
      only_host_admin_add_video: "仅房主/管理员可添加视频。",
      input_bv_hint: "请输入 Bilibili 链接或 BV 号",
      progress_sync_on: "进度同步：开启",
      progress_sync_off: "进度同步：关闭",
      hq_mode_on: "高画质标签页模式已开启",
      hq_mode_off: "高画质标签页模式已关闭",
      hq_paused_parked: "高画质暂停：已停靠弹窗",
      play_mode_updated: "播放模式已更新",
      no_next_video: "没有可播放的下一条视频",
      auto_mode_prefix: "自动",
      skip_mode_prefix: "切换",
      current_deleted_switched: "当前视频已删除，已切到下一条",
      video_delete: "删除",
      delete_video_title: "从播放列表删除该视频",
      only_host_admin_delete_video: "仅房主/管理员可删除视频",
      now_playing: "正在播放",
      no_videos_shared: "还没有人分享视频",
      playback_paused: "暂停",
      playback_playing: "播放中",
      action_play: "播放",
      action_pause: "暂停",
      mode_set: "播放模式：{mode}",
      connected_sync: "同步",
      ready: "准备就绪",
      select_video_first: "请先在共享视频里选择一个视频。",
      host_changed_to: "房主已切换为 {name}",
      now_you_are_host: "你已成为房主",
      admins_synced: "管理员已同步",
      play_mode_synced: "播放模式已同步",
      playlist_updated: "播放列表已更新",
      playlist_exported: "歌单已导出为 JSON",
      playlist_import_invalid_json: "导入失败：JSON 格式无效",
      playlist_import_empty: "导入失败：未找到可导入的视频条目",
      playlist_import_result: "歌单导入完成：成功 {success} 条，失败 {failed} 条",
      local_video_register_invalid: "请选择有效的视频文件",
      local_video_register_none: "未选择本地视频文件",
      local_video_register_result: "本地视频注册完成：{count} 个",
      local_video_registered: "已注册本地视频：{title}"
    },
    en: {
      mode_list_loop: "List Loop",
      mode_single_loop: "Single Loop",
      mode_shuffle: "Shuffle",
      role_host: "Host",
      role_admin: "Admin",
      role_member: "Member",
      window_rooms_title: "BC Listen Together - Rooms",
      window_player_title: "BC Listen Together - Player",
      hq_placeholder: "High-Quality Tab Mode is active. Playback is opened in Bilibili tab.",
      language_label: "Language",
      window_minimize: "Minimize",
      window_restore: "Restore",
      host_only_change_mode: "Only host can change play mode",
      host_only_permission: "Only host can manage host/admin permissions",
      host_admin_add_video: "Only host/admin can add videos",
      host_admin_import_playlist: "Only host/admin can import playlists",
      host_only_skip: "Only host can skip tracks",
      skip_to_next: "Skip to next video",
      failed_build_watch_url: "Failed to build Bilibili watch URL.",
      popup_blocked: "Failed to open window (popup may be blocked). Allow popups for this site.",
      room_available_rooms: "Available Rooms",
      room_refresh: "Refresh",
      room_create_room: "Create Room",
      room_host_badge: "Host",
      room_name_label: "Room Name (Room ID)",
      room_name_placeholder: "Enter a unique room name",
      room_passcode_label: "Room Passcode (Optional)",
      room_passcode_placeholder: "optional passcode",
      room_create_btn: "Create Room",
      room_loading: "Loading rooms...",
      room_none: "No rooms available",
      room_loaded_count: "Loaded {count} room(s)",
      room_load_error: "Error loading rooms",
      room_locked: "Locked room",
      room_host_prefix: "host",
      room_online_count: "{count} online",
      passcode_prompt: "Enter passcode for room: {roomName}",
      passcode_required: "This room is locked. Passcode is required.",
      unknown_room: "Unknown Room",
      toolbar_host: "Host",
      alert_enter_room_name: "Please enter a room name.",
      create_room_failed: "Failed to create room: {message}",
      no_active_members: "No active members found in this room.",
      select_one_host: "Please select one host.",
      permissions_updated_transferred: "Permissions updated and ownership transferred",
      admin_permissions_updated: "Admin permissions updated",
      ownership_transferred_to: "Ownership transferred to {name}",
      player_no_video_playing: "No video playing",
      player_sync_progress: "Sync Playback Progress",
      player_hq_mode: "High-Quality Tab Mode (GM_openInTab)",
      player_immersive_mode: "Immersive Mode (Player Only)",
      immersive_exit: "Exit Immersive",
      immersive_mode_on: "Immersive mode on",
      immersive_mode_off: "Immersive mode off",
      player_status_ready: "Ready",
      player_shared_videos: "Shared Videos",
      player_add_placeholder: "Paste Bilibili URL or BV",
      player_add_btn: "+ Add",
      player_add_local_btn: "Add Local Video",
      player_import_btn: "Import JSON",
      player_export_btn: "Export JSON",
      player_register_local_btn: "Register Local Video",
      player_mode_title: "Playback mode",
      player_manage_permissions: "Host/Admin Permissions",
      permission_modal_sub: "Active members (including yourself). Host is single-select, Admin is multi-select.",
      permission_close: "Close",
      permission_cancel: "Cancel",
      permission_save: "Save Changes",
      permission_note: "Display Name = registered display name in room member records.",
      leave: "Leave",
      only_host_manage_permissions: "Only host can manage permissions.",
      only_host_admin_add_video: "Only host/admin can add videos.",
      input_bv_hint: "Please input a Bilibili URL or BV",
      progress_sync_on: "Progress sync on",
      progress_sync_off: "Progress sync off",
      hq_mode_on: "HQ tab mode on",
      hq_mode_off: "HQ tab mode off",
      hq_paused_parked: "HQ paused: popup parked",
      play_mode_updated: "Play mode updated",
      no_next_video: "No next video available",
      auto_mode_prefix: "Auto",
      skip_mode_prefix: "Skip",
      current_deleted_switched: "Current video deleted, switched to next",
      video_delete: "Delete",
      delete_video_title: "Delete this video from playlist",
      only_host_admin_delete_video: "Only host/admin can delete videos",
      now_playing: "Now Playing",
      no_videos_shared: "No videos shared yet",
      playback_paused: "Paused",
      playback_playing: "Playing",
      action_play: "Play",
      action_pause: "Pause",
      mode_set: "Mode set: {mode}",
      connected_sync: "sync",
      ready: "Ready",
      select_video_first: "Please select a video from Shared Videos first.",
      host_changed_to: "Host changed to {name}",
      now_you_are_host: "You are now host",
      admins_synced: "Admins synced",
      play_mode_synced: "Play mode synced",
      playlist_updated: "Playlist updated",
      playlist_exported: "Playlist exported as JSON",
      playlist_import_invalid_json: "Import failed: invalid JSON format",
      playlist_import_empty: "Import failed: no valid video entries found",
      playlist_import_result: "Playlist import complete: {success} succeeded, {failed} failed",
      local_video_register_invalid: "Please select a valid video file",
      local_video_register_none: "No local video selected",
      local_video_register_result: "Local video registration complete: {count}",
      local_video_registered: "Local video registered: {title}"
    }
  };
  function normalizeLanguage(language) {
    const key = String(language || "").toLowerCase();
    return SUPPORTED_LANGS[key] ? key : "zh";
  }
  function getLanguage() {
    const normalized = normalizeLanguage(state.settings.language);
    if (state.settings.language !== normalized) {
      state.settings.language = normalized;
      saveSettings();
    }
    return normalized;
  }
  function t(key, vars = {}) {
    const lang = getLanguage();
    const table = I18N[lang] || I18N.en;
    const fallback = I18N.en || {};
    const template = table[key] || fallback[key] || key;
    return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
  }
  function applyLanguage(nextLanguage) {
    const normalized = normalizeLanguage(nextLanguage);
    if (normalized === state.settings.language) return;
    state.settings.language = normalized;
    saveSettings();
    if (windowInstance == null ? void 0 : windowInstance.headerEl) {
      const selector = windowInstance.headerEl.querySelector("#bclt-language-select");
      if (selector) selector.value = normalized;
    }
    refreshLocalizedUi();
  }
  function refreshLocalizedUi() {
    var _a, _b, _c, _d;
    const selector = (_a = windowInstance == null ? void 0 : windowInstance.headerEl) == null ? void 0 : _a.querySelector("#bclt-language-select");
    if (selector) selector.title = t("language_label");
    const minimizeBtn = (_b = windowInstance == null ? void 0 : windowInstance.headerEl) == null ? void 0 : _b.querySelector("#bclt-minimize-btn");
    if (minimizeBtn) {
      minimizeBtn.title = (windowInstance == null ? void 0 : windowInstance.isMinimized) ? t("window_restore") : t("window_minimize");
    }
    const roomMode = (_c = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _c.querySelector("#bclt-room-list");
    const playerMode = (_d = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _d.querySelector("#bclt-player-container");
    if (roomMode) {
      showRoomListMode();
      return;
    }
    if (playerMode) {
      refreshPlayerLocalizedText();
    }
  }
  function refreshPlayerLocalizedText() {
    var _a, _b;
    const content = windowInstance == null ? void 0 : windowInstance.content;
    if (!content) return;
    const titleEl = (_a = windowInstance == null ? void 0 : windowInstance.headerEl) == null ? void 0 : _a.querySelector(".bclt-window-title");
    if (titleEl) titleEl.textContent = t("window_player_title");
    const leaveBtn = (_b = windowInstance == null ? void 0 : windowInstance.headerEl) == null ? void 0 : _b.querySelector("#bclt-toolbar-leave");
    if (leaveBtn) leaveBtn.textContent = t("leave");
    const syncLabel = content.querySelector('label[for="bclt-sync-progress"] span');
    if (syncLabel) syncLabel.textContent = t("player_sync_progress");
    const hqLabel = content.querySelector('label[for="bclt-hq-tab-mode"] span');
    if (hqLabel) hqLabel.textContent = t("player_hq_mode");
    const immersiveLabel = content.querySelector('label[for="bclt-immersive-mode"] span');
    if (immersiveLabel) immersiveLabel.textContent = t("player_immersive_mode");
    const immersiveExitBtn = content.querySelector("#bclt-btn-exit-immersive");
    if (immersiveExitBtn) {
      immersiveExitBtn.textContent = t("immersive_exit");
      immersiveExitBtn.title = t("immersive_exit");
    }
    const videoTitleEl = content.querySelector(".video-list-title");
    if (videoTitleEl) videoTitleEl.textContent = t("player_shared_videos");
    const addBtn = content.querySelector("#bclt-btn-add-video");
    if (addBtn) addBtn.textContent = t("player_add_btn");
    const addLocalBtn = content.querySelector("#bclt-btn-add-local-video");
    if (addLocalBtn) addLocalBtn.textContent = t("player_add_local_btn");
    const importBtn = content.querySelector("#bclt-btn-import-playlist");
    if (importBtn) importBtn.textContent = t("player_import_btn");
    const exportBtn = content.querySelector("#bclt-btn-export-playlist");
    if (exportBtn) exportBtn.textContent = t("player_export_btn");
    const registerLocalBtn = content.querySelector("#bclt-btn-register-local-video");
    if (registerLocalBtn) registerLocalBtn.textContent = t("player_register_local_btn");
    const addInput = content.querySelector("#bclt-add-video-input");
    if (addInput) addInput.placeholder = t("player_add_placeholder");
    const modeSlider = content.querySelector("#bclt-mode-slider");
    if (modeSlider) modeSlider.title = t("player_mode_title");
    content.querySelectorAll(".mode-slider-btn").forEach((btn) => {
      const mode = String(btn.getAttribute("data-mode") || "list");
      if (mode === "single") btn.title = t("mode_single_loop");
      else if (mode === "shuffle") btn.title = t("mode_shuffle");
      else btn.title = t("mode_list_loop");
    });
    const manageBtn = content.querySelector("#bclt-btn-manage-permissions");
    if (manageBtn) manageBtn.textContent = t("player_manage_permissions");
    updateVideoList();
    updatePlaybackUi();
    refreshHostUiPrivileges();
  }
  const PLAYBACK_MODES = {
    list: { labelKey: "mode_list_loop", icon: "🔁" },
    single: { labelKey: "mode_single_loop", icon: "🔂" },
    shuffle: { labelKey: "mode_shuffle", icon: "🔀" }
  };
  function normalizePlaybackMode(mode) {
    const key = String(mode || "").toLowerCase();
    return PLAYBACK_MODES[key] ? key : "list";
  }
  function getPlaybackModeLabel(mode = state.settings.playbackMode) {
    const normalized = normalizePlaybackMode(mode);
    return t(PLAYBACK_MODES[normalized].labelKey);
  }
  function normalizeAdminMemberIds(ids, hostMemberId = state.settings.roomHostMemberId || memberId()) {
    const hostId = String(hostMemberId || "").trim();
    const unique = /* @__PURE__ */ new Set();
    (Array.isArray(ids) ? ids : []).forEach((id) => {
      const normalized = String(id || "").trim();
      if (!normalized || normalized === hostId) return;
      unique.add(normalized);
    });
    return Array.from(unique);
  }
  function setRoomAdminMemberIds(ids, hostMemberId = state.settings.roomHostMemberId || memberId()) {
    state.roomAdminMemberIds = normalizeAdminMemberIds(ids, hostMemberId);
  }
  function isCurrentMemberAdmin() {
    return state.roomAdminMemberIds.includes(memberId());
  }
  function canManagePlaylist() {
    return !!state.settings.isHost || isCurrentMemberAdmin();
  }
  function roleLabel() {
    if (state.settings.isHost) return t("role_host");
    if (isCurrentMemberAdmin()) return t("role_admin");
    return t("role_member");
  }
  function isSyncControlLocked() {
    return !state.settings.isHost && state.settings.syncPlaybackProgress !== false;
  }
  function isHighQualityTabModeEnabled() {
    return state.settings.highQualityTabMode === true;
  }
  function isImmersiveModeEnabled() {
    return state.settings.immersiveMode === true;
  }
  function applyImmersiveModeUi(enabled) {
    if (!(windowInstance == null ? void 0 : windowInstance.container)) return;
    const immersive = !!enabled;
    windowInstance.container.classList.toggle("bclt-immersive-mode", immersive);
    if (immersive) {
      resizeWindowForMode(960, 600);
    } else {
      resizeWindowForMode(1e3, 680);
    }
  }
  function setImmersiveMode(enabled, options = {}) {
    var _a, _b;
    const { save = true, statusHint = "" } = options;
    const immersive = !!enabled;
    state.settings.immersiveMode = immersive;
    if (save) saveSettings();
    const immersiveCheckbox = (_a = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _a.querySelector("#bclt-immersive-mode");
    if (immersiveCheckbox) immersiveCheckbox.checked = immersive;
    const exitBtn = (_b = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _b.querySelector("#bclt-btn-exit-immersive");
    if (exitBtn) {
      exitBtn.textContent = t("immersive_exit");
      exitBtn.title = t("immersive_exit");
    }
    applyImmersiveModeUi(immersive);
    if (statusHint) updatePlaybackUi(statusHint);
  }
  function closeHighQualityPlaybackTab(options = {}) {
    const { destroySession = false, blankUrl = "about:blank" } = options;
    const tryRetargetByName = () => {
      if (!highQualityTabSessionOpened) return null;
      try {
        return window.open(blankUrl, HQ_TAB_WINDOW_NAME, HQ_TAB_WINDOW_FEATURES);
      } catch (error) {
        return null;
      }
    };
    let handle = highQualityPlaybackTab;
    if (!handle && !highQualityTabSessionOpened) {
      return;
    }
    if (!handle) {
      handle = tryRetargetByName();
    }
    if (!handle) {
      highQualityPlaybackTab = null;
      if (destroySession) {
        highQualityTabSessionOpened = false;
        highQualityTabLastSyncAt = 0;
      }
      return;
    }
    try {
      if (destroySession) {
        const target = tryRetargetByName() || handle;
        if (target && typeof target.close === "function") {
          target.close();
        }
        highQualityPlaybackTab = null;
        highQualityTabSessionOpened = false;
        highQualityTabLastSyncAt = 0;
        return;
      }
      try {
        handle.location.href = blankUrl;
      } catch (error) {
        const retargeted = tryRetargetByName();
        if (retargeted) {
          handle = retargeted;
        }
      }
      highQualityPlaybackTab = handle;
      highQualityTabSessionOpened = true;
      try {
        window.focus();
      } catch (focusError) {
        console.warn("[BCLT] focus main window after parking popup failed:", focusError.message);
      }
    } catch (error) {
      console.warn("[BCLT] close high-quality playback tab failed:", error);
      highQualityPlaybackTab = null;
    }
  }
  function readBilibiliPageFromUrl(sourceUrl) {
    try {
      const parsed = new URL(String(sourceUrl || "").trim());
      const page = Number(parsed.searchParams.get("p") || 1);
      return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    } catch (error) {
      return 1;
    }
  }
  function normalizeBilibiliSourceForSync(sourceUrl) {
    const source = String(sourceUrl || "").trim();
    if (!source) return "";
    const youtubeId = parseYouTubeVideoId(source);
    if (youtubeId || isYouTubeUrl(source)) {
      const normalized = normalizeYouTubeSourceUrl(source);
      const normalizedId = parseYouTubeVideoId(normalized) || youtubeId;
      return normalizedId ? `yt:${normalizedId}:t1` : normalized;
    }
    const bvid = parseBilibiliBvid(source);
    if (bvid) {
      return `bvid:${String(bvid)}:p${readBilibiliPageFromUrl(source)}:t1`;
    }
    try {
      const url = new URL(source);
      url.searchParams.delete("autoplay");
      url.searchParams.set("t", "1");
      url.hash = "";
      return url.toString();
    } catch (error) {
      return source;
    }
  }
  const DIRECT_MEDIA_URL_RE = /\.(mp4|webm|ogg|m3u8|mkv|mov|flv|mp3|m4a|aac|wav|flac|opus|oga|weba)(\?|#|$)/i;
  function isDirectMediaUrl(sourceUrl) {
    const source = String(sourceUrl || "").trim();
    if (!source) return false;
    return DIRECT_MEDIA_URL_RE.test(source);
  }
  function isSupportedLocalMediaFile(file) {
    if (!file) return false;
    const mime = String(file.type || "").toLowerCase();
    if (mime.startsWith("video/") || mime.startsWith("audio/")) return true;
    const fileName = String(file.name || "");
    return DIRECT_MEDIA_URL_RE.test(fileName);
  }
  function detectMediaKind(sourceUrl) {
    const source = String(sourceUrl || "").trim();
    if (!source) return "bilibili";
    if (source.startsWith("local://")) return "local_video";
    if (parseYouTubeVideoId(source) || isYouTubeUrl(source)) return "youtube";
    if (isDirectMediaUrl(source)) return "video";
    return "bilibili";
  }
  function resolveLocalVideoObjectUrlByHash(fileHash) {
    const key = String(fileHash || "").trim();
    if (!key) return "";
    const entry = localVideoFilesByHash.get(key);
    if (!entry || !entry.file) return "";
    if (entry.objectUrl) return String(entry.objectUrl);
    const objectUrl = URL.createObjectURL(entry.file);
    localVideoFilesByHash.set(key, {
      ...entry,
      objectUrl
    });
    return objectUrl;
  }
  function buildBilibiliWatchUrl(sourceUrl, currentTime = 0, { autoplay = true } = {}) {
    const source = String(sourceUrl || "").trim();
    if (!source) return null;
    const mediaKind = detectMediaKind(source);
    if (mediaKind === "local_video") {
      const fileHash = source.replace("local://", "");
      const localObjectUrl = resolveLocalVideoObjectUrlByHash(fileHash);
      if (!localObjectUrl) return null;
      const seconds = Math.max(1, Math.floor(Number(currentTime) || 0));
      return `${localObjectUrl}#t=${seconds}`;
    }
    const youtubeWatchUrl = buildYouTubeWatchUrl(source, currentTime, { autoplay });
    if (youtubeWatchUrl) {
      return youtubeWatchUrl;
    }
    const bvid = parseBilibiliBvid(source);
    const baseUrl = bvid ? `https://www.bilibili.com/video/${bvid}` : source;
    try {
      const url = new URL(baseUrl);
      const page = readBilibiliPageFromUrl(source);
      if (page > 1) {
        url.searchParams.set("p", String(page));
      }
      const seconds = Math.max(1, Math.floor(Number(currentTime) || 0));
      if (mediaKind === "video") {
        url.hash = `#t=${seconds}`;
        return url.toString();
      }
      url.searchParams.set("t", String(seconds));
      if (autoplay) {
        url.searchParams.set("autoplay", "1");
      }
      return url.toString();
    } catch (error) {
      return null;
    }
  }
  function canUseHighQualityTabForSource(sourceUrl, currentTime = 0) {
    const source = String(sourceUrl || "").trim();
    if (!source) return false;
    if (detectMediaKind(source) === "youtube") return false;
    return !!buildBilibiliWatchUrl(source, currentTime, { autoplay: true });
  }
  function updateOrOpenHighQualityPlaybackTab(sourceUrl, currentTime, { autoplay = true, allowOpen = true } = {}) {
    var _a;
    console.log("[BCLT] updateOrOpenHighQualityPlaybackTab called", { sourceUrl, currentTime, autoplay, allowOpen, hasWindow: !!highQualityPlaybackTab });
    const watchUrl = buildBilibiliWatchUrl(sourceUrl, currentTime, { autoplay });
    if (!watchUrl) {
      const msg = t("failed_build_watch_url");
      console.warn("[BCLT]", msg);
      return { ok: false, message: msg };
    }
    console.log("[BCLT] Watch URL built:", watchUrl);
    let hadExistingTab = false;
    try {
      if (highQualityPlaybackTab && !highQualityPlaybackTab.closed) {
        hadExistingTab = true;
        highQualityTabSessionOpened = true;
        const existingHref = String(((_a = highQualityPlaybackTab.location) == null ? void 0 : _a.href) || "");
        if (existingHref === watchUrl) {
          console.log("[BCLT] Popup already on target URL, skip navigation.");
          return { ok: true, watchUrl, action: "noop" };
        }
        console.log("[BCLT] Popup window exists, updating location to new time...");
        highQualityPlaybackTab.location.href = watchUrl;
        console.log("[BCLT] Popup navigated to:", watchUrl);
        return { ok: true, watchUrl, action: "updated" };
      }
    } catch (error) {
      console.warn("[BCLT] Failed to update existing popup location, will open new window:", error.message);
      highQualityPlaybackTab = null;
    }
    if (!allowOpen) {
      console.log("[BCLT] Skipping popup open because allowOpen=false.");
      return { ok: true, watchUrl, action: "skipped" };
    }
    console.log("[BCLT] Opening or retargeting popup window...");
    let openedTab = null;
    try {
      openedTab = window.open(
        watchUrl,
        HQ_TAB_WINDOW_NAME,
        HQ_TAB_WINDOW_FEATURES
      );
      console.log("[BCLT] window.open returned:", openedTab, "type:", typeof openedTab);
      if (openedTab === null) {
        console.warn("[BCLT] window.open returned null (browser may have blocked popup)");
        return { ok: false, message: t("popup_blocked") };
      }
      highQualityPlaybackTab = openedTab;
      highQualityTabSessionOpened = true;
      console.log("[BCLT] Window handle stored.");
      try {
        window.focus();
        console.log("[BCLT] Focus returned to main window.");
      } catch (error) {
        console.warn("[BCLT] Failed to set focus back to main window:", error.message);
      }
    } catch (error) {
      console.error("[BCLT] window.open failed:", error.message);
      return { ok: false, message: `Failed to open window: ${error.message}` };
    }
    console.log("[BCLT] updateOrOpenHighQualityPlaybackTab completed for URL:", watchUrl);
    return { ok: true, watchUrl, action: hadExistingTab ? "updated" : "opened" };
  }
  function renderHighQualityPlaceholder() {
    var _a;
    const playerContainer = (_a = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _a.querySelector("#bclt-player-container");
    if (!playerContainer) return;
    playerContainer.innerHTML = `<div class="empty-state">${t("hq_placeholder")}</div>`;
  }
  function extractCurrentBvid() {
    const currentSource = String(computeBilibiliSyntheticState().sourceUrl || state.bilibili.sourceUrl || "");
    if (currentSource.startsWith("local://")) {
      const fileHash = currentSource.replace("local://", "").toLowerCase();
      return `local:${fileHash}`;
    }
    const currentBvidMatch = currentSource.match(/(BV[0-9A-Za-z]{10,})/i);
    if (currentBvidMatch) return `bili:${currentBvidMatch[1].toUpperCase()}`;
    const youtubeId = parseYouTubeVideoId(currentSource);
    if (youtubeId) return `yt:${youtubeId}`;
    if (isDirectMediaUrl(currentSource)) {
      const parts = currentSource.split(/[\/\?#]+/);
      let mediaId = parts[parts.length - 1] || "video";
      if (mediaId.length > 50) mediaId = mediaId.substring(0, 30) + "...";
      return `vid:${mediaId}`;
    }
    return "";
  }
  function getCurrentPlayingVideoIndex() {
    const currentBvid = extractCurrentBvid();
    if (!currentBvid) return -1;
    for (let index = activeVideos.length - 1; index >= 0; index -= 1) {
      const candidate = activeVideos[index];
      const candidateBvidRaw = String((candidate == null ? void 0 : candidate.bvid) || "");
      const candidateBvid = candidateBvidRaw.toUpperCase();
      const candidateUrl = String((candidate == null ? void 0 : candidate.url) || (candidate == null ? void 0 : candidate.sourceUrl) || "");
      const candidateYoutubeId = parseYouTubeVideoId(candidateUrl) || "";
      const isVideoURL = isDirectMediaUrl(candidateUrl);
      let candidateKey = "";
      if ((candidate == null ? void 0 : candidate.mediaKind) === "local_video" && /^#local_/i.test(candidateBvidRaw)) {
        const localHash = candidateBvidRaw.replace(/^#local_/i, "").toLowerCase();
        candidateKey = localHash ? `local:${localHash}` : "";
      } else if (candidateBvid.startsWith("BV")) {
        candidateKey = `bili:${candidateBvid}`;
      } else if (candidateYoutubeId) {
        candidateKey = `yt:${candidateYoutubeId}`;
      } else if (isVideoURL || (candidate == null ? void 0 : candidate.mediaKind) === "video") {
        const parts = candidateUrl.split(/[\/\?#]+/);
        let mediaId = parts[parts.length - 1] || candidateBvid || "video";
        if (mediaId.length > 50) mediaId = mediaId.substring(0, 30) + "...";
        candidateKey = `vid:${mediaId}`;
      }
      if (candidateKey && candidateKey === currentBvid) {
        return index;
      }
    }
    return -1;
  }
  function buildNowPlayingHighlightToken() {
    const currentBvid = extractCurrentBvid();
    const currentIndex = getCurrentPlayingVideoIndex();
    return `${currentBvid}|${currentIndex}`;
  }
  function refreshNowPlayingHighlightIfNeeded() {
    var _a;
    const listEl = (_a = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _a.querySelector("#bclt-video-list");
    if (!listEl) return;
    const nextToken = buildNowPlayingHighlightToken();
    if (nextToken === nowPlayingHighlightToken) return;
    nowPlayingHighlightToken = nextToken;
    updateVideoList();
  }
  function pickNextVideoByMode(mode, currentIndex) {
    if (!activeVideos.length) return null;
    const normalizedMode = normalizePlaybackMode(mode);
    const safeIndex = currentIndex >= 0 && currentIndex < activeVideos.length ? currentIndex : 0;
    if (normalizedMode === "single") {
      return activeVideos[safeIndex] || activeVideos[0];
    }
    if (normalizedMode === "shuffle") {
      if (activeVideos.length === 1) return activeVideos[0];
      let randomIndex = safeIndex;
      while (randomIndex === safeIndex) {
        randomIndex = Math.floor(Math.random() * activeVideos.length);
      }
      return activeVideos[randomIndex];
    }
    const nextIndex = (safeIndex + 1) % activeVideos.length;
    return activeVideos[nextIndex];
  }
  function updatePlaybackModeUi() {
    var _a, _b;
    const normalized = normalizePlaybackMode(state.settings.playbackMode);
    const modeSlider = (_a = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _a.querySelector("#bclt-mode-slider");
    if (modeSlider) modeSlider.setAttribute("data-mode", normalized);
    (_b = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _b.querySelectorAll(".mode-slider-btn").forEach((btn) => {
      const active = btn.getAttribute("data-mode") === normalized;
      btn.classList.toggle("is-active", active);
    });
  }
  function refreshHostUiPrivileges() {
    var _a, _b, _c, _d, _e, _f, _g;
    const hostOnly = !!state.settings.isHost;
    const canEditPlaylist = canManagePlaylist();
    const permissionBtn = (_a = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _a.querySelector("#bclt-btn-manage-permissions");
    const modeButtons = ((_b = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _b.querySelectorAll(".mode-slider-btn")) || [];
    const addVideoBtn = (_c = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _c.querySelector("#bclt-btn-add-video");
    const addLocalVideoBtn = (_d = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _d.querySelector("#bclt-btn-add-local-video");
    const addVideoInput = (_e = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _e.querySelector("#bclt-add-video-input");
    const importPlaylistBtn = (_f = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _f.querySelector("#bclt-btn-import-playlist");
    const skipBtn = (_g = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _g.querySelector("#bclt-btn-skip-next");
    modeButtons.forEach((btn) => {
      btn.disabled = !hostOnly;
      btn.title = hostOnly ? "" : t("host_only_change_mode");
    });
    if (permissionBtn) {
      permissionBtn.disabled = !hostOnly;
      permissionBtn.style.opacity = hostOnly ? "1" : "0.6";
      permissionBtn.title = hostOnly ? "" : t("host_only_permission");
    }
    if (addVideoBtn) {
      addVideoBtn.disabled = !canEditPlaylist;
      addVideoBtn.style.opacity = canEditPlaylist ? "1" : "0.6";
      addVideoBtn.title = canEditPlaylist ? "" : t("host_admin_add_video");
    }
    if (addVideoInput) {
      addVideoInput.disabled = !canEditPlaylist;
      addVideoInput.title = canEditPlaylist ? "" : t("host_admin_add_video");
    }
    if (addLocalVideoBtn) {
      addLocalVideoBtn.disabled = !canEditPlaylist;
      addLocalVideoBtn.style.opacity = canEditPlaylist ? "1" : "0.6";
      addLocalVideoBtn.title = canEditPlaylist ? "" : t("host_admin_add_video");
    }
    if (importPlaylistBtn) {
      importPlaylistBtn.disabled = !canEditPlaylist;
      importPlaylistBtn.style.opacity = canEditPlaylist ? "1" : "0.6";
      importPlaylistBtn.title = canEditPlaylist ? "" : t("host_admin_import_playlist");
    }
    if (skipBtn) {
      skipBtn.disabled = !hostOnly;
      skipBtn.title = hostOnly ? t("skip_to_next") : t("host_only_skip");
    }
    updateSyncControlLockUi();
  }
  function updateSyncControlLockUi() {
    var _a, _b, _c, _d;
    const locked = isSyncControlLocked();
    const playerPanel = (_a = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _a.querySelector(".player-panel");
    const videoListPanel = (_b = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _b.querySelector(".video-list");
    const toggleBtn = (_c = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _c.querySelector("#bclt-btn-toggle-play");
    const progressRange = (_d = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _d.querySelector("#bclt-progress-range");
    if (playerPanel) playerPanel.classList.toggle("sync-locked", locked);
    if (videoListPanel) videoListPanel.classList.toggle("sync-locked", locked);
    if (toggleBtn) toggleBtn.disabled = locked;
    if (progressRange) progressRange.disabled = locked;
  }
  async function setPlaybackMode(nextMode, options = {}) {
    const {
      save = true,
      publishMode = false,
      statusHint = ""
    } = options;
    const normalized = normalizePlaybackMode(nextMode);
    const prev = normalizePlaybackMode(state.settings.playbackMode);
    state.settings.playbackMode = normalized;
    if (save && prev !== normalized) saveSettings();
    updatePlaybackModeUi();
    if (publishMode && state.settings.isHost) {
      await publish("room_control", {
        action: "playback_mode_changed",
        playbackMode: normalized,
        at: Date.now()
      });
      if (state.settings.syncPlaybackProgress !== false) {
        await publish("media_state", computeBilibiliSyntheticState());
      }
    }
    if (statusHint) {
      updatePlaybackUi(statusHint);
    } else if (prev !== normalized) {
      updatePlaybackUi(t("mode_set", { mode: getPlaybackModeLabel(normalized) }));
    }
  }
  async function maybeAutoAdvanceFromSnapshot(snapshot) {
    if (!state.settings.isHost || autoAdvanceInFlight) return;
    if (!snapshot || snapshot.paused || !snapshot.sourceUrl) {
      autoAdvanceTriggerToken = "";
      return;
    }
    const duration = Number(snapshot.duration);
    const currentTime = Number(snapshot.currentTime || 0);
    if (!Number.isFinite(duration) || duration <= 0) return;
    const remaining = duration - currentTime;
    if (remaining > 0.8) {
      autoAdvanceTriggerToken = "";
      return;
    }
    const token = `${snapshot.sourceUrl}|${Math.floor(duration)}`;
    if (token === autoAdvanceTriggerToken) return;
    const currentIndex = getCurrentPlayingVideoIndex();
    const nextVideo = pickNextVideoByMode(state.settings.playbackMode, currentIndex);
    if (!nextVideo || !nextVideo.bvid) return;
    autoAdvanceInFlight = true;
    autoAdvanceTriggerToken = token;
    try {
      await playVideo(nextVideo, {
        publish: true,
        reason: "playlist-auto-advance",
        statusHint: `${t("auto_mode_prefix")}: ${getPlaybackModeLabel(state.settings.playbackMode)}`
      });
    } finally {
      autoAdvanceInFlight = false;
    }
  }
  function resizeWindowForMode(targetWidth, targetHeight) {
    if (!windowInstance || !windowInstance.container) return;
    const viewportPadding = 16;
    const maxWidth = Math.max(320, window.innerWidth - viewportPadding * 2);
    const maxHeight = Math.max(320, window.innerHeight - viewportPadding * 2);
    windowInstance.width = Math.min(targetWidth, maxWidth);
    windowInstance.height = Math.min(targetHeight, maxHeight);
    windowInstance.container.style.width = windowInstance.width + "px";
    windowInstance.container.style.height = windowInstance.height + "px";
    windowInstance.clampPosition();
  }
  function normalizeActiveVideo(rawVideo) {
    if (!rawVideo) return null;
    const inputUrl = String(rawVideo.url || rawVideo.sourceUrl || "").trim();
    const explicitKind = String(rawVideo.mediaKind || "").trim().toLowerCase();
    const bvidCandidate = String(rawVideo.bvid || "").trim();
    const youtubeIdFromUrl = parseYouTubeVideoId(inputUrl);
    const bilibiliIdFromUrl = parseBilibiliBvid(inputUrl);
    const mediaKind = explicitKind || detectMediaKind(inputUrl || bvidCandidate);
    const mediaId = mediaKind === "youtube" ? youtubeIdFromUrl || parseYouTubeVideoId(bvidCandidate) || "" : parseBilibiliBvid(bvidCandidate) || bilibiliIdFromUrl || bvidCandidate;
    if (!mediaId) return null;
    const sender = String(rawVideo.senderName || rawVideo.sender || "Unknown").trim() || "Unknown";
    const title = sanitizeBilibiliText(rawVideo.title || rawVideo.videoTitle || mediaId);
    const shareId = rawVideo.shareId ? String(rawVideo.shareId) : "";
    const timestamp = Number.isFinite(Number(rawVideo.timestamp)) ? Number(rawVideo.timestamp) : Date.now();
    const url = String(rawVideo.url || (mediaKind === "youtube" ? `https://www.youtube.com/watch?v=${mediaId}` : `https://www.bilibili.com/video/${mediaId}`)).trim();
    return {
      shareId,
      sender,
      title,
      bvid: mediaId,
      mediaKind,
      url,
      timestamp
    };
  }
  function sanitizeBilibiliText(input) {
    const raw = String(input || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ");
    const helper = document.createElement("textarea");
    helper.innerHTML = raw;
    return helper.value.replace(/\s+/g, " ").trim();
  }
  function extractBilibiliApiError(payload, fallback = "Bilibili API request failed") {
    if (!payload || typeof payload !== "object") return fallback;
    const code = Number(payload.code);
    const message = String(payload.message || payload.msg || fallback).trim() || fallback;
    if (code === -352 || /security control policy|安全风控/i.test(message)) {
      return "Bilibili rejected the request due to security control policy";
    }
    if (Number.isFinite(code) && code !== 0) {
      return `${message} (code: ${code})`;
    }
    return message;
  }
  function ensureBilibiliApiOk(payload, fallback) {
    if (!payload || typeof payload !== "object") {
      throw new Error(fallback);
    }
    const code = Number(payload.code);
    if (!Number.isFinite(code) || code !== 0) {
      throw new Error(extractBilibiliApiError(payload, fallback));
    }
    return payload;
  }
  async function requestBilibiliApiWithFallback(endpoint) {
    try {
      return await callBilibiliJsonp(endpoint);
    } catch (jsonpError) {
      const response = await fetch(endpoint, { method: "GET", mode: "cors", credentials: "omit" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    }
  }
  function callBilibiliJsonp(url, timeoutMs = 9e3) {
    return new Promise((resolve, reject) => {
      const callbackName = `__bclt_jsonp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const script = document.createElement("script");
      let timeoutId = 0;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (script.parentElement) script.parentElement.removeChild(script);
        try {
          delete window[callbackName];
        } catch (error) {
          window[callbackName] = void 0;
        }
      };
      window[callbackName] = (payload) => {
        cleanup();
        resolve(payload);
      };
      script.onerror = () => {
        cleanup();
        reject(new Error("JSONP request failed"));
      };
      timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error("JSONP request timed out"));
      }, timeoutMs);
      const joiner = url.includes("?") ? "&" : "?";
      script.src = `${url}${joiner}jsonp=jsonp&callback=${encodeURIComponent(callbackName)}`;
      document.head.appendChild(script);
    });
  }
  async function fetchBilibiliVideoTitleByBvid(bvid) {
    const normalizedBvid = String(bvid || "").trim();
    if (!/^BV[0-9A-Za-z]{10,}$/i.test(normalizedBvid)) return normalizedBvid;
    const key = normalizedBvid.toUpperCase();
    if (bilibiliVideoTitleTaskByBvid.has(key)) {
      return bilibiliVideoTitleTaskByBvid.get(key);
    }
    const task = (async () => {
      const endpoint = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(normalizedBvid)}`;
      const parseTitle = (payload2) => {
        var _a;
        ensureBilibiliApiOk(payload2, "Bilibili view API failed");
        return sanitizeBilibiliText(((_a = payload2 == null ? void 0 : payload2.data) == null ? void 0 : _a.title) || normalizedBvid) || normalizedBvid;
      };
      const payload = await requestBilibiliApiWithFallback(endpoint);
      return parseTitle(payload);
    })();
    bilibiliVideoTitleTaskByBvid.set(key, task);
    try {
      return await task;
    } finally {
      bilibiliVideoTitleTaskByBvid.delete(key);
    }
  }
  async function enrichVideoTitle(video) {
    if (!video || !video.bvid) return;
    const currentTitle = String(video.title || "").trim();
    if (currentTitle && currentTitle !== video.bvid) return;
    try {
      const mediaKind = String(video.mediaKind || "").trim().toLowerCase() || detectMediaKind(video.url || video.bvid);
      const title = mediaKind === "youtube" ? await fetchYouTubeTitleByVideoId(video.bvid) : await fetchBilibiliVideoTitleByBvid(video.bvid);
      if (!title || title === video.title) return;
      video.title = title;
      updateVideoList();
    } catch (error) {
      console.warn("[BCLT] enrich video title failed:", error);
    }
  }
  function choosePreferredVideo(nextVideo, prevVideo) {
    if (!prevVideo) return nextVideo;
    const nextTime = Number(nextVideo.timestamp || 0);
    const prevTime = Number(prevVideo.timestamp || 0);
    const preferNext = nextTime >= prevTime;
    return {
      ...preferNext ? prevVideo : nextVideo,
      ...preferNext ? nextVideo : prevVideo,
      bvid: String(nextVideo.bvid || prevVideo.bvid || "").trim(),
      mediaKind: String(nextVideo.mediaKind || prevVideo.mediaKind || "").trim() || detectMediaKind(nextVideo.url || prevVideo.url),
      // Keep a shareId when either side has one so remove actions remain addressable.
      shareId: String(nextVideo.shareId || prevVideo.shareId || ""),
      timestamp: Math.max(nextTime, prevTime, Date.now())
    };
  }
  function mergeActiveVideos(videos) {
    const byMediaKey = /* @__PURE__ */ new Map();
    const queue = [
      ...Array.isArray(videos) ? videos : [],
      ...activeVideos
    ];
    queue.forEach((video) => {
      const normalized = normalizeActiveVideo(video);
      if (!normalized) return;
      const mediaKey = `${normalized.mediaKind || detectMediaKind(normalized.url)}:${String(normalized.bvid || "").toUpperCase()}`;
      const prev = byMediaKey.get(mediaKey);
      byMediaKey.set(mediaKey, choosePreferredVideo(normalized, prev));
    });
    activeVideos = Array.from(byMediaKey.values()).sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  }
  function buildPlaylistStatePayload(targetMemberId = "") {
    const syncEnabled = state.settings.syncPlaybackProgress !== false;
    return {
      targetMemberId: targetMemberId || "",
      videos: activeVideos.map((video) => ({ ...video })),
      playbackMode: normalizePlaybackMode(state.settings.playbackMode),
      adminMemberIds: [...state.roomAdminMemberIds],
      mediaState: syncEnabled ? computeBilibiliSyntheticState() : null,
      syncProgress: syncEnabled,
      generatedAt: Date.now()
    };
  }
  function resetPlaylistSnapshotRequestState() {
    playlistSnapshotPending = false;
    playlistRequestAttempts = 0;
    if (playlistRequestRetryTimer) {
      clearTimeout(playlistRequestRetryTimer);
      playlistRequestRetryTimer = null;
    }
  }
  function schedulePlaylistSnapshotRequestRetry() {
    if (!playlistSnapshotPending) return;
    if (state.settings.isHost) return;
    if (!state.connected) return;
    if (playlistRequestRetryTimer) return;
    if (playlistRequestAttempts >= PLAYLIST_REQUEST_RETRY_MAX_ATTEMPTS) return;
    playlistRequestRetryTimer = window.setTimeout(async () => {
      playlistRequestRetryTimer = null;
      if (!playlistSnapshotPending || state.settings.isHost || !state.connected) return;
      playlistRequestAttempts += 1;
      try {
        await publish("playlist_request", {
          requesterId: memberId(),
          requestedAt: Date.now(),
          attempt: playlistRequestAttempts
        });
      } catch (error) {
        console.warn("[BCLT] retry playlist_request failed:", error);
      }
      schedulePlaylistSnapshotRequestRetry();
    }, PLAYLIST_REQUEST_RETRY_DELAY_MS);
  }
  async function requestPlaylistSnapshotWithRetry() {
    if (state.settings.isHost) return;
    if (!state.connected) return;
    resetPlaylistSnapshotRequestState();
    playlistSnapshotPending = true;
    playlistRequestAttempts = 1;
    await publish("playlist_request", {
      requesterId: memberId(),
      requestedAt: Date.now(),
      attempt: playlistRequestAttempts
    });
    schedulePlaylistSnapshotRequestRetry();
  }
  function clampMainButtonPosition() {
    if (!buttonElement) return;
    const viewportPadding = 16;
    const rect = buttonElement.getBoundingClientRect();
    const width = rect.width || 58;
    const height = rect.height || 58;
    const left = Number.parseFloat(buttonElement.style.left || "0") || viewportPadding;
    const top = Number.parseFloat(buttonElement.style.top || "0") || viewportPadding;
    const clampedLeft = Math.min(Math.max(left, viewportPadding), Math.max(viewportPadding, window.innerWidth - width - viewportPadding));
    const clampedTop = Math.min(Math.max(top, viewportPadding), Math.max(viewportPadding, window.innerHeight - height - viewportPadding));
    buttonElement.style.left = `${clampedLeft}px`;
    buttonElement.style.top = `${clampedTop}px`;
  }
  function setMainButtonSpinning(spinning) {
    if (!buttonElement) return;
    buttonElement.classList.toggle("is-minimized-spinning", !!spinning);
  }
  function setupMainButtonDrag() {
    if (!buttonElement) return;
    const pointerDown = (event) => {
      if (event.button !== 0) return;
      const left = Number.parseFloat(buttonElement.style.left || "0") || 0;
      const top = Number.parseFloat(buttonElement.style.top || "0") || 0;
      mainButtonDragState.dragging = true;
      mainButtonDragState.moved = false;
      mainButtonDragState.startX = event.clientX;
      mainButtonDragState.startY = event.clientY;
      mainButtonDragState.startLeft = left;
      mainButtonDragState.startTop = top;
      isDraggingMainButton = true;
      buttonElement.classList.add("dragging");
    };
    const pointerMove = (event) => {
      if (!mainButtonDragState.dragging || !buttonElement) return;
      const deltaX = event.clientX - mainButtonDragState.startX;
      const deltaY = event.clientY - mainButtonDragState.startY;
      if (!mainButtonDragState.moved && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) {
        mainButtonDragState.moved = true;
      }
      buttonElement.style.left = `${mainButtonDragState.startLeft + deltaX}px`;
      buttonElement.style.top = `${mainButtonDragState.startTop + deltaY}px`;
      clampMainButtonPosition();
    };
    const pointerUp = () => {
      if (!mainButtonDragState.dragging) return;
      mainButtonDragState.dragging = false;
      buttonElement == null ? void 0 : buttonElement.classList.remove("dragging");
      if (mainButtonDragState.moved) {
        suppressNextMainButtonClick = true;
      }
      isDraggingMainButton = false;
    };
    buttonElement.addEventListener("mousedown", pointerDown);
    document.addEventListener("mousemove", pointerMove);
    document.addEventListener("mouseup", pointerUp);
    window.addEventListener("resize", clampMainButtonPosition);
  }
  function createUI() {
    if (document.getElementById(APP_ID)) return;
    const style = document.createElement("style");
    style.id = APP_ID;
    style.textContent = `
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&display=swap');

        :root {
            --bclt-surface: linear-gradient(150deg, rgba(15, 29, 53, 0.96), rgba(9, 17, 34, 0.95));
            --bclt-panel: rgba(13, 26, 48, 0.72);
            --bclt-panel-hover: rgba(20, 37, 66, 0.84);
            --bclt-border: rgba(148, 184, 255, 0.34);
            --bclt-border-soft: rgba(148, 184, 255, 0.2);
            --bclt-text-main: #eaf2ff;
            --bclt-text-soft: #afc4ea;
            --bclt-accent: #22d3ee;
            --bclt-accent-2: #34d399;
            --bclt-shadow: 0 16px 40px rgba(3, 8, 20, 0.42);
            --bclt-radius: 14px;
        }

        #bclt-button {
            position: fixed;
            top: calc(100vh - 80px);
            left: calc(100vw - 80px);
            z-index: 99999;
            width: 58px;
            height: 58px;
            border-radius: 50%;
            background: conic-gradient(from 210deg, #06b6d4, #22d3ee, #34d399, #06b6d4);
            border: 1px solid rgba(255,255,255,0.5);
            cursor: pointer;
            font-size: 26px;
            color: #062236;
            box-shadow: 0 10px 26px rgba(4, 31, 54, 0.42);
            transition: transform 0.22s ease, box-shadow 0.22s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 800;
            font-family: 'Sora', 'Avenir Next', 'Noto Sans SC', 'Microsoft YaHei UI', sans-serif;
            user-select: none;
        }

        #bclt-button:hover {
            transform: translateY(-2px) scale(1.04);
            box-shadow: 0 14px 28px rgba(4, 31, 54, 0.52);
        }

        #bclt-button:active {
            transform: scale(0.96);
        }

        #bclt-button.dragging {
            cursor: grabbing;
            transition: none;
            transform: none;
        }

        #bclt-button.is-minimized-spinning {
            animation: bclt-record-spin 2.4s linear infinite;
        }

        #bclt-window {
            position: relative;
            max-width: calc(100vw - 32px);
            max-height: calc(100vh - 32px);
        }

        #bclt-window.bclt-player-mode {
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
        }

        #bclt-window.bclt-immersive-mode .bclt-window-header {
            display: none;
        }

        #bclt-window.bclt-immersive-mode .bclt-window-content {
            padding: 0;
            background: #000;
        }

        #bclt-window.bclt-immersive-mode .player-container {
            grid-template-columns: 1fr;
            gap: 0;
        }

        #bclt-window.bclt-immersive-mode .video-list,
        #bclt-window.bclt-immersive-mode .player-room-tools,
        #bclt-window.bclt-immersive-mode #bclt-player-status {
            display: none;
        }

        #bclt-window.bclt-immersive-mode .player-panel {
            position: relative;
            gap: 0;
            border-radius: 0;
            overflow: hidden;
        }

        #bclt-window.bclt-immersive-mode .video-stage {
            min-height: 100%;
            height: 100%;
            border: none;
            border-radius: 0;
            box-shadow: none;
        }

        #bclt-window.bclt-immersive-mode .player-progress {
            position: absolute;
            left: 16px;
            right: 16px;
            bottom: 16px;
            z-index: 8;
            opacity: 0;
            transform: translateY(10px);
            pointer-events: none;
            transition: opacity 0.2s ease, transform 0.2s ease;
            background: rgba(6, 16, 30, 0.8);
            border-color: rgba(148, 184, 255, 0.34);
            backdrop-filter: blur(8px);
        }

        #bclt-window.bclt-immersive-mode:hover .player-progress,
        #bclt-window.bclt-immersive-mode:hover .immersive-exit-btn {
            opacity: 1;
            transform: translateY(0);
            pointer-events: auto;
        }

        #bclt-window .immersive-exit-btn {
            display: none;
        }

        #bclt-window.bclt-immersive-mode .immersive-exit-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            position: absolute;
            top: 16px;
            right: 16px;
            z-index: 8;
            height: 32px;
            padding: 0 12px;
            border-radius: 999px;
            border: 1px solid rgba(244, 114, 182, 0.45);
            background: rgba(15, 23, 42, 0.68);
            color: #fce7f3;
            font-size: 12px;
            font-weight: 700;
            cursor: pointer;
            opacity: 0;
            transform: translateY(-8px);
            pointer-events: none;
            transition: opacity 0.2s ease, transform 0.2s ease, filter 0.18s ease;
            backdrop-filter: blur(6px);
        }

        #bclt-window.bclt-immersive-mode .immersive-exit-btn:hover {
            filter: brightness(1.08);
        }

        #bclt-window::before {
            content: '';
            position: absolute;
            inset: -1px;
            border-radius: 18px;
            background: linear-gradient(135deg, rgba(34, 211, 238, 0.28), rgba(52, 211, 153, 0.12), rgba(148, 184, 255, 0.28));
            pointer-events: none;
        }

        #bclt-window.dragging {
            cursor: grabbing;
            box-shadow: 0 26px 54px rgba(4, 10, 24, 0.6);
        }

        #bclt-window .bclt-window-header {
            background: linear-gradient(180deg, rgba(38, 75, 126, 0.2), rgba(38, 75, 126, 0.06));
        }

        #bclt-window .bclt-window-title {
            letter-spacing: 0.2px;
            text-shadow: 0 1px 0 rgba(255,255,255,0.08);
        }

        #bclt-window .bclt-close-btn {
            width: 30px;
            height: 30px;
            border-radius: 9px;
            border: 1px solid rgba(255,255,255,0.18);
            color: var(--bclt-text-main);
            background: rgba(255,255,255,0.04);
            font-size: 20px;
            line-height: 1;
            cursor: pointer;
            transition: background 0.18s ease, transform 0.18s ease;
        }

        #bclt-window .bclt-close-btn:hover {
            background: rgba(248, 113, 113, 0.2);
            transform: scale(1.04);
        }

        #bclt-window .bclt-minimize-btn {
            width: 30px;
            height: 30px;
            border-radius: 9px;
            border: 1px solid rgba(255,255,255,0.18);
            color: var(--bclt-text-main);
            background: rgba(255,255,255,0.04);
            font-size: 18px;
            line-height: 1;
            cursor: pointer;
            transition: background 0.18s ease, transform 0.18s ease;
        }

        #bclt-window .bclt-minimize-btn:hover {
            background: rgba(96, 165, 250, 0.24);
            transform: scale(1.04);
        }

        #bclt-window .bclt-window-resizer {
            position: absolute;
            right: 2px;
            bottom: 2px;
            width: 14px;
            height: 14px;
            border-right: 2px solid rgba(148, 184, 255, 0.65);
            border-bottom: 2px solid rgba(148, 184, 255, 0.65);
            border-radius: 0 0 14px 0;
            cursor: nwse-resize;
            z-index: 5;
            opacity: 0.8;
        }

        #bclt-window .bclt-window-resizer:hover {
            opacity: 1;
        }

        #bclt-window .bclt-window-content {
            background:
                radial-gradient(120% 60% at 120% 0%, rgba(34, 211, 238, 0.16), transparent 48%),
                radial-gradient(85% 70% at -10% 100%, rgba(52, 211, 153, 0.12), transparent 46%);
        }

        #bclt-window .room-mode-layout {
            display: grid;
            grid-template-columns: minmax(260px, 0.95fr) minmax(0, 1.35fr);
            gap: 12px;
            height: 100%;
        }

        #bclt-window .panel-card {
            border-radius: var(--bclt-radius);
            border: 1px solid var(--bclt-border-soft);
            background: var(--bclt-panel);
            box-shadow: var(--bclt-shadow);
        }

        #bclt-window .panel-card-form {
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        #bclt-window .panel-card-body {
            padding: 12px;
        }

        #bclt-window .panel-card-form .status-text {
            padding: 0 12px 8px;
        }

        #bclt-window .panel-card-form .btn-primary {
            margin: 0 12px 12px;
        }

        #bclt-window .btn-small {
            padding: 7px 10px;
            font-size: 12px;
            line-height: 1;
            border-radius: 10px;
        }

        #bclt-window .panel-card-rooms {
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        #bclt-window .panel-title-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 11px 12px;
            border-bottom: 1px solid var(--bclt-border-soft);
        }

        #bclt-window .panel-title-row strong {
            font-size: 12px;
            letter-spacing: 0.4px;
            text-transform: uppercase;
            color: var(--bclt-text-soft);
        }

        #bclt-window .panel-pill {
            font-size: 10px;
            padding: 4px 8px;
            border-radius: 999px;
            border: 1px solid rgba(34, 211, 238, 0.32);
            background: rgba(34, 211, 238, 0.14);
            color: #c9f8ff;
        }

        #bclt-window .room-list-grid {
            padding: 12px;
            display: grid;
            gap: 8px;
            flex: 1;
            min-height: 0;
            overflow-y: auto;
        }

        #bclt-window .room-list-footer-status {
            margin: 0;
            padding: 10px 12px;
            border-top: 1px solid var(--bclt-border-soft);
            background: rgba(11, 24, 44, 0.42);
        }

        #bclt-window .room-item {
            padding: 12px 14px;
            margin-bottom: 9px;
            background: var(--bclt-panel);
            border: 1px solid var(--bclt-border-soft);
            border-radius: 12px;
            cursor: pointer;
            transition: background 0.18s ease, border-color 0.18s ease, transform 0.18s ease;
            box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
        }

        #bclt-window .room-item:hover {
            background: var(--bclt-panel-hover);
            border-color: var(--bclt-border);
            transform: translateY(-1px);
        }

        #bclt-window .room-item-title {
            font-weight: 700;
            margin-bottom: 4px;
            font-size: 13px;
        }

        #bclt-window .room-item-title-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
        }

        #bclt-window .room-lock-indicator {
            font-size: 12px;
            line-height: 1;
            opacity: 0.95;
        }

        #bclt-window .room-item-info {
            font-size: 11px;
            color: var(--bclt-text-soft);
        }

        #bclt-window .room-item-id {
            font-family: 'Consolas', 'SFMono-Regular', monospace;
            font-size: 11px;
            color: #c7dcff;
            margin-bottom: 4px;
            opacity: 0.92;
        }

        #bclt-window .player-container {
            display: grid;
            grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
            gap: 14px;
            height: 100%;
        }

        #bclt-window .player-panel {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        #bclt-window .video-stage {
            flex: 1;
            min-height: 220px;
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: var(--bclt-radius);
            border: 1px solid var(--bclt-border-soft);
            background:
                linear-gradient(160deg, rgba(13, 28, 50, 0.98), rgba(9, 17, 35, 0.9)),
                repeating-linear-gradient(45deg, rgba(255,255,255,0.02) 0 10px, rgba(255,255,255,0.04) 10px 20px);
            overflow: hidden;
            isolation: isolate;
            box-shadow: var(--bclt-shadow);
        }

        #bclt-window .video-stage iframe {
            width: 100%;
            height: 100%;
            aspect-ratio: 16 / 9;
            border: none;
            border-radius: 0;
            position: relative;
            z-index: 2;
            display: block;
            background: #000;
        }

        #bclt-window .player-controls {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
        }

        #bclt-window .toolbar-leave-btn {
            width: auto;
            height: 30px;
            padding: 0 10px;
            border-radius: 9px;
            border: 1px solid rgba(255,255,255,0.18);
            color: var(--bclt-text-main);
            background: rgba(255,255,255,0.04);
            font-size: 12px;
            font-weight: 700;
            line-height: 1;
            cursor: pointer;
            transition: background 0.18s ease, transform 0.18s ease;
        }

        #bclt-window .toolbar-leave-btn:hover {
            background: rgba(248, 113, 113, 0.22);
            transform: translateY(-1px);
        }

        #bclt-window .toolbar-room-name {
            margin-left: auto;
            margin-right: 8px;
            max-width: 220px;
            padding: 5px 10px;
            border-radius: 999px;
            border: 1px solid rgba(34, 211, 238, 0.34);
            background: rgba(34, 211, 238, 0.12);
            color: #cffafe;
            font-size: 11px;
            font-weight: 700;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        #bclt-window .player-controls button {
            padding: 11px 12px;
            border: 1px solid transparent;
            border-radius: 11px;
            color: #e8f2ff;
            cursor: pointer;
            font-weight: 700;
            font-size: 13px;
            letter-spacing: 0.1px;
            transition: transform 0.16s ease, filter 0.16s ease, box-shadow 0.16s ease;
        }

        #bclt-window .player-controls button:hover {
            transform: translateY(-1px);
            filter: brightness(1.05);
            box-shadow: 0 8px 16px rgba(8, 17, 34, 0.34);
        }

        #bclt-window button.btn-accent {
            background: linear-gradient(135deg, #0ea5e9, #22d3ee);
            border-color: rgba(34, 211, 238, 0.56);
            color: #062436;
        }

        #bclt-window button.btn-neutral {
            background: linear-gradient(135deg, #334155, #475569);
            border-color: rgba(148, 163, 184, 0.5);
        }

        #bclt-window button.btn-success {
            background: linear-gradient(135deg, #10b981, #34d399);
            border-color: rgba(52, 211, 153, 0.55);
            color: #052e1f;
        }

        #bclt-window button.btn-warning {
            background: linear-gradient(135deg, #f59e0b, #fbbf24);
            border-color: rgba(251, 191, 36, 0.58);
            color: #3b2a08;
        }

        #bclt-window .player-progress {
            display: grid;
            gap: 6px;
            padding: 10px;
            border: 1px solid var(--bclt-border-soft);
            border-radius: 12px;
            background: rgba(11, 25, 45, 0.78);
        }

        #bclt-window .player-progress-track {
            display: grid;
            grid-template-columns: auto auto minmax(0, 1fr);
            align-items: center;
            gap: 8px;
        }

        #bclt-window .player-progress-track input[type="range"] {
            min-width: 0;
        }

        #bclt-window .media-toggle-btn {
            width: 36px;
            height: 36px;
            border-radius: 10px;
            border: 1px solid rgba(34, 211, 238, 0.46);
            background: linear-gradient(135deg, #0ea5e9, #22d3ee);
            color: #05293b;
            font-size: 14px;
            font-weight: 800;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: transform 0.16s ease, filter 0.16s ease;
        }

        #bclt-window .media-toggle-btn:hover {
            transform: translateY(-1px);
            filter: brightness(1.05);
        }

        #bclt-window .media-toggle-btn.is-paused {
            background: linear-gradient(135deg, #f59e0b, #fbbf24);
            border-color: rgba(251, 191, 36, 0.58);
            color: #3b2a08;
        }

        #bclt-window .skip-track-btn {
            width: 36px;
            height: 36px;
            border-radius: 10px;
            border: 1px solid rgba(148, 163, 184, 0.5);
            background: linear-gradient(135deg, #334155, #475569);
            color: #e8f2ff;
            font-size: 14px;
            font-weight: 800;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: transform 0.16s ease, filter 0.16s ease;
        }

        #bclt-window .skip-track-btn:hover {
            transform: translateY(-1px);
            filter: brightness(1.05);
        }

        #bclt-window .player-room-tools {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            align-items: center;
        }

        #bclt-window .sync-progress-toggle {
            grid-column: 1 / -1;
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
            color: var(--bclt-text-soft);
            background: rgba(10, 22, 41, 0.68);
            border: 1px solid var(--bclt-border-soft);
            border-radius: 10px;
            padding: 8px 10px;
            user-select: none;
        }

        #bclt-window .sync-progress-toggle input {
            accent-color: var(--bclt-accent-2);
        }

        #bclt-window .player-progress input[type="range"] {
            width: 100%;
            margin: 0;
            accent-color: var(--bclt-accent-2);
            cursor: pointer;
        }

        #bclt-window .player-progress-meta {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 12px;
            color: var(--bclt-text-soft);
        }

        #bclt-window .sync-indicator {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            border: 1px solid rgba(148, 163, 184, 0.6);
            background: rgba(148, 163, 184, 0.3);
            box-shadow: none;
            transition: background 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
        }

        #bclt-window .sync-indicator.is-active {
            border-color: rgba(52, 211, 153, 0.82);
            background: rgba(52, 211, 153, 0.95);
            box-shadow: 0 0 0 4px rgba(52, 211, 153, 0.16);
        }

        #bclt-window .video-list-header {
            display: flex;
            flex-wrap: wrap;
            justify-content: space-between;
            align-items: flex-start;
            gap: 8px;
            padding: 11px 12px;
            border-bottom: 1px solid var(--bclt-border-soft);
        }

        #bclt-window .video-list-header-row {
            width: 100%;
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 8px;
            min-width: 0;
        }

        #bclt-window .video-add-row {
            align-items: stretch;
        }

        #bclt-window .video-toolbar-row {
            justify-content: space-between;
            align-items: center;
            flex-wrap: nowrap;
        }

        #bclt-window .playlist-actions {
            display: flex;
            flex-wrap: nowrap;
            gap: 8px;
            min-width: 0;
            flex: 1;
            overflow-x: auto;
            scrollbar-width: thin;
            padding-bottom: 2px;
        }

        #bclt-window .playlist-io-btn {
            flex-shrink: 0;
            white-space: nowrap;
            border-radius: 999px;
            padding-inline: 10px;
            letter-spacing: 0.1px;
            font-size: 11px;
        }

        #bclt-window .add-local-btn {
            flex-shrink: 0;
            white-space: nowrap;
            border-radius: 999px;
            padding-inline: 12px;
            border-color: rgba(34, 211, 238, 0.5);
            background: linear-gradient(135deg, rgba(14, 165, 233, 0.42), rgba(34, 211, 238, 0.28));
        }

        #bclt-window .video-toolbar-row .mode-slider {
            margin-left: 8px;
        }

        #bclt-window .add-video-input {
            flex: 1;
            min-width: 0;
            box-sizing: border-box;
            padding: 8px 10px;
            background: rgba(8, 19, 35, 0.84);
            border: 1px solid var(--bclt-border-soft);
            border-radius: 9px;
            color: var(--bclt-text-main);
            font-size: 12px;
        }

        #bclt-window .add-video-input::placeholder {
            color: rgba(175, 196, 234, 0.7);
        }

        #bclt-window .mode-slider {
            position: relative;
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 4px;
            padding: 4px;
            width: 124px;
            border-radius: 999px;
            border: 1px solid var(--bclt-border-soft);
            background: rgba(8, 19, 35, 0.84);
            flex-shrink: 0;
        }

        #bclt-window .mode-slider::before {
            content: '';
            position: absolute;
            top: 4px;
            left: 4px;
            width: calc((100% - 8px) / 3);
            height: calc(100% - 8px);
            border-radius: 999px;
            background: linear-gradient(135deg, #22d3ee, #34d399);
            transition: transform 0.18s ease;
            pointer-events: none;
        }

        #bclt-window .mode-slider[data-mode="single"]::before {
            transform: translateX(100%);
        }

        #bclt-window .mode-slider[data-mode="shuffle"]::before {
            transform: translateX(200%);
        }

        #bclt-window .mode-slider-btn {
            position: relative;
            z-index: 1;
            border: none;
            background: transparent;
            color: var(--bclt-text-soft);
            height: 30px;
            border-radius: 999px;
            font-size: 14px;
            cursor: pointer;
            transition: color 0.15s ease, opacity 0.15s ease;
        }

        #bclt-window .mode-slider-btn.is-active {
            color: #072a39;
        }

        #bclt-window .mode-slider-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        #bclt-window .video-item-meta {
            font-size: 11px;
            color: var(--bclt-text-soft);
            margin-top: 2px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        #bclt-window .video-list {
            border: 1px solid var(--bclt-border-soft);
            border-radius: var(--bclt-radius);
            overflow: hidden;
            display: flex;
            flex-direction: column;
            background: rgba(11, 24, 44, 0.78);
            box-shadow: var(--bclt-shadow);
        }

        #bclt-window .video-list-title {
            font-weight: 700;
            font-size: 13px;
            color: var(--bclt-text-main);
        }

        #bclt-window .video-list-footer {
            padding: 8px;
            border-top: 1px solid var(--bclt-border-soft);
            background: rgba(8, 19, 35, 0.5);
        }

        #bclt-window .permission-entry-btn {
            width: 100%;
            padding: 10px 12px;
            border-radius: 10px;
            border: 1px solid rgba(34, 211, 238, 0.45);
            background: linear-gradient(135deg, rgba(14, 165, 233, 0.35), rgba(34, 211, 238, 0.2));
            color: var(--bclt-text-main);
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.1px;
            cursor: pointer;
            transition: transform 0.16s ease, filter 0.16s ease;
        }

        #bclt-window .permission-entry-btn:hover {
            transform: translateY(-1px);
            filter: brightness(1.07);
        }

        #bclt-window .permission-modal-backdrop {
            position: absolute;
            inset: 0;
            z-index: 7;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(3, 8, 20, 0.68);
            backdrop-filter: blur(4px);
            padding: 16px;
            animation: bclt-window-enter 150ms ease-out;
        }

        #bclt-window .permission-modal {
            width: min(640px, 100%);
            max-height: calc(100% - 24px);
            display: flex;
            flex-direction: column;
            border-radius: 14px;
            border: 1px solid var(--bclt-border);
            background: linear-gradient(160deg, rgba(15, 30, 55, 0.98), rgba(10, 19, 38, 0.96));
            box-shadow: 0 18px 48px rgba(3, 9, 20, 0.6);
            overflow: hidden;
        }

        #bclt-window .permission-modal-head {
            padding: 12px 14px;
            border-bottom: 1px solid var(--bclt-border-soft);
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 10px;
        }

        #bclt-window .permission-modal-head strong {
            font-size: 14px;
            color: var(--bclt-text-main);
        }

        #bclt-window .permission-modal-sub {
            font-size: 11px;
            color: var(--bclt-text-soft);
        }

        #bclt-window .permission-user-list {
            overflow: auto;
            padding: 8px;
            display: grid;
            gap: 6px;
        }

        #bclt-window .permission-user-row {
            border: 1px solid var(--bclt-border-soft);
            border-radius: 10px;
            background: rgba(9, 19, 36, 0.7);
            padding: 9px 10px;
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto auto;
            align-items: center;
            gap: 10px;
        }

        #bclt-window .permission-user-name {
            font-size: 12px;
            font-weight: 700;
            color: var(--bclt-text-main);
        }

        #bclt-window .permission-user-id {
            display: block;
            font-size: 11px;
            color: var(--bclt-text-soft);
            font-family: 'Consolas', 'SFMono-Regular', monospace;
        }

        #bclt-window .permission-col {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 11px;
            color: var(--bclt-text-soft);
            user-select: none;
        }

        #bclt-window .permission-modal-foot {
            padding: 10px;
            border-top: 1px solid var(--bclt-border-soft);
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            background: rgba(8, 19, 35, 0.55);
        }

        #bclt-window .permission-note {
            padding: 0 10px 10px;
            font-size: 11px;
            color: var(--bclt-text-soft);
        }

        #bclt-window .video-list-content {
            flex: 1;
            overflow-y: auto;
            padding: 6px;
        }

        #bclt-window .video-item {
            padding: 9px 10px;
            border-bottom: 1px solid rgba(147, 197, 253, 0.12);
            font-size: 12px;
            transition: background 0.18s ease, border-color 0.18s ease;
            border-radius: 10px;
            margin-bottom: 4px;
            border: 1px solid transparent;
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            align-items: center;
            gap: 8px;
        }

        #bclt-window .video-item:hover {
            background: rgba(30, 64, 112, 0.34);
            border-color: rgba(125, 211, 252, 0.34);
        }

        #bclt-window .video-item.active {
            background: linear-gradient(135deg, rgba(34, 211, 238, 0.25), rgba(56, 189, 248, 0.2));
            border-color: rgba(34, 211, 238, 0.55);
        }

        #bclt-window .video-item-name {
            font-weight: 700;
            margin-bottom: 2px;
            color: var(--bclt-text-main);
        }

        #bclt-window .video-item-main {
            min-width: 0;
            cursor: pointer;
        }

        #bclt-window .video-item-main.sync-locked {
            cursor: not-allowed;
            opacity: 0.55;
        }

        #bclt-window .video-item-remove {
            border: 1px solid rgba(248, 113, 113, 0.4);
            background: rgba(127, 29, 29, 0.4);
            color: #fecaca;
            border-radius: 8px;
            font-size: 11px;
            padding: 5px 8px;
            cursor: pointer;
        }

        #bclt-window .video-item-remove:hover {
            filter: brightness(1.08);
        }

        #bclt-window .video-item-user {
            font-size: 11px;
            color: var(--bclt-text-soft);
        }

        #bclt-window .settings-form {
            display: grid;
            gap: 10px;
        }

        #bclt-window .form-group {
            display: grid;
            gap: 6px;
        }

        #bclt-window .form-group label {
            font-size: 12px;
            font-weight: 700;
            color: var(--bclt-text-soft);
        }

        #bclt-window .form-group input {
            width: 100%;
            box-sizing: border-box;
            padding: 10px 11px;
            background: rgba(8, 19, 35, 0.84);
            border: 1px solid var(--bclt-border-soft);
            border-radius: 10px;
            color: var(--bclt-text-main);
            font-size: 13px;
            transition: border-color 0.18s ease, box-shadow 0.18s ease;
        }

        #bclt-window .form-group input:focus {
            outline: none;
            border-color: rgba(34, 211, 238, 0.62);
            box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.16);
        }

        #bclt-window .form-group input::placeholder {
            color: rgba(175, 196, 234, 0.7);
        }

        #bclt-window .button-group {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            margin-top: 4px;
        }

        #bclt-window button.btn-primary {
            padding: 11px 12px;
            background: linear-gradient(135deg, #0ea5e9, #22d3ee);
            color: #062436;
            border: 1px solid rgba(34, 211, 238, 0.46);
            border-radius: 11px;
            cursor: pointer;
            font-weight: 800;
            font-size: 13px;
            transition: transform 0.16s ease, filter 0.16s ease;
        }

        #bclt-window button.btn-primary:hover {
            transform: translateY(-1px);
            filter: brightness(1.06);
        }

        #bclt-window button.btn-danger {
            padding: 11px 12px;
            background: linear-gradient(135deg, #ef4444, #f87171);
            color: #fff;
            border: 1px solid rgba(248, 113, 113, 0.65);
            border-radius: 11px;
            cursor: pointer;
            font-weight: 700;
            font-size: 13px;
        }

        #bclt-window button.btn-danger:hover {
            filter: brightness(1.06);
        }

        #bclt-window .status-text {
            font-size: 12px;
            color: var(--bclt-text-soft);
            padding: 4px 2px;
            min-height: 20px;
        }

        #bclt-window .status-text.status-emphasis {
            text-align: center;
            border-radius: 10px;
            border: 1px dashed rgba(52, 211, 153, 0.45);
            padding: 8px;
            background: rgba(15, 34, 56, 0.65);
            color: #d7ffe8;
        }

        #bclt-window:not(.bclt-immersive-mode) .player-panel.sync-locked .player-progress,
        #bclt-window .video-list.sync-locked .video-list-content {
            opacity: 0.55;
        }

        #bclt-window .empty-state {
            text-align: center;
            color: var(--bclt-text-soft);
            padding: 22px 14px;
            font-size: 12px;
        }

        @media (max-width: 920px) {
            #bclt-window .room-mode-layout {
                grid-template-columns: 1fr;
            }

            #bclt-window .player-container {
                grid-template-columns: 1fr;
                grid-template-rows: auto minmax(220px, 1fr);
            }

            #bclt-window .video-list {
                min-height: 180px;
            }

            #bclt-window .toolbar-room-name {
                max-width: 150px;
            }
        }

        @media (max-width: 600px) {
            #bclt-window .button-group,
            #bclt-window .player-controls {
                grid-template-columns: 1fr;
            }

            #bclt-window .panel-title-row {
                padding: 10px;
            }

            #bclt-window .video-stage {
                min-height: 180px;
            }

            #bclt-window .toolbar-room-name {
                display: none;
            }
        }

        @keyframes bclt-window-enter {
            from {
                opacity: 0;
                transform: translateY(8px) scale(0.985);
            }
            to {
                opacity: 1;
                transform: translateY(0) scale(1);
            }
        }

        @keyframes bclt-record-spin {
            from {
                transform: rotate(0deg);
            }
            to {
                transform: rotate(360deg);
            }
        }
    `;
    document.head.appendChild(style);
    buttonElement = document.createElement("button");
    buttonElement.id = "bclt-button";
    buttonElement.textContent = "♫";
    buttonElement.onclick = () => {
      if (suppressNextMainButtonClick || isDraggingMainButton) {
        suppressNextMainButtonClick = false;
        return;
      }
      if (windowInstance) {
        windowInstance.show();
      } else {
        showRoomListMode();
      }
    };
    document.body.appendChild(buttonElement);
    const viewportPadding = 22;
    buttonElement.style.left = `${Math.max(viewportPadding, window.innerWidth - 58 - viewportPadding)}px`;
    buttonElement.style.top = `${Math.max(viewportPadding, window.innerHeight - 58 - viewportPadding)}px`;
    clampMainButtonPosition();
    setupMainButtonDrag();
    logStatus(t("ready"));
  }
  function showRoomListMode() {
    var _a, _b, _c, _d;
    const roomTitle = t("window_rooms_title");
    if (!windowInstance) {
      windowInstance = new DraggableWindow({
        title: roomTitle,
        width: 460,
        height: 620,
        onMinimizeChanged: setMainButtonSpinning
      });
      windowInstance.create();
    }
    windowInstance.setTitle(roomTitle);
    (_a = windowInstance.container) == null ? void 0 : _a.classList.remove("bclt-player-mode");
    (_b = windowInstance.container) == null ? void 0 : _b.classList.remove("bclt-immersive-mode");
    const toolbarLeaveBtn = (_c = windowInstance.headerEl) == null ? void 0 : _c.querySelector("#bclt-toolbar-leave");
    if (toolbarLeaveBtn) toolbarLeaveBtn.remove();
    const toolbarRoomName = (_d = windowInstance.headerEl) == null ? void 0 : _d.querySelector("#bclt-toolbar-room-name");
    if (toolbarRoomName) toolbarRoomName.remove();
    closeHighQualityPlaybackTab({ destroySession: true });
    resizeWindowForMode(460, 620);
    windowInstance.setContent(`
        <div class="room-mode-layout">
            <div class="panel-card panel-card-rooms">
                <div class="panel-title-row">
                    <strong>${t("room_available_rooms")}</strong>
                    <button id="bclt-refresh-rooms" class="btn-primary btn-small">${t("room_refresh")}</button>
                </div>
                <div id="bclt-room-list" class="room-list-grid"></div>
                <div id="bclt-window-status" class="status-text room-list-footer-status"></div>
            </div>
            <div class="panel-card panel-card-form">
                <div class="panel-title-row">
                    <strong>${t("room_create_room")}</strong>
                    <span class="panel-pill">${t("room_host_badge")}</span>
                </div>
                <div class="panel-card-body settings-form">
                    <div class="form-group">
                        <label>${t("room_name_label")}</label>
                        <input id="bclt-room-id" type="text" placeholder="${t("room_name_placeholder")}" />
                    </div>
                    <div class="form-group">
                        <label>${t("room_passcode_label")}</label>
                        <input id="bclt-room-passcode" type="password" placeholder="${t("room_passcode_placeholder")}" />
                    </div>
                </div>
                <button id="bclt-create-room" class="btn-primary">${t("room_create_btn")}</button>
            </div>
        </div>
    `);
    const fields = {
      roomPasscode: windowInstance.content.querySelector("#bclt-room-passcode"),
      roomId: windowInstance.content.querySelector("#bclt-room-id")
    };
    fields.roomPasscode.value = state.settings.roomPasscode;
    fields.roomId.value = state.settings.roomId;
    const saveSettings_local = () => {
      state.settings.roomPasscode = fields.roomPasscode.value.trim();
      state.settings.roomId = fields.roomId.value.trim();
      saveSettings();
    };
    Object.values(fields).forEach((el) => {
      el.addEventListener("change", saveSettings_local);
      el.addEventListener("blur", saveSettings_local);
    });
    windowInstance.content.querySelector("#bclt-refresh-rooms").addEventListener("click", async () => {
      await loadAndDisplayRooms();
    });
    windowInstance.content.querySelector("#bclt-create-room").addEventListener("click", () => {
      createRoomAndJoin(fields.roomId.value);
    });
    loadAndDisplayRooms();
    windowInstance.show();
  }
  function promptForPasscodeAndJoin(room) {
    if (room && room.isLocked) {
      const passcode = prompt(t("passcode_prompt", { roomName: room.roomName || room.name || room.id }));
      if (passcode === null) return;
      const trimmedPasscode = passcode.trim();
      if (!trimmedPasscode) {
        alert(t("passcode_required"));
        return;
      }
      state.settings.roomPasscode = trimmedPasscode;
    } else {
      state.settings.roomPasscode = "";
    }
    state.settings.isHost = false;
    state.settings.roomHostMemberId = room && room.hostMemberId ? String(room.hostMemberId) : "";
    setRoomAdminMemberIds([]);
    state.settings.roomName = room && (room.roomName || room.name || room.id) ? room.roomName || room.name || room.id : state.settings.roomId;
    state.currentRoomHostName = room && room.host ? String(room.host) : "";
    saveSettings();
    showPlayerMode();
  }
  function formatRoomToolbarLabel() {
    const roomName = state.settings.roomName || state.settings.roomId || t("unknown_room");
    const hostName = String(state.currentRoomHostName || "").trim();
    return hostName ? `${roomName} | ${t("toolbar_host")}: ${hostName}` : roomName;
  }
  async function createRoomAndJoin(inputRoomName) {
    try {
      const roomName = String(inputRoomName || "").trim();
      if (!roomName) {
        alert(t("alert_enter_room_name"));
        return;
      }
      state.settings.roomPasscode = String(state.settings.roomPasscode || "").trim();
      state.settings.roomId = roomName;
      state.settings.roomName = roomName;
      state.settings.isHost = true;
      state.settings.roomHostMemberId = memberId();
      setRoomAdminMemberIds([]);
      state.currentRoomHostName = effectiveDisplayName();
      await createRoomRecord();
      saveSettings();
      showPlayerMode();
    } catch (error) {
      alert(t("create_room_failed", { message: error.message }));
      console.error("[BCLT] create room failed:", error);
    }
  }
  async function loadAndDisplayRooms() {
    const roomList = windowInstance.content.querySelector("#bclt-room-list");
    const statusEl = windowInstance.content.querySelector("#bclt-window-status");
    if (!roomList || !statusEl) return;
    roomList.innerHTML = `<div class="empty-state">${t("room_loading")}</div>`;
    statusEl.textContent = "";
    try {
      const rooms = await fetchAvailableRooms();
      roomList.innerHTML = "";
      if (rooms.length === 0) {
        roomList.innerHTML = `<div class="empty-state">${t("room_none")}</div>`;
      } else {
        rooms.forEach((room) => {
          const item = document.createElement("div");
          item.className = "room-item";
          item.innerHTML = `
                    <div class="room-item-title-row">
                        <div class="room-item-title">${room.roomName || room.displayName || room.name || room.id}</div>
                        ${room.isLocked ? `<span class="room-lock-indicator" title="${t("room_locked")}">🔒</span>` : ""}
                    </div>
                    <div class="room-item-info">${t("room_host_prefix")}: ${room.host || t("unknown_room")}</div>
                    <div class="room-item-info">${t("room_online_count", { count: room.members })}</div>
                `;
          item.onclick = () => {
            state.settings.roomId = room.id;
            saveSettings();
            promptForPasscodeAndJoin(room);
          };
          roomList.appendChild(item);
        });
      }
      statusEl.textContent = t("room_loaded_count", { count: rooms.length });
    } catch (error) {
      roomList.innerHTML = `<div class="empty-state" style="color: #fca5a5;">${t("room_load_error")}</div>`;
      statusEl.textContent = `Error: ${error.message}`;
      console.error("[BCLT] Error loading rooms:", error);
    }
  }
  async function openPermissionManagementModal() {
    if (!(windowInstance == null ? void 0 : windowInstance.container) || !state.settings.isHost) {
      alert(t("only_host_manage_permissions"));
      return;
    }
    const existing = windowInstance.container.querySelector(".permission-modal-backdrop");
    if (existing) existing.remove();
    const members = await fetchRoomMembers({ includeStale: false, excludeSelf: false });
    if (!members.length) {
      alert(t("no_active_members"));
      return;
    }
    const hostMemberId = String(state.settings.roomHostMemberId || memberId());
    let selectedHostId = hostMemberId;
    const selectedAdminIds = new Set(state.roomAdminMemberIds);
    const backdrop = document.createElement("div");
    backdrop.className = "permission-modal-backdrop";
    backdrop.innerHTML = `
        <div class="permission-modal" role="dialog" aria-modal="true" aria-label="${t("player_manage_permissions")}">
            <div class="permission-modal-head">
                <div>
                    <strong>${t("player_manage_permissions")}</strong>
                    <div class="permission-modal-sub">${t("permission_modal_sub")}</div>
                </div>
                <button type="button" class="btn-neutral btn-small" id="bclt-permission-close">${t("permission_close")}</button>
            </div>
            <div class="permission-user-list" id="bclt-permission-user-list"></div>
            <div class="permission-note">${t("permission_note")}</div>
            <div class="permission-modal-foot">
                <button type="button" class="btn-neutral" id="bclt-permission-cancel">${t("permission_cancel")}</button>
                <button type="button" class="btn-accent" id="bclt-permission-save">${t("permission_save")}</button>
            </div>
        </div>
    `;
    const listEl = backdrop.querySelector("#bclt-permission-user-list");
    const renderRows = () => {
      listEl.innerHTML = "";
      members.forEach((member) => {
        const row = document.createElement("label");
        row.className = "permission-user-row";
        row.innerHTML = `
                <div>
                    <div class="permission-user-name">${member.displayName}</div>
                    <span class="permission-user-id">ID: ${member.memberId}</span>
                </div>
                <span class="permission-col">
                    <input type="radio" name="bclt-perm-host" value="${member.memberId}" ${selectedHostId === member.memberId ? "checked" : ""} />
                    ${t("role_host")}
                </span>
                <span class="permission-col">
                    <input type="checkbox" name="bclt-perm-admin" value="${member.memberId}" ${selectedAdminIds.has(member.memberId) && selectedHostId !== member.memberId ? "checked" : ""} ${selectedHostId === member.memberId ? "disabled" : ""} />
                    ${t("role_admin")}
                </span>
            `;
        listEl.appendChild(row);
      });
      listEl.querySelectorAll('input[name="bclt-perm-host"]').forEach((radio) => {
        radio.addEventListener("change", () => {
          selectedHostId = String(radio.value || "").trim();
          if (selectedHostId) selectedAdminIds.delete(selectedHostId);
          renderRows();
        });
      });
      listEl.querySelectorAll('input[name="bclt-perm-admin"]').forEach((checkbox) => {
        checkbox.addEventListener("change", () => {
          const id = String(checkbox.value || "").trim();
          if (!id || id === selectedHostId) return;
          if (checkbox.checked) selectedAdminIds.add(id);
          else selectedAdminIds.delete(id);
        });
      });
    };
    renderRows();
    windowInstance.container.appendChild(backdrop);
    const closeModal = () => backdrop.remove();
    backdrop.querySelector("#bclt-permission-close").onclick = closeModal;
    backdrop.querySelector("#bclt-permission-cancel").onclick = closeModal;
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeModal();
    });
    backdrop.querySelector("#bclt-permission-save").onclick = async () => {
      var _a;
      try {
        const nextHostId = String(selectedHostId || "").trim();
        if (!nextHostId) {
          alert(t("select_one_host"));
          return;
        }
        const nextAdminIds = Array.from(selectedAdminIds).map((id) => String(id || "").trim()).filter((id) => !!id && id !== nextHostId);
        const hostChanged = nextHostId !== String(state.settings.roomHostMemberId || memberId());
        if (hostChanged) {
          const nextHostMember = members.find((m) => m.memberId === nextHostId);
          await transferRoomOwnership(nextHostId, { adminMemberIds: nextAdminIds });
          if (nextHostMember) {
            state.currentRoomHostName = nextHostMember.displayName;
          }
          saveSettings();
          updatePlaybackUi(t("ownership_transferred_to", {
            name: nextHostMember ? nextHostMember.displayName : nextHostId
          }));
          logStatus(t("permissions_updated_transferred"));
        } else {
          setRoomAdminMemberIds(nextAdminIds, nextHostId);
          await publish("room_control", {
            action: "admin_members_updated",
            adminMemberIds: [...state.roomAdminMemberIds],
            at: Date.now()
          });
          updatePlaybackUi(t("admin_permissions_updated"));
          logStatus(t("admin_permissions_updated"));
        }
        const roomNameEl = (_a = windowInstance == null ? void 0 : windowInstance.headerEl) == null ? void 0 : _a.querySelector("#bclt-toolbar-room-name");
        if (roomNameEl) {
          roomNameEl.textContent = formatRoomToolbarLabel();
        }
        refreshHostUiPrivileges();
        updateVideoList();
        closeModal();
      } catch (error) {
        alert(`Save permission changes failed: ${error.message}`);
        console.error("[BCLT] save permission changes failed:", error);
      }
    };
  }
  function showPlayerMode() {
    var _a, _b, _c;
    const playerTitle = t("window_player_title");
    removeBilibiliEmbed();
    stopPlaybackUiTicker();
    playbackSeekMaxSeconds = 3600;
    autoAdvanceTriggerToken = "";
    autoAdvanceInFlight = false;
    nowPlayingHighlightToken = "";
    const normalizedMode = normalizePlaybackMode(state.settings.playbackMode);
    if (normalizedMode !== state.settings.playbackMode) {
      state.settings.playbackMode = normalizedMode;
      saveSettings();
    }
    if (!windowInstance) {
      windowInstance = new DraggableWindow({
        title: playerTitle,
        width: 1e3,
        height: 680,
        onMinimizeChanged: setMainButtonSpinning
      });
      windowInstance.create();
    }
    windowInstance.setTitle(playerTitle);
    (_a = windowInstance.container) == null ? void 0 : _a.classList.add("bclt-player-mode");
    resizeWindowForMode(1e3, 680);
    windowInstance.setContent(`
        <div class="player-container">
            <div class="player-panel">
                <div id="bclt-player-container" class="video-stage">
                    <div class="empty-state">${t("player_no_video_playing")}</div>
                </div>
                <button id="bclt-btn-exit-immersive" class="immersive-exit-btn" type="button" title="${t("immersive_exit")}">${t("immersive_exit")}</button>
                <div class="player-room-tools">
                    <label class="sync-progress-toggle" for="bclt-sync-progress">
                        <input id="bclt-sync-progress" type="checkbox" />
                        <span>${t("player_sync_progress")}</span>
                    </label>
                    <label class="sync-progress-toggle" for="bclt-hq-tab-mode">
                        <input id="bclt-hq-tab-mode" type="checkbox" />
                        <span>${t("player_hq_mode")}</span>
                    </label>
                    <label class="sync-progress-toggle" for="bclt-immersive-mode">
                        <input id="bclt-immersive-mode" type="checkbox" />
                        <span>${t("player_immersive_mode")}</span>
                    </label>
                </div>
                <div class="player-progress">
                    <div class="player-progress-track">
                        <button id="bclt-btn-toggle-play" class="media-toggle-btn" type="button" title="Play">▶</button>
                        <button id="bclt-btn-skip-next" class="skip-track-btn" type="button" title="${t("skip_to_next")}">⏭</button>
                        <input id="bclt-progress-range" type="range" min="0" max="3600" step="1" value="0" />
                    </div>
                    <div class="player-progress-meta">
                        <span id="bclt-progress-current">0:00</span>
                        <span id="bclt-progress-max">60:00</span>
                        <span id="bclt-sync-indicator" class="sync-indicator" title="Sync status"></span>
                    </div>
                </div>
                <div id="bclt-player-status" class="status-text status-emphasis">${t("player_status_ready")}</div>
            </div>
            <div class="video-list">
                <div class="video-list-header">
                    <div class="video-list-title">${t("player_shared_videos")}</div>
                    <div class="video-list-header-row video-add-row">
                        <input id="bclt-add-video-input" class="add-video-input" type="text" placeholder="${t("player_add_placeholder")}" />
                        <button id="bclt-btn-add-video" class="btn-accent btn-small" type="button">${t("player_add_btn")}</button>
                        <button id="bclt-btn-add-local-video" class="btn-small add-local-btn" type="button">${t("player_add_local_btn")}</button>
                    </div>
                    <div class="video-list-header-row video-toolbar-row">
                        <div class="playlist-actions">
                            <button id="bclt-btn-import-playlist" class="btn-neutral btn-small playlist-io-btn" type="button">${t("player_import_btn")}</button>
                            <button id="bclt-btn-export-playlist" class="btn-neutral btn-small playlist-io-btn" type="button">${t("player_export_btn")}</button>
                            <button id="bclt-btn-register-local-video" class="btn-neutral btn-small playlist-io-btn" type="button">${t("player_register_local_btn")}</button>
                        </div>
                        <div id="bclt-mode-slider" class="mode-slider" data-mode="list" title="${t("player_mode_title")}">
                            <button class="mode-slider-btn" data-mode="list" type="button" title="${t("mode_list_loop")}">🔁</button>
                            <button class="mode-slider-btn" data-mode="single" type="button" title="${t("mode_single_loop")}">🔂</button>
                            <button class="mode-slider-btn" data-mode="shuffle" type="button" title="${t("mode_shuffle")}">🔀</button>
                        </div>
                    </div>
                    <input id="bclt-import-playlist-input" type="file" accept="application/json,.json" style="display:none" />
                    <input id="bclt-add-local-video-input" type="file" accept="video/*,audio/*" multiple style="display:none" />
                    <input id="bclt-register-local-video-input" type="file" accept="video/*,audio/*" multiple style="display:none" />
                </div>
                <div class="video-list-content" id="bclt-video-list"></div>
                <div class="video-list-footer">
                    <button id="bclt-btn-manage-permissions" class="permission-entry-btn">${t("player_manage_permissions")}</button>
                </div>
            </div>
        </div>
    `);
    const toolbarLeaveBtnId = "bclt-toolbar-leave";
    const toolbarRoomNameId = "bclt-toolbar-room-name";
    const closeBtn = (_b = windowInstance.headerEl) == null ? void 0 : _b.querySelector(".bclt-close-btn");
    const actionsEl = closeBtn == null ? void 0 : closeBtn.parentElement;
    if (closeBtn && actionsEl && actionsEl.parentElement === windowInstance.headerEl) {
      let roomNameEl = windowInstance.headerEl.querySelector(`#${toolbarRoomNameId}`);
      if (!roomNameEl) {
        roomNameEl = document.createElement("span");
        roomNameEl.id = toolbarRoomNameId;
        roomNameEl.className = "toolbar-room-name";
        windowInstance.headerEl.insertBefore(roomNameEl, actionsEl);
      }
      roomNameEl.textContent = formatRoomToolbarLabel();
      let leaveBtn = actionsEl.querySelector(`#${toolbarLeaveBtnId}`);
      if (!leaveBtn) {
        leaveBtn = document.createElement("button");
        leaveBtn.id = toolbarLeaveBtnId;
        leaveBtn.type = "button";
        leaveBtn.className = "toolbar-leave-btn";
        leaveBtn.textContent = t("leave");
        actionsEl.insertBefore(leaveBtn, closeBtn);
      }
    }
    windowInstance.content.querySelector("#bclt-player-container");
    windowInstance.content.querySelector("#bclt-video-list");
    windowInstance.content.querySelector("#bclt-player-status");
    const syncProgressCheckbox = windowInstance.content.querySelector("#bclt-sync-progress");
    const highQualityModeCheckbox = windowInstance.content.querySelector("#bclt-hq-tab-mode");
    const immersiveModeCheckbox = windowInstance.content.querySelector("#bclt-immersive-mode");
    const immersiveExitBtn = windowInstance.content.querySelector("#bclt-btn-exit-immersive");
    const addVideoInput = windowInstance.content.querySelector("#bclt-add-video-input");
    const addVideoBtn = windowInstance.content.querySelector("#bclt-btn-add-video");
    const addLocalVideoBtn = windowInstance.content.querySelector("#bclt-btn-add-local-video");
    const importPlaylistBtn = windowInstance.content.querySelector("#bclt-btn-import-playlist");
    const exportPlaylistBtn = windowInstance.content.querySelector("#bclt-btn-export-playlist");
    const registerLocalVideoBtn = windowInstance.content.querySelector("#bclt-btn-register-local-video");
    const importPlaylistInput = windowInstance.content.querySelector("#bclt-import-playlist-input");
    const addLocalVideoInput = windowInstance.content.querySelector("#bclt-add-local-video-input");
    const registerLocalVideoInput = windowInstance.content.querySelector("#bclt-register-local-video-input");
    const managePermissionsBtn = windowInstance.content.querySelector("#bclt-btn-manage-permissions");
    const modeButtons = windowInstance.content.querySelectorAll(".mode-slider-btn");
    syncProgressCheckbox.checked = state.settings.syncPlaybackProgress !== false;
    highQualityModeCheckbox.checked = isHighQualityTabModeEnabled();
    immersiveModeCheckbox.checked = isImmersiveModeEnabled();
    updatePlaybackModeUi();
    refreshHostUiPrivileges();
    syncProgressCheckbox.addEventListener("change", () => {
      state.settings.syncPlaybackProgress = !!syncProgressCheckbox.checked;
      saveSettings();
      updateSyncControlLockUi();
      updateVideoList();
      updatePlaybackUi(state.settings.syncPlaybackProgress ? t("progress_sync_on") : t("progress_sync_off"));
    });
    highQualityModeCheckbox.addEventListener("change", async () => {
      state.settings.highQualityTabMode = !!highQualityModeCheckbox.checked;
      saveSettings();
      const snapshot = computeBilibiliSyntheticState();
      if (!snapshot.sourceUrl) {
        updatePlaybackUi(state.settings.highQualityTabMode ? t("hq_mode_on") : t("hq_mode_off"));
        return;
      }
      if (state.settings.highQualityTabMode) {
        await applyRoomPlaybackState(snapshot, {
          publishState: false,
          reason: "hq-tab-mode-toggle-on",
          forceReload: true,
          syncProgress: state.settings.syncPlaybackProgress !== false,
          statusHint: t("hq_mode_on")
        });
        return;
      }
      closeHighQualityPlaybackTab();
      await applyRoomPlaybackState(snapshot, {
        publishState: false,
        reason: "hq-tab-mode-toggle-off",
        forceReload: true,
        syncProgress: state.settings.syncPlaybackProgress !== false,
        statusHint: t("hq_mode_off")
      });
    });
    immersiveModeCheckbox.addEventListener("change", () => {
      setImmersiveMode(immersiveModeCheckbox.checked, {
        save: true,
        statusHint: immersiveModeCheckbox.checked ? t("immersive_mode_on") : t("immersive_mode_off")
      });
    });
    immersiveExitBtn.addEventListener("click", () => {
      setImmersiveMode(false, {
        save: true,
        statusHint: t("immersive_mode_off")
      });
    });
    modeButtons.forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!state.settings.isHost) return;
        await setPlaybackMode(btn.getAttribute("data-mode") || "list", {
          save: true,
          publishMode: true,
          statusHint: t("play_mode_updated")
        });
      });
    });
    const submitInlineVideo = async () => {
      if (!canManagePlaylist()) {
        alert(t("only_host_admin_add_video"));
        return;
      }
      const value = String((addVideoInput == null ? void 0 : addVideoInput.value) || "").trim();
      if (!value) {
        updatePlaybackUi(t("input_bv_hint"));
        return;
      }
      await addVideoToRoom(value);
      if (addVideoInput) {
        addVideoInput.value = "";
        addVideoInput.focus();
      }
    };
    addVideoBtn.addEventListener("click", submitInlineVideo);
    addVideoInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void submitInlineVideo();
      }
    });
    exportPlaylistBtn.addEventListener("click", () => {
      exportPlaylistAsJson();
    });
    importPlaylistBtn.addEventListener("click", () => {
      if (!canManagePlaylist()) {
        alert(t("host_admin_import_playlist"));
        return;
      }
      importPlaylistInput.click();
    });
    importPlaylistInput.addEventListener("change", async (event) => {
      if (!canManagePlaylist()) return;
      const file = event.target.files && event.target.files[0];
      if (file) {
        await importPlaylistFromJsonFile(file);
      }
      importPlaylistInput.value = "";
    });
    addLocalVideoBtn.addEventListener("click", () => {
      if (!canManagePlaylist()) {
        alert(t("host_admin_add_video"));
        return;
      }
      addLocalVideoInput.click();
    });
    addLocalVideoInput.addEventListener("change", async (event) => {
      if (!canManagePlaylist()) return;
      const files = Array.from(event.target.files || []);
      for (const file of files) {
        await addLocalVideoToRoom(file);
      }
      addLocalVideoInput.value = "";
    });
    registerLocalVideoBtn.addEventListener("click", () => {
      registerLocalVideoInput.click();
    });
    registerLocalVideoInput.addEventListener("change", async (event) => {
      const files = Array.from(event.target.files || []);
      if (!files.length) {
        updatePlaybackUi(t("local_video_register_none"));
        registerLocalVideoInput.value = "";
        return;
      }
      let success = 0;
      for (const file of files) {
        const result = registerLocalVideoFile(file, { announce: false });
        if (result) success += 1;
      }
      if (success > 0) {
        updatePlaybackUi(t("local_video_register_result", { count: success }));
      } else {
        updatePlaybackUi(t("local_video_register_invalid"));
      }
      registerLocalVideoInput.value = "";
    });
    managePermissionsBtn.addEventListener("click", async () => {
      if (!state.settings.isHost) {
        alert(t("only_host_manage_permissions"));
        return;
      }
      await openPermissionManagementModal();
    });
    windowInstance.content.querySelector("#bclt-btn-toggle-play").addEventListener("click", async () => {
      if (isSyncControlLocked()) return;
      const synthetic = computeBilibiliSyntheticState();
      if (synthetic.paused) {
        await controlRoomPlayback("play");
      } else {
        await controlRoomPlayback("pause");
      }
    });
    windowInstance.content.querySelector("#bclt-btn-skip-next").addEventListener("click", async () => {
      if (!state.settings.isHost) return;
      const currentIndex = getCurrentPlayingVideoIndex();
      const nextVideo = pickNextVideoByMode(state.settings.playbackMode, currentIndex);
      if (!nextVideo || !nextVideo.bvid) {
        updatePlaybackUi(t("no_next_video"));
        return;
      }
      await playVideo(nextVideo, {
        publish: true,
        reason: "host-skip-next",
        statusHint: `${t("skip_mode_prefix")}: ${getPlaybackModeLabel(state.settings.playbackMode)}`
      });
    });
    windowInstance.content.querySelector("#bclt-progress-range").addEventListener("change", async (event) => {
      if (isSyncControlLocked()) return;
      const seconds = Number(event.target.value || 0);
      await controlRoomPlayback("seek", seconds);
    });
    const leaveToolbarBtn = (_c = windowInstance.headerEl) == null ? void 0 : _c.querySelector("#bclt-toolbar-leave");
    const leaveFromToolbar = async () => {
      clearRoomCallbacks();
      stopPlaybackUiTicker();
      closeHighQualityPlaybackTab({ destroySession: true });
      activeVideos = [];
      setRoomAdminMemberIds([]);
      await leaveRoom();
      state.currentRoomHostName = "";
      showRoomListMode();
    };
    if (leaveToolbarBtn) {
      leaveToolbarBtn.onclick = leaveFromToolbar;
    }
    setImmersiveMode(isImmersiveModeEnabled(), { save: false });
    initializeRoomMode();
    windowInstance.show();
  }
  function buildPlaylistExportPayload() {
    return {
      schema: "bclt.playlist.v1",
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      roomId: String(state.settings.roomId || ""),
      roomName: String(state.settings.roomName || ""),
      playbackMode: normalizePlaybackMode(state.settings.playbackMode),
      videos: activeVideos.map((video) => ({
        bvid: String(video.bvid || ""),
        title: sanitizeBilibiliText(video.title || ""),
        url: String(video.url || ""),
        sender: String(video.sender || ""),
        timestamp: Number(video.timestamp || Date.now())
      }))
    };
  }
  function downloadJson(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 1e3);
  }
  function buildPlaylistExportFilename() {
    const now = /* @__PURE__ */ new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hour = String(now.getHours()).padStart(2, "0");
    const minute = String(now.getMinutes()).padStart(2, "0");
    const second = String(now.getSeconds()).padStart(2, "0");
    return `bclt-playlist-${year}${month}${day}-${hour}${minute}${second}.json`;
  }
  function exportPlaylistAsJson() {
    const payload = buildPlaylistExportPayload();
    downloadJson(buildPlaylistExportFilename(), payload);
    updatePlaybackUi(t("playlist_exported"));
  }
  function extractPlaylistImportEntries(parsed) {
    if (Array.isArray(parsed)) return parsed;
    if (!parsed || typeof parsed !== "object") return [];
    if (Array.isArray(parsed.videos)) return parsed.videos;
    if (Array.isArray(parsed.playlist)) return parsed.playlist;
    if (Array.isArray(parsed.items)) return parsed.items;
    return [];
  }
  function normalizePlaylistImportEntry(entry) {
    if (!entry) return null;
    if (typeof entry === "string") {
      const text = entry.trim();
      return text ? text : null;
    }
    if (typeof entry !== "object") return null;
    const bvid = String(entry.bvid || "").trim();
    const url = String(entry.url || "").trim();
    const title = sanitizeBilibiliText(entry.title || "");
    const source = String(entry.source || entry.input || "").trim();
    if (bvid || url || source) {
      return {
        bvid,
        url,
        title,
        source
      };
    }
    return null;
  }
  async function importPlaylistFromJsonFile(file) {
    if (!canManagePlaylist()) {
      alert(t("host_admin_import_playlist"));
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (error) {
      alert(t("playlist_import_invalid_json"));
      return;
    }
    const entries = extractPlaylistImportEntries(parsed).map(normalizePlaylistImportEntry).filter(Boolean);
    if (!entries.length) {
      alert(t("playlist_import_empty"));
      return;
    }
    let success = 0;
    let failed = 0;
    for (const entry of entries) {
      const candidate = typeof entry === "string" ? entry : entry.bvid || entry.url || entry.source || "";
      if (!candidate) {
        failed += 1;
        continue;
      }
      const ok = await addVideoToRoom(typeof entry === "string" ? candidate : {
        bvid: entry.bvid || candidate,
        url: entry.url || candidate,
        title: entry.title || ""
      }, { silent: true });
      if (ok) success += 1;
      else failed += 1;
    }
    updatePlaybackUi(t("playlist_import_result", { success, failed }));
  }
  function hashFileIdentifier(file) {
    const size = file.size || 0;
    let hash = 5381;
    const sizeStr = String(size);
    for (let i = 0; i < sizeStr.length; i++) {
      hash = (hash << 5) + hash + sizeStr.charCodeAt(i);
    }
    return Math.abs(hash >>> 0).toString(36).substring(0, 12);
  }
  const localVideoFilesByHash = /* @__PURE__ */ new Map();
  function registerLocalVideoFile(file, options = {}) {
    const { announce = true } = options;
    if (!isSupportedLocalMediaFile(file)) {
      if (announce) {
        alert(t("local_video_register_invalid"));
      }
      return null;
    }
    const fileHash = hashFileIdentifier(file);
    const fileName = file.name || "Local Video";
    const title = fileName.replace(/\.[^/.]+$/, "");
    const existing = localVideoFilesByHash.get(fileHash) || {};
    const hasFileChanged = !!existing.file && existing.file !== file;
    if (hasFileChanged && existing.objectUrl) {
      URL.revokeObjectURL(existing.objectUrl);
    }
    localVideoFilesByHash.set(fileHash, {
      ...existing,
      file,
      name: fileName,
      size: file.size,
      time: Date.now(),
      remote: existing.remote === true,
      objectUrl: hasFileChanged ? "" : existing.objectUrl || ""
    });
    if (announce) {
      logStatus(t("local_video_registered", { title }));
    }
    return { fileHash, fileName, title };
  }
  async function addLocalVideoToRoom(file) {
    if (!canManagePlaylist()) {
      alert(t("host_admin_add_video"));
      return;
    }
    try {
      const registered = registerLocalVideoFile(file, { announce: false });
      if (!registered) {
        return false;
      }
      const { fileHash, fileName, title } = registered;
      const localVideoUrl = `local://${fileHash}`;
      const senderName = effectiveDisplayName();
      const shareId = `${memberId()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      mergeActiveVideos([{
        shareId,
        sender: senderName,
        title,
        bvid: `#local_${fileHash}`,
        mediaKind: "local_video",
        url: localVideoUrl,
        timestamp: Date.now()
      }]);
      await publish("video_shared", {
        shareId,
        bvid: `#local_${fileHash}`,
        mediaKind: "local_video",
        title,
        url: localVideoUrl,
        senderName,
        fileHash,
        fileName,
        fileSize: file.size
      });
      updateVideoList();
      logStatus(`Added local video: ${title}`);
      return true;
    } catch (error) {
      alert(`Error adding local video: ${error.message}`);
      console.error("[BCLT] Error adding local video:", error);
      return false;
    }
  }
  async function addVideoToRoom(bilibiliBvId, options = {}) {
    const { silent = false } = options;
    try {
      const sourceText = typeof bilibiliBvId === "string" ? bilibiliBvId : String((bilibiliBvId == null ? void 0 : bilibiliBvId.url) || (bilibiliBvId == null ? void 0 : bilibiliBvId.bvid) || "");
      const inputBvid = typeof bilibiliBvId === "object" && (bilibiliBvId == null ? void 0 : bilibiliBvId.bvid) ? String(bilibiliBvId.bvid) : sourceText;
      const youtubeId = parseYouTubeVideoId(sourceText || inputBvid);
      const isVideoURL = isDirectMediaUrl(sourceText || inputBvid);
      const mediaKind = youtubeId ? "youtube" : isVideoURL ? "video" : "bilibili";
      let mediaId = inputBvid;
      if (mediaKind === "youtube") {
        mediaId = youtubeId;
      } else if (mediaKind === "video") {
        const parts = (sourceText || inputBvid).split(/[\/\?#]+/);
        mediaId = parts[parts.length - 1] || "video";
        if (mediaId.length > 50) mediaId = mediaId.substring(0, 30) + "...";
      } else if (sourceText.includes("bilibili.com") || sourceText.includes("b23.tv")) {
        const match = sourceText.match(/(BV[0-9A-Za-z]{10,})/i);
        if (!match) throw new Error("Cannot extract BV ID from URL");
        mediaId = match[1];
      }
      if (mediaKind === "bilibili" && !/^BV[0-9A-Za-z]{10,}$/i.test(mediaId)) {
        throw new Error("Invalid BV ID format");
      }
      if (mediaKind === "youtube" && !/^[a-zA-Z0-9_-]{11}$/.test(mediaId)) {
        throw new Error("Invalid video ID format");
      }
      const titleCandidate = typeof bilibiliBvId === "object" && (bilibiliBvId == null ? void 0 : bilibiliBvId.title) ? sanitizeBilibiliText(bilibiliBvId.title) : "";
      let title = "";
      if (titleCandidate) {
        title = titleCandidate;
      } else if (mediaKind === "youtube") {
        title = await fetchYouTubeTitleByVideoId(mediaId) || `Video ${mediaId}`;
      } else if (mediaKind === "video") {
        title = decodeURIComponent(mediaId);
      } else {
        title = await fetchBilibiliVideoTitleByBvid(mediaId);
      }
      const videoUrl = typeof bilibiliBvId === "object" && (bilibiliBvId == null ? void 0 : bilibiliBvId.url) ? String(bilibiliBvId.url) : mediaKind === "youtube" ? normalizeYouTubeSourceUrl(`https://www.youtube.com/watch?v=${mediaId}`) : mediaKind === "video" ? sourceText || inputBvid : `https://www.bilibili.com/video/${mediaId}`;
      const senderName = effectiveDisplayName();
      const shareId = `${memberId()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      mergeActiveVideos([{
        shareId,
        sender: senderName,
        title,
        bvid: mediaId,
        mediaKind,
        url: videoUrl,
        timestamp: Date.now()
      }]);
      await publish("video_shared", {
        shareId,
        bvid: mediaId,
        mediaKind,
        title,
        url: videoUrl,
        senderName
      });
      updateVideoList();
      logStatus(`Added: ${title}`);
      return true;
    } catch (error) {
      if (!silent) {
        alert(`Error: ${error.message}`);
      }
      console.error("[BCLT] Error adding video:", error);
      return false;
    }
  }
  function removeVideoByReference(reference, options = {}) {
    const { publishRemoval = false } = options;
    const normalizedRef = normalizeActiveVideo(reference) || reference;
    const referenceShareId = normalizedRef && normalizedRef.shareId ? String(normalizedRef.shareId) : "";
    const referenceBvid = normalizedRef && normalizedRef.bvid ? String(normalizedRef.bvid).toUpperCase() : "";
    const removeIndex = activeVideos.findIndex((video) => {
      if (referenceShareId && String(video.shareId || "") === referenceShareId) return true;
      return referenceBvid && String(video.bvid || "").toUpperCase() === referenceBvid;
    });
    if (removeIndex < 0) return false;
    const [removed] = activeVideos.splice(removeIndex, 1);
    updateVideoList();
    if (publishRemoval && canManagePlaylist()) {
      void publish("room_control", {
        action: "playlist_video_removed",
        shareId: removed.shareId || "",
        bvid: removed.bvid,
        sender: removed.sender,
        at: Date.now()
      });
    }
    return true;
  }
  function updateVideoList() {
    var _a;
    const videoList = (_a = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _a.querySelector("#bclt-video-list");
    if (!videoList) return;
    videoList.innerHTML = "";
    const currentPlayingIndex = getCurrentPlayingVideoIndex();
    const filteredVideos = activeVideos;
    if (activeVideos.length === 0) {
      videoList.innerHTML = `<div class="empty-state">${t("no_videos_shared")}</div>`;
    } else if (!filteredVideos.length) {
      videoList.innerHTML = '<div class="empty-state">No matching videos</div>';
    } else {
      filteredVideos.forEach((video, index) => {
        const item = document.createElement("div");
        item.className = "video-item";
        const isActive = currentPlayingIndex >= 0 && index === currentPlayingIndex;
        const syncLocked = isSyncControlLocked();
        if (isActive) item.classList.add("active");
        const main = document.createElement("div");
        main.className = "video-item-main";
        const title = sanitizeBilibiliText(video.title || video.bvid) || video.bvid;
        const nameEl = document.createElement("div");
        nameEl.className = "video-item-name";
        nameEl.title = title;
        nameEl.textContent = `${title}${isActive ? ` (${t("now_playing")})` : ""}`;
        main.appendChild(nameEl);
        const metaEl = document.createElement("div");
        metaEl.className = "video-item-meta";
        metaEl.textContent = video.bvid;
        main.appendChild(metaEl);
        const senderEl = document.createElement("div");
        senderEl.className = "video-item-user";
        senderEl.textContent = video.sender;
        main.appendChild(senderEl);
        main.classList.toggle("sync-locked", syncLocked);
        main.onclick = () => {
          if (isSyncControlLocked()) return;
          playVideo(video, {
            publish: state.settings.isHost,
            reason: "video-select"
          });
        };
        void enrichVideoTitle(video);
        item.appendChild(main);
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "video-item-remove";
        removeBtn.textContent = t("video_delete");
        const canRemove = canManagePlaylist();
        removeBtn.disabled = !canRemove;
        removeBtn.title = canRemove ? t("delete_video_title") : t("only_host_admin_delete_video");
        removeBtn.onclick = async (event) => {
          event.stopPropagation();
          if (!canManagePlaylist()) {
            alert(t("only_host_admin_delete_video"));
            return;
          }
          const currentIndex = getCurrentPlayingVideoIndex();
          const targetIndexBeforeRemove = activeVideos.findIndex((candidate) => {
            if (video.shareId && candidate.shareId) {
              return candidate.shareId === video.shareId;
            }
            return String(candidate.bvid || "").toUpperCase() === String(video.bvid || "").toUpperCase();
          });
          const removed = removeVideoByReference(video, { publishRemoval: true });
          if (!removed) return;
          const removedIsCurrent = currentIndex >= 0 && currentIndex === targetIndexBeforeRemove;
          if (removedIsCurrent && activeVideos.length > 0 && state.settings.isHost) {
            const fallbackIndex = Math.min(Math.max(targetIndexBeforeRemove, 0), activeVideos.length - 1);
            const nextVideo = activeVideos[fallbackIndex];
            if (nextVideo && nextVideo.bvid) {
              await playVideo(nextVideo, {
                publish: true,
                reason: "playlist-delete-switch",
                statusHint: t("current_deleted_switched")
              });
            }
          }
        };
        item.appendChild(removeBtn);
        videoList.appendChild(item);
      });
    }
    nowPlayingHighlightToken = buildNowPlayingHighlightToken();
  }
  function stopPlaybackUiTicker() {
    if (playbackUiTimer) {
      clearInterval(playbackUiTimer);
      playbackUiTimer = null;
    }
  }
  function updateSyncIndicator(active = false) {
    var _a;
    const indicator = (_a = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _a.querySelector("#bclt-sync-indicator");
    if (!indicator) return;
    indicator.classList.toggle("is-active", !!active);
  }
  function updateMediaToggleButton(snapshot) {
    var _a;
    const btn = (_a = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _a.querySelector("#bclt-btn-toggle-play");
    if (!btn || !snapshot) return;
    const paused = !!snapshot.paused;
    btn.textContent = paused ? "▶" : "❚❚";
    btn.title = paused ? t("action_play") : t("action_pause");
    btn.classList.toggle("is-paused", !paused);
  }
  function bindInlineVideoStateSync(videoEl, sourceUrl) {
    if (!(videoEl instanceof HTMLVideoElement)) return;
    const syncFromElement = (reason = "inline-video-sync") => {
      var _a;
      const activeVideo = (_a = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _a.querySelector("#bclt-player-container video");
      if (!videoEl.isConnected || activeVideo !== videoEl) {
        return;
      }
      const fallbackSource = String(computeBilibiliSyntheticState().sourceUrl || state.bilibili.sourceUrl || "");
      const resolvedSource = String(sourceUrl || videoEl.dataset.bcltSourceUrl || fallbackSource || "").trim();
      if (!resolvedSource) return;
      const duration = Number.isFinite(Number(videoEl.duration)) && Number(videoEl.duration) > 0 ? Number(videoEl.duration) : null;
      setBilibiliSyntheticState({
        sourceUrl: resolvedSource,
        currentTime: Number.isFinite(Number(videoEl.currentTime)) ? Number(videoEl.currentTime) : 0,
        duration,
        paused: !!videoEl.paused,
        playbackRate: Number.isFinite(Number(videoEl.playbackRate)) && Number(videoEl.playbackRate) > 0 ? Number(videoEl.playbackRate) : 1
      }, reason);
    };
    videoEl.dataset.bcltSourceUrl = String(sourceUrl || videoEl.dataset.bcltSourceUrl || "").trim();
    if (videoEl.dataset.bcltSyncBound === "1") {
      return;
    }
    const publishIfHost = () => {
      if (!state.settings.isHost || state.settings.syncPlaybackProgress === false) return;
      if (Date.now() < Number(state.remoteGuardUntil || 0)) return;
      void publish("media_state", computeBilibiliSyntheticState());
    };
    const handleState = () => {
      syncFromElement("inline-video-state");
      updatePlaybackUi();
      publishIfHost();
    };
    videoEl.dataset.bcltSyncBound = "1";
    videoEl.addEventListener("loadedmetadata", handleState);
    videoEl.addEventListener("play", handleState);
    videoEl.addEventListener("pause", handleState);
    videoEl.addEventListener("ratechange", handleState);
    videoEl.addEventListener("seeked", handleState);
  }
  function updatePlaybackUi(statusHint = "") {
    var _a, _b, _c, _d;
    const currentLabel = (_a = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _a.querySelector("#bclt-progress-current");
    const maxLabel = (_b = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _b.querySelector("#bclt-progress-max");
    const rangeEl = (_c = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _c.querySelector("#bclt-progress-range");
    const statusEl = (_d = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _d.querySelector("#bclt-player-status");
    if (!currentLabel || !maxLabel || !rangeEl || !statusEl) return;
    const snapshot = computeBilibiliSyntheticState();
    refreshNowPlayingHighlightIfNeeded();
    const currentTime = Math.max(0, Number(snapshot.currentTime) || 0);
    const knownDuration = Number(snapshot.duration);
    const hasKnownDuration = Number.isFinite(knownDuration) && knownDuration > 0;
    if (hasKnownDuration) {
      playbackSeekMaxSeconds = Math.max(Math.ceil(knownDuration), Math.ceil(currentTime) + 1);
    } else {
      playbackSeekMaxSeconds = Math.max(playbackSeekMaxSeconds, Math.ceil(currentTime) + 30);
    }
    rangeEl.max = String(playbackSeekMaxSeconds);
    rangeEl.value = String(Math.min(playbackSeekMaxSeconds, Math.floor(currentTime)));
    currentLabel.textContent = secondsToHms(currentTime);
    maxLabel.textContent = secondsToHms(playbackSeekMaxSeconds);
    const mode = snapshot.paused ? t("playback_paused") : t("playback_playing");
    const role = roleLabel();
    statusEl.textContent = `${role} | ${mode} @ ${secondsToHms(currentTime)} | ${getPlaybackModeLabel(state.settings.playbackMode)}`;
    updateMediaToggleButton(snapshot);
    updateSyncIndicator(Boolean(statusHint));
  }
  function startPlaybackUiTicker() {
    stopPlaybackUiTicker();
    playbackUiTimer = window.setInterval(() => {
      const snapshot = computeBilibiliSyntheticState();
      updatePlaybackUi();
      void maybeAutoAdvanceFromSnapshot(snapshot);
    }, 500);
  }
  async function applyRoomPlaybackState(nextState, options = {}) {
    var _a, _b, _c;
    const {
      publishState = false,
      reason = "local",
      forceReload = false,
      statusHint = "",
      syncProgress = true
    } = options;
    if (nextState && nextState.playbackMode) {
      await setPlaybackMode(nextState.playbackMode, {
        save: true,
        publishMode: false,
        statusHint: ""
      });
    }
    const sourceUrl = nextState.sourceUrl || state.bilibili.sourceUrl;
    if (!sourceUrl) return false;
    const current = computeBilibiliSyntheticState();
    const incomingTime = Number.isFinite(Number(nextState.currentTime)) ? Number(nextState.currentTime) : current.currentTime;
    const targetTime = syncProgress ? incomingTime : current.currentTime;
    const incomingPaused = typeof nextState.paused === "boolean" ? nextState.paused : current.paused;
    const incomingRate = Number.isFinite(Number(nextState.playbackRate)) && Number(nextState.playbackRate) > 0 ? Number(nextState.playbackRate) : current.playbackRate;
    const playerContainer = (_a = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _a.querySelector("#bclt-player-container");
    const iframeEl = (_b = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _b.querySelector("#bclt-player-container iframe, #bclt-player-container video");
    if (!playerContainer) return false;
    const mediaKind = detectMediaKind(sourceUrl);
    const userEnabledHighQualityTab = isHighQualityTabModeEnabled();
    const sourceAllowsHighQualityTab = canUseHighQualityTabForSource(sourceUrl, targetTime);
    const highQualityMode = userEnabledHighQualityTab && sourceAllowsHighQualityTab;
    const shouldDriveHighQualityTab = highQualityMode && !incomingPaused;
    if (mediaKind === "youtube") {
      closeHighQualityPlaybackTab();
    }
    const thresholdSeconds = Math.max(0.1, Number(state.settings.driftThresholdMs || 800) / 1e3);
    const driftSeconds = Math.abs(targetTime - current.currentTime);
    const sourceChanged = normalizeBilibiliSourceForSync(sourceUrl) !== normalizeBilibiliSourceForSync(current.sourceUrl);
    const pausedChanged = incomingPaused !== current.paused;
    const rateChanged = incomingRate !== current.playbackRate;
    const isRemoteSyncReason = reason === "remote-sync" || reason === "remote-playlist-state";
    if (isRemoteSyncReason) {
      state.remoteGuardUntil = Date.now() + 700;
    }
    const missingInlineIframe = !highQualityMode && !iframeEl;
    const isInlineVideo = !highQualityMode && (mediaKind === "video" || mediaKind === "local_video");
    const shouldReloadByState = forceReload || missingInlineIframe || sourceChanged || !isInlineVideo && (pausedChanged || rateChanged);
    const shouldReloadByDrift = syncProgress && driftSeconds > thresholdSeconds;
    let shouldReload = shouldReloadByState || !isInlineVideo && shouldReloadByDrift;
    if (isInlineVideo && !shouldReloadByState && !sourceChanged && !missingInlineIframe) {
      const videoEl = (_c = windowInstance == null ? void 0 : windowInstance.content) == null ? void 0 : _c.querySelector("#bclt-player-container video");
      if (videoEl) {
        bindInlineVideoStateSync(videoEl, sourceUrl);
        if (shouldReloadByDrift) {
          videoEl.currentTime = targetTime;
        }
        if (pausedChanged) {
          if (incomingPaused && !videoEl.paused) videoEl.pause();
          if (!incomingPaused && videoEl.paused) videoEl.play().catch((e) => console.warn("[BCLT] play:", e));
        }
        if (rateChanged) {
          videoEl.playbackRate = incomingRate;
        }
      }
    }
    setBilibiliSyntheticState({
      sourceUrl,
      currentTime: targetTime,
      duration: nextState.duration,
      paused: incomingPaused,
      playbackRate: incomingRate
    }, reason);
    const shouldHydrateDuration = !Number.isFinite(Number(nextState.duration)) || Number(nextState.duration) <= 0;
    if (shouldHydrateDuration && (sourceChanged || !Number.isFinite(Number(current.duration)) || Number(current.duration) <= 0)) {
      void hydrateBilibiliDuration(sourceUrl).then((duration) => {
        if (!Number.isFinite(Number(duration)) || Number(duration) <= 0) return;
        updatePlaybackUi();
        if (state.settings.isHost && state.settings.syncPlaybackProgress !== false) {
          void publish("media_state", computeBilibiliSyntheticState());
        }
      }).catch((error) => {
        console.warn("[BCLT] duration hydration failed:", error);
      });
    }
    if (highQualityMode) {
      if (!shouldReloadByState && shouldReloadByDrift && isRemoteSyncReason) {
        const hqDriftThreshold = Math.max(HQ_TAB_REMOTE_DRIFT_THRESHOLD_SECONDS, thresholdSeconds);
        const now = Date.now();
        const inCooldown = now - highQualityTabLastSyncAt < HQ_TAB_REMOTE_SYNC_COOLDOWN_MS;
        const exceedsHqThreshold = driftSeconds > hqDriftThreshold;
        shouldReload = !inCooldown && exceedsHqThreshold;
      }
      renderHighQualityPlaceholder();
      console.log("[BCLT] High-quality tab mode enabled, shouldReload:", shouldReload);
      if (shouldReload) {
        if (!shouldDriveHighQualityTab) {
          console.log("[BCLT] HQ mode paused: closing popup window instead of relying on autoplay flag.");
          closeHighQualityPlaybackTab();
          updatePlaybackUi(t("hq_paused_parked"));
          highQualityTabLastSyncAt = Date.now();
        } else {
          const hasExistingTab = !!(highQualityPlaybackTab && !highQualityPlaybackTab.closed);
          const allowOpen = hasExistingTab || !isRemoteSyncReason || sourceChanged;
          console.log("[BCLT] Attempting to update or open high-quality playback tab...");
          const result = updateOrOpenHighQualityPlaybackTab(sourceUrl, targetTime, { autoplay: true, allowOpen });
          console.log("[BCLT] Tab operation result:", result);
          if (!result.ok) {
            const noLocalFileForTab = mediaKind === "local_video" && !resolveLocalVideoObjectUrlByHash(sourceUrl.replace("local://", ""));
            const fallbackMessage = noLocalFileForTab ? "Local video not registered on this device for tab mode" : "HQ tab operation failed";
            console.warn("[BCLT] Tab operation failed:", result.message || fallbackMessage);
            updatePlaybackUi(result.message || fallbackMessage);
          } else {
            if (result.action === "skipped" || result.action === "noop") {
              updatePlaybackUi("HQ tab unchanged");
            } else {
              const actionText = result.action === "updated" ? "Updated" : "Opened";
              updatePlaybackUi(`${actionText} playback tab: ${result.watchUrl.split("/").slice(-1)[0]}`);
              highQualityTabLastSyncAt = Date.now();
            }
          }
        }
      } else {
        console.log("[BCLT] shouldReload is false, not updating tab");
      }
    } else if (shouldReload) {
      closeHighQualityPlaybackTab();
      if (mediaKind === "local_video") {
        const fileHash = sourceUrl.replace("local://", "");
        const fileInfo = localVideoFilesByHash.get(fileHash);
        if (fileInfo && fileInfo.file) {
          const objectUrl = resolveLocalVideoObjectUrlByHash(fileHash);
          playerContainer.innerHTML = `<video src="${objectUrl}" style="width:100%;height:100%;background:#000;" controls></video>`;
          const videoEl = playerContainer.querySelector("video");
          bindInlineVideoStateSync(videoEl, sourceUrl);
          videoEl.currentTime = targetTime;
          videoEl.playbackRate = incomingRate;
          if (!incomingPaused) {
            videoEl.play().catch((e) => console.warn("[BCLT] Video play blocked:", e));
          }
        } else {
          playerContainer.innerHTML = `<div style="width:100%;height:100%;background:#000;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;">
                    <div style="text-align:center;">
                        <div>⚠️ Local video not available</div>
                        <div style="font-size:12px;margin-top:4px;">Sync controls remain active</div>
                    </div>
                </div>`;
        }
      } else if (mediaKind === "video") {
        playerContainer.innerHTML = `<video src="${sourceUrl}" style="width:100%;height:100%;background:#000;" controls></video>`;
        const videoEl = playerContainer.querySelector("video");
        bindInlineVideoStateSync(videoEl, sourceUrl);
        videoEl.currentTime = targetTime;
        videoEl.playbackRate = incomingRate;
        if (!incomingPaused) {
          videoEl.play().catch((e) => console.warn("[BCLT] Video play blocked:", e));
        }
      } else {
        const playerUrl = mediaKind === "youtube" ? buildYouTubePlayerUrl(sourceUrl, {
          currentTime: targetTime,
          autoplay: !incomingPaused
        }) : buildBilibiliPlayerUrl(sourceUrl, {
          currentTime: targetTime,
          autoplay: !incomingPaused
        });
        if (!playerUrl) return false;
        playerContainer.innerHTML = `<iframe src="${playerUrl}" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
      }
    }
    updatePlaybackUi(statusHint);
    if (publishState && state.settings.isHost && state.settings.syncPlaybackProgress !== false) {
      await publish("media_state", computeBilibiliSyntheticState());
    }
    return true;
  }
  async function controlRoomPlayback(action, value = 0) {
    const current = computeBilibiliSyntheticState();
    const sourceUrl = current.sourceUrl || state.bilibili.sourceUrl;
    if (!sourceUrl) {
      alert(t("select_video_first"));
      return;
    }
    if (action === "play") {
      await applyRoomPlaybackState({
        sourceUrl,
        currentTime: current.currentTime,
        paused: false,
        playbackRate: current.playbackRate
      }, { publishState: true, reason: "local-play", forceReload: true });
      return;
    }
    if (action === "pause") {
      await applyRoomPlaybackState({
        sourceUrl,
        currentTime: current.currentTime,
        paused: true,
        playbackRate: current.playbackRate
      }, { publishState: true, reason: "local-pause", forceReload: true });
      return;
    }
    if (action === "seek") {
      await applyRoomPlaybackState({
        sourceUrl,
        currentTime: Math.max(0, Number(value) || 0),
        paused: current.paused,
        playbackRate: current.playbackRate
      }, { publishState: true, reason: "local-seek", forceReload: true });
    }
  }
  async function playVideo(target, options = {}) {
    const sourceText = typeof target === "string" ? target : String((target == null ? void 0 : target.url) || (target == null ? void 0 : target.sourceUrl) || (target == null ? void 0 : target.bvid) || "");
    (target == null ? void 0 : target.mediaKind) || "bilibili";
    if (sourceText.startsWith("local://")) {
      const fileHash = sourceText.replace("local://", "");
      const fileInfo = localVideoFilesByHash.get(fileHash);
      if (!fileInfo || !fileInfo.file) {
        logStatus(`⚠️ Local video not found on this system (hash: ${fileHash.substring(0, 6)}...)`);
      } else {
        logStatus(`Playing local video: ${fileInfo.name}`);
      }
    }
    const youtubeId = parseYouTubeVideoId(sourceText);
    const bvid = parseBilibiliBvid(sourceText);
    const sourceUrl = youtubeId ? normalizeYouTubeSourceUrl(sourceText || `https://www.youtube.com/watch?v=${youtubeId}`) : bvid ? `https://www.bilibili.com/video/${bvid}?t=1` : sourceText;
    if (!sourceUrl) return;
    await applyRoomPlaybackState({
      sourceUrl,
      currentTime: 0,
      paused: false,
      playbackRate: 1
    }, {
      publishState: !!options.publish,
      reason: options.reason || "video-select",
      forceReload: true,
      statusHint: options.statusHint || ""
    });
  }
  function initializeRoomMode(playerContainer, videoList, statusEl) {
    state.onRemoteVideoShared = async (payload) => {
      if (payload && payload.bvid) {
        if (payload.shareId && activeVideos.some((video) => video.shareId === payload.shareId)) {
          return;
        }
        const sender = payload.senderName || payload.sender || "Unknown";
        if (payload.mediaKind === "local_video" && payload.fileHash) {
          const existing = localVideoFilesByHash.get(payload.fileHash) || {};
          localVideoFilesByHash.set(payload.fileHash, {
            ...existing,
            remote: true,
            name: existing.name || payload.fileName || "Remote Local Video",
            size: existing.size || payload.fileSize || 0,
            time: Date.now(),
            senderId: payload.senderId,
            file: existing.file || null
          });
        }
        mergeActiveVideos([{
          shareId: payload.shareId || "",
          sender,
          title: payload.title || payload.videoTitle || payload.bvid,
          bvid: payload.bvid,
          mediaKind: payload.mediaKind || "bilibili",
          url: payload.url || `https://www.bilibili.com/video/${payload.bvid}`,
          timestamp: Number(payload.timestamp || Date.now())
        }]);
        updateVideoList();
        logStatus(`${sender} shared: ${payload.title || payload.bvid}`);
      }
    };
    state.onRemotePlaylistRequest = async (payload) => {
      if (!state.settings.isHost) return false;
      const requesterId = payload && payload.requesterId ? String(payload.requesterId) : "";
      if (requesterId && requesterId === memberId()) return false;
      await publish("playlist_state", buildPlaylistStatePayload(requesterId));
      return true;
    };
    state.onRemotePlaylistState = async (payload, envelope) => {
      if (!payload) return false;
      const targetMemberId = payload.targetMemberId ? String(payload.targetMemberId) : "";
      if (targetMemberId && targetMemberId !== memberId()) return false;
      const knownHostMemberId = String(state.settings.roomHostMemberId || "");
      if (!state.settings.isHost && knownHostMemberId && envelope && envelope.senderId && envelope.senderId !== knownHostMemberId) {
        return false;
      }
      mergeActiveVideos(Array.isArray(payload.videos) ? payload.videos : []);
      setRoomAdminMemberIds(payload.adminMemberIds);
      if (payload.playbackMode) {
        await setPlaybackMode(payload.playbackMode, {
          save: true,
          publishMode: false
        });
      }
      refreshHostUiPrivileges();
      updateVideoList();
      resetPlaylistSnapshotRequestState();
      const localSyncProgress = state.settings.syncPlaybackProgress !== false;
      const payloadSyncProgress = payload.syncProgress !== false;
      if (payload.mediaState && localSyncProgress && payloadSyncProgress) {
        await applyRoomPlaybackState(payload.mediaState, {
          publishState: false,
          reason: "remote-playlist-state",
          forceReload: false,
          syncProgress: true,
          statusHint: "sync"
        });
      }
      return true;
    };
    state.onRoomConnected = async () => {
      if (state.settings.isHost) return;
      await requestPlaylistSnapshotWithRetry();
    };
    state.onRemoteMediaState = async (payload, envelope) => {
      if (!payload) return false;
      if (state.settings.syncPlaybackProgress === false || payload.syncProgress === false) {
        return true;
      }
      const sourceUrl = payload.sourceUrl || payload.src || (payload.mediaKind === "youtube" && payload.videoId ? `https://www.youtube.com/watch?v=${payload.videoId}` : "") || (payload.bvid ? `https://www.bilibili.com/video/${payload.bvid}` : "");
      const isSupported = /bilibili\.com|b23\.tv|BV[0-9A-Za-z]{10,}/i.test(sourceUrl) || isYouTubeUrl(sourceUrl) || !!parseYouTubeVideoId(sourceUrl) || String(sourceUrl).startsWith("local://") || payload.mediaKind === "local_video" || isDirectMediaUrl(sourceUrl);
      if (!isSupported || !sourceUrl) return false;
      const localSyncProgress = state.settings.syncPlaybackProgress !== false;
      const payloadSyncProgress = payload.syncProgress !== false;
      const shouldSyncProgress = localSyncProgress && payloadSyncProgress;
      const applied = await applyRoomPlaybackState({
        sourceUrl,
        currentTime: payload.currentTime,
        duration: payload.duration,
        paused: payload.paused,
        playbackRate: payload.playbackRate,
        playbackMode: payload.playbackMode
      }, {
        publishState: false,
        reason: "remote-sync",
        forceReload: false,
        syncProgress: shouldSyncProgress,
        statusHint: "sync"
      });
      return applied;
    };
    state.onRemoteRoomControl = async (payload, envelope) => {
      var _a;
      if (!payload || !payload.action) return false;
      if (payload.action === "ownership_transferred") {
        const newHostId = payload.newHostMemberId ? String(payload.newHostMemberId) : "";
        if (!newHostId) return false;
        state.settings.roomHostMemberId = newHostId;
        state.settings.isHost = newHostId === memberId();
        setRoomAdminMemberIds(payload.adminMemberIds);
        if (payload.newHostDisplayName) {
          state.currentRoomHostName = String(payload.newHostDisplayName);
        }
        saveSettings();
        refreshHostUiPrivileges();
        updateVideoList();
        updatePlaybackUi(state.settings.isHost ? t("now_you_are_host") : t("host_changed_to", { name: payload.newHostDisplayName || newHostId }));
        const roomNameEl = (_a = windowInstance == null ? void 0 : windowInstance.headerEl) == null ? void 0 : _a.querySelector("#bclt-toolbar-room-name");
        if (roomNameEl) {
          roomNameEl.textContent = formatRoomToolbarLabel();
        }
        logStatus(`Ownership transferred by ${envelope.senderName || envelope.senderId}`);
        return true;
      }
      if (payload.action === "admin_members_updated") {
        const senderId = envelope && envelope.senderId ? String(envelope.senderId) : "";
        if (!senderId || senderId !== String(state.settings.roomHostMemberId || "")) return false;
        setRoomAdminMemberIds(payload.adminMemberIds);
        refreshHostUiPrivileges();
        updateVideoList();
        updatePlaybackUi(t("admins_synced"));
        return true;
      }
      if (payload.action === "playback_mode_changed") {
        await setPlaybackMode(payload.playbackMode, {
          save: true,
          publishMode: false,
          statusHint: t("play_mode_synced")
        });
        return true;
      }
      if (payload.action === "playlist_video_removed") {
        const senderId = envelope && envelope.senderId ? String(envelope.senderId) : "";
        const hostId = String(state.settings.roomHostMemberId || "");
        const senderIsHost = senderId && hostId && senderId === hostId;
        const senderIsAdmin = senderId && state.roomAdminMemberIds.includes(senderId);
        if (!senderIsHost && !senderIsAdmin) return false;
        const removed = removeVideoByReference(payload, { publishRemoval: false });
        if (removed) {
          updatePlaybackUi(t("playlist_updated"));
        }
        return removed;
      }
      return false;
    };
    startPlaybackUiTicker();
    joinRoom();
    updateVideoList();
    updatePlaybackUi();
    void (async () => {
      try {
        if (state.settings.syncPlaybackProgress === false) return;
        const snapshot = await fetchCurrentRoomPlaybackState();
        if (!snapshot) return;
        await applyRoomPlaybackState(snapshot, {
          publishState: false,
          reason: "hydrate-room-state",
          forceReload: true,
          syncProgress: state.settings.syncPlaybackProgress !== false,
          statusHint: "sync"
        });
      } catch (error) {
        console.warn("[BCLT] hydrate room state failed:", error);
      }
    })();
  }
  function clearRoomCallbacks() {
    resetPlaylistSnapshotRequestState();
    state.onRemoteVideoShared = null;
    state.onRemoteMediaState = null;
    state.onRemotePlaylistState = null;
    state.onRemotePlaylistRequest = null;
    state.onRemoteRoomControl = null;
    state.onRoomConnected = null;
  }
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
    if (state.settings.syncPlaybackProgress === false) return;
    const mediaState = readLocalMediaState();
    if (!mediaState) return;
    await publish("media_state", mediaState);
  }
  async function start() {
    await waitForGameReady();
    setLocalChangeNotifier(async () => {
      await publishLocalMediaState();
    });
    createUI();
    bindMediaHooks(publishLocalMediaState);
    logStatus("Ready");
  }
  start().catch((error) => {
    console.error("[BCLT] fatal start error:", error);
  });

})();