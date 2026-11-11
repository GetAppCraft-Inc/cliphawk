// Shared helpers: URL classification, ad heuristics, formatting.

export const AD_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'imasdk.googleapis.com',
  '2mdn.net', 'adnxs.com', 'advertising.com', 'adsrvr.org', 'springserve.com', 'spotxchange.com',
  'spotx.tv', 'fwmrm.net', 'freewheel.tv', 'moatads.com', 'innovid.com', 'teads.tv', 'tremorhub.com',
  'serving-sys.com', 'adform.net', 'smartadserver.com', 'pubmatic.com', 'rubiconproject.com',
  'openx.net', 'criteo.com', 'taboola.com', 'outbrain.com', 'vidoomy.com', 'aniview.com',
  'connatix.com', 'primis.tech', 'adsafeprotected.com', 'yieldmo.com', 'unrulymedia.com', 'vdo.ai',
  'sekindo.com', 'amazon-adsystem.com', 'adcolony.com', 'vungle.com', 'unityads.unity3d.com',
  'applovin.com', 'inmobi.com', 'mgid.com', 'propellerads.com', 'exoclick.com', 'juicyads.com',
  'trafficjunky.net', 'adspyglass.com', 'popads.net', 'adsterra.com', 'video-ads.net', 'vidazoo.com',
  'stickyadstv.com', 'lkqd.net', 'beachfront.com', 'synacor.com', 'undertone.com', 'brightcove.com/ads'
];

const AD_PATH_RE = /(?:^|[\/_.\-])(?:ads?|adv|advert(?:ising|isement)?s?|preroll|pre-roll|midroll|mid-roll|postroll|vast|vpaid|commercials?|sponsored|bumper)(?:[\/_.\-]|$)/i;

const FILE_EXT = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogv', 'flv', 'avi', '3gp']);
const SEGMENT_EXT = new Set(['ts', 'm4s', 'm4f', 'cmfv', 'cmfa', 'aac', 'm4a', 'mp3', 'vtt', 'key', 'init']);

export function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ''; }
}

export function extOf(u) {
  try {
    const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(u).pathname);
    return m ? m[1].toLowerCase() : '';
  } catch { return ''; }
}

export function isAdHost(u) {
  const h = hostOf(u);
  if (!h) return false;
  if (AD_HOSTS.some(a => !a.includes('/') && (h === a || h.endsWith('.' + a)))) return true;
  return /^(ads?|adserver|adx|advert|adtech)[\d-]*\./.test(h);
}

export function isAdUrl(u) {
  if (!u) return false;
  if (isAdHost(u)) return true;
  try { return AD_PATH_RE.test(new URL(u).pathname); } catch { return false; }
}

/** Returns 'hls' | 'dash' | 'file' | null */
export function classify(url, contentType) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  const ext = extOf(url);
  if (/mpegurl/.test(ct) || ext === 'm3u8') return 'hls';
  if (ct === 'application/dash+xml' || ext === 'mpd') return 'dash';
  if (ct === 'video/mp2t' || ct === 'video/iso.segment' || SEGMENT_EXT.has(ext)) return null;
  if (ct.startsWith('audio/') || ct.startsWith('image/') || ct.startsWith('text/')) return null;
  if (ct.startsWith('video/')) return 'file';
  if (FILE_EXT.has(ext) && (!ct || ct === 'application/octet-stream' || ct === 'binary/octet-stream')) return 'file';
  return null;
}

// Strip byte-range style query params so chunked progressive requests collapse into one full-file URL.
const RANGE_PARAMS = ['range', 'rn', 'rbuf', 'bytestart', 'byteend', 'start_byte', 'end_byte'];
export function cleanFileUrl(u) {
  try {
    const url = new URL(u);
    let changed = false;
    for (const p of RANGE_PARAMS) if (url.searchParams.has(p)) { url.searchParams.delete(p); changed = true; }
    return changed ? url.href : u;
  } catch { return u; }
}

export function sanitizeFilename(name, fallback = 'video') {
  let s = String(name || '')
    .replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  if (!s) s = fallback;
  s = s.slice(0, 120).replace(/[.\s]+$/g, '');
  // Windows reserves these names even when a file extension is appended.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) s = '_' + s;
  return s || fallback;
}

export function formatBytes(n) {
  if (!n || n < 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function formatDuration(sec) {
  if (!sec || !isFinite(sec)) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = x => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Point Referer/Origin at the source page for requests made by this extension, so CDNs that
 * hotlink-protect still serve us. Best-effort: harmless if a server doesn't care.
 */
export async function setRefererRule({ ruleId, pageUrl, tabId, domains }) {
  if (!pageUrl || !/^https?:/.test(pageUrl)) return;
  const condition = {
    tabIds: [tabId],
    resourceTypes: ['xmlhttprequest', 'media', 'other']
  };
  if (domains && domains.length) condition.requestDomains = [...new Set(domains)].filter(Boolean);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [{
        id: ruleId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'set', value: pageUrl },
            { header: 'origin', operation: 'set', value: new URL(pageUrl).origin }
          ]
        },
        condition
      }]
    });
  } catch (e) {
    console.warn('[ClipHawk] referer rule failed', e);
  }
}

export async function fetchText(url, { timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { credentials: 'include', signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}
