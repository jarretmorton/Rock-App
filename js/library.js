// library.js — the saved-specimen library, backed by IndexedDB.
//
// This is the ONE place in the app that persists images. Everything here stays
// on the user's own device (IndexedDB); nothing is uploaded anywhere. Saving is
// opt-in: an entry is written only when the user taps "Save to library".

const DB_NAME = 'rockid-library';
const DB_VERSION = 1;
const STORE = 'specimens';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode) {
  return openDb().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// A stable id that doesn't depend on wall-clock uniqueness.
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Build a library entry from a completed session. Includes the downscaled image
// data URL (this is the deliberate exception to the app's no-persistence rule).
export function specimenFromSession(session) {
  const verdict = session.call2_response;
  return {
    id: newId(),
    timestamp: session.timestamp,
    image_data_url: session.image?.dataUrl || null,
    image_sha256: session.image_sha256,
    name: verdict?.final?.name || 'Unknown',
    confidence: verdict?.final?.confidence ?? null,
    context: session.context || '',
    model_id: session.model_id,
    prompt_version: session.prompt_version,
    call1_response: session.call1_response,
    answers: session.answers,
    call2_response: session.call2_response,
  };
}

export async function saveSpecimen(entry) {
  const store = await tx('readwrite');
  await wrap(store.put(entry));
  return entry.id;
}

// Newest first.
export async function listSpecimens() {
  const store = await tx('readonly');
  const all = await wrap(store.getAll());
  return all.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

export async function getSpecimen(id) {
  const store = await tx('readonly');
  return wrap(store.get(id));
}

export async function deleteSpecimen(id) {
  const store = await tx('readwrite');
  return wrap(store.delete(id));
}

export async function countSpecimens() {
  const store = await tx('readonly');
  return wrap(store.count());
}
