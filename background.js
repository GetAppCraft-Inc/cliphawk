// ClipHawk service worker: sniffs media requests per tab and keeps a candidate list.
import { classify, cleanFileUrl, isAdUrl, isAdHost } from './lib/common.js';

const tabKey = id => `tab:${id}`;
const cache = new Map();            // tabId -> Promise<{ items: {[url]: item}, seq: number }>
const flushTimers = new Map();

function loadTab(tabId) {
  if (!cache.has(tabId)) {
    cache.set(tabId, chrome.storage.session.get(tabKey(tabId))
      .then(o => o[tabKey(tabId)] || { items: {}, seq: 0 }));
  }
  return cache.get(tabId);
}

function scheduleFlush(tabId) {
  clearTimeout(flushTimers.get(tabId));
  flushTimers.set(tabId, setTimeout(async () => {
    flushTimers.delete(tabId);
    const t = await loadTab(tabId);
    await chrome.storage.session.set({ [tabKey(tabId)]: t }).catch(() => {});
    updateBadge(tabId, t);
  }, 300));
}

function updateBadge(tabId, t) {
  const n = Object.values(t.items).filter(i => !i.ad).length;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#ff8a00' }).catch(() => {});
}

async function resetTab(tabId) {
  clearTimeout(flushTimers.get(tabId));
  cache.set(tabId, Promise.resolve({ items: {}, seq: 0 }));
  await chrome.storage.session.remove(tabKey(tabId)).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

const header = (hs, name) => hs?.find(h => h.name.toLowerCase() === name)?.value;

async function onHeaders(d) {
  if (d.tabId < 0) return;
  if (d.type === 'main_frame') return resetTab(d.tabId);
  if (d.statusCode < 200 || d.statusCode >= 300) return;
  if (!/^https?:/.test(d.url)) return;

  const ct = header(d.responseHeaders, 'content-type');
  const kind = classify(d.url, ct);
  if (!kind) return;

  let size = Number(header(d.responseHeaders, 'content-length')) || 0;
  const cr = header(d.responseHeaders, 'content-range');
  const total = cr && /\/(\d+)\s*$/.exec(cr);
  if (total) size = Number(total[1]);
  // Tiny "videos" are tracking pixels / previews / byte-range probes.
  if (kind === 'file' && size && size < 200 * 1024) return;

  const url = kind === 'file' ? cleanFileUrl(d.url) : d.url;
  const t = await loadTab(d.tabId);
  const existing = t.items[url];
  if (existing) {
    existing.size = Math.max(existing.size || 0, size);
    existing.hits = (existing.hits || 1) + 1;
  } else {
    t.items[url] = {
      url,
      kind,
      size,
      contentType: ct || '',
      initiator: d.initiator || '',
      frameId: d.frameId,
      ad: isAdUrl(url) || isAdHost(d.initiator || ''),
      seq: ++t.seq,
      seen: Date.now(),
      hits: 1
    };
  }
  scheduleFlush(d.tabId);
}

chrome.webRequest.onHeadersReceived.addListener(
  d => { onHeaders(d).catch(e => console.warn('[ClipHawk]', e)); },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener(tabId => {
  cache.delete(tabId);
  chrome.storage.session.remove(tabKey(tabId)).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'get-tab') {
    loadTab(msg.tabId).then(t => sendResponse(Object.values(t.items)));
    return true;
  }
  if (msg?.type === 'clear-tab') {
    resetTab(msg.tabId).then(() => sendResponse(true));
    return true;
  }
});

// Clean up the popup's referer rule (id 1) once a direct download finishes.
chrome.downloads.onChanged.addListener(delta => {
  const st = delta.state?.current;
  if (st === 'complete' || st === 'interrupted') {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1] }).catch(() => {});
  }
});
