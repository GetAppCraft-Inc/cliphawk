// Minimal HLS (m3u8) parser: master + media playlists, keys, maps, byte ranges.

export function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  return out;
}

const abs = (u, base) => new URL(u, base).href;

function parseByteRange(v, lastEnd) {
  // "length[@offset]" -> { start, end } inclusive
  if (!/^\d+(?:@\d+)?$/.test(v)) throw new Error('Invalid HLS byte range');
  const [len, off] = String(v).split('@').map(Number);
  const start = Number.isFinite(off) ? off : lastEnd;
  if (!Number.isSafeInteger(len) || len <= 0 || !Number.isSafeInteger(start) || start < 0 ||
      !Number.isSafeInteger(start + len)) throw new Error('Invalid or missing HLS byte-range offset');
  return { start, end: start + len - 1 };
}

function isEncryptingMethod(method) {
  return method && method.toUpperCase() !== 'NONE';
}

export function parseHls(text, baseUrl) {
  if (!text || !text.trimStart().startsWith('#EXTM3U')) throw new Error('Not an HLS playlist');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    const media = [];
    let sessionKey = null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttrs(l.slice(18));
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith('#')) j++;
        if (j >= lines.length) continue;
        const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
        variants.push({
          uri: abs(lines[j], baseUrl),
          bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH || 0),
          width: w || 0,
          height: h || 0,
          codecs: a.CODECS || '',
          audio: a.AUDIO || null
        });
        i = j;
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrs(l.slice(13));
        media.push({
          type: a.TYPE, group: a['GROUP-ID'], name: a.NAME, lang: a.LANGUAGE,
          isDefault: a.DEFAULT === 'YES', uri: a.URI ? abs(a.URI, baseUrl) : null
        });
      } else if (l.startsWith('#EXT-X-SESSION-KEY:')) {
        const a = parseAttrs(l.slice(19));
        if (isEncryptingMethod(a.METHOD)) sessionKey = a.METHOD;
      }
    }
    variants.sort((x, y) => (y.height - x.height) || (y.bandwidth - x.bandwidth));
    variants.forEach((v, i) => {
      v.label = [
        v.height ? `${v.height}p` : `Variant ${i + 1}`,
        v.bandwidth ? `${(v.bandwidth / 1e6).toFixed(1)} Mbps` : ''
      ].filter(Boolean).join(' · ');
    });
    return { type: 'master', variants, media, encrypted: !!sessionKey, keyMethod: sessionKey };
  }

  const segments = [];
  let duration = 0, pendingDur = 0, pendingRange = null, map = null;
  let encrypted = false, keyMethod = null, endList = false, discontinuities = 0;
  let previousSegment = null;
  for (const l of lines) {
    if (l.startsWith('#EXTINF:')) {
      pendingDur = parseFloat(l.slice(8)) || 0;
    } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = l.slice('#EXT-X-BYTERANGE:'.length);
    } else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(l.slice(11));
      if (isEncryptingMethod(a.METHOD)) { encrypted = true; keyMethod = a.METHOD; }
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(l.slice(11));
      if (a.URI) {
        const url = abs(a.URI, baseUrl);
        const nextMap = { url, range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, undefined) : null };
        if (segments.length && JSON.stringify(map) !== JSON.stringify(nextMap)) {
          throw new Error('HLS streams with changing initialization segments are not supported');
        }
        map = nextMap;
      }
    } else if (l === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (l === '#EXT-X-DISCONTINUITY') {
      discontinuities++;
    } else if (!l.startsWith('#')) {
      const url = abs(l, baseUrl);
      let range = null;
      if (pendingRange) {
        range = parseByteRange(pendingRange, previousSegment?.url === url && previousSegment.range
          ? previousSegment.range.end + 1 : undefined);
      }
      previousSegment = { url, duration: pendingDur, range };
      segments.push(previousSegment);
      duration += pendingDur;
      pendingDur = 0;
      pendingRange = null;
    }
  }
  return { type: 'media', segments, duration, map, encrypted, keyMethod, live: !endList, discontinuities };
}

/** Pick the alternate audio rendition for a variant, if audio is not muxed in. */
export function pickAudio(master, variant) {
  if (!variant.audio) return null;
  const group = master.media.filter(m => m.type === 'AUDIO' && m.group === variant.audio && m.uri);
  if (!group.length) return null;
  return group.find(m => m.isDefault) || group[0];
}
