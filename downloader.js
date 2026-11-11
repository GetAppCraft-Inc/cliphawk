import { fetchText, formatBytes, setRefererRule, sanitizeFilename } from './lib/common.js';
import { parseHls, pickAudio } from './lib/hls.js';
import { parseDash, dashTrackPlan } from './lib/dash.js';
import { fetchBytes, waitForDownload } from './lib/download.js';

const $ = s => document.querySelector(s);
const CONCURRENCY = 6;
const MIME = { ts: 'video/mp2t', mp4: 'video/mp4', m4a: 'audio/mp4', webm: 'video/webm', aac: 'audio/aac' };

const ctrl = new AbortController();
let ruleId = null;
let cancelled = false;

class EncryptedError extends Error {}

function setStatus(text, cls = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = cls;
}

// ---------- plans ----------
function hlsTrack(media, role) {
  if (media.encrypted) throw new EncryptedError(`Stream is encrypted (${media.keyMethod}) — skipped.`);
  if (!media.segments.length) throw new Error('Playlist has no segments');
  const first = media.segments[0].url;
  const fmp4 = !!media.map || /\.(m4s|mp4|m4v|cmfv|cmfa|m4a)(\?|$)/i.test(first);
  const ext = fmp4 ? (role === 'audio' ? 'm4a' : 'mp4') : (/\.aac(\?|$)/i.test(first) ? 'aac' : 'ts');
  return { role, ext, init: media.map, segments: media.segments, live: media.live };
}

async function planHls(job) {
  const pl = parseHls(await fetchText(job.url), job.url);
  if (pl.type !== 'master') return { label: '', tracks: [hlsTrack(pl, 'video')] };
  if (pl.encrypted) throw new EncryptedError(`Stream is encrypted (${pl.keyMethod}) — skipped.`);
  const v = pl.variants[job.variant] || pl.variants[0];
  if (!v) throw new Error('Master playlist has no variants');
  const tracks = [hlsTrack(parseHls(await fetchText(v.uri), v.uri), 'video')];
  const aud = pickAudio(pl, v);
  if (aud) tracks.push(hlsTrack(parseHls(await fetchText(aud.uri), aud.uri), 'audio'));
  return { label: v.label, tracks };
}

async function planDash(job) {
  const d = parseDash(await fetchText(job.url), job.url);
  if (d.encrypted) throw new EncryptedError('DASH stream has ContentProtection (DRM) — skipped.');
  if (d.live) throw new Error('Live DASH streams are not supported yet.');
  const tracks = [];
  const v = d.video[job.variant] || d.video[0];
  if (v) tracks.push(dashTrackPlan(v));
  if (d.audio[0]) tracks.push(dashTrackPlan(d.audio[0]));
  if (!tracks.length) throw new Error('No audio/video representations found');
  return { label: v?.label || 'audio', tracks };
}

// ---------- fetching ----------
async function fetchBuf(item, onBytes) {
  return fetchBytes(item, { signal: ctrl.signal, onBytes });
}

async function downloadTrack(track, ui) {
  const items = track.init ? [track.init, ...track.segments] : track.segments;
  if (!items.length) throw new Error('Stream has no downloadable segments');
  const parts = new Array(items.length);
  let next = 0, done = 0, bytes = 0;

  if (items.length === 1) {
    parts[0] = await fetchBuf(items[0], (got, total) => ui(total ? got / total : 0, `${formatBytes(got)}${total ? ` / ${formatBytes(total)}` : ''}`));
    ui(1, formatBytes(parts[0].byteLength));
    return parts;
  }

  const worker = async () => {
    while (!ctrl.signal.aborted) {
      const i = next++;
      if (i >= items.length) return;
      parts[i] = await fetchBuf(items[i]);
      done++;
      bytes += parts[i].byteLength;
      ui(done / items.length, `${done}/${items.length} chunks · ${formatBytes(bytes)}`);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  } catch (e) {
    ctrl.abort();
    throw e;
  }
  ctrl.signal.throwIfAborted();
  return parts;
}

function trackUi(track, idx) {
  const label = track.role === 'audio' ? 'Audio' : (idx === 0 ? 'Video' : `Track ${idx + 1}`);
  const right = document.createElement('span');
  right.textContent = 'waiting';
  const head = document.createElement('div');
  head.className = 'track-head';
  head.append(Object.assign(document.createElement('span'), { textContent: `${label} · .${track.ext}` }), right);
  const fill = Object.assign(document.createElement('div'), { className: 'fill' });
  const bar = Object.assign(document.createElement('div'), { className: 'bar' });
  bar.append(fill);
  const wrap = Object.assign(document.createElement('div'), { className: 'track' });
  wrap.append(head, bar);
  $('#tracks').append(wrap);
  return (frac, text) => { fill.style.width = `${Math.round(frac * 100)}%`; right.textContent = text; };
}

async function save(parts, filename, ext) {
  const blob = new Blob(parts, { type: MIME[ext] || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
    return await waitForDownload(id);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function showHint(files) {
  const v = files.find(f => f.role === 'video');
  const a = files.find(f => f.role === 'audio');
  const lines = [];
  if (v && a) {
    lines.push('Video and audio were saved separately. Merge them losslessly with ffmpeg:');
    lines.push(`ffmpeg -i "${v.name}" -i "${a.name}" -c copy "${v.name.replace(/\.[^.]+$/, '')} (merged).mp4"`);
  } else if (v && v.name.endsWith('.ts')) {
    lines.push('Saved as MPEG-TS (plays in VLC/mpv). To convert to MP4 without re-encoding:');
    lines.push(`ffmpeg -i "${v.name}" -c copy "${v.name.replace(/\.ts$/, '')}.mp4"`);
  }
  if (!lines.length) return;
  const hint = $('#hint');
  hint.hidden = false;
  const pre = document.createElement('pre');
  pre.textContent = lines.slice(1).join('\n');
  const p = Object.assign(document.createElement('p'), { className: 'note', textContent: lines[0] });
  hint.replaceChildren(p, pre);
}

async function run() {
  const id = new URLSearchParams(location.search).get('job');
  const job = (await chrome.storage.session.get(`job:${id}`))[`job:${id}`];
  if (!job) throw new Error('Download job not found (it may have expired). Start again from the popup.');

  $('#title').textContent = job.title;
  document.title = `ClipHawk · ${job.title}`;
  $('#source').textContent = job.url;

  const me = await chrome.tabs.getCurrent();
  if (me) {
    ruleId = 100 + (me.id % 100000);
    await setRefererRule({ ruleId, pageUrl: job.pageUrl, tabId: me.id });
  }

  const plan = job.kind === 'hls' ? await planHls(job) : await planDash(job);
  const uis = plan.tracks.map(trackUi);
  if (plan.tracks.some(t => t.live)) setStatus('Live stream — grabbing the segments available right now…');
  else setStatus('Downloading…');

  const base = sanitizeFilename(`${job.title}${plan.label ? ` [${plan.label.split(' · ')[0]}]` : ''}`);
  const files = [];
  for (let i = 0; i < plan.tracks.length; i++) {
    const t = plan.tracks[i];
    const parts = await downloadTrack(t, uis[i]);
    const suffix = plan.tracks.length > 1 ? (t.role === 'audio' ? ' (audio)' : ' (video)') : '';
    const name = `${base}${suffix}.${t.ext}`;
    setStatus(`Saving ${name}…`);
    const state = await save(parts, name, t.ext);
    if (state !== 'complete') throw new Error(`Browser could not save ${name}`);
    files.push({ role: t.role, name });
  }
  setStatus(`Done — saved ${files.map(f => f.name).join(' + ')}`, 'ok');
  $('#cancel').textContent = 'Close tab';
  showHint(files);
  await chrome.storage.session.remove(`job:${id}`);
}

$('#cancel').addEventListener('click', async () => {
  cancelled = true;
  ctrl.abort();
  const me = await chrome.tabs.getCurrent();
  if (me) chrome.tabs.remove(me.id);
});

window.addEventListener('beforeunload', () => {
  if (ruleId) chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
});

run().catch(e => {
  if (cancelled) return setStatus('Cancelled.', 'err');
  setStatus(e instanceof EncryptedError ? `🔒 ${e.message}` : `Failed: ${e.message || e}`, 'err');
  $('#cancel').textContent = 'Close tab';
}).finally(async () => {
  if (ruleId) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
});
