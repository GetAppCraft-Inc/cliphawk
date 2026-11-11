import test from 'node:test';
import assert from 'node:assert/strict';

test('closing a tab cancels pending storage flushes and removes only its request rules', async t => {
  const listeners = {};
  const storage = {};
  const timers = new Map();
  const removedRules = [];
  let timerId = 0;
  const originalChrome = globalThis.chrome;
  t.after(() => { globalThis.chrome = originalChrome; });
  t.mock.method(globalThis, 'setTimeout', callback => { timers.set(++timerId, callback); return timerId; });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  globalThis.chrome = {
    storage: { session: {
      get: async key => ({ [key]: storage[key] }),
      set: async value => Object.assign(storage, value),
      remove: async key => { delete storage[key]; }
    } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    webRequest: { onHeadersReceived: { addListener: fn => { listeners.headers = fn; } } },
    tabs: { onRemoved: { addListener: fn => { listeners.removed = fn; } } },
    runtime: { onMessage: { addListener: fn => { listeners.message = fn; } } },
    downloads: { onChanged: { addListener: () => {} } },
    declarativeNetRequest: {
      getSessionRules: async () => [
        { id: 107, condition: { tabIds: [7] } },
        { id: 108, condition: { tabIds: [8] } },
        { id: 1, condition: { tabIds: [-1] } }
      ],
      updateSessionRules: async update => removedRules.push(...update.removeRuleIds)
    }
  };
  await import('../background.js');
  listeners.headers({ tabId: 7, type: 'media', statusCode: 200, url: 'https://example.com/video.mp4', responseHeaders: [] });
  // Flush microtasks from storage reads without running the pending flush timer.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 1);
  listeners.removed(7);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 0);
  assert.equal(storage['tab:7'], undefined);
  assert.deepEqual(removedRules, [107]);
});
