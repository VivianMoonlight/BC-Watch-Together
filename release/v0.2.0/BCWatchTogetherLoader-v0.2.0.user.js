// ==UserScript==
// @name         BC Watch Together Loader
// @namespace    https://github.com/VivianMoonlight
// @version      0.2.0
// @description  Loader script for BC Watch Together remote entry.
// @author       VivianMoonlight
// @match        https://bondageprojects.elementfx.com/*
// @match        https://www.bondageprojects.elementfx.com/*
// @match        https://bondage-europe.com/*
// @match        https://www.bondage-europe.com/*
// @match        https://bondageprojects.com/*
// @match        https://www.bondageprojects.com/*
// @match        https://www.bondage-asia.com/club/R*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // Primary source (raw) plus CDN fallback. We execute via Blob to avoid MIME restrictions.
    const REMOTE_ENTRY_URLS = [
        'https://raw.githubusercontent.com/VivianMoonlight/BC-Watch-Together/main/BCWatchTogether.user.js',
        'https://cdn.jsdelivr.net/gh/VivianMoonlight/BC-Watch-Together@main/BCWatchTogether.user.js',
    ];

    async function loadRemoteEntry() {
        const stamp = Date.now();

        for (const baseUrl of REMOTE_ENTRY_URLS) {
            const url = `${baseUrl}?t=${stamp}`;
            try {
                const response = await fetch(url, { cache: 'no-store' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                const code = await response.text();
                const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));

                const script = document.createElement('script');
                script.src = blobUrl;
                script.onload = () => {
                    URL.revokeObjectURL(blobUrl);
                    script.remove();
                };
                script.onerror = () => {
                    URL.revokeObjectURL(blobUrl);
                    console.error('[BCWT] Failed to execute remote script from', baseUrl);
                };

                document.head.appendChild(script);
                return;
            } catch (error) {
                console.warn('[BCWT] Failed to download remote script from', baseUrl, error);
            }
        }

        console.error('[BCWT] All remote script sources failed.');
    }

    setTimeout(() => {
        loadRemoteEntry();
    }, 1000);
})();
