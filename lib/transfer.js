import { fetchBytes } from './download.js';

// Pausing waits at a segment boundary. Requests already in flight are allowed to finish.
export class PauseGate {
  paused = false;
  #waiters = new Set();

  pause() { this.paused = true; }

  resume() {
    this.paused = false;
    for (const release of [...this.#waiters]) release();
  }

  async wait(signal) {
    signal?.throwIfAborted();
    if (!this.paused) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.#waiters.delete(release);
        signal?.removeEventListener('abort', abort);
      };
      const release = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal.reason); };
      this.#waiters.add(release);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
  }
}

export async function fetchTrack(track, {
  controller, gate, onProgress = () => {}, onBytes = () => {}, onActive = () => {},
  fetchChunk = fetchBytes, concurrency = 6
}) {
  const items = track.init ? [track.init, ...track.segments] : track.segments;
  if (!items.length) throw new Error('Stream has no downloadable segments');
  const parts = new Array(items.length);
  let next = 0, completed = 0, bytes = 0, active = 0, failure;
  const signal = controller.signal;
  const worker = async () => {
    try {
      while (true) {
        await gate.wait(signal);
        const index = next++;
        if (index >= items.length) return;
        let previous = 0;
        active++;
        onActive(active);
        try {
          parts[index] = await fetchChunk(items[index], {
            signal,
            onBytes: (got, total) => {
              const delta = got < previous ? got : got - previous;
              previous = got;
              onBytes(delta);
              if (items.length === 1) onProgress({ fraction: total ? got / total : 0, bytes: got, completed: 0, total: 1 });
            }
          });
        } finally {
          active--;
          onActive(active);
        }
        completed++;
        bytes += parts[index].byteLength;
        onProgress({ fraction: completed / items.length, bytes, completed, total: items.length });
      }
    } catch (error) {
      if (!failure) failure = error;
      controller.abort(error);
      throw error;
    }
  };
  // Drain every worker before allowing Retry to start a new attempt.
  await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failure) throw failure;
  signal.throwIfAborted();
  return parts;
}

export function elapsedLabel(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  const h = Math.floor(value / 3600), m = Math.floor(value / 60) % 60, s = value % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
