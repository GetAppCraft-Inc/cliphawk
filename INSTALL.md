# Install ClipHawk

ClipHawk is a browser extension for Chrome and Brave on Windows, macOS, and Linux.
Use a current browser (Chrome 111 or later is required). No Node.js, Python, or
other development tools are needed to use the downloaded extension.

1. Open https://github.com/GetAppCraft-Inc/cliphawk/releases/latest.
2. Under **Assets**, download **cliphawk-VERSION.zip**. Choose this packaged asset,
   rather than GitHub's automatically generated source archives.
3. Extract the ZIP to a permanent folder, such as `Documents/ClipHawk`.
4. Open `chrome://extensions` in Chrome or `brave://extensions` in Brave.
5. Enable **Developer mode**.
6. Click **Load unpacked** and select the extracted folder containing `manifest.json`.
7. Pin ClipHawk from the browser's Extensions menu. Open a video page, reload it,
   press play, then click ClipHawk and choose **Download**.

Use search and the format filters to narrow the list. The gear button opens theme,
preferred-quality, and save-location preferences. On the downloader page, **Pause**
finishes active requests before stopping; **Retry download** restarts unfinished
tracks and keeps files already saved. Direct files use the browser's download controls.

Keep the extracted folder in place. Chrome loads the extension from this folder.
This GitHub distribution uses Developer mode; it is not a one-click Web Store
installation or a signed installer. Managed browsers may prevent unpacked installs.

## Updating

GitHub installs do not update automatically. Close any ClipHawk download tabs,
extract the new release over the files in the same folder, then click **Reload**
on the ClipHawk card at the extensions page. Reload video pages afterward.

## Troubleshooting

- **No video found:** reload the video page, press play, then use **Rescan page**.
  Browser internal pages and the Chrome Web Store cannot be scanned.
- **Encrypted/DRM:** protected streams are detected and skipped.
- **Download failed:** the media link may have expired or require your signed-in
  session. Reload the source page and capture a fresh link.
- **Separate audio/video:** the downloader displays an ffmpeg command to combine
  them. `.ts` files can be opened in VLC or mpv.
- **Large files:** streams are assembled in memory. Keep the downloader tab open
  until saving finishes, and avoid downloading several large streams at once.

## Verify a download (optional)

Every release includes a matching `.zip.sha256` file. Compare its hash with:

```powershell
Get-FileHash ./cliphawk-1.1.1.zip -Algorithm SHA256
```

On Linux, use `sha256sum -c cliphawk-1.1.1.zip.sha256`; on macOS, use
`shasum -a 256 -c cliphawk-1.1.1.zip.sha256`. Substitute the downloaded version.
