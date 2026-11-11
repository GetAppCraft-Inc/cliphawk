import test from 'node:test';
import assert from 'node:assert/strict';
import { canDownload, selectCandidates } from '../lib/candidates.js';

test('downloadable filter excludes protected, unreadable, and live DASH streams', () => {
  const candidates = [
    { kind: 'file', url: 'https://example.com/video.mp4' },
    { kind: 'hls', url: 'https://example.com/live.m3u8', info: { live: true } },
    { kind: 'hls', url: 'https://example.com/protected.m3u8', info: { encrypted: true } },
    { kind: 'dash', url: 'https://example.com/live.mpd', info: { live: true } },
    { kind: 'dash', url: 'https://example.com/broken.mpd', info: { error: 'HTTP 403' } }
  ];
  assert.deepEqual(candidates.map(canDownload), [true, true, false, false, false]);
  assert.deepEqual(selectCandidates(candidates, { readyOnly: true }), candidates.slice(0, 2));
});

test('search and sorting combine without changing captured candidate order', () => {
  const small = { kind: 'file', url: 'https://example.com/trailer.mp4', size: 10, seen: 30, score: 9, info: { duration: 200 } };
  const large = { kind: 'file', url: 'https://example.com/film.mp4', size: 100, seen: 10, score: 5, info: { duration: 100 } };
  const stream = { kind: 'hls', url: 'https://cdn.example.com/master.m3u8', size: 0, score: 20, info: { variants: ['720p · 2 Mbps'] } };
  const candidates = [small, large, stream];
  assert.deepEqual(selectCandidates(candidates, { kind: 'file', sort: 'size' }), [large, small]);
  assert.deepEqual(selectCandidates(candidates, { kind: 'file', sort: 'duration' }), [small, large]);
  assert.deepEqual(selectCandidates(candidates, { query: ' 720P ' }), [stream]);
  assert.deepEqual(selectCandidates(candidates, { query: 'trailer', kind: 'hls' }), []);
  assert.deepEqual(selectCandidates(candidates, { sort: 'newest' }), [small, large, stream]);
  assert.deepEqual(candidates, [small, large, stream]);
});

test('search finds visible titles and URL-decoded filenames', () => {
  const named = { kind: 'hls', title: 'A walk through Kyoto', url: 'https://example.com/abc123.m3u8' };
  const encoded = { kind: 'file', url: 'https://example.com/Family%20holiday.mp4' };
  const malformed = { kind: 'file', url: 'https://example.com/broken%ZZ.mp4' };
  assert.deepEqual(selectCandidates([named, encoded, malformed], { query: 'KYOTO' }), [named]);
  assert.deepEqual(selectCandidates([named, encoded, malformed], { query: 'family holiday' }), [encoded]);
  assert.deepEqual(selectCandidates([named, encoded, malformed], { query: 'broken%ZZ' }), [malformed]);
});
