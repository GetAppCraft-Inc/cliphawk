import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchBytes, waitForDownload } from '../lib/download.js';

const item = { url: 'https://media.example/video.mp4', range: { start: 10, end: 12 } };

test('fetches only the requested byte range with progress', async t => {
  const progress = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, item.url);
    assert.equal(options.headers.Range, 'bytes=10-12');
    assert.equal(options.credentials, 'include');
    return new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { 'content-range': 'bytes 10-12/100', 'content-length': '3' } });
  });
  assert.deepEqual(await fetchBytes(item, { onBytes: (...p) => progress.push(p) }), new Uint8Array([1, 2, 3]));
  assert.deepEqual(progress.at(-1), [3, 3]);
});

test('rejects ignored and mismatched ranges without retrying', async t => {
  for (const response of [
    new Response('all bytes'),
    new Response('abc', { status: 206, headers: { 'content-range': 'bytes 0-2/100' } })
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(fetchBytes(item), /requested byte range/);
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
  }
});

test('rejects truncated range responses', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('ab', { status: 206, headers: { 'content-range': 'bytes 10-12/100' } }));
  await assert.rejects(fetchBytes(item, { retries: 0 }), /Incomplete/);
});

test('retries temporary server errors, but not authentication failures', async t => {
  let attempts = 0;
  const mock = t.mock.method(globalThis, 'fetch', async () => ++attempts === 1
    ? new Response('', { status: 503 }) : new Response('ok'));
  assert.equal(new TextDecoder().decode(await fetchBytes({ url: item.url }, { retryDelay: 1 })), 'ok');
  assert.equal(attempts, 2);
  mock.mock.restore();
  const denied = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  await assert.rejects(fetchBytes(item), /HTTP 403/);
  assert.equal(denied.mock.callCount(), 1);
});

test('cancellation interrupts retry backoff and starts no further requests', async t => {
  const ctrl = new AbortController();
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  const pending = fetchBytes(item, { signal: ctrl.signal, retryDelay: 10000 });
  setTimeout(() => ctrl.abort(), 10);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(mock.mock.callCount(), 1);
});

test('request timeout terminates a stalled response', async t => {
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await assert.rejects(fetchBytes(item, { timeout: 5, retries: 0 }), /timed out/);
});

test('active streaming can take longer than the inactivity timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      for (let n = 1; n <= 4; n++) {
        setTimeout(() => {
          controller.enqueue(new Uint8Array([n]));
          if (n === 4) controller.close();
        }, n * 50);
      }
    }
  })));
  const pending = fetchBytes({ url: item.url }, { timeout: 80, retries: 0 });
  await new Promise(resolve => setImmediate(resolve));
  for (let n = 0; n < 4; n++) {
    t.mock.timers.tick(50);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(await pending, new Uint8Array([1, 2, 3, 4]));
});

function downloadsMock(state = 'in_progress') {
  const listeners = new Set();
  return {
    listeners,
    onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    search: async () => [{ id: 7, state }],
    emit: delta => { for (const listener of listeners) listener(delta); }
  };
}

test('already completed downloads resolve and remove listeners', async () => {
  const downloads = downloadsMock('complete');
  assert.equal(await waitForDownload(7, downloads), 'complete');
  assert.equal(downloads.listeners.size, 0);
});

test('download events handle interruptions and ignore unrelated downloads', async () => {
  const downloads = downloadsMock();
  const pending = waitForDownload(7, downloads);
  downloads.emit({ id: 8, state: { current: 'complete' } });
  assert.equal(downloads.listeners.size, 1);
  downloads.emit({ id: 7, state: { current: 'interrupted' } });
  assert.equal(await pending, 'interrupted');
  assert.equal(downloads.listeners.size, 0);
});

test('missing downloads fail instead of waiting forever', async () => {
  const downloads = downloadsMock();
  downloads.search = async () => [];
  await assert.rejects(waitForDownload(7, downloads), /no longer exists/);
  assert.equal(downloads.listeners.size, 0);
});
