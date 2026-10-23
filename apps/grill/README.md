# Grill-Me board

Grill-Me board is a private, self-hosted review surface for decisions raised during an agent conversation. An agent publishes a round of questions, the board keeps those rounds available across devices, and the user answers them before reviewing one compact prompt to return to the originating conversation.

The board is designed for one person. It uses a shared four-digit access code instead of accounts, stores its data and private images and videos in Supabase, and runs as a Vercel application. Pi's native cloud extension and Aboard can relay a reviewed prompt to the exact provider session; copying the prompt always remains available.

## What the board does

- Lists Claude Code, Codex, and Pi sessions in active and finished sections of one responsive interface.
- Preserves earlier rounds as read-only history.
- Shows one question at a time, including the agent's explanation, recommendation, and optional interactive content.
- Accepts an option, a note, or a custom answer. Every edit saves automatically and is included in the prompt.
- Offers **Add Additional Notes** after the final question in every round. The last **Notes** card autosaves round-wide context and includes it after question answers in the reviewed prompt.
- Produces a read-only, single-line prompt with ` | ` between questions and before additional notes. Line breaks in answers, notes, and diagram feedback become spaces before review, so copy and delivery use the reviewed text. It can be copied, sent through Aboard, or sent to Pi when its session relay is connected. Pi claims answers only while idle and confirms receipt from its saved session.
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

For Pi, install Harness's `grill-me-in-cloud` package with `--platform pi`, reload Pi, and invoke `/grill-me-in-cloud` or `/skill:grill-me-in-cloud`. Its extension owns publication and the answer relay; Aboard is optional. The board labels this connection **Pi** and offers **Send to Pi**. Background relay retries run silently.

When upgrading an existing board for Pi, apply `20261014120000_add_pi_grill_relay.sql` before deploying the app. It widens provider constraints, adds snapshot idempotency for Pi, and extends the shared claim function with native round binding and recovery of an owner's outstanding claims. `GET /api/v1/capabilities` lets the extension reject older services before inference. Existing Claude/ChatGPT session identities and delivery status values remain compatible.

## Video previews

Videos publish like images: put an MP4 or WebM file in the round's supplied assets directory, reference it in the explanation, then write the round JSON last. The board shows an inline player with native controls, supports optional poster images, and pauses playback when switching questions. Playback remains in place while answers save and the board polls.

The local publisher checks for `ffmpeg` on PATH only when publishing a video. It uses that installed executable to prepare clips up to 720p and 30 fps (H.264/AAC MP4 or VP9/Opus WebM), preserving the original files. FFmpeg is not bundled, downloaded, or run on Vercel. Images work without it. Target clips under one minute; source and prepared videos are limited to 20 MiB each, images to 6 MiB, and a round to 50 MiB / 20 assets.

Uploads go directly to the existing private Supabase bucket. After authenticating the viewer, the app redirects video playback to a signed Storage URL valid for one hour, so seeking and video bytes bypass Vercel functions. Anyone with that temporary URL can use it until expiry. The board renews an expired playback URL when loading fails. Existing session deletion and 30-day finished-session cleanup include videos; unfinished sessions retain their media indefinitely.

For an existing personal deployment, apply `20261021120000_add_video_assets.sql` with `supabase db push`, then deploy the updated app and upgrade the local `grill-me-in-cloud` package. No additional service, account, or environment variable is required.

## Local development

Use `.env.development.local` for development credentials. For the included local Supabase stack:

```sh
cd apps/grill
npm ci
npx supabase start
npx supabase status
```

Copy `.env.example` to `.env.development.local`, replace its placeholder secrets, and set
`SUPABASE_SECRET_KEY` to the local secret key reported by `supabase status` (or its
`SERVICE_ROLE_KEY`). Keep `SUPABASE_URL=http://127.0.0.1:55421` and
`HARNESS_GRILL_URL=http://localhost:55430`. Then run:

```sh
npm run dev
```

The board opens at `http://localhost:55430`. Development and preview commands use port
55430 and fail if it is occupied. Supabase reserves ports 55420–55429 in
`supabase/config.toml`, leaving its default ports available to other projects. A separate
development Supabase project can be used instead by changing its URL and secret key.

Production credentials belong in Vercel. If local production-mode builds or diagnostics need
them, keep a separate, ignored `.env.production.local`; it is loaded for production mode,
including `npm run build`, but not for `npm run dev`. Keep production values out of `.env`
and `.env.local`, which Vite loads in every mode. Variables already set in the shell override
env files. The server needs only the variables listed under **Personal deployment**;
`VITE_SUPABASE_*`, publishable keys, project IDs and Vercel OIDC tokens are not needed.
Both credential files stay out of Git. Restart the server after changing either file.

Useful checks are:

```sh
npm test
npm run build
npm run lint
```

Browser acceptance tests use the running local Supabase stack and an isolated development server:

```sh
npx supabase start
npx playwright install chromium
npm run test:e2e
```

These tests publish and remove their own sessions, covering desktop and mobile Notes navigation,
autosave, refresh persistence, save retries, review, and frozen history. They always use local
Supabase credentials from `supabase status`; deployment environment files cannot select the database.
Round notes use the existing answer-draft table, so this feature needs no database migration.

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

## Editable Mermaid diagrams

Diagrams autosave separately from the authored questions and restore after navigation, refresh, and in round history. **Reset to original** restores the agent's initial diagram, including its labels, layout, and background. Diagram feedback is generated only when you click **Review prompt**, from the final drawing compared with its original baseline. Written notes stay separate; panning, zooming, and selecting objects do not count as changes. Feedback uses one compact sentence per edited diagram, grouping additions, removals, labels, connections, layout and styling; the attached image supplies the details. Bound labels count with their shapes, and bulk edits are aggregated rather than listed individually. Undoing or resetting back to the baseline omits that diagram from feedback.

Review waits for drawings and changed-diagram PNGs to save. Save or export failures keep the draft and offer a retry. Drawings have a 4 MB request limit and PNG exports a 2.9 MB limit; simplify an oversized drawing before retrying. Reviewed snapshots retain immutable image IDs, checksums, question/diagram identities, and scene revisions. Image and snapshot metadata endpoints require the existing browser cookie or machine bearer authentication. Session deletion and retention also remove these drawings and images.

For existing deployments, apply `20261021130000_editable_diagram_scenes.sql` with `supabase db push` before deploying the app. It adds the separate scene table, immutable baselines, snapshot revision binding, and private image metadata. Authenticated `GET /api/v1/prompt-snapshots/<id>` returns snapshot images for delivery clients; relay responses include the same immutable metadata. Apply `20261021140000_snapshot_image_delivery.sql` as well. It reserves immutable snapshot identities during review and replaces Pi's one-delivery-per-snapshot constraint with one active attempt across all providers; completed or failed attempts can be deliberately resent. Existing duplicate active attempts are visibly expired during migration, preserving the oldest claimed attempt (otherwise the oldest pending attempt).

Reviewed prompts include diagram changes and immutable image IDs. For copy/paste and native Pi delivery, the skill supplies a bundled `scripts/download_grill_image.py` helper that accepts an image ID, resolves Harness configuration internally, and saves the PNG beside the runtime inboxes. Aboard prepares all images into an external runtime cache before terminal submission, verifies SHA256, byte size and valid bounded PNG pixels, and replaces only generated reference ranges. Notes and unrelated URLs stay intact. Download failures retain the reviewed image IDs for the skill helper. Each snapshot supports up to 20 images and 50 MiB total. Preparation and provider confirmation share the delivery expiry budget, and the relay rechecks exact session and terminal binding after downloading.

Protocol image metadata includes `reference_start` and `reference_end` as UTF-16 offsets into the immutable snapshot prompt, plus `reference`, `asset_id`, `question_id`, `diagram_id`, `scene_revision`, `sha256`, `byte_size` and `media_type`. Delivery clients retrieve the authenticated snapshot to verify ranges and metadata. `POST /prompt-snapshots/<id>/deliveries` accepts a gesture-owned UUID `delivery_id`: network retries reuse it, while deliberate retry/resend uses a new one. Concurrent active attempts return the existing attempt. Images never use bearer links, query credentials or public storage URLs.

Local receiving acceptance runs through `npx playwright test test/browser/diagram-delivery.spec.ts --project desktop`; it installs all three real CLIs' payloads, publishes through the shipped publisher, saves edited scenes, reviews an authenticated snapshot and executes receiving commands against loopback fake inference. The Aboard branch tests its image preparation boundary; relay binding and confirmation lifecycle have separate unit tests, and `npm run test:vscode` validates the isolated extension host.
