# ClipHawk privacy and permissions

ClipHawk has no analytics, telemetry, or developer-operated server. Media analysis
runs locally in the extension. It requests manifests and media from the source
sites/CDNs, including browser credentials where permitted, to download the media
you select. Those sites still receive ordinary network requests.

## Browser permissions

| Permission | Purpose |
| --- | --- |
| Access to all websites | Discover and fetch media hosted on pages and third-party CDNs. |
| `webRequest` | Observe media response URLs, types, and sizes for each tab. |
| `activeTab`, `scripting` | Inspect video elements on the active page when the popup opens. |
| `storage` | Hold captured media URLs and download jobs in browser session storage. |
| `downloads` | Save selected media using the browser's download manager. |
| `declarativeNetRequestWithHostAccess` | Set source-page Referer/Origin headers for media servers that require them. |

The page script marks MediaSource and DRM use so ClipHawk can describe supported
and protected streams. It does not decrypt DRM content.

Captured URLs can include temporary access tokens. They are kept in memory/session
storage, cleared on navigation or with **Clear captured**, and are not sent to the
developer. Session storage ends with the browser session; downloaded files and
browser download history remain until you remove them. Copying a URL places it
on your system clipboard. Avoid sharing captured URLs if they grant access to
private media.
