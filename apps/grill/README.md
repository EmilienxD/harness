# Grill-Me board

Grill-Me board is a private, self-hosted review surface for decisions raised during an agent conversation. An agent publishes a round of questions, the board keeps those rounds available across devices, and the user queues answers before reviewing one compact prompt to return to the originating conversation.

The board is designed for one person. It uses a shared four-digit access code instead of accounts, stores its data and private images in Supabase, and runs as a Vercel application. Aboard can optionally relay a reviewed prompt to the exact open provider session; copying the prompt always remains available.

## What the board does

- Lists recent Claude Code and Codex sessions in one responsive interface.
- Preserves earlier rounds as read-only history.
- Shows one question at a time, including the agent's explanation, recommendation, and optional interactive content.
- Accepts an option, a note, or a custom answer. Only **Queue answer** saves and includes it in the prompt.
- Produces a read-only prompt that can be copied or sent through Aboard when that session is waiting for input.
- Retains active sessions for 30 days after their latest meaningful activity and removes expired data and stored images through a daily cleanup job.

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
| `HARNESS_GRILL_URL` | The canonical production origin, such as `https://grill.example.com`, with no trailing slash |
| `HARNESS_GRILL_CODE` | Exactly four digits; this is shared by the browser, publisher, and Aboard |
| `HARNESS_GRILL_SESSION_SECRET` | A long random secret used to sign browser-session cookies |
| `CRON_SECRET` | A different random secret, at least 16 characters, used to authenticate cleanup requests |
| `SUPABASE_URL` | The project URL from Supabase |
| `SUPABASE_SECRET_KEY` | The project's server-only secret key |

If the first deployment assigned the production URL, set `HARNESS_GRILL_URL` afterward and redeploy. Never expose the Supabase secret key in browser-prefixed variables or commit any of these values.

The included Vercel configuration runs cleanup once per day. Vercel sends `CRON_SECRET` to the cleanup endpoint as a bearer token.

### 3. Connect the local clients

Set these two variables in the environment that launches Claude Code or Codex:

```text
HARNESS_GRILL_URL=https://your-production-origin.example
HARNESS_GRILL_CODE=1234
```

Use the same values in the VS Code extension host if you want Aboard delivery. Each initialized project relays separately and labels its presence with its own project name and home-relative path. Aboard reports only recent, exact-session presence, and a delivery succeeds only once the provider's own prompt-submit hook confirms the prompt arrived.

Open the deployed URL, enter the four-digit code, and publish a test round before relying on the board for active work.

## Local development

Copy `.env.example` to `.env`, replace every placeholder, and point it at a development Supabase project. Then run:

```sh
cd apps/grill
npm ci
npm run dev
```

Useful checks are:

```sh
npm run build
npm run lint
```

The production access cookie is secure over HTTPS; local HTTP development works without an override.

## Security model

This is a personal tool, not a multi-user service. Keep both the deployment URL and access code private. All application tables have row-level security enabled with direct anonymous and authenticated access revoked, stored images are private, and Supabase credentials remain server-side.

Published explanation HTML and JavaScript are intentionally trusted. Only connect agents and clients whose output you are willing to execute in your browser.

## Current limits

- The browser workflow has been validated end to end with test sessions, but a complete real agentic session has not yet been validated.
- Edits are local until **Queue answer** or **Update answer** is pressed. Refreshing first discards those unqueued edits.
- The generated prompt is deliberately compact and refers to answers by question ID and option letter. It works best when returned to the conversation that authored the round; an unrelated conversation may lack enough context.
- Aboard confirmation means the text was submitted to the terminal, not that the provider received or processed it.
- The four-digit code is a lightweight gate. It is not a substitute for user accounts or strong public-facing authentication.

For the visual and interaction conventions, see [docs/design.md](docs/design.md).

