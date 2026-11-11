import test from 'node:test';
import assert from 'node:assert/strict';
import { PauseGate, fetchTrack, elapsedLabel } from '../lib/transfer.js';

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const track = { segments: [{ url: 'one' }, { url: 'two' }, { url: 'three' }] };

test('paused transfers finish current chunks and wait before starting the next', async () => {
  const gate = new PauseGate();
  const controller = new AbortController();
  const first = deferred();
  const requested = [];
  const result = fetchTrack(track, {
    controller, gate, concurrency: 1,
    fetchChunk: async item => {
      requested.push(item.url);
      if (item.url === 'one') await first.promise;
      return new Uint8Array([requested.length]);
    }
  });
  await nextTurn();
  gate.pause();
  first.resolve();
  await nextTurn();
  assert.deepEqual(requested, ['one']);
  gate.resume();
  assert.deepEqual((await result).map(part => part[0]), [1, 2, 3]);
  assert.deepEqual(requested, ['one', 'two', 'three']);
});

test('cancelling while paused settles every waiter without starting requests', async () => {
  const gate = new PauseGate();
  gate.pause();
  const controller = new AbortController();
  let requests = 0;
  const pending = fetchTrack(track, {
    controller, gate,
    fetchChunk: async () => { requests++; return new Uint8Array([1]); }
  });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(requests, 0);
  gate.resume();
});

test('parallel requests preserve manifest order and include initialization bytes', async () => {
  const first = deferred();
  const second = deferred();
  const requested = [];
  const pending = fetchTrack({ init: { url: 'init' }, segments: [{ url: 'one' }] }, {
    controller: new AbortController(), gate: new PauseGate(),
    fetchChunk: async item => {
      requested.push(item.url);
      return item.url === 'init' ? first.promise : second.promise;
    }
  });
  await nextTurn();
  assert.deepEqual(requested, ['init', 'one']);
  second.resolve(new Uint8Array([2]));
  first.resolve(new Uint8Array([1]));
  assert.deepEqual((await pending).map(part => part[0]), [1, 2]);
});

test('failure aborts and drains other workers before an attempt finishes', async () => {
  const controller = new AbortController();
  const failed = deferred();
  let drained = false;
  const pending = fetchTrack({ segments: [{ url: 'fail' }, { url: 'slow' }] }, {
    controller, gate: new PauseGate(),
    fetchChunk: async (item, { signal }) => {
      if (item.url === 'fail') { await failed.promise; throw new Error('Network unavailable'); }
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', async () => {
          await nextTurn();
          drained = true;
          reject(signal.reason);
        }, { once: true });
      });
    }
  });
  await nextTurn();
  failed.resolve();
  await assert.rejects(pending, /Network unavailable/);
  assert.equal(controller.signal.aborted, true);
  assert.equal(drained, true);
});

test('empty tracks fail rather than producing an empty download', async () => {
  await assert.rejects(fetchTrack({ segments: [] }, { controller: new AbortController(), gate: new PauseGate() }), /no downloadable segments/);
});

test('elapsed labels show zero, minutes, and hours without wrapping', () => {
  assert.equal(elapsedLabel(0), '0:00');
  assert.equal(elapsedLabel(65.9), '1:05');
  assert.equal(elapsedLabel(3602), '1:00:02');
});
