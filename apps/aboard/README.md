# Aboard

Aboard is a VS Code extension for visible Claude Code and ChatGPT sessions. It keeps agent work in terminals the user can inspect, gives the user one place to track active and recent sessions, and runs issue-driven Auto Run workflows without hiding the work from the user.

Install it through the [Harness catalogue](../../README.md#installation) by selecting `aboard`. Harness verifies the VSIX and installs the worker assets Aboard needs.

## At a glance

```mermaid
flowchart LR
    U[The user] --> C[Commands and Aboard views]

    subgraph V[VS Code]
        C --> A[Aboard]
        A --> T[Visible agent terminals]
        A --> F[Agent Fleet]
        A --> R[Recent Activity]
        A --> Q[Auto Run]
        B[Authenticated loopback bridge] --> A
    end

    T --> P{Platform selected in<br/>.harness/launch.json}
    P --> CL[Claude Code]
    P --> CG[ChatGPT via Codex CLI]
    CL -->|Lifecycle events| B
    CG -->|Lifecycle events| B
    Q <--> G[Local Git checkout]
    Q <--> GH[GitHub issues and pull requests]
```

## Visible sessions

Initialize the project once, then use **Run Agent** to open an empty, attended terminal. The platform, model, and reasoning effort come from `.harness/launch.json`. Aboard reads that file for every new launch, resume, or reopen, so existing sessions keep their configuration while future sessions use the user's latest choices.

The Fleet shows live sessions. Recent Activity keeps completed work available for inspection and supported reopen flows.

```mermaid
flowchart TD
    L[Run Agent or manual delegation] --> S[Starting]
    S -->|Platform session starts| R[Running in a visible terminal]
    S -->|Launch fails| F[Failed]
    R -->|Agent needs interaction| W[Awaiting the user]
    W -->|The user continues in the terminal| R
    R -->|Process exits successfully| C[Completed]
    R -->|Process or policy failure| F
    C --> D{Record has useful<br/>session or outcome data?}
    F --> D
    D -->|Yes| A[Recent Activity]
    D -->|No, empty attended launch| Z[Remove from Fleet]

    A --> O{Conversation still available?}
    O -->|Yes, terminal still open| FT[Focus existing terminal]
    O -->|Yes, terminal ended| RL[Relaunch current platform<br/>and resume conversation]
    O -->|No| NR[Keep the activity record;<br/>reopen is unavailable]
    RL --> S
```

Interactive and manually delegated sessions inherit the user's native Claude Code or ChatGPT settings. Explore sessions are read-only. Auto Run workers use stricter, extension-owned Git and GitHub restrictions.

## Auto Run

Auto Run turns labelled GitHub issues into a visible, recoverable queue. Review the forecast in the panel or run `/auto --dry`; start from the panel or run `/auto` when the plan looks right.

```mermaid
flowchart TD
    I[Labelled GitHub issues] --> P[Inspect forecast and frozen issue order]
    P --> S[Create or prepare checkout<br/>and run branch]
    S --> E{Explore before fresh implementer?}
    E -->|Yes| X[Read-only Explore session]
    E -->|No| M{Issue disposition}
    X --> M

    M -->|AFK| AFK[Implementer must succeed with<br/>exactly one clean descendant commit]
    M -->|HITL| HITL[Implementer leaves changes uncommitted<br/>in its visible terminal]
    HITL --> U[The user inspects, continues, and commits<br/>the accepted clean range]
    AFK --> B{Branch mode}
    U --> B

    B -->|Per issue| IP[Push issue branch and open<br/>internal PR into run branch]
    B -->|Single branch| SP[Push run branch and create or update<br/>the cumulative run PR]
    IP --> RV{Review enabled?}
    SP --> RV
    RV -->|Yes| R[Reviewer makes no commit,<br/>or exactly one clean fix commit]
    RV -->|No| IN[Integrate accepted issue]
    R --> IN

    IN -->|Per issue| MP[Automatically merge internal PR<br/>and clean up issue branch]
    IN -->|Single branch| CP[Update cumulative PR<br/>and close accepted issue]
    MP --> PA{Pause after this<br/>HITL issue?}
    CP --> PA
    PA -->|Yes| RS[Stop at a recoverable checkpoint;<br/>Resume Auto Run to continue]
    PA -->|No| Q{More issues?}
    RS --> Q
    Q -->|Yes| E
    Q -->|No changes landed| D[Complete without a final PR]
    Q -->|Accepted work landed| PR[Open or finalize run PR<br/>into original target branch]
    PR --> AM{Automatic final merge enabled<br/>and safe?}
    AM -->|Yes| MG[Aboard merges final PR]
    AM -->|No| Y[Leave final PR open for the user]
```

- **HITL** leaves implementation work in a visible terminal and waits for one or more clean commits that the user accepts.
- **AFK** accepts only a successful worker result with exactly one clean descendant commit.
- Aboard owns branch changes, publication, integration, and GitHub mutations. Workers may inspect, edit, stage, and commit within their assigned checkout.

Stopping preserves recoverable state. Resume continues from recorded checkpoints. Discard follows the configured cleanup policy and never removes dirty or moved work it can no longer prove it owns.

## Configuration

| Location | Purpose |
| --- | --- |
| `.harness/launch.json` | Selects Claude Code or ChatGPT, command, model, and reasoning effort. |
| `.abd/settings.json` | Stores project-level Aboard settings. |
| VS Code settings | Supplies user and profile defaults under `aboard.*`. |

Non-launch settings resolve from VS Code workspace settings, then `.abd/settings.json`, then user or profile settings and defaults. Auto Run freezes run-specific settings for recovery; it reads launch configuration again whenever it starts or resumes an agent.

Worktree mode gives a run its own checkout. Aboard copies ignored local `.claude`, `.agents`, `.codex`, and `.abd` configuration without overwriting tracked files. Optional setup commands live in `.abd/session-setup.ps1` and `.abd/session-setup.sh`.

## Development

From `apps/aboard/`:

```powershell
npm ci
npm run check
npm test
npm run test:vscode
npm run package
```

Use `npm run test:integration` for unit and VS Code integration tests. `npm run e2e:full` runs the complete disposable real-CLI journey.

Aboard keeps its npm build and `aboard-v<version>` release history independent from the Python installer. The packaged VSIX includes this README and the extension runtime, never the Harness skill catalogue.
