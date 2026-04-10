import { removeBilibiliEmbed, buildBilibiliPlayerUrl, computeBilibiliSyntheticState, setBilibiliSyntheticState, secondsToHms, hydrateBilibiliDuration, parseBilibiliBvid } from './bilibili.js';
import { APP_ID, effectiveDisplayName, logStatus, saveSettings, state, memberId } from './state.js';
import {
    joinRoom,
    leaveRoom,
    publish,
    createRoomRecord,
    fetchAvailableRooms,
    fetchCurrentRoomPlaybackState,
    fetchRoomMembers,
    transferRoomOwnership,
} from './sync.js';

// ============ DRAGGABLE WINDOW SYSTEM ============
class DraggableWindow {
    constructor(options = {}) {
        this.title = options.title || 'Window';
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
        this.onMinimizeChanged = typeof options.onMinimizeChanged === 'function' ? options.onMinimizeChanged : null;
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
        this.container.style.left = this.x + 'px';
        this.container.style.top = this.y + 'px';
    }

    create() {
        this.container = document.createElement('div');
        this.container.id = 'bclt-window';
        this.container.className = 'bclt-shell';
        const viewportPadding = 16;
        const maxWidth = Math.max(320, window.innerWidth - viewportPadding * 2);
        const maxHeight = Math.max(320, window.innerHeight - viewportPadding * 2);
        this.width = Math.min(this.width, maxWidth);
        this.height = Math.min(this.height, maxHeight);
        this.container.style.position = 'fixed';
        this.container.style.left = this.x + 'px';
        this.container.style.top = this.y + 'px';
        this.container.style.width = this.width + 'px';
        this.container.style.height = this.height + 'px';
        this.container.style.zIndex = '100000';
        this.container.style.background = 'var(--bclt-surface)';
        this.container.style.border = '1px solid var(--bclt-border)';
        this.container.style.borderRadius = '18px';
        this.container.style.boxShadow = '0 22px 48px rgba(6, 12, 24, 0.56)';
        this.container.style.color = 'var(--bclt-text-main)';
        this.container.style.fontFamily = "'Sora', 'Avenir Next', 'Noto Sans SC', 'Microsoft YaHei UI', sans-serif";
        this.container.style.display = 'flex';
        this.container.style.flexDirection = 'column';
        this.container.style.overflow = 'hidden';
        this.container.style.backdropFilter = 'blur(14px)';
        this.container.style.animation = 'bclt-window-enter 220ms ease-out';
        this.container.style.minWidth = this.minWidth + 'px';
        this.container.style.minHeight = this.minHeight + 'px';

        // Header
        this.headerEl = document.createElement('div');
        this.headerEl.className = 'bclt-window-header';
        this.headerEl.style.padding = '14px 16px';
        this.headerEl.style.display = 'flex';
        this.headerEl.style.alignItems = 'center';
        this.headerEl.style.justifyContent = 'space-between';
        this.headerEl.style.borderBottom = '1px solid var(--bclt-border-soft)';
        this.headerEl.style.fontSize = '14px';
        this.headerEl.style.fontWeight = '800';
        this.headerEl.style.cursor = 'move';
        this.headerEl.style.userSelect = 'none';

        const title = document.createElement('span');
        title.className = 'bclt-window-title';
        title.textContent = this.title;
        this.headerEl.appendChild(title);

        const actions = document.createElement('div');
        actions.className = 'bclt-window-actions';
        actions.style.display = 'flex';
        actions.style.alignItems = 'center';
        actions.style.gap = '8px';

        const languageSelect = document.createElement('select');
        languageSelect.id = 'bclt-language-select';
        languageSelect.className = 'bclt-language-select';
        languageSelect.title = t('language_label');
        languageSelect.style.height = '30px';
        languageSelect.style.borderRadius = '8px';
        languageSelect.style.border = '1px solid rgba(255,255,255,0.18)';
        languageSelect.style.background = 'rgba(255,255,255,0.05)';
        languageSelect.style.color = 'var(--bclt-text-main)';
        languageSelect.style.padding = '0 8px';
        languageSelect.style.fontSize = '12px';
        languageSelect.style.cursor = 'pointer';
        Object.entries(SUPPORTED_LANGS).forEach(([lang, label]) => {
            const option = document.createElement('option');
            option.value = lang;
            option.textContent = label;
            option.style.color = '#0f172a';
            languageSelect.appendChild(option);
        });
        languageSelect.value = getLanguage();
        languageSelect.addEventListener('change', () => {
            applyLanguage(languageSelect.value);
        });
        actions.appendChild(languageSelect);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'bclt-close-btn';
        closeBtn.textContent = '×';
        closeBtn.type = 'button';
        closeBtn.onclick = () => this.close();

        const minimizeBtn = document.createElement('button');
        minimizeBtn.className = 'bclt-minimize-btn';
        minimizeBtn.id = 'bclt-minimize-btn';
        minimizeBtn.textContent = '−';
        minimizeBtn.type = 'button';
        minimizeBtn.onclick = () => this.toggleMinimize();

        actions.appendChild(minimizeBtn);
        actions.appendChild(closeBtn);

        this.headerEl.appendChild(actions);

        this.container.appendChild(this.headerEl);

        // Content
        this.content = document.createElement('div');
        this.content.className = 'bclt-window-content';
        this.content.style.flex = '1';
        this.content.style.overflow = 'auto';
        this.content.style.padding = '14px';
        this.container.appendChild(this.content);

        // Resize handle
        this.resizerEl = document.createElement('div');
        this.resizerEl.className = 'bclt-window-resizer';
        this.container.appendChild(this.resizerEl);

        // Add drag listeners
        this.headerEl.addEventListener('mousedown', (e) => this.onDragStart(e));
        this.resizerEl.addEventListener('mousedown', (e) => this.onResizeStart(e));
        document.addEventListener('mousemove', (e) => this.onDragMove(e));
        document.addEventListener('mousemove', (e) => this.onResizeMove(e));
        document.addEventListener('mouseup', () => this.onDragEnd());
        document.addEventListener('mouseup', () => this.onResizeEnd());

        return this.container;
    }

    onDragStart(e) {
        if (this.isResizing || this.isMinimized) return;
        if (e.target && typeof e.target.closest === 'function' && (e.target.closest('.bclt-close-btn') || e.target.closest('.bclt-minimize-btn') || e.target.closest('.bclt-language-select'))) return;
        this.isDragging = true;
        this.dragOffsetX = e.clientX - this.x;
        this.dragOffsetY = e.clientY - this.y;
        this.container.classList.add('dragging');
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
            this.container.classList.remove('dragging');
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
        this.container.classList.add('resizing');
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
        this.container.style.width = this.width + 'px';
        this.container.style.height = this.height + 'px';
        this.clampPosition();
    }

    onResizeEnd() {
        if (!this.isResizing) return;
        this.isResizing = false;
        if (this.container) {
            this.container.classList.remove('resizing');
            this.clampPosition();
        }
    }

    setMinimized(nextMinimized) {
        const shouldMinimize = !!nextMinimized;
        if (!this.container || shouldMinimize === this.isMinimized) return;

        this.isMinimized = shouldMinimize;
        this.container.classList.toggle('is-minimized', shouldMinimize);
        this.container.style.display = shouldMinimize ? 'none' : 'flex';

        const minimizeBtn = this.headerEl?.querySelector('#bclt-minimize-btn');
        if (minimizeBtn) {
            minimizeBtn.title = shouldMinimize ? t('window_restore') : t('window_minimize');
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
        this.title = nextTitle;
        const titleEl = this.headerEl?.querySelector('.bclt-window-title') || this.headerEl?.querySelector('span');
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

// ============ UI STATE MANAGEMENT ============
let windowInstance = null;
let buttonElement = null;
let activeVideos = []; // Store videos shared by room members
let playbackUiTimer = null;
let playbackSeekMaxSeconds = 3600;
let autoAdvanceTriggerToken = '';
let autoAdvanceInFlight = false;
let highQualityPlaybackTab = null;
let highQualityTabLastSyncAt = 0;
let nowPlayingHighlightToken = '';
const bilibiliVideoTitleTaskByBvid = new Map();
let isDraggingMainButton = false;
let suppressNextMainButtonClick = false;
const mainButtonDragState = {
    dragging: false,
    moved: false,
    startX: 0,
    startY: 0,
    startLeft: 0,
    startTop: 0,
};

const SUPPORTED_LANGS = {
    zh: '中文',
    en: 'EN',
};

const HQ_TAB_REMOTE_DRIFT_THRESHOLD_SECONDS = 12;
const HQ_TAB_REMOTE_SYNC_COOLDOWN_MS = 10000;

const I18N = {
    zh: {
        mode_list_loop: '列表循环',
        mode_single_loop: '单曲循环',
        mode_shuffle: '随机播放',
        role_host: '房主',
        role_admin: '管理员',
        role_member: '成员',
        window_rooms_title: 'BC 一起听 - 房间',
        window_player_title: 'BC 一起听 - 播放器',
        hq_placeholder: '已启用高画质标签页模式。播放会在 Bilibili 标签页中进行。',
        language_label: '语言',
        window_minimize: '最小化',
        window_restore: '还原',
        host_only_change_mode: '仅房主可切换播放模式',
        host_only_permission: '仅房主可管理房主/管理员权限',
        host_admin_add_video: '仅房主/管理员可添加视频',
        host_only_skip: '仅房主可切歌',
        skip_to_next: '切到下一首',
        failed_build_watch_url: '构建 Bilibili 播放链接失败。',
        popup_blocked: '无法打开窗口（可能被浏览器拦截弹窗），请允许当前站点弹窗。',
        room_available_rooms: '可用房间',
        room_refresh: '刷新',
        room_create_room: '创建房间',
        room_host_badge: '房主',
        room_name_label: '房间名（房间 ID）',
        room_name_placeholder: '请输入唯一房间名',
        room_passcode_label: '房间密码（可选）',
        room_passcode_placeholder: '可选密码',
        room_create_btn: '创建房间',
        room_loading: '正在加载房间...',
        room_none: '暂无可用房间',
        room_loaded_count: '已加载 {count} 个房间',
        room_load_error: '加载房间失败',
        room_locked: '加锁房间',
        room_host_prefix: '房主',
        room_online_count: '{count} 人在线',
        passcode_prompt: '请输入房间密码：{roomName}',
        passcode_required: '该房间已加锁，必须输入密码。',
        unknown_room: '未知房间',
        toolbar_host: '房主',
        alert_enter_room_name: '请输入房间名称。',
        create_room_failed: '创建房间失败：{message}',
        no_active_members: '当前房间没有活跃成员。',
        select_one_host: '请选择一位房主。',
        permissions_updated_transferred: '权限已更新并已转移房主',
        admin_permissions_updated: '管理员权限已更新',
        ownership_transferred_to: '房主已转移给 {name}',
        player_no_video_playing: '当前未播放视频',
        player_sync_progress: '同步播放进度',
        player_hq_mode: '高画质标签页模式（GM_openInTab）',
        player_status_ready: '准备就绪',
        player_shared_videos: '共享视频',
        player_add_placeholder: '粘贴 Bilibili 链接或 BV 号',
        player_add_btn: '+ 添加',
        player_mode_title: '播放模式',
        player_manage_permissions: '房主/管理员权限',
        permission_modal_sub: '活跃成员（包含你自己）。房主为单选，管理员为多选。',
        permission_close: '关闭',
        permission_cancel: '取消',
        permission_save: '保存更改',
        permission_note: '显示名 = 成员记录中的注册显示名。',
        leave: '离开',
        only_host_manage_permissions: '仅房主可管理权限。',
        only_host_admin_add_video: '仅房主/管理员可添加视频。',
        input_bv_hint: '请输入 Bilibili 链接或 BV 号',
        progress_sync_on: '进度同步：开启',
        progress_sync_off: '进度同步：关闭',
        hq_mode_on: '高画质标签页模式已开启',
        hq_mode_off: '高画质标签页模式已关闭',
        hq_paused_parked: '高画质暂停：已停靠弹窗',
        play_mode_updated: '播放模式已更新',
        no_next_video: '没有可播放的下一条视频',
        auto_mode_prefix: '自动',
        skip_mode_prefix: '切换',
        current_deleted_switched: '当前视频已删除，已切到下一条',
        video_delete: '删除',
        delete_video_title: '从播放列表删除该视频',
        only_host_admin_delete_video: '仅房主/管理员可删除视频',
        now_playing: '正在播放',
        no_videos_shared: '还没有人分享视频',
        playback_paused: '暂停',
        playback_playing: '播放中',
        action_play: '播放',
        action_pause: '暂停',
        mode_set: '播放模式：{mode}',
        connected_sync: '同步',
        ready: '准备就绪',
        select_video_first: '请先在共享视频里选择一个视频。',
        host_changed_to: '房主已切换为 {name}',
        now_you_are_host: '你已成为房主',
        admins_synced: '管理员已同步',
        play_mode_synced: '播放模式已同步',
        playlist_updated: '播放列表已更新',
    },
    en: {
        mode_list_loop: 'List Loop',
        mode_single_loop: 'Single Loop',
        mode_shuffle: 'Shuffle',
        role_host: 'Host',
        role_admin: 'Admin',
        role_member: 'Member',
        window_rooms_title: 'BC Listen Together - Rooms',
        window_player_title: 'BC Listen Together - Player',
        hq_placeholder: 'High-Quality Tab Mode is active. Playback is opened in Bilibili tab.',
        language_label: 'Language',
        window_minimize: 'Minimize',
        window_restore: 'Restore',
        host_only_change_mode: 'Only host can change play mode',
        host_only_permission: 'Only host can manage host/admin permissions',
        host_admin_add_video: 'Only host/admin can add videos',
        host_only_skip: 'Only host can skip tracks',
        skip_to_next: 'Skip to next video',
        failed_build_watch_url: 'Failed to build Bilibili watch URL.',
        popup_blocked: 'Failed to open window (popup may be blocked). Allow popups for this site.',
        room_available_rooms: 'Available Rooms',
        room_refresh: 'Refresh',
        room_create_room: 'Create Room',
        room_host_badge: 'Host',
        room_name_label: 'Room Name (Room ID)',
        room_name_placeholder: 'Enter a unique room name',
        room_passcode_label: 'Room Passcode (Optional)',
        room_passcode_placeholder: 'optional passcode',
        room_create_btn: 'Create Room',
        room_loading: 'Loading rooms...',
        room_none: 'No rooms available',
        room_loaded_count: 'Loaded {count} room(s)',
        room_load_error: 'Error loading rooms',
        room_locked: 'Locked room',
        room_host_prefix: 'host',
        room_online_count: '{count} online',
        passcode_prompt: 'Enter passcode for room: {roomName}',
        passcode_required: 'This room is locked. Passcode is required.',
        unknown_room: 'Unknown Room',
        toolbar_host: 'Host',
        alert_enter_room_name: 'Please enter a room name.',
        create_room_failed: 'Failed to create room: {message}',
        no_active_members: 'No active members found in this room.',
        select_one_host: 'Please select one host.',
        permissions_updated_transferred: 'Permissions updated and ownership transferred',
        admin_permissions_updated: 'Admin permissions updated',
        ownership_transferred_to: 'Ownership transferred to {name}',
        player_no_video_playing: 'No video playing',
        player_sync_progress: 'Sync Playback Progress',
        player_hq_mode: 'High-Quality Tab Mode (GM_openInTab)',
        player_status_ready: 'Ready',
        player_shared_videos: 'Shared Videos',
        player_add_placeholder: 'Paste Bilibili URL or BV',
        player_add_btn: '+ Add',
        player_mode_title: 'Playback mode',
        player_manage_permissions: 'Host/Admin Permissions',
        permission_modal_sub: 'Active members (including yourself). Host is single-select, Admin is multi-select.',
        permission_close: 'Close',
        permission_cancel: 'Cancel',
        permission_save: 'Save Changes',
        permission_note: 'Display Name = registered display name in room member records.',
        leave: 'Leave',
        only_host_manage_permissions: 'Only host can manage permissions.',
        only_host_admin_add_video: 'Only host/admin can add videos.',
        input_bv_hint: 'Please input a Bilibili URL or BV',
        progress_sync_on: 'Progress sync on',
        progress_sync_off: 'Progress sync off',
        hq_mode_on: 'HQ tab mode on',
        hq_mode_off: 'HQ tab mode off',
        hq_paused_parked: 'HQ paused: popup parked',
        play_mode_updated: 'Play mode updated',
        no_next_video: 'No next video available',
        auto_mode_prefix: 'Auto',
        skip_mode_prefix: 'Skip',
        current_deleted_switched: 'Current video deleted, switched to next',
        video_delete: 'Delete',
        delete_video_title: 'Delete this video from playlist',
        only_host_admin_delete_video: 'Only host/admin can delete videos',
        now_playing: 'Now Playing',
        no_videos_shared: 'No videos shared yet',
        playback_paused: 'Paused',
        playback_playing: 'Playing',
        action_play: 'Play',
        action_pause: 'Pause',
        mode_set: 'Mode set: {mode}',
        connected_sync: 'sync',
        ready: 'Ready',
        select_video_first: 'Please select a video from Shared Videos first.',
        host_changed_to: 'Host changed to {name}',
        now_you_are_host: 'You are now host',
        admins_synced: 'Admins synced',
        play_mode_synced: 'Play mode synced',
        playlist_updated: 'Playlist updated',
    },
};

function normalizeLanguage(language) {
    const key = String(language || '').toLowerCase();
    return SUPPORTED_LANGS[key] ? key : 'zh';
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
    return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

function applyLanguage(nextLanguage) {
    const normalized = normalizeLanguage(nextLanguage);
    if (normalized === state.settings.language) return;
    state.settings.language = normalized;
    saveSettings();
    if (windowInstance?.headerEl) {
        const selector = windowInstance.headerEl.querySelector('#bclt-language-select');
        if (selector) selector.value = normalized;
    }
    refreshLocalizedUi();
}

function refreshLocalizedUi() {
    const selector = windowInstance?.headerEl?.querySelector('#bclt-language-select');
    if (selector) selector.title = t('language_label');
    const minimizeBtn = windowInstance?.headerEl?.querySelector('#bclt-minimize-btn');
    if (minimizeBtn) {
        minimizeBtn.title = windowInstance?.isMinimized ? t('window_restore') : t('window_minimize');
    }

    const roomMode = windowInstance?.content?.querySelector('#bclt-room-list');
    const playerMode = windowInstance?.content?.querySelector('#bclt-player-container');
    if (roomMode) {
        showRoomListMode();
        return;
    }
    if (playerMode) {
        refreshPlayerLocalizedText();
    }
}

function refreshPlayerLocalizedText() {
    const content = windowInstance?.content;
    if (!content) return;
    const titleEl = windowInstance?.headerEl?.querySelector('.bclt-window-title');
    if (titleEl) titleEl.textContent = t('window_player_title');

    const leaveBtn = windowInstance?.headerEl?.querySelector('#bclt-toolbar-leave');
    if (leaveBtn) leaveBtn.textContent = t('leave');

    const syncLabel = content.querySelector('label[for="bclt-sync-progress"] span');
    if (syncLabel) syncLabel.textContent = t('player_sync_progress');

    const hqLabel = content.querySelector('label[for="bclt-hq-tab-mode"] span');
    if (hqLabel) hqLabel.textContent = t('player_hq_mode');

    const videoTitleEl = content.querySelector('.video-list-title');
    if (videoTitleEl) videoTitleEl.textContent = t('player_shared_videos');

    const addBtn = content.querySelector('#bclt-btn-add-video');
    if (addBtn) addBtn.textContent = t('player_add_btn');

    const addInput = content.querySelector('#bclt-add-video-input');
    if (addInput) addInput.placeholder = t('player_add_placeholder');

    const modeSlider = content.querySelector('#bclt-mode-slider');
    if (modeSlider) modeSlider.title = t('player_mode_title');
    content.querySelectorAll('.mode-slider-btn').forEach((btn) => {
        const mode = String(btn.getAttribute('data-mode') || 'list');
        if (mode === 'single') btn.title = t('mode_single_loop');
        else if (mode === 'shuffle') btn.title = t('mode_shuffle');
        else btn.title = t('mode_list_loop');
    });

    const manageBtn = content.querySelector('#bclt-btn-manage-permissions');
    if (manageBtn) manageBtn.textContent = t('player_manage_permissions');

    updateVideoList();
    updatePlaybackUi();
    refreshHostUiPrivileges();
}

const PLAYBACK_MODES = {
    list: { labelKey: 'mode_list_loop', icon: '🔁' },
    single: { labelKey: 'mode_single_loop', icon: '🔂' },
    shuffle: { labelKey: 'mode_shuffle', icon: '🔀' },
};

function normalizePlaybackMode(mode) {
    const key = String(mode || '').toLowerCase();
    return PLAYBACK_MODES[key] ? key : 'list';
}

function getPlaybackModeLabel(mode = state.settings.playbackMode) {
    const normalized = normalizePlaybackMode(mode);
    return t(PLAYBACK_MODES[normalized].labelKey);
}

function normalizeAdminMemberIds(ids, hostMemberId = state.settings.roomHostMemberId || memberId()) {
    const hostId = String(hostMemberId || '').trim();
    const unique = new Set();
    (Array.isArray(ids) ? ids : []).forEach((id) => {
        const normalized = String(id || '').trim();
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
    if (state.settings.isHost) return t('role_host');
    if (isCurrentMemberAdmin()) return t('role_admin');
    return t('role_member');
}

function isSyncControlLocked() {
    return !state.settings.isHost && state.settings.syncPlaybackProgress !== false;
}

function isHighQualityTabModeEnabled() {
    return state.settings.highQualityTabMode === true;
}

function closeHighQualityPlaybackTab(options = {}) {
    const { destroySession = false, blankUrl = 'about:blank' } = options;
    if (!highQualityPlaybackTab) return;

    try {
        if (highQualityPlaybackTab.closed) {
            highQualityPlaybackTab = null;
            return;
        }

        if (destroySession) {
            if (typeof highQualityPlaybackTab.close === 'function') {
                highQualityPlaybackTab.close();
            }
            highQualityPlaybackTab = null;
            return;
        }

        // Non-session-destroy close: park popup on blank page to reduce repeated popout interruptions.
        if (highQualityPlaybackTab.location) {
            highQualityPlaybackTab.location.href = blankUrl;
        }
        try {
            window.focus();
        } catch (focusError) {
            console.warn('[BCLT] focus main window after parking popup failed:', focusError.message);
        }
    } catch (error) {
        console.warn('[BCLT] close high-quality playback tab failed:', error);
        highQualityPlaybackTab = null;
    }
}

function readBilibiliPageFromUrl(sourceUrl) {
    try {
        const parsed = new URL(String(sourceUrl || '').trim());
        const page = Number(parsed.searchParams.get('p') || 1);
        return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    } catch (error) {
        return 1;
    }
}

function normalizeBilibiliSourceForSync(sourceUrl) {
    const source = String(sourceUrl || '').trim();
    if (!source) return '';

    const bvid = parseBilibiliBvid(source);
    if (bvid) {
        return `bvid:${String(bvid)}:p${readBilibiliPageFromUrl(source)}`;
    }

    try {
        const url = new URL(source);
        url.searchParams.delete('t');
        url.searchParams.delete('autoplay');
        url.hash = '';
        return url.toString();
    } catch (error) {
        return source;
    }
}

function buildBilibiliWatchUrl(sourceUrl, currentTime = 0, { autoplay = true } = {}) {
    const source = String(sourceUrl || '').trim();
    if (!source) return null;

    const bvid = parseBilibiliBvid(source);
    const baseUrl = bvid ? `https://www.bilibili.com/video/${bvid}` : source;

    try {
        const url = new URL(baseUrl);
        const page = readBilibiliPageFromUrl(source);
        if (page > 1) {
            url.searchParams.set('p', String(page));
        }

        const seconds = Math.max(1, Math.floor(Number(currentTime) || 0));
        url.searchParams.set('t', String(seconds));

        if (autoplay) {
            url.searchParams.set('autoplay', '1');
        }

        return url.toString();
    } catch (error) {
        return null;
    }
}

function updateOrOpenHighQualityPlaybackTab(sourceUrl, currentTime, { autoplay = true } = {}) {
    console.log('[BCLT] updateOrOpenHighQualityPlaybackTab called', { sourceUrl, currentTime, autoplay, hasWindow: !!highQualityPlaybackTab });

    const watchUrl = buildBilibiliWatchUrl(sourceUrl, currentTime, { autoplay });
    if (!watchUrl) {
        const msg = t('failed_build_watch_url');
        console.warn('[BCLT]', msg);
        return { ok: false, message: msg };
    }

    console.log('[BCLT] Watch URL built:', watchUrl);

    // Check if popup already exists and is accessible
    try {
        if (highQualityPlaybackTab && !highQualityPlaybackTab.closed) {
            console.log('[BCLT] Popup window exists, updating location to new time...');
            highQualityPlaybackTab.location.href = watchUrl;
            console.log('[BCLT] Popup navigated to:', watchUrl);
            return { ok: true, watchUrl, action: 'updated' };
        }
    } catch (error) {
        console.warn('[BCLT] Failed to update existing popup location, will open new window:', error.message);
        highQualityPlaybackTab = null;
    }

    // Popup doesn't exist or couldn't be updated, open new one
    console.log('[BCLT] Opening new popup window...');
    let openedTab = null;
    try {
        openedTab = window.open(
            watchUrl,
            'bilibili_player_' + Date.now(),
            'width=1280,height=720,left=100,top=100,resizable=yes,scrollbars=yes'
        );
        console.log('[BCLT] window.open returned:', openedTab, 'type:', typeof openedTab);

        if (openedTab === null) {
            console.warn('[BCLT] window.open returned null (browser may have blocked popup)');
            return { ok: false, message: t('popup_blocked') };
        }

        highQualityPlaybackTab = openedTab;
        console.log('[BCLT] Window handle stored.');

        // Auto-minimize: keep focus on main BC window so popup stays in background
        try {
            window.focus();
            console.log('[BCLT] Focus returned to main window.');
        } catch (error) {
            console.warn('[BCLT] Failed to set focus back to main window:', error.message);
        }
    } catch (error) {
        console.error('[BCLT] window.open failed:', error.message);
        return { ok: false, message: `Failed to open window: ${error.message}` };
    }

    console.log('[BCLT] updateOrOpenHighQualityPlaybackTab completed for URL:', watchUrl);
    return { ok: true, watchUrl, action: 'opened' };
}

function openHighQualityPlaybackTab(sourceUrl, currentTime, { autoplay = true } = {}) {
    console.log('[BCLT] openHighQualityPlaybackTab called (legacy), redirecting to updateOrOpenHighQualityPlaybackTab');
    return updateOrOpenHighQualityPlaybackTab(sourceUrl, currentTime, { autoplay });
}

function renderHighQualityPlaceholder() {
    const playerContainer = windowInstance?.content?.querySelector('#bclt-player-container');
    if (!playerContainer) return;
    playerContainer.innerHTML = `<div class="empty-state">${t('hq_placeholder')}</div>`;
}

function extractCurrentBvid() {
    const currentSource = String(computeBilibiliSyntheticState().sourceUrl || state.bilibili.sourceUrl || '');
    const currentBvidMatch = currentSource.match(/(BV[0-9A-Za-z]{10,})/i);
    return currentBvidMatch ? currentBvidMatch[1].toUpperCase() : '';
}

function getCurrentPlayingVideoIndex() {
    const currentBvid = extractCurrentBvid();
    if (!currentBvid) return -1;
    // When duplicate BVIDs exist, prefer the latest one so only one row is marked as now playing.
    for (let index = activeVideos.length - 1; index >= 0; index -= 1) {
        if (String(activeVideos[index]?.bvid || '').toUpperCase() === currentBvid) {
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
    const listEl = windowInstance?.content?.querySelector('#bclt-video-list');
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

    if (normalizedMode === 'single') {
        return activeVideos[safeIndex] || activeVideos[0];
    }

    if (normalizedMode === 'shuffle') {
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
    const normalized = normalizePlaybackMode(state.settings.playbackMode);
    const modeSlider = windowInstance?.content?.querySelector('#bclt-mode-slider');
    if (modeSlider) modeSlider.setAttribute('data-mode', normalized);
    windowInstance?.content?.querySelectorAll('.mode-slider-btn').forEach((btn) => {
        const active = btn.getAttribute('data-mode') === normalized;
        btn.classList.toggle('is-active', active);
    });
}

function refreshHostUiPrivileges() {
    const hostOnly = !!state.settings.isHost;
    const canEditPlaylist = canManagePlaylist();
    const permissionBtn = windowInstance?.content?.querySelector('#bclt-btn-manage-permissions');
    const modeButtons = windowInstance?.content?.querySelectorAll('.mode-slider-btn') || [];
    const addVideoBtn = windowInstance?.content?.querySelector('#bclt-btn-add-video');
    const addVideoInput = windowInstance?.content?.querySelector('#bclt-add-video-input');
    const skipBtn = windowInstance?.content?.querySelector('#bclt-btn-skip-next');

    modeButtons.forEach((btn) => {
        btn.disabled = !hostOnly;
        btn.title = hostOnly ? '' : t('host_only_change_mode');
    });

    if (permissionBtn) {
        permissionBtn.disabled = !hostOnly;
        permissionBtn.style.opacity = hostOnly ? '1' : '0.6';
        permissionBtn.title = hostOnly ? '' : t('host_only_permission');
    }

    if (addVideoBtn) {
        addVideoBtn.disabled = !canEditPlaylist;
        addVideoBtn.style.opacity = canEditPlaylist ? '1' : '0.6';
        addVideoBtn.title = canEditPlaylist ? '' : t('host_admin_add_video');
    }

    if (addVideoInput) {
        addVideoInput.disabled = !canEditPlaylist;
        addVideoInput.title = canEditPlaylist ? '' : t('host_admin_add_video');
    }

    if (skipBtn) {
        skipBtn.disabled = !hostOnly;
        skipBtn.title = hostOnly ? t('skip_to_next') : t('host_only_skip');
    }

    updateSyncControlLockUi();
}

function updateSyncControlLockUi() {
    const locked = isSyncControlLocked();
    const playerPanel = windowInstance?.content?.querySelector('.player-panel');
    const videoListPanel = windowInstance?.content?.querySelector('.video-list');
    const toggleBtn = windowInstance?.content?.querySelector('#bclt-btn-toggle-play');
    const progressRange = windowInstance?.content?.querySelector('#bclt-progress-range');

    if (playerPanel) playerPanel.classList.toggle('sync-locked', locked);
    if (videoListPanel) videoListPanel.classList.toggle('sync-locked', locked);
    if (toggleBtn) toggleBtn.disabled = locked;
    if (progressRange) progressRange.disabled = locked;
}

async function setPlaybackMode(nextMode, options = {}) {
    const {
        save = true,
        publishMode = false,
        statusHint = '',
    } = options;

    const normalized = normalizePlaybackMode(nextMode);
    const prev = normalizePlaybackMode(state.settings.playbackMode);
    state.settings.playbackMode = normalized;
    if (save && prev !== normalized) saveSettings();
    updatePlaybackModeUi();

    if (publishMode && state.settings.isHost) {
        await publish('room_control', {
            action: 'playback_mode_changed',
            playbackMode: normalized,
            at: Date.now(),
        });
        if (state.settings.syncPlaybackProgress !== false) {
            await publish('media_state', computeBilibiliSyntheticState());
        }
    }

    if (statusHint) {
        updatePlaybackUi(statusHint);
    } else if (prev !== normalized) {
        updatePlaybackUi(t('mode_set', { mode: getPlaybackModeLabel(normalized) }));
    }
}

async function maybeAutoAdvanceFromSnapshot(snapshot) {
    if (!state.settings.isHost || autoAdvanceInFlight) return;
    if (!snapshot || snapshot.paused || !snapshot.sourceUrl) {
        autoAdvanceTriggerToken = '';
        return;
    }

    const duration = Number(snapshot.duration);
    const currentTime = Number(snapshot.currentTime || 0);
    if (!Number.isFinite(duration) || duration <= 0) return;

    const remaining = duration - currentTime;
    if (remaining > 0.8) {
        autoAdvanceTriggerToken = '';
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
        await playVideo(nextVideo.bvid, {
            publish: true,
            reason: 'playlist-auto-advance',
            statusHint: `${t('auto_mode_prefix')}: ${getPlaybackModeLabel(state.settings.playbackMode)}`,
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
    windowInstance.container.style.width = windowInstance.width + 'px';
    windowInstance.container.style.height = windowInstance.height + 'px';
    windowInstance.clampPosition();
}

function normalizeActiveVideo(rawVideo) {
    if (!rawVideo || !rawVideo.bvid) return null;

    const bvid = String(rawVideo.bvid).trim();
    if (!/^BV[0-9A-Za-z]{10,}$/i.test(bvid)) return null;

    const sender = String(rawVideo.senderName || rawVideo.sender || 'Unknown').trim() || 'Unknown';
    const title = sanitizeBilibiliText(rawVideo.title || rawVideo.videoTitle || bvid);
    const shareId = rawVideo.shareId ? String(rawVideo.shareId) : '';
    const timestamp = Number.isFinite(Number(rawVideo.timestamp)) ? Number(rawVideo.timestamp) : Date.now();
    const url = String(rawVideo.url || `https://www.bilibili.com/video/${bvid}`).trim();

    return {
        shareId,
        sender,
        title,
        bvid,
        url,
        timestamp,
    };
}

function sanitizeBilibiliText(input) {
    const raw = String(input || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ');
    const helper = document.createElement('textarea');
    helper.innerHTML = raw;
    return helper.value.replace(/\s+/g, ' ').trim();
}

function extractBilibiliApiError(payload, fallback = 'Bilibili API request failed') {
    if (!payload || typeof payload !== 'object') return fallback;
    const code = Number(payload.code);
    const message = String(payload.message || payload.msg || fallback).trim() || fallback;
    if (code === -352 || /security control policy|安全风控/i.test(message)) {
        return 'Bilibili rejected the request due to security control policy';
    }
    if (Number.isFinite(code) && code !== 0) {
        return `${message} (code: ${code})`;
    }
    return message;
}

function ensureBilibiliApiOk(payload, fallback) {
    if (!payload || typeof payload !== 'object') {
        throw new Error(fallback || 'Invalid Bilibili API payload');
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
        const response = await fetch(endpoint, { method: 'GET', mode: 'cors', credentials: 'omit' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    }
}

function callBilibiliJsonp(url, timeoutMs = 9000) {
    return new Promise((resolve, reject) => {
        const callbackName = `__bclt_jsonp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const script = document.createElement('script');
        let timeoutId = 0;

        const cleanup = () => {
            if (timeoutId) clearTimeout(timeoutId);
            if (script.parentElement) script.parentElement.removeChild(script);
            try {
                delete window[callbackName];
            } catch (error) {
                window[callbackName] = undefined;
            }
        };

        window[callbackName] = (payload) => {
            cleanup();
            resolve(payload);
        };

        script.onerror = () => {
            cleanup();
            reject(new Error('JSONP request failed'));
        };

        timeoutId = window.setTimeout(() => {
            cleanup();
            reject(new Error('JSONP request timed out'));
        }, timeoutMs);

        const joiner = url.includes('?') ? '&' : '?';
        script.src = `${url}${joiner}jsonp=jsonp&callback=${encodeURIComponent(callbackName)}`;
        document.head.appendChild(script);
    });
}

async function fetchBilibiliVideoTitleByBvid(bvid) {
    const normalizedBvid = String(bvid || '').trim();
    if (!/^BV[0-9A-Za-z]{10,}$/i.test(normalizedBvid)) return normalizedBvid;

    const key = normalizedBvid.toUpperCase();
    if (bilibiliVideoTitleTaskByBvid.has(key)) {
        return bilibiliVideoTitleTaskByBvid.get(key);
    }

    const task = (async () => {
        const endpoint = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(normalizedBvid)}`;
        const parseTitle = (payload) => {
            ensureBilibiliApiOk(payload, 'Bilibili view API failed');
            return sanitizeBilibiliText(payload?.data?.title || normalizedBvid) || normalizedBvid;
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
    const currentTitle = String(video.title || '').trim();
    if (currentTitle && currentTitle !== video.bvid) return;

    try {
        const title = await fetchBilibiliVideoTitleByBvid(video.bvid);
        if (!title || title === video.title) return;
        video.title = title;
        updateVideoList();
    } catch (error) {
        console.warn('[BCLT] enrich video title failed:', error);
    }
}

function choosePreferredVideo(nextVideo, prevVideo) {
    if (!prevVideo) return nextVideo;

    const nextTime = Number(nextVideo.timestamp || 0);
    const prevTime = Number(prevVideo.timestamp || 0);
    const preferNext = nextTime >= prevTime;

    return {
        ...(preferNext ? prevVideo : nextVideo),
        ...(preferNext ? nextVideo : prevVideo),
        bvid: String(nextVideo.bvid || prevVideo.bvid || '').trim(),
        // Keep a shareId when either side has one so remove actions remain addressable.
        shareId: String(nextVideo.shareId || prevVideo.shareId || ''),
        timestamp: Math.max(nextTime, prevTime, Date.now()),
    };
}

function mergeActiveVideos(videos) {
    const byBvid = new Map();
    const queue = [
        ...(Array.isArray(videos) ? videos : []),
        ...activeVideos,
    ];

    queue.forEach((video) => {
        const normalized = normalizeActiveVideo(video);
        if (!normalized) return;

        const bvidKey = String(normalized.bvid || '').toUpperCase();
        const prev = byBvid.get(bvidKey);
        byBvid.set(bvidKey, choosePreferredVideo(normalized, prev));
    });

    activeVideos = Array.from(byBvid.values())
        .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
}

function buildPlaylistStatePayload(targetMemberId = '') {
    const syncEnabled = state.settings.syncPlaybackProgress !== false;
    return {
        targetMemberId: targetMemberId || '',
        videos: activeVideos.map((video) => ({ ...video })),
        playbackMode: normalizePlaybackMode(state.settings.playbackMode),
        adminMemberIds: [...state.roomAdminMemberIds],
        mediaState: syncEnabled ? computeBilibiliSyntheticState() : null,
        syncProgress: syncEnabled,
        generatedAt: Date.now(),
    };
}

function clampMainButtonPosition() {
    if (!buttonElement) return;
    const viewportPadding = 16;
    const rect = buttonElement.getBoundingClientRect();
    const width = rect.width || 58;
    const height = rect.height || 58;
    const left = Number.parseFloat(buttonElement.style.left || '0') || viewportPadding;
    const top = Number.parseFloat(buttonElement.style.top || '0') || viewportPadding;
    const clampedLeft = Math.min(Math.max(left, viewportPadding), Math.max(viewportPadding, window.innerWidth - width - viewportPadding));
    const clampedTop = Math.min(Math.max(top, viewportPadding), Math.max(viewportPadding, window.innerHeight - height - viewportPadding));
    buttonElement.style.left = `${clampedLeft}px`;
    buttonElement.style.top = `${clampedTop}px`;
}

function setMainButtonSpinning(spinning) {
    if (!buttonElement) return;
    buttonElement.classList.toggle('is-minimized-spinning', !!spinning);
}

function setupMainButtonDrag() {
    if (!buttonElement) return;

    const pointerDown = (event) => {
        if (event.button !== 0) return;

        const left = Number.parseFloat(buttonElement.style.left || '0') || 0;
        const top = Number.parseFloat(buttonElement.style.top || '0') || 0;
        mainButtonDragState.dragging = true;
        mainButtonDragState.moved = false;
        mainButtonDragState.startX = event.clientX;
        mainButtonDragState.startY = event.clientY;
        mainButtonDragState.startLeft = left;
        mainButtonDragState.startTop = top;
        isDraggingMainButton = true;
        buttonElement.classList.add('dragging');
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
        buttonElement?.classList.remove('dragging');
        if (mainButtonDragState.moved) {
            suppressNextMainButtonClick = true;
        }
        isDraggingMainButton = false;
    };

    buttonElement.addEventListener('mousedown', pointerDown);
    document.addEventListener('mousemove', pointerMove);
    document.addEventListener('mouseup', pointerUp);
    window.addEventListener('resize', clampMainButtonPosition);
}

export function createUI() {
    if (document.getElementById(APP_ID)) return;

    // Create global style
    const style = document.createElement('style');
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
            align-items: center;
            gap: 8px;
            padding: 11px 12px;
            border-bottom: 1px solid var(--bclt-border-soft);
        }

        #bclt-window .video-list-header-row {
            width: 100%;
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
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

        #bclt-window .player-panel.sync-locked .player-progress,
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

    // Create button to open window
    buttonElement = document.createElement('button');
    buttonElement.id = 'bclt-button';
    buttonElement.textContent = '♫';
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

    logStatus(t('ready'));
}

function showRoomListMode() {
    const roomTitle = t('window_rooms_title');
    if (!windowInstance) {
        windowInstance = new DraggableWindow({
            title: roomTitle,
            width: 460,
            height: 620,
            onMinimizeChanged: setMainButtonSpinning,
        });
        windowInstance.create();
    }
    windowInstance.setTitle(roomTitle);
    windowInstance.container?.classList.remove('bclt-player-mode');

    const toolbarLeaveBtn = windowInstance.headerEl?.querySelector('#bclt-toolbar-leave');
    if (toolbarLeaveBtn) toolbarLeaveBtn.remove();
    const toolbarRoomName = windowInstance.headerEl?.querySelector('#bclt-toolbar-room-name');
    if (toolbarRoomName) toolbarRoomName.remove();

    closeHighQualityPlaybackTab({ destroySession: true });

    resizeWindowForMode(460, 620);

    windowInstance.setContent(`
        <div class="room-mode-layout">
            <div class="panel-card panel-card-rooms">
                <div class="panel-title-row">
                    <strong>${t('room_available_rooms')}</strong>
                    <button id="bclt-refresh-rooms" class="btn-primary btn-small">${t('room_refresh')}</button>
                </div>
                <div id="bclt-room-list" class="room-list-grid"></div>
                <div id="bclt-window-status" class="status-text room-list-footer-status"></div>
            </div>
            <div class="panel-card panel-card-form">
                <div class="panel-title-row">
                    <strong>${t('room_create_room')}</strong>
                    <span class="panel-pill">${t('room_host_badge')}</span>
                </div>
                <div class="panel-card-body settings-form">
                    <div class="form-group">
                        <label>${t('room_name_label')}</label>
                        <input id="bclt-room-id" type="text" placeholder="${t('room_name_placeholder')}" />
                    </div>
                    <div class="form-group">
                        <label>${t('room_passcode_label')}</label>
                        <input id="bclt-room-passcode" type="password" placeholder="${t('room_passcode_placeholder')}" />
                    </div>
                </div>
                <button id="bclt-create-room" class="btn-primary">${t('room_create_btn')}</button>
            </div>
        </div>
    `);

    // Load saved settings
    const fields = {
        roomPasscode: windowInstance.content.querySelector('#bclt-room-passcode'),
        roomId: windowInstance.content.querySelector('#bclt-room-id'),
    };

    fields.roomPasscode.value = state.settings.roomPasscode;
    fields.roomId.value = state.settings.roomId;

    // Save on change
    const saveSettings_local = () => {
        state.settings.roomPasscode = fields.roomPasscode.value.trim();
        state.settings.roomId = fields.roomId.value.trim();
        saveSettings();
    };

    Object.values(fields).forEach((el) => {
        el.addEventListener('change', saveSettings_local);
        el.addEventListener('blur', saveSettings_local);
    });

    // Refresh rooms button
    windowInstance.content.querySelector('#bclt-refresh-rooms').addEventListener('click', async () => {
        await loadAndDisplayRooms();
    });

    // Create room button
    windowInstance.content.querySelector('#bclt-create-room').addEventListener('click', () => {
        createRoomAndJoin(fields.roomId.value);
    });

    // Load rooms on init
    loadAndDisplayRooms();
    windowInstance.show();
}

function promptForPasscodeAndJoin(room) {
    if (room && room.isLocked) {
        const passcode = prompt(t('passcode_prompt', { roomName: room.roomName || room.name || room.id }));
        if (passcode === null) return;

        const trimmedPasscode = passcode.trim();
        if (!trimmedPasscode) {
            alert(t('passcode_required'));
            return;
        }
        state.settings.roomPasscode = trimmedPasscode;
    } else {
        state.settings.roomPasscode = '';
    }

    state.settings.isHost = false;
    state.settings.roomHostMemberId = room && room.hostMemberId ? String(room.hostMemberId) : '';
    setRoomAdminMemberIds([]);
    state.settings.roomName = room && (room.roomName || room.name || room.id) ? (room.roomName || room.name || room.id) : state.settings.roomId;
    state.currentRoomHostName = room && room.host ? String(room.host) : '';
    saveSettings();
    showPlayerMode();
}

function formatRoomToolbarLabel() {
    const roomName = state.settings.roomName || state.settings.roomId || t('unknown_room');
    const hostName = String(state.currentRoomHostName || '').trim();
    return hostName ? `${roomName} | ${t('toolbar_host')}: ${hostName}` : roomName;
}

async function createRoomAndJoin(inputRoomName) {
    try {
        const roomName = String(inputRoomName || '').trim();
        if (!roomName) {
            alert(t('alert_enter_room_name'));
            return;
        }

        state.settings.roomPasscode = String(state.settings.roomPasscode || '').trim();
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
        alert(t('create_room_failed', { message: error.message }));
        console.error('[BCLT] create room failed:', error);
    }
}

async function loadAndDisplayRooms() {
    const roomList = windowInstance.content.querySelector('#bclt-room-list');
    const statusEl = windowInstance.content.querySelector('#bclt-window-status');
    
    if (!roomList || !statusEl) return;

    roomList.innerHTML = `<div class="empty-state">${t('room_loading')}</div>`;
    statusEl.textContent = '';

    try {
        const rooms = await fetchAvailableRooms();

        roomList.innerHTML = '';
        if (rooms.length === 0) {
            roomList.innerHTML = `<div class="empty-state">${t('room_none')}</div>`;
        } else {
            rooms.forEach((room) => {
                const item = document.createElement('div');
                item.className = 'room-item';
                item.innerHTML = `
                    <div class="room-item-title-row">
                        <div class="room-item-title">${room.roomName || room.displayName || room.name || room.id}</div>
                        ${room.isLocked ? `<span class="room-lock-indicator" title="${t('room_locked')}">🔒</span>` : ''}
                    </div>
                    <div class="room-item-info">${t('room_host_prefix')}: ${room.host || t('unknown_room')}</div>
                    <div class="room-item-info">${t('room_online_count', { count: room.members })}</div>
                `;
                item.onclick = () => {
                    state.settings.roomId = room.id;
                    saveSettings();
                    promptForPasscodeAndJoin(room);
                };
                roomList.appendChild(item);
            });
        }

        statusEl.textContent = t('room_loaded_count', { count: rooms.length });
    } catch (error) {
        roomList.innerHTML = `<div class="empty-state" style="color: #fca5a5;">${t('room_load_error')}</div>`;
        statusEl.textContent = `Error: ${error.message}`;
        console.error('[BCLT] Error loading rooms:', error);
    }
}

async function openPermissionManagementModal() {
    if (!windowInstance?.container || !state.settings.isHost) {
        alert(t('only_host_manage_permissions'));
        return;
    }

    const existing = windowInstance.container.querySelector('.permission-modal-backdrop');
    if (existing) existing.remove();

    const members = await fetchRoomMembers({ includeStale: false, excludeSelf: false });
    if (!members.length) {
        alert(t('no_active_members'));
        return;
    }

    const hostMemberId = String(state.settings.roomHostMemberId || memberId());
    let selectedHostId = hostMemberId;
    const selectedAdminIds = new Set(state.roomAdminMemberIds);

    const backdrop = document.createElement('div');
    backdrop.className = 'permission-modal-backdrop';
    backdrop.innerHTML = `
        <div class="permission-modal" role="dialog" aria-modal="true" aria-label="${t('player_manage_permissions')}">
            <div class="permission-modal-head">
                <div>
                    <strong>${t('player_manage_permissions')}</strong>
                    <div class="permission-modal-sub">${t('permission_modal_sub')}</div>
                </div>
                <button type="button" class="btn-neutral btn-small" id="bclt-permission-close">${t('permission_close')}</button>
            </div>
            <div class="permission-user-list" id="bclt-permission-user-list"></div>
            <div class="permission-note">${t('permission_note')}</div>
            <div class="permission-modal-foot">
                <button type="button" class="btn-neutral" id="bclt-permission-cancel">${t('permission_cancel')}</button>
                <button type="button" class="btn-accent" id="bclt-permission-save">${t('permission_save')}</button>
            </div>
        </div>
    `;

    const listEl = backdrop.querySelector('#bclt-permission-user-list');
    const renderRows = () => {
        listEl.innerHTML = '';

        members.forEach((member) => {
            const row = document.createElement('label');
            row.className = 'permission-user-row';
            row.innerHTML = `
                <div>
                    <div class="permission-user-name">${member.displayName}</div>
                    <span class="permission-user-id">ID: ${member.memberId}</span>
                </div>
                <span class="permission-col">
                    <input type="radio" name="bclt-perm-host" value="${member.memberId}" ${selectedHostId === member.memberId ? 'checked' : ''} />
                    ${t('role_host')}
                </span>
                <span class="permission-col">
                    <input type="checkbox" name="bclt-perm-admin" value="${member.memberId}" ${selectedAdminIds.has(member.memberId) && selectedHostId !== member.memberId ? 'checked' : ''} ${selectedHostId === member.memberId ? 'disabled' : ''} />
                    ${t('role_admin')}
                </span>
            `;
            listEl.appendChild(row);
        });

        listEl.querySelectorAll('input[name="bclt-perm-host"]').forEach((radio) => {
            radio.addEventListener('change', () => {
                selectedHostId = String(radio.value || '').trim();
                if (selectedHostId) selectedAdminIds.delete(selectedHostId);
                renderRows();
            });
        });

        listEl.querySelectorAll('input[name="bclt-perm-admin"]').forEach((checkbox) => {
            checkbox.addEventListener('change', () => {
                const id = String(checkbox.value || '').trim();
                if (!id || id === selectedHostId) return;
                if (checkbox.checked) selectedAdminIds.add(id);
                else selectedAdminIds.delete(id);
            });
        });
    };

    renderRows();
    windowInstance.container.appendChild(backdrop);

    const closeModal = () => backdrop.remove();
    backdrop.querySelector('#bclt-permission-close').onclick = closeModal;
    backdrop.querySelector('#bclt-permission-cancel').onclick = closeModal;
    backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) closeModal();
    });

    backdrop.querySelector('#bclt-permission-save').onclick = async () => {
        try {
            const nextHostId = String(selectedHostId || '').trim();
            if (!nextHostId) {
                alert(t('select_one_host'));
                return;
            }

            const nextAdminIds = Array.from(selectedAdminIds)
                .map((id) => String(id || '').trim())
                .filter((id) => !!id && id !== nextHostId);

            const hostChanged = nextHostId !== String(state.settings.roomHostMemberId || memberId());

            if (hostChanged) {
                const nextHostMember = members.find((m) => m.memberId === nextHostId);
                await transferRoomOwnership(nextHostId, { adminMemberIds: nextAdminIds });
                if (nextHostMember) {
                    state.currentRoomHostName = nextHostMember.displayName;
                }
                saveSettings();
                updatePlaybackUi(t('ownership_transferred_to', {
                    name: nextHostMember ? nextHostMember.displayName : nextHostId,
                }));
                logStatus(t('permissions_updated_transferred'));
            } else {
                setRoomAdminMemberIds(nextAdminIds, nextHostId);
                await publish('room_control', {
                    action: 'admin_members_updated',
                    adminMemberIds: [...state.roomAdminMemberIds],
                    at: Date.now(),
                });
                updatePlaybackUi(t('admin_permissions_updated'));
                logStatus(t('admin_permissions_updated'));
            }

            const roomNameEl = windowInstance?.headerEl?.querySelector('#bclt-toolbar-room-name');
            if (roomNameEl) {
                roomNameEl.textContent = formatRoomToolbarLabel();
            }

            refreshHostUiPrivileges();
            updateVideoList();
            closeModal();
        } catch (error) {
            alert(`Save permission changes failed: ${error.message}`);
            console.error('[BCLT] save permission changes failed:', error);
        }
    };
}

function showPlayerMode() {
    const playerTitle = t('window_player_title');
    removeBilibiliEmbed();
    stopPlaybackUiTicker();
    playbackSeekMaxSeconds = 3600;
    autoAdvanceTriggerToken = '';
    autoAdvanceInFlight = false;
    nowPlayingHighlightToken = '';

    const normalizedMode = normalizePlaybackMode(state.settings.playbackMode);
    if (normalizedMode !== state.settings.playbackMode) {
        state.settings.playbackMode = normalizedMode;
        saveSettings();
    }

    if (!windowInstance) {
        windowInstance = new DraggableWindow({
            title: playerTitle,
            width: 1000,
            height: 680,
            onMinimizeChanged: setMainButtonSpinning,
        });
        windowInstance.create();
    }
    windowInstance.setTitle(playerTitle);
    windowInstance.container?.classList.add('bclt-player-mode');
    resizeWindowForMode(1000, 680);

    windowInstance.setContent(`
        <div class="player-container">
            <div class="player-panel">
                <div id="bclt-player-container" class="video-stage">
                    <div class="empty-state">${t('player_no_video_playing')}</div>
                </div>
                <div class="player-room-tools">
                    <label class="sync-progress-toggle" for="bclt-sync-progress">
                        <input id="bclt-sync-progress" type="checkbox" />
                        <span>${t('player_sync_progress')}</span>
                    </label>
                    <label class="sync-progress-toggle" for="bclt-hq-tab-mode">
                        <input id="bclt-hq-tab-mode" type="checkbox" />
                        <span>${t('player_hq_mode')}</span>
                    </label>
                </div>
                <div class="player-progress">
                    <div class="player-progress-track">
                        <button id="bclt-btn-toggle-play" class="media-toggle-btn" type="button" title="Play">▶</button>
                        <button id="bclt-btn-skip-next" class="skip-track-btn" type="button" title="${t('skip_to_next')}">⏭</button>
                        <input id="bclt-progress-range" type="range" min="0" max="3600" step="1" value="0" />
                    </div>
                    <div class="player-progress-meta">
                        <span id="bclt-progress-current">0:00</span>
                        <span id="bclt-progress-max">60:00</span>
                        <span id="bclt-sync-indicator" class="sync-indicator" title="Sync status"></span>
                    </div>
                </div>
                <div id="bclt-player-status" class="status-text status-emphasis">${t('player_status_ready')}</div>
            </div>
            <div class="video-list">
                <div class="video-list-header">
                    <div class="video-list-title">${t('player_shared_videos')}</div>
                    <div class="video-list-header-row">
                        <input id="bclt-add-video-input" class="add-video-input" type="text" placeholder="${t('player_add_placeholder')}" />
                        <button id="bclt-btn-add-video" class="btn-accent btn-small" type="button">${t('player_add_btn')}</button>
                        <div id="bclt-mode-slider" class="mode-slider" data-mode="list" title="${t('player_mode_title')}">
                            <button class="mode-slider-btn" data-mode="list" type="button" title="${t('mode_list_loop')}">🔁</button>
                            <button class="mode-slider-btn" data-mode="single" type="button" title="${t('mode_single_loop')}">🔂</button>
                            <button class="mode-slider-btn" data-mode="shuffle" type="button" title="${t('mode_shuffle')}">🔀</button>
                        </div>
                    </div>
                </div>
                <div class="video-list-content" id="bclt-video-list"></div>
                <div class="video-list-footer">
                    <button id="bclt-btn-manage-permissions" class="permission-entry-btn">${t('player_manage_permissions')}</button>
                </div>
            </div>
        </div>
    `);

    const toolbarLeaveBtnId = 'bclt-toolbar-leave';
    const toolbarRoomNameId = 'bclt-toolbar-room-name';
    const closeBtn = windowInstance.headerEl?.querySelector('.bclt-close-btn');
    const actionsEl = closeBtn?.parentElement;
    if (closeBtn && actionsEl && actionsEl.parentElement === windowInstance.headerEl) {
        let roomNameEl = windowInstance.headerEl.querySelector(`#${toolbarRoomNameId}`);
        if (!roomNameEl) {
            roomNameEl = document.createElement('span');
            roomNameEl.id = toolbarRoomNameId;
            roomNameEl.className = 'toolbar-room-name';
            windowInstance.headerEl.insertBefore(roomNameEl, actionsEl);
        }
        roomNameEl.textContent = formatRoomToolbarLabel();

        let leaveBtn = actionsEl.querySelector(`#${toolbarLeaveBtnId}`);
        if (!leaveBtn) {
            leaveBtn = document.createElement('button');
            leaveBtn.id = toolbarLeaveBtnId;
            leaveBtn.type = 'button';
            leaveBtn.className = 'toolbar-leave-btn';
            leaveBtn.textContent = t('leave');
            actionsEl.insertBefore(leaveBtn, closeBtn);
        }
    }

    // Setup player mode
    const playerContainer = windowInstance.content.querySelector('#bclt-player-container');
    const videoList = windowInstance.content.querySelector('#bclt-video-list');
    const statusEl = windowInstance.content.querySelector('#bclt-player-status');
    const syncProgressCheckbox = windowInstance.content.querySelector('#bclt-sync-progress');
    const highQualityModeCheckbox = windowInstance.content.querySelector('#bclt-hq-tab-mode');
    const addVideoInput = windowInstance.content.querySelector('#bclt-add-video-input');
    const addVideoBtn = windowInstance.content.querySelector('#bclt-btn-add-video');
    const managePermissionsBtn = windowInstance.content.querySelector('#bclt-btn-manage-permissions');
    const modeButtons = windowInstance.content.querySelectorAll('.mode-slider-btn');

    syncProgressCheckbox.checked = state.settings.syncPlaybackProgress !== false;
    highQualityModeCheckbox.checked = isHighQualityTabModeEnabled();
    updatePlaybackModeUi();

    refreshHostUiPrivileges();

    syncProgressCheckbox.addEventListener('change', () => {
        state.settings.syncPlaybackProgress = !!syncProgressCheckbox.checked;
        saveSettings();
        updateSyncControlLockUi();
        updateVideoList();
        updatePlaybackUi(state.settings.syncPlaybackProgress ? t('progress_sync_on') : t('progress_sync_off'));
    });

    highQualityModeCheckbox.addEventListener('change', async () => {
        state.settings.highQualityTabMode = !!highQualityModeCheckbox.checked;
        saveSettings();

        const snapshot = computeBilibiliSyntheticState();
        if (!snapshot.sourceUrl) {
            updatePlaybackUi(state.settings.highQualityTabMode ? t('hq_mode_on') : t('hq_mode_off'));
            return;
        }

        if (state.settings.highQualityTabMode) {
            await applyRoomPlaybackState(snapshot, {
                publishState: false,
                reason: 'hq-tab-mode-toggle-on',
                forceReload: true,
                syncProgress: state.settings.syncPlaybackProgress !== false,
                statusHint: t('hq_mode_on'),
            });
            return;
        }

        closeHighQualityPlaybackTab();
        await applyRoomPlaybackState(snapshot, {
            publishState: false,
            reason: 'hq-tab-mode-toggle-off',
            forceReload: true,
            syncProgress: state.settings.syncPlaybackProgress !== false,
            statusHint: t('hq_mode_off'),
        });
    });

    modeButtons.forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!state.settings.isHost) return;
            await setPlaybackMode(btn.getAttribute('data-mode') || 'list', {
                save: true,
                publishMode: true,
                statusHint: t('play_mode_updated'),
            });
        });
    });

    const submitInlineVideo = async () => {
        if (!canManagePlaylist()) {
            alert(t('only_host_admin_add_video'));
            return;
        }

        const value = String(addVideoInput?.value || '').trim();
        if (!value) {
            updatePlaybackUi(t('input_bv_hint'));
            return;
        }

        await addVideoToRoom(value);
        if (addVideoInput) {
            addVideoInput.value = '';
            addVideoInput.focus();
        }
    };

    // Add video button
    addVideoBtn.addEventListener('click', submitInlineVideo);
    addVideoInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            void submitInlineVideo();
        }
    });

    managePermissionsBtn.addEventListener('click', async () => {
        if (!state.settings.isHost) {
            alert(t('only_host_manage_permissions'));
            return;
        }

        await openPermissionManagementModal();
    });

    windowInstance.content.querySelector('#bclt-btn-toggle-play').addEventListener('click', async () => {
        if (isSyncControlLocked()) return;
        const synthetic = computeBilibiliSyntheticState();
        if (synthetic.paused) {
            await controlRoomPlayback('play');
        } else {
            await controlRoomPlayback('pause');
        }
    });

    windowInstance.content.querySelector('#bclt-btn-skip-next').addEventListener('click', async () => {
        if (!state.settings.isHost) return;

        const currentIndex = getCurrentPlayingVideoIndex();
        const nextVideo = pickNextVideoByMode(state.settings.playbackMode, currentIndex);
        if (!nextVideo || !nextVideo.bvid) {
            updatePlaybackUi(t('no_next_video'));
            return;
        }

        await playVideo(nextVideo.bvid, {
            publish: true,
            reason: 'host-skip-next',
            statusHint: `${t('skip_mode_prefix')}: ${getPlaybackModeLabel(state.settings.playbackMode)}`,
        });
    });

    windowInstance.content.querySelector('#bclt-progress-range').addEventListener('change', async (event) => {
        if (isSyncControlLocked()) return;
        const seconds = Number(event.target.value || 0);
        await controlRoomPlayback('seek', seconds);
    });

    const leaveToolbarBtn = windowInstance.headerEl?.querySelector('#bclt-toolbar-leave');
    const leaveFromToolbar = async () => {
        clearRoomCallbacks();
        stopPlaybackUiTicker();
        closeHighQualityPlaybackTab({ destroySession: true });
        activeVideos = [];
        setRoomAdminMemberIds([]);
        await leaveRoom();
        state.currentRoomHostName = '';
        showRoomListMode();
    };
    if (leaveToolbarBtn) {
        leaveToolbarBtn.onclick = leaveFromToolbar;
    }

    // Initialize room
    initializeRoomMode(playerContainer, videoList, statusEl);
    windowInstance.show();
}

async function addVideoToRoom(bilibiliBvId) {
    try {
        const sourceText = typeof bilibiliBvId === 'string' ? bilibiliBvId : String(bilibiliBvId?.url || bilibiliBvId?.bvid || '');
        const inputBvid = typeof bilibiliBvId === 'object' && bilibiliBvId?.bvid
            ? String(bilibiliBvId.bvid)
            : sourceText;

        // Parse the input to extract BV ID
        let bvid = inputBvid;
        if (sourceText.includes('bilibili.com') || sourceText.includes('b23.tv')) {
            const match = sourceText.match(/(BV[0-9A-Za-z]{10,})/i);
            if (!match) throw new Error('Cannot extract BV ID from URL');
            bvid = match[1];
        }

        // Validate BV ID format
        if (!/^BV[0-9A-Za-z]{10,}$/i.test(bvid)) {
            throw new Error('Invalid BV ID format');
        }

        const titleCandidate = typeof bilibiliBvId === 'object' && bilibiliBvId?.title
            ? sanitizeBilibiliText(bilibiliBvId.title)
            : '';
        const title = titleCandidate || await fetchBilibiliVideoTitleByBvid(bvid);
        const videoUrl = typeof bilibiliBvId === 'object' && bilibiliBvId?.url
            ? String(bilibiliBvId.url)
            : `https://www.bilibili.com/video/${bvid}`;

        // Add to active videos locally
        const senderName = effectiveDisplayName();
        const shareId = `${memberId()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        mergeActiveVideos([{
            shareId,
            sender: senderName,
            title,
            bvid: bvid,
            url: videoUrl,
            timestamp: Date.now(),
        }]);

        // Publish to room
        await publish('video_shared', {
            shareId,
            bvid: bvid,
            title,
            url: videoUrl,
            senderName: senderName,
        });

        updateVideoList();
        logStatus(`Added: ${title}`);
    } catch (error) {
        alert(`Error: ${error.message}`);
        console.error('[BCLT] Error adding video:', error);
    }
}

function removeVideoByReference(reference, options = {}) {
    const { publishRemoval = false } = options;

    const normalizedRef = normalizeActiveVideo(reference) || reference;
    const referenceShareId = normalizedRef && normalizedRef.shareId ? String(normalizedRef.shareId) : '';
    const referenceBvid = normalizedRef && normalizedRef.bvid ? String(normalizedRef.bvid).toUpperCase() : '';

    const removeIndex = activeVideos.findIndex((video) => {
        if (referenceShareId && String(video.shareId || '') === referenceShareId) return true;
        return referenceBvid && String(video.bvid || '').toUpperCase() === referenceBvid;
    });

    if (removeIndex < 0) return false;

    const [removed] = activeVideos.splice(removeIndex, 1);
    updateVideoList();

    if (publishRemoval && canManagePlaylist()) {
        void publish('room_control', {
            action: 'playlist_video_removed',
            shareId: removed.shareId || '',
            bvid: removed.bvid,
            sender: removed.sender,
            at: Date.now(),
        });
    }

    return true;
}

function updateVideoList() {
    const videoList = windowInstance?.content?.querySelector('#bclt-video-list');
    if (!videoList) return;

    videoList.innerHTML = '';
    const currentPlayingIndex = getCurrentPlayingVideoIndex();
    const filteredVideos = activeVideos;

    if (activeVideos.length === 0) {
        videoList.innerHTML = `<div class="empty-state">${t('no_videos_shared')}</div>`;
    } else if (!filteredVideos.length) {
        videoList.innerHTML = '<div class="empty-state">No matching videos</div>';
    } else {
        filteredVideos.forEach((video, index) => {
            const item = document.createElement('div');
            item.className = 'video-item';
            const isActive = currentPlayingIndex >= 0 && index === currentPlayingIndex;
            const syncLocked = isSyncControlLocked();
            if (isActive) item.classList.add('active');

            const main = document.createElement('div');
            main.className = 'video-item-main';
            const title = sanitizeBilibiliText(video.title || video.bvid) || video.bvid;

            const nameEl = document.createElement('div');
            nameEl.className = 'video-item-name';
            nameEl.title = title;
            nameEl.textContent = `${title}${isActive ? ` (${t('now_playing')})` : ''}`;
            main.appendChild(nameEl);

            const metaEl = document.createElement('div');
            metaEl.className = 'video-item-meta';
            metaEl.textContent = video.bvid;
            main.appendChild(metaEl);

            const senderEl = document.createElement('div');
            senderEl.className = 'video-item-user';
            senderEl.textContent = video.sender;
            main.appendChild(senderEl);
            main.classList.toggle('sync-locked', syncLocked);

            main.onclick = () => {
                if (isSyncControlLocked()) return;
                playVideo(video.bvid, {
                    publish: state.settings.isHost,
                    reason: 'video-select',
                });
            };

            void enrichVideoTitle(video);

            item.appendChild(main);

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'video-item-remove';
            removeBtn.textContent = t('video_delete');
            const canRemove = canManagePlaylist();
            removeBtn.disabled = !canRemove;
            removeBtn.title = canRemove ? t('delete_video_title') : t('only_host_admin_delete_video');
            removeBtn.onclick = async (event) => {
                event.stopPropagation();
                if (!canManagePlaylist()) {
                    alert(t('only_host_admin_delete_video'));
                    return;
                }

                const currentIndex = getCurrentPlayingVideoIndex();
                const targetIndexBeforeRemove = activeVideos.findIndex((candidate) => {
                    if (video.shareId && candidate.shareId) {
                        return candidate.shareId === video.shareId;
                    }
                    return String(candidate.bvid || '').toUpperCase() === String(video.bvid || '').toUpperCase();
                });

                const removed = removeVideoByReference(video, { publishRemoval: true });
                if (!removed) return;

                const removedIsCurrent = currentIndex >= 0 && currentIndex === targetIndexBeforeRemove;
                if (removedIsCurrent && activeVideos.length > 0 && state.settings.isHost) {
                    const fallbackIndex = Math.min(Math.max(targetIndexBeforeRemove, 0), activeVideos.length - 1);
                    const nextVideo = activeVideos[fallbackIndex];
                    if (nextVideo && nextVideo.bvid) {
                        await playVideo(nextVideo.bvid, {
                            publish: true,
                            reason: 'playlist-delete-switch',
                            statusHint: t('current_deleted_switched'),
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
    const indicator = windowInstance?.content?.querySelector('#bclt-sync-indicator');
    if (!indicator) return;
    indicator.classList.toggle('is-active', !!active);
}

function updateMediaToggleButton(snapshot) {
    const btn = windowInstance?.content?.querySelector('#bclt-btn-toggle-play');
    if (!btn || !snapshot) return;
    const paused = !!snapshot.paused;
    btn.textContent = paused ? '▶' : '❚❚';
    btn.title = paused ? t('action_play') : t('action_pause');
    btn.classList.toggle('is-paused', !paused);
}

function updatePlaybackUi(statusHint = '') {
    const currentLabel = windowInstance?.content?.querySelector('#bclt-progress-current');
    const maxLabel = windowInstance?.content?.querySelector('#bclt-progress-max');
    const rangeEl = windowInstance?.content?.querySelector('#bclt-progress-range');
    const statusEl = windowInstance?.content?.querySelector('#bclt-player-status');
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

    const mode = snapshot.paused ? t('playback_paused') : t('playback_playing');
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
    const {
        publishState = false,
        reason = 'local',
        forceReload = false,
        statusHint = '',
        syncProgress = true,
    } = options;

    if (nextState && nextState.playbackMode) {
        await setPlaybackMode(nextState.playbackMode, {
            save: true,
            publishMode: false,
            statusHint: '',
        });
    }

    const sourceUrl = nextState.sourceUrl || state.bilibili.sourceUrl;
    if (!sourceUrl) return false;

    const current = computeBilibiliSyntheticState();
    const incomingTime = Number.isFinite(Number(nextState.currentTime)) ? Number(nextState.currentTime) : current.currentTime;
    const targetTime = syncProgress ? incomingTime : current.currentTime;
    const incomingPaused = typeof nextState.paused === 'boolean' ? nextState.paused : current.paused;
    const incomingRate = Number.isFinite(Number(nextState.playbackRate)) && Number(nextState.playbackRate) > 0
        ? Number(nextState.playbackRate)
        : current.playbackRate;

    const playerContainer = windowInstance?.content?.querySelector('#bclt-player-container');
    const iframeEl = windowInstance?.content?.querySelector('#bclt-player-container iframe');
    if (!playerContainer) return false;
    const highQualityMode = isHighQualityTabModeEnabled();

    const thresholdSeconds = Math.max(0.1, Number(state.settings.driftThresholdMs || 800) / 1000);
    const driftSeconds = Math.abs(targetTime - current.currentTime);
    const sourceChanged = normalizeBilibiliSourceForSync(sourceUrl) !== normalizeBilibiliSourceForSync(current.sourceUrl);
    const pausedChanged = incomingPaused !== current.paused;
    const rateChanged = incomingRate !== current.playbackRate;
    const isRemoteSyncReason = reason === 'remote-sync' || reason === 'remote-playlist-state';
    const missingInlineIframe = !highQualityMode && !iframeEl;
    const shouldReloadByState = forceReload || missingInlineIframe || sourceChanged || pausedChanged || rateChanged;
    const shouldReloadByDrift = syncProgress && driftSeconds > thresholdSeconds;
    let shouldReload = shouldReloadByState || shouldReloadByDrift;

    setBilibiliSyntheticState({
        sourceUrl,
        currentTime: targetTime,
        duration: nextState.duration,
        paused: incomingPaused,
        playbackRate: incomingRate,
    }, reason);

    const shouldHydrateDuration = !Number.isFinite(Number(nextState.duration)) || Number(nextState.duration) <= 0;
    if (shouldHydrateDuration && (sourceChanged || !Number.isFinite(Number(current.duration)) || Number(current.duration) <= 0)) {
        void hydrateBilibiliDuration(sourceUrl)
            .then((duration) => {
                if (!Number.isFinite(Number(duration)) || Number(duration) <= 0) return;
                updatePlaybackUi();
                if (state.settings.isHost && state.settings.syncPlaybackProgress !== false) {
                    void publish('media_state', computeBilibiliSyntheticState());
                }
            })
            .catch((error) => {
                console.warn('[BCLT] duration hydration failed:', error);
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
        console.log('[BCLT] High-quality tab mode enabled, shouldReload:', shouldReload);
        if (shouldReload) {
            if (incomingPaused) {
                console.log('[BCLT] HQ mode paused: closing popup window instead of relying on autoplay flag.');
                closeHighQualityPlaybackTab();
                updatePlaybackUi(t('hq_paused_parked'));
                highQualityTabLastSyncAt = Date.now();
            } else {
                console.log('[BCLT] Attempting to update or open high-quality playback tab...');
                const result = updateOrOpenHighQualityPlaybackTab(sourceUrl, targetTime, { autoplay: true });
                console.log('[BCLT] Tab operation result:', result);
                if (!result.ok) {
                    console.warn('[BCLT] Tab operation failed:', result.message);
                    updatePlaybackUi(result.message || 'HQ tab operation failed');
                } else {
                    const actionText = result.action === 'updated' ? 'Updated' : 'Opened';
                    updatePlaybackUi(`${actionText} in Bilibili: ${result.watchUrl.split('/').slice(-1)[0]}`);
                    highQualityTabLastSyncAt = Date.now();
                }
            }
        } else {
            console.log('[BCLT] shouldReload is false, not updating tab');
        }
    } else if (shouldReload) {
        closeHighQualityPlaybackTab();
        const playerUrl = buildBilibiliPlayerUrl(sourceUrl, {
            currentTime: targetTime,
            autoplay: !incomingPaused,
        });
        if (!playerUrl) return false;
        playerContainer.innerHTML = `<iframe src="${playerUrl}" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
    }

    updatePlaybackUi(statusHint);

    if (publishState && state.settings.isHost && state.settings.syncPlaybackProgress !== false) {
        await publish('media_state', computeBilibiliSyntheticState());
    }

    return true;
}

async function controlRoomPlayback(action, value = 0) {
    const current = computeBilibiliSyntheticState();
    const sourceUrl = current.sourceUrl || state.bilibili.sourceUrl;
    if (!sourceUrl) {
        alert(t('select_video_first'));
        return;
    }

    if (action === 'play') {
        await applyRoomPlaybackState({
            sourceUrl,
            currentTime: current.currentTime,
            paused: false,
            playbackRate: current.playbackRate,
        }, { publishState: true, reason: 'local-play', forceReload: true });
        return;
    }

    if (action === 'pause') {
        await applyRoomPlaybackState({
            sourceUrl,
            currentTime: current.currentTime,
            paused: true,
            playbackRate: current.playbackRate,
        }, { publishState: true, reason: 'local-pause', forceReload: true });
        return;
    }

    if (action === 'seek') {
        await applyRoomPlaybackState({
            sourceUrl,
            currentTime: Math.max(0, Number(value) || 0),
            paused: current.paused,
            playbackRate: current.playbackRate,
        }, { publishState: true, reason: 'local-seek', forceReload: true });
    }
}

async function playVideo(bvid, options = {}) {
    const sourceUrl = `https://www.bilibili.com/video/${bvid}?t=1`;
    await applyRoomPlaybackState({
        sourceUrl,
        currentTime: 0,
        paused: false,
        playbackRate: 1,
    }, {
        publishState: !!options.publish,
        reason: options.reason || 'video-select',
        forceReload: true,
        statusHint: options.statusHint || '',
    });
}

function initializeRoomMode(playerContainer, videoList, statusEl) {
    // Setup callback for remote video sharing
    state.onRemoteVideoShared = async (payload) => {
        if (payload && payload.bvid) {
            if (payload.shareId && activeVideos.some((video) => video.shareId === payload.shareId)) {
                return;
            }

            const sender = payload.senderName || payload.sender || 'Unknown';
            mergeActiveVideos([{
                shareId: payload.shareId || '',
                sender,
                title: payload.title || payload.videoTitle || payload.bvid,
                bvid: payload.bvid,
                url: payload.url || `https://www.bilibili.com/video/${payload.bvid}`,
                timestamp: Number(payload.timestamp || Date.now()),
            }]);
            updateVideoList();
            logStatus(`${sender} shared: ${payload.title || payload.bvid}`);
        }
    };

    state.onRemotePlaylistRequest = async (payload) => {
        if (!state.settings.isHost) return false;

        const requesterId = payload && payload.requesterId ? String(payload.requesterId) : '';
        if (requesterId && requesterId === memberId()) return false;

        await publish('playlist_state', buildPlaylistStatePayload(requesterId));
        return true;
    };

    state.onRemotePlaylistState = async (payload, envelope) => {
        if (!payload) return false;

        const targetMemberId = payload.targetMemberId ? String(payload.targetMemberId) : '';
        if (targetMemberId && targetMemberId !== memberId()) return false;

        if (!state.settings.isHost && envelope && envelope.senderId && envelope.senderId !== state.settings.roomHostMemberId) {
            // Allow non-host clients to trust playlist snapshot only from current host.
            return false;
        }

        mergeActiveVideos(Array.isArray(payload.videos) ? payload.videos : []);
        setRoomAdminMemberIds(payload.adminMemberIds);
        if (payload.playbackMode) {
            await setPlaybackMode(payload.playbackMode, {
                save: true,
                publishMode: false,
            });
        }
        refreshHostUiPrivileges();
        updateVideoList();

        const localSyncProgress = state.settings.syncPlaybackProgress !== false;
        const payloadSyncProgress = payload.syncProgress !== false;
        if (payload.mediaState && localSyncProgress && payloadSyncProgress) {
            await applyRoomPlaybackState(payload.mediaState, {
                publishState: false,
                reason: 'remote-playlist-state',
                forceReload: false,
                syncProgress: true,
                statusHint: 'sync',
            });
        }

        return true;
    };

    state.onRoomConnected = async () => {
        if (state.settings.isHost) return;

        await publish('playlist_request', {
            requesterId: memberId(),
            requestedAt: Date.now(),
        });
    };

    state.onRemoteMediaState = async (payload, envelope) => {
        if (!payload) return false;

        if (state.settings.syncPlaybackProgress === false || payload.syncProgress === false) {
            return true;
        }

        const sourceUrl = payload.sourceUrl || payload.src || (payload.bvid ? `https://www.bilibili.com/video/${payload.bvid}` : '');
        const isBilibili = payload.mediaKind === 'bilibili' || /bilibili\.com|b23\.tv|BV[0-9A-Za-z]{10,}/i.test(sourceUrl);
        if (!isBilibili || !sourceUrl) return false;

        const localSyncProgress = state.settings.syncPlaybackProgress !== false;
        const payloadSyncProgress = payload.syncProgress !== false;
        const shouldSyncProgress = localSyncProgress && payloadSyncProgress;

        const applied = await applyRoomPlaybackState({
            sourceUrl,
            currentTime: payload.currentTime,
            duration: payload.duration,
            paused: payload.paused,
            playbackRate: payload.playbackRate,
            playbackMode: payload.playbackMode,
        }, {
            publishState: false,
            reason: 'remote-sync',
            forceReload: false,
            syncProgress: shouldSyncProgress,
            statusHint: 'sync',
        });

        return applied;
    };

    state.onRemoteRoomControl = async (payload, envelope) => {
        if (!payload || !payload.action) return false;

        if (payload.action === 'ownership_transferred') {
            const newHostId = payload.newHostMemberId ? String(payload.newHostMemberId) : '';
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
            updatePlaybackUi(state.settings.isHost
                ? t('now_you_are_host')
                : t('host_changed_to', { name: payload.newHostDisplayName || newHostId }));

            const roomNameEl = windowInstance?.headerEl?.querySelector('#bclt-toolbar-room-name');
            if (roomNameEl) {
                roomNameEl.textContent = formatRoomToolbarLabel();
            }

            logStatus(`Ownership transferred by ${envelope.senderName || envelope.senderId}`);
            return true;
        }

        if (payload.action === 'admin_members_updated') {
            const senderId = envelope && envelope.senderId ? String(envelope.senderId) : '';
            if (!senderId || senderId !== String(state.settings.roomHostMemberId || '')) return false;

            setRoomAdminMemberIds(payload.adminMemberIds);
            refreshHostUiPrivileges();
            updateVideoList();
            updatePlaybackUi(t('admins_synced'));
            return true;
        }

        if (payload.action === 'playback_mode_changed') {
            await setPlaybackMode(payload.playbackMode, {
                save: true,
                publishMode: false,
                statusHint: t('play_mode_synced'),
            });
            return true;
        }

        if (payload.action === 'playlist_video_removed') {
            const senderId = envelope && envelope.senderId ? String(envelope.senderId) : '';
            const hostId = String(state.settings.roomHostMemberId || '');
            const senderIsHost = senderId && hostId && senderId === hostId;
            const senderIsAdmin = senderId && state.roomAdminMemberIds.includes(senderId);
            if (!senderIsHost && !senderIsAdmin) return false;

            const removed = removeVideoByReference(payload, { publishRemoval: false });
            if (removed) {
                updatePlaybackUi(t('playlist_updated'));
            }
            return removed;
        }

        return false;
    };

    // Join the room
    startPlaybackUiTicker();
    joinRoom();
    updateVideoList();
    updatePlaybackUi();

    // Hydrate the latest room snapshot so late joiners see the currently playing video immediately.
    void (async () => {
        try {
            if (state.settings.syncPlaybackProgress === false) return;
            const snapshot = await fetchCurrentRoomPlaybackState();
            if (!snapshot) return;

            await applyRoomPlaybackState(snapshot, {
                publishState: false,
                reason: 'hydrate-room-state',
                forceReload: true,
                syncProgress: state.settings.syncPlaybackProgress !== false,
                statusHint: 'sync',
            });
        } catch (error) {
            console.warn('[BCLT] hydrate room state failed:', error);
        }
    })();
}

function clearRoomCallbacks() {
    state.onRemoteVideoShared = null;
    state.onRemoteMediaState = null;
    state.onRemotePlaylistState = null;
    state.onRemotePlaylistRequest = null;
    state.onRemoteRoomControl = null;
    state.onRoomConnected = null;
}
