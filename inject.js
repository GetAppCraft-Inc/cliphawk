// Runs in the page's MAIN world at document_start.
// Flags DRM (EME) and MediaSource usage on <html> so the popup can read it from the isolated world.
(() => {
  if (window.__clipHawk) return;
  window.__clipHawk = true;

  const mark = (k, v) => {
    const set = () => { try { document.documentElement.setAttribute(k, v); } catch { /* ignore */ } };
    if (document.documentElement) set();
    else document.addEventListener('readystatechange', set, { once: true });
  };

  let lastKeySystem = '';

  try {
    const nav = navigator;
    if (typeof nav.requestMediaKeySystemAccess === 'function') {
      const orig = nav.requestMediaKeySystemAccess;
      nav.requestMediaKeySystemAccess = function (keySystem, configs) {
        lastKeySystem = String(keySystem || '');
        return orig.call(this, keySystem, configs);
      };
    }
  } catch { /* ignore */ }

  try {
    const proto = HTMLMediaElement.prototype;
    const origSet = proto.setMediaKeys;
    if (typeof origSet === 'function') {
      proto.setMediaKeys = function (mediaKeys) {
        if (mediaKeys) mark('data-cliphawk-drm', lastKeySystem || 'EME');
        return origSet.call(this, mediaKeys);
      };
    }
  } catch { /* ignore */ }

  // 'encrypted' fires when the media itself carries protection info.
  document.addEventListener('encrypted', () => mark('data-cliphawk-drm', lastKeySystem || 'EME'), true);

  for (const name of ['MediaSource', 'ManagedMediaSource', 'WebKitMediaSource']) {
    try {
      const MS = window[name];
      if (!MS || !MS.prototype || typeof MS.prototype.addSourceBuffer !== 'function') continue;
      const orig = MS.prototype.addSourceBuffer;
      MS.prototype.addSourceBuffer = function (type) {
        mark('data-cliphawk-mse', String(type || '1'));
        return orig.call(this, type);
      };
    } catch { /* ignore */ }
  }
})();
