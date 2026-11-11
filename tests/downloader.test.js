import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';

const html = await readFile(new URL('../downloader.html', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
let scenario = 0;

async function until(predicate, message) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await tick();
  }
}

async function page(t, { fetchMedia, preferencesFailure = false, saveAs = false } = {}) {
  const { window, document } = parseHTML(html);
  const originals = new Map();
  const install = (key, value) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const downloads = [], revealed = [], copied = [], requests = [];
  const job = { id: 'test', title: 'A sample video', kind: 'hls', url: 'https://media.example/master.m3u8', pageUrl: 'https://example.com/watch', variant: 0, saveAs };
  const listeners = new Set();
  install('window', window);
  install('document', document);
  install('location', { search: '?job=test' });
  install('navigator', { platform: 'Win32', clipboard: { writeText: async text => copied.push(text) } });
  install('chrome', {
    storage: {
      local: { get: async () => {
        if (preferencesFailure) throw new Error('Settings unavailable');
        return { preferences: { theme: 'dark' } };
      } },
      session: { get: async () => ({ 'job:test': job }), remove: async () => {} }
    },
    tabs: { getCurrent: async () => ({ id: 55 }), remove: async () => {} },
    declarativeNetRequest: { updateSessionRules: async () => {} },
    downloads: {
      download: async options => {
        const id = downloads.length + 1;
        downloads.push({ id, options, state: 'complete', filename: `C:\\Downloads\\${options.filename}` });
        return id;
      },
      search: async ({ id }) => downloads.filter(download => download.id === id),
      cancel: async id => {
        const download = downloads.find(item => item.id === id);
        if (download) download.state = 'interrupted';
        for (const listener of listeners) listener({ id, state: { current: 'interrupted' } });
      },
      show: async id => revealed.push(id),
      onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) }
    }
  });
  install('fetch', async (url, options) => {
    requests.push(url);
    return fetchMedia(url, options);
  });
  t.after(async () => {
    window.dispatchEvent(new window.Event('beforeunload'));
    await tick();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await import(`../downloader.js?scenario=${++scenario}`);
  const click = selector => {
    const element = document.querySelector(selector);
    assert(element && !element.hidden && !element.disabled, `${selector} is available`);
    element.dispatchEvent(new window.Event('click'));
  };
  return { document, click, downloads, revealed, copied, requests, listeners };
}

const playlist = count => `#EXTM3U\n${Array.from({ length: count }, (_, index) => `#EXTINF:5,\npart${index}.ts`).join('\n')}\n#EXT-X-ENDLIST`;

test('downloader saves files, applies preferences, reveals files, and copies conversion commands', async t => {
  const ui = await page(t, {
    saveAs: true,
    fetchMedia: async url => new Response(url.endsWith('.m3u8') ? playlist(1) : new Uint8Array([1, 2, 3]))
  });
  await until(() => !ui.document.querySelector('#close').hidden, 'download completes');
  assert.equal(ui.document.querySelector('#state').textContent, 'Complete');
  assert.equal(ui.document.documentElement.dataset.theme, 'dark');
  assert.equal(ui.downloads.length, 1);
  assert.equal(ui.downloads[0].options.saveAs, true);
  assert.match(ui.document.querySelector('#files').textContent, /A sample video\.ts/);
  assert.equal(ui.document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '100');
  ui.click('#files button');
  ui.click('#copy-command');
  await tick();
  assert.deepEqual(ui.revealed, [1]);
  assert.match(ui.copied[0], /^ffmpeg -i 'A sample video\.ts'/);
  assert.equal(ui.listeners.size, 0);
});

test('pause finishes active chunks, cancellation remains on page, and retry starts a fresh transfer', async t => {
  const pending = [];
  let hold = true;
  const ui = await page(t, {
    fetchMedia: async (url, { signal }) => {
      if (url.endsWith('.m3u8')) return new Response(playlist(8));
      if (!hold) return new Response(new Uint8Array([1, 2, 3]));
      return new Promise((resolve, reject) => {
        pending.push(() => resolve(new Response(new Uint8Array([1, 2, 3]))));
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
  });
  await until(() => pending.length === 6, 'first six requests start');
  ui.click('#pause');
  assert.equal(ui.document.querySelector('#state').textContent, 'Pausing');
  pending.forEach(resolve => resolve());
  await until(() => ui.document.querySelector('#state').textContent === 'Paused', 'in-flight requests finish');
  assert.equal(ui.requests.filter(url => url.endsWith('.ts')).length, 6);
  ui.click('#cancel');
  await until(() => !ui.document.querySelector('#retry').hidden, 'cancel allows retry');
  assert.equal(ui.document.querySelector('#state').textContent, 'Cancelled');
  assert.equal(ui.downloads.length, 0);
  hold = false;
  ui.click('#retry');
  await until(() => !ui.document.querySelector('#close').hidden, 'retried download completes');
  assert.equal(ui.document.querySelector('#state').textContent, 'Complete');
  assert.equal(ui.downloads.length, 1);
});

test('retry after an audio failure keeps the previously saved video', async t => {
  let failAudio = true;
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO="audio"\nvideo.m3u8';
  const ui = await page(t, {
    fetchMedia: async url => {
      if (url.endsWith('master.m3u8')) return new Response(master);
      if (url.endsWith('video.m3u8')) return new Response('#EXTM3U\n#EXTINF:5,\nvideo.ts\n#EXT-X-ENDLIST');
      if (url.endsWith('audio.m3u8')) return new Response('#EXTM3U\n#EXTINF:5,\naudio.aac\n#EXT-X-ENDLIST');
      if (url.endsWith('audio.aac') && failAudio) return new Response('', { status: 403 });
      return new Response(new Uint8Array([1, 2, 3]));
    }
  });
  await until(() => !ui.document.querySelector('#retry').hidden, 'audio download fails');
  assert.match(ui.document.querySelector('#status').textContent, /HTTP 403/);
  assert.equal(ui.downloads.length, 1);
  failAudio = false;
  ui.click('#retry');
  await until(() => !ui.document.querySelector('#close').hidden, 'audio retry completes');
  assert.equal(ui.document.querySelector('#state').textContent, 'Complete');
  assert.equal(ui.downloads.length, 2);
  assert.equal(ui.requests.filter(url => url.endsWith('/video.ts')).length, 1);
  assert.equal(ui.requests.filter(url => url.endsWith('master.m3u8')).length, 1);
  assert.equal(ui.document.querySelectorAll('#files .saved-file').length, 2);
  assert.match(ui.document.querySelector('#command').textContent, /\(merged\)\.mp4/);
});

test('unavailable settings do not prevent a download', async t => {
  const ui = await page(t, {
    preferencesFailure: true,
    fetchMedia: async url => new Response(url.endsWith('.m3u8') ? playlist(1) : new Uint8Array([1]))
  });
  await until(() => !ui.document.querySelector('#close').hidden, 'download completes without settings');
  assert.equal(ui.document.querySelector('#state').textContent, 'Complete');
  assert.equal(ui.document.documentElement.dataset.theme, 'system');
});
