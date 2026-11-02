/*
 * content.js — isolated world
 * Loads the saved settings, injects the caption stylesheet, hands the settings
 * to player.js (which runs in YouTube's own JS context), and answers probe
 * requests from the popup ("what can this video actually do?").
 */
(() => {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    lockQuality: true,
    quality: 'hd1080',
    captionsMode: 'keep',
    captionLang: '',
    captionStyle: {
      enabled: true,
      font: 'default',
      scale: 100,
      bold: false,
      italic: false,
      underline: false,
      color: '#ffffff',
      fontOpacity: 100,
      bgColor: '#080808',
      bgOpacity: 75,
      windowColor: '#080808',
      windowOpacity: 0,
      edge: 'shadow'
    }
  };

  const FONTS = {
    default: '"YouTube Sans", "Roboto", "Arial", sans-serif',
    sans: 'Arial, Helvetica, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: 'Consolas, Menlo, monospace',
    rounded: '"Trebuchet MS", Verdana, sans-serif',
    condensed: '"Arial Narrow", "Segoe UI", sans-serif'
  };

  const EDGES = {
    shadow: '0 0.06em 0.16em rgba(0,0,0,.95), 0 0 0.35em rgba(0,0,0,.65)',
    outline:
      '-0.07em 0 0 #000, 0.07em 0 0 #000, 0 -0.07em 0 #000, 0 0.07em 0 #000, ' +
      '-0.07em -0.07em 0 #000, 0.07em 0.07em 0 #000, -0.07em 0.07em 0 #000, 0.07em -0.07em 0 #000',
    raised: '0.08em 0.08em 0.03em rgba(0,0,0,.9)',
    none: 'none'
  };

  function deepMerge(base, extra) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!extra || typeof extra !== 'object') return out;
    for (const key of Object.keys(extra)) {
      const val = extra[key];
      if (val === undefined) continue;
      if (val && typeof val === 'object' && !Array.isArray(val) && base[key] && typeof base[key] === 'object') {
        out[key] = deepMerge(base[key], val);
      } else {
        out[key] = val;
      }
    }
    return out;
  }

  function hexToRgba(hex, opacity) {
    let h = String(hex || '#000000').replace('#', '').trim();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(h)) h = '000000';
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const n = Number(opacity);
    const a = Math.min(100, Math.max(0, Number.isFinite(n) ? n : 0)) / 100;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  /*
   * The stylesheet is regenerated with literal values on every refresh — no
   * CSS custom properties at all, so a missing variable can never silently
   * fall back to YouTube's own styling.
   */
  function buildCss(active, cs) {
    if (!active) return '';

    const font = FONTS[cs.font] || FONTS.default;
    const weight = cs.bold ? '700' : '400';
    const style = cs.italic ? 'italic' : 'normal';
    const deco = cs.underline ? 'underline' : 'none';
    const zoom = String(Math.min(2.5, Math.max(0.6, (Number(cs.scale) || 100) / 100)));
    const shadow = EDGES[cs.edge] || EDGES.shadow;
    const noBg = Number(cs.bgOpacity) <= 0;
    const bg = noBg ? 'transparent' : hexToRgba(cs.bgColor, cs.bgOpacity);
    const pad = noBg ? '0 0.12em' : '0.06em 0.22em';
    const color = hexToRgba(cs.color, cs.fontOpacity == null ? 100 : cs.fontOpacity);
    const win = hexToRgba(cs.windowColor, cs.windowOpacity == null ? 0 : cs.windowOpacity);

    return `
html.yql-style .ytp-caption-segment {
  color: ${color} !important;
  background-color: ${bg} !important;
  background-image: none !important;
  font-family: ${font} !important;
  font-weight: ${weight} !important;
  font-style: ${style} !important;
  text-decoration: ${deco} !important;
  zoom: ${zoom} !important;
  text-shadow: ${shadow} !important;
  letter-spacing: normal !important;
  word-spacing: normal !important;
  line-height: 1.28 !important;
  padding: ${pad} !important;
  border-radius: 0.14em !important;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
html.yql-style .caption-window,
html.yql-style .ytp-caption-window-container {
  text-shadow: none !important;
  background-color: ${win} !important;
  background-image: none !important;
  border-radius: 0.14em !important;
}`;
  }

  function styleEl() {
    let el = document.getElementById('yql-style');
    if (!el) {
      el = document.createElement('style');
      el.id = 'yql-style';
      (document.head || document.documentElement).appendChild(el);
    }
    return el;
  }

  function applyStyle(settings) {
    const cs = settings.captionStyle || DEFAULTS.captionStyle;
    const active = !!settings.enabled && !!cs.enabled;
    document.documentElement.classList.toggle('yql-style', active);
    styleEl().textContent = buildCss(active, cs);
  }

  function broadcast(settings) {
    try {
      window.postMessage({ source: 'yql-ext', type: 'settings', settings }, location.origin);
    } catch (err) {
      /* ignore */
    }
  }

  function normalize(stored) {
    const settings = deepMerge(DEFAULTS, stored || {});
    const cs = settings.captionStyle;
    // migrate the old boolean `shadow` field to the `edge` selector
    if (cs.edge === undefined) cs.edge = cs.shadow === false ? 'none' : 'shadow';
    if (!EDGES[cs.edge]) cs.edge = 'shadow';
    return settings;
  }

  async function readLayer(area) {
    try {
      return (await chrome.storage[area].get(null)) || {};
    } catch (err) {
      // Firefox's storage.sync rejects when the user is not signed in to a
      // Firefox Sync account — fall through and let storage.local answer.
      return {};
    }
  }

  async function readSettings() {
    // storage.local is always available; storage.sync only works with an
    // active Sync account. Merge both, letting sync (when reachable) win so
    // two devices stay in step.
    let stored = await readLayer('local');
    const synced = await readLayer('sync');
    if (synced.captionStyle !== undefined || synced.quality !== undefined) {
      stored = deepMerge(stored, synced);
    }
    return normalize(stored);
  }

  /* ---------- probe: report what this video actually offers ---------- */

  function probePage() {
    return new Promise((resolve) => {
      let done = false;
      const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

      const onMessage = (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== 'yql-page' || data.type !== 'probe-result' || data.id !== id) return;
        done = true;
        window.removeEventListener('message', onMessage);
        resolve(data.data || null);
      };

      window.addEventListener('message', onMessage);
      try {
        window.postMessage({ source: 'yql-ext', type: 'probe', id }, location.origin);
      } catch (err) {
        /* ignore */
      }

      setTimeout(() => {
        if (done) return;
        window.removeEventListener('message', onMessage);
        resolve(null);
      }, 1500);
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'yql:settings' && msg.settings) {
      // live push from the popup — applies instantly, whatever the storage
      // backends happen to be doing
      current = normalize(msg.settings);
      applyStyle(current);
      broadcast(current);
    }
    if (!msg || msg.type !== 'yql:probe') return undefined;
    probePage().then((data) => sendResponse({ ok: !!data, data }));
    return true; // async response
  });

  /* ---------- wiring ---------- */

  let current = normalize({});

  async function refresh() {
    current = await readSettings();
    applyStyle(current);
    broadcast(current);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' || area === 'local') refresh();
  });

  // player.js asks for settings once it is up (and on every navigation).
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'yql-page' || data.type !== 'hello') return;
    broadcast(current);
  });

  window.addEventListener('yt-navigate-finish', () => broadcast(current));
  window.addEventListener('pageshow', () => broadcast(current));

  refresh();
})();
