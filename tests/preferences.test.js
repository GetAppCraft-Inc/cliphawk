import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePreferences, preferredVariant } from '../lib/preferences.js';

test('preferences accept only supported values and actual booleans', () => {
  assert.deepEqual(normalizePreferences(null), { theme: 'system', quality: 'best', saveAs: false });
  assert.deepEqual(normalizePreferences({ theme: 'unknown', quality: '4k', saveAs: 'true' }), { theme: 'system', quality: 'best', saveAs: false });
  assert.deepEqual(normalizePreferences({ theme: 'dark', quality: '720', saveAs: true }), { theme: 'dark', quality: '720', saveAs: true });
});

test('quality preferences choose the highest available rendition below the cap', () => {
  const variants = ['1080p · 5 Mbps', '480p · 1 Mbps', '720p · 2 Mbps'];
  assert.equal(preferredVariant(variants, 'best'), 0);
  assert.equal(preferredVariant(variants, '720'), 2);
  assert.equal(preferredVariant(variants, '480'), 1);
  assert.equal(preferredVariant(['2160p', '1080p'], '720'), 1);
  assert.equal(preferredVariant(['Variant 1', 'Variant 2'], '720'), 0);
  assert.equal(preferredVariant([], '720'), 0);
});
