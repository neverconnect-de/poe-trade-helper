// ==UserScript==
// @name         PoE Trade Helper
// @namespace    https://neverconnect.de/
// @version      0.9.0
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
  const TOKEN_SOURCE_URL = 'https://raw.githubusercontent.com/veiset/poe-vendor-string/master/src/generated/mapmods/Generated.MapModsV3.ENGLISH.ts';
  const TOKEN_CACHE_KEY = 'tm-poe-trade-not-regex-cache-v1';
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

  let tokenCachePromise = null;

  function init() {
    injectStyles();
    ensureToast();
    injectGlobalCopyButton();
    injectResultButtons();
    observeDom();
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
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
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
    const entries = [];
    const pattern = /\{id:\s*([-\d]+),\s*regex:\s*"((?:\\.|[^"])*)",\s*rawText:\s*"((?:\\.|[^"])*)",\s*generalizedText:\s*"((?:\\.|[^"])*)"(?:,\s*options:\s*\{([^}]*)\})?/g;
    let match;

    while ((match = pattern.exec(source)) !== null) {
      const regexToken = unescapeJs(match[2]);
      const rawText = unescapeJs(match[3]);
      const generalizedText = unescapeJs(match[4]);
      const optionsText = match[5] || '';
      const nm = /\bnm:\s*true\b/.test(optionsText);
      const candidates = generalizedText
        .split('|')
        .map((part) => part.replace(/^\^/, '').replace(/\$$/, ''))
        .map(normalizeGeneralizedText)
        .concat(rawText.split('|').map(normalizeGeneralizedText))
        .filter(Boolean);

      const uniqueCandidates = Array.from(new Set(candidates));

      if (uniqueCandidates.length > 0) {
        entries.push({
          id: Number(match[1]),
          regex: regexToken,
          nm,
          candidates: uniqueCandidates,
          candidateMeta: uniqueCandidates.map((candidate) => ({
            text: candidate,
            loose: normalizeLooseText(candidate),
            words: tokenizeComparableText(candidate)
          }))
        });
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
      .find((row) => getTradeFilterGroupTitle(row).toLowerCase() === 'map filters');

    if (!group) {
      return {};
    }

    return {
      map_tier: readMapFilterRowValue(group, 'Map Tier'),
      map_iiq: readMapFilterRowValue(group, 'Map IIQ'),
      map_packsize: readMapFilterRowValue(group, 'Map Packsize'),
      map_iir: readMapFilterRowValue(group, 'Map IIR')
    };
  }

  function readMapFilterRowValue(group, title) {
    const row = Array.from(group.querySelectorAll('.filter-group-body .filter'))
      .find((filterRow) => {
        const titleNode = filterRow.querySelector('.filter-title');
        return normalizeWhitespace(titleNode && titleNode.textContent).toLowerCase() === String(title).toLowerCase();
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
    return `"${amountPart}\\s*[x×]\\s*${currencyPart}"`;
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

    const exact = tokenEntries.find((entry) => entry.candidates.includes(generalized));
    if (exact) {
      return exact;
    }

    const looseGeneralized = normalizeLooseText(generalized);
    const loose = tokenEntries.find((entry) => entry.candidates.some((candidate) => normalizeLooseText(candidate) === looseGeneralized));
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
