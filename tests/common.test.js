import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, isAdUrl, sanitizeFilename } from '../lib/common.js';

test('classifies manifests and files while excluding media chunks and images', () => {
  assert.equal(classify('https://example.com/stream', 'application/vnd.apple.mpegurl'), 'hls');
  assert.equal(classify('https://example.com/stream.mpd', ''), 'dash');
  assert.equal(classify('https://example.com/video.mp4?token=1', 'video/mp4'), 'file');
  assert.equal(classify('https://example.com/chunk.m4s', 'video/mp4'), null);
  assert.equal(classify('https://example.com/chunk', 'video/mp2t'), null);
  assert.equal(classify('https://example.com/video.mp4', 'image/png'), null);
});

test('ad detection respects hostname and path boundaries', () => {
  assert.equal(isAdUrl('https://cdn.doubleclick.net/video'), true);
  assert.equal(isAdUrl('https://example.com/preroll/video.mp4'), true);
  assert.equal(isAdUrl('https://notdoubleclick.net/roads.mp4'), false);
});

test('filenames work on Windows and cannot introduce path separators', () => {
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(sanitizeFilename('nul.txt'), '_nul.txt');
  assert.equal(sanitizeFilename('a/b:c?d'), 'a b c d');
  assert.equal(sanitizeFilename('...'), 'video');
  assert.equal(sanitizeFilename('title. '), 'title');
  assert.equal(sanitizeFilename('‎My​ clip‮﻿'), 'My clip');
  assert.equal(sanitizeFilename('... 50% off'), '50 off');
  assert.equal(sanitizeFilename('x'.repeat(119) + '.extra'), 'x'.repeat(119));
});
