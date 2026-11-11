import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';

test('popup supports discovery, filters, preferences, and download actions', async t => {
  const { window, document } = parseHTML(await readFile(new URL('../popup.html', import.meta.url), 'utf8'));
  // LinkeDOM intentionally omits the native select.value setter. Supply only
  // that browser behavior so these tests exercise the actual popup handlers.
  const selectDescriptor = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { return (this.querySelector('option[selected]') || this.querySelector('option'))?.getAttribute('value') || ''; },
    set(value) {
      for (const option of this.querySelectorAll('option')) {
        if (option.getAttribute('value') === String(value)) option.setAttribute('selected', '');
        else option.removeAttribute('selected');
      }
    }
  });
  t.after(() => Object.defineProperty(window.HTMLSelectElement.prototype, 'value', selectDescriptor));
  const $ = selector => document.querySelector(selector);
  const click = selector => $(selector).dispatchEvent(new window.Event('click', { bubbles: true }));
  const change = (selector, value, event = 'change') => {
    if ($(selector).type === 'checkbox') $(selector).checked = value;
    else $(selector).value = value;
    $(selector).dispatchEvent(new window.Event(event, { bubbles: true }));
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const until = async predicate => {
    for (let n = 0; n < 100; n++) {
      if (predicate()) return;
      await flush();
    }
    assert.fail(`Popup did not reach expected state: ${$('#stats').textContent}; ${$('#notice').textContent}; ${$('#list').textContent}`);
  };
  const captured = [
    { kind: 'file', url: 'https://media.example/camera.mp4', size: 20 * 1024 * 1024, seen: 50 },
    { kind: 'file', url: 'https://media.example/movie.mp4', size: 200 * 1024 * 1024, seen: 40 },
    { kind: 'hls', url: 'https://media.example/master.m3u8', seen: 30 },
    { kind: 'hls', url: 'https://media.example/protected.m3u8', seen: 20 },
    { kind: 'file', url: 'https://ads.example/advert.mp4', size: 1024 * 1024, ad: true, seen: 10 }
  ];
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nmedium.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480\nlow.m3u8';
  const media = '#EXTM3U\n#EXTINF:1200,\nchunk.ts\n#EXT-X-ENDLIST';
  const protectedMedia = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:1200,\nchunk.ts\n#EXT-X-ENDLIST';
  const storage = { preferences: { theme: 'dark', quality: '720', saveAs: true } };
  const session = {};
  const createdTabs = [];
  const downloads = [];
  const copied = [];
  const messages = [];
  const rules = [];
  let scanCount = 0;
  let rejectTab = false;
  const globals = {
    document,
    navigator: { clipboard: { writeText: async value => copied.push(value) } },
    chrome: {
      runtime: {
        getManifest: () => ({ version: '1.1.0' }),
        getURL: path => `chrome-extension://cliphawk/${path}`,
        sendMessage: async message => { messages.push(message); return message.type === 'get-tab' ? captured : true; }
      },
      storage: {
        local: { get: async () => storage, set: async value => Object.assign(storage, value) },
        session: { set: async value => Object.assign(session, value), remove: async key => { delete session[key]; } }
      },
      tabs: {
        TAB_ID_NONE: -1,
        query: async () => [{ id: 3, index: 2, title: 'Test video collection', url: 'https://watch.example/videos' }],
        create: async value => { if (rejectTab) throw new Error('Tab unavailable'); createdTabs.push(value); }
      },
      scripting: {
        executeScript: async () => {
          scanCount++;
          return [{ result: { videos: [{ srcs: [], duration: 1200, visibleArea: 100000, adCtx: false }], drm: null, mse: true } }];
        }
      },
      declarativeNetRequest: { updateSessionRules: async value => rules.push(value) },
      downloads: { download: async value => { downloads.push(value); return downloads.length; } }
    }
  };
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
  }
  t.mock.method(globalThis, 'fetch', async url => {
    assert.match(url, /^https:\/\/media\.example\//);
    return new Response(url.endsWith('/master.m3u8') ? master : url.endsWith('/protected.m3u8') ? protectedMedia : media);
  });
  await import('../popup.js');
  await until(() => $('#list').getAttribute('aria-busy') === 'false' && $('#count').textContent === '5');

  await t.test('initial scan renders playable and protected cards with preferences applied', () => {
    assert.equal($('#page').textContent, 'Test video collection');
    assert.equal($('#site').textContent, 'watch.example');
    assert.equal(document.documentElement.dataset.theme, 'dark');
    assert.equal($('#list').querySelectorAll('article').length, 5);
    assert.equal($('#list').querySelectorAll('.ad-group article').length, 1);
    assert.equal($('.main select').value, '1');
    assert.match($('#stats').textContent, /3 ready/);
    assert.equal($('article[aria-label*="protected"] .download-btn').disabled, true);
    assert.deepEqual(rules.at(-1), { removeRuleIds: [2] });
  });

  await t.test('copy links excludes protected streams and likely ads', async () => {
    click('#copy-all');
    await flush();
    assert.deepEqual(new Set(copied.at(-1).split('\n')), new Set(captured.slice(0, 3).map(c => c.url)));
    assert.match($('#notice').textContent, /Copied 3 downloadable links/);
  });

  await t.test('format, ready-only, search, and reset controls combine', () => {
    click('[data-kind="hls"]');
    assert.equal($('#list').querySelectorAll('article').length, 2);
    assert.equal($('[data-kind="hls"]').getAttribute('aria-pressed'), 'true');
    change('#ready-only', true);
    assert.equal($('#list').querySelectorAll('article').length, 1);
    change('#search', 'does-not-exist', 'input');
    assert.match($('#list').textContent, /No matching videos/);
    assert.equal($('#copy-all').disabled, true);
    click('#list .empty button');
    assert.equal($('#search').value, '');
    assert.equal($('#ready-only').checked, false);
    assert.equal($('#list').querySelectorAll('article').length, 5);
  });

  await t.test('largest-first sorting orders direct files correctly', () => {
    click('[data-kind="file"]');
    change('#sort', 'size');
    assert.match($('#list > article').getAttribute('aria-label'), /movie\.mp4/);
    change('#sort', 'newest');
    assert.match($('#list > article').getAttribute('aria-label'), /camera\.mp4/);
    click('[data-kind="all"]');
  });

  await t.test('search matches the page title displayed on the top pick', () => {
    change('#search', 'video collection', 'input');
    assert.equal($('#list').querySelectorAll('article').length, 1);
    assert.match($('#list article').getAttribute('aria-label'), /master\.m3u8/);
    change('#search', '', 'input');
  });

  await t.test('preferences persist and update quality without losing card state', async () => {
    click('#settings-toggle');
    assert.equal($('#settings').hidden, false);
    assert.equal($('#settings-toggle').getAttribute('aria-expanded'), 'true');
    change('#theme', 'light');
    change('#quality', '480');
    await until(() => storage.preferences.quality === '480');
    assert.equal(document.documentElement.dataset.theme, 'light');
    assert.equal($('.main select').value, '2');
    assert.deepEqual(storage.preferences, { theme: 'light', quality: '480', saveAs: true });
    click('#settings-toggle');
    assert.equal($('#settings').hidden, true);
  });

  await t.test('preferences popover closes with Escape or an outside click', () => {
    click('#settings-toggle');
    const escape = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(escape, 'key', { value: 'Escape' });
    $('#theme').dispatchEvent(escape);
    assert.equal($('#settings').hidden, true);
    assert.equal($('#settings-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(escape.defaultPrevented, true);
    click('#settings-toggle');
    click('#page');
    assert.equal($('#settings').hidden, true);
    assert.equal($('#settings-toggle').getAttribute('aria-expanded'), 'false');
  });

  await t.test('stream download job receives selected quality and save location preference', async () => {
    click('.main .download-btn');
    await until(() => createdTabs.length === 1);
    const job = Object.values(session)[0];
    assert.equal(job.kind, 'hls');
    assert.equal(job.variant, 2);
    assert.equal(job.saveAs, true);
    assert.equal(job.pageUrl, 'https://watch.example/videos');
    assert.equal(createdTabs[0].index, 3);
    assert.equal($('.main .download-btn').disabled, true);
    change('#search', 'camera', 'input');
    change('#search', '', 'input');
    assert.equal($('.main .download-btn').disabled, true);
  });

  await t.test('direct files use the browser save-as setting', async () => {
    change('#search', 'camera', 'input');
    click('#list > article .download-btn');
    await until(() => downloads.length === 1);
    assert.equal(downloads[0].url, captured[0].url);
    assert.equal(downloads[0].saveAs, true);
    assert.equal(downloads[0].filename, 'Test video collection.mp4');
  });

  await t.test('rescan retains active search and handles failed tab creation without abandoned jobs', async () => {
    click('#rescan');
    await until(() => scanCount === 2 && $('#list').getAttribute('aria-busy') === 'false');
    assert.equal($('#search').value, 'camera');
    assert.equal($('#list').querySelectorAll('article').length, 1);
    change('#search', 'master', 'input');
    const countBefore = Object.keys(session).length;
    rejectTab = true;
    click('#list > article .download-btn');
    await until(() => $('#list').textContent.includes('Failed: Tab unavailable'));
    assert.equal(Object.keys(session).length, countBefore);
    assert.equal($('#list > article .download-btn').disabled, false);
  });

  await t.test('clear removes results without immediately repopulating them', async () => {
    click('#clear');
    await until(() => $('#count').textContent === '0');
    assert.deepEqual(messages.at(-1), { type: 'clear-tab', tabId: 3 });
    assert.equal($('#list').querySelectorAll('article').length, 0);
    assert.equal($('#clear').disabled, true);
    assert.equal($('#copy-all').disabled, true);
    assert.match($('#notice').textContent, /Captured list cleared/);
  });
});
