import { formatBytes, setRefererRule, sanitizeFilename, hostOf } from './lib/common.js';
import { parseHls, pickAudio } from './lib/hls.js';
import { parseDash, dashTrackPlan } from './lib/dash.js';
import { fetchBytes, waitForDownload, startDownload } from './lib/download.js';
import { PauseGate, fetchTrack, elapsedLabel } from './lib/transfer.js';
import { readPreferences, applyTheme } from './lib/preferences.js';

const $ = selector => document.querySelector(selector);
const MIME = { ts: 'video/mp2t', mp4: 'video/mp4', m4a: 'audio/mp4', webm: 'video/webm', aac: 'audio/aac' };
const jobId = new URLSearchParams(location.search).get('job');
let job, plan, ruleId, controller, gate, timer, activeDownload;
let busy = false, cancelled = false, activeRequests = 0, phase = 'preparing';
let startedAt = 0, transferred = 0;
const saved = new Map();

class EncryptedError extends Error {}

function setStatus(text, state = 'Downloading', tone = '') {
  // Avoid repeating live-region announcements for every chunk that starts or ends.
  if ($('#status').textContent !== text) $('#status').textContent = text;
  $('#status').className = tone;
  if ($('#state').textContent !== state) $('#state').textContent = state;
  $('#state').className = `state-pill ${tone}`;
}

function updateStats() {
  const seconds = startedAt ? (Date.now() - startedAt) / 1000 : 0;
  $('#transferred').textContent = formatBytes(transferred) || '0 B';
  $('#elapsed').textContent = elapsedLabel(seconds);
  $('#speed').textContent = phase === 'fetching' && gate?.paused && !activeRequests ? 'Paused'
    : transferred && seconds > 0 ? `${formatBytes(transferred / seconds)}/s` : '—';
}

function updatePauseStatus() {
  if (!busy || phase !== 'fetching' || cancelled) return;
  if (gate.paused) {
    setStatus(activeRequests ? `Finishing ${activeRequests} active request${activeRequests === 1 ? '' : 's'} before pausing…`
      : 'Paused. Resume when you are ready.', activeRequests ? 'Pausing' : 'Paused');
  } else {
    setStatus(plan?.tracks.some(track => track.live)
      ? 'Downloading the segments available in this live stream right now.' : 'Downloading your media…');
  }
  updateStats();
}

async function manifest(url, signal) {
  return new TextDecoder().decode(await fetchBytes({ url }, { signal, timeout: 15000 }));
}

function hlsTrack(media, role) {
  if (media.encrypted) throw new EncryptedError(`This stream is encrypted (${media.keyMethod}) and cannot be downloaded.`);
  if (!media.segments.length) throw new Error('Playlist has no segments');
  const first = media.segments[0].url;
  const fmp4 = !!media.map || /\.(m4s|mp4|m4v|cmfv|cmfa|m4a)(\?|$)/i.test(first);
  const ext = fmp4 ? (role === 'audio' ? 'm4a' : 'mp4') : (/\.aac(\?|$)/i.test(first) ? 'aac' : 'ts');
  return { role, ext, init: media.map, segments: media.segments, live: media.live };
}

async function planHls(signal) {
  const playlist = parseHls(await manifest(job.url, signal), job.url);
  if (playlist.type !== 'master') return { label: '', tracks: [hlsTrack(playlist, 'video')] };
  if (playlist.encrypted) throw new EncryptedError(`This stream is encrypted (${playlist.keyMethod}) and cannot be downloaded.`);
  const variant = playlist.variants[job.variant] || playlist.variants[0];
  if (!variant) throw new Error('Master playlist has no variants');
  const tracks = [hlsTrack(parseHls(await manifest(variant.uri, signal), variant.uri), 'video')];
  const audio = pickAudio(playlist, variant);
  if (audio) tracks.push(hlsTrack(parseHls(await manifest(audio.uri, signal), audio.uri), 'audio'));
  return { label: variant.label, tracks };
}

async function planDash(signal) {
  const dash = parseDash(await manifest(job.url, signal), job.url);
  if (dash.encrypted) throw new EncryptedError('This DASH stream has DRM protection and cannot be downloaded.');
  if (dash.live) throw new Error('Live DASH streams are not supported yet.');
  const tracks = [];
  const video = dash.video[job.variant] || dash.video[0];
  if (video) tracks.push(dashTrackPlan(video));
  if (dash.audio[0]) tracks.push(dashTrackPlan(dash.audio[0]));
  if (!tracks.length) throw new Error('No audio/video tracks found');
  return { label: video?.label || 'Audio', tracks };
}

function trackUi(track, index) {
  const label = track.role === 'audio' ? 'Audio' : 'Video';
  const wrap = document.createElement('div');
  wrap.className = 'download-track';
  const head = document.createElement('div');
  head.className = 'download-track-head';
  const name = Object.assign(document.createElement('span'), { className: 'download-track-name', textContent: `${label} · ${track.ext.toUpperCase()}` });
  const percent = Object.assign(document.createElement('span'), { className: 'download-track-percent', textContent: '0%' });
  head.append(name, percent);
  const bar = Object.assign(document.createElement('div'), { className: 'download-bar' });
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', `${label} download progress`);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const fill = Object.assign(document.createElement('div'), { className: 'download-fill' });
  bar.append(fill);
  const detail = Object.assign(document.createElement('div'), { className: 'download-track-detail', textContent: 'Waiting to start' });
  wrap.append(head, bar, detail);
  $('#tracks').append(wrap);
  const update = ({ fraction, bytes, completed, total }, text) => {
    const value = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    fill.style.width = `${value}%`;
    percent.textContent = `${value}%`;
    bar.setAttribute('aria-valuenow', String(value));
    detail.textContent = text || `${completed}/${total} chunks · ${formatBytes(bytes) || '0 B'}`;
  };
  if (saved.has(index)) update({ fraction: 1 }, 'Already saved');
  else bar.setAttribute('aria-valuenow', '0');
  return update;
}

async function save(parts, filename, ext, signal) {
  const url = URL.createObjectURL(new Blob(parts, { type: MIME[ext] || 'application/octet-stream' }));
  try {
    const id = await startDownload({ url, filename, conflictAction: 'uniquify', saveAs: !!job.saveAs });
    activeDownload = id;
    if (signal.aborted) await chrome.downloads.cancel(id).catch(() => {});
    const state = await waitForDownload(id);
    if (state !== 'complete') throw new Error(`Browser could not save ${filename}`);
    const items = await chrome.downloads.search({ id }).catch(() => []);
    return { id, name: items[0]?.filename?.split(/[\\/]/).pop() || filename };
  } finally {
    activeDownload = null;
    URL.revokeObjectURL(url);
  }
}

function showSavedFiles() {
  $('#saved').hidden = !saved.size;
  $('#files').replaceChildren();
  for (const file of saved.values()) {
    const row = Object.assign(document.createElement('div'), { className: 'saved-file' });
    const name = Object.assign(document.createElement('span'), { className: 'saved-file-name', textContent: file.name });
    const reveal = Object.assign(document.createElement('button'), { className: 'btn ghost', textContent: 'Show in folder' });
    reveal.addEventListener('click', async () => {
      try { await chrome.downloads.show(file.id); }
      catch { setStatus('Could not locate that file. Check your browser downloads.', 'File unavailable', 'err'); }
    });
    row.append(name, reveal);
    $('#files').append(row);
  }
  showHint();
}

function showHint() {
  const files = [...saved.values()];
  const video = files.find(file => file.role === 'video');
  const audio = files.find(file => file.role === 'audio');
  const windows = /Win/i.test(navigator.platform);
  const quote = value => `'${value.replaceAll("'", windows ? "''" : "'\\''")}'`;
  let command = '', description = '';
  if (video && audio) {
    command = `ffmpeg -i ${quote(video.name)} -i ${quote(audio.name)} -c copy ${quote(video.name.replace(/\.[^.]+$/, '') + ' (merged).mp4')}`;
    description = 'Your video and audio are saved separately. Combine them without re-encoding.';
  } else if (video?.name.endsWith('.ts')) {
    command = `ffmpeg -i ${quote(video.name)} -c copy ${quote(video.name.replace(/\.ts$/, '.mp4'))}`;
    description = 'This MPEG-TS file plays in VLC or mpv. You can also convert it to MP4 without re-encoding.';
  }
  $('#hint').hidden = !command;
  $('#command').textContent = command;
  $('#hint-description').textContent = `${description} With ffmpeg installed, run this in ${windows ? 'PowerShell' : 'your terminal'} from the folder containing both files (or adjust the paths).`;
}

async function run() {
  if (busy || !job) return;
  let canRetry = false;
  busy = true;
  cancelled = false;
  activeRequests = 0;
  phase = 'preparing';
  controller = new AbortController();
  gate = new PauseGate();
  startedAt = Date.now();
  transferred = 0;
  $('#retry').hidden = true;
  $('#close').hidden = true;
  $('#cancel').hidden = false;
  $('#cancel').disabled = false;
  $('#pause').hidden = false;
  $('#pause').disabled = true;
  $('#pause').textContent = 'Pause';
  $('#control-hint').textContent = 'Pause finishes active requests before stopping. Keep this tab open until saving is complete.';
  setStatus('Reading the stream manifest…', 'Preparing');
  updateStats();
  timer = setInterval(updateStats, 500);
  try {
    const me = await chrome.tabs.getCurrent();
    if (me) {
      ruleId = 100 + (me.id % 100000);
      await setRefererRule({ ruleId, pageUrl: job.pageUrl, tabId: me.id });
    }
    // Reuse the same snapshot on retry so saved video and a retried audio track stay aligned.
    if (!plan) plan = job.kind === 'hls' ? await planHls(controller.signal) : await planDash(controller.signal);
    controller.signal.throwIfAborted();
    $('#tracks').replaceChildren();
    const uis = plan.tracks.map(trackUi);
    const base = sanitizeFilename(`${job.title}${plan.label ? ` [${plan.label.split(' · ')[0]}]` : ''}`);
    for (let index = 0; index < plan.tracks.length; index++) {
      if (saved.has(index)) continue;
      phase = 'fetching';
      $('#pause').disabled = false;
      updatePauseStatus();
      const track = plan.tracks[index];
      const parts = await fetchTrack(track, {
        controller, gate, onProgress: uis[index],
        onBytes: bytes => { transferred += bytes; },
        onActive: count => { activeRequests = count; updatePauseStatus(); }
      });
      await gate.wait(controller.signal);
      phase = 'saving';
      $('#pause').disabled = true;
      const suffix = plan.tracks.length > 1 ? ` (${track.role})` : '';
      const name = `${base}${suffix}.${track.ext}`;
      setStatus(`Saving ${name}…`, 'Saving');
      const file = await save(parts, name, track.ext, controller.signal);
      saved.set(index, { ...file, role: track.role });
      uis[index]({ fraction: 1 }, 'Saved to your computer');
      showSavedFiles();
      controller.signal.throwIfAborted();
    }
    phase = 'complete';
    setStatus(`All done. ${saved.size} file${saved.size === 1 ? '' : 's'} saved to your computer.`, 'Complete', 'ok');
    $('#control-hint').textContent = 'Your files are ready. You can safely close this tab.';
    await chrome.storage.session.remove(`job:${jobId}`).catch(() => {});
  } catch (error) {
    phase = 'stopped';
    if (cancelled) setStatus('Download cancelled. Files already saved are kept.', 'Cancelled');
    else setStatus(error.message || String(error), error instanceof EncryptedError ? 'Protected stream' : 'Download failed', 'err');
    canRetry = !(error instanceof EncryptedError);
    $('#control-hint').textContent = error instanceof EncryptedError ? 'ClipHawk skips encrypted and DRM-protected streams.'
      : 'Retry restarts unfinished tracks. Saved files are kept. If the link expired, capture it again from the source page.';
  } finally {
    clearInterval(timer);
    updateStats();
    $('#pause').hidden = true;
    $('#cancel').hidden = true;
    if (ruleId) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
    busy = false;
    $('#retry').hidden = !canRetry;
    $('#close').hidden = false;
  }
}

$('#pause').addEventListener('click', () => {
  if (!busy || phase !== 'fetching') return;
  if (gate.paused) gate.resume(); else gate.pause();
  $('#pause').textContent = gate.paused ? 'Resume' : 'Pause';
  updatePauseStatus();
});

$('#cancel').addEventListener('click', async () => {
  if (!busy) return;
  cancelled = true;
  $('#cancel').disabled = true;
  $('#pause').disabled = true;
  setStatus('Stopping active requests…', 'Cancelling');
  controller.abort();
  if (activeDownload != null) await chrome.downloads.cancel(activeDownload).catch(() => {});
});

$('#retry').addEventListener('click', () => { void run(); });
$('#close').addEventListener('click', async () => {
  const me = await chrome.tabs.getCurrent();
  if (me) await chrome.tabs.remove(me.id);
});
$('#copy-command').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#command').textContent);
    $('#copy-status').textContent = 'Command copied.';
  } catch { $('#copy-status').textContent = 'Could not copy the command. Select and copy the text above.'; }
});

window.addEventListener('beforeunload', () => {
  controller?.abort();
  clearInterval(timer);
  if (ruleId) chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
  chrome.storage.session.remove(`job:${jobId}`).catch(() => {});
});

async function initialize() {
  const preferences = await readPreferences().catch(() => ({ theme: 'system' }));
  applyTheme(preferences.theme);
  job = (await chrome.storage.session.get(`job:${jobId}`))[`job:${jobId}`];
  if (!job) throw new Error('This download job has expired. Start a new download from ClipHawk.');
  $('#title').textContent = job.title;
  document.title = `ClipHawk · ${job.title}`;
  $('#source').textContent = hostOf(job.url);
  $('#source').title = job.url;
  $('#format').textContent = job.kind.toUpperCase();
  await run();
}

initialize().catch(error => {
  setStatus(error.message || String(error), 'Unable to start', 'err');
  $('#pause').hidden = true;
  $('#cancel').hidden = true;
  $('#close').hidden = false;
});
