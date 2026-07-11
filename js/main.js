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
} from './api.js';
import {
  getApiKey,
  setApiKey,
  clearApiKey,
  hasApiKey,
  maskApiKey,
  getModelOverride,
} from './storage.js';
import {
  MODEL_ID,
  PROMPT_VERSION,
} from './prompts.js';
import {
  specimenFromSession,
  saveSpecimen,
  listSpecimens,
  getSpecimen,
  deleteSpecimen,
} from './library.js';
import * as ui from './ui.js';

const $ = (id) => document.getElementById(id);

// App version — single source of truth, shown in the header. Bump on release.
export const APP_VERSION = '0.2.0';

// --- Session state (in memory only; never persisted) -------------------------
let session = null;
function freshSession() {
  return {
    timestamp: new Date().toISOString(),
    model_id: getModelOverride() || MODEL_ID,
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
  wireHeader();
  wireSetup();
  wireCapture();
  wireCandidates();
  wireDiagnostics();
  wireVerdict();
  wireLibrary();

  session = freshSession();

  if (MOCK_MODE || hasApiKey()) {
    show('screen-capture');
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
  $('key-entry').hidden = saved;
  $('key-saved').hidden = !saved;
  // "Start identifying" shows once a key exists (or in mock mode).
  $('setup-continue-btn').hidden = !(saved || MOCK_MODE);
  $('key-status').replaceChildren();

  if (saved) $('key-mask').textContent = maskApiKey(getApiKey());
  if (MOCK_MODE) {
    $('key-status').replaceChildren(
      ui.statusLine('Mock mode is on (?mock=1) — no key needed. Real requests are disabled.', 'info')
    );
  }
}

function wireSetup() {
  $('key-save-btn').addEventListener('click', onSaveKey);
  $('key-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSaveKey();
  });
  $('key-change-btn').addEventListener('click', () => {
    $('key-entry').hidden = false;
    $('key-saved').hidden = true;
    $('key-input').value = '';
    $('key-input').focus();
  });
  $('key-remove-btn').addEventListener('click', () => {
    clearApiKey();
    renderSetup();
  });
  $('setup-continue-btn').addEventListener('click', () => show('screen-capture'));
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
    resetSaveButton();
    show('screen-verdict');
  } catch (err) {
    handleApiError(err, finishDiagnostics);
  }
}

// --- 5. Verdict + export -----------------------------------------------------
function wireVerdict() {
  $('download-session-btn').addEventListener('click', () => downloadSession(session));
  $('save-library-btn').addEventListener('click', onSaveToLibrary);
  $('restart-btn').addEventListener('click', () => {
    session = freshSession();
    resetCaptureUi();
    show('screen-capture');
  });
}

// Reset the Save-to-library button to its default state (called each time a
// fresh verdict is shown).
function resetSaveButton() {
  const btn = $('save-library-btn');
  btn.disabled = false;
  btn.textContent = '＋ Save to library';
  $('save-status').replaceChildren();
}

async function onSaveToLibrary() {
  const btn = $('save-library-btn');
  try {
    const entry = specimenFromSession(session);
    await saveSpecimen(entry);
    btn.disabled = true;
    btn.textContent = '✓ Saved to library';
    $('save-status').replaceChildren(ui.statusLine('Saved to this device. Open it any time from the library (▤).', 'ok'));
  } catch (e) {
    $('save-status').replaceChildren(ui.statusLine('Could not save — your browser may block local storage in private mode.', 'err'));
  }
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
    onDelete: async (delId) => {
      await deleteSpecimen(delId);
      openLibrary();
    },
  });
  show('screen-library-detail');
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
