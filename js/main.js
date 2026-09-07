// main.js — application state machine and flow control.
// setup → capture → (loading) → candidates → diagnostics → verdict → export.

import {
  MOCK_MODE,
  ApiError,
  downscaleImage,
  sha256OfBase64,
  getCandidates,
  getVerdict,
  validateKey,
  activeModel,
  onModelDowngrade,
  imageFromDataUrl,
  setModelPair,
} from './api.js';
import { listModels, pickPair, isLite } from './models.js';
import {
  getApiKey,
  setApiKey,
  clearApiKey,
  hasApiKey,
  maskApiKey,
  setModelOverride,
  requestPersistence,
} from './storage.js';
import { PROMPT_VERSION } from './prompts.js';
import {
  specimenFromSession,
  saveSpecimen,
  listSpecimens,
  getSpecimen,
  deleteSpecimen,
  updateSpecimenNote,
} from './library.js';
import * as ui from './ui.js';

const $ = (id) => document.getElementById(id);

// App version — single source of truth, shown in the header. Bump on release.
export const APP_VERSION = '0.6.0';

// Models discovered from Google for this key, best first, plus the two the
// toggle cycles between. Empty until discovery runs; pickPair() falls back to
// the shipped constants so the UI works before and without it.
let discovered = [];
let pair = pickPair([]);

// --- Session state (in memory only; never persisted) -------------------------
let session = null;
function freshSession() {
  return {
    // Set once this session earns a library row, so every later save updates
    // that row instead of adding another.
    id: null,
    timestamp: new Date().toISOString(),
    model_id: activeModel(), // records the model actually called, discovered or not
    prompt_version: PROMPT_VERSION,
    image: null, // { base64, mimeType, dataUrl } — NOT exported
    image_sha256: null,
    context: '',
    call1_response: null,
    answers: [], // [{ id, question, answer }]
    call2_response: null,
    // diagnostics cursor
    _qIndex: 0,
  };
}

// --- Screen router -----------------------------------------------------------
const SCREENS = [
  'screen-setup',
  'screen-capture',
  'screen-loading',
  'screen-candidates',
  'screen-notrock',
  'screen-diagnostics',
  'screen-verdict',
  'screen-library',
  'screen-library-detail',
];

function show(screenId) {
  for (const id of SCREENS) $(id).hidden = id !== screenId;
  window.scrollTo(0, 0);
}

function showLoading(msg) {
  $('loading-msg').textContent = msg;
  show('screen-loading');
}

// --- Boot --------------------------------------------------------------------
function boot() {
  // Fire-and-forget: asks the browser not to evict the saved library.
  requestPersistence();

  wireHeader();
  wireSetup();
  wireCapture();
  wireCandidates();
  wireDiagnostics();
  wireVerdict();
  wireLibrary();
  wireModelBanner();

  // When the API auto-downgrades after a rate limit, tell the user.
  onModelDowngrade((model) => showModelBanner(model));

  session = freshSession();

  if (MOCK_MODE || hasApiKey()) {
    show('screen-capture');
    refreshModelList(); // background: find the current best without opening Settings
  } else {
    renderSetup();
    show('screen-setup');
  }
}

// --- Header ------------------------------------------------------------------
function wireHeader() {
  $('app-version').textContent = `v${APP_VERSION}`;
  $('home-btn').addEventListener('click', () => {
    show(MOCK_MODE || hasApiKey() ? 'screen-capture' : 'screen-setup');
  });
  $('settings-btn').addEventListener('click', () => {
    renderSetup();
    show('screen-setup');
  });
  $('library-btn').addEventListener('click', openLibrary);
}

// --- 1. Setup / Settings -----------------------------------------------------
function renderSetup() {
  const saved = hasApiKey();
  // The key field is always present now; a saved key shows as a mask beside it
  // rather than being rendered back into the input.
  $('key-input').value = '';
  $('key-input').placeholder = saved ? 'Paste a new key to replace it' : 'AIza…';
  $('key-mask').hidden = !saved;
  $('key-mask').textContent = saved ? `Saved key: ${maskApiKey(getApiKey())}` : '';
  $('key-remove-btn').disabled = !saved;
  hideKeyConfirm();
  // "Start identifying" shows once a key exists (or in mock mode).
  $('setup-continue-btn').hidden = !(saved || MOCK_MODE);
  $('key-status').replaceChildren();

  if (MOCK_MODE) {
    $('key-status').replaceChildren(
      ui.statusLine('Mock mode is on (?mock=1) — no key needed. Real requests are disabled.', 'info')
    );
  }

  renderModelRow();
  refreshModelList();
}

// Fill the picker from whatever discovery found, always including the model in
// use so the select can never silently disagree with what the app will call.
function renderModelRow() {
  const current = activeModel();
  const options = discovered.slice();
  if (!options.some((m) => m.id === current)) options.unshift({ id: current, label: current });

  const select = $('model-select');
  select.replaceChildren(
    ...options.map((m) => {
      const tag = m.id === pair.best ? ' — best free' : m.id === pair.lite ? ' — lighter, higher limits' : '';
      const opt = ui.el('option', { value: m.id, text: `${m.label}${tag}` });
      opt.selected = m.id === current;
      return opt;
    })
  );

  const onLite = isLite(current);
  $('model-toggle-btn').textContent = onLite ? 'Use the best free model' : 'Switch to the lighter model';
  $('model-note').textContent = onLite
    ? 'On the lighter model: higher rate limits, slightly less detail.'
    : 'On the strongest free model.';
}

// Ask Google what this key can reach. Best-effort: no key, no network or a
// refused list just leaves the shipped defaults in place.
async function refreshModelList() {
  if (MOCK_MODE || !hasApiKey()) return;
  try {
    const found = await listModels(getApiKey());
    if (!found.length) return;
    discovered = found;
    pair = pickPair(found);
    setModelPair(pair);
    renderModelRow();
  } catch {
    /* keep the built-in defaults; the picker still works */
  }
}

function wireSetup() {
  $('key-save-btn').addEventListener('click', onSaveKey);
  $('key-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSaveKey();
  });

  // Forgetting the key is destructive and can't be undone here, so it asks.
  $('key-remove-btn').addEventListener('click', () => {
    $('key-confirm').hidden = false;
    $('key-confirm-yes').focus();
  });
  $('key-confirm-no').addEventListener('click', () => {
    hideKeyConfirm();
    $('key-remove-btn').focus();
  });
  $('key-confirm-yes').addEventListener('click', () => {
    clearApiKey();
    discovered = []; // the list belonged to that key
    pair = pickPair([]);
    renderSetup();
    $('key-status').replaceChildren(ui.statusLine('Key removed from this device.', 'info'));
  });

  $('setup-continue-btn').addEventListener('click', () => show('screen-capture'));

  $('model-select').addEventListener('change', (e) => {
    // Selecting the best model clears the override so this browser keeps
    // following the default as it moves; anything else is pinned.
    setModelOverride(e.target.value === pair.best ? '' : e.target.value);
    hideModelBanner();
    renderModelRow();
  });
  $('model-toggle-btn').addEventListener('click', () => {
    const goingLite = !isLite(activeModel());
    setModelOverride(goingLite ? pair.lite : '');
    if (!goingLite) hideModelBanner();
    renderModelRow();
  });
}

function hideKeyConfirm() {
  $('key-confirm').hidden = true;
}

// --- Model downgrade banner --------------------------------------------------
function wireModelBanner() {
  $('model-banner-dismiss').addEventListener('click', hideModelBanner);
}

function showModelBanner(model) {
  $('model-banner-text').textContent =
    `Hit the rate limit — switched to the lighter model (${model}) to keep going. Results may be a little less detailed. Change this in Settings.`;
  $('model-banner').hidden = false;
}

function hideModelBanner() {
  $('model-banner').hidden = true;
}

async function onSaveKey() {
  const key = $('key-input').value.trim();
  const statusEl = $('key-status');
  if (!key) {
    statusEl.replaceChildren(ui.statusLine('Paste a key first.', 'err'));
    return;
  }
  statusEl.replaceChildren(ui.statusLine('Validating…', 'info'));
  $('key-save-btn').disabled = true;
  try {
    await validateKey(key); // fires a minimal request via header auth
    setApiKey(key);
    statusEl.replaceChildren(ui.statusLine('✓ Key validated and saved.', 'ok'));
    renderSetup();
  } catch (err) {
    const msg = err instanceof ApiError ? err.userMessage : 'Could not validate the key.';
    statusEl.replaceChildren(ui.statusLine(`✗ ${msg}`, 'err'));
  } finally {
    $('key-save-btn').disabled = false;
  }
}

// --- 2. Capture --------------------------------------------------------------
function wireCapture() {
  const input = $('photo-input');
  const dz = $('dropzone');

  input.addEventListener('change', () => {
    if (input.files?.[0]) handleFile(input.files[0]);
  });

  // Desktop drag-and-drop.
  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add('dropzone-over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove('dropzone-over');
    })
  );
  dz.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  });

  $('context-input').addEventListener('input', (e) => {
    session.context = e.target.value;
  });

  $('identify-btn').addEventListener('click', onIdentify);
}

async function handleFile(file) {
  const status = $('capture-status');
  if (!file.type.startsWith('image/')) {
    status.replaceChildren(ui.statusLine('That file is not an image.', 'err'));
    return;
  }
  status.replaceChildren(ui.statusLine('Preparing image…', 'info'));
  try {
    const img = await downscaleImage(file);
    session.image = img;
    session.image_sha256 = await sha256OfBase64(img.base64);
    $('preview-img').src = img.dataUrl;
    $('preview-wrap').hidden = false;
    $('identify-btn').disabled = false;
    status.replaceChildren();
  } catch (e) {
    status.replaceChildren(ui.statusLine('Could not read that image. Try another.', 'err'));
  }
}

async function onIdentify() {
  if (!session.image) return;
  showLoading('Examining the rock…');
  try {
    const data = await getCandidates({
      base64: session.image.base64,
      mimeType: session.image.mimeType,
      userContext: session.context,
    });
    session.call1_response = data;

    if (!data.is_identifiable_rock || !data.candidates?.length) {
      $('notrock-msg').textContent =
        data.image_quality_feedback || "That doesn't look like a single natural rock.";
      show('screen-notrock');
      return;
    }
    ui.renderCandidates($('candidates-out'), data);
    // Kept from here on, so abandoning the diagnostics doesn't lose the photo
    // and the candidates that came back with it.
    await saveToLibrary();
    show('screen-candidates');
  } catch (err) {
    handleApiError(err, onIdentify);
  }
}

// --- 3. Candidates -----------------------------------------------------------
function wireCandidates() {
  $('start-diagnostics-btn').addEventListener('click', () => {
    session._qIndex = 0;
    session.answers = [];
    renderCurrentQuestion();
    show('screen-diagnostics');
  });
  $('candidates-retake-btn').addEventListener('click', backToCapture);
  $('notrock-retake-btn').addEventListener('click', backToCapture);
}

// --- 4. Diagnostics ----------------------------------------------------------
function wireDiagnostics() {
  $('skip-diagnostics-btn').addEventListener('click', finishDiagnostics);
}

function questions() {
  return session.call1_response?.questions || [];
}

function renderCurrentQuestion() {
  const qs = questions();
  const q = qs[session._qIndex];
  if (!q) return finishDiagnostics();
  ui.renderQuestion($('question-out'), {
    question: q,
    index: session._qIndex,
    total: qs.length,
    onAnswer: (answer) => {
      session.answers.push({ id: q.id, question: q.text, answer });
      session._qIndex += 1;
      saveToLibrary(); // keep the answers even if the run is abandoned here
      if (session._qIndex >= qs.length) finishDiagnostics();
      else renderCurrentQuestion();
    },
  });
}

async function finishDiagnostics() {
  showLoading('Weighing your answers…');
  try {
    const data = await getVerdict({
      base64: session.image.base64,
      mimeType: session.image.mimeType,
      candidates: session.call1_response.candidates,
      answers: session.answers,
      userContext: session.context,
    });
    session.call2_response = data;
    ui.renderVerdict($('verdict-out'), data);
    await saveToLibrary(); // fold the answers and the verdict into the row
    renderSaveState();
    show('screen-verdict');
  } catch (err) {
    handleApiError(err, finishDiagnostics);
  }
}

// --- 5. Verdict + export -----------------------------------------------------
function wireVerdict() {
  $('download-session-btn').addEventListener('click', () => downloadSession(session));
  $('library-remove-btn').addEventListener('click', onRemoveFromLibrary);
  $('restart-btn').addEventListener('click', () => {
    session = freshSession();
    resetCaptureUi();
    show('screen-capture');
  });
}

// Write the session to its library row, creating the row the first time.
// Best-effort throughout: storage can be unavailable (private mode, a full
// disk) and losing the library must never cost you the identification on
// screen, so a failure only marks the session unsaved.
let librarySaveFailed = false;
async function saveToLibrary() {
  // Nothing to keep until the model has actually identified something.
  if (!session?.call1_response?.candidates?.length) return;
  try {
    const entry = specimenFromSession(session);
    session.id = entry.id; // first save fixes the id; later ones update it
    await saveSpecimen(entry);
    librarySaveFailed = false;
  } catch {
    librarySaveFailed = true;
  }
}

// Tell the user where the specimen went — and offer a way out, since it was
// kept without being asked and a photo is part of what's kept.
function renderSaveState() {
  const status = $('save-status');
  const removeBtn = $('library-remove-btn');
  if (librarySaveFailed || !session?.id) {
    removeBtn.hidden = true;
    status.replaceChildren(
      ui.statusLine('Not saved — your browser may block local storage in private mode.', 'err')
    );
    return;
  }
  removeBtn.hidden = false;
  status.replaceChildren(
    ui.statusLine('Saved to this device automatically. Open it any time from the library (▤).', 'ok')
  );
}

async function onRemoveFromLibrary() {
  if (!session?.id) return;
  try {
    await deleteSpecimen(session.id);
  } catch {
    /* already gone, or storage is unavailable — either way it isn't saved */
  }
  session.id = null;
  $('library-remove-btn').hidden = true;
  $('save-status').replaceChildren(
    ui.statusLine('Removed from your library. This one is not kept on the device.', 'info')
  );
}

// The stable session-export shape (also used to export a saved specimen).
// Note: the image itself is NEVER included here, only its SHA-256 hash.
function sessionExportShape(src) {
  return {
    timestamp: src.timestamp,
    model_id: src.model_id,
    prompt_version: src.prompt_version,
    image_sha256: src.image_sha256,
    context: src.context || '',
    call1_response: src.call1_response,
    answers: src.answers,
    call2_response: src.call2_response,
  };
}

function downloadSession(src) {
  const out = sessionExportShape(src);
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rockid-session-${(src.timestamp || 'export').replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// --- 6. Library --------------------------------------------------------------
function wireLibrary() {
  $('library-back-btn').addEventListener('click', openLibrary);
}

async function openLibrary() {
  let specimens = [];
  try {
    specimens = await listSpecimens();
  } catch {
    /* IndexedDB unavailable (e.g. private mode) — show empty state */
  }
  ui.renderLibrary($('library-out'), specimens, { onOpen: openSpecimen });
  show('screen-library');
}

async function openSpecimen(id) {
  const s = await getSpecimen(id);
  if (!s) return openLibrary();
  ui.renderSpecimenDetail($('library-detail-out'), s, {
    onExport: (spec) => downloadSession(spec),
    onRedo: (spec) => redoSpecimen(spec),
    onSaveNote: async (text) => {
      await updateSpecimenNote(s.id, text);
      s.context = text; // keep the in-memory copy in sync for re-identify/export
    },
    onDelete: async (delId) => {
      await deleteSpecimen(delId);
      openLibrary();
    },
  });
  show('screen-library-detail');
}

// Re-run the identification for a saved specimen: load its photo + note into a
// fresh session (new timestamp, current model) and drop into the normal flow.
// The original entry is left untouched; the redo's result can be saved as a new
// library entry from the verdict screen.
async function redoSpecimen(s) {
  const image = imageFromDataUrl(s.image_data_url);
  if (!image) return; // nothing to re-identify without the stored photo
  session = freshSession();
  session.image = image;
  session.image_sha256 = s.image_sha256 || null;
  session.context = s.context || '';
  await onIdentify();
}

// --- Shared helpers ----------------------------------------------------------
function backToCapture() {
  show('screen-capture');
}

function resetCaptureUi() {
  $('preview-wrap').hidden = true;
  $('preview-img').removeAttribute('src');
  $('identify-btn').disabled = true;
  $('photo-input').value = '';
  $('context-input').value = '';
  $('capture-status').replaceChildren();
}

// Central API error handling. `retry` re-runs the failed action.
function handleApiError(err, retry) {
  const e = err instanceof ApiError ? err : new ApiError('server', String(err?.message || err));
  const out = $('candidates-out'); // reuse an on-screen spot for parse debug
  console.warn('RockID error:', e.kind); // never logs the key or the message detail

  // Return the user to a screen with the error visible + a retry.
  const host = document.createElement('div');
  host.className = 'error-box';
  host.append(ui.statusLine(e.userMessage, 'err'));

  const actions = ui.el('div', { class: 'row' });
  if (e.kind === 'key') {
    actions.append(
      ui.el('button', { class: 'primary-btn', type: 'button', text: 'Open Settings', onclick: () => { renderSetup(); show('screen-setup'); } })
    );
  }
  if (e.kind !== 'key') {
    actions.append(ui.el('button', { class: 'primary-btn', type: 'button', text: 'Retry', onclick: retry }));
  }
  actions.append(ui.el('button', { class: 'secondary-btn', type: 'button', text: 'Back to photo', onclick: backToCapture }));
  host.append(actions);

  if (e.kind === 'parse' && e.detail) ui.renderRawDebug(host, e.detail);

  // Render on the capture screen as a neutral home for errors.
  resetErrorHost(host);
}

function resetErrorHost(host) {
  const cap = $('screen-capture');
  // Drop any prior error box, then show capture with the error on top.
  cap.querySelectorAll('.error-box').forEach((n) => n.remove());
  cap.prepend(host);
  show('screen-capture');
}

boot();
