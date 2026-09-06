// models.js — live model discovery, so the app doesn't ship a name that rots.
//
// Google's ListModels endpoint reports which models a key can actually reach.
// What it does NOT report is price: there is no free-tier or cost field in the
// response (verified against the documented schema — name, version,
// displayName, description, token limits, supportedGenerationMethods, sampling
// params, and nothing else). So "free" here is INFERRED from the family:
// Flash and Flash-Lite are the tiers Google offers at no cost, Pro is not.
// That inference is the one soft spot in this file; if Google changes which
// families are free, `keep()` is the line to revisit.
//
// Discovery is an enhancement, never a dependency: every caller falls back to
// the constants in prompts.js when the network, the key, or the list is absent.

import { MODEL_ID, MODEL_ID_FALLBACK } from './prompts.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ListModels prefixes every name with "models/".
const shortId = (name) => String(name || '').replace(/^models\//, '');

// The numeric part of a Gemini id: "gemini-3.8-flash" -> 3.8. Ordering only,
// so anything unparseable sorts last instead of throwing.
export function versionOf(id) {
  const m = /gemini-(\d+(?:\.\d+)?)/.exec(id);
  return m ? parseFloat(m[1]) : 0;
}

export const isLite = (id) => /-lite/.test(id);
const isPreview = (id) => /preview|experimental|-exp/.test(id);

// Keep the text-capable Flash family; drop embedding, image, TTS, live and Pro.
function keep(model) {
  const id = shortId(model.name);
  return (model.supportedGenerationMethods || []).includes('generateContent') &&
    /^gemini-/.test(id) &&
    /flash/.test(id) &&
    !/embedding|aqa|image|tts|audio|live/.test(id);
}

// Newest first; at equal versions a stable release beats a preview, and only
// then does full Flash beat Lite. Stability outranks power on purpose: a
// stable Flash-Lite is a better thing to offer than a preview that may move
// or vanish under the user.
function byPreference(a, b) {
  return versionOf(b.id) - versionOf(a.id) ||
    isPreview(a.id) - isPreview(b.id) ||
    isLite(a.id) - isLite(b.id) ||
    a.id.localeCompare(b.id);
}

// Every free-tier chat model this key can reach, best first. Throws on a bad
// key or a network failure — callers treat that as "no list", not as fatal.
export async function listModels(key) {
  const found = [];
  let pageToken = '';
  do {
    const url = `${API_BASE}?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const resp = await fetch(url, { headers: { 'x-goog-api-key': key } });
    if (!resp.ok) throw new Error(`ListModels returned ${resp.status}`);
    const data = await resp.json();
    found.push(...(data.models || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return found
    .filter(keep)
    .map((m) => ({ id: shortId(m.name), label: m.displayName || shortId(m.name) }))
    .sort(byPreference);
}

// The two models the app cycles between: the strongest free Flash, and the
// lighter one with higher rate limits. Falls back to the shipped constants so
// the toggle works before (or without) any discovery.
export function pickPair(models) {
  const list = models || [];
  return {
    best: list.find((m) => !isLite(m.id))?.id || MODEL_ID,
    lite: list.find((m) => isLite(m.id))?.id || MODEL_ID_FALLBACK,
  };
}
