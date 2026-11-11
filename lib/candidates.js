export function canDownload(candidate) {
  return !candidate.info?.encrypted && !candidate.info?.error && !(candidate.kind === 'dash' && candidate.info?.live);
}

export function selectCandidates(candidates, { query = '', kind = 'all', sort = 'recommended', readyOnly = false } = {}) {
  const needle = query.trim().toLowerCase();
  const selected = candidates.filter(candidate => {
    const info = candidate.info || {};
    let decodedUrl = candidate.url;
    try { decodedUrl = decodeURIComponent(candidate.url); } catch { /* Keep malformed URLs searchable as-is. */ }
    const haystack = [candidate.title || '', candidate.url, decodedUrl, candidate.kind, ...(info.variants || []), info.note || ''].join(' ').toLowerCase();
    return (kind === 'all' || candidate.kind === kind) && (!needle || haystack.includes(needle)) &&
      (!readyOnly || canDownload(candidate));
  });
  const descending = property => (a, b) => (property(b) || 0) - (property(a) || 0);
  const byScore = descending(c => c.score);
  const compare = {
    recommended: byScore,
    size: descending(c => c.size),
    duration: descending(c => c.info?.duration),
    newest: descending(c => c.seen)
  }[sort] || byScore;
  return selected.sort((a, b) => compare(a, b) || byScore(a, b));
}
