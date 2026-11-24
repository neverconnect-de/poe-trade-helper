// ==UserScript==
// @name         PoE Trade Helper
// @namespace    https://neverconnect.de/
// @version      0.9.5
// @updateURL    https://raw.githubusercontent.com/neverconnect-de/poe-trade-helper/refs/heads/main/poe-trade-helper.js
// @downloadURL  https://raw.githubusercontent.com/neverconnect-de/poe-trade-helper/refs/heads/main/poe-trade-helper.js
// @description  Build a poe.re-style regex from trade stat filter.
// @author       neverconnect
// @match        https://www.pathofexile.com/trade/search/*
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';

  const STYLE_ID = 'tm-poe-trade-not-regex-style';
  const GROUP_TOOL_CLASS = 'tm-poe-trade-group-tools';
  const GROUP_TOOLBAR_CLASS = 'tm-poe-trade-group-toolbar';
  const RESULT_REGEX_BUTTON_CLASS = 'tm-poe-trade-row-regex-btn';
  const TOAST_ID = 'tm-poe-trade-regex-toast';
  const TOKEN_SOURCE_URL = 'https://raw.githubusercontent.com/veiset/poe-vendor-string/master/poe/public/generated/mapmods/Generated.Map.ENGLISH.min.json';
  const TOKEN_CACHE_KEY = 'tm-poe-trade-not-regex-cache-v2';
  const TOKEN_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const PHYSICAL_REFLECT_TEXT = 'Monsters reflect (13-18)% of Physical Damage';
  const ELEMENTAL_REFLECT_TEXT = 'Monsters reflect (13-18)% of Elemental Damage';
  const PHYSICAL_REFLECT_GENERALIZED = 'monsters reflect #% of physical damage';
  const ELEMENTAL_REFLECT_GENERALIZED = 'monsters reflect #% of elemental damage';
  const SPECIAL_STATIC_REGEX_BUILDERS = {
    'map is occupied by': () => 'occupied',
    'area is influenced by any': () => '(shaper|elder)',
    'area is influenced by the shaper': () => 'shaper',
    'area is influenced by the elder': () => 'elder',
    'area is influenced by the originator s memories': () => 'originator',
    'map contains s citadel': () => 'citadel',
    'has shaper influence': () => 'shaper',
    'has elder influence': () => 'elder',
    'has crusader influence': () => 'crusader',
    'has redeemer influence': () => 'redeemer',
    'has hunter influence': () => 'hunter',
    'has warlord influence': () => 'warlord'
  };
  const SPECIAL_PSEUDO_REGEX_BUILDERS = {
    'more currency': (min) => `urr.*${buildValueRegex(min)}%`,
    'more scarabs': (min) => `sca.*${buildValueRegex(min)}%`,
    'more maps': (min) => `aps.*${buildValueRegex(min)}%`,
    'more divination cards': (min) => `div.*${buildValueRegex(min)}%`,
    'quality currency': (min) => `cy\\).*${buildValueRegex(min)}%`,
    'quality scarabs': (min) => `bs\\).*${buildValueRegex(min)}%`,
    'quality divination cards': (min) => `ds\\).*${buildValueRegex(min)}%`,
    'quality pack size': (min) => `ty\\).*${buildValueRegex(min)}%|ze\\).*${buildValueRegex(min)}%`
  };

  const DIRECT_BUTTON_SELECTOR = '.btns .direct-btn';
  const IN_DEMAND_CONFIRM_PATTERN = /teleport\s+anyway/i;
  const AUTO_CONFIRM_WINDOW_MS = 8000;
  const AUTO_CONFIRM_POLL_MS = 40;

  let tokenCachePromise = null;
  let autoConfirmTimer = null;
  let autoConfirmObserver = null;
  let autoConfirmClickInFlight = false;
  const autoConfirmWatchers = new Map();

  // Seller ranking: the trade API hands out at most 100 ids per search, so the counts cover
  // the first 100 listings in the search's sort order (cheapest first by default).
  const SELLER_BADGE_CLASS = 'tm-poe-trade-seller-count';
  const SELLER_STATUS_CLASS = 'tm-poe-trade-seller-status';
  const SELLER_PANEL_ID = 'tm-poe-trade-seller-panel';
  const SELLER_SETTINGS_KEY = 'tm-poe-trade-seller-settings-v1';
  const SELLER_FETCH_BATCH = 10;
  const SELLER_SCAN_LIMIT = 100;
  const SELLER_SCAN_REUSE_MS = 2 * 60 * 1000;
  const sellerSettings = readSellerSettings();
  const sellerScans = new Map();
  let sellerScanPath = null;
  let sellerScan = null;

  function init() {
    injectStyles();
    ensureToast();
    injectGlobalCopyButton();
    injectResultButtons();
    observeDom();
    setupInDemandAutoConfirm();
    watchSellerCounts();
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${TOAST_ID} {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 99999;
        width: 340px;
        background: rgba(15, 15, 15, 0.96);
        color: #f0e6d2;
        border: 1px solid #8b6c2f;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
        padding: 10px 12px;
        font: 12px/1.4 Verdana, sans-serif;
        opacity: 0;
        pointer-events: none;
        transform: translateY(8px);
        transition: opacity 0.18s ease, transform 0.18s ease;
      }

      #${TOAST_ID}.visible {
        opacity: 1;
        transform: translateY(0);
      }

      #${TOAST_ID} .tm-title {
        font-size: 13px;
        font-weight: 700;
        margin-bottom: 6px;
        color: #f8d88c;
      }

      #${TOAST_ID} .tm-status {
        color: #d7c9a8;
        margin-bottom: 6px;
      }

      #${TOAST_ID} .tm-regex {
        width: 100%;
        box-sizing: border-box;
        background: #0b0b0b;
        color: #f0e6d2;
        border: 1px solid #59451d;
        padding: 8px;
        font: 12px/1.35 Consolas, Monaco, monospace;
        white-space: pre-wrap;
        word-break: break-word;
      }

      #${TOAST_ID} .tm-meta {
        margin-top: 8px;
        color: #b9ab87;
        white-space: pre-wrap;
      }

      .${GROUP_TOOL_CLASS} {
        display: inline-flex;
        align-items: center;
        gap: 0;
      }

      .${GROUP_TOOLBAR_CLASS} {
        display: inline-flex;
        align-items: center;
        margin-right: 10px;
        flex: 0 0 auto;
      }

      .${GROUP_TOOL_CLASS} .tm-group-btn.tm-regex-copy-btn {
        min-width: 0;
        width: auto;
        padding: 0 14px;
      }

      .controls-right .${GROUP_TOOL_CLASS} .tm-group-btn.tm-regex-copy-btn .plus {
        margin-right: 8px;
      }

      .btns .${RESULT_REGEX_BUTTON_CLASS} {
        margin-left: 6px;
        min-width: 0;
        padding: 0 8px;
        font-size: 11px;
        letter-spacing: 0.02em;
      }

      .${SELLER_BADGE_CLASS} {
        display: inline-block;
        margin-left: 6px;
        padding: 0 5px;
        border: 1px solid #8b6c2f;
        border-radius: 3px;
        background: #2a1f0b;
        color: #f8d88c;
        font-size: 11px;
        font-weight: 700;
        line-height: 16px;
        cursor: help;
      }

      .${SELLER_STATUS_CLASS} {
        margin-left: 12px;
        color: #b9ab87;
        font-size: 12px;
      }

      .${SELLER_STATUS_CLASS}.tm-error {
        color: #e0806a;
      }

      #${SELLER_PANEL_ID} {
        position: fixed;
        top: 140px;
        right: 0;
        z-index: 9999;
        display: flex;
        align-items: flex-start;
        font: 12px/1.4 Verdana, sans-serif;
        color: #f0e6d2;
      }

      #${SELLER_PANEL_ID} .tm-handle {
        writing-mode: vertical-rl;
        transform: rotate(180deg);
        padding: 10px 5px;
        background: rgba(15, 15, 15, 0.96);
        border: 1px solid #8b6c2f;
        border-left: none;
        color: #f8d88c;
        font-weight: 700;
        cursor: pointer;
        user-select: none;
      }

      #${SELLER_PANEL_ID} .tm-handle .tm-handle-count {
        display: inline-block;
        margin-top: 6px;
        padding: 3px 0;
        background: #8b6c2f;
        color: #0b0b0b;
        border-radius: 3px;
      }

      #${SELLER_PANEL_ID} .tm-body {
        display: none;
        width: 360px;
        max-height: 70vh;
        overflow-y: auto;
        background: rgba(15, 15, 15, 0.96);
        border: 1px solid #8b6c2f;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
        padding: 10px 12px;
      }

      #${SELLER_PANEL_ID}.open .tm-body {
        display: block;
      }

      #${SELLER_PANEL_ID} .tm-title {
        font-size: 13px;
        font-weight: 700;
        color: #f8d88c;
        margin-bottom: 8px;
      }

      #${SELLER_PANEL_ID} label {
        display: block;
        margin-bottom: 6px;
        color: #d7c9a8;
        cursor: pointer;
      }

      #${SELLER_PANEL_ID} input[type="number"] {
        width: 48px;
        background: #0b0b0b;
        color: #f0e6d2;
        border: 1px solid #59451d;
      }

      #${SELLER_PANEL_ID} .tm-panel-status {
        margin: 8px 0;
        color: #b9ab87;
      }

      #${SELLER_PANEL_ID} .tm-panel-status.tm-error {
        color: #e0806a;
      }

      #${SELLER_PANEL_ID} .tm-seller {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 0;
        border-top: 1px solid #2c2414;
      }

      #${SELLER_PANEL_ID} .tm-seller-count {
        min-width: 34px;
        color: #f8d88c;
        font-weight: 700;
        font-size: 14px;
      }

      #${SELLER_PANEL_ID} .tm-seller-main {
        flex: 1;
        min-width: 0;
      }

      #${SELLER_PANEL_ID} .tm-seller-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${SELLER_PANEL_ID} .tm-seller-price {
        color: #b9ab87;
        font-size: 11px;
      }

      #${SELLER_PANEL_ID} .tm-seller button {
        flex: 0 0 auto;
      }

    `;
    document.head.appendChild(style);
  }

  function ensureToast() {
    if (document.getElementById(TOAST_ID)) {
      return;
    }

    const toast = document.createElement('div');
    toast.id = TOAST_ID;
    toast.innerHTML = `
      <div class="tm-title">Regex Copied</div>
      <div class="tm-status">Ready.</div>
      <div class="tm-regex"></div>
      <div class="tm-meta"></div>
    `;
    document.body.appendChild(toast);
  }

  function observeDom() {
    const observer = new MutationObserver(() => {
      ensureToast();
      injectGlobalCopyButton();
      injectResultButtons();
      watchSellerCounts();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  // The trade site guards popular listings: clicking "Travel to Hideout" can swap the very
  // same button into an "In demand. Teleport anyway?" confirmation instead of teleporting.
  // Arm a short-lived watcher on every hideout button the user clicks, and press the
  // confirmation for them as soon as it shows up.
  function setupInDemandAutoConfirm() {
    document.addEventListener('click', handleDirectButtonClick, true);
  }

  function handleDirectButtonClick(event) {
    if (autoConfirmClickInFlight) {
      return;
    }

    const target = event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }

    const button = target.closest(DIRECT_BUTTON_SELECTOR);
    if (!button || button.disabled || button.classList.contains('disabled')) {
      return;
    }

    const label = normalizeWhitespace(button.textContent);
    if (IN_DEMAND_CONFIRM_PATTERN.test(label)) {
      // Already the confirmation step, the user approved it themselves.
      return;
    }

    const row = button.closest('.row');
    autoConfirmWatchers.set(button, {
      button,
      row,
      rowId: row ? row.getAttribute('data-id') : null,
      initialLabel: label,
      deadline: Date.now() + AUTO_CONFIRM_WINDOW_MS
    });

    startAutoConfirmLoop();
  }

  function startAutoConfirmLoop() {
    if (!autoConfirmObserver) {
      autoConfirmObserver = new MutationObserver(pollAutoConfirm);
    }

    // The button text is swapped in place, so plain childList mutations are not enough.
    autoConfirmObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'disabled']
    });

    if (!autoConfirmTimer) {
      autoConfirmTimer = setInterval(pollAutoConfirm, AUTO_CONFIRM_POLL_MS);
    }
  }

  function stopAutoConfirmLoop() {
    if (autoConfirmTimer) {
      clearInterval(autoConfirmTimer);
      autoConfirmTimer = null;
    }

    if (autoConfirmObserver) {
      autoConfirmObserver.disconnect();
    }
  }

  function pollAutoConfirm() {
    const now = Date.now();

    autoConfirmWatchers.forEach((entry, key) => {
      const button = resolveWatchedButton(entry);
      if (!button || now > entry.deadline) {
        autoConfirmWatchers.delete(key);
        return;
      }

      entry.button = button;
      if (!isInDemandConfirmButton(button, entry) || button.disabled || button.classList.contains('disabled')) {
        return;
      }

      autoConfirmWatchers.delete(key);
      confirmInDemandTeleport(button);
    });

    if (autoConfirmWatchers.size === 0) {
      stopAutoConfirmLoop();
    }
  }

  function resolveWatchedButton(entry) {
    if (entry.button && entry.button.isConnected) {
      return entry.button;
    }

    // Vue can re-render the row; fall back to the same listing by id.
    if (entry.row && entry.row.isConnected) {
      return entry.row.querySelector(DIRECT_BUTTON_SELECTOR);
    }

    if (!entry.rowId) {
      return null;
    }

    const rowId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(entry.rowId) : entry.rowId.replace(/"/g, '\\"');
    const row = document.querySelector(`.row[data-id="${rowId}"]`);
    if (!row) {
      return null;
    }

    entry.row = row;
    return row.querySelector(DIRECT_BUTTON_SELECTOR);
  }

  function isInDemandConfirmButton(button, entry) {
    const label = normalizeWhitespace(button.textContent);
    if (IN_DEMAND_CONFIRM_PATTERN.test(label)) {
      return true;
    }

    // Locale independent fallback: the soft failure adds the "expired" class while leaving the
    // button clickable, whereas a genuinely expired listing is also disabled.
    return label !== entry.initialLabel && button.classList.contains('expired');
  }

  function confirmInDemandTeleport(button) {
    autoConfirmClickInFlight = true;
    try {
      button.click();
    } finally {
      autoConfirmClickInFlight = false;
    }

    showToast('Teleport confirmed', '', 'Skipped the "In demand. Teleport anyway?" prompt.', false);
  }

  function copyText(value) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(value);
      return;
    }

    navigator.clipboard.writeText(value).catch(() => {
      /* noop */
    });
  }

  function extractSelectedModsForGroup(group) {
    if (!isTradeFilterGroupEnabled(group)) {
      return [];
    }

    const exactRows = extractSelectedModsFromTradeMarkup(group);
    if (exactRows.length > 0) {
      return exactRows;
    }

    const stateBackedRows = extractSelectedModsUsingTradeState(group);
    if (stateBackedRows.length > 0) {
      return stateBackedRows;
    }

    const container = findGroupContainer(group);
    if (!container) {
      return [];
    }

    const rows = new Map();
    const toggles = container.querySelectorAll('input[type="checkbox"], [role="checkbox"], [aria-checked]');

    toggles.forEach((toggle) => {
      if (!isChecked(toggle)) {
        return;
      }

      const row = findRowElement(toggle, container);
      if (!row) {
        return;
      }

      const rowData = extractRowData(row);
      if (!rowData) {
        return;
      }

      rows.set(rowData.text, rowData);
    });

    return Array.from(rows.values());
  }

  function extractSelectedModsFromTradeMarkup(group) {
    if (!group) {
      return [];
    }

    return Array.from(group.querySelectorAll('.filter-group-body .filter'))
      .filter((row) => !row.classList.contains('filter-padded'))
      .filter(isTradeFilterRowEnabled)
      .map(extractTradeFilterRowData)
      .filter(shouldIncludeRowData)
      .filter(Boolean);
  }

  function extractSelectedModsUsingTradeState(group) {
    if (!group) {
      return [];
    }

    const state = readTradeBootstrapState();
    if (!state || !Array.isArray(state.stats)) {
      return [];
    }

    const groupTitle = getTradeFilterGroupTitle(group).toLowerCase();
    const groupState = state.stats.find((entry) => String(entry.type).toLowerCase() === groupTitle);
    if (!groupState || !Array.isArray(groupState.filters)) {
      return [];
    }

    const enabledIndexes = groupState.filters
      .map((filter, index) => ({ filter, index }))
      .filter(({ filter }) => !filter.disabled)
      .map(({ index }) => index);

    if (enabledIndexes.length === 0) {
      return [];
    }

    const rows = Array.from(group.querySelectorAll('.filter-group-body .filter'))
      .filter((row) => !row.classList.contains('filter-padded'));

    return enabledIndexes
      .map((index) => rows[index])
      .map((row) => row ? extractTradeFilterRowData(row) : null)
      .filter(shouldIncludeRowData)
      .filter(Boolean);
  }

  function isTradeFilterGroupEnabled(group) {
    if (!group || group.classList.contains('disabled')) {
      return false;
    }

    const toggle = group.querySelector('.filter-group-header .toggle-btn');
    if (!toggle) {
      return true;
    }

    return !toggle.classList.contains('off');
  }

  function injectGlobalCopyButton() {
    const controlsRight = document.querySelector('.controls .controls-right');
    if (!controlsRight || controlsRight.querySelector(`:scope > .${GROUP_TOOLBAR_CLASS}`)) {
      return;
    }

    const toolbar = document.createElement('div');
    toolbar.className = GROUP_TOOLBAR_CLASS;

    const tools = document.createElement('div');
    tools.className = GROUP_TOOL_CLASS;
    tools.innerHTML = `<button type="button" class="btn clear-btn" data-action="copy"><span class="plus"></span><span>Regex</span></button>`;
    tools.querySelector('[data-action="copy"]').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      handleCopyAllFilters();
    });

    toolbar.appendChild(tools);
    controlsRight.insertBefore(toolbar, controlsRight.firstChild || null);
  }

  function injectResultButtons() {
    const directButtons = Array.from(document.querySelectorAll('.row .btns .direct-btn'));
    directButtons.forEach((directButton) => {
      const buttonGroup = directButton.parentElement;
      if (!buttonGroup || buttonGroup.querySelector(`.${RESULT_REGEX_BUTTON_CLASS}`)) {
        return;
      }

      const regexButton = document.createElement('button');
      regexButton.type = 'button';
      regexButton.className = `btn btn-xs btn-default ${RESULT_REGEX_BUTTON_CLASS}`;
      regexButton.title = 'Copy regex with price and travel to hideout';
      regexButton.textContent = 'Rx';
      regexButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleRowRegexCopyAndHideout(directButton);
      });

      if (directButton.nextSibling) {
        buttonGroup.insertBefore(regexButton, directButton.nextSibling);
      } else {
        buttonGroup.appendChild(regexButton);
      }
    });
  }

  async function handleCopyAllFilters() {
    const result = await generateCombinedRegex();
    if (!result.ok) {
      showToast('Copy failed', result.message, '', false);
      return;
    }

    if (!result.payload.regex) {
      showToast('Copy failed', 'No regex generated.', '', false);
      return;
    }

    copyText(result.payload.regex);
    showToast('Combined regex copied', result.payload.regex, buildResultMeta(result.payload), true);
  }

  async function handleRowRegexCopyAndHideout(directButton) {
    const row = directButton && directButton.closest('.row');
    if (!row) {
      showToast('Copy failed', 'Could not find the selected result row.', '', false);
      return;
    }

    const result = await generateCombinedRegex();
    if (!result.ok || !result.payload || !result.payload.regex) {
      showToast('Copy failed', result.message || 'No regex generated.', '', false);
      return;
    }

    const priceTerm = extractPriceRegexTermFromRow(row);
    const combinedRegex = [result.payload.regex, priceTerm].filter(Boolean).join(' ');

    copyText(combinedRegex);
    showToast(
      'Hideout regex copied',
      combinedRegex,
      [buildResultMeta(result.payload), priceTerm ? `Price term: ${priceTerm}` : ''].filter(Boolean).join('\n'),
      true
    );

    directButton.click();
  }

  function buildResultMeta(result) {
    return [
      `Matched with poe.re tokens: ${result.matched.length}`,
      `Fallback fragments: ${result.fallback.length}`,
      result.mapTerms && result.mapTerms.length ? `Map filter terms: ${result.mapTerms.length}` : '',
      result.unmatched.length ? `Unmatched mods:\n- ${result.unmatched.join('\n- ')}` : ''
    ].filter(Boolean).join('\n');
  }

  function getTradeFilterGroupTitle(group) {
    const title = group && group.querySelector('.filter-group-header .filter-title');
    return normalizeWhitespace(title && title.textContent);
  }

  async function generateCombinedRegex() {
    try {
      const tokenEntries = await loadTokenEntries();
      const negativeMods = collectGroupMods('Not');
      const positiveMods = collectTopLevelStatMods()
        .concat(collectGroupMods('And'))
        .concat(collectGroupMods('Count'))
        .concat(collectActiveSpecialPseudoMods());
      const statPayload = buildCombinedStatRegex(negativeMods, positiveMods, tokenEntries);
      const mapTerms = extractActiveMapFilterTerms();
      const itemPropertyTerms = extractItemPropertyTerms();

      const parts = []
        .concat(statPayload.parts)
        .concat(mapTerms)
        .concat(itemPropertyTerms);

      if (parts.length === 0) {
        return { ok: false, message: 'No active or filled filters found.' };
      }

      return {
        ok: true,
        payload: {
          regex: parts.join(' '),
          matched: statPayload.matched,
          fallback: statPayload.fallback,
          unmatched: statPayload.unmatched,
          mapTerms: mapTerms.concat(itemPropertyTerms)
        }
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  function collectGroupMods(title) {
    return findTradeFilterGroupsByTitle(title)
      .flatMap((group) => extractSelectedModsForGroup(group));
  }

  function collectTopLevelStatMods() {
    const statFiltersGroup = findTradeFilterGroupsByTitle('Stat Filters')[0];
    if (!statFiltersGroup || !isTradeFilterGroupEnabled(statFiltersGroup)) {
      return [];
    }

    const body = statFiltersGroup.querySelector(':scope > .filter-group-body');
    if (!body) {
      return [];
    }

    return Array.from(body.children)
      .filter((child) => child.classList && child.classList.contains('filter'))
      .filter((row) => !row.classList.contains('filter-padded'))
      .filter(isTradeFilterRowEnabled)
      .map(extractTradeFilterRowData)
      .filter(shouldIncludeRowData)
      .filter(Boolean);
  }

  function findTradeFilterGroupsByTitle(title) {
    return Array.from(document.querySelectorAll('.filter-group'))
      .filter((group) => getTradeFilterGroupTitle(group).toLowerCase() === String(title).toLowerCase());
  }

  function collectActiveSpecialPseudoMods() {
    const rows = Array.from(document.querySelectorAll('.filter-group-body .filter'))
      .filter(isTradeFilterRowEnabled)
      .map(extractTradeFilterRowData)
      .filter(Boolean)
      .filter((row) => {
        const normalized = normalizeLooseText(normalizeGeneralizedText(row.text));
        return Boolean(SPECIAL_PSEUDO_REGEX_BUILDERS[normalized]);
      });

    const unique = new Map();
    rows.forEach((row) => {
      unique.set(row.text, row);
    });
    return Array.from(unique.values());
  }

  function findGroupContainer(group) {
    if (group) {
      return group;
    }

    const candidates = Array.from(document.querySelectorAll('div, span, h1, h2, h3, h4, label'))
      .filter((element) => {
        const text = normalizeWhitespace(element.textContent);
        return ['Not', 'And', 'Count'].includes(text) && isVisible(element);
      });

    let best = null;
    let bestScore = -1;

    candidates.forEach((heading) => {
      let current = heading;
      for (let i = 0; i < 6 && current; i += 1) {
        const text = normalizeWhitespace(current.textContent).toLowerCase();
        const score =
          (text.includes('add stat filter') ? 6 : 0) +
          (text.includes('not') ? 2 : 0) +
          current.querySelectorAll('input[type="checkbox"], [role="checkbox"], [aria-checked]').length;

        if (score > bestScore) {
          best = current;
          bestScore = score;
        }

        current = current.parentElement;
      }
    });

    return best;
  }

  function isChecked(element) {
    if (element.matches('input[type="checkbox"]')) {
      return element.checked;
    }

    const ariaChecked = element.getAttribute('aria-checked');
    if (ariaChecked === 'true') {
      return true;
    }

    const className = `${element.className || ''}`.toLowerCase();
    return /checked|selected|active/.test(className);
  }

  function findRowElement(start, boundary) {
    let current = start;
    for (let i = 0; i < 8 && current && current !== boundary; i += 1) {
      const text = normalizeWhitespace(current.textContent);
      if (looksLikeStatRow(text)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function looksLikeStatRow(text) {
    if (!text) {
      return false;
    }

    if (/^\+?\s*add stat filter$/i.test(text)) {
      return false;
    }

    if (/^not$/i.test(text)) {
      return false;
    }

    if (text.length < 4) {
      return false;
    }

    if (/^(min|max|any)$/i.test(text)) {
      return false;
    }

    if (/players|monsters|monster|area|unique boss|buffs|rare monsters/i.test(text)) {
      return true;
    }

    return /[#%+]|resistance|damage|life|mana|energy shield|armour|evasion|ward|block|dexterity|strength|intelligence|critical|speed|charge|curse|regen|leech|projectile|aura|suppres|impale|poison|bleed|ailment|currency|scarabs|divination|pack size|quality \(|maps|influence/i.test(text);
  }

  function extractRowData(row) {
    let text = normalizeWhitespace(row.textContent);

    text = text.replace(/\bMIN\b.*$/i, '');
    text = text.replace(/\bMAX\b.*$/i, '');
    text = text.replace(/\bnot\b$/i, '');
    text = text.replace(/\+\s*add stat filter.*$/i, '');
    text = normalizeWhitespace(text);

    if (!looksLikeStatRow(text)) {
      return null;
    }

    return {
      text,
      ...extractRowBounds(row)
    };
  }

  function extractTradeFilterRowData(row) {
    const title = row.querySelector('.filter-body .filter-title');
    if (!title) {
      return null;
    }

    const cloned = title.cloneNode(true);
    const isPseudo = Boolean(cloned.querySelector('.mutate-type-pseudo'));
    cloned.querySelectorAll('.filter-tip, .mutate-type').forEach((node) => node.remove());

    const parts = Array.from(cloned.childNodes)
      .map((node) => normalizeWhitespace(node.textContent))
      .filter(Boolean);

    const selectionText = extractRowSelectionValue(row);
    const text = normalizeWhitespace([parts.join(' '), selectionText].filter(Boolean).join(' '));
    if (!looksLikeStatRow(text)) {
      return null;
    }

    return {
      text,
      isPseudo,
      ...extractRowBounds(row)
    };
  }

  function shouldIncludeRowData(rowData) {
    if (!rowData) {
      return false;
    }

    if (!rowData.isPseudo) {
      return true;
    }

    const normalized = normalizeLooseText(normalizeGeneralizedText(rowData.text));
    return Boolean(SPECIAL_PSEUDO_REGEX_BUILDERS[normalized] || SPECIAL_STATIC_REGEX_BUILDERS[normalized]);
  }

  function extractRowSelectionValue(row) {
    if (!row) {
      return '';
    }

    const multiselectValue = extractMultiselectValue(row);
    if (multiselectValue) {
      return multiselectValue;
    }

    const selectedNode = row.querySelector('.multiselect__single, .multiselect__tags-wrap');
    return normalizeWhitespace(selectedNode && selectedNode.textContent);
  }

  function extractMultiselectValue(container) {
    if (!container) {
      return '';
    }

    const directSelected = container.querySelector('.multiselect__single');
    const directSelectedText = normalizeWhitespace(directSelected && directSelected.textContent);
    if (directSelectedText) {
      return directSelectedText;
    }

    const selectedOption = container.querySelector('.multiselect__option--selected');
    if (selectedOption) {
      const optionText = normalizeWhitespace(selectedOption.textContent);
      if (optionText) {
        return optionText;
      }
    }

    const tagsWrap = container.querySelector('.multiselect__tags-wrap, .multiselect__tags');
    const tagsText = normalizeWhitespace(tagsWrap && tagsWrap.textContent);
    if (tagsText) {
      return tagsText;
    }

    const multiselectInput = container.querySelector('.multiselect input.multiselect__input, .multiselect input[type="text"]');
    if (!multiselectInput) {
      return '';
    }

    return normalizeWhitespace(
      multiselectInput.value
      || multiselectInput.getAttribute('value')
      || multiselectInput.getAttribute('placeholder')
    );
  }

  function extractRowBounds(row) {
    const inputs = row ? row.querySelectorAll('input.minmax, input[type="number"]') : [];
    const min = inputs[0] ? normalizeWhitespace(inputs[0].value || inputs[0].getAttribute('value')) : '';
    const max = inputs[1] ? normalizeWhitespace(inputs[1].value || inputs[1].getAttribute('value')) : '';

    return {
      min: min || null,
      max: max || null
    };
  }

  function isTradeFilterRowEnabled(row) {
    if (!row || row.classList.contains('disabled')) {
      return false;
    }

    const toggle = row.querySelector('.input-group-btn .toggle-btn');
    if (!toggle) {
      return true;
    }

    return !toggle.classList.contains('off');
  }

  function normalizeWhitespace(value) {
    return (value || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function readTradeBootstrapState() {
    const scripts = Array.from(document.scripts);
    for (const script of scripts) {
      const content = script.textContent || '';
      if (!content.includes('"stats"') || !content.includes('require(["trade"]')) {
        continue;
      }

      const state = extractJsonObject(content, '"state":');
      if (state) {
        return state;
      }
    }

    return null;
  }

  function extractJsonObject(content, marker) {
    const markerIndex = content.indexOf(marker);
    if (markerIndex === -1) {
      return null;
    }

    const startIndex = content.indexOf('{', markerIndex);
    if (startIndex === -1) {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = startIndex; index < content.length; index += 1) {
      const char = content[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(content.slice(startIndex, index + 1));
          } catch (_error) {
            return null;
          }
        }
      }
    }

    return null;
  }

  async function loadTokenEntries() {
    if (tokenCachePromise) {
      return tokenCachePromise;
    }

    tokenCachePromise = (async () => {
      const cached = readCachedTokens();
      if (cached) {
        return cached;
      }

      const response = await fetch(TOKEN_SOURCE_URL, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Token fetch failed with ${response.status}`);
      }

      const source = await response.text();
      const tokens = normalizeTokenEntries(parseTokenEntries(source));
      writeCachedTokens(tokens);
      return tokens;
    })();

    return tokenCachePromise;
  }

  function readCachedTokens() {
    try {
      const raw = localStorage.getItem(TOKEN_CACHE_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw);
      if (!parsed.timestamp || !Array.isArray(parsed.tokens)) {
        return null;
      }

      if ((Date.now() - parsed.timestamp) > TOKEN_CACHE_TTL_MS) {
        return null;
      }

      return normalizeTokenEntries(parsed.tokens);
    } catch (_error) {
      return null;
    }
  }

  function writeCachedTokens(tokens) {
    try {
      localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify({
        timestamp: Date.now(),
        tokens: normalizeTokenEntries(tokens)
      }));
    } catch (_error) {
      /* noop */
    }
  }

  function normalizeTokenEntries(entries) {
    if (!Array.isArray(entries)) {
      return [];
    }

    return entries
      .filter((entry) => entry && typeof entry.regex === 'string')
      .map((entry) => {
        const candidates = Array.isArray(entry.candidates)
          ? Array.from(new Set(entry.candidates.map(normalizeGeneralizedText).filter(Boolean)))
          : [];

        return {
          regex: entry.regex,
          nm: Boolean(entry.nm),
          candidates,
          candidateMeta: candidates.map((candidate) => ({
            text: candidate,
            loose: normalizeLooseText(candidate),
            words: tokenizeComparableText(candidate)
          }))
        };
      });
  }

  function parseTokenEntries(source) {
    const jsonEntries = parseJsonTokenEntries(source);
    if (jsonEntries) {
      return jsonEntries;
    }

    return parseTsTokenEntries(source);
  }

  function parseJsonTokenEntries(source) {
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (_error) {
      return null;
    }

    const tokens = parsed && Array.isArray(parsed.tokens) ? parsed.tokens : null;
    if (!tokens) {
      return null;
    }

    return tokens
      .filter((token) => token && typeof token.regex === 'string')
      .map((token) => buildTokenEntry(
        Number(token.id),
        token.regex,
        String(token.rawText || ''),
        String(token.generalizedText || ''),
        Boolean(token.options && token.options.nm)
      ))
      .filter(Boolean);
  }

  function buildTokenEntry(id, regexToken, rawText, generalizedText, nm) {
    const candidates = generalizedText
      .split('|')
      .map((part) => part.replace(/^\^/, '').replace(/\$$/, ''))
      .map(normalizeGeneralizedText)
      .concat(rawText.split('|').map(normalizeGeneralizedText))
      .filter(Boolean);

    const uniqueCandidates = Array.from(new Set(candidates));
    if (uniqueCandidates.length === 0) {
      return null;
    }

    return {
      id,
      regex: regexToken,
      nm,
      candidates: uniqueCandidates,
      candidateMeta: uniqueCandidates.map((candidate) => ({
        text: candidate,
        loose: normalizeLooseText(candidate),
        words: tokenizeComparableText(candidate)
      }))
    };
  }

  function parseTsTokenEntries(source) {
    const entries = [];
    const pattern = /\{id:\s*([-\d]+),\s*regex:\s*"((?:\\.|[^"])*)",\s*rawText:\s*"((?:\\.|[^"])*)",\s*generalizedText:\s*"((?:\\.|[^"])*)"(?:,\s*options:\s*\{([^}]*)\})?/g;
    let match;

    while ((match = pattern.exec(source)) !== null) {
      const optionsText = match[5] || '';
      const entry = buildTokenEntry(
        Number(match[1]),
        unescapeJs(match[2]),
        unescapeJs(match[3]),
        unescapeJs(match[4]),
        /\bnm:\s*true\b/.test(optionsText)
      );

      if (entry) {
        entries.push(entry);
      }
    }

    return entries;
  }

  function unescapeJs(value) {
    return value
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .replace(/\\'/g, "'");
  }

  function buildRegex(selectedMods, tokenEntries, mode) {
    const matched = [];
    const fallback = [];
    const unmatched = [];
    const fragments = [];
    const consumedIndexes = new Set();
    const reflectIndexes = findReflectSelectionIndexes(selectedMods);

    if (reflectIndexes.physical !== -1 && reflectIndexes.elemental !== -1) {
      const comboToken = findReflectComboToken(tokenEntries);
      if (comboToken) {
        const modText = `${PHYSICAL_REFLECT_TEXT} + ${ELEMENTAL_REFLECT_TEXT}`;
        matched.push({ modText, token: comboToken });
        fragments.push(comboToken.regex);
        consumedIndexes.add(reflectIndexes.physical);
        consumedIndexes.add(reflectIndexes.elemental);
      }
    }

    selectedMods.forEach((modEntry, index) => {
      if (consumedIndexes.has(index)) {
        return;
      }

      const modText = typeof modEntry === 'string' ? modEntry : modEntry && modEntry.text;
      if (!modText) {
        return;
      }

      const specialFragment = buildSpecialPseudoFragment(modEntry);
      if (specialFragment) {
        matched.push({ modText, token: { regex: specialFragment, special: true } });
        fragments.push(specialFragment);
        return;
      }

      const specialStaticFragment = buildSpecialStaticFragment(modEntry);
      if (specialStaticFragment) {
        matched.push({ modText, token: { regex: specialStaticFragment, special: true } });
        fragments.push(specialStaticFragment);
        return;
      }

      const generalized = normalizeGeneralizedText(modText);
      const token = isReflectGeneralized(generalized)
        ? findReflectSpecificToken(generalized, tokenEntries)
        : findTokenForMod(generalized, tokenEntries);

      if (token) {
        matched.push({ modText, token });
        fragments.push(token.regex);
        return;
      }

      const fragment = buildFallbackFragment(modText);
      if (fragment) {
        fallback.push({ modText, fragment });
        fragments.push(fragment);
      } else {
        unmatched.push(modText);
      }
    });

    const uniqueFragments = Array.from(new Set(fragments)).filter(Boolean);
    const joiner = uniqueFragments.join('|');
    const normalizedMode = mode || 'negative';
    return {
      regex: uniqueFragments.length ? formatRegex(joiner, normalizedMode) : '',
      matched,
      fallback,
      unmatched
    };
  }

  function buildSpecialPseudoFragment(modEntry) {
    const modText = typeof modEntry === 'string' ? modEntry : modEntry && modEntry.text;
    if (!modText) {
      return '';
    }

    const normalized = normalizeLooseText(normalizeGeneralizedText(modText));
    const builder = SPECIAL_PSEUDO_REGEX_BUILDERS[normalized];
    if (!builder) {
      return '';
    }

    const min = typeof modEntry === 'object' && modEntry ? modEntry.min : null;
    return builder(min);
  }

  function buildSpecialStaticFragment(modEntry) {
    const modText = typeof modEntry === 'string' ? modEntry : modEntry && modEntry.text;
    if (!modText) {
      return '';
    }

    const normalized = normalizeLooseText(normalizeGeneralizedText(modText));
    const builder = SPECIAL_STATIC_REGEX_BUILDERS[normalized];
    return builder ? builder() : '';
  }

  function buildValueRegex(value) {
    const normalizedValue = value == null || `${value}` === '' ? '1' : String(value);
    return generateNumberRegex(normalizedValue, false);
  }

  function findReflectSelectionIndexes(selectedMods) {
    let physical = -1;
    let elemental = -1;

    selectedMods.forEach((modEntry, index) => {
      const modText = typeof modEntry === 'string' ? modEntry : modEntry && modEntry.text;
      const generalized = normalizeGeneralizedText(modText);
      if (generalized === PHYSICAL_REFLECT_GENERALIZED && physical === -1) {
        physical = index;
      }
      if (generalized === ELEMENTAL_REFLECT_GENERALIZED && elemental === -1) {
        elemental = index;
      }
    });

    return { physical, elemental };
  }

  function isReflectGeneralized(generalized) {
    return generalized === PHYSICAL_REFLECT_GENERALIZED || generalized === ELEMENTAL_REFLECT_GENERALIZED;
  }

  function findReflectComboToken(tokenEntries) {
    return (Array.isArray(tokenEntries) ? tokenEntries : []).find((entry) =>
      entry
      && entry.nm
      && Array.isArray(entry.candidates)
      && entry.candidates.includes(PHYSICAL_REFLECT_GENERALIZED)
      && entry.candidates.includes(ELEMENTAL_REFLECT_GENERALIZED)
    ) || null;
  }

  function findReflectSpecificToken(generalized, tokenEntries) {
    const exactMatches = (Array.isArray(tokenEntries) ? tokenEntries : []).filter((entry) =>
      entry
      && Array.isArray(entry.candidates)
      && entry.candidates.includes(generalized)
    );

    const nonNightmareSingle = exactMatches.find((entry) => !entry.nm && entry.candidates.length === 1);
    if (nonNightmareSingle) {
      return nonNightmareSingle;
    }

    const nonNightmare = exactMatches.find((entry) => !entry.nm);
    if (nonNightmare) {
      return nonNightmare;
    }

    return exactMatches[0] || findTokenForMod(generalized, tokenEntries, { skipReflectSpecialCase: true });
  }

  function buildCombinedStatRegex(negativeMods, positiveMods, tokenEntries) {
    const negativePayload = buildRegex(negativeMods, tokenEntries, 'negative');
    const positivePayload = buildRegex(positiveMods, tokenEntries, 'positive');

    const parts = [];
    if (negativePayload.regex) {
      parts.push(negativePayload.regex);
    }
    if (positivePayload.regex) {
      parts.push(...splitPositiveTerms(positivePayload.regex));
    }

    return {
      parts,
      matched: negativePayload.matched.concat(positivePayload.matched),
      fallback: negativePayload.fallback.concat(positivePayload.fallback),
      unmatched: negativePayload.unmatched.concat(positivePayload.unmatched)
    };
  }

  function splitPositiveTerms(regexText) {
    const trimmed = (regexText || '').trim();
    if (!trimmed) {
      return [];
    }

    const unquoted = trimmed.replace(/^"|"$/g, '');
    return splitTopLevelRegexAlternatives(unquoted)
      .map((term) => term.trim())
      .filter(Boolean)
      .map((term) => `"${term}"`);
  }

  function splitTopLevelRegexAlternatives(value) {
    const parts = [];
    let current = '';
    let escapeNext = false;
    let parenDepth = 0;
    let classDepth = 0;

    for (const char of value) {
      if (escapeNext) {
        current += char;
        escapeNext = false;
        continue;
      }

      if (char === '\\') {
        current += char;
        escapeNext = true;
        continue;
      }

      if (char === '[') {
        classDepth += 1;
      } else if (char === ']' && classDepth > 0) {
        classDepth -= 1;
      } else if (char === '(' && classDepth === 0) {
        parenDepth += 1;
      } else if (char === ')' && classDepth === 0 && parenDepth > 0) {
        parenDepth -= 1;
      }

      if (char === '|' && classDepth === 0 && parenDepth === 0) {
        parts.push(current);
        current = '';
        continue;
      }

      current += char;
    }

    if (current) {
      parts.push(current);
    }

    return parts;
  }

  function formatRegex(joinedFragments, mode) {
    if (mode === 'positive') {
      return `"${joinedFragments}"`;
    }
    return `"!${joinedFragments}"`;
  }

  function extractActiveMapFilterTerms() {
    const entries = [];
    const domFilters = extractMapFilterValuesFromDom();

    addMapFilterTerm(entries, 'map_tier', domFilters.map_tier || readMapFilterValueFromState('map_tier'), (min) => `"tier ${generateMapTierRegex(min)}"`);
    addMapFilterTerm(entries, 'map_iiq', domFilters.map_iiq || readMapFilterValueFromState('map_iiq'), (min) => `"m q.*${generateNumberRegex(String(min), false)}%"`);
    addMapFilterTerm(entries, 'map_packsize', domFilters.map_packsize || readMapFilterValueFromState('map_packsize'), (min) => `"iz.*${generateNumberRegex(String(min), false)}%"`);
    addMapFilterTerm(entries, 'map_iir', domFilters.map_iir || readMapFilterValueFromState('map_iir'), (min) => `"m rar.*${generateNumberRegex(String(min), false)}%"`);
    return entries;
  }

  function generateMapTierRegex(value) {
    const tier = Number.parseInt(String(value), 10);
    if (!Number.isFinite(tier)) {
      return String(value || '').trim();
    }

    const minTier = Math.max(1, Math.min(16, tier));
    if (minTier >= 16) {
      return '16';
    }
    if (minTier >= 10) {
      return `1[${minTier - 10}-6]`;
    }
    if (minTier === 9) {
      return '(9|1[0-6])';
    }

    return `([${minTier}-9]|1[0-6])`;
  }

  function extractMapFilterValuesFromDom() {
    const group = Array.from(document.querySelectorAll('.filter-group'))
      .find((row) => ['map/chart filters', 'map filters'].includes(getTradeFilterGroupTitle(row).toLowerCase()));

    if (!group) {
      return {};
    }

    return {
      map_tier: readMapFilterRowValue(group, 'Map Tier'),
      map_iiq: readMapFilterRowValue(group, ['Increased Item Quantity', 'Map IIQ']),
      map_packsize: readMapFilterRowValue(group, ['Increased Packsize', 'Map Packsize']),
      map_iir: readMapFilterRowValue(group, ['Increased Item Rarity', 'Map IIR'])
    };
  }

  function readMapFilterRowValue(group, titles) {
    const normalizedTitles = (Array.isArray(titles) ? titles : [titles])
      .map((title) => String(title).toLowerCase());
    const row = Array.from(group.querySelectorAll('.filter-group-body .filter'))
      .find((filterRow) => {
        const titleNode = filterRow.querySelector('.filter-title');
        return normalizedTitles.includes(normalizeWhitespace(titleNode && titleNode.textContent).toLowerCase());
      });

    if (!row) {
      return null;
    }

    const inputs = row.querySelectorAll('input[type="number"], input.minmax');
    if (!inputs.length) {
      return null;
    }

    const min = normalizeWhitespace(inputs[0].value || inputs[0].getAttribute('value'));
    const max = inputs[1] ? normalizeWhitespace(inputs[1].value || inputs[1].getAttribute('value')) : '';

    if (!min && !max) {
      return null;
    }

    return {
      min: min || null,
      max: max || null
    };
  }

  function readMapFilterValueFromState(key) {
    const state = readTradeBootstrapState();
    const mapFilters = state && state.filters && state.filters.map_filters;
    if (!mapFilters || mapFilters.disabled || !mapFilters.filters) {
      return null;
    }

    return mapFilters.filters[key] || null;
  }

  function extractItemPropertyTerms() {
    return []
      .concat(extractItemRarityTerms())
      .concat(extractItemStateTerms());
  }

  function extractItemRarityTerms() {
    const text = readFilterSelectionValue('Item Rarity') || '';

    if (!text || text === 'any') {
      return [];
    }
    if (text.includes('any non-unique') || text.includes('any non unique')) {
      return ['"y: n|y: m|y: r"'];
    }
    if (text.includes('rare')) {
      return ['"y: r"'];
    }
    if (text.includes('magic')) {
      return ['"y: m"'];
    }
    if (text.includes('normal')) {
      return ['"y: n"'];
    }
    if (text.includes('unique (foil)') || text.includes('foil unique')) {
      return ['"y: f"'];
    }
    if (text.includes('unique')) {
      return ['"y: u"'];
    }
    return [];
  }

  function extractItemStateTerms() {
    return [
      extractBooleanPropertyTerm('Identified', {
        yes: '"!unidentified"',
        no: '"unidentified"'
      }),
      extractBooleanPropertyTerm('Mirrored', {
        yes: '"mirrored"',
        no: '"!mirrored"'
      }),
      extractBooleanPropertyTerm('Corrupted', {
        yes: '"corrupted"',
        no: '"!corrupted"'
      }),
      extractBooleanPropertyTerm('Split', {
        yes: '"split"',
        no: '"!split"'
      })
    ].filter(Boolean);
  }

  function extractBooleanPropertyTerm(title, values) {
    const text = readFilterSelectionValue(title) || '';
    if (!text || text === 'any') {
      return '';
    }

    if (text === 'yes') {
      return values.yes || '';
    }

    if (text === 'no') {
      return values.no || '';
    }

    return '';
  }

  function readFilterSelectionValue(title) {
    const row = findFilterRowByTitle(title);
    if (!row) {
      return '';
    }

    const multiselectValue = extractMultiselectValue(row);
    if (multiselectValue) {
      return multiselectValue.toLowerCase();
    }

    const selectedNode = row.querySelector('.multiselect__single, .multiselect__tags-wrap, .multiselect__tags');

    if (!selectedNode) {
      const body = row.querySelector('.filter-body');
      return normalizeWhitespace(body && body.textContent)
        .replace(new RegExp(`^${escapeRegex(title)}`, 'i'), '')
        .trim()
        .toLowerCase();
    }

    return normalizeWhitespace(
      selectedNode.value
      || selectedNode.getAttribute('value')
      || selectedNode.getAttribute('placeholder')
      || selectedNode.textContent
    )
      .replace(new RegExp(`^${escapeRegex(title)}`, 'i'), '')
      .trim()
      .toLowerCase();
  }

  function findFilterRowByTitle(title) {
    return Array.from(document.querySelectorAll('.filter'))
      .find((row) => {
        const titleNode = row.querySelector('.filter-title');
        return normalizeWhitespace(titleNode && titleNode.textContent).toLowerCase() === String(title).toLowerCase();
      }) || null;
  }

  function addMapFilterTerm(target, _key, filterValue, minFormatter) {
    if (!filterValue) {
      return;
    }

    if (filterValue.min != null && `${filterValue.min}` !== '') {
      const term = minFormatter(filterValue.min);
      if (term) {
        target.push(term);
      }
      return;
    }

    if (filterValue.max != null && `${filterValue.max}` !== '') {
      target.push(`"${filterValue.max}"`);
    }
  }

  function extractPriceRegexTermFromRow(row) {
    if (!row) {
      return '';
    }

    const noteNode = row.querySelector('.textCurrency.itemNote');
    const noteText = normalizeWhitespace(noteNode && noteNode.textContent).toLowerCase();
    if (noteText) {
      return buildExactPriceNoteRegex(noteText);
    }

    const amountNode = row.querySelector('.price [data-field="price"] > span:nth-of-type(2)');
    const currencyImage = row.querySelector('.price [data-field="price"] .currency-text img');
    const currencyTextNode = row.querySelector('.price [data-field="price"] .currency-text span');
    const amount = normalizeWhitespace(amountNode && amountNode.textContent);
    const currency = normalizeWhitespace(
      (currencyImage && (currencyImage.getAttribute('alt') || currencyImage.getAttribute('title')))
      || (currencyTextNode && currencyTextNode.textContent)
    ).toLowerCase();

    return buildExactVisiblePriceRegex(amount, currency);
  }

  function buildExactPriceNoteRegex(noteText) {
    const normalized = normalizeWhitespace(noteText).toLowerCase();
    if (!normalized) {
      return '';
    }

    return `"${escapeRegex(normalized).replace(/\\ /g, '\\s+')}"`;
  }

  function buildExactVisiblePriceRegex(amount, currency) {
    const normalizedAmount = normalizeWhitespace(amount);
    const normalizedCurrency = normalizePriceCurrency(currency);
    if (!normalizedAmount || !normalizedCurrency) {
      return '';
    }

    const amountPart = escapeRegex(normalizedAmount).replace(/\\ /g, '\\s+');
    const currencyPart = escapeRegex(normalizedCurrency).replace(/\\ /g, '\\s+');
    // The trade result renders prices as "3 × chaos", but stash item text uses
    // the note format "~price 3 chaos" (or "~b/o 3 chaos"). Match the text that
    // is actually searchable in the stash instead of the visual multiplication sign.
    return `"${amountPart}\\s+${currencyPart}"`;
  }

  function normalizePriceCurrency(currency) {
    const normalized = normalizeWhitespace(currency).toLowerCase();
    if (!normalized) {
      return '';
    }

    return normalized
      .replace(/\borb\b/g, '')
      .replace(/\bequivalent\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function generateNumberRegex(number, optimize) {
    const numbers = `${number}`.match(/\d/g);
    if (numbers === null) {
      return '';
    }
    const quant = optimize
      ? Math.floor(Number(numbers.join('')) / 10) * 10
      : Number(numbers.join(''));
    if (isNaN(quant) || quant === 0) {
      if (optimize && numbers.length === 1) {
        return '.';
      }
      return '';
    }
    if (quant >= 200) {
      const v = truncateLastDigit(truncateLastDigit(quant));
      return `[${v}-9]..`;
    }
    if (quant >= 150) {
      const str = quant.toString();
      const d0 = str[0];
      const d1 = str[1];
      const d2 = str[2];
      if (str[1] === '0' && str[2] === '0') {
        return `([2-9]..|${d0}..)`;
      } else if (str[2] === '0') {
        return `([2-9]..|1[${d1}-9].)`;
      } else if (str[1] === '0') {
        return `([1-9]0[${d2}-9]|[1-9][1-9].)`;
      } else if (str[1] === '9' && str[2] === '9') {
        return '([2-9]..|199)';
      } else {
        if (d1 === '9') {
          return `([2-9]..|19[${d2}-9])`;
        }
        return `[12]([${d1}-9][${d2}-9]|[${Number(d1) + 1}-9].)`;
      }
    }
    if (quant > 100) {
      const str = quant.toString();
      const d0 = str[0];
      const d1 = str[1];
      const d2 = str[2];
      if (str[1] === '0' && str[2] === '0') {
        return `${d0}..`;
      } else if (str[2] === '0') {
        return `(1[${d1}-9].|[2-9]..)`;
      } else if (str[1] === '0') {
        return `([1-9]0[${d2}-9]|[1-9][1-9].)`;
      } else if (str[1] === '9' && str[2] === '9') {
        return '(199|[2-9]..)';
      } else {
        if (d1 === '9') {
          return `19[${d2}-9]`;
        }
        return `(1([${d1}-9][${d2}-9]|[${Number(d1) + 1}-9].)|[2-9]..)`;
      }
    }
    if (quant === 100) {
      return '\\d..';
    }
    if (quant > 9) {
      const str = quant.toString();
      const d0 = str[0];
      const d1 = str[1];
      if (str[1] === '0') {
        return `([${d0}-9].|\\d..)`;
      } else if (str[0] === '9') {
        return `(${d0}[${d1}-9]|\\d..)`;
      } else {
        return `(${d0}[${d1}-9]|[${Number(d0) + 1}-9].|\\d..)`;
      }
    }
    if (quant <= 9) {
      return `([${quant}-9]|\\d..?)`;
    }
    return `${number}`;
  }

  function truncateLastDigit(n) {
    return Math.floor(n / 10);
  }

  function findTokenForMod(generalized, tokenEntries, options) {
    const settings = options || {};

    if (!settings.skipReflectSpecialCase && isReflectGeneralized(generalized)) {
      return findReflectSpecificToken(generalized, tokenEntries);
    }

    const exact = findPreferredTokenMatch(tokenEntries, (candidate) => candidate === generalized);
    if (exact) {
      return exact;
    }

    const looseGeneralized = normalizeLooseText(generalized);
    const loose = findPreferredTokenMatch(
      tokenEntries,
      (candidate) => normalizeLooseText(candidate) === looseGeneralized
    );
    if (loose) {
      return loose;
    }

    const generalizedWords = tokenizeComparableText(generalized);
    const scoredMatch = findBestScoredTokenMatch(generalized, looseGeneralized, generalizedWords, tokenEntries);
    if (scoredMatch) {
      return scoredMatch;
    }

    return tokenEntries.find((entry) => entry.candidates.some((candidate) => generalized.includes(candidate) || candidate.includes(generalized))) || null;
  }

  function findPreferredTokenMatch(tokenEntries, candidateMatches) {
    const matches = (Array.isArray(tokenEntries) ? tokenEntries : []).filter((entry) =>
      entry
      && Array.isArray(entry.candidates)
      && entry.candidates.some(candidateMatches)
    );

    return matches.find((entry) => !entry.nm && entry.candidates.length === 1)
      || matches.find((entry) => !entry.nm)
      || matches.find((entry) => entry.candidates.length === 1)
      || matches[0]
      || null;
  }

  function findBestScoredTokenMatch(generalized, looseGeneralized, generalizedWords, tokenEntries) {
    let best = null;

    (Array.isArray(tokenEntries) ? tokenEntries : []).forEach((entry) => {
      const candidateMeta = Array.isArray(entry && entry.candidateMeta)
        ? entry.candidateMeta
        : Array.isArray(entry && entry.candidates)
          ? entry.candidates.map((candidate) => ({
              text: candidate,
              loose: normalizeLooseText(candidate),
              words: tokenizeComparableText(candidate)
            }))
          : [];

      candidateMeta.forEach((candidate) => {
        const score = scoreTokenCandidate(generalized, looseGeneralized, generalizedWords, candidate);
        if (!best || score > best.score) {
          best = { entry, score };
        }
      });
    });

    return best && best.score >= 4 ? best.entry : null;
  }

  function scoreTokenCandidate(generalized, looseGeneralized, generalizedWords, candidate) {
    // Fuzzy matching is only for wording changes of the same modifier. Do not
    // let shared trailing terms (for example "attack and cast speed") map a
    // Monsters modifier to a Unique Boss modifier with different behaviour.
    if (generalizedWords[0] && candidate.words[0] && generalizedWords[0] !== candidate.words[0]) {
      return 0;
    }

    const commonWords = countCommonWords(generalizedWords, candidate.words);
    const maxWords = Math.max(generalizedWords.length, candidate.words.length, 1);
    const minWords = Math.max(Math.min(generalizedWords.length, candidate.words.length), 1);
    const coverage = commonWords / maxWords;
    const completeness = commonWords / minWords;

    let score = 0;
    if (commonWords >= 2) {
      score += commonWords * 2;
    }
    if (coverage >= 0.55) {
      score += 2;
    }
    if (completeness >= 0.75) {
      score += 2;
    }
    if (looseGeneralized.includes(candidate.loose) || candidate.loose.includes(looseGeneralized)) {
      score += 2;
    }
    if (generalizedWords[0] && generalizedWords[0] === candidate.words[0]) {
      score += 1;
    }
    return score;
  }

  function tokenizeComparableText(value) {
    return normalizeLooseText(value)
      .split(' ')
      .filter(Boolean)
      .filter((word) => word.length > 2)
      .filter((word) => !['have', 'has', 'with', 'from', 'more', 'less', 'your', 'gain', 'gains', 'them', 'their', 'that', 'this', 'added', 'chance'].includes(word));
  }

  function countCommonWords(wordsA, wordsB) {
    if (!wordsA.length || !wordsB.length) {
      return 0;
    }

    const setB = new Set(wordsB);
    let count = 0;
    wordsA.forEach((word) => {
      if (setB.has(word)) {
        count += 1;
      }
    });
    return count;
  }

  function normalizeGeneralizedText(value) {
    return (value || '')
      .toLowerCase()
      .replace(/[−–—]/g, '-')
      .replace(/\(\s*\d+\s*-\s*\d+\s*\)/g, '#')
      .replace(/[+-]?\d+(?:\.\d+)?/g, '#')
      .replace(/%/g, '%')
      .replace(/#%|%#/g, '#%')
      .replace(/[#%]+/g, (match) => (match.includes('#') ? '#%' : match))
      .replace(/[^a-z0-9#%' ,\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function buildFallbackFragment(modText) {
    const cleaned = modText
      .replace(/[+-]?\d+(?:\.\d+)?%?/g, '')
      .replace(/\bto\b/g, '')
      .replace(/\bof\b/g, '')
      .replace(/\ba\b/g, '')
      .replace(/\ban\b/g, '')
      .replace(/\bthe\b/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    if (!cleaned) {
      return '';
    }

    const words = cleaned
      .split(' ')
      .filter((word) => word.length >= 4)
      .slice(0, 4);

    if (words.length === 0) {
      return '';
    }

    return escapeRegex(words.join('.*'));
  }

  function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\.\*/g, '.*');
  }

  function normalizeLooseText(value) {
    return (value || '')
      .replace(/[#%'-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Seller ranking, for buying many items in few trades. A side tab opens a panel that lists
  // the sellers of the current search with the most listings first; "Travel" teleports
  // straight to that seller's hideout. Rows also get a "×N" badge. The counts
  // come from a second search without "Collapse listings by account", which would hide
  // exactly the extra listings, made once per search URL.
  function readSellerSettings() {
    const defaults = { enabled: true, open: false, minListings: 2 };
    try {
      return { ...defaults, ...JSON.parse(localStorage.getItem(SELLER_SETTINGS_KEY) || '{}') };
    } catch (_error) {
      return defaults;
    }
  }

  function saveSellerSettings(changes) {
    Object.assign(sellerSettings, changes);
    try {
      localStorage.setItem(SELLER_SETTINGS_KEY, JSON.stringify(sellerSettings));
    } catch (error) {
      showToast('Seller settings not saved', '', error.message, false);
    }
  }

  function watchSellerCounts() {
    ensureSellerPanel();
    const path = location.pathname;
    if (path !== sellerScanPath) {
      sellerScanPath = path;
      if (sellerSettings.enabled) {
        startSellerScan(path);
      }
    }
    renderSellerCounts();
  }

  async function startSellerScan(path) {
    const reusable = sellerScans.get(path);
    if (reusable && !reusable.error && Date.now() - reusable.startedAt < SELLER_SCAN_REUSE_MS) {
      setCurrentSellerScan(reusable);
      return;
    }

    const target = parseTradeSearchPath(path);
    if (!target) {
      return;
    }

    const scan = {
      path,
      target,
      query: null,
      sort: null,
      startedAt: Date.now(),
      status: '',
      done: false,
      error: false,
      sellers: null,
      scanned: 0,
      total: 0
    };

    let body = null;
    try {
      body = await decodeTradeSearchId(target.id);
    } catch (error) {
      body = null;
    }
    if (!body) {
      Object.assign(scan, { status: 'This search URL carries no readable query, so sellers cannot be counted.', done: true, error: true });
      setCurrentSellerScan(scan);
      return;
    }

    scan.query = JSON.parse(JSON.stringify(body.query || body));
    scan.sort = body.sort || { price: 'asc' };
    const tradeFilters = scan.query.filters && scan.query.filters.trade_filters && scan.query.filters.trade_filters.filters;
    if (tradeFilters && tradeFilters.account) {
      // A single seller's listings (opened from the panel): keep the ranking it came from.
      return;
    }
    if (tradeFilters) {
      delete tradeFilters.collapse;
    }

    if (sellerScanPath !== path) {
      return;
    }
    sellerScans.set(path, scan);
    setCurrentSellerScan(scan);
    scanSellerCounts(scan);
  }

  function setCurrentSellerScan(scan) {
    sellerScan = scan;
    renderSellerPanel();
    renderSellerCounts();
  }

  async function scanSellerCounts(scan) {
    const isCurrent = () => sellerScan === scan && sellerSettings.enabled;
    const update = (fields) => {
      Object.assign(scan, fields);
      if (sellerScan === scan) {
        renderSellerPanel();
        renderSellerCounts();
      }
    };

    try {
      // The page has just searched; wait so a quick run of searches costs one scan, not one each.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (!isCurrent()) {
        sellerScans.delete(scan.path);
        return;
      }

      const search = await tradeApiRequest(`/api/trade/search/${scan.target.realmLeague}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: scan.query, sort: scan.sort })
      });
      const ids = Array.isArray(search.result) ? search.result.slice(0, SELLER_SCAN_LIMIT) : [];
      const sellers = new Map();
      update({ sellers, searchId: search.id, total: search.total || ids.length, scanned: 0 });

      for (let index = 0; index < ids.length; index += SELLER_FETCH_BATCH) {
        if (!isCurrent()) {
          sellerScans.delete(scan.path);
          return;
        }

        const batch = ids.slice(index, index + SELLER_FETCH_BATCH);
        const fetched = await tradeApiRequest(`/api/trade/fetch/${batch.join(',')}?query=${encodeURIComponent(search.id)}`);
        (fetched.result || []).forEach((entry) => addSellerListing(sellers, entry));
        update({ scanned: Math.min(index + batch.length, ids.length) });
      }

      update({ done: true, status: describeSellerCoverage(scan) });
    } catch (error) {
      update({ status: `Seller counts failed: ${error.message}`, done: true, error: true });
    }
  }

  function addSellerListing(sellers, entry) {
    const listing = entry && entry.listing;
    const name = listing && listing.account && listing.account.name;
    if (!name) {
      return;
    }

    let seller = sellers.get(name);
    if (!seller) {
      seller = { name, count: 0, prices: new Map(), listings: [] };
      sellers.set(name, seller);
    }
    seller.count += 1;

    const price = listing.price;
    seller.listings.push({
      id: entry.id,
      token: listing.hideout_token || null,
      amount: price && typeof price.amount === 'number' ? price.amount : Infinity
    });

    if (price && typeof price.amount === 'number' && price.currency) {
      const entry = seller.prices.get(price.currency) || { count: 0, sum: 0, min: Infinity, max: -Infinity };
      entry.count += 1;
      entry.sum += price.amount;
      entry.min = Math.min(entry.min, price.amount);
      entry.max = Math.max(entry.max, price.amount);
      seller.prices.set(price.currency, entry);
    }
  }

  function describeSellerCoverage(scan) {
    if (scan.total > scan.scanned) {
      return `Counted the cheapest ${scan.scanned} of ${scan.total} listings. A lower max price covers more of the market.`;
    }
    return `Counted all ${scan.total} listings.`;
  }

  function rankedSellers(scan) {
    if (!scan || !scan.sellers) {
      return [];
    }

    return Array.from(scan.sellers.values())
      .filter((seller) => seller.count >= Math.max(1, Number(sellerSettings.minListings) || 1))
      .sort((a, b) => b.count - a.count || sellerSortPrice(a) - sellerSortPrice(b));
  }

  function sellerSortPrice(seller) {
    const cheapest = Array.from(seller.prices.values()).map((entry) => entry.min);
    return cheapest.length ? Math.min(...cheapest) : Infinity;
  }

  function formatSellerPrices(seller) {
    return Array.from(seller.prices.entries())
      .map(([currency, entry]) => {
        const range = entry.min === entry.max ? `${formatAmount(entry.min)}` : `${formatAmount(entry.min)}–${formatAmount(entry.max)}`;
        return `${range} ${currency} each · ${formatAmount(entry.sum)} ${currency} for ${entry.count}`;
      })
      .join(' | ') || 'no price';
  }

  function formatAmount(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function ensureSellerPanel() {
    if (document.getElementById(SELLER_PANEL_ID) || !document.body) {
      return;
    }

    const panel = document.createElement('div');
    panel.id = SELLER_PANEL_ID;
    panel.innerHTML = `
      <div class="tm-handle" title="Sellers with the most listings">Sellers <span class="tm-handle-count"></span></div>
      <div class="tm-body">
        <div class="tm-title">Sellers with the most listings</div>
        <label><input type="checkbox" class="tm-enabled"> Count sellers on every search</label>
        <label>Show sellers with at least <input type="number" class="tm-min" min="1" step="1"> listings</label>
        <div class="tm-panel-status"></div>
        <div class="tm-seller-list"></div>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('.tm-handle').addEventListener('click', () => {
      saveSellerSettings({ open: !sellerSettings.open });
      renderSellerPanel();
    });
    panel.querySelector('.tm-enabled').addEventListener('change', (event) => {
      saveSellerSettings({ enabled: event.target.checked });
      if (sellerSettings.enabled) {
        startSellerScan(location.pathname);
      } else {
        sellerScan = null;
      }
      renderSellerPanel();
      renderSellerCounts();
    });
    panel.querySelector('.tm-min').addEventListener('change', (event) => {
      saveSellerSettings({ minListings: Math.max(1, Math.floor(Number(event.target.value)) || 1) });
      renderSellerPanel();
      renderSellerCounts();
    });

    renderSellerPanel();
  }

  function renderSellerPanel() {
    const panel = document.getElementById(SELLER_PANEL_ID);
    if (!panel) {
      return;
    }

    const scan = sellerScan;
    const sellers = rankedSellers(scan);
    panel.classList.toggle('open', Boolean(sellerSettings.open));
    panel.querySelector('.tm-enabled').checked = Boolean(sellerSettings.enabled);
    const minInput = panel.querySelector('.tm-min');
    if (document.activeElement !== minInput) {
      minInput.value = String(sellerSettings.minListings);
    }
    panel.querySelector('.tm-handle-count').textContent = sellers.length ? String(sellers.length) : '';

    const status = panel.querySelector('.tm-panel-status');
    let text;
    if (!sellerSettings.enabled) {
      text = 'Off. Tick the box to count sellers on this search.';
    } else if (!scan) {
      text = 'Run a search to count its sellers.';
    } else if (!scan.done) {
      text = scan.sellers
        ? `Counting… ${scan.scanned}/${Math.min(scan.total, SELLER_SCAN_LIMIT)} listings`
        : 'Counting… waiting for the search to settle';
    } else {
      text = scan.status;
    }
    status.textContent = text;
    status.classList.toggle('tm-error', Boolean(scan && scan.error));

    const list = panel.querySelector('.tm-seller-list');
    list.textContent = '';
    if (!sellerSettings.enabled || !scan) {
      return;
    }
    if (scan.sellers && !sellers.length && scan.done && !scan.error) {
      list.textContent = `No seller has ${sellerSettings.minListings} or more of the counted listings.`;
      return;
    }

    sellers.forEach((seller) => {
      const row = document.createElement('div');
      row.className = 'tm-seller';

      const count = document.createElement('div');
      count.className = 'tm-seller-count';
      count.textContent = `×${seller.count}`;

      const main = document.createElement('div');
      main.className = 'tm-seller-main';
      const name = document.createElement('div');
      name.className = 'tm-seller-name';
      name.textContent = seller.name;
      name.title = seller.name;
      const price = document.createElement('div');
      price.className = 'tm-seller-price';
      price.textContent = formatSellerPrices(seller);
      main.append(name, price);

      const travel = document.createElement('button');
      travel.type = 'button';
      travel.className = 'btn btn-xs btn-default';
      travel.textContent = 'Travel';
      travel.title = 'Teleport to this seller\'s hideout';
      travel.addEventListener('click', () => travelToSeller(scan, seller, travel));

      row.append(count, main, travel);
      list.appendChild(row);
    });
  }

  // Teleports to the seller's hideout the way the site's "Travel to Hideout" button does
  // (POST /api/trade/whisper with a listing's hideout token). An "in demand" answer carries a
  // "continue" value; it is sent straight back, so in-demand listings teleport without asking.
  async function travelToSeller(scan, seller, button) {
    button.disabled = true;
    button.textContent = '…';
    try {
      const listings = await freshSellerListings(scan, seller);
      if (!listings.length) {
        throw new Error('none of this seller\'s counted listings can be travelled to any more (sold or delisted)');
      }

      let lastError = null;
      for (const listing of listings) {
        try {
          let reply = await sendTradeWhisper({ token: listing.token });
          if (!reply.success && reply.continue) {
            reply = await sendTradeWhisper({ token: listing.token, continue: reply.continue });
          }
          if (reply.success) {
            button.textContent = 'Teleporting!';
            showToast('Teleporting', '', `To ${seller.name}'s hideout.`, false);
            setTimeout(() => {
              button.disabled = false;
              button.textContent = 'Travel';
            }, 5000);
            return;
          }
          lastError = new Error('the trade site did not confirm the teleport');
        } catch (error) {
          // Code 1: this listing's token is no longer valid; another of the seller's may be.
          lastError = error;
          if (error.code !== 1) {
            break;
          }
        }
      }
      throw lastError;
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Travel';
      showToast('Travel failed', '', `${seller.name}: ${error.message}`, false);
    }
  }

  // The seller's listings with a hideout token that is still valid, cheapest first. Tokens
  // expire (the site greys its own button out with "Item must be refreshed"), so expired ones
  // are fetched again; a listing that comes back without a token has gone.
  async function freshSellerListings(scan, seller) {
    const valid = (listing) => listing.token && hideoutTokenExpiry(listing.token) > Date.now() + 15000;
    // One teleport needs one valid token, so refreshing the cheapest ten stale listings is enough.
    const stale = seller.listings
      .filter((listing) => !valid(listing))
      .sort((a, b) => a.amount - b.amount)
      .slice(0, SELLER_FETCH_BATCH)
      .map((listing) => listing.id);
    if (stale.length) {
      const fetched = await tradeApiRequest(`/api/trade/fetch/${stale.join(',')}?query=${encodeURIComponent(scan.searchId)}`);
      (fetched.result || []).forEach((entry) => {
        const listing = entry && seller.listings.find((candidate) => candidate.id === entry.id);
        if (listing) {
          listing.token = (entry.listing && entry.listing.hideout_token) || null;
        }
      });
    }

    return seller.listings.filter(valid).sort((a, b) => a.amount - b.amount);
  }

  function hideoutTokenExpiry(token) {
    try {
      const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return (JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))).exp || 0) * 1000;
    } catch (_error) {
      return 0;
    }
  }

  async function sendTradeWhisper(body) {
    // Without the header jQuery adds to the site's own request, the endpoint answers 403 Forbidden.
    const response = await fetch('/api/trade/whisper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (data.error || !response.ok) {
      const error = new Error((data.error && data.error.message) || `HTTP ${response.status}`);
      error.code = data.error && data.error.code;
      throw error;
    }
    return data;
  }

  function parseTradeSearchPath(path) {
    // /trade/search/<League>/<id>, or /trade/search/<realm>/<League>/<id> on console realms.
    const parts = path.split('/').filter(Boolean);
    if (parts[parts.length - 1] === 'live') {
      parts.pop();
    }
    if (parts[0] !== 'trade' || parts[1] !== 'search' || parts.length < 4) {
      return null;
    }

    return {
      realmLeague: parts.slice(2, -1).map(encodeURIComponent).join('/'),
      id: parts[parts.length - 1]
    };
  }

  // The site encodes the whole query in the URL as base64url-encoded gzip JSON ("H4sI…").
  async function decodeTradeSearchId(id) {
    if (!id.startsWith('H4sI')) {
      return null;
    }

    const base64 = id.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (char) => char.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }

  // Earliest time for the next request, per API policy (search and fetch are limited apart).
  const tradeApiNextAt = { search: 0, fetch: 0 };

  // The scan keeps every rate-limit window under half full: a rule that is still under half
  // allows a request a second, one at half or more drops to half its sustained rate. The rest
  // of the budget stays with the page itself (searching, loading rows, travelling to hideouts).
  async function tradeApiRequest(url, options) {
    const policy = url.startsWith('/api/trade/search/') ? 'search' : 'fetch';
    const wait = tradeApiNextAt[policy] - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

    const response = await fetch(url, options);
    let interval = 1000;
    response.headers.forEach((value, name) => {
      if (!/^x-rate-limit-(?!rules$|policy$)[a-z]+$/i.test(name)) {
        return;
      }

      const states = (response.headers.get(`${name}-state`) || '').split(',');
      value.split(',').forEach((rule, index) => {
        const [hits, period] = rule.split(':').map(Number);
        const used = Number((states[index] || '').split(':')[0]) || 0;
        if (hits > 0 && period > 0 && used + 1 >= hits / 2) {
          interval = Math.max(interval, (period * 1000 * 2) / hits);
        }
      });
    });
    tradeApiNextAt[policy] = Date.now() + interval;

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      throw new Error(`rate limited by the trade site${retryAfter ? `, retry in ${retryAfter}s` : ''}`);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      throw new Error((data.error && data.error.message) || `HTTP ${response.status}`);
    }

    return data;
  }

  function renderSellerCounts() {
    const scan = sellerSettings.enabled ? sellerScan : null;
    const header = document.querySelector('.results .row-total');
    if (header) {
      let status = header.querySelector(`.${SELLER_STATUS_CLASS}`);
      let text = '';
      if (scan) {
        if (!scan.done) {
          text = `Counting sellers… ${scan.scanned}${scan.sellers ? `/${Math.min(scan.total, SELLER_SCAN_LIMIT)}` : ''}`;
        } else if (scan.error) {
          text = scan.status;
        } else {
          const ranked = rankedSellers(scan).length;
          text = `${ranked} seller${ranked === 1 ? '' : 's'} with ${sellerSettings.minListings}+ listings (Sellers tab)`;
        }
      }
      if (!status && text) {
        status = document.createElement('span');
        status.className = SELLER_STATUS_CLASS;
        header.appendChild(status);
      }
      if (status) {
        if (status.textContent !== text) {
          status.textContent = text;
        }
        status.classList.toggle('tm-error', Boolean(scan && scan.error));
      }
    }

    const sellers = scan && scan.sellers;
    const minListings = Math.max(2, Number(sellerSettings.minListings) || 2);
    document.querySelectorAll('.resultset .row[data-id]').forEach((row) => {
      const link = row.querySelector('.info .profile-link a');
      if (!link) {
        return;
      }

      const seller = sellers ? sellers.get(link.textContent.trim()) : null;
      const count = seller ? seller.count : 0;
      let badge = link.parentElement.querySelector(`.${SELLER_BADGE_CLASS}`);
      if (count < minListings) {
        if (badge) {
          badge.remove();
        }
        return;
      }

      const text = `×${count}`;
      if (!badge) {
        badge = document.createElement('span');
        badge.className = SELLER_BADGE_CLASS;
        link.after(badge);
      }
      if (badge.textContent !== text) {
        badge.textContent = text;
        badge.title = `This seller has ${count} of the ${scan.scanned} counted listings for this search (${scan.total} matched in total).`;
      }
    });
  }

  let toastTimer = null;

  function showToast(title, regexText, metaText, copied) {
    ensureToast();
    const toast = document.getElementById(TOAST_ID);
    if (!toast) {
      return;
    }

    toast.querySelector('.tm-title').textContent = title || 'Regex Copied';
    toast.querySelector('.tm-status').textContent = copied ? 'Copied to clipboard.' : '';
    toast.querySelector('.tm-regex').textContent = regexText || '';
    toast.querySelector('.tm-meta').textContent = metaText || '';
    toast.classList.add('visible');

    if (toastTimer) {
      clearTimeout(toastTimer);
    }

    toastTimer = setTimeout(() => {
      toast.classList.remove('visible');
    }, 4500);
  }

  init();
})();
