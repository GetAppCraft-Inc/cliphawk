import {
  classify, isAdUrl, hostOf, extOf, sanitizeFilename, formatBytes, formatDuration,
  setRefererRule, fetchText
} from './lib/common.js';
import { parseHls } from './lib/hls.js';
import { parseDash } from './lib/dash.js';
import { DEFAULT_PREFERENCES, readPreferences, savePreferences, applyTheme, preferredVariant } from './lib/preferences.js';
import { canDownload, selectCandidates } from './lib/candidates.js';

const $ = s => document.querySelector(s);
let preferences = { ...DEFAULT_PREFERENCES };
let scanning = false;
let state = { candidates: [], frames: [], ctx: null, cards: new Map() };
let filterKind = 'all';

function notice(message, error = false) {
  $('#notice').hidden = !message;
  $('#notice').textContent = message;
  $('#notice').className = error ? 'notice err' : 'notice';
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

// ---------- DOM scan (runs inside every frame of the page) ----------
function collectDom() {
  const AD_RE = /(^|[\s_\-])(ad|ads|adv|advert|advertisement|preroll|midroll|sponsor|sponsored|ima|vast|vpaid|outstream|dfp|gpt)([\s_\-]|$)/i;
  const vw = innerWidth, vh = innerHeight;
  const videos = [...document.querySelectorAll('video')].map(v => {
    const r = v.getBoundingClientRect();
    const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    let adCtx = false;
    for (let el = v, i = 0; el && i < 8; el = el.parentElement, i++) {
      const s = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
      if (AD_RE.test(s)) { adCtx = true; break; }
    }
    const srcs = [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map(s => s.src)]
      .filter(u => u && /^https?:/.test(u));
    return {
      srcs: [...new Set(srcs)],
      blob: /^blob:/.test(v.currentSrc || v.src || ''),
      width: Math.round(r.width), height: Math.round(r.height),
      visibleArea: Math.round(visW * visH),
      duration: Number.isFinite(v.duration) ? v.duration : null,
      paused: v.paused, muted: v.muted, loop: v.loop,
      videoHeight: v.videoHeight, adCtx
    };
  });
  const root = document.documentElement;
  return {
    url: location.href,
    title: document.title,
    drm: root.getAttribute('data-cliphawk-drm'),
    mse: root.hasAttribute('data-cliphawk-mse'),
    videos
  };
}

// ---------- analysis ----------
async function analyze(c) {
  const info = { duration: null, variants: [], encrypted: false, live: false, note: '', error: '' };
  try {
    if (c.kind === 'hls') {
      const pl = parseHls(await fetchText(c.url), c.url);
      if (pl.type === 'master') {
        info.variants = pl.variants.map(v => v.label);
        info.encrypted = pl.encrypted;
        info.height = pl.variants[0]?.height || 0;
        info.separateAudio = pl.media.some(m => m.type === 'AUDIO' && m.uri);
        if (pl.variants[0]) {
          const media = parseHls(await fetchText(pl.variants[0].uri), pl.variants[0].uri);
          fillMedia(info, media);
        }
        info.childUrls = pl.variants.map(v => v.uri).concat(pl.media.map(m => m.uri).filter(Boolean));
      } else {
        fillMedia(info, pl);
      }
    } else if (c.kind === 'dash') {
      const d = parseDash(await fetchText(c.url), c.url);
      info.encrypted = d.encrypted;
      info.live = d.live;
      info.duration = d.duration || null;
      info.variants = d.video.map(v => v.label);
      info.height = d.video[0]?.height || 0;
      info.separateAudio = d.audio.length > 0 && d.video.length > 0;
      if (!d.video.length && d.audio.length) info.note = 'Audio only';
      if (d.periods > 1) info.note = `${d.periods} periods — longest kept (others are often ads)`;
    }
  } catch (e) {
    info.error = `Couldn't read manifest: ${e.message || e}`;
  }
  c.info = info;
  return c;
}

function fillMedia(info, media) {
  info.duration = media.duration || null;
  info.live = media.live;
  if (media.encrypted) {
    info.encrypted = true;
    info.keyMethod = media.keyMethod;
  }
  if (media.discontinuities > 2) info.note = `${media.discontinuities} discontinuities — may include stitched-in ads`;
}

// ---------- ranking: find the main video, demote ads ----------
function rank(cands, frames) {
  const dom = frames.flatMap(f => f.videos);
  const visible = dom.filter(v => !v.adCtx && v.visibleArea > 0).sort((a, b) => b.visibleArea - a.visibleArea);
  const mainDom = visible[0];

  for (const c of cands) {
    let s = 0;
    const why = [];
    const d = c.info?.duration;

    if (c.ad) { s -= 100; why.push('ad server / ad path'); }

    const dv = dom.find(v => v.srcs.includes(c.url));
    if (dv) {
      if (dv.adCtx) { s -= 60; why.push('inside ad container'); }
      else { s += 30 + Math.min(40, dv.visibleArea / 15000); why.push('playing in page'); }
      if (!d && dv.duration) c.info.duration = dv.duration;
    }

    const dur = c.info?.duration;
    if (dur) {
      if (dur >= 600) s += 45;
      else if (dur >= 180) s += 30;
      else if (dur >= 60) s += 12;
      else if (dur <= 35) { s -= 35; why.push('ad-length (≤35s)'); }
      else s -= 10;
      if (mainDom?.duration && dur >= 60 && Math.abs(mainDom.duration - dur) < 3) { s += 40; why.push('matches main player'); }
    }

    if (c.size) {
      const mb = c.size / 1048576;
      if (mb > 50) s += 25; else if (mb > 10) s += 10; else if (mb < 2) s -= 15;
    }
    if ((c.info?.variants?.length || 0) > 1) s += 15;
    if (c.kind !== 'file') s += 5;
    if (c.info?.error) s -= 20;

    c.score = Math.round(s);
    c.why = why;
    c.likelyAd = c.ad || s <= -25 || (dv && dv.adCtx);
  }
  cands.sort((a, b) => b.score - a.score || (b.size || 0) - (a.size || 0));
  return cands;
}

// ---------- download ----------
async function startDownload(c, variantIdx, ctx) {
  const title = sanitizeFilename(ctx.title || hostOf(ctx.pageUrl));
  if (c.kind === 'file') {
    let ext = extOf(c.url);
    if (!ext) ext = /webm/.test(c.contentType) ? 'webm' : 'mp4';
    await setRefererRule({ ruleId: 1, pageUrl: ctx.pageUrl, tabId: chrome.tabs.TAB_ID_NONE, domains: [hostOf(c.url)] });
    await chrome.downloads.download({ url: c.url, filename: `${title}.${ext}`, conflictAction: 'uniquify', saveAs: preferences.saveAs });
    return 'Download started';
  }
  const id = crypto.randomUUID();
  const job = { id, kind: c.kind, url: c.url, variant: variantIdx, pageUrl: ctx.pageUrl, title, saveAs: preferences.saveAs };
  await chrome.storage.session.set({ [`job:${id}`]: job });
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`downloader.html?job=${id}`), active: true, index: ctx.tabIndex + 1 });
  } catch (error) {
    await chrome.storage.session.remove(`job:${id}`);
    throw error;
  }
  return 'Opened downloader';
}

// ---------- render ----------
function shortUrl(u) {
  try {
    const x = new URL(u);
    const file = x.pathname.split('/').filter(Boolean).pop() || '';
    return `${x.hostname} / ${file || x.pathname}`;
  } catch { return u; }
}

function card(c, ctx, isMain) {
  const i = c.info || {};
  const kindLabel = { hls: 'HLS', dash: 'DASH', file: (extOf(c.url) || 'video').toUpperCase() }[c.kind];
  const blocked = !canDownload(c);

  const tags = h('div', { class: 'tags' },
    isMain && h('span', { class: 'tag star' }, '★ TOP PICK'),
    h('span', { class: 'tag kind' }, kindLabel),
    i.height ? h('span', { class: 'tag' }, `${i.height}p`) : null,
    i.encrypted && h('span', { class: 'tag lock' }, `🔒 Encrypted${i.keyMethod ? ` (${i.keyMethod})` : ''}`),
    i.live && h('span', { class: 'tag live' }, '● Live'),
    c.likelyAd && h('span', { class: 'tag ad' }, 'Likely ad'),
    c.fromDom && h('span', { class: 'tag' }, 'In page')
  );

  const meta = [
    formatDuration(i.duration),
    i.variants?.length > 1 ? `${i.variants.length} qualities` : '',
    formatBytes(c.size),
    i.separateAudio ? 'separate audio track' : ''
  ].filter(Boolean);

  let select = null;
  if (i.variants?.length > 1 && !blocked) {
    select = h('select', { 'aria-label': 'Video quality' }, i.variants.map((label, idx) => h('option', { value: idx }, label)));
    select.value = String(preferredVariant(i.variants, preferences.quality));
  }

  const status = h('div', { class: 'note', role: 'status' });
  const dlBtn = h('button', {
    class: 'btn download-btn',
    disabled: blocked,
    onclick: async () => {
      dlBtn.disabled = true;
      try {
        status.className = 'note';
        status.textContent = await startDownload(c, select ? Number(select.value) : 0, ctx);
        dlBtn.textContent = 'Started ✓';
      } catch (e) {
        status.className = 'note err';
        status.textContent = `Failed: ${e.message || e}`;
        dlBtn.disabled = false;
      }
    }
  }, blocked ? 'Unavailable' : 'Download ↓');

  const copyBtn = h('button', {
    class: 'btn ghost',
    title: 'Copy URL',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(c.url);
        copyBtn.textContent = 'Copied';
        setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
      } catch {
        status.className = 'note err';
        status.textContent = 'Could not copy the URL. Check clipboard access and try again.';
      }
    }
  }, 'Copy');

  let name;
  try { name = decodeURIComponent(new URL(c.url).pathname.split('/').filter(Boolean).pop() || 'Video'); } catch { name = 'Video'; }
  return h('article', { class: `card${isMain ? ' main' : ''}`, 'aria-label': `${kindLabel}: ${name}` },
    tags,
    h('div', { class: 'card-heading' }, h('span', { class: 'media-mark', 'aria-hidden': 'true' }, '▶'),
      h('div', { class: 'media-heading' }, h('h2', { class: 'media-title', title: isMain ? ctx.title : name }, isMain ? (ctx.title || name) : name),
        h('div', { class: 'url', title: c.url }, shortUrl(c.url)))),
    meta.length > 0 && h('div', { class: 'meta' }, meta.map(text => h('span', {}, text))),
    i.encrypted && h('div', { class: 'note' }, 'This stream is protected and cannot be downloaded.'),
    c.kind === 'dash' && i.live && h('div', { class: 'note' }, 'Live DASH downloads are not supported.'),
    i.error && h('div', { class: 'note err' }, i.error),
    i.note && h('div', { class: 'note' }, i.note),
    c.why?.length ? h('details', { class: 'details' }, h('summary', {}, 'Detection details'), h('div', { class: 'note' }, c.why.join(' · '))) : null,
    h('div', { class: 'actions' }, select, copyBtn, dlBtn),
    status
  );
}

function renderEmpty(frames) {
  const mse = frames.some(f => f.mse);
  const hasBlob = frames.some(f => f.videos.some(v => v.blob));
  $('#list').replaceChildren(h('div', { class: 'empty' },
    h('span', { class: 'empty-symbol', 'aria-hidden': 'true' }, '◎'),
    h('b', {}, 'No videos detected yet'),
    h('p', {}, hasBlob || mse
      ? 'This player streams via MediaSource. Reload the page and press play so ClipHawk can catch the stream manifest.'
      : 'Press play on the page, then select Rescan. If the page was open before installing, reload it.')
  ));
}

function visibleCandidates() {
  return selectCandidates(state.candidates, {
    query: $('#search').value, kind: filterKind, sort: $('#sort').value, readyOnly: $('#ready-only').checked
  });
}

function resetFilters() {
  $('#search').value = '';
  $('#ready-only').checked = false;
  filterKind = 'all';
  updateFilterButtons();
  render();
}

function updateFilterButtons() {
  for (const button of document.querySelectorAll('[data-kind]')) {
    const selected = button.dataset.kind === filterKind;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}

function render() {
  if (scanning) return;
  const visible = visibleCandidates();
  const real = visible.filter(c => !c.likelyAd);
  const ads = visible.filter(c => c.likelyAd);
  const ready = state.candidates.filter(c => !c.likelyAd && canDownload(c));
  $('#count').textContent = String(state.candidates.length);
  $('#stats').textContent = `${visible.length} of ${state.candidates.length} shown · ${ready.length} ready`;
  $('#copy-all').disabled = !real.some(canDownload);
  $('#copy-all').title = 'Copy downloadable links in this filter, excluding likely ads';
  $('#clear').disabled = !state.candidates.length;
  const list = $('#list');
  list.replaceChildren();
  if (!state.candidates.length) return renderEmpty(state.frames);
  if (!visible.length) {
    list.append(h('div', { class: 'empty' }, h('span', { class: 'empty-symbol', 'aria-hidden': 'true' }, '⌕'),
      h('b', {}, 'No matching videos'), h('p', {}, 'Try another search or show all formats.'),
      h('button', { class: 'btn ghost', onclick: resetFilters }, 'Reset filters')));
    return;
  }
  const best = state.candidates.find(c => !c.likelyAd && canDownload(c)) || state.candidates.find(c => !c.likelyAd);
  const cachedCard = c => {
    if (!state.cards.has(c.url)) state.cards.set(c.url, card(c, state.ctx, c === best));
    return state.cards.get(c.url);
  };
  real.forEach(c => list.append(cachedCard(c)));
  if (!real.length && ads.length) list.append(h('div', { class: 'empty' }, h('b', {}, 'Only likely ads match'), h('p', {}, 'Play the main video and rescan, or review the captured clips below.')));
  if (ads.length) list.append(h('details', { class: 'ad-group' }, h('summary', {}, `Likely ads · ${ads.length}`), ads.map(cachedCard)));
}

async function scan() {
  if (scanning) return;
  scanning = true;
  $('#rescan').disabled = true;
  $('#clear').disabled = true;
  $('#copy-all').disabled = true;
  $('#list').setAttribute('aria-busy', 'true');
  $('#banner').hidden = true;
  notice('');
  $('#stats').textContent = 'Scanning…';
  $('#list').replaceChildren(h('div', { class: 'empty pulse' }, h('b', {}, 'Looking for videos…')));
  try {
    await scanPage();
  } catch (e) {
    $('#list').replaceChildren(h('div', { class: 'empty' }, h('b', {}, 'Couldn’t scan this page'), h('p', {}, String(e.message || e))));
    $('#stats').textContent = 'Scan failed · try again';
  } finally {
    scanning = false;
    $('#rescan').disabled = false;
    $('#list').setAttribute('aria-busy', 'false');
  }
}

async function scanPage() {
  state = { candidates: [], frames: [], ctx: null, cards: new Map() };
  $('#count').textContent = '0';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found. Open a video page and try again.');
  $('#page').textContent = tab.title || tab.url || '';
  $('#page').title = tab.title || '';
  $('#site').textContent = hostOf(tab.url) || 'CURRENT TAB';

  let frames = [];
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: collectDom });
    frames = res.map(r => r.result).filter(Boolean);
  } catch {
    throw new Error('Browser pages and the Web Store cannot be scanned. Open a website with a video.');
  }

  const net = (await chrome.runtime.sendMessage({ type: 'get-tab', tabId: tab.id })) || [];
  const byUrl = new Map(net.map(n => [n.url, { ...n }]));
  for (const f of frames) for (const v of f.videos) for (const src of v.srcs) {
    if (!byUrl.has(src)) {
      byUrl.set(src, { url: src, kind: classify(src, '') || 'file', size: 0, contentType: '', ad: isAdUrl(src) || v.adCtx, fromDom: true });
    }
  }
  let cands = [...byUrl.values()];

  const drm = frames.find(f => f.drm)?.drm;
  if (drm) {
    const banner = $('#banner');
    banner.hidden = false;
    banner.textContent = `🔒 This page uses DRM (${drm}). Protected streams are skipped.`;
  }

  state.frames = frames;
  state.ctx = { pageUrl: tab.url, title: tab.title, tabIndex: tab.index, tabId: tab.id };

  $('#list').replaceChildren(h('div', { class: 'empty pulse' }, `Analyzing ${cands.length} candidate${cands.length > 1 ? 's' : ''}…`));

  const pageUrl = tab.url;
  if (cands.length) {
    await setRefererRule({ ruleId: 2, pageUrl, tabId: chrome.tabs.TAB_ID_NONE, domains: cands.map(c => hostOf(c.url)) });
    try {
      for (let offset = 0; offset < cands.length; offset += 4) await Promise.all(cands.slice(offset, offset + 4).map(analyze));
    } finally {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [2] }).catch(() => {});
    }
  }

  // Hide HLS variant/audio playlists that belong to a captured master playlist.
  const children = new Set(cands.flatMap(c => c.info?.childUrls || []));
  cands = cands.filter(c => !children.has(c.url));

  rank(cands, frames);
  const topPick = cands.find(c => !c.likelyAd && canDownload(c)) || cands.find(c => !c.likelyAd);
  if (topPick) topPick.title = tab.title || '';

  state.candidates = cands;
  scanning = false;
  render();
}

$('#rescan').addEventListener('click', scan);
$('#search').addEventListener('input', render);
$('#sort').addEventListener('change', render);
$('#ready-only').addEventListener('change', render);
for (const button of document.querySelectorAll('[data-kind]')) button.addEventListener('click', () => {
  filterKind = button.dataset.kind;
  updateFilterButtons();
  render();
});
$('#copy-all').addEventListener('click', async () => {
  const urls = visibleCandidates().filter(c => !c.likelyAd && canDownload(c)).map(c => c.url);
  if (!urls.length) return;
  try {
    await navigator.clipboard.writeText(urls.join('\n'));
    notice(`Copied ${urls.length} downloadable link${urls.length === 1 ? '' : 's'}.`);
  } catch { notice('Could not copy links. Check clipboard access and try again.', true); }
});
$('#clear').addEventListener('click', async () => {
  if (!state.ctx || scanning) return;
  try {
    await chrome.runtime.sendMessage({ type: 'clear-tab', tabId: state.ctx.tabId });
    state.candidates = [];
    state.cards.clear();
    render();
    notice('Captured list cleared. Rescan to check the page again.');
  } catch { notice('Could not clear captured videos. Try again.', true); }
});

$('#settings-toggle').addEventListener('click', () => {
  const open = $('#settings').hidden;
  $('#settings').hidden = !open;
  $('#settings-toggle').setAttribute('aria-expanded', String(open));
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('#settings').hidden) {
    $('#settings').hidden = true;
    $('#settings-toggle').setAttribute('aria-expanded', 'false');
    $('#settings-toggle').focus();
    event.preventDefault();
  }
});
document.addEventListener('click', event => {
  if (!$('#settings').hidden && !$('#settings').contains(event.target) && !$('#settings-toggle').contains(event.target)) {
    $('#settings').hidden = true;
    $('#settings-toggle').setAttribute('aria-expanded', 'false');
  }
});
let preferenceWrite = Promise.resolve();
for (const id of ['theme', 'quality', 'save-as']) $(`#${id}`).addEventListener('change', () => {
  preferences = { theme: $('#theme').value, quality: $('#quality').value, saveAs: $('#save-as').checked };
  applyTheme(preferences.theme);
  if (id === 'quality') {
    for (const c of state.candidates) {
      const select = state.cards.get(c.url)?.querySelector('select');
      if (select) select.value = String(preferredVariant(c.info.variants, preferences.quality));
    }
  }
  const next = { ...preferences };
  preferenceWrite = preferenceWrite.catch(() => {}).then(() => savePreferences(next)).then(() => {
    $('#settings-status').textContent = 'Preferences saved';
    $('#settings-status').className = 'note';
  }).catch(() => {
    $('#settings-status').textContent = 'Could not save preferences. Try again.';
    $('#settings-status').className = 'note err';
  });
});

async function init() {
  $('#version').textContent = `v${chrome.runtime.getManifest().version}`;
  try { preferences = await readPreferences(); } catch { /* Use defaults if local storage is unavailable. */ }
  applyTheme(preferences.theme);
  $('#theme').value = preferences.theme;
  $('#quality').value = preferences.quality;
  $('#save-as').checked = preferences.saveAs;
  await scan();
}
init().catch(e => notice(String(e.message || e), true));
