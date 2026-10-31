# Deterministic real-CLI E2E environment

Harness replaces model inference with authenticated loopback servers. The installed agent CLI,
native tools, project resources, extensions/hooks, filesystem, and session lifecycle remain real.
Tool implementers use this environment to verify observable behavior, without paid inference or
prompt-text assertions. Read the repository's `harness-e2e` skill before changing this boundary.

## Run Pi checks

Prerequisites: Node.js >=22.19.0, npm, uv, a synced root Python environment (`uv sync`), and stable Pi >=1.2.0 and <2.0.0 on `PATH`.
CI installs `@earendil-works/pi-coding-agent` 1.4.0. The adapter accepts later stable 1.x
minor releases and checks required CLI flags; the real journeys verify behavior. A new minor
version alone does not fail preflight. Prereleases and new major versions require explicit review.

From `tests/e2e/`:

```powershell
npm ci
npm run check
npm run test:pi-all
# Or select individual journeys:
npm run e2e:pi
npm run test:pi
npm run test:pi-package-precedence
npm run test:pi-shared-skills
npm run test:path-guards
npm run test:pi-path-guards
npm run test:pi-command-guard
npm run test:pi-prefer-fewer-comments
npm run test:pi-issues
npm run test:pi-no-new-documents
npm run test:pi-cleanup-git
npm run test:pi-test-workflows
npm run test:pi-commit
npm run test:pi-desktop-notification
npm run test:pi-report-gotchas
npm run test:pi-subagents
npm run test:pi-web-toolkit
npm run test:chrome-devtools
npm run test:pi-background-shell
npm run test:pi-calm
npm run test:pi-mid-prompt-skills
npm run test:pi-file-mentions
npm run test:pi-environment-context
npm run e2e:flush-out-useless-tests
```

`e2e:pi` runs the real JSON and RPC smoke journeys. `test:pi` additionally verifies zero-inference
extension commands, reload, exact persisted-session resume, native project skill discovery,
provider-error classification, abort, redacted diagnostics, and cleanup. The complete `npm test`
suite includes these Pi checks and also requires the installed Claude Code and Codex CLIs.
`test:pi-all` runs the full Pi suite serially. The shared installer uses shipped host-runtime pins by
default; checkout-runtime substitution is an explicit development variant, not release acceptance.
The shared CI job installs all three CLIs and uv, syncs the Python environment, and bounds test-file
concurrency so process-heavy journeys do not all contend at once.

### Pi 1.4.0 upgrade checks

The Windows upgrade checks on 2026-10-27 use the installed Pi 1.4.0 CLI with the authenticated
fake Responses API. `test/pi-resume-tools.test.ts` additionally exercises real compaction and
continued guarded writes, plus RPC-to-JSON session resume: selected tools stay active, newly
installed tools become active, explicitly removed tools stay inactive, and Harness exclusions
still prevent tool registration. Both journeys assert filesystem effects and exact inference counts.

Standalone real-SDK checks cover the private adapters in Statusline, Exclude Unwanted Tools,
Polished Code Blocks and Tool Inspector:

```powershell
# Run from the repository root; substitute the installed Pi npm package directory.
node tests/unit/statusline_host.mjs <pi-package-directory>
node tests/unit/exclude_unwanted_tools_host.mjs <pi-package-directory>
node tests/unit/polished_code_blocks_host.mjs <pi-package-directory>
node tests/unit/tool_inspector_host.mjs <pi-package-directory>
```

Calm's real loader/component checks run inside `test:pi-calm`. Aboard's consuming
`npm run e2e:pi` journey also passes with Pi 1.4.0. These checks cover headless integration
and the exercised components; interactive terminal behavior and POSIX need their own runs.
Earlier tool sections below retain their original 1.2.0 acceptance evidence. Accepting future
1.x releases at preflight does not claim those untested versions have already passed these checks.

`e2e:flush-out-useless-tests` installs the real local catalogue package through Harness, then
runs project JSON/RPC and user RPC journeys. It checks a real Node test baseline, native skill
discovery, no edits before scripted approval, exact cleanup and passing verification, dry-run,
repeat install, agent-directory receipt separation, and cross-provider uninstall preservation.
Run `uv sync` in the repository first; the installer helper uses that environment offline.

`test:pi-shared-skills` installs the 22 local shared-skill ports, including `caveman`, `setup-help`, and `websearch`, at project and user scopes,
checks native discovery of all 23 entry points and their explicit-invocation flags, invokes
each skill, reads bundled references and the websearch source index with real tools, and checks exact inference counts
and receipt-driven removal. Scripted fixture actions certify resource integration;
they do not evaluate unscripted workflow judgment or external services. Upstream skill bridges
such as Lavish have separate acquisition and receipt tests; this journey checks local payloads.

Pi extension packages install through `pi install` under
`npm/node_modules/harness-pi-<tool>/` in the selected Pi directory. Each archive contains its
extensions, skills and required Python/TypeScript helpers; resource paths remain inside the
package. `test:pi-package-precedence` verifies matching user/project identities, reload,
copied checkouts, filters, untrusted projects and user fallback. It also runs native npm updates
with npm networking disabled, reinstalls the archive directly through Pi, and checks native
removal preserves another package and its npm metadata. Archives and settings stay in the fixture.
Editable user policies remain under `<agent-dir>/harness/`; project policies use `.harness/guards/`.
The coupled subagent toolkit skill stays in conventional `skills/`, where both Pi and its
independent Python runtime read the same delegation instructions.
Command-guard journeys check fresh project and user installations create no `hooks/` directory. They also run
the installed Pi startup warning detector in an isolated subprocess and require zero warnings.
JSON/RPC suppress interactive deprecation warnings, so silence alone is not evidence. A positive
control checks the detector recognizes legacy directories at both scopes.

Each fixture creates its own external temporary directory:

```text
<temporary root>/
├── project/.pi/settings.json     # selects harness-e2e/pi-e2e
├── project/.pi/skills/           # staged real tool skills
├── project/.pi/extensions/       # staged real tool extensions
├── pi-agent/models.json         # custom OpenAI Responses baseUrl and dummy key variable
├── pi-agent/settings.json       # controlled resources, no retries/cache warming
├── pi-agent/auth.json            # empty, no personal credentials
├── home/                        # isolated user resources and application state
├── sessions/                    # real Pi session files, removed at teardown
└── structural-diagnostics.json  # metadata only, upstreamMode: forbidden
```

Pi's supported custom endpoint definition belongs in agent-directory `models.json`, not project
`.pi/models.json`. The fixture sets `PI_CODING_AGENT_DIR` to `pi-agent/`; project settings select
that provider/model. No personal/global Pi configuration is edited. The URL is an ephemeral
`http://127.0.0.1:<port>/v1` endpoint using the **same fake OpenAI Responses server as Codex**.
The dummy bearer is per-fixture and supplied by an environment variable, not written into config.
There is no forwarding mode or upstream fallback.

Child environment variables are allowlisted. Personal home/config/skills/auth and inherited model
credentials, selectors, proxies, and cloud credentials are excluded. Launches use `--offline`,
disable telemetry/version checks/MCP and unrelated built-in extensions, and trust only the
generated project through process-local `--approve`. Automatic compaction, retries, and cache
warming are disabled. Trust is never persisted for an unrelated project.

## Pi environment context

`npm run test:pi-environment-context` installs the real Pi-only catalogue package at both
project and user scopes. Real Pi 1.2.0 JSON/RPC runs cover non-Git and local Git working
directories, reload without inference, native write effects, dry-run/repeat installs, and
receipt-driven removal. A fixture extension records final section names and sizes at agent start,
plus native session metadata; checks do not compare prompt wording. Each scope requires
seven inference requests and zero unexpected requests. Unit fixtures separately verify
full Git counts, staged/unstaged overlap, conflicts, renames, individual untracked files,
and list truncation. No personal Pi configuration or paid inference is used.

## Pi file mentions

`npm run test:pi-file-mentions` installs the real `file-mentions` package at project and user
scopes and runs JSON/RPC prompts through Pi 1.2.0. The endpoint checks structured resource paths,
fixture bytes, escaping, duplicate counts, fresh content, shallow directory entries, explicit
skips and bounded listings, rather than instruction wording. A separate child loads the installed
extension with Pi's real loader and user-message component: it verifies content stays in model
input while rendering only the original user block, including old snapshots and reload. Statuses
use separate native info notifications with literal relative paths, including unusual characters;
RPC journeys verify notification payloads and ordering after user-message start. Native tool writes produce fixture receipts; each scope requires exactly
10 inference requests, zero unexpected requests, unchanged
settings and receipt-driven removal. Unit checks additionally cover images, code exclusions,
UTF-8 validation, aggregate/reference budgets and canonical symlink deduplication. No personal
Pi configuration or paid model service is used.

## Chrome DevTools

`npm run test:chrome-devtools` installs the actual catalogue package into an isolated npm
prefix at both Pi project and user scopes. It uses the pinned upstream CLI, a unique daemon
session and temporary browser profile, with upstream telemetry/update checks disabled. Requires
the catalogue's Node.js/npm prerequisites and installed Google Chrome; no personal daemon or
global npm installation is modified. The real Pi RPC fixture invokes the installed skill,
reads its bundled installation reference, and uses the native shell to run the browser check.
A loopback page supplies a button; the CLI discovers its snapshot UID, clicks it, verifies
the changed heading, and saves a real screenshot. Each scope uses exactly three scripted
inference requests and no unexpected requests. Dry-run, repeat install, cross-provider host
sharing, and final receipt-driven npm removal are checked. This certifies integration and
browser effects, not unscripted agent judgment or arbitrary external websites.

## Pi slash command guard

`npm run test:pi-slash-command-guard` installs the actual `slash-command-guard` package
at project and user scope against Pi 1.2.0. RPC checks unknown commands produce error
notifications without user messages or inference, including after reload. Native extension
dispatch and `/clear` remain zero-inference; resolved skills, prompt templates (including
tab-separated arguments), and normal text with later slashes still reach the fake endpoint.
JSON mode also rejects unknown input before an agent run. Dry-run, repeat install and
receipt-driven removal are checked; after removal unknown slash text reaches inference again.
Each scope makes exactly five expected requests and zero unexpected requests.

## Pi mid-prompt skills

`npm run test:pi-mid-prompt-skills` installs the actual `mid-prompt-skills` catalogue package
at project and user scope, using real Pi 1.2.0 JSON/RPC against the shared fake Codex Responses
API. Twelve cases per scope cover later/multiple/stacked invocations, native leading expansion,
deduplication, fenced and inline code, unclosed fences, unknown names, token boundaries, and
already expanded resources. Structured skill identities/locations select real reference reads
and receipt writes; instruction wording is not a prompt contract. Checks also verify configured
external skills, explicit-only skills with command discovery disabled, native collision precedence,
image preservation through the real input pipeline, zero-inference unreadable-file handling,
exact inference counts, repeat/dry-run installation and receipt-driven removal. A final headless
run verifies later invocations are no longer expanded after uninstall. This certifies loading,
not unscripted model compliance or sequencing. `e2e:pi-mid-prompt-skills` runs the same journeys
and prints structural summaries only.

## Pi Calm

`npm run test:pi-calm` installs the actual `calm` package at project and user scope.
The real Pi RPC journey checks zero-inference `/calm` preference changes, restart persistence,
native write/read effects, exact inference counts and receipt-driven removal.
An isolated child loads the installed payload through Pi's real extension loader and checks
all eight native tool rows through Pi 1.2's renderer merge. It verifies streaming/completed
row hiding for native tools, Background Shell, unmarked custom tools, SDK overrides, custom
self-framed renderers and unavailable-tool fallback rows, plus summary rendering, exact
restoration, reasoning expansion and images,
reload and listener disposal. UI calls that replace the native working display fail the check.
The actual tool-row component renders each call as an independent transient chat block;
checks cover all streamed calls, overlapping execution, independently staggered three-second
completion holds using a controlled monotonic clock, green/red completion dots, long-running calls,
late-update suppression, request/settlement hold preservation, timer disposal, nested calls, narrow terminals and toggling
during a run. Changing the working message fails.
These component checks cover rendering; the RPC journey alone cannot certify terminal display.
The same checks run with a preinstalled legacy renderer to catch live-upgrade regressions;
reload must replace drawing code and preserve a single prototype wrapper.

## Pi background shell

`npm run test:pi-background-shell` installs the actual `background-shell` catalogue payload at
project and user scope and launches real Pi RPC sessions. The project Bash journey includes a
26-second command with no output, proving launch returns while work continues and silence does
not end the job. A second prompt succeeds while it runs. A completion notification then wakes
the agent, whose real `write` tool saves the observed exit status and output to a fixture receipt.
The inference server routes from call/result history and completion data, without polling jobs
or using prompt wording assertions. The running command is inspected with omitted, false and true
`show_output` values through `get_background_shell_status`; status is always returned, output is
opt-in. User turns receive a hidden count-only reminder, and both replacement tools require an ID.
Windows user-scope acceptance also exercises native PowerShell. A synchronized background worker
finishes during a real foreground command; its steering message must reach the next model request
before the ongoing task's next write, with one final response and no completion-only follow-up.

Automatic-handoff cases (the fixture sets `backgroundShell.foregroundTimeout`) verify the foreground limit returns before completion, the worker
launches once, its log includes output from before and after handoff, and another prompt can
run while it continues. A nested caller aborts its own signal after handoff to verify background
ownership. Hard `timeout` deadlines are checked before and after handoff, including a timeout equal to the foreground limit; commands that settle in the foreground must not send a completion notification.

Further cases cover nonzero native exit codes, explicit termination deadlines, large output and
log limits, command-guard denial before launch, invalid arguments, process-tree cancellation,
reload, tree-navigation, session-switch and shutdown cleanup, nested execution and guard denial,
exact inference counts, unchanged project settings/instructions, and
receipt-driven uninstall. All provider traffic stays on the authenticated fake loopback endpoint.
The `/ps` command is discovered and handled without inference. A tool cancellation returns its
final state directly through `cancel_background_shell` without an automatic duplicate when
cancelled before submission; Pi-owned queued messages cannot be retracted. Project
acceptance also runs component/real-process checks against the installed Pi SDK: split-tool schemas,
optional output, running-count reminders, six-character ID collisions/non-reuse, selector navigation, cancellation
and reopening, editor replacement/restoration, bounded wrapping/scrolling, key-release filtering,
native fullscreen Page Up/Down and wheel dispatch, pre-submission consumption, receipt confirmation,
queued-message non-retraction, ambiguous-submission deduplication, and synchronous rejection retry.
`npm run e2e:pi-background-shell` is the corresponding CLI journey.

## Reusable boundaries

| Module | Responsibility |
| --- | --- |
| [`core/openai-server.ts`](core/openai-server.ts) | Authenticated Responses SSE transport, structural observations, request counts, fail-closed errors; shared by Pi and Codex. |
| [`core/pi.ts`](core/pi.ts) | Isolated configuration/environment, CLI compatibility, JSON launcher, RPC client, LF framing, deadlines, semantic completion, process-tree cleanup. |
| [`core/pi-fixture.ts`](core/pi-fixture.ts) | Own the external root, server, workspace, RPC children, and teardown. |
| [`core/pi-scenario.ts`](core/pi-scenario.ts) | Linear native-tool scenario derived from full call/result history; stable IDs and structural validation. |
| [`core/installer.ts`](core/installer.ts) | Run the real local Harness installer offline, with target and receipt state inside a fixture. |
| [`tools/pi-smoke/`](tools/pi-smoke/) | Executable example exercising the real provider boundary. Its probe extension is test-only. |
| [`test/pi.test.ts`](test/pi.test.ts) | Public-boundary checks against real Pi, not mocks of its event handlers. |

`createPiFixture` accepts the shared server's transition callback. Use `createPiToolScenario`
for simple sequential native-tool journeys. More complex tools supply their own transition over
`request.input` and `request.tools`, maintaining the same closed history/identity contract.
Use complete history to choose responses; an HTTP request counter is not scenario state.

## Add a Pi tool journey

1. Create `tools/<tool>/scenario.ts`, `run.ts`, and `cli.ts`, with a test in `test/`.
2. Create a fixture and stage the checked-in package payload in its project using the proposed Pi
   mappings. Once the Pi installer ships, install the actual local package through it. Copy the
   real extension, helpers, skills, and policies; the smoke probe is not a production tool adapter.
3. Script only inference responses. Have Pi execute the real actions with stable call IDs, then
   inspect the observed call/result history before returning the next response.
4. Assert exact file/index/Git/GitHub effects, actual guard errors, durable session/receipt state,
   and expected inference/unexpected-request counts. Assert permission effects, not denial prose.
5. Close the fixture in `finally`, then run `npm run check`, the focused journey, and `npm test`.

Minimal runner shape (the real tool payload is staged at the indicated point):

```typescript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPiFixture } from "../../core/pi-fixture.js";
import { createPiToolScenario } from "../../core/pi-scenario.js";

const scenario = createPiToolScenario({
  name: "my-tool", marker: "[E2E:my-tool]",
  steps: [{
    checkpoint: "write", tool: "write",
    input: { path: "result.txt", content: "expected\n" },
  }],
});
const fixture = await createPiFixture(scenario);
try {
  // Stage the tool's actual checked-in Pi payload here.
  const run = await fixture.runJson({ prompt: "[E2E:my-tool]" });
  assert.equal(run.status, "success");
  assert.equal(await readFile(join(fixture.workspace.projectRoot, "result.txt"), "utf8"), "expected\n");
  assert.equal(fixture.assertions().inferenceRequests, 2);
  assert.equal(fixture.assertions().unexpectedRequests, 0);
} finally {
  await fixture.close();
}
```

The marker is a scenario routing key, not a contract for agent prompt wording. A skill journey
places the marker in its staged skill and invokes `/skill:name`, so native discovery/expansion
must work for the fake server to select the scenario.

## Choose JSON or RPC

Use `fixture.runJson({ prompt, sessionId })` for one-shot journeys. For continuation, locate the
saved file under `workspace.sessionsDir` and pass its exact path as `sessionFile`; avoid Pi's
most-recent-session shortcuts. Session files stay inside the fixture and are removed afterward.

Use `fixture.rpc()` for warm sessions, native commands, abort, reload, or later feedback loops:

```typescript
const rpc = fixture.rpc();
const result = await rpc.prompt("/my-deterministic-command");
assert.equal(result.status, "handled");
assert.equal(fixture.assertions().inferenceRequests, 0);
```

`prompt()` consumes output continuously and correlates RPC responses. `handled` means the original
prompt was consumed; extension-started work still needs its own effect/request checks. Otherwise
it waits for `agent_settled` and checks assistant stop reasons. A zero process
exit or successful prompt response alone is not successful model work. Provider errors and aborts
produce `failed` and `aborted`. JSONL uses LF framing, including messages with Unicode separators.
RPC's TUI built-in commands are not a universal control API: the smoke extension's `e2e-reload`
command calls native `ctx.reload()` to verify that lifecycle without sending `/reload` to a model.

Per-process and per-command deadlines are bounded, output is capped in memory, and teardown kills
only fixture-owned process trees when orderly shutdown fails. `fixture.close()` also closes all
RPC clients; callers may close an individual client early.

## Diagnostics and limits

`run.events` contains rich protocol records **in memory only**. Never print/persist it, raw stdout,
transcripts, prompts, tool arguments/results, credentials, or response bodies. Public journey
results should carry structural status, event/tool names, counts, and checkpoint labels only.
The server persists redacted metadata and hashes and refuses unknown routes, authentication,
model/history shapes, tool identities, and ordering. Preserve the unknown-history failure check
when changing a scenario.

The Pi smoke proves the test environment, not catalogue-tool support or a security sandbox.
The first tool's journey proves installer/native skill integration and a scripted approval flow;
it does not evaluate unscripted model judgment or turn a skill's instructions into an enforced guard.
Tool-specific policies still need their own real journeys. The current bootstrap was executed on
Windows with Pi 1.2.0; POSIX, Pi TUI, browser/UI, MCP/codemode, production runtime, and Aboard
provider parity need their applicable additional journeys. GitHub-backed tools should use the
existing disposable fixture rules from the `harness-e2e` skill. Supply any scoped external-fixture
credentials explicitly for that journey; keep model-service credentials excluded. Do not reset
shared remote state to prepare a local Pi smoke run.

## Pi commits and desktop notifications

`test:pi-commit` installs the actual `commit` package and exercises the native command through
Pi headless JSON/RPC against the fake Responses API shared with Codex. Acceptance inspects real
Git HEAD, commit paths/trailer and index contents, active-branch receipts and exact inference
counts. It covers dry runs, command/skill aliases, successful native and shell changes, uncertain
attribution, preexisting work, unrelated staging, reload/resume/tree/fork identity, merge refusal,
literal filenames, failed shell effects and dependency removal. The separate authenticated loopback
Gemini fixture verifies direct AI generation, failed-generation explicit-message recovery, and
working-tree/index changes arriving during generation. All four project/user × JSON/RPC combinations run.
Pi's event attribution conservatively refuses overlapping same-path/shell calls and unrecognized
mutators; passing this fixture does not certify arbitrary extension I/O.

`test:pi-desktop-notification` runs project/user installs with real Pi, the installed Python
adapter and the shared OS notifier. Its recording executable replaces only the native desktop
submission boundary (Windows `powershell.exe`, macOS `osascript`, Linux `notify-send`) inside the
isolated fixture PATH. Notification text stays in the fixture and is deleted at teardown; journey
output contains structural counts only. Assertions cover zero-inference enable/disable and skill
alias, Unicode title/body, two `agent_end` events with just one final notification, backend failure,
reload/tree preferences, new/fork isolation, exact JSON resume, helper outage and coupled removal.
A separate real-provider failure/abort journey verifies one explicit status notification each.

Acceptance was run on Windows with Pi 1.2.0. Run `npm run e2e:pi-desktop-notification -- --native`
for an explicit real-desktop smoke through the installed Pi package. The existing Windows notifier
successfully submitted a toast without the recording backend, and the user confirmed visible
delivery. POSIX desktop services and the interactive Pi TUI remain outside this headless gate. `--ai` requires its own explicitly
requested Gemini service; command integration uses fake inference, never paid Pi inference.

## Pi Web Toolkit

`test:pi-web-toolkit` installs the actual `web-toolkit-native` extension without a host CLI
installation, then acquires the shipped immutable uvx source into an empty isolated cache.
Project JSON and user RPC journeys use real Pi 1.2.0 with the
fake OpenAI Responses API shared with Codex. They verify that no Web Toolkit skill is installed
or discovered and invoke the native tools directly. Local HTTP pages verify fetch, redirects,
Unicode, saved full text, HTTP error bodies, validation, missing uvx, offline acquisition failure and
RPC cancellation. Search runs the real CLI and Chrome DOM extraction/filtering; a fixture
CDP connection fulfills search navigation with fixed engine HTML and blocks other browser
requests. This tests the integration without depending on public engine availability.
Domain-filter journeys verify multiple allowed hosts, case normalization, subdomains,
blocked-host precedence, unrestricted search, invalid domain inputs and rejected mixed filter
syntax. They inspect the exact query received by the actual browser in memory only.
Each journey expects 20 inference requests and zero unexpected requests, checks the offered
tool schemas and structured outputs, and verifies receipt-driven removal and unchanged settings.
The CLI arguments include shell metacharacters to verify literal transport.
Cancellation must disconnect the actual HTTP request, preserve the shared browser endpoint,
and permit a subsequent native browser-backed search. A subprocess loads the installed extension
with Pi's real SDK, starts a real uvx fetch, fires the unmodified 120-second deadline callback
under a controlled clock, and requires HTTP disconnection and shared-browser survival.
The same subprocess checks the 256 KiB output limit against an actual large CLI response.
The journeys verify no permanent CLI package or executable is installed. They also install
the separate `web-toolkit` skill, verify native skill discovery alongside the extension,
and remove each package independently while preserving the other. Skill discovery and
installer ownership are covered; unscripted model selection of the skill remains outside this gate.

Run `npm run e2e:pi-web-toolkit` for the executable journeys. Chrome, Edge or Chromium is
required. These Windows headless checks cover native integration; public engine availability,
POSIX and interactive Pi rendering remain separate acceptance boundaries.

## Pi gotcha reports

`test:pi-report-gotchas` installs the checkout `report-gotchas` skill and executes its bundled
Python scripts directly in all four project/user and JSON/RPC combinations. It uses real headless Pi 1.2.0 and
the fake Responses endpoint, with no reporting extension, hooks, transport dependency or Git
repository. A loopback HTTPS Discord fixture preserves real URL validation, TLS, urllib,
shell execution and CLI exit status. It requires `openssl` for its temporary certificate;
its CONNECT proxy refuses every destination except the fixture host and never forwards
externally. Webhook bodies remain in memory and fixture files stay in the external temporary root.

Checks cover confirmed direct posting, missing configuration, empty reports, Unicode, disabled
mentions, multipart posts, explicit HTTP/rate-limit errors, exact inference counts, absence of
local report storage and installer removal. The only reporting state is webhook configuration.
No unit-test mock replaces the CLI or HTTP client.

`npm run test:report-gotchas-local` additionally runs the bundled scripts through real
Claude Code and Codex using the same local HTTPS fixture, with three inference requests
per provider and exact report delivery. No live Discord messages are sent by these tests.

Explicit live acceptance uses the configured real Discord webhook:

```powershell
npm run e2e:report-gotchas                  # real headless Claude Code and Codex
npm run e2e:pi-report-gotchas -- --live      # real headless Pi JSON
```

These commands each post clearly labeled test reports. They read the webhook from the user's
configuration (or `HARNESS_REPORT_GOTCHAS_E2E_WEBHOOK_URL`) and pass it only in child environment
variables; diagnostics never contain the URL or message bodies. Inference always goes to the
fake loopback API. Each live provider journey requires exactly three inference requests and
checks the real CLI's confirmed Discord success before completing. Before the packaging changes,
all three live journeys passed on Windows and the user confirmed receipt of the notifications.
The bundled scripts are verified against the local HTTPS fixture; live posting has not been rerun.

Package managers are offline and no reporting CLI is installed; only Discord uses the network.
Interactive Pi TUI and POSIX need separate checks.

## Pi persistent subagents

Checkout-runtime regressions publish BOM-prefixed requests through native shell tools in JSON auto
and RPC interactive sessions, including a command that writes its request before failing. They
verify one launched child, one acknowledged result, an empty request inbox and four inference
requests. The shared Claude/Codex journey also publishes shell-created BOM requests without an
explicit `harness ask`; lifecycle hooks must discover and launch them.
Separate Claude/Codex cases disable tool-completion hooks and verify that Stop discovers
the request, launches the child and delivers its result.

`test:pi-subagents` installs the real `subagents` package at project scope into an isolated uv tool
environment. The auto journey runs with both the checkout runtime (`--local`) and the manifest's
published Git pin; the latter catches stale runtime pins that local-source tests cannot detect.
The npm packaging checks found that the current `c650a6f` pin predates the extension's
`inbox_scan` operation. Four shipped-pin subagent journeys fail until the runtime changes in
local commit `ba136dd` are published and pinned. Checkout-runtime delegation and the combined
cloud interview stack pass; those development results do not certify the shipped runtime pin.
The interactive journey uses the shipped runtime pin. The shared fixture installer defaults to
shipped pins; local-runtime testing must opt in explicitly. A project
`.harness/config.json` gives children the same isolated, trusted Pi invocation; the session and agent
directories are inherited. The auto journey runs a JSON parent that writes an inbox request,
launches a real `pi --mode json` child under the runtime supervisor, waits in `agent_before_settle`,
and integrates the answer. The interactive journey runs an RPC parent; `capture-terminal.mjs`
stands in for the visible terminal and hands the launch specification to the test, which opens the
child as an RPC session with the runtime's environment and requested model/thinking flags. The child's previous-message reply makes
zero inference requests and the result starts the idle parent's next turn. Each journey asserts
exactly four inference requests, the succeeded and acknowledged request, one persisted result
message matching its delivery ID, the child's native session file and no remaining request file.
Combined auto and interactive journeys start through `/skill:grill-me-in-cloud`, obtain the inbox
without invoking a delegation command first, request `gpt-6.1-sol` at medium effort, integrate the
child result, and publish a round. The model ID is registered only against the loopback fake endpoint. Both check the
child's persisted model/thinking metadata, the board payload, request cleanup and exactly five
inference calls, with project guards and user-scope background shell, Calm and input extensions loaded.

The checkout-runtime busy-parent regression holds an RPC parent in a bounded real shell tool.
The interactive child sends `/reply-to-agent-with-previous-message` with zero inference; durable state
must show a claimed delivery while RPC confirms the parent is still busy, with no concurrent model request.
After releasing the tool, the very next model request must contain the child's result. Acceptance
requires continuation of the same parent run, exactly five inference requests, one persisted and
acknowledged delivery, the native child session, and an empty inbox.

To run the combined journeys against the real local Grill app, database and storage instead of the
transport fixture, start the local stack described in `apps/grill/README.md`, set
`HARNESS_GRILL_URL` to its `http://127.0.0.1:<port>` origin and `HARNESS_GRILL_CODE` to its test code,
then run `npm run e2e:pi-subagents:live`. This command accepts loopback services only, keeps inference
on the fake endpoint, and deletes only each journey's UUID-owned board session afterward.

The shutdown regression also runs a real JSON Pi parent with an automatic Codex child using
`gpt-6.1-sol` at medium effort, with both catalogue targets installed from the checkout runtime.
Its hook adapter deliberately withholds the child's `Stop` result and runs the actual `SessionEnd`
handler before process exit. Acceptance requires a pending request at shutdown, the supervisor's
successful reply, one persisted and acknowledged Pi delivery, a native Codex session, an empty
inbox and exactly four fake-API requests. The shared Claude/Codex subagent journey additionally
checks this shutdown order on both the initial automatic launch and its continuation.

This certifies Windows headless integration, not the Pi TUI, POSIX, or Claude/Codex parents with
Pi children through real CLIs. Unpublished runtime changes use checkout-source acceptance;
advance the manifest's immutable source pin when releasing those changes.

## Pi path guards

`test:pi-path-guards` installs the real `on-read-reminder`, `on-edit-reminder`, and
`on-edit-block` catalogue payloads with their coupled `pi-path-guards` and `pi-transport`
dependencies. It exercises headless JSON/RPC and project/user installations through the fake
Responses endpoint. Assertions
cover original tool output, additive guidance, cooldown, failed calls, complete and partial reads,
denied mutation effects, shell reads, nested native calls, reload/tree ancestry, exact bytes,
inference counts, starter preservation, and removal of the last dependent's bridge. Test-only
probe commands orchestrate lifecycle changes without inference; production guards decide policy.

`test:pi-command-guard` installs the real `command-guard` 2.2.1 payload with its coupled
`pi-transport` dependency. It runs the installed Pi 1.2.0 JSON/RPC CLI at project and user scopes
through the fake Responses endpoint: a safe native `bash`/`powershell` call runs and writes its
file, while a configured dangerous command is denied with no side effect. A malformed policy
denies every command, matching the hook's fail-closed behavior. Assertions cover dry-run bridge
absence, idempotent reinstall, denied-call effects, exact inference counts, starter policy
preservation, and removal of the extension, Python helper, and the last dependent's bridge. The
shared Python core owns policy parsing; the extension only translates native events.

## Pi comment budgets

`test:pi-prefer-fewer-comments` installs actual `prefer-fewer-comments` 2.3.1 and its coupled
bridge at project/user scopes and runs the installed Pi 1.2.0 JSON/RPC CLI against the fake
Responses endpoint shared with Codex. Four scope/mode journeys verify unchanged overwrites,
inline code changes, new adjacent comment lines, full multiline lexical context, template strings,
comment/doc/header/density budgets, directives, ordered exemptions and project precedence,
cooldown, distinct outside-project files, failed edits, native `@` paths, multi-edit diffs and BOM/CRLF bytes. A bounded analysis
failure preserves the mutation and adds a diagnostic. Receipts contain no file snapshots.

The lifecycle journey exercises concurrent nested native writes alongside the actual edit guards,
denied mutation effects, one comment receipt per file cooldown, reload, tree ancestry, exact saved
session resume, zero-inference lifecycle commands and shared dependency removal. A sixth journey
removes/restores the real helper, verifies successful writes and unspent cooldown across the outage,
then checks explicit zero comment/doc/header budgets and a fresh native session. The suite checks exact
filesystem bytes and inference counts; scripted inference certifies integration, not unscripted
model response to advice. Run `e2e:pi-prefer-fewer-comments` for the executable project JSON,
user RPC and lifecycle journeys. Shell mutations and competing tool replacements are outside coverage.

## Pi issue workflows

`test:pi-issues` installs `issue-readers` and `issue-writers` with their coupled bridge at
project and user scope. Real Pi 1.2.0 JSON/RPC sessions prepare issue context, implement and review
fixture files, reject dirty addressing without inference, invoke the four writing skills and
publish through the native command with no inference. Agent journeys also preview and publish through
the installed script with the native shell, checking automatic identity, immediate results and no deferred notice.
A local fake `gh` records read and publish effects; no GitHub credentials
or external tracker mutations are involved. Checks include supplied draft paths, reload identity,
foreign-session preservation, dry-run/invalid options, removed writer aliases, response-only specs
without draft setup, progress notifications, draft-to-issue notice mappings and exclusion of visible
publication reports from model context, exact inference counts, reader skills installed only inside
their npm package and removal of the bridge after its last dependent. Python unit tests exercise complete
context, relation deduplication, provider identity and notice isolation; the existing issue graph
and publishing tests retain all-page retrieval and dependency/crash-recovery coverage.

`npm run e2e:pi-issues:live` additionally exercises the exact private
`EmilienxD/harness-e2e` repository with the real authenticated `gh` CLI, while retaining
fake Responses inference and isolated real Pi JSON/RPC at project and user scope. It publishes
a parent/child draft batch, verifies labels and rewritten references, adds a maintainer comment,
and verifies both readers receive the live issue graph. Dry-run leaves GitHub untouched;
publication and repeat publication make zero inference requests. The active GitHub account must
be `EmilienxD`. A token is passed to the isolated child environment in memory only.
The run closes only its UUID-tagged issues and restores any gateway label it added; it never
resets the fixture, changes branches, or recreates the repository. Run this explicit live command
when GitHub acceptance is needed; `npm test` retains credential-free local journeys.

## Pi document drafts, Git cleanup and test workflows

`test:pi-no-new-documents` installs actual project/user catalogue payloads, then runs JSON/RPC
with the fake Responses endpoint shared with Codex. It checks denied direct/shell/nested creations,
allowed existing-document edits, mirrored drafts, quoted paths, zero-inference approval/rejection,
no overwrite, competing publication, skipped malformed policy, escaping paths, reload/resume/tree notices,
starter preservation and receipt-driven removal. Other extensions' direct I/O and arbitrary scripts
remain outside the guardrail; native commands are also callable by trusted extensions.
The two native-path journeys verify `@`, tilde, file URL and Unicode-space expansion plus Windows
MSYS/WSL/Cygwin paths and casing, aliases into docs, docs links outside the project and linked
draft rejection. Both installation scopes deny twelve creations on Windows and preserve exact
native write/edit and approved bytes. A policy journey verifies the root-only starter, project
exclusions overriding recursive user protection, and skipped invalid entries in both JSON and RPC;
it asserts newly created files, denied effects and twelve inference requests. The complete gate has
eight journeys; commands add zero inference requests. See the [document-guard implementation and source evidence](../../docs/user/tools/guards/no-new-documents.md#implementation-and-verification)
for the event-guard choice and coverage boundary.

`test:pi-cleanup-git` verifies project JSON and user RPC invocation through native skill expansion.
Inventory collection performs only local Git and fake paginated GitHub reads. The scripted model
waits for named approval, rechecks live state, preserves a branch with newly arrived commits, and
removes only the approved merged branch/worktree. Unrelated input starts no inventory; unavailable
skills/helpers stop before inference. These checks certify integration, not unscripted cleanup judgment.

`test:pi-test-workflows` installs the shared skill and executes its bundled Python script
with package managers offline and no installed helper CLI. Project JSON and user RPC run a passing acceptance check before explicit confirmation,
then introduce a regression and prove failed acceptance leaves verification stale. Broken/invalid
coverage, exact hashes, request counts, skill removal and absence of installed host CLIs are checked. Status
and confirmation do not execute the acceptance steps themselves.

These journeys use real Pi 1.2.0 on Windows, isolated configuration/session directories and fake
inference only. POSIX runtime acceptance and Pi TUI behavior need their own applicable checks.

## Pi hosted interviews

`npm run test:pi-grill` uses the real installed Pi 1.2.0 CLI, actual catalogue payloads,
and the authenticated fake OpenAI Responses endpoint shared with Codex. A local hosted
transport fixture injects unsupported-service, outage and acknowledgement failures.
It verifies project RPC and user JSON-to-RPC workflows, malformed-round rejection,
SVG upload, queued-only answer effects, a single persisted correlated user message,
publication outbox recovery and abandoned-branch suppression, reload recovery, competing
claims/processes, tree/fork isolation, explicit stop, new sessions and receipt-driven removal.
No unit tests or paid inference are involved.

To exercise the actual Grill API/database/Storage, start the local Supabase stack and Grill
app as described in `apps/grill/README.md`, or deploy the additive Pi migration and app.
Then supply that service's origin and access code to the explicit journey:

```powershell
$env:HARNESS_GRILL_URL = 'http://127.0.0.1:8080' # or the upgraded production origin
$env:HARNESS_GRILL_CODE = '<configured four-digit code>'
npm run e2e:pi-grill:live
```

It runs both scopes, publishes a real round/image, verifies exact uploaded bytes, reviews
only queued answers, creates a delivery, waits for Pi's persisted receipt and server
acknowledgement, and removes only its UUID-owned sessions/publications/assets. Each success
uses five model requests; lifecycle commands and recovery create none. Credentials go only
to the explicitly selected hosted service and isolated child environment; inference remains
loopback-only with upstream forbidden. Run `npm run e2e:pi-grill -- --admission` against an
older service to verify rejection before inference without publishing remote data.

The actual local service/database/Storage gate passed on Windows with Pi 1.2.0. On 2026-10-14,
the migration and app were deployed and both live journeys passed against
`https://grill-me-in-cloud.vercel.app/`, with exactly five fake inference requests per scope.
Each verified the uploaded SVG bytes, queued-only answer effects, one persisted correlated
user message, confirmed server delivery, reload/fork/tree isolation and owned test cleanup.
These headless checks do not certify browser rendering, Pi TUI behavior or unscripted model
interview quality.

## Explicit subagent skills

`npm run e2e:subagents:skills` runs Claude Code and Codex headless CLI parents and children against the fake Anthropic/Responses APIs. `npm run e2e:pi-subagents:skills` installs the checkout runtime with the real catalogue installer and runs Pi JSON parents and children against the fake Responses API. All fixtures are external and upstream inference is forbidden.

Each provider covers omitted, available, and missing `skill` parameters. Available skills carry a fixture resource identity and cause a real tool to write a receipt; omitted skills have no loaded body. Missing skills persist a failed request, notify the parent, and start no child CLI. Claude/Codex successful launches also resume the saved child without re-invoking its skill. Pi expects 4/5/3 inference requests for omitted/found/missing respectively; the failure reaches its parent through both the write outcome and durable result delivery. These are checkout-runtime checks, independent of the shipped remote pin and VS Code/TUI acceptance.
