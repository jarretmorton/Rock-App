# Build "RockID" — a BYOK rock identification web app (v0)

## What we're building

A static, mobile-first web app that identifies rocks from photos using the Gemini vision API. The user supplies their own free Gemini API key (BYOK). The app's core thesis is **honesty about uncertainty**: photo-only rock ID is inherently unreliable, so instead of pretending otherwise, the app returns top-3 candidates and then walks the user through 2–4 real physical diagnostic tests (vinegar fizz, glass scratch, streak color, magnetism...) to narrow to a confident answer — the way an actual geologist works.

Core loop: **photograph rock → top-3 candidates with reasoning → answer diagnostic questions → final verdict with confidence + one confirming test.**

## Hard constraints

- **Static site only.** Vanilla HTML/CSS/JS with ES modules. No framework, no build step, no backend, no dependencies unless you ask me first. Must deploy to GitHub Pages by pushing files.
- **BYOK.** Never hardcode, commit, or log an API key. Key lives only in `localStorage`. Send it only via the `x-goog-api-key` request header — **never** as a `?key=` URL parameter.
- **Privacy.** Photos are processed in memory and sent directly from the browser to Google's API. Never persist images (no localStorage/IndexedDB storage of photos).
- **Free-tier friendly.** Default to a current free-tier Gemini Flash vision model. Handle 429 rate-limit errors gracefully.

## Before writing any code

1. Fetch the current Gemini API REST docs (start at https://ai.google.dev/gemini-api/docs) and confirm: (a) the exact `generateContent` request schema for inline base64 images, (b) how to request JSON output (`response_mime_type` / response schema support), and (c) the current free-tier multimodal model IDs. **Do not trust memorized model names — they go stale.** Set the chosen model ID as a single constant (I believe `gemini-3.5-flash` is current, but verify; note a flash-lite variant as a fallback for rate limits).
2. Show me a short plan (file structure + flow) and wait for my OK before implementing.

## Architecture

```
index.html
styles.css
js/main.js       — app state machine and flow control
js/api.js        — Gemini client: fetch wrapper, error mapping, MOCK_MODE
js/prompts.js    — ALL prompt templates + PROMPT_VERSION + MODEL_ID constants
js/storage.js    — localStorage helpers (key management, settings)
js/ui.js         — DOM rendering helpers
fixtures/        — canned API responses for mock mode
```

- **MOCK_MODE**: when a `?mock=1` query param is present (or a constant is flipped), `api.js` returns canned fixture responses (e.g., a plausible basalt-vs-gabbro result with questions). The entire UI flow must be developable and demoable with zero API key.
- **prompts.js is sacred**: every string sent to the model lives here, exported as named constants, with a `PROMPT_VERSION` string. I'll be iterating on prompts and later benchmarking them, so nothing model-facing gets scattered through the codebase.

## Screens and flow

### 1. Key setup (first run, reachable later via Settings)

- One short paragraph explaining BYOK: "This app runs entirely in your browser. You bring your own free Gemini API key; it's stored only on this device."
- 3-step instructions with a link to https://aistudio.google.com/ (sign in with Google → Get API key → Create API key → copy).
- Paste field + **"Validate & save"** button that fires a minimal test request and shows a clear ✓ or a specific failure message.
- Once saved: show the key masked (`AIza••••••••1234`), with Change and Remove actions.
- Honest fine print (short, plain): photos go directly from your browser to Google; on the free tier, Google may use inputs to improve its products; free tier isn't available in the EEA/UK/Switzerland.

### 2. Capture

- `<input type="file" accept="image/*" capture="environment">` so phones open the camera; drag-and-drop zone on desktop.
- Client-side downscale before sending: longest edge → 1024px, JPEG ~0.85 quality, then base64. (Phone photos are 5–15 MB; this keeps requests fast and cheap.)
- Image preview + optional free-text context field with placeholder: *"e.g., found on an Oregon beach, feels heavy for its size"*.
- Tips shown inline: natural light, fill the frame, include a coin for scale, wet vs dry surface.

### 3. Candidates (API call #1)

Send image + context. Request **strict JSON** from the model shaped like:

```json
{
  "is_identifiable_rock": true,
  "image_quality_feedback": "string or null",
  "candidates": [
    {
      "name": "Basalt",
      "type": "igneous | sedimentary | metamorphic | mineral",
      "confidence": 0.55,
      "visual_evidence": "what in THIS photo supports this",
      "commonly_confused_with": ["gabbro", "andesite"]
    }
  ],
  "questions": [
    {
      "id": "q1",
      "text": "Does it fizz when you put a drop of vinegar on it?",
      "how_to": "one-sentence instructions for performing the test safely",
      "answers": ["Yes", "No", "Can't test"],
      "discriminates": "which candidates this separates and why"
    }
  ]
}
```

- Exactly 3 candidates (fewer only if the model is highly confident), 2–4 questions ordered by how much they discriminate.
- Render candidates as cards: name, rock type badge, confidence bar, visual evidence.
- If `is_identifiable_rock` is false (a brick, a dog, three rocks at once): friendly message + retake tips, no candidates.

### 4. Diagnostics

- One question at a time. Big tappable answer buttons including **"Can't test"** — never force an answer.
- Show the `how_to` text with each question. A "skip remaining questions" escape hatch is fine.

### 5. Verdict (API call #2)

Send the image again + candidates + the Q&A transcript. Request JSON: `{ "final": { "name", "confidence", "reasoning" }, "runner_up": { "name", "why_still_possible" }, "confirm_with": "one cheap physical test to be sure", "caveats": "string" }`.

- Present honestly. Map confidence to wording: <0.5 → "best guess", 0.5–0.75 → "likely", >0.75 → "confident". Always show the runner-up and caveats. Never present a photo ID as definitive — that honesty is the product.

### 6. Session export

- A "Download session (JSON)" button producing: `{ timestamp, model_id, prompt_version, image_sha256, context, call1_response, answers, call2_response }`. Hash of the image, not the image itself.
- This file format seeds a future eval/benchmark set, so keep it stable and complete.

## API details (verify against current docs first)

- `POST https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`
- Auth: `x-goog-api-key` header only.
- Body: `contents[0].parts` = one text part (the prompt) + one inline base64 image part; set the generation config for JSON output (and a response schema if the API supports it for this model).
- **Parse defensively**: strip stray code fences, try/catch `JSON.parse`, and on failure show a collapsible "raw response" debug block instead of a blank screen.
- Error mapping with specific user-facing messages:
  - 400/403 invalid or restricted key → "Key rejected — check it in Settings" (+ note that region restrictions can cause this)
  - 429 → "You've hit the free tier's rate limit. Daily quotas reset at midnight Pacific." Suggest waiting or switching the model constant to the flash-lite variant.
  - Network failure → offline message with retry.

## Design direction

Mobile-first field-guide aesthetic — this gets used one-handed, outdoors, in sunlight, with a rock in the other hand. High contrast, large type, big touch targets. Draw the palette from the subject itself: mineral tones (slate, sandstone, iron oxide, quartz-white) rather than tech-brand colors. One signature element is enough — e.g., confidence rendered as a sediment-layer fill, or candidate cards styled like field-guide specimen entries. Avoid the generic AI-app look: no purple-gradient hero, no cream-background-with-terracotta-serif template, no dark-mode-with-acid-green. Keep motion minimal; respect `prefers-reduced-motion`; visible keyboard focus states.

## Non-goals for v0

No accounts, no server, no database, no photo storage, no PWA/offline mode, no custom ML classifier, no frameworks, no paid APIs, no i18n. Don't build a rock reference encyclopedia — the model's reasoning is the content.

## Acceptance checklist

- [ ] Entire flow (key setup → capture → candidates → diagnostics → verdict → export) works in MOCK_MODE with no key
- [ ] Key validation gives specific success/failure feedback
- [ ] Phone camera photo → downscaled → candidates rendered, typically well under 10s on a Flash model
- [ ] Non-rock photo handled gracefully
- [ ] 429 produces the friendly rate-limit message
- [ ] Session JSON downloads and includes `prompt_version` and `model_id`
- [ ] `grep` finds no API key anywhere in the repo; the key never appears in any URL
- [ ] README covers local dev (any static file server) and GitHub Pages deployment
- [ ] Works on a ~375px-wide viewport

## Process

Work in this order: plan (wait for my OK) → skeleton UI in MOCK_MODE → real `api.js` → diagnostics loop → verdict + export → polish pass against the design direction. Ask before adding any dependency. Keep commits small and labeled by phase.
