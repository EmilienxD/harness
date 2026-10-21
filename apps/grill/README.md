# Grill-Me board

Grill-Me board is a private, self-hosted review surface for decisions raised during an agent conversation. An agent publishes a round of questions, the board keeps those rounds available across devices, and the user answers them before reviewing one compact prompt to return to the originating conversation.

The board is designed for one person. It uses a shared four-digit access code instead of accounts, stores its data and private images and videos in Supabase, and runs as a Vercel application. Pi's native cloud extension and Aboard can relay a reviewed prompt to the exact provider session; copying the prompt always remains available.

## What the board does

- Lists Claude Code, Codex, and Pi sessions in active and finished sections of one responsive interface.
- Preserves earlier rounds as read-only history.
- Shows one question at a time, including the agent's explanation, recommendation, and optional interactive content.
- Accepts an option, a note, or a custom answer. Every edit saves automatically and is included in the prompt.
- Produces a read-only prompt that can be copied, sent through Aboard, or sent to Pi when its session relay is connected. Pi claims answers only while idle and confirms receipt from its saved session.
- Keeps unfinished sessions indefinitely. Finishing a session moves it to the archive and starts a 30-day period before the daily cleanup removes its data and stored media. Finished sessions can be restored during that period, and a newly published round restores its session automatically.

## Default hosted board

Clients default to `https://grill-me-in-cloud.vercel.app`. Configure only the shared four-digit code in `.harness/config.local.json` or `~/.harness/config.json`:

```json
{ "version": 1, "grill": { "code": "1234" } }
```

Use the board's actual access code, not the example above. `grill.url` (or `HARNESS_GRILL_URL`) is an optional override for a personal deployment or local development; it is not required for the default board.

## Personal deployment

You need a Supabase project, a Vercel account, Node.js with npm, and a checkout of this repository.

### 1. Create the database

Create an empty Supabase project, then apply the included migrations in order. With the Supabase CLI installed:

```sh
cd apps/grill
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

The migrations create the application tables, database functions, access-attempt limiter, and private `grill-assets` bucket. Browser and machine clients do not connect to these tables directly; the deployed server uses a Supabase secret key.

### 2. Create the Vercel project

Import this repository into Vercel and set the project's root directory to `apps/grill`. Alternatively, deploy from that directory with the Vercel CLI:

```sh
npm ci
npm run build
vercel --prod
```

Add these environment variables to the Vercel project:

| Variable | Value |
| --- | --- |
| `HARNESS_GRILL_URL` | Optional canonical origin override, with no trailing slash; otherwise links use the request origin, falling back to `https://grill-me-in-cloud.vercel.app` |
| `HARNESS_GRILL_CODE` | Exactly four digits; this is shared by the browser, publisher, and Aboard |
| `HARNESS_GRILL_SESSION_SECRET` | A long random secret used to sign browser-session cookies |
| `CRON_SECRET` | A different random secret, at least 16 characters, used to authenticate cleanup requests |
| `SUPABASE_URL` | The project URL from Supabase |
| `SUPABASE_SECRET_KEY` | The project's server-only secret key |

Set `HARNESS_GRILL_URL` if generated links should use a fixed canonical origin instead of the request origin. Never expose the Supabase secret key in browser-prefixed variables or commit secrets.

The included Vercel configuration runs cleanup once per day. Vercel sends `CRON_SECRET` to the cleanup endpoint as a bearer token.

### 3. Connect the local clients

Set the code in the environment that launches Claude Code, Codex, or Pi. For a personal deployment, also override the default URL:

```text
HARNESS_GRILL_CODE=1234
# Optional: omit to use https://grill-me-in-cloud.vercel.app
HARNESS_GRILL_URL=https://your-production-origin.example
```

Use the same values in the VS Code extension host if you want Aboard delivery. Each initialized project relays separately and labels its presence with its own project name and home-relative path. Aboard reports only recent, exact-session presence, and a delivery succeeds only once the provider's own prompt-submit hook confirms the prompt arrived.

Open the deployed URL, enter the four-digit code, and publish a test round before relying on the board for active work.

For Pi, install Harness's `grill-me-in-cloud` package with `--platform pi`, reload Pi, and invoke `/grill-me-in-cloud` or `/skill:grill-me-in-cloud`. Its extension owns publication and the answer relay; Aboard is optional. The board labels this connection **Pi** and offers **Send to Pi**. `/grill-cloud-stop` disconnects without deleting rounds or answers.

When upgrading an existing board for Pi, apply `20261014120000_add_pi_grill_relay.sql` before deploying the app. It widens provider constraints, adds snapshot idempotency for Pi, and extends the shared claim function with native round binding and recovery of an owner's outstanding claims. `GET /api/v1/capabilities` lets the extension reject older services before inference. Existing Claude/ChatGPT session identities and delivery status values remain compatible.

## Video previews

Videos publish like images: put an MP4 or WebM file in the round's supplied assets directory, reference it in the explanation, then write the round JSON last. The board shows an inline player with native controls, supports optional poster images, and pauses playback when switching questions. Playback remains in place while answers save and the board polls.

The local publisher checks for `ffmpeg` on PATH only when publishing a video. It uses that installed executable to prepare clips up to 720p and 30 fps (H.264/AAC MP4 or VP9/Opus WebM), preserving the original files. FFmpeg is not bundled, downloaded, or run on Vercel. Images work without it. Target clips under one minute; source and prepared videos are limited to 20 MiB each, images to 6 MiB, and a round to 50 MiB / 20 assets.

Uploads go directly to the existing private Supabase bucket. After authenticating the viewer, the app redirects video playback to a signed Storage URL valid for one hour, so seeking and video bytes bypass Vercel functions. Anyone with that temporary URL can use it until expiry. The board renews an expired playback URL when loading fails. Existing session deletion and 30-day finished-session cleanup include videos; unfinished sessions retain their media indefinitely.

For an existing personal deployment, apply `20261021120000_add_video_assets.sql` with `supabase db push`, then deploy the updated app and upgrade the local `grill-me-in-cloud` package. No additional service, account, or environment variable is required.

## Local development

Copy `.env.example` to `.env`, replace every placeholder, and point it at a development Supabase project. Then run:

```sh
cd apps/grill
npm ci
npm run dev
```

For a local Supabase stack, run `npx supabase start` from `apps/grill` and set
`SUPABASE_URL=http://127.0.0.1:55421` in your local environment file. Get the
local secret key from `npx supabase status`. Grill reserves ports 55420–55429 in
`supabase/config.toml`, leaving Supabase's default ports available to other projects.

Useful checks are:

```sh
npm test
npm run build
npm run lint
```

The production access cookie is secure over HTTPS; local HTTP development works without an override.

## Security model

This is a personal tool, not a multi-user service. Keep the access code private. All application tables have row-level security enabled with direct anonymous and authenticated access revoked, stored images are private, and Supabase credentials remain server-side.

Published explanation HTML and JavaScript are intentionally trusted. Only connect agents and clients whose output you are willing to execute in your browser.

## Current limits

- Pi 1.2.0 JSON/RPC workflows have been verified with real native tools and fake model inference against both the local stack and production Vercel/Supabase/Storage service. Project RPC and user JSON-to-RPC live journeys passed on 2026-10-14; see `tests/e2e/README.md` for repeatable acceptance. This certifies integration, not unscripted model judgment, browser rendering or Pi's interactive TUI.
- Answers autosave: options at once, notes after a short pause in typing. Concurrent edits from two devices resolve to whichever saved last.
- The generated prompt is deliberately compact and refers to answers by question ID and option letter. It works best when returned to the conversation that authored the round; an unrelated conversation may lack enough context.
- Relay confirmation means the provider accepted the prompt. Pi additionally verifies its persisted user message; confirmation does not imply successful model processing.
- The four-digit code is a lightweight gate. It is not a substitute for user accounts or strong public-facing authentication.

For the visual and interaction conventions, see [docs/design.md](docs/design.md).

