// Minimal MPEG-DASH (.mpd) parser. Needs DOMParser, so use it from extension pages, not the service worker.

const kids = (el, name) => el ? [...el.children].filter(c => c.localName === name) : [];
const kid = (el, name) => kids(el, name)[0] || null;

export function parseIsoDuration(s) {
  if (!s) return 0;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s.trim());
  if (!m) return 0;
  const [, d, h, mi, se] = m.map(x => parseFloat(x) || 0);
  return d * 86400 + h * 3600 + mi * 60 + se;
}

function resolveBase(chain, mpdUrl) {
  let base = mpdUrl;
  for (const el of chain) {
    const b = kid(el, 'BaseURL');
    if (b && b.textContent.trim()) base = new URL(b.textContent.trim(), base).href;
  }
  return base;
}

function mergedTemplate(chain) {
  let attrs = null, timeline = null;
  for (const el of chain) {
    const t = kid(el, 'SegmentTemplate');
    if (!t) continue;
    attrs = { ...(attrs || {}) };
    for (const a of t.attributes) attrs[a.name] = a.value;
    const tl = kid(t, 'SegmentTimeline');
    if (tl) timeline = tl;
  }
  return attrs ? { attrs, timeline } : null;
}

function nearest(chain, name) {
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = kid(chain[i], name);
    if (n) return n;
  }
  return null;
}

function trackType(as, rep) {
  const ct = rep.getAttribute('contentType') || as.getAttribute('contentType') || '';
  const mt = rep.getAttribute('mimeType') || as.getAttribute('mimeType') || '';
  if (ct === 'video' || mt.startsWith('video/')) return 'video';
  if (ct === 'audio' || mt.startsWith('audio/')) return 'audio';
  return 'other';
}

export function parseDash(text, mpdUrl) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const mpd = doc.documentElement;
  if (!mpd || mpd.localName !== 'MPD') throw new Error('Not a DASH manifest');

  const encrypted = doc.getElementsByTagNameNS('*', 'ContentProtection').length > 0;
  const live = mpd.getAttribute('type') === 'dynamic';
  const totalDuration = parseIsoDuration(mpd.getAttribute('mediaPresentationDuration'));

  // Multi-period manifests often splice ads in as separate periods: keep the longest one.
  const periods = kids(mpd, 'Period');
  let period = periods[0], periodDur = 0;
  for (const p of periods) {
    const d = parseIsoDuration(p.getAttribute('duration')) || (periods.length === 1 ? totalDuration : 0);
    if (d > periodDur) { periodDur = d; period = p; }
  }
  if (!periodDur) periodDur = totalDuration;
  if (!period) throw new Error('DASH manifest has no Period');

  const video = [], audio = [];
  for (const as of kids(period, 'AdaptationSet')) {
    for (const rep of kids(as, 'Representation')) {
      const type = trackType(as, rep);
      if (type === 'other') continue;
      const chain = [mpd, period, as, rep];
      const mime = rep.getAttribute('mimeType') || as.getAttribute('mimeType') || (type === 'video' ? 'video/mp4' : 'audio/mp4');
      const r = {
        id: rep.getAttribute('id') || '',
        type,
        mime,
        bandwidth: Number(rep.getAttribute('bandwidth') || 0),
        width: Number(rep.getAttribute('width') || as.getAttribute('width') || 0),
        height: Number(rep.getAttribute('height') || as.getAttribute('height') || 0),
        codecs: rep.getAttribute('codecs') || as.getAttribute('codecs') || '',
        lang: as.getAttribute('lang') || '',
        base: resolveBase(chain, mpdUrl),
        template: mergedTemplate([period, as, rep]),
        list: nearest([period, as, rep], 'SegmentList'),
        periodDur
      };
      (type === 'video' ? video : audio).push(r);
    }
  }
  video.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  audio.sort((a, b) => b.bandwidth - a.bandwidth);
  video.forEach((v, i) => {
    v.label = [v.height ? `${v.height}p` : `Track ${i + 1}`, v.bandwidth ? `${(v.bandwidth / 1e6).toFixed(1)} Mbps` : '']
      .filter(Boolean).join(' · ');
  });
  return { encrypted, live, duration: totalDuration || periodDur, video, audio, periods: periods.length };
}

function fill(tpl, vals) {
  return tpl
    .replace(/\$(RepresentationID|Number|Time|Bandwidth)(?:%0(\d+)d)?\$/g, (_, k, w) => {
      let v = String(vals[k] ?? '');
      if (w) v = v.padStart(Number(w), '0');
      return v;
    })
    .replace(/\$\$/g, '$');
}

function parseRange(s) {
  if (!s) return null;
  const [a, b] = s.split('-').map(Number);
  return { start: a, end: b };
}

/** Build { init, segments[] } for one representation. */
export function dashTrackPlan(rep) {
  const ext = /webm/.test(rep.mime) ? 'webm' : (rep.type === 'audio' ? 'm4a' : 'mp4');
  const base = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };

  if (rep.template) {
    const a = rep.template.attrs;
    const timescale = Number(a.timescale || 1);
    const startNumber = Number(a.startNumber ?? 1);
    const init = a.initialization ? { url: new URL(fill(a.initialization, base), rep.base).href } : null;
    const media = a.media;
    if (!media) throw new Error('SegmentTemplate without media attribute');
    const segments = [];
    if (rep.template.timeline) {
      let time = 0, num = startNumber;
      const end = rep.periodDur * timescale;
      for (const s of kids(rep.template.timeline, 'S')) {
        if (s.hasAttribute('t')) time = Number(s.getAttribute('t'));
        const d = Number(s.getAttribute('d'));
        let r = Number(s.getAttribute('r') || 0);
        if (r < 0) r = Math.max(0, Math.ceil((end - time) / d) - 1);
        for (let k = 0; k <= r; k++) {
          segments.push({ url: new URL(fill(media, { ...base, Number: num, Time: time }), rep.base).href });
          time += d;
          num++;
        }
      }
    } else {
      const segDur = Number(a.duration || 0) / timescale;
      if (!segDur || !rep.periodDur) throw new Error('Cannot determine DASH segment count');
      const count = Math.ceil(rep.periodDur / segDur);
      for (let n = 0; n < count; n++) {
        segments.push({ url: new URL(fill(media, { ...base, Number: startNumber + n, Time: Math.round(n * segDur * timescale) }), rep.base).href });
      }
    }
    return { role: rep.type, ext, init, segments };
  }

  if (rep.list) {
    const ini = kid(rep.list, 'Initialization');
    const init = ini ? {
      url: new URL(ini.getAttribute('sourceURL') || '', rep.base).href,
      range: parseRange(ini.getAttribute('range'))
    } : null;
    const segments = kids(rep.list, 'SegmentURL').map(s => ({
      url: new URL(s.getAttribute('media') || '', rep.base).href,
      range: parseRange(s.getAttribute('mediaRange'))
    }));
    return { role: rep.type, ext, init, segments };
  }

  // SegmentBase / plain BaseURL: the representation is one whole file.
  return { role: rep.type, ext, init: null, segments: [{ url: rep.base }] };
}
