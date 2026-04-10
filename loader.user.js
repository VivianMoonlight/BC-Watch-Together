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

    // This URL points to the published bundled userscript artifact.
    const REMOTE_ENTRY_URL = 'https://raw.githubusercontent.com/VivianMoonlight/BC-Watch-Together/main/dist/BCWatchTogether.user.js';

    setTimeout(() => {
        const script = document.createElement('script');
        script.crossOrigin = 'anonymous';
        script.src = `${REMOTE_ENTRY_URL}?t=${Date.now()}`;
        script.onload = () => script.remove();
        script.onerror = () => {
            console.error('[BCLT] Failed to load remote script from', REMOTE_ENTRY_URL);
        };
        document.head.appendChild(script);
    }, 1000);
})();
