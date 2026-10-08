# Subagents

## Use it

The `subagents` package delegates bounded work to separate, persistent Claude Code or Codex conversations. Install it on your agent platform, then invoke `/work-with-agent` in Claude Code or `$work-with-agent` in ChatGPT for general work. More focused skills are `explore-with-agent`, `prototype-with-agent`, `websearch-with-agent`, `brainstorm-with-agent`, `address-with-agent`, and `review-with-agent`. The package also provides `reply-to-agent` and `resume-agent`.

## What happens

Delegation defaults to `mode: auto`, which runs the child in the background. Ask for `mode: interactive` to work with the child in a visible terminal. Prototypes require interactive mode. You can request `provider: claude` or `provider: chatgpt` (`codex` is an alias). An interactive child uses `reply-to-agent` to return its result. `resume-agent` continues a child with its original provider, mode, directory, and conversation.

## Persistent commands

The package installs persistent session commands distinct from the catalogue installer:

```text
harness run --provider claude|chatgpt [initial prompt]
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
