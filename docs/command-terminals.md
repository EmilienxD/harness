# Command terminals

The bridge exposes one surface that has nothing to do with agents: an automated
script asks aboard to run a shell command, and the extension opens a real VS Code
terminal for it so the output is visible where the user already watches
everything else.

This is for scripts; a project's own setup command, a backend or frontend
bootstrap, a task runner in another repository. A command terminal is not an
aboard agent: it gets no fleet row, no write lease, no `ABOARD_*` credentials, no
resume, and it never appears in the fleet view. The endpoint is published only
while the project is initialized. Deleting `.abd/` removes the endpoint and
turns this surface off with the rest of aboard.

## Endpoints

All requests go to the loopback bridge and carry the bearer token
(`Authorization: Bearer <token>`), like every other bridge route.

| Method | Path | Purpose |
| :-- | :-- | :-- |
| `POST` | `/commands` | Open a terminal and run a command in it |
| `GET` | `/commands` | List command terminals from this activation |
| `GET` | `/commands/<id>` | One terminal's state |
| `POST` | `/commands/<id>/show` | Reveal the terminal again |
| `DELETE` | `/commands/<id>` | Close the terminal |

### `POST /commands`

```json
{
  "command": "npm install && npm run dev",
  "name": "backend",
  "cwd": "C:\\work\\project\\backend",
  "env": { "PORT": "8080" },
  "show": true
}
```

- `command` (required); one shell command line, sent to the terminal as typed
  input. A terminal receives one line, so newlines and other control characters
  are rejected rather than escaped; chain steps with your own shell's operator.
  It runs in VS Code's default shell for the platform.
- `name`; the terminal tab's label. Defaults to `aboard: command`.
- `cwd`; defaults to the workspace root. A directory that does not exist is a
  `400`, not a terminal that opens and immediately fails.
- `env`; extra string environment on top of the one VS Code gives terminals.
- `show`; reveal the terminal. Defaults to `true`; pass `false` for a background
  step that should not steal focus.

`201` returns the terminal's record:

```json
{
  "commandTerminalId": "0f8c…",
  "name": "backend",
  "command": "npm install && npm run dev",
  "cwd": "C:\\work\\project\\backend",
  "status": "open",
  "createdAt": "2026-08-22T09:00:00.000Z",
  "closedAt": null,
  "exitCode": null
}
```

`status` becomes `closed` with the shell's `exitCode` when the terminal itself
closes. Because the command is typed into a shell rather than spawned, aboard
observes the terminal's lifetime, not the command's: a command that finishes
inside a shell that stays open leaves the record `open`. Poll `GET /commands/<id>`
for that, or have the command signal its own completion.

Errors follow the bridge's usual shape: `400 invalid-request` for a malformed
body or an unusable directory, `404 not-found` for an unknown id, and
`409 terminal-closed` for control of a terminal that has closed.

## Finding the endpoint

Every open aboard window publishes a small record naming its port and a
**command-scoped token**. The records live in one per-user directory, outside
every workspace:

| Platform | Directory |
| :-- | :-- |
| Windows | `%LOCALAPPDATA%\abd\endpoints` |
| macOS | `~/Library/Application Support/abd/endpoints` |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/abd/endpoints` |

Each file is one window:

```json
{
  "version": 1,
  "host": "127.0.0.1",
  "port": 4823,
  "workspaceRoot": "C:\\work\\project",
  "commandToken": "…",
  "pid": 21714,
  "activatedAt": "2026-08-22T09:00:00.000Z"
}
```

The reader's whole job is: read every `*.json` in the directory, and keep the
record whose `workspaceRoot` contains your working directory. File names are an
implementation detail; never parse them, and never try to reproduce them.

```bash
dir="${LOCALAPPDATA:+$LOCALAPPDATA/abd/endpoints}"
dir="${dir:-${XDG_STATE_HOME:-$HOME/.local/state}/abd/endpoints}"
record=$(grep -l -F "$(pwd)" "$dir"/*.json | head -1)   # or match properly in your language
port=$(node -p "require('$record').port")
token=$(node -p "require('$record').commandToken")

curl -fsS "http://127.0.0.1:$port/commands" \
  -H "authorization: Bearer $token" \
  -H "content-type: application/json" \
  -d '{"command":"npm install","name":"backend"}'
```

Notes for a robust reader:

- **Match, don't assume.** More than one window can be open. Compare
  `workspaceRoot` against your own directory (case-insensitively on Windows) and
  walk up if you start in a subdirectory.
- **A record can be stale.** A window that crashed leaves one behind; `pid` tells
  you whether that extension host still exists, and the next activation prunes
  dead records. A `401` also means stale; the token is new on every activation,
  so re-read the file rather than caching the value.
- **No record means no window.** aboard writes one only while a window is open on
  that project. Fall back to running the command yourself.

Processes aboard launched itself do not need any of this: they inherit
`ABOARD_BRIDGE_PORT` and `ABOARD_BRIDGE_TOKEN`. Another VS Code extension can read
`commandEndpointDirectory` from aboard's exported API.

## Security

The bridge mints two per-activation credentials:

- The **full token** reaches every route. It stays in memory and in the
  environment of processes aboard started; only ephemeral MCP configurations
  for catalog-owning roles contain resolved copies while initialized. It is not published.
- The **command token** reaches `/commands` and nothing else; a request to any
  other path is `403 forbidden`. This is the one that gets published, because a
  credential a script can find is a credential anything running as that user can
  find. Scoping it means what finds it can run a command in a visible terminal;
  it cannot create agents, drive the Manager, or read fleet, session, or hook
  state.

That capability is still "run a shell command as the user", which is what the
endpoint is for and what anything already running as that user could do anyway.
The record is written `0600` in a per-user directory, never inside a workspace,
and is removed when the window closes.
