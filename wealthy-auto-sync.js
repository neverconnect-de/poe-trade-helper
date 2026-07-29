// ==UserScript==
// @name         Wealthy Exile Auto Sync
// @namespace    https://wealthyexile.com/
// @version      1.0.1
// @updateURL    https://raw.githubusercontent.com/neverconnect-de/poe-trade-helper/refs/heads/main/wealthy-auto-sync.js
// @downloadURL  https://raw.githubusercontent.com/neverconnect-de/poe-trade-helper/refs/heads/main/wealthy-auto-sync.js
// @description  Automatically clicks the "Sync stash" button at a configurable interval.
// @match        https://wealthyexile.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
    "use strict";

    // Change this value to your desired interval.
    const SYNC_INTERVAL_MINUTES = 15;

    const SYNC_BUTTON_SELECTOR = 'button[aria-label="Sync stash"]';
    const TOGGLE_BUTTON_ID = "tampermonkey-auto-sync-toggle";
    const STORAGE_KEY = "wealthyExileAutoSyncEnabled";

    let intervalId = null;

    function isAutoSyncEnabled() {
        return localStorage.getItem(STORAGE_KEY) === "true";
    }

    function saveAutoSyncState(enabled) {
        localStorage.setItem(STORAGE_KEY, String(enabled));
    }

    function getSyncButton() {
        return document.querySelector(SYNC_BUTTON_SELECTOR);
    }

    function syncStash() {
        const syncButton = getSyncButton();

        if (!syncButton) {
            console.warn("[Auto Sync] Sync stash button not found.");
            return;
        }

        if (syncButton.disabled || syncButton.dataset.disabled === "true") {
            console.log("[Auto Sync] Sync stash button is currently disabled.");
            return;
        }

        console.log(
            `[Auto Sync] Clicking Sync stash at ${new Date().toLocaleTimeString()}`
        );

        syncButton.click();
    }

    function startAutoSync(syncImmediately = false) {
        stopAutoSync();

        console.log(
            `[Auto Sync] Enabled. Interval: ${SYNC_INTERVAL_MINUTES} minute(s).`
        );

        if (syncImmediately) {
            syncStash();
        }

        intervalId = window.setInterval(
            syncStash,
            SYNC_INTERVAL_MINUTES * 60 * 1000
        );
    }

    function stopAutoSync() {
        if (intervalId !== null) {
            window.clearInterval(intervalId);
            intervalId = null;
        }

        console.log("[Auto Sync] Disabled.");
    }

    function updateToggleButton() {
        const toggleButton = document.getElementById(TOGGLE_BUTTON_ID);

        if (!toggleButton) {
            return;
        }

        const enabled = isAutoSyncEnabled();

        toggleButton.textContent = enabled
            ? `Auto-sync ON (${SYNC_INTERVAL_MINUTES}m)`
            : "Auto-sync OFF";

        toggleButton.setAttribute("aria-pressed", String(enabled));
        toggleButton.title = enabled
            ? "Click to disable automatic stash syncing"
            : "Click to enable automatic stash syncing";

        toggleButton.style.background = enabled
            ? "var(--mantine-color-green-filled, #2f9e44)"
            : "var(--mantine-color-default, #25262b)";

        toggleButton.style.color = enabled
            ? "#ffffff"
            : "var(--mantine-color-default-color, #ffffff)";
    }

    function toggleAutoSync() {
        const enabled = !isAutoSyncEnabled();

        saveAutoSyncState(enabled);
        updateToggleButton();

        if (enabled) {
            // Change to false if it should wait for the first interval.
            startAutoSync(true);
        } else {
            stopAutoSync();
        }
    }

    function createToggleButton() {
        if (document.getElementById(TOGGLE_BUTTON_ID)) {
            return;
        }

        const syncButton = getSyncButton();

        if (!syncButton) {
            return;
        }

        const toggleButton = document.createElement("button");

        toggleButton.id = TOGGLE_BUTTON_ID;
        toggleButton.type = "button";
        toggleButton.addEventListener("click", toggleAutoSync);

        Object.assign(toggleButton.style, {
            height: "36px",
            padding: "0 12px",
            border: "1px solid var(--mantine-color-default-border, #373a40)",
            borderRadius: "4px",
            cursor: "pointer",
            fontSize: "14px",
            fontWeight: "500",
            whiteSpace: "nowrap",
            transition: "background 150ms ease"
        });

        /*
         * The Sync stash button is inside its own wrapper div.
         * Insert our toggle after that wrapper so it appears beside it.
         */
        const syncButtonWrapper = syncButton.parentElement;

        if (syncButtonWrapper?.parentElement) {
            syncButtonWrapper.insertAdjacentElement("afterend", toggleButton);
        } else {
            syncButton.insertAdjacentElement("afterend", toggleButton);
        }

        updateToggleButton();
    }

    function initialize() {
        createToggleButton();

        if (isAutoSyncEnabled() && intervalId === null) {
            startAutoSync(false);
        }
    }

    /*
     * Wealthy Exile appears to be a dynamic React/Next.js application.
     * The MutationObserver restores the toggle if navigation or a rerender
     * replaces the relevant DOM elements.
     */
    const observer = new MutationObserver(() => {
        if (
            getSyncButton() &&
            !document.getElementById(TOGGLE_BUTTON_ID)
        ) {
            createToggleButton();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    initialize();
})();
