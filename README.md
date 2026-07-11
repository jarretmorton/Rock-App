# RockID

A static, mobile-first web app that identifies rocks from a photo using the
Gemini vision API — and is **honest about uncertainty**. Photo-only rock ID is
unreliable, so instead of faking confidence, RockID returns the top candidates,
then walks you through real physical diagnostic tests (vinegar fizz, glass
scratch, streak, magnetism…) to narrow it down the way a geologist would.

**Bring your own key (BYOK).** The app runs entirely in your browser. You supply
your own free Gemini API key; it's stored only on your device and sent straight
to Google — never to any server of ours.

## The flow

photograph rock → top-3 candidates with reasoning → answer a few diagnostic
questions → final verdict with confidence, a runner-up, and one confirming test →
optionally download the session as JSON.

## Local development

It's a static site — no build step, no dependencies. Serve the folder with any
static file server (a plain `file://` open won't work because it uses ES modules
and `fetch`):

```bash
# Python
python -m http.server 4173

# or Node
npx serve .
```

Then open <http://localhost:4173>.

### Mock mode (no API key needed)

Append `?mock=1` to the URL to run the **entire flow** against canned fixtures in
`fixtures/` — no key, no network, no cost:

```
http://localhost:4173/?mock=1
```

Type `not a rock` in the context field in mock mode to exercise the
non-rock / unidentifiable path.

## Configuration

Everything model-facing lives in [`js/prompts.js`](js/prompts.js) — the prompts,
the JSON response schemas, `PROMPT_VERSION`, and the model constants:

- `MODEL_ID` — the vision model (default `gemini-3.5-flash`).
- `MODEL_ID_FALLBACK` — a lighter Flash-Lite model (`gemini-3.1-flash-lite`).

The app **starts on `MODEL_ID`** and, the first time a request hits a rate limit
(HTTP 429), **automatically downgrades to `MODEL_ID_FALLBACK`**, shows a banner
explaining the switch, and retries the request so the flow continues. The choice
persists (in `localStorage`) so later requests skip straight to the lighter
model. You can switch back to the stronger model, or opt into the lighter one
manually, under **Settings → Model**.

**Model names go stale.** If a request 404s on the model, update `MODEL_ID` here —
it's the single source of truth. Verify current IDs at
<https://ai.google.dev/gemini-api/docs/models>.

## Getting a free Gemini API key

1. Go to <https://aistudio.google.com/> and sign in with Google.
2. Click **Get API key → Create API key**.
3. Copy the key (starts with `AIza…`) and paste it into RockID's setup screen.

The free tier has daily quotas that reset at midnight Pacific, and is **not
available in the EEA, UK, or Switzerland**.

## Privacy & security

- Your API key lives only in `localStorage` and is sent **only** via the
  `x-goog-api-key` request header — never as a URL parameter, never logged.
- Photos are processed in memory and sent directly from your browser to Google.
  By default nothing is persisted. The one exception is the **library**: if you
  tap "Save to library", that specimen's photo and result are stored in this
  browser's `IndexedDB`, on your device only — they are never uploaded to us. You
  can delete any saved specimen from the library at any time.
- The JSON session export contains a SHA-256 **hash** of the image, not the
  image itself.

## Deploy to GitHub Pages

No build step — just publish the files.

1. Push this folder to a GitHub repo.
2. Repo **Settings → Pages**.
3. Under **Build and deployment**, set **Source: Deploy from a branch**, pick
   your branch (e.g. `main`) and folder `/ (root)`, and save.
4. Your app will be live at `https://<user>.github.io/<repo>/` in a minute or two.

If you deploy from a subfolder of a larger repo, either set Pages to serve that
folder or move these files to the repo root, since all asset paths are relative.

## Project structure

```
index.html          screen containers
styles.css          field-guide mineral-tone styling, mobile-first
js/main.js          app state machine and flow control
js/api.js           Gemini client: fetch, error mapping, downscale, MOCK_MODE
js/prompts.js       ALL prompts + schemas + PROMPT_VERSION + MODEL_ID  (edit here)
js/storage.js       localStorage helpers (key management)
js/library.js       saved-specimen library (IndexedDB) — the only image persistence
js/ui.js            DOM rendering helpers
fixtures/           canned API responses for mock mode
```

## Non-goals (v0)

No accounts, no server, no remote database, no offline/PWA, no custom
classifier, no frameworks, no paid APIs. (Saved specimens live in a local,
on-device library — see Privacy above.) The model's reasoning is the content —
this isn't a rock encyclopedia.
