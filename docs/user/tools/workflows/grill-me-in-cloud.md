# Grill me in cloud

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install grill-me-in-cloud`; see [installation and scope](../../getting-started.md).

## When to use

Use `grill-me-in-cloud` when a branching design interview benefits from a persistent visual board that can show comparisons, code excerpts, images, video previews, and interactive explanations.

## Invocation

Use `/grill-me-in-cloud [plan or design]` in Claude Code, `$grill-me-in-cloud` in ChatGPT, or `/grill-me-in-cloud` (also `/skill:grill-me-in-cloud`) in Pi. A board session is published round by round. Answer on the board, review its prompt, then choose **Send to Pi** for Pi's native session relay or **Send via Aboard** for Claude/ChatGPT. Copying the prompt remains available.

## What happens

The agent asks the current frontier of decisions, with options and recommendations. Its hook supplies fresh round and asset paths outside the project, uploads local explanation images, publishes the round, and returns the session URL. Only queued answers enter the next prompt. The board formats the prompt as one line before review, separating questions and additional notes with ` | ` and replacing line breaks in answers, notes, and diagram feedback with spaces. Copy and delivery use that reviewed text. Unanswered questions retain their IDs in later rounds; the process continues until decisions are settled and you confirm shared understanding.

## Files and prerequisites

Claude/ChatGPT use hooks; Pi uses an extension and Python publisher, with no Aboard prerequisite. Install with `harness install grill-me-in-cloud --platform pi`, then reload Pi. Pi 1.2.0 is the verified runtime. The hosted app needs the Pi provider migration and current server; older deployments stop the invocation before inference with an upgrade diagnostic.

Board connection can be configured in Harness config under `grill`; workspace-local `.harness/config.local.json` is ignored by project installs and can hold the URL and code. Drafts, round assets, and Pi's delivery journal live outside the project. The relay advertises the exact session and accepts answers when Pi is idle. Delivery is confirmed only after that session's saved JSONL contains the correlated user message. Reload/resume recover accepted answers without submitting them again. A second process resuming the same session cannot take over a live relay.

An outage or expired delivery preserves the saved answers: reconnect and send a newly reviewed prompt, or copy it into the session. Forked sessions need their own explicit invocation, and tree navigation invalidates the previous branch's relay. Background relay retries run silently. Published rounds are announced as `Round n with m questions available at <url>`.

## Example

`/grill-me-in-cloud Review the checkout redesign` opens a hosted decision round for that proposal.

Video previews use the same local asset workflow as images. The publisher checks for the installed `ffmpeg` on PATH and prepares MP4/WebM clips locally; it never bundles FFmpeg. Videos support native inline controls and optional poster images. Each source and prepared clip is limited to 20 MiB, with 50 MiB / 20 assets per round. Personal deployments need the current app and video asset migration.

Edited diagrams travel with the reviewed answers as private immutable PNGs. The review shows authenticated asset endpoints and a snapshot-specific Python command using the installed helper. Aboard downloads and verifies them into an external runtime cache before sending the prompt; copy/paste and Pi's native relay retain the authenticated references and command. Run that command from the project directory to retrieve all images together, including their question and diagram identities. It resolves the same local, shared URL, user and environment configuration as publication, without putting the access code in commands or output. Retrying reuses verified cached files and repairs corrupt files.

## Implementation and verification

`grill-me-in-cloud` 2.2.1 installs the shared skill/publisher, a small Python adapter,
and a native extension/relay, with a Pi-only coupled `pi-transport` dependency. Project and
user installation remain independent of Aboard. The implementation was verified on Windows
with installed Pi 1.2.0, including the actual local Grill app, Supabase database and private
Storage uploads. On 2026-10-14 the additive migration was applied to the production database
and Vercel deployment `dpl_2y7fyTUeTSTTJwNaEB8RpUr9VPQB` reached READY at
`https://grill-me-in-cloud.vercel.app/`. Real Pi project RPC and user JSON-to-RPC journeys
both passed against that board with exactly five fake Responses requests apiece. They verified
private SVG uploads, queued-only answers, a single persisted correlated user message, server
acknowledgement, reload/fork/tree isolation, stop/new-session commands, and owned test cleanup.
The older deployment was also verified to reject Pi before inference.

The authoring contract stays file-based: prepare reserved round/assets paths, write assets
first, then write the complete round. Pi's successful tool-result event publishes through the
existing Python validation, immutable asset staging, idempotent preparation/commit, and outbox.
This retains native tools and shared skill semantics, including nested tool results. Failed
preparation consumes explicit invocations before inference. Malformed rounds receive new paths;
network publication failures keep their staged payload/assets for retry on the next user input.
Each asset reference receives its own immutable Storage path, including when different filenames
contain identical bytes. Retries reuse the prepared manifest; known duplicate-object responses
(HTTP 409 or Supabase's legacy HTTP 400) defer to commit's size, media and SHA256 verification.
Upload failures identify the asset reference and available Storage error code. Publications already
prepared with the older hash-only paths need a fresh submission if their references collide.
Pi's local staged metadata binds retry to the exact native session file and an anchor still in
the active ancestry; a queued round on an abandoned branch is preserved without being published.
Unrelated sessions do not resolve configuration or poll the board. Titles come from
`pi.getSessionName()` and identity from the native session manager, never a model-provider name.

The relay uses the public extension API in TUI, JSON and RPC. The installed
`agent-session.js` was inspected alongside the mirrored [extension API](https://github.com/EmilienxD/harness/blob/main/docs/PI-REFERENCES/docs/extensions.md)
and [session format](https://github.com/EmilienxD/harness/blob/main/docs/PI-REFERENCES/docs/session-format.md): `message_end` handlers execute
before the user message is appended, and `pi.sendUserMessage()` returns void. The awaited
`sendUserMessage` API belongs to replacement-session callbacks; it is not a general receipt.
Consequently neither callback nor submission return acknowledges a cloud answer.

Delivery follows these boundaries:

1. `/pi/sync` advertises the exact native session, current branch's published round, workspace,
   and whether Pi is idle. The shared database claim function admits Pi only for that active
   round and an idle session. All relays compete for the same locked delivery row; a Pi owner
   can recover its own outstanding claim. Credentials travel only through internal transport.
2. An external atomic journal binds a random persistent instance ID to the exact session file.
   A process lock excludes simultaneous resumptions; dead-process reclamation is serialized.
   Before submission it records the delivery ID, round, content hash, last session entry ID and activation identity.
   Only one user message is submitted per tick, because asynchronous input preflight can delay
   Pi's busy state. Slash/skill expansion is disabled for answers.
3. The injected user message is exactly the reviewed board prompt. Acknowledgement requires
   a matching persisted user entry after the recorded session entry in the exact JSONL file,
   with the native session header and complete content hash checked. A custom session receipt
   links the delivery to that entry without adding metadata to the user message.
   Reload can acknowledge an accepted message after an outage without resending it. An
   in-memory matching user message also prevents resubmission while awaiting persistence.
4. Shutdown, reload, new/fork and tree navigation stop the old relay and abort transport.
   Native start/stop and round receipts are reconstructed from active ancestry and bound to
   the native session ID. Tree navigation appends a non-context branch receipt to persist the
   selected leaf immediately; a restart therefore cannot revive the prior branch's outbox.
   Forks require an explicit new invocation. Accepted messages on an
   abandoned branch still count as received for delivery idempotency; that history never
   supplies the current branch's round authority.

The shared skill owns publishing and response rules. Runtime context supplies initial or
changed inbox/asset locations, publication results with round number, question count and URL,
and actionable errors. Ordinary follow-up turns add no preparation reminders. Pi background
relay retries add no conversation messages; launch failures use UI notifications only.

The additive migration widens all four provider checks and the claim function result adds
`round_id`. Internal v1 snapshot reason `aboard` and success status `submitted-to-terminal`
remain compatible names; the Pi UI uses **Send to Pi**, and success means persisted native
receipt. Snapshot retries reuse one Pi delivery. A late, previously owned acknowledgement can
repair expiry after disconnect. An unaccepted expired delivery stays unsubmitted; board drafts
remain available for a newly reviewed send or manual copy. This is explicit receipt recovery,
not a lease takeover that could replay an answer from a still-running owner.

`test:pi-grill` verifies real installed Pi and fake Responses inference with a hosted fault
fixture: project/user install/removal, native aliases, zero-inference unsupported/outage
admission, malformed-round rejection, SVG publication, queued-only answers, persisted receipt,
publication outage/recovery and abandoned outboxes, acknowledgement failure/reload, competing
claims/processes, tree/fork isolation, stop/reload and new-session behavior. The
explicit `e2e:pi-grill:live` journey verifies the same successful publication/Storage/delivery
boundaries against an actual configured service. It checks exact inference counts and deletes
only its UUID-owned sessions/assets. Scripted inference certifies integration; TUI/browser
rendering and unscripted design quality are outside this gate.

`apps/grill/test/browser/publications.spec.ts` verifies identical PNGs under distinct references
against the local app, Supabase database and private Storage, including partial-upload retries,
stable prepared paths, idempotent commit, exact downloaded bytes and session deletion. It runs
with `npx playwright test test/browser/publications.spec.ts --project desktop` from `apps/grill/`.
Publisher unit tests cover legacy duplicate responses and upload rejection diagnostics. This
acceptance does not establish deployment of the fix to the hosted board.
