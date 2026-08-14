// storage.js — localStorage helpers. ONLY the API key and small UI settings are
// ever persisted here. Photos and session data are NEVER written to
// localStorage (the opt-in specimen library uses IndexedDB — see library.js).

const KEY_API = 'rockid.apiKey';
const KEY_MODEL_OVERRIDE = 'rockid.modelOverride'; // optional: user-chosen model id

export function getApiKey() {
  try {
    return localStorage.getItem(KEY_API) || '';
  } catch {
    return '';
  }
}

export function setApiKey(key) {
  try {
    localStorage.setItem(KEY_API, key);
  } catch {
    /* private mode / storage disabled — key simply won't persist */
  }
}

export function clearApiKey() {
  try {
    localStorage.removeItem(KEY_API);
  } catch {
    /* ignore */
  }
}

export function hasApiKey() {
  return getApiKey().length > 0;
}

// Mask a key for display: keep the "AIza" prefix and last 4 chars.
// Never log or render the full key anywhere.
export function maskApiKey(key) {
  const k = key || '';
  if (k.length <= 8) return '••••';
  const head = k.slice(0, 4);
  const tail = k.slice(-4);
  return `${head}••••••••${tail}`;
}

export function getModelOverride() {
  try {
    return localStorage.getItem(KEY_MODEL_OVERRIDE) || '';
  } catch {
    return '';
  }
}

export function setModelOverride(id) {
  try {
    if (id) localStorage.setItem(KEY_MODEL_OVERRIDE, id);
    else localStorage.removeItem(KEY_MODEL_OVERRIDE);
  } catch {
    /* ignore */
  }
}

// Ask the browser to treat this origin's storage as persistent.
//
// Safari's ITP can evict script-writable storage after roughly a week without
// a visit. That covers both stores this app uses: the API key here, and — the
// part actually worth protecting — the saved specimen library in IndexedDB,
// photos included (see library.js). Persistence is a request, not a guarantee:
// browsers weigh signals like installation and engagement, so a false result
// means "not granted", not "failed". Best-effort; never blocks startup.
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
