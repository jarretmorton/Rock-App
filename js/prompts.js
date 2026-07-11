// prompts.js — SACRED FILE.
// Every string sent to the model lives here, plus all model/version constants.
// Nothing model-facing may be scattered elsewhere in the codebase. This file is
// designed to be diffed, iterated on, and benchmarked.

// --- Model configuration -----------------------------------------------------
// Verified against https://ai.google.dev/gemini-api/docs/models (2026).
// gemini-3.5-flash is the current free-tier multimodal Flash model.
// If it 404s (model names go stale fast), swap to the fallback or a 2.5 variant.
export const MODEL_ID = 'gemini-3.5-flash';
export const MODEL_ID_FALLBACK = 'gemini-3.1-flash-lite'; // lighter, higher RPM — use when rate-limited

// Bump on ANY change to the prompt strings or schemas below. This string is
// written into every session export so results are traceable to a prompt build.
export const PROMPT_VERSION = 'rockid-2026-07-11-a';

// --- Candidates call (API call #1) -------------------------------------------
// The model receives: this text part + one inline image + optional user context.
// We also send CANDIDATES_SCHEMA as generationConfig.responseSchema, but the
// prompt restates the shape because schema adherence is not guaranteed.
export const CANDIDATES_PROMPT = `You are a careful field geologist helping identify a rock from a single photo.

Photo-only rock identification is INHERENTLY UNRELIABLE. Do not pretend otherwise. Your job is not to guess a single answer — it is to propose the most likely candidates and then design the physical tests that would actually distinguish them, the way a geologist works in the field.

Return STRICT JSON matching this shape (no prose, no markdown):
{
  "is_identifiable_rock": boolean,        // false for a brick, a dog, a coin, or several rocks at once
  "image_quality_feedback": string|null,  // one short sentence if the photo hurts identification, else null
  "candidates": [
    {
      "name": string,                      // common rock or mineral name, e.g. "Basalt"
      "type": "igneous"|"sedimentary"|"metamorphic"|"mineral",
      "confidence": number,                // 0..1, your honest probability given ONLY this photo
      "visual_evidence": string,           // what in THIS specific photo supports it (color, grain, luster, texture)
      "commonly_confused_with": string[]   // rocks this is easily mistaken for
    }
  ],
  "questions": [
    {
      "id": string,                        // "q1", "q2", ...
      "text": string,                      // a yes/no-ish physical diagnostic question
      "how_to": string,                    // one sentence: how to safely perform the test
      "answers": string[],                 // tappable options, ALWAYS include "Can't test"
      "discriminates": string              // which candidates this separates and why
    }
  ]
}

Rules:
- Provide EXACTLY 3 candidates, ordered most→least likely. Return fewer only if you are highly confident.
- Provide 2 to 4 questions, ordered by how much they discriminate between your candidates (most decisive first).
- Prefer cheap, safe, common tests: vinegar fizz (carbonate), glass/steel scratch (hardness), streak color on unglazed porcelain, magnetism, heft/density, grain size, layering, reaction to a magnet.
- Every question's "answers" array MUST include "Can't test".
- If is_identifiable_rock is false, return an empty candidates array and an empty questions array, and put the reason in image_quality_feedback.
- Confidence is your genuine uncertainty from a photo alone. Do not inflate it.`;

// --- Verdict call (API call #2) ----------------------------------------------
// Receives: this text part + the SAME image again + a JSON blob of the prior
// candidates and the user's diagnostic answers (injected via buildVerdictContext).
export const VERDICT_PROMPT = `You are the same field geologist. You previously proposed candidates for this rock and asked diagnostic questions. The user has now answered some of them (some may be "Can't test" — treat those as no information, never as a negative).

You are given the original photo again plus a JSON transcript of your candidates and the user's answers.

Return STRICT JSON matching this shape (no prose, no markdown):
{
  "final": {
    "name": string,
    "confidence": number,        // 0..1, honest given photo + answers
    "reasoning": string          // why this one, citing the answers that moved you
  },
  "runner_up": {
    "name": string,
    "why_still_possible": string // what would still point to this instead
  },
  "confirm_with": string,         // ONE cheap physical test the user could do to be sure
  "caveats": string               // the honest limits of a photo-plus-a-few-tests identification
}

Rules:
- Weigh the answers heavily; a decisive test result should override the photo-only ranking.
- "Can't test" answers give you NO information — do not treat them as "No".
- Never present the identification as definitive. Always give a real runner_up and honest caveats.
- confirm_with must be a single, cheap, safe test (not "take it to a lab" unless nothing else discriminates).`;

// Builds the context string appended as a second text hint for the verdict call.
// Kept here so 100% of model-facing text is in this file.
export function buildVerdictContext({ candidates, answers, userContext }) {
  return `Original user context: ${userContext ? JSON.stringify(userContext) : 'none'}

Your prior candidates and the user's diagnostic answers (JSON):
${JSON.stringify({ candidates, answers }, null, 2)}`;
}

// --- Response schemas (generationConfig.responseSchema) ----------------------
// Google's responseSchema is an OpenAPI-subset. Keep in sync with the shapes above.
export const CANDIDATES_SCHEMA = {
  type: 'object',
  properties: {
    is_identifiable_rock: { type: 'boolean' },
    image_quality_feedback: { type: 'string', nullable: true },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['igneous', 'sedimentary', 'metamorphic', 'mineral'] },
          confidence: { type: 'number' },
          visual_evidence: { type: 'string' },
          commonly_confused_with: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'type', 'confidence', 'visual_evidence', 'commonly_confused_with'],
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          how_to: { type: 'string' },
          answers: { type: 'array', items: { type: 'string' } },
          discriminates: { type: 'string' },
        },
        required: ['id', 'text', 'how_to', 'answers', 'discriminates'],
      },
    },
  },
  required: ['is_identifiable_rock', 'candidates', 'questions'],
};

export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    final: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        confidence: { type: 'number' },
        reasoning: { type: 'string' },
      },
      required: ['name', 'confidence', 'reasoning'],
    },
    runner_up: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        why_still_possible: { type: 'string' },
      },
      required: ['name', 'why_still_possible'],
    },
    confirm_with: { type: 'string' },
    caveats: { type: 'string' },
  },
  required: ['final', 'runner_up', 'confirm_with', 'caveats'],
};

// Minimal prompt used only to validate a freshly pasted key (cheap text request).
export const VALIDATION_PROMPT = 'Reply with the single word: ok';
