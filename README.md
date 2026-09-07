# RockID

<img width="512" height="512" alt="rockidicon512" src="https://github.com/user-attachments/assets/e5900b52-9abe-43ba-ab78-10ecb8002994" style="width: 15%;"/>

A static, mobile-first web app that identifies rocks from a photo using the
Gemini vision API — and is **honest about uncertainty**. Photo-only rock ID is
unreliable, so instead of faking confidence, RockID returns the top candidates,
then walks you through real physical diagnostic tests (vinegar fizz, glass
scratch, streak, magnetism…) to narrow it down the way a geologist would.

<img width="1080" height="1816" alt="image" src="https://github.com/user-attachments/assets/26192064-739a-4b68-ae7d-d3a63a2f1e49" style="width: 30%;"/>
<br><br>

**Bring your own key (BYOK).** The app runs entirely in your browser. You supply
your own free Gemini API key; it's stored only on your device and sent straight
to Google — never to any server of ours.

## The flow

photograph rock → top-3 candidates with reasoning → answer a few diagnostic
questions → final verdict with confidence, a runner-up, and one confirming test →
optionally download the session as JSON.

Every identification is saved to your **library** (the ▤ button) automatically,
from the moment candidates come back — so an abandoned run keeps its photo and
its answers, and nothing is lost by closing the tab. See Privacy below for what
that means, and how to remove one.

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
the JSON response schemas, `PROMPT_VERSION`, and the model constants
`MODEL_ID` and `MODEL_ID_FALLBACK`.

### The model list comes from Google

Model names go stale fast, so those two constants are where the picker
**starts**, not where it stays. On startup (and whenever Settings open)
[`js/models.js`](js/models.js) calls Google's
[ListModels](https://ai.google.dev/api/models) endpoint with your key and fills
**Settings → Model** with what that key can actually reach, newest first. A
single button cycles between the two the app cares about:

- **best free** — the newest full Flash model
- **lighter** — the newest Flash-Lite, which has higher rate limits and slightly
  less detail

Picking the best model stores nothing, so the browser keeps following the best
as it moves; picking anything else pins it in `localStorage`.

The first time a request hits a rate limit (HTTP 429), the app **automatically
downgrades to the lighter model**, shows a banner explaining the switch, and
retries so the flow continues — landing on the discovered Flash-Lite rather than
a constant that may have been retired.

**One caveat worth knowing.** ListModels reports what a key can reach, but *not
what anything costs* — there is no free-tier or pricing field in the response.
So "free" here is **inferred from the family**: Flash and Flash-Lite are the
tiers Google offers at no cost, Pro is not, and everything else (embedding,
image, TTS) is filtered out. If Google changes which families are free, the
`keep()` filter in `js/models.js` is the line to revisit.

Discovery is always an enhancement, never a dependency. No key, no network, or a
refused list simply leaves the constants in place. If a request 404s on the
model, pick another from the dropdown — or update `MODEL_ID`. Verify current IDs
at <https://ai.google.dev/gemini-api/docs/models>.

## Getting a free Gemini API key

1. Go to <https://aistudio.google.com/> and sign in with Google.
2. Click **Get API key → Create API key**.
3. Copy the key (starts with `AIza…`) and paste it into RockID's setup screen.

The free tier has daily quotas that reset at midnight Pacific, and is **not
available in the EEA, UK, or Switzerland**.

## Privacy & security

- Your API key lives only in `localStorage` and is sent **only** via the
  `x-goog-api-key` request header — never as a URL parameter, never logged.
- Photos are sent directly from your browser to Google, and are **also kept on
  this device**: every identification is saved to the library automatically —
  photo included — as soon as the model returns candidates, so a session is
  never lost by closing the tab. Saved specimens live in this browser's
  `IndexedDB`, on your device only, and are never uploaded to us. Delete any of
  them from the library at any time, or tap **Don't keep this one** on a result
  to remove it immediately.
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
js/models.js        live model discovery via Google's ListModels endpoint
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
