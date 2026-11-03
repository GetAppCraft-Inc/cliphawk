import {
  classify, isAdUrl, hostOf, extOf, sanitizeFilename, formatBytes, formatDuration,
  setRefererRule, fetchText
} from './lib/common.js';
import { parseHls } from './lib/hls.js';
import { parseDash } from './lib/dash.js';

const $ = s => document.querySelector(s);

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
    await chrome.downloads.download({ url: c.url, filename: `${title}.${ext}`, conflictAction: 'uniquify' });
    return 'Download started';
  }
  const id = crypto.randomUUID();
  const job = { id, kind: c.kind, url: c.url, variant: variantIdx, pageUrl: ctx.pageUrl, title };
  await chrome.storage.session.set({ [`job:${id}`]: job });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`downloader.html?job=${id}`), active: true, index: ctx.tabIndex + 1 });
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
  const blocked = i.encrypted || !!i.error;

  const tags = h('div', { class: 'tags' },
    isMain && h('span', { class: 'tag star' }, '★ Main video'),
    h('span', { class: 'tag kind' }, kindLabel),
    i.height ? h('span', { class: 'tag' }, `${i.height}p`) : null,
    i.encrypted && h('span', { class: 'tag lock' }, `🔒 Encrypted${i.keyMethod ? ` (${i.keyMethod})` : ''}`),
    i.live && h('span', { class: 'tag live' }, '● Live'),
    c.likelyAd && h('span', { class: 'tag ad' }, 'Likely ad'),
    c.fromDom && h('span', { class: 'tag' }, 'from <video>')
  );

  const meta = [
    formatDuration(i.duration),
    i.variants?.length > 1 ? `${i.variants.length} qualities` : '',
    formatBytes(c.size),
    i.separateAudio ? 'separate audio track' : ''
  ].filter(Boolean).join(' · ');

  let select = null;
  if (i.variants?.length > 1 && !blocked) {
    select = h('select', {}, i.variants.map((label, idx) => h('option', { value: idx }, label)));
  }

  const status = h('div', { class: 'note' });
  const dlBtn = h('button', {
    class: 'btn',
    disabled: blocked,
    onclick: async () => {
      dlBtn.disabled = true;
      try {
        status.className = 'note';
        status.textContent = await startDownload(c, select ? Number(select.value) : 0, ctx);
      } catch (e) {
        status.className = 'note err';
        status.textContent = `Failed: ${e.message || e}`;
        dlBtn.disabled = false;
      }
    }
  }, i.encrypted ? 'Skipped' : 'Download');

  const copyBtn = h('button', {
    class: 'btn ghost',
    title: 'Copy URL',
    onclick: async () => {
      await navigator.clipboard.writeText(c.url);
      copyBtn.textContent = 'Copied';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
    }
  }, 'Copy');

  return h('div', { class: `card${isMain ? ' main' : ''}` },
    tags,
    h('div', { class: 'url', title: c.url }, shortUrl(c.url)),
    meta && h('div', { class: 'meta' }, meta),
    i.encrypted && h('div', { class: 'note' }, 'Encrypted chunks — skipped for now.'),
    i.error && h('div', { class: 'note err' }, i.error),
    i.note && h('div', { class: 'note' }, i.note),
    c.why?.length ? h('div', { class: 'note' }, `Why: ${c.why.join(', ')}`) : null,
    h('div', { class: 'actions' }, select, copyBtn, dlBtn),
    status
  );
}

function renderEmpty(frames) {
  const mse = frames.some(f => f.mse);
  const hasBlob = frames.some(f => f.videos.some(v => v.blob));
  $('#list').replaceChildren(h('div', { class: 'empty' },
    h('b', {}, 'No videos detected yet'),
    hasBlob || mse
      ? 'This player streams via MediaSource. Reload the page and press play so ClipHawk can catch the stream manifest.'
      : 'Press play on the video, then open ClipHawk again. If the page was open before installing, reload it.'
  ));
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  $('#page').textContent = tab.title || tab.url || '';

  let frames = [];
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: collectDom });
    frames = res.map(r => r.result).filter(Boolean);
  } catch {
    $('#list').replaceChildren(h('div', { class: 'empty' }, h('b', {}, 'Can’t scan this page'), 'Browser pages and the Web Store are off-limits to extensions.'));
    return;
  }

  const net = (await chrome.runtime.sendMessage({ type: 'get-tab', tabId: tab.id })) || [];
  const byUrl = new Map(net.map(n => [n.url, { ...n }]));
  for (const f of frames) for (const v of f.videos) for (const src of v.srcs) {
    if (!byUrl.has(src)) {
      byUrl.set(src, { url: src, kind: classify(src, '') || 'file', size: 0, contentType: '', ad: isAdUrl(src) || v.adCtx, fromDom: true });
    }
  }
  let cands = [...byUrl.values()];
  $('#stats').textContent = `${net.length} stream${net.length === 1 ? '' : 's'} captured`;

  const drm = frames.find(f => f.drm)?.drm;
  if (drm) {
    const banner = $('#banner');
    banner.hidden = false;
    banner.textContent = `🔒 This page uses DRM (${drm}). Protected streams are skipped.`;
  }

  if (!cands.length) return renderEmpty(frames);

  $('#list').replaceChildren(h('div', { class: 'empty pulse' }, `Analyzing ${cands.length} candidate${cands.length > 1 ? 's' : ''}…`));

  const pageUrl = tab.url;
  await setRefererRule({ ruleId: 2, pageUrl, tabId: chrome.tabs.TAB_ID_NONE, domains: cands.map(c => hostOf(c.url)) });
  await Promise.all(cands.map(analyze));

  // Hide HLS variant/audio playlists that belong to a captured master playlist.
  const children = new Set(cands.flatMap(c => c.info?.childUrls || []));
  cands = cands.filter(c => !children.has(c.url));

  rank(cands, frames);

  const ctx = { pageUrl, title: tab.title, tabIndex: tab.index };
  const ads = cands.filter(c => c.likelyAd);
  const real = cands.filter(c => !c.likelyAd);
  const main = real[0];
  const list = $('#list');
  list.replaceChildren();

  if (main) {
    list.append(card(main, ctx, true));
  } else {
    list.append(h('div', { class: 'empty' }, h('b', {}, 'Only ad videos found'), 'Let the ad finish, play the actual video, then rescan.'));
  }
  const others = real.slice(1);
  if (others.length) {
    list.append(h('div', { class: 'section-title' }, `Other videos (${others.length})`));
    others.forEach(c => list.append(card(c, ctx, false)));
  }
  if (ads.length) {
    list.append(h('details', {}, h('summary', {}, `Likely ads (${ads.length})`), ads.map(c => card(c, ctx, false))));
  }
}

$('#rescan').addEventListener('click', () => location.reload());
$('#clear').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await chrome.runtime.sendMessage({ type: 'clear-tab', tabId: tab.id });
  location.reload();
});

main().catch(e => {
  $('#list').replaceChildren(h('div', { class: 'empty' }, h('b', {}, 'Something went wrong'), String(e.message || e)));
});
