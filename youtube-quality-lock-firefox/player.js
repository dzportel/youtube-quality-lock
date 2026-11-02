/*
 * player.js — runs in YouTube's own JS context (world: MAIN).
 * The player API is only reachable from the page context, so this file gets
 * the settings from content.js over window.postMessage and keeps the player
 * pinned to them. It also answers "probe" requests from the popup.
 *
 * Hardened version: quality and caption changes are applied a bounded number
 * of times with exponential backoff. If the player ignores the requested
 * quality, the extension parks itself instead of retrying forever — that
 * retry loop is what could otherwise look like the video skipping repeatedly.
 */
(() => {
  'use strict';

  if (window.__yqlMain) return;
  window.__yqlMain = true;

  const ORDER = ['highres', 'hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];
  const RANK = new Map(ORDER.map((q, i) => [q, i]));
  const LABELS = {
    highres: '4320p (8K)',
    hd2160: '2160p (4K)',
    hd1440: '1440p',
    hd1080: '1080p',
    hd720: '720p',
    large: '480p',
    medium: '360p',
    small: '240p',
    tiny: '144p'
  };

  const QUALITY_BACKOFF_MS = 2500;   // wait this long between corrections of one target
  const QUALITY_CAP = 6;             // give up after this many ignored corrections
  const CAPTION_CAP = 4;             // max caption toggle clicks per navigation cycle
  const AD_SETTLE_MS = 1200;         // extra wait at the very start of a video

  const now = () => performance.now();

  let settings = null;
  let player = null;
  let hooked = null;
  let ticks = 0;

  // quality state (per current video)
  let qTarget = '';        // last target we asked for on this player
  let qAttempts = 0;       // corrections already sent for qTarget
  let qLastAt = 0;         // last time we sent a correction
  let qParked = false;     // stopped because the player keeps ignoring us
  let qVideoEpoch = '';    // identifies the current video for parking resets

  // captions state (per navigation cycle)
  let capKey = '';
  let capTries = 0;
  let capLastAt = 0;
  let langAt = 0;

  function post(msg) {
    try {
      window.postMessage(Object.assign({ source: 'yql-page' }, msg), location.origin);
    } catch (err) {
      /* ignore */
    }
  }

  function requestSettings() {
    post({ type: 'hello' });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'yql-ext') return;

    if (data.type === 'settings') {
      const next = data.settings || null;
      const changedQuality = !settings || !next || settings.quality !== next.quality;
      settings = next;
      if (changedQuality) {
        qAttempts = 0;
        qTarget = '';
        qParked = false;
        qLastAt = 0;
      }
      tick();
    } else if (data.type === 'probe') {
      post({ type: 'probe-result', id: data.id, data: probe() });
    }
  });

  function getPlayer() {
    if (player && player.isConnected && typeof player.getPlaybackQuality === 'function') return player;
    const el = document.getElementById('movie_player');
    player = el && typeof el.getPlaybackQuality === 'function' ? el : null;
    return player;
  }

  function videoEpoch(p) {
    let id = '';
    try {
      id = (p.getVideoData && p.getVideoData().video_id) || '';
    } catch (err) {
      /* ignore */
    }
    return id || String(Math.random());
  }

  function resetQualityState(resetPark) {
    qTarget = '';
    qAttempts = 0;
    qLastAt = 0;
    if (resetPark) qParked = false;
  }

  /* ---------- probe ---------- */

  function levelLabel(entry) {
    const label = entry && entry.qualityLabel ? String(entry.qualityLabel) : '';
    if (label) return label;
    return LABELS[entry && entry.id] || String((entry && entry.id) || '');
  }

  function probe() {
    const p = getPlayer();
    if (!p) return null;

    let levels = [];
    let data = [];
    try {
      data = (typeof p.getAvailableQualityData === 'function' && p.getAvailableQualityData()) || [];
    } catch (err) {
      data = [];
    }

    if (Array.isArray(data) && data.length) {
      for (const entry of data) {
        if (!entry) continue;
        const id = entry.quality || entry.qualityLevel || '';
        if (!id || id === 'auto') continue;
        levels.push({ id, label: levelLabel({ id, qualityLabel: entry.qualityLabel }) });
      }
    } else {
      let raw = [];
      try {
        raw = p.getAvailableQualityLevels() || [];
      } catch (err) {
        raw = [];
      }
      for (const id of raw) {
        if (!id || id === 'auto') continue;
        levels.push({ id, label: levelLabel({ id }) });
      }
    }

    // de-duplicate, then sort highest -> lowest
    const seen = new Set();
    levels = levels.filter((l) => {
      if (seen.has(l.id)) return false;
      seen.add(l.id);
      return true;
    });
    levels.sort((a, b) => {
      const ra = RANK.has(a.id) ? RANK.get(a.id) : 99;
      const rb = RANK.has(b.id) ? RANK.get(b.id) : 99;
      return ra - rb;
    });

    let current = '';
    try {
      current = p.getPlaybackQuality() || '';
    } catch (err) {
      current = '';
    }

    let tracks = [];
    try {
      tracks = p.getOption('captions', 'tracklist') || [];
    } catch (err) {
      tracks = [];
    }

    const byCode = new Map();
    for (const track of tracks) {
      if (!track || !track.languageCode) continue;
      const code = track.languageCode;
      const kind = track.kind || '';
      const name = track.languageName || track.displayName || code;
      const prev = byCode.get(code);
      // prefer a human-authored track over the auto-generated one
      if (!prev || (prev.kind === 'asr' && kind !== 'asr')) {
        byCode.set(code, { code, name, kind });
      }
    }

    let captionsOn = false;
    const button = document.querySelector('.ytp-subtitles-button');
    if (button) captionsOn = button.getAttribute('aria-pressed') === 'true';

    return {
      current,
      levels,
      captionTracks: Array.from(byCode.values()).sort((a, b) => a.name.localeCompare(b.name)),
      captionsOn
    };
  }

  /* ---------- quality ---------- */

  function pickTarget(p, want) {
    let levels = [];
    try {
      levels = (p.getAvailableQualityLevels && p.getAvailableQualityLevels()) || [];
    } catch (err) {
      levels = [];
    }
    const usable = levels.filter((q) => RANK.has(q));
    if (!usable.length) return want;
    if (usable.indexOf(want) !== -1) return want;

    // Best available quality that is not higher than the requested one.
    const wantRank = RANK.get(want);
    let best = '';
    for (const q of usable) {
      const r = RANK.get(q);
      if (r >= wantRank && (best === '' || r < RANK.get(best))) best = q;
    }
    if (best) return best;

    // Requested quality is lower than anything available: take the worst one.
    for (const q of usable) {
      if (best === '' || RANK.get(q) > RANK.get(best)) best = q;
    }
    return best || want;
  }

  function applyQuality(p) {
    if (!p || !settings || !settings.enabled || !settings.lockQuality) return;
    const want = settings.quality;
    if (!want || want === 'auto') return;
    if (p.classList && p.classList.contains('ad-showing')) return;

    // If the player keeps ignoring us, stand down until the video changes.
    if (qParked) return;

    // Fresh video? Reset the correction counter before doing anything.
    const epoch = videoEpoch(p);
    if (epoch !== qVideoEpoch) {
      qVideoEpoch = epoch;
      resetQualityState(true);
    }

    const target = pickTarget(p, want);
    if (!target) return;

    let current = '';
    try {
      current = p.getPlaybackQuality() || '';
    } catch (err) {
      return;
    }
    if (current && current === target) {
      resetQualityState(false);
      return;
    }

    const t = now();
    if (target === qTarget) {
      // Already asked for this one and it has not taken effect yet.
      if (t - qLastAt < QUALITY_BACKOFF_MS) return;
      qAttempts += 1;
      if (qAttempts > QUALITY_CAP) {
        qParked = true; // stop fighting until the video or setting changes
        return;
      }
    } else {
      qTarget = target;
      qAttempts = 1;
    }
    qLastAt = t;

    // Let the very start of a video settle before touching the player.
    if (p.getPlayerState && (function () { try { return p.getPlayerState() === 1; } catch (err) { return false; } })()) {
      if (t - (p.__yqlStartedAt || (p.__yqlStartedAt = t)) < AD_SETTLE_MS) return;
    }

    try {
      // Ask once, with one API — calling both can double-trigger a rebuffer.
      if (typeof p.setPlaybackQualityRange === 'function') {
        p.setPlaybackQualityRange(target, target);
      } else if (typeof p.setPlaybackQuality === 'function') {
        p.setPlaybackQuality(target);
      }
    } catch (err) {
      /* player not ready yet — the next tick retries (with backoff) */
    }
  }

  /* ---------- captions ---------- */

  function applyCaptionLang(p) {
    const lang = settings.captionLang;
    if (!lang) return;

    let track = null;
    try {
      track = p.getOption('captions', 'track');
    } catch (err) {
      return;
    }
    if (track && track.languageCode === lang) return;

    const t = now();
    if (t - langAt < 5000) return;
    langAt = t;
    try {
      p.setOption('captions', 'track', { languageCode: lang });
    } catch (err) {
      /* captions module not loaded yet */
    }
  }

  function applyCaptions(p) {
    if (!p || !settings || !settings.enabled) return;
    const mode = settings.captionsMode || 'keep';
    if (mode === 'keep') {
      capKey = '';
      capTries = 0;
      capLastAt = 0;
      return;
    }

    const button = document.querySelector('.ytp-subtitles-button');
    if (!button || button.getAttribute('aria-disabled') === 'true') return;

    const wantOn = mode === 'on';
    const isOn = button.getAttribute('aria-pressed') === 'true';
    const t = now();

    if (isOn !== wantOn) {
      const key = wantOn ? 'on' : 'off';
      // Wait at least 8s between attempts and hard-cap the number of clicks;
      // a stuck toggle can otherwise click-loop forever.
      if (capKey === key) {
        if (capTries >= CAPTION_CAP) return; // parked until the state changes
        if (t - capLastAt < 8000) return;
        capTries += 1;
      } else {
        capKey = key;
        capTries = 1;
        if (t - capLastAt < 2000) return; // debounce double clicks
      }
      capLastAt = t;
      try {
        button.click();
      } catch (err) {
        /* ignore */
      }
      return;
    }

    capKey = '';
    capTries = 0;
    if (wantOn) applyCaptionLang(p);
  }

  /* ---------- wiring ---------- */

  function hook(p) {
    if (hooked === p) return;
    hooked = p;
    try {
      p.addEventListener('onPlaybackQualityChange', () => setTimeout(() => applyQuality(p), 300));
      p.addEventListener('onStateChange', () => {
        let state = -1;
        try {
          state = p.getPlayerState();
        } catch (err) {
          /* ignore */
        }
        if (state === 1) {
          applyQuality(p);
          applyCaptions(p);
        }
      });
      p.addEventListener('onVideoDataChange', () => {
        // new video: forget everything learned about the old one
        resetQualityState(true);
        capKey = '';
        capTries = 0;
        setTimeout(() => applyQuality(p), 700);
      });
    } catch (err) {
      /* ignore */
    }
  }

  function tick() {
    const p = getPlayer();
    if (!p) return;
    hook(p);
    applyQuality(p);
    // captions only twice per watchdog cycle — they don't need fast polling
    if (ticks % 3 === 0) applyCaptions(p);
    ticks += 1;
  }

  // Slow watchdog: purely event-driven hooks do almost all the work.
  setInterval(tick, 2600);
  [0, 400, 1200].forEach((delay) => setTimeout(requestSettings, delay));
  requestSettings();

  document.addEventListener(
    'yt-navigate-finish',
    () => {
      resetQualityState(true);
      capKey = '';
      capTries = 0;
      requestSettings();
      setTimeout(tick, 400);
    },
    true
  );
  window.addEventListener('pageshow', requestSettings);
})();
