# Quality Lock for YouTube

A small Manifest V3 extension for Chrome / Edge / Brave that keeps YouTube from
resetting your video quality to **Auto** and keeps your caption (subtitle)
settings the way you set them.

## What it does

- **Locks video quality** to the level you pick. If a video doesn't offer that
  level, it falls back to the closest lower one, never to Auto. It re-applies
  after every ad, seek, navigation and quality change YouTube tries to make.
- **Quality picker shows the real levels** for the video you're watching, read
  live from the player (so 1440p/4K/8K only appear where the video actually has
  them).
- **Subtitles on / off / untouched**, plus a language picker built from the
  subtitle tracks that video actually has (auto-generated tracks are marked
  `(auto)`).
- **Caption style**: font, size, bold/italic/underline, text colour, **text
  opacity**, background colour + opacity (behind the letters), **window colour +
  opacity** (the whole caption box) and edge style (drop shadow / outline /
  raised / none) — applied over YouTube's own captions, including in fullscreen
  and theatre mode.
- Settings sync through your browser profile (`chrome.storage.sync`).

## Install (unpacked)

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `youtube-quality-lock` folder.
4. Pin the extension, open a YouTube video, and pick your quality / caption style.

Reload already-open YouTube tabs once after installing or after updating files.

## How the pickers get their options

The popup asks the active YouTube tab what it can do (`yql:probe`):

1. `popup.js` → `chrome.tabs.sendMessage(tabId, {type: 'yql:probe'})`
2. `content.js` (isolated world) → `window.postMessage({type: 'probe'})`
3. `player.js` (main world) reads `getAvailableQualityData()` /
   `getAvailableQualityLevels()` and `getOption('captions','tracklist')`, then
   posts `probe-result` back
4. `content.js` resolves the popup's request; the selects are rebuilt.

If no YouTube tab is reachable, the popup falls back to the full static list so
nothing breaks. The **Read this video** button re-runs the probe on demand
(useful after switching videos).

## Notes

- Quality identifiers are YouTube's own: `highres` 4320p, `hd2160` 2160p,
  `hd1440`, `hd1080`, `hd720`, `large` 480p, `medium` 360p, `small` 240p,
  `tiny` 144p. The extension never picks a level above what the video offers.
- A saved quality persists across videos. On a video that doesn't have it, the
  popup shows `1080p — saved, not on this video` and playback uses the closest
  lower level.
- Some videos only expose 1080p+ for Premium accounts or after buffering starts.
  If the lock seems ignored for a few seconds, that is why — it re-applies as
  soon as the level appears.
- "Subtitle language" only switches to a track that already exists on the video.
  Auto-generated captions use the video's spoken language code (e.g. `en`).
- Language switching only runs when subtitles are set to **Always on**.
- Caption styling targets YouTube's own caption elements (`.ytp-caption-segment`),
  so the built-in YouTube caption menu keeps working; this extension just
  overrides the look on top of it.
- Background opacity 0 gives outline-only captions.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest, storage permission, content scripts |
| `content.js` | Isolated world: settings, caption CSS, probe relay, applies style |
| `player.js` | Main world: YouTube player API (quality, captions, probe) |
| `popup.html/.css/.js` | Settings UI with live caption preview + live pickers |
| `icons/` | Toolbar icons |
| `tools/gen-icons.js` | Regenerates the PNG icons (`node tools/gen-icons.js`) |
