# Subagents

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install subagents`; see [installation and scope](../../getting-started.md).

## Use it

The `subagents` package delegates bounded work to separate, persistent Claude Code, Codex, or Pi conversations. Install it on your agent platform, then invoke `/work-with-agent` in Claude Code or `$work-with-agent` in ChatGPT for general work. More focused skills are `explore-with-agent`, `prototype-with-agent`, `websearch-with-agent`, `brainstorm-with-agent`, `address-with-agent`, and `review-with-agent`. The package also provides `reply-to-agent` and `resume-agent`.

## What happens

Delegation defaults to `mode: auto`, which runs the child in the background. Ask for `mode: interactive` to work with the child in a visible terminal. Prototypes require interactive mode. You can request `provider: claude`, `provider: chatgpt` (`codex` is an alias), or `provider: pi`. On Pi, invoke `/skill:work-with-agent` or another installed launcher skill. An interactive child uses `reply-to-agent` to return its result. `resume-agent` continues a child with its original provider, mode, directory, and conversation.

Delegated launch and resume prompts preserve skill invocations while neutralizing native CLI commands such as `/resume` by removing their slash prefix. Harness and Aboard use shared provider command lists and matching rules, including for direct Aboard bridge requests. Task-selected skills are added separately after sanitization.

## Persistent commands

The package installs persistent session commands distinct from the catalogue installer:

```text
harness run --provider claude|chatgpt|pi [initial prompt]
harness ask <session-id>
harness reply
harness resume <session-id|agent-i> [next message...]
harness watch [session-id|agent-i] [--once]
```

`run` opens an independent visible terminal. `ask` processes a parent's delegation inbox; `reply` arms an interactive child's next successful stop to return its result. `watch` follows a background child's recorded progress, while `--once` prints the progress recorded so far. Inside a parent, `agent-i` identifies a child.

## Configuration and troubleshooting

Configure launches in project `.harness/config.json` or user `~/.harness/config.json`. The first existing file wins; they are not merged. A minimal file is `{ "version": 1 }`. For example:

```json
{
  "version": 1,
  "autoRun": { "provider": "chatgpt" },
  "providers": {
    "chatgpt": {
      "delegations": { "explore": { "model": "gpt-5.6-luna", "effort": "low" } }
    }
  }
}
```

`autoRun.provider` defaults to Claude and does not restrict explicit `harness run --provider` choices. Provider entries can set a `command` and separate `explore`, `prototype`, `websearch`, `brainstorm`, `address`, `review`, and `general` profiles. Profiles accept `model` and `effort`; `"inherit"` uses native settings. Claude profiles other than `explore` can also set `deniedTools`. `session.stopWaitHours` sets an optional nonnegative wait for an outstanding reply. Session requests and logs live under `~/.harness/runtime/`; set `HARNESS_STATE_DIR` to change the Harness state root. If delegation says its hook did not provide the shared inbox, check that the package's provider hook is installed and active before retrying.

## Implementation and verification

`subagents` 2.10.0 (runtime 2.10.0) adds Pi as a provider of the existing Python runtime rather
than a second orchestrator. Requests, executions, process supervision, delivery claims and replay
stay in the shared SQLite state; a native extension translates Pi events into versioned
`harness-subagents-hook --pi` operations through `pi-transport` 1.1.0's bounded `requestCommand`.
The uv-installed entry point keeps the runtime's PyYAML dependency in its managed environment.

Children launch through the CLI process boundary, never the SDK: automatic work runs
`pi --mode json`, interactive work the terminal UI. Harness assigns the native ID with
`--session-id` for new sessions and continuations, and `--fork <id> --session-id <new>` when the
original session is still live, so resume never depends on the extension having loaded. Child
skills start as `/skill:<name> <prompt>` because Pi reads the skill name up to the first space.
The supervisor binds the JSON session header and decides success from Pi's events, because the
exit status ignores failed responses: the run must reach `agent_settled` unaborted, and the last
assistant message must end without `error`, `aborted` or `length` and contain text. Pi's
`--model` searches its whole catalogue, including unauthenticated providers, so a bare `haiku`
selected a Bedrock alias in manual testing. The runtime lists authenticated models with
`--list-models`, applies Pi's exact-then-alias matching, and launches the qualified
`provider/model`; unavailable or ambiguous models fail before launch. Effort maps to `--thinking`. Pi has no universal exploration model, so
`explore` keeps the native model at low thinking. RPC, run pools and the SDK were rejected:
a JSON run already matches the one-request child lifecycle, and live steering is not required.

Parent wake-up replaces the Claude/Codex Stop-hook wait. The runtime touches a per-parent
`results-ready` marker whenever a request settles; the extension stats it every 500 ms and rechecks
the database every 30 seconds. A terminal-UI or RPC parent delivers each claimed batch with
`pi.sendMessage`: idle parents start a turn, busy parents receive it as steering before their next
model call, matching PostToolUse delivery. A JSON or print parent, including an automatic child
that delegated further, waits in `agent_before_settle` and continues once with the result entry.
A delivery is acknowledged only after its `custom_message` entry carrying the delivery ID is
persisted; replay after reload or restart acknowledges an already persisted batch without
resending it. Delivery is session-wide rather than branch-bound, as with Claude/Codex rewinds,
so tree navigation cannot strand a child result.

Other boundaries: one stable `harness-subagents` system-prompt section carries the inbox, preserving
prompt caching and surviving compaction. Delegation skills receive their instructions by input
transformation. Successful native `write`/`edit` results inside the inbox, including nested calls,
launch requests and append the launch status. `/reply-to-agent-with-previous-message` and its
`/skill:` spelling send the latest successful assistant text on the active branch without inference.
Interactive children report at `agent_settled`; a new prompt or failed turn expires an armed reply,
and quitting cancels an unanswered request. In-process `/new` and `/fork` sessions become unrelated
conversations. Loop implementers are rejected for Pi. Aboard accepts Pi delegations through its
native adapter and shared durable runtime. Headless children load project extensions only in trusted projects, so nested
delegation from automatic children needs project trust or a user-scope installation.

`npm run test:pi-subagents` installs the real catalogue package with `--local` (the checkout runtime
as a uv tool) and drives real Pi 1.2.0 on Windows against the fake Responses endpoint. A JSON parent
launches an automatic Pi child, waits before settlement and integrates its answer; an RPC parent
launches an interactive child, opened as an RPC session through a visible-terminal stand-in, whose
previous-message reply makes zero inference requests and starts the idle parent's next turn. Both
assert exact request counts, durable request state, acknowledged session-persisted delivery, native
session files and emptied inboxes. Unit tests cover argument construction, JSON success semantics
through a real supervisor run, discovery roots, bridge operations, delivery replay and the Aboard
payload. The Pi TUI itself, POSIX, Claude/Codex parents with Pi children through real CLIs, and
busy-parent steering are outside this gate.

## Remaining integration limits

Pi context-usage telemetry remains unimplemented rather than estimated. Ordinary launch/reply/resume support does not enable Pi loop implementers for [ship](../workflows/ship.md#pi-status). Inline `@path` text in a delegated prompt is not a universal attachment guarantee: the [file-mentions](file-mentions.md) extension handles Pi user input when installed, and required context must otherwise be read or attached explicitly.

Checkout-runtime acceptance and immutable remote pins are separate. The existing native npm packaging checks recorded four shipped-pin journeys requiring the runtime changes from local commit `ba136dd`; rebuilding the extension archive does not itself publish that runtime. Keep remote-install claims scoped to the pin actually tested.
