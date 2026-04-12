// ==UserScript==
// @name         BC Watch Together Loader
// @namespace    https://github.com/VivianMoonlight
// @version      0.3.0
// @description  Loader script for BC Watch Together remote entry.
// @author       VivianMoonlight
// @match        https://bondageprojects.elementfx.com/*
// @match        https://www.bondageprojects.elementfx.com/*
// @match        https://bondage-europe.com/*
// @match        https://www.bondage-europe.com/*
// @match        https://bondageprojects.com/*
// @match        https://www.bondageprojects.com/*
// @match        https://www.bondage-asia.com/club/R*
// @require      https://cdn.jsdelivr.net/npm/systemjs@6.15.1/dist/system.min.js
// @require      https://cdn.jsdelivr.net/npm/systemjs@6.15.1/dist/extras/named-register.min.js
// @require      data:application/javascript,%3B(typeof%20System!%3D'undefined')%26%26(System%3Dnew%20System.constructor())%3B
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

    const SYSTEMJS_URLS = [
        'https://cdn.jsdelivr.net/npm/systemjs@6.15.1/dist/system.min.js',
        'https://cdn.jsdelivr.net/npm/systemjs@6.15.1/dist/extras/named-register.min.js',
    ];

    function loadScriptTag(url) {
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

    async function ensureSystemRuntime() {
        if (typeof window.System !== 'undefined') return;

        for (const url of SYSTEMJS_URLS) {
            await loadScriptTag(url);
        }

        if (typeof window.System !== 'undefined' && window.System.constructor) {
            window.System = new window.System.constructor();
        }
    }

    async function loadRemoteEntry() {
        const stamp = Date.now();

        try {
            await ensureSystemRuntime();
        } catch (error) {
            console.error('[BCWT] Failed to initialize SystemJS runtime.', error);
            return;
        }

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
