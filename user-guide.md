Phase 0 — Install (2 min)
1. In this repo's terminal: code --install-extension dist\aboard-0.0.0.vsix
2. Reload VS Code when prompted.
Phase 1 — Sandbox setup (5 min, no tokens)
Do not e2e inside the aboard repo — it would pollute your real repo with test issues/PRs and merge hooks into its .claude/settings.json. In PowerShell:
mkdir C:\Users\emb\dev\aboard-e2e; cd C:\Users\emb\dev\aboard-e2e
git init -b main
Set-Content calc.py "def add(a, b):`n    return a + b"
Set-Content README.md "# aboard e2e sandbox"
git add -A; git commit -m "init"
gh repo create aboard-e2e --private --source=. --remote=origin --push
gh label create spec --color BFD4F2 --description "Implementation contract" --force
gh label create afk --color 0E8A16 --description "Agent may merge and close" --force
gh label create hitl --color D93F0B --description "Only a human may close" --force
code -n C:\Users\emb\dev\aboard-e2e
3. In the new window: trust the folder. Verify: the aboard icon is in the activity bar; Output panel → "aboard" channel shows the bridge bound to 127.0.0.1 on some port; a status-bar item shows bridge info. Verify the project tree is still clean — no .aboard/ directory exists before initialization.
Phase 2 — Scaffold (5 min, no tokens)
4. Open the aboard view. Expect a short description of the project and a single "Initialize" button (Command Palette equivalent: "Aboard: Initialize Project"). Expect an info message with created counts, and the view to switch to the ready state offering "Start Manager" and "Update Project Assets".
5. Verify in the sandbox:
- .claude\agents\ has brainstormer.md, implementer.md, reviewer.md, fixer.md (no explorer.md)
- .claude\hooks\, .claude\skills\ (7 skills), .mcp.json with ${ABOARD_BRIDGE_PORT} placeholders and no secrets
- .claude\settings.json contains hooks only — no permissions, no autoCompact keys (open it and look)
- .claude\settings.local.json contains "enabledMcpjsonServers": ["aboard"], so Claude never asks to approve the bridge MCP server
- .gitignore gained .aboard/runtime/ and .claude/settings.local.json; git status --porcelain does not list .aboard/ or the local settings file
- .aboard/ now exists and holds scaffold.json plus runtime/ — and no bridge token file
- On GitHub: a "Project TODO" issue exists with the (auto-created) todo label
6. Non-destructive merge test: add a marker line (e.g. <!-- my edit -->) to .claude\agents\implementer.md, then click the sync icon ("Update Project Assets") in the Fleet view's title bar. Expect: a warning, the file reported as preserved, and your marker still there. The sync icon stays available once agents are listed.
6b. State test: delete .aboard\ from the explorer. Expect: any live agent terminals close, the fleet empties, and the view returns to the presentation page with the "Initialize" button. Re-initialize before continuing.
7. Commit the scaffold: git add -A; git commit -m "aboard scaffold"; git push
Phase 3 — Bridge security probes (2 min, no tokens)
8. Get the port from Output → aboard or the status bar (the token lives in bridge.json under the extension's per-workspace storage, outside the project — do not paste it anywhere, including to me). Then:
curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:<port>/mcp      # expect 401
curl.exe -s -o NUL -w "%{http_code}" -H "Authorization: Bearer wrong" http://127.0.0.1:<port>/mcp   # expect 401
Test-NetConnection <your-LAN-IP-from-ipconfig> -Port <port>          # expect TcpTestSucceeded: False
Phase 4 — Manager smoke $ (5–10 min)
 9. Click "+ New Manager" in the Manager section above the fleet. On a fresh project it is the only launch button; no dialog should appear. Expect the one-time warning about permission prompts (workers aren't in bypass mode yet) — that's correct, acknowledge it. A Manager terminal opens and the launch buttons are replaced by a single Manager row in that section. The Fleet section below stays empty — it lists workers only, never the Manager.
10. If Claude Code asks to approve the aboard MCP server from .mcp.json → approve. (First launch may pause on trust/MCP notices.)
11. Verify: SessionStart briefing is injected (git branch, GitHub state, fleet, TODO pointer); the fleet tree shows the Manager.
12. Ask the Manager: "What's the project status?" → expect a briefing-based answer, possibly using aboard__list_agents / aboard__get_todo visibly as tool calls.
13. Close the Manager terminal (bin icon or terminal kill). Expect: the Manager row disappears entirely — no "completed" row — and the Manager section falls back to "Resume Previous Manager" above "+ New Manager". Click Resume → no dialog, the same session continues (check .aboard\runtime\manager.json session id is unchanged). Close it again and click "+ New Manager" → a fresh session id is recorded. Later, with workers still listed in the fleet, kill the Manager again and confirm the launch buttons still appear — they are tied to no Manager running, not to an empty fleet.
Phase 5 — Interception & interactive agents $ (10 min)
14. Now set the worker permission mode for unattended work: Settings (Ctrl+,) → search aboard → Workers: Permission Mode = bypass. (Before this, ask the Manager to implement something and watch it refuse or note the config; optional.)
15. In the Manager terminal, type: /brainstorm caching strategy → expected: the prompt never reaches the model; you see a short confirmation line; a brainstormer terminal opens and is focused; a tree node appears. Kill it after a moment (right-click node → Kill Agent) — don't run a full brainstorm, that burns money.
16. Back in the Manager, ask a real question ("what's running right now?"). Expected: the answer is preceded by deferred-notification context like "Since your last message: at HH:MM you started a brainstormer…".
17. Type /raw in the Manager terminal → raw terminal opens at an empty prompt; tree shows raw; status bar shows it as lease holder.
18. Lease refusal: with raw idle, ask the Manager: "Implement issue #1" → expect an immediate refusal naming the raw agent as lease holder (not a queue, not a wait). Kill the raw agent → lease clears in the status bar.
Phase 6 — The money test: afk issue end-to-end $ (10–20 min)
19. gh issue create --title "Add multiply function" --body "Add a \multiply(a, b)\` function to \`calc.py\` that returns a * b." --label afk`
20. Tell the Manager: "Implement issue #1." Watch:
- A worker terminal appears running claude --agent implementer --session-id … with the task as a CLI argument (issue body inline — nobody typed into a TUI)
- Tree: implementer running · lease holder; status bar shows lease holder
- Worker: branch → edit → commit → PR referencing Closes #1 → merges itself (afk) → stops
- While it runs: open calc.py, add a space, Ctrl+S → expect the lease warning notification
- Manager receives the result (blocking tool result or a drained notification with a timestamped "at HH:MM, worker finished" phrasing)
21. After: issue #1 is closed on GitHub, PR merged, lease released, tree node resolved, .aboard\runtime\fleet.json reflects it. Also confirm the reviewer did not run anywhere (autoReview ships as never).
Phase 7 — Typed failure & hitl path $ (10–15 min)
22. gh issue create --title "Add divide function" --body "Add a \divide(a, b)\` function to \`calc.py\` that raises ValueError when b is 0." --label hitl`
23. Ask the Manager to implement issue #2. Mid-run, right-click the worker → Kill Agent. Expect: typed failure reported as killed, lease released, Manager informed.
24. Ask the Manager to implement issue #2 again. Let it finish → PR opens, worker stops without merging (hitl).
Phase 8 — Review (opt-in, recommended) $
25. Command Palette → "Aboard: Review Pull Request" → enter the PR number → reviewer agent runs read-only → findings appear as PR review comments on GitHub lines.
26. In the Manager: "Send the review feedback back to the implementer." → it uses aboard__send_to_agent, resuming the same session; fixes land as a new commit on the PR.
27. Merge PR #2 by hand → issue #2 closes (that merge is the approval).
Phase 9 — Guards & restart (5 min, no tokens)
28. In the sandbox window: Terminal → New Terminal → run claude by hand. Expect: no briefing injection, no new fleet node, hooks silent. (It will adopt the sandbox's Manager-style CLAUDE.md — that's project-scoping, expected.) Exit it.
29. Developer: Reload Window → bridge rebinds → "Aboard: Resume Manager" resumes the same session; fleet state restored from .aboard\runtime\.
Phase 10 — Preset evaluation (spec open question #4)
30. Set aboard.manager.toolPreset = delegation-only, run "Aboard: New Manager", ask it to read calc.py. Expected: it has no Read tool and must delegate/decline. Form an opinion vs read-only — your preference closes open question #4.
What to report back to me
For each phase, one line: PASS or FAIL + step number. For any FAIL:
1. Exact step number and what you saw instead (exact text/screenshot of the terminal)
2. Output → aboard channel, last ~50 lines
3. .aboard\runtime\fleet.json contents — but never paste bridge.json or any token
4. GitHub state if relevant (gh issue list, PR state)
Plus four qualitative answers:
- (a) read-only vs delegation-only — which Manager preset felt right?
- (b) Any moment you felt you lost visibility or couldn't intervene?
- (c) Any unexpected permission prompts, TUI stalls, or garbled terminals?
- (d) Rough wall-clock time and feel of the afk run.
Cleanup when done: kill all agents from the tree, and optionally gh repo delete aboard-e2e --yes.
Known non-bugs (don't report): the permission warning firing once; MCP-server approval prompt in the Manager terminal; the aboard-repo window running its own bridge on a different port; a hand-started session adopting the sandbox CLAUDE.md persona.