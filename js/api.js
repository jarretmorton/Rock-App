// api.js — Gemini client. Handles: MOCK_MODE fixtures, client-side image
// downscale, the generateContent fetch (header auth only), defensive JSON
// parsing, error mapping, and key validation.
//
// SECURITY: the API key is sent ONLY via the `x-goog-api-key` request header,
// never as a URL parameter, and is never logged.

import {
  MODEL_ID,
  MODEL_ID_FALLBACK,
  CANDIDATES_PROMPT,
  VERDICT_PROMPT,
  CANDIDATES_SCHEMA,
  VERDICT_SCHEMA,
  VALIDATION_PROMPT,
  buildVerdictContext,
} from './prompts.js';
import { getApiKey, getModelOverride, setModelOverride } from './storage.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// MOCK_MODE: on when `?mock=1` is present, or flip this constant to true.
const MOCK_CONST = false;
export const MOCK_MODE =
  MOCK_CONST ||
  (typeof location !== 'undefined' &&
    new URLSearchParams(location.search).get('mock') === '1');

// Downscale target: longest edge, JPEG quality. Keeps requests small & cheap.
const MAX_EDGE = 1024;
const JPEG_QUALITY = 0.85;

// --- Error type --------------------------------------------------------------
// Carries a user-facing message plus a `kind` the UI can branch on.
export class ApiError extends Error {
  constructor(kind, userMessage, detail) {
    super(userMessage);
    this.name = 'ApiError';
    this.kind = kind; // 'key' | 'rate' | 'network' | 'parse' | 'server' | 'notrock'
    this.userMessage = userMessage;
    this.detail = detail || null;
  }
}

// --- Image handling ----------------------------------------------------------
// Downscale a File/Blob to a base64 JPEG (no data: prefix). Returns { base64,
// mimeType, dataUrl } — dataUrl is for the in-memory preview only, never stored.
export async function downscaleImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return { base64, mimeType: 'image/jpeg', dataUrl };
}

// SHA-256 hex of the base64 image bytes (for session export — the hash, not the image).
export async function sha256OfBase64(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --- Defensive JSON parse ----------------------------------------------------
// Strips stray ```json fences / prose and parses. Throws ApiError('parse') with
// the raw text attached so the UI can show a collapsible debug block.
export function parseModelJson(text) {
  const raw = (text || '').trim();
  let candidate = raw;

  // Strip a leading/trailing code fence if present.
  const fence = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) candidate = fence[1].trim();

  // If there's leading/trailing prose, grab the outermost {...}.
  if (candidate[0] !== '{') {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first !== -1 && last > first) candidate = candidate.slice(first, last + 1);
  }

  try {
    return JSON.parse(candidate);
  } catch {
    throw new ApiError('parse', 'The model returned something we could not read as JSON.', raw);
  }
}

// --- Core fetch --------------------------------------------------------------
export function activeModel() {
  return getModelOverride() || MODEL_ID;
}

// Notifier so the UI can tell the user when we auto-downgrade the model.
// Registered from main.js via onModelDowngrade().
let downgradeNotifier = null;
export function onModelDowngrade(cb) {
  downgradeNotifier = cb;
}
function notifyDowngrade(model) {
  try {
    downgradeNotifier?.(model);
  } catch {
    /* a broken notifier must never break the request */
  }
}

// One attempt against a specific model. Throws ApiError on any failure.
async function requestOnce(model, key, body) {
  let resp;
  try {
    resp = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key, // header auth ONLY — never ?key= in the URL
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError('network', 'Network error — you may be offline. Check your connection and retry.', String(e));
  }

  if (!resp.ok) throw mapHttpError(resp.status, await safeText(resp));

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
  if (!text) {
    // Could be a safety block or an empty candidate.
    const block = data?.promptFeedback?.blockReason;
    throw new ApiError('server', block ? `The request was blocked (${block}).` : 'The model returned an empty response.', JSON.stringify(data));
  }
  return parseModelJson(text);
}

// parts: array of generateContent parts. schema: responseSchema object.
// Starts on the stronger model; on a rate limit, auto-downgrades to the
// flash-lite fallback (persisting the choice), tells the UI, and retries once.
async function generateContent(parts, schema) {
  const key = getApiKey();
  if (!key) throw new ApiError('key', 'No API key saved. Add one in Settings.');

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature: 0.2,
    },
  };

  const model = activeModel();
  try {
    return await requestOnce(model, key, body);
  } catch (e) {
    const canDowngrade = e instanceof ApiError && e.kind === 'rate' && model !== MODEL_ID_FALLBACK;
    if (!canDowngrade) throw e;
    // Switch to the lighter model for this and all future calls, then retry.
    setModelOverride(MODEL_ID_FALLBACK);
    notifyDowngrade(MODEL_ID_FALLBACK);
    return await requestOnce(MODEL_ID_FALLBACK, key, body);
  }
}

function mapHttpError(status, detailText) {
  if (status === 400 || status === 403) {
    return new ApiError('key', 'Key rejected — check it in Settings. (Region restrictions can also cause this: the free tier is not available in the EEA, UK, or Switzerland.)', detailText);
  }
  if (status === 429) {
    // The generateContent wrapper auto-downgrades to the lite model on the first
    // 429; this message is what the user sees only if even the lite model is
    // rate-limited (or on a validation call).
    return new ApiError('rate', "You've hit the free tier's rate limit on the lighter model too. Daily quotas reset at midnight Pacific — please wait and try again.", detailText);
  }
  if (status >= 500) {
    return new ApiError('server', 'Google had a server error. Try again in a moment.', detailText);
  }
  return new ApiError('server', `Unexpected error (HTTP ${status}).`, detailText);
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}

// --- Public calls ------------------------------------------------------------

// API call #1: image + optional context → candidates + questions.
export async function getCandidates({ base64, mimeType, userContext }) {
  if (MOCK_MODE) return mockCandidates(userContext);

  const parts = [{ text: CANDIDATES_PROMPT }];
  if (userContext) parts.push({ text: `User context: ${userContext}` });
  parts.push({ inline_data: { mime_type: mimeType, data: base64 } });
  return generateContent(parts, CANDIDATES_SCHEMA);
}

// API call #2: same image + candidates + answers → final verdict.
export async function getVerdict({ base64, mimeType, candidates, answers, userContext }) {
  if (MOCK_MODE) return mockVerdict();

  const parts = [
    { text: VERDICT_PROMPT },
    { text: buildVerdictContext({ candidates, answers, userContext }) },
    { inline_data: { mime_type: mimeType, data: base64 } },
  ];
  return generateContent(parts, VERDICT_SCHEMA);
}

// Fires a minimal text request to check a freshly pasted key. Returns true or
// throws ApiError with a specific message. Sends the candidate key via header.
export async function validateKey(key) {
  if (MOCK_MODE) return true;
  const model = activeModel();
  let resp;
  try {
    resp = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: VALIDATION_PROMPT }] }] }),
    });
  } catch (e) {
    throw new ApiError('network', 'Network error while validating — check your connection and retry.', String(e));
  }
  if (!resp.ok) throw mapHttpError(resp.status, await safeText(resp));
  return true;
}

// --- Mock mode ---------------------------------------------------------------
async function loadFixture(name) {
  const resp = await fetch(new URL(`../fixtures/${name}`, import.meta.url));
  if (!resp.ok) throw new ApiError('server', `Mock fixture ${name} not found.`);
  return resp.json();
}

// Small artificial delay so mock mode exercises the loading UI.
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function mockCandidates(userContext) {
  await delay(700);
  // Let a tester force the non-rock path by typing "not a rock" in context.
  if (userContext && /not a rock|brick|dog/i.test(userContext)) return loadFixture('not-a-rock.json');
  return loadFixture('candidates.json');
}

async function mockVerdict() {
  await delay(700);
  return loadFixture('verdict.json');
}
