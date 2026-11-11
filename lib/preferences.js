export const DEFAULT_PREFERENCES = Object.freeze({ theme: 'system', quality: 'best', saveAs: false });

export function normalizePreferences(value = {}) {
  return {
    theme: ['system', 'dark', 'light'].includes(value?.theme) ? value.theme : 'system',
    quality: ['best', '720', '480'].includes(value?.quality) ? value.quality : 'best',
    saveAs: value?.saveAs === true
  };
}

export async function readPreferences() {
  const stored = await chrome.storage.local.get('preferences');
  return normalizePreferences(stored.preferences);
}

export async function savePreferences(value) {
  const preferences = normalizePreferences(value);
  await chrome.storage.local.set({ preferences });
  return preferences;
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = normalizePreferences({ theme }).theme;
}

// Prefer the highest available quality at or below the user's limit.
export function preferredVariant(variants, quality) {
  if (quality === 'best' || !variants?.length) return 0;
  const cap = Number(quality);
  const measured = variants.map((label, index) => ({ index, height: Number(/^(\d+)p\b/.exec(label)?.[1]) || 0 }))
    .filter(v => v.height).sort((a, b) => b.height - a.height);
  return (measured.find(v => v.height <= cap) || measured.at(-1))?.index || 0;
}
