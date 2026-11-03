# 🦅 ClipHawk — Video Grabber (Chrome & Brave)

Finds the **main** video on the current page, ignores the ads around it, and downloads it.

## Install (unpacked)
1. Open `chrome://extensions` (or `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this `cliphawk/` folder.
4. Pin ClipHawk. The orange badge shows how many non-ad videos it caught on the tab.

## How it works
| Piece | Job |
|---|---|
| `background.js` | Watches network responses (`webRequest`) for MP4/WebM files, HLS `.m3u8` and DASH `.mpd` manifests, per tab. Ignores segments (`.ts`, `.m4s`), tiny files and resets on navigation. |
| `inject.js` | Runs in the page world and flags EME/DRM usage (`setMediaKeys`, `encrypted` event) and MediaSource streaming. |
| `popup.js` | Scans every `<video>` in every frame, reads the manifests, then **scores** each candidate to choose the main video. |
| `downloader.html/js` | Fetches stream chunks in parallel (6 at a time, with retries), joins them and saves the file. |

### Picking the main video over ads
The score goes **up** for: a long duration (3+ min, 10+ min), a duration that matches the big visible player, a large size, several quality levels, or a large on-screen `<video>`.
It goes **down** for: known ad servers (DoubleClick, IMA, FreeWheel, SpotX, Teads…), ad words in the URL path (`/ads/`, `preroll`, `vast`…), players inside `ad`/`ima`/`preroll` containers, and clips of 35 seconds or less.
The best candidate is shown as **★ Main video**. Other real videos are listed below it, and suspected ads are folded under *Likely ads*.

### Encrypted streams: skipped for now
- HLS with `#EXT-X-KEY` / `#EXT-X-SESSION-KEY` set to anything other than `NONE` (AES-128, SAMPLE-AES, FairPlay…)
- DASH with `<ContentProtection>` (Widevine/PlayReady)
- Pages using EME/DRM show a 🔒 banner

These streams appear with a 🔒 tag and a disabled button.

## Output formats
- **Direct files**: saved as-is by the browser's download manager.
- **HLS (TS segments)**: saved as `.ts`, which plays in VLC/mpv. To convert to MP4: `ffmpeg -i in.ts -c copy out.mp4`
- **HLS (fMP4) / DASH**: saved as `.mp4`. When audio is a separate track it is saved as a separate `.m4a`, and the downloader shows the `ffmpeg` merge command.

## Limits / TODO
- Encrypted chunk handling (deliberately left for later)
- Muxing video and audio inside the browser (would need ffmpeg.wasm)
- Live DASH; for live HLS only the current window of segments is grabbed
- Streams are held in memory before saving, so very long videos need RAM
- If nothing is detected, reload the page and press play. Manifests loaded before the extension started can't be seen.

Icons: `python3 scripts/make_icons.py`
