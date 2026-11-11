# ClipHawk — Video Grabber

[![Build](https://github.com/GetAppCraft-Inc/cliphawk/actions/workflows/release.yml/badge.svg)](https://github.com/GetAppCraft-Inc/cliphawk/actions/workflows/release.yml)

ClipHawk finds video on the current page, ranks the likely main video above ads,
and downloads supported MP4/WebM files, HLS playlists, and DASH streams. It is a
Manifest V3 extension for Chrome and Brave. Ad detection is heuristic; encrypted
and DRM-protected streams are skipped.

## Download and install

**[Download the latest release](https://github.com/GetAppCraft-Inc/cliphawk/releases/latest)**

1. Under **Assets**, download `cliphawk-VERSION.zip` and extract it to a permanent folder.
2. Open `chrome://extensions` or `brave://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the extracted folder containing `manifest.json`.
4. Pin ClipHawk, reload the video page, press play, then open ClipHawk.
5. Choose a quality and click **Download**. Keep the downloader tab open until saving finishes.

No build tools are needed to use the release. See [INSTALL.md](INSTALL.md) for
updating, troubleshooting, and checksum verification. GitHub installs require
Developer mode and manual updates. Chrome restricts normal self-hosted extension
installation on Windows/macOS; a one-click consumer install would require a
[Chrome Web Store listing](https://developer.chrome.com/docs/extensions/how-to/distribute).
The first downloadable release appears after a version tag passes the workflow.

For a source checkout, load the repository folder directly using the same steps.

## Improvements in 1.0.1

- Correct HLS byte-range offsets and reject invalid ranges or changing initialization segments.
- Validate partial HTTP responses so a server ignoring ranges cannot silently corrupt downloads.
- Time out stalled requests, retry temporary failures, and cancel retry waits promptly.
- Detect downloads that finish before listeners attach; clean up object URLs on save errors.
- Show actual download failures instead of incorrectly reporting them as cancellation.
- Handle clipboard failures, reserved Windows filenames, keyboard focus, and reduced motion.
- Clean up tab timers and downloader request-header rules when tabs close.
- Add regression tests, package validation, verified ZIPs, checksums, and automated GitHub releases.

## How it works

| Component | Purpose |
| --- | --- |
| `background.js` | Captures media responses per tab, ignores segments/tiny previews, and clears captured media on navigation. |
| `inject.js` | Marks MediaSource and EME/DRM usage on the page. |
| `popup.js` | Scans video elements, reads manifests, and ranks candidates by duration, size, player visibility, and ad heuristics. |
| `downloader.js` | Downloads up to six chunks concurrently, then saves assembled tracks. |
| `lib/` | URL helpers, HLS/DASH parsing, bounded network retries, and download completion handling. |

Likely ads are grouped separately. Multiple qualities are shown when available.
Streams containing HLS encryption keys or DASH ContentProtection are skipped.
See [PRIVACY.md](PRIVACY.md) for permissions, stored data, and network behavior.

## Output and limitations

- Direct files are saved as supplied by the server.
- HLS transport streams are saved as `.ts` (playable in VLC/mpv). Convert without
  re-encoding with `ffmpeg -i in.ts -c copy out.mp4`.
- fMP4 HLS and MP4 DASH tracks are saved as `.mp4`; separate audio is saved separately.
  The downloader shows an ffmpeg merge command. Browser-side muxing is not included.
- Live DASH is unsupported; live HLS saves only the current playlist window.
- HLS playlists that change initialization segments are rejected to avoid invalid output.
- Multi-period DASH keeps one period (the longest when duration is available).
- Streams are assembled in RAM; long videos can require substantial memory.
- Expired URLs, access restrictions, unusual manifest layouts, or unsupported encryption
  can prevent downloads. Reloading and playing the source video can refresh captured links.

## Development and verification

Use Node.js 24 or newer. There are no npm dependencies and no install step.

```sh
npm run check
npm test
npm run build
```

Packaging uses Windows PowerShell on Windows or PowerShell 7 (`pwsh`) on Linux/macOS.
The build validates the manifest, version, referenced runtime assets, icons, and
JavaScript syntax. It includes only files in `scripts/package-files.json`, verifies
every ZIP entry against the source, and writes:

```text
dist/cliphawk-1.0.1.zip
dist/cliphawk-1.0.1.zip.sha256
```

Tests cover HLS parsing, byte-range responses, retries, timeout/cancellation,
download completion races, classification, and filenames. They use mocked browser
and network APIs. Before releasing, also load the extension in Chrome/Brave and
smoke-test direct downloads, HLS with separate audio, cancellation, and DRM indicators.

## GitHub Actions and releases

The [workflow](.github/workflows/release.yml) runs on pull requests, pushes to `main`,
version tags, and manual **Run workflow** requests. Tests run on Windows and Linux.
Successful builds upload a ZIP and checksum as the `cliphawk-package` Actions artifact.

To publish a public download:

1. Commit and push the changes to this repository.
2. Set the same release version in `manifest.json` and `package.json` (currently `1.0.1`).
3. Commit/push any version change, then push the matching tag:

   ```sh
   git tag v1.0.1
   git push origin v1.0.1
   ```

The workflow rejects tags that do not match the manifest. Once checks and packaging
pass, it verifies the checksum and publishes the ZIP and checksum to GitHub Releases.
The repository must be public for anyone to download anonymously. Enable Actions
in repository settings; no custom secrets or signing certificates are required.
Only the release job receives `contents: write` via GitHub's built-in token.
Repository/organization policies must allow that permission.

Published assets are not overwritten on reruns. If an upload fails and leaves a
draft, review/remove that incomplete draft before rerunning the failed job. Manual
workflow runs produce test artifacts only; publishing is triggered by a tag push.

Icons can be regenerated with `python scripts/make_icons.py` (Python standard library only).
