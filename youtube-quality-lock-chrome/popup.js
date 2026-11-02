/*
 * popup.js — settings UI.
 * Everything lives in chrome.storage.sync; content.js watches storage and
 * pushes changes to the player. If the active tab is a YouTube page, the
 * popup asks it what this specific video offers, so the pickers show the
 * real quality levels and the real subtitle tracks instead of a fixed list.
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

  // Fallback list, used when no YouTube tab is reachable.
  const STATIC_LEVELS = [
    { id: 'highres', label: '4320p (8K)' },
    { id: 'hd2160', label: '2160p (4K)' },
    { id: 'hd1440', label: '1440p' },
    { id: 'hd1080', label: '1080p' },
    { id: 'hd720', label: '720p' },
    { id: 'large', label: '480p' },
    { id: 'medium', label: '360p' },
    { id: 'small', label: '240p' },
    { id: 'tiny', label: '144p' }
  ];

  const $ = (id) => document.getElementById(id);

  let state = clone(DEFAULTS);
  let saveTimer = 0;
  let statusTimer = 0;
  let note = '';
  let tab = null;
  let probe = null;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function deepMerge(base, extra) {
    const out = clone(base);
    if (!extra || typeof extra !== 'object') return out;
    for (const key of Object.keys(extra)) {
      const val = extra[key];
      if (val === undefined) continue;
      if (val && typeof val === 'object' && !Array.isArray(val) && out[key] && typeof out[key] === 'object') {
        out[key] = deepMerge(out[key], val);
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

  function labelFor(id) {
    const known = STATIC_LEVELS.find((l) => l.id === id);
    if (known) return known.label;
    if (!id) return '';
    const m = /^(\d+)p/.exec(String(id));
    return m ? `${m[1]}p` : String(id);
  }

  function isYouTube(url) {
    return !!url && /^https?:\/\/([^/]+\.)?youtube\.com(\/|$)/i.test(url);
  }

  /* ---------- pickers fed by the live video ---------- */

  function fillQuality() {
    const sel = $('quality');
    const levels = probe && probe.levels && probe.levels.length ? probe.levels : STATIC_LEVELS;
    const keep = state.quality || 'hd1080';

    sel.textContent = '';
    for (const level of levels) {
      sel.add(new Option(level.label, level.id));
    }
    if (!levels.some((l) => l.id === keep) && keep !== 'auto') {
      sel.add(new Option(`${labelFor(keep)} — saved, not on this video`, keep));
    }
    sel.add(new Option('Auto (do not lock)', 'auto'));
    sel.value = keep;

    const qualityNote = $('qualityNote');
    if (!probe) {
      qualityNote.textContent = '';
      return;
    }
    const currentLabel = probe.current ? labelFor(probe.current) : '';
    qualityNote.textContent = currentLabel
      ? `This video is playing ${currentLabel} right now.`
      : '';
  }

  function fillLanguages() {
    const sel = $('captionLang');
    const keep = state.captionLang || '';
    const tracks = (probe && probe.captionTracks) || [];

    sel.textContent = '';
    sel.add(new Option("Don't change", ''));

    if (tracks.length) {
      for (const track of tracks) {
        const suffix = track.kind === 'asr' ? ' (auto)' : '';
        sel.add(new Option(`${track.name}${suffix}`, track.code));
      }
      if (keep && !tracks.some((t) => t.code === keep)) {
        sel.add(new Option(`${keep} — saved, not on this video`, keep));
      }
    } else {
      // No probe: offer the common list, keeping whatever is already saved.
      for (const [code, name] of COMMON_LANGS) sel.add(new Option(name, code));
      if (keep && !COMMON_LANGS.some(([code]) => code === keep)) {
        sel.add(new Option(`${keep} — saved`, keep));
      }
    }
    sel.value = keep;

    const langNote = $('langNote');
    if (!probe) {
      langNote.textContent = '';
    } else if (tracks.length) {
      langNote.textContent = `This video has ${tracks.length} subtitle track${tracks.length === 1 ? '' : 's'}.`;
    } else {
      langNote.textContent = 'This video has no subtitle tracks.';
    }
  }

  const COMMON_LANGS = [
    ['en', 'English'],
    ['en-US', 'English (US)'],
    ['en-GB', 'English (UK)'],
    ['es', 'Spanish'],
    ['fr', 'French'],
    ['de', 'German'],
    ['it', 'Italian'],
    ['pt', 'Portuguese'],
    ['pt-BR', 'Portuguese (Brazil)'],
    ['nl', 'Dutch'],
    ['pl', 'Polish'],
    ['ru', 'Russian'],
    ['uk', 'Ukrainian'],
    ['tr', 'Turkish'],
    ['ar', 'Arabic'],
    ['he', 'Hebrew'],
    ['fa', 'Persian'],
    ['hi', 'Hindi'],
    ['ur', 'Urdu'],
    ['ja', 'Japanese'],
    ['ko', 'Korean'],
    ['zh-Hans', 'Chinese (Simplified)'],
    ['zh-Hant', 'Chinese (Traditional)'],
    ['id', 'Indonesian'],
    ['vi', 'Vietnamese'],
    ['th', 'Thai'],
    ['sv', 'Swedish']
  ];

  /* ---------- rendering ---------- */

  function render() {
    const cs = state.captionStyle;

    $('enabled').checked = !!state.enabled;
    $('lockQuality').checked = !!state.lockQuality;
    $('quality').value = state.quality;

    document.querySelectorAll('#captionsMode button').forEach((btn) => {
      const active = btn.dataset.value === state.captionsMode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $('captionLang').value = state.captionLang || '';

    $('styleEnabled').checked = !!cs.enabled;
    $('font').value = FONTS[cs.font] ? cs.font : 'default';
    $('scale').value = cs.scale;
    $('edge').value = EDGES[cs.edge] ? cs.edge : 'shadow';
    $('color').value = cs.color;
    $('bgColor').value = cs.bgColor;
    $('fontOpacity').value = cs.fontOpacity;
    $('bgOpacity').value = cs.bgOpacity;
    $('windowColor').value = cs.windowColor;
    $('windowOpacity').value = cs.windowOpacity;
    $('bold').checked = !!cs.bold;
    $('italic').checked = !!cs.italic;
    $('underline').checked = !!cs.underline;

    $('scaleOut').textContent = cs.scale + '%';
    $('fontOut').textContent = cs.fontOpacity + '%';
    $('bgOut').textContent = cs.bgOpacity + '%';
    $('windowOut').textContent = cs.windowOpacity + '%';
    document.querySelector('.style-section').classList.toggle('muted', !cs.enabled);

    updatePreview();
  }

  function updatePreview() {
    const cs = state.captionStyle;
    const box = $('preview');
    const active = !!state.enabled && !!cs.enabled;

    box.classList.toggle('off', !active);
    box.style.setProperty('--p-color', hexToRgba(cs.color, cs.fontOpacity == null ? 100 : cs.fontOpacity));
    box.style.setProperty('--p-bg', hexToRgba(cs.bgColor, cs.bgOpacity));
    box.style.setProperty('--p-window', hexToRgba(cs.windowColor, cs.windowOpacity));
    box.style.setProperty('--p-font', FONTS[cs.font] || FONTS.default);
    box.style.setProperty('--p-size', ((13 * Number(cs.scale)) / 100).toFixed(1) + 'px');
    box.style.setProperty('--p-weight', cs.bold ? '700' : '400');
    box.style.setProperty('--p-style', cs.italic ? 'italic' : 'normal');
    box.style.setProperty('--p-deco', cs.underline ? 'underline' : 'none');
    box.style.setProperty('--p-shadow', EDGES[cs.edge] || EDGES.shadow);
  }

  /* ---------- saving ---------- */

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 200);
  }

  /* Firefox's storage.sync rejects writes when no Sync account is signed in,
   * so every save also goes to storage.local, which always works. Reads back
   * both and lets sync win when it is reachable. */
  async function save() {
    let ok = false;
    try {
      await chrome.storage.sync.set(state);
      ok = true;
    } catch (err) {
      /* no Sync account — local copy below still saves */
    }
    try {
      await chrome.storage.local.set(state);
      ok = true;
    } catch (err) {
      /* ignore */
    }
    flash(ok ? 'Saved' : 'Could not save');
    pushToTab();
  }

  /* Belt-and-braces: also hand the new settings straight to the content
   * script in the active tab so they are applied immediately even if a
   * storage backend misbehaves (Firefox rejects storage.sync without an
   * active Sync account). */
  function pushToTab() {
    if (!tab || !tab.id) return;
    try {
      const send = chrome.tabs.sendMessage(tab.id, { type: 'yql:settings', settings: state });
      if (send && typeof send.catch === 'function') send.catch(() => {});
      if (typeof chrome.runtime.lastError !== 'undefined') void chrome.runtime.lastError;
    } catch (err) {
      /* active tab has no content script (not a YouTube page) */
    }
  }

  function flash(message) {
    $('status').textContent = message;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusTimer = 0;
      $('status').textContent = note;
    }, 1300);
  }

  /* ---------- probing the active tab ---------- */

  function queryActiveTab() {
    return new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          resolve((tabs && tabs[0]) || null);
        });
      } catch (err) {
        resolve(null);
      }
    });
  }

  function askPage() {
    return new Promise((resolve) => {
      if (!tab || !tab.id) return resolve(null);
      try {
        chrome.tabs.sendMessage(tab.id, { type: 'yql:probe' }, (response) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(response && response.data ? response.data : null);
        });
      } catch (err) {
        resolve(null);
      }
    });
  }

  async function refreshProbe() {
    probe = await askPage();
    fillQuality();
    fillLanguages();
    render();

    if (!probe) {
      note = tab && isYouTube(tab.url)
        ? 'Reload the YouTube tab to let the extension read it'
        : 'Open a YouTube video to see it applied';
    } else {
      note = '';
    }
    if (!statusTimer) $('status').textContent = note;
  }

  /* ---------- wiring ---------- */

  function bind() {
    $('enabled').addEventListener('change', (e) => {
      state.enabled = e.target.checked;
      render();
      scheduleSave();
    });

    $('lockQuality').addEventListener('change', (e) => {
      state.lockQuality = e.target.checked;
      scheduleSave();
    });

    $('quality').addEventListener('change', (e) => {
      state.quality = e.target.value;
      scheduleSave();
    });

    document.querySelectorAll('#captionsMode button').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.captionsMode = btn.dataset.value;
        render();
        scheduleSave();
      });
    });

    $('captionLang').addEventListener('change', (e) => {
      state.captionLang = e.target.value;
      scheduleSave();
    });

    $('styleEnabled').addEventListener('change', (e) => {
      state.captionStyle.enabled = e.target.checked;
      render();
      scheduleSave();
    });

    $('font').addEventListener('change', (e) => {
      state.captionStyle.font = e.target.value;
      updatePreview();
      scheduleSave();
    });

    $('edge').addEventListener('change', (e) => {
      state.captionStyle.edge = e.target.value;
      updatePreview();
      scheduleSave();
    });

    $('scale').addEventListener('input', (e) => {
      state.captionStyle.scale = Number(e.target.value);
      $('scaleOut').textContent = e.target.value + '%';
      updatePreview();
      scheduleSave();
    });

    $('bgOpacity').addEventListener('input', (e) => {
      state.captionStyle.bgOpacity = Number(e.target.value);
      $('bgOut').textContent = e.target.value + '%';
      updatePreview();
      scheduleSave();
    });

    $('fontOpacity').addEventListener('input', (e) => {
      state.captionStyle.fontOpacity = Number(e.target.value);
      $('fontOut').textContent = e.target.value + '%';
      updatePreview();
      scheduleSave();
    });

    $('windowOpacity').addEventListener('input', (e) => {
      state.captionStyle.windowOpacity = Number(e.target.value);
      $('windowOut').textContent = e.target.value + '%';
      updatePreview();
      scheduleSave();
    });

    $('windowColor').addEventListener('input', (e) => {
      state.captionStyle.windowColor = e.target.value;
      updatePreview();
      scheduleSave();
    });

    $('color').addEventListener('input', (e) => {
      state.captionStyle.color = e.target.value;
      updatePreview();
      scheduleSave();
    });

    $('bgColor').addEventListener('input', (e) => {
      state.captionStyle.bgColor = e.target.value;
      updatePreview();
      scheduleSave();
    });

    for (const key of ['bold', 'italic', 'underline']) {
      $(key).addEventListener('change', (e) => {
        state.captionStyle[key] = e.target.checked;
        updatePreview();
        scheduleSave();
      });
    }

    $('detect').addEventListener('click', () => {
      flash('Reading…');
      refreshProbe().then(() => flash(probe ? 'Read from video' : 'No YouTube video found'));
    });

    $('reset').addEventListener('click', () => {
      state = clone(DEFAULTS);
      render();
      fillQuality();
      fillLanguages();
      render();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 0);
    });
  }

  async function init() {
    let stored = {};
    try {
      stored = (await chrome.storage.local.get(null)) || {};
    } catch (err) {
      stored = {};
    }
    try {
      const synced = (await chrome.storage.sync.get(null)) || {};
      if (synced.captionStyle !== undefined || synced.quality !== undefined) {
        stored = deepMerge(stored, synced);
      }
    } catch (err) {
      /* no Sync account — local copy already loaded */
    }
    if (stored.captionStyle) {
      if (stored.captionStyle.edge === undefined) {
        stored.captionStyle.edge = stored.captionStyle.shadow === false ? 'none' : 'shadow';
      }
      if (!EDGES[stored.captionStyle.edge]) stored.captionStyle.edge = 'shadow';
    }
    state = deepMerge(DEFAULTS, stored || {});

    // migrate the old boolean `shadow` field to the `edge` selector
    const cs = state.captionStyle;
    if (cs.edge === undefined) cs.edge = cs.shadow === false ? 'none' : 'shadow';
    if (!EDGES[cs.edge]) cs.edge = 'shadow';

    tab = await queryActiveTab();
    bind();
    fillQuality();
    fillLanguages();
    render();
    refreshProbe();
  }

  init();
})();
