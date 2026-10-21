# Grill me in cloud

## When to use

Use `grill-me-in-cloud` when a branching design interview benefits from a persistent visual board that can show comparisons, code excerpts, images, video previews, and interactive explanations.

## Invocation

Use `/grill-me-in-cloud [plan or design]` in Claude Code, `$grill-me-in-cloud` in ChatGPT, or `/grill-me-in-cloud` (also `/skill:grill-me-in-cloud`) in Pi. A board session is published round by round. Answer on the board, review its prompt, then choose **Send to Pi** for Pi's native session relay or **Send via Aboard** for Claude/ChatGPT. Copying the prompt remains available.

## What happens

The agent asks the current frontier of decisions, with options and recommendations. Its hook supplies fresh round and asset paths outside the project, uploads local explanation images, publishes the round, and returns the session URL. Only queued answers enter the next prompt. Unanswered questions retain their IDs in later rounds; the process continues until decisions are settled and you confirm shared understanding.

## Files and prerequisites

Claude/ChatGPT use hooks; Pi uses an extension and Python publisher, with no Aboard prerequisite. Install with `harness install grill-me-in-cloud --platform pi`, then reload Pi. Pi 1.2.0 is the verified runtime. The hosted app needs the Pi provider migration and current server; older deployments stop the invocation before inference with an upgrade diagnostic.

Board connection can be configured in Harness config under `grill`; workspace-local `.harness/config.local.json` is ignored by project installs and can hold the URL and code. Drafts, round assets, and Pi's delivery journal live outside the project. The relay advertises the exact session and accepts answers when Pi is idle. Delivery is confirmed only after that session's saved JSONL contains the correlated user message. Reload/resume recover accepted answers without submitting them again. A second process resuming the same session cannot take over a live relay.

Use `/grill-cloud-stop` to disconnect the Pi interview. Its board history and answers remain available; invoke the skill again to reconnect. An outage or expired delivery preserves the saved answers: reconnect and send a newly reviewed prompt, or copy it into the session. Forked sessions need their own explicit invocation, and tree navigation invalidates the previous branch's relay.

## Example

`/grill-me-in-cloud Review the checkout redesign` opens a hosted decision round for that proposal.

Video previews use the same local asset workflow as images. The publisher checks for the installed `ffmpeg` on PATH and prepares MP4/WebM clips locally; it never bundles FFmpeg. Videos support native inline controls and optional poster images. Each source and prepared clip is limited to 20 MiB, with 50 MiB / 20 assets per round. Personal deployments need the current app and video asset migration.

Edited diagrams travel with the reviewed answers as private immutable PNGs. The review shows authenticated asset endpoints and a snapshot-specific Python command using the installed helper. Aboard downloads and verifies them into an external runtime cache before sending the prompt; copy/paste and Pi's native relay retain the authenticated references and command. Run that command from the project directory to retrieve all images together, including their question and diagram identities. It resolves the same local, shared URL, user and environment configuration as publication, without putting the access code in commands or output. Retrying reuses verified cached files and repairs corrupt files.
