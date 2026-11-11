import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHls, pickAudio } from '../lib/hls.js';

const base = 'https://media.example/path/master.m3u8';
const parse = text => parseHls(`#EXTM3U\n${text}`, base);

test('HLS ranges retain the first digit and advance implicit offsets', () => {
  const result = parse('#EXTINF:5,\n#EXT-X-BYTERANGE:1000@25\nvideo.ts\n#EXTINF:6,\n#EXT-X-BYTERANGE:2000\nvideo.ts\n#EXT-X-ENDLIST');
  assert.deepEqual(result.segments.map(s => s.range), [{ start: 25, end: 1024 }, { start: 1025, end: 3024 }]);
  assert.equal(result.segments[0].url, 'https://media.example/path/video.ts');
  assert.equal(result.duration, 11);
  assert.equal(result.live, false);
});

test('HLS rejects missing offsets, changed resources, zero lengths, and malformed ranges', () => {
  for (const value of ['100', '0@0', 'abc@0', '10@-1', '99999999999999999999@0']) {
    assert.throws(() => parse(`#EXT-X-BYTERANGE:${value}\na.ts`), /byte.range/);
  }
  assert.throws(() => parse('#EXT-X-BYTERANGE:100@0\na.ts\n#EXT-X-BYTERANGE:100\nb.ts'), /offset/);
  assert.throws(() => parse('#EXT-X-BYTERANGE:100@0\na.ts\nb.ts\n#EXT-X-BYTERANGE:100\na.ts'), /offset/);
});

test('HLS preserves fMP4 initialization ranges and rejects changing maps', () => {
  const map = '#EXT-X-MAP:URI="video.mp4",BYTERANGE="200@0"';
  const result = parse(`${map}\n#EXT-X-BYTERANGE:1000@200\nvideo.mp4`);
  assert.deepEqual(result.map.range, { start: 0, end: 199 });
  assert.equal(result.live, true);
  assert.throws(() => parse(`${map}\na.m4s\n#EXT-X-MAP:URI="other.mp4"\nb.m4s`), /changing initialization/);
});

test('HLS sorts qualities and selects default audio within the matching group', () => {
  const result = parse('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English, stereo",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,AUDIO="a"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,AUDIO="a"\nhigh.m3u8');
  assert.equal(result.variants[0].height, 1080);
  assert.equal(pickAudio(result, result.variants[0]).uri, 'https://media.example/path/audio.m3u8');
  assert.equal(pickAudio(result, { audio: 'missing' }), null);
});

test('HLS keeps encryption flagged even when a later key uses NONE', () => {
  assert.equal(parse('#EXT-X-KEY:METHOD=AES-128,URI="key"\na.ts\n#EXT-X-KEY:METHOD=NONE\nb.ts').encrypted, true);
  assert.equal(parse('#EXT-X-KEY:METHOD=NONE\na.ts').encrypted, false);
  assert.equal(parse('#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8').encrypted, true);
  assert.throws(() => parseHls('<html>error</html>', base), /Not an HLS/);
});
