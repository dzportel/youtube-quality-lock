# Quality Lock for YouTube — Firefox (source code)

This is the complete source code for the Firefox add-on "Quality Lock for YouTube"
version 1.0.1 (add-on ID {8f5a3c2e-9d1b-4e6f-a7c8-2b5d0e4f9a13}).

All JavaScript, HTML and CSS files are hand-written plain source files.
They are shipped as-is: nothing is minified, transpiled, bundled or concatenated.

The only machine-generated files are the PNG icons in `icons/`, which are
produced by the script `tools/gen-icons.js` included in this archive.

## Files

- `manifest.json` — Manifest V2 add-on manifest
- `content.js`    — content script (isolated world): reads settings, injects the caption stylesheet, listens for live setting updates from the popup
- `player.js`     — content script injected in the page world (MAIN): talks to the YouTube player API (setPlaybackQualityRange / setPlaybackQuality, caption track list) and applies the quality lock with backoff and retry caps
- `popup.html` / `popup.css` / `popup.js` — the toolbar popup UI and its logic (storage read/write + live push to tabs)
- `tools/gen-icons.js` — Node.js script that generates the PNG icons in `icons/`
- `icons/icon16.png`, `icons/icon32.png`, `icons/icon48.png`, `icons/icon128.png` — generated toolbar/store icons

## Build instructions (step by step)

Requirements:

- Node.js version 18 or later (only the built-in modules `fs` and `zlib` are
  used; there are no npm dependencies and nothing to install)
- Any OS (Windows, macOS or Linux)
- A zip tool (or the `Compress-Archive` / `zip` command)

Steps to produce a byte-equivalent copy of the submitted add-on:

1. Extract this source archive into a folder.
2. Regenerate the icons (optional; the generated PNGs are already included):

       node tools/gen-icons.js

   This rewrites `icons/icon16.png`, `icons/icon32.png`, `icons/icon48.png`
   and `icons/icon128.png` in place.

3. Zip the following files with `manifest.json` at the root of the archive
   (do not zip the folder itself):

       manifest.json
       content.js
       player.js
       popup.html
       popup.css
       popup.js
       icons/icon16.png
       icons/icon32.png
       icons/icon48.png
       icons/icon128.png

   Example (Linux/macOS, from this folder):

       zip ../youtube-quality-lock-firefox.zip manifest.json content.js player.js popup.html popup.css popup.js icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png

   Example (Windows PowerShell, from this folder):

       Compress-Archive -Path manifest.json,content.js,player.js,popup.html,popup.css,popup.js,icons -DestinationPath ..\youtube-quality-lock-firefox.zip -Force

4. The resulting zip is the installable add-on package.

## Runtime notes

- The add-on requests host access only to `*://*.youtube.com/*`.
- Settings are stored with `chrome.storage.sync` with a `chrome.storage.local`
  fallback (Firefox rejects `storage.sync` when no Sync account is signed in).
- No data is collected and no network requests are made
  (`data_collection_permissions: none`).
