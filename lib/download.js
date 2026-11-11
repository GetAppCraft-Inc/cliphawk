// Fetch helpers shared by the downloader and its regression tests.
class ResponseError extends Error {}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function fetchBytes(item, { signal, onBytes, timeout = 30000, retries = 3, retryDelay = 600 } = {}) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const ctrl = new AbortController();
    const abort = () => ctrl.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    let timer;
    const resetTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(new Error('Download request timed out')), timeout);
    };
    resetTimeout();
    try {
      const headers = item.range ? { Range: `bytes=${item.range.start}-${item.range.end}` } : {};
      const r = await fetch(item.url, { credentials: 'include', headers, signal: ctrl.signal });
      resetTimeout();
      if (!r.ok) {
        const message = `HTTP ${r.status} while downloading media`;
        await r.body?.cancel();
        if (r.status === 408 || r.status === 429 || r.status >= 500) throw new Error(message);
        throw new ResponseError(message);
      }
      // Appending a full response for every range silently corrupts the output.
      if (item.range) {
        const range = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i.exec(r.headers.get('content-range') || '');
        if (r.status !== 206 || !range || Number(range[1]) !== item.range.start || Number(range[2]) !== item.range.end) {
          await r.body?.cancel();
          throw new ResponseError('Server did not return the requested byte range');
        }
      }
      const total = Number(r.headers.get('content-length')) || 0;
      // A fresh response also starts a fresh progress counter after a retry.
      onBytes?.(0, total);
      const chunks = [];
      let got = 0;
      if (r.body) {
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // The limit measures inactivity, so large files can keep progressing.
          resetTimeout();
          chunks.push(value);
          got += value.byteLength;
          onBytes?.(got, total);
        }
      }
      if (item.range && got !== item.range.end - item.range.start + 1) throw new Error('Incomplete byte-range response');
      if (!got) throw new Error('Server returned empty media');
      const out = new Uint8Array(got);
      let offset = 0;
      for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
      return out;
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      if (e instanceof ResponseError || attempt >= retries) throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    await wait(retryDelay * 2 ** attempt, signal);
  }
}

// Subscribe before checking state so even very fast downloads cannot be missed.
export function waitForDownload(id, downloads = chrome.downloads) {
  return new Promise((resolve, reject) => {
    const finish = state => {
      if (state !== 'complete' && state !== 'interrupted') return;
      downloads.onChanged.removeListener(onChange);
      resolve(state);
    };
    const onChange = delta => { if (delta.id === id) finish(delta.state?.current); };
    downloads.onChanged.addListener(onChange);
    downloads.search({ id }).then(items => {
      if (!items.length) throw new Error('Download no longer exists');
      finish(items[0].state);
    }).catch(error => {
      downloads.onChanged.removeListener(onChange);
      reject(error);
    });
  });
}
