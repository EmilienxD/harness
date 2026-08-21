#!/usr/bin/env python3
"""Native ChatGPT hooks for zero-model-call ``/commit``.

ChatGPT explicitly treats its transcript as an unstable hook interface.  This
adapter therefore records file deltas from lifecycle events under ``.git`` and
uses the existing commit tool's staging and message-generation core only after
the prompt hook sees ``/commit``.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import commit_core as core


core.HOST_CONFIG_DIR = ".codex"


def _repo_root(cwd: str) -> str | None:
    result = core.run(["git", "rev-parse", "--show-toplevel"], cwd)
    if result.returncode != 0 or not result.stdout.strip():
        return None
    return os.path.normpath(result.stdout.strip())


def _token(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()[:24]


def _session_dir(repo_root: str, session_id: str) -> Path:
    relative = f"harness/commit/sessions/{_token(session_id)}"
    result = core.run(["git", "rev-parse", "--git-path", relative], repo_root)
    raw = result.stdout.strip() if result.returncode == 0 else os.path.join(".git", relative)
    path = Path(raw)
    if not path.is_absolute():
        path = Path(repo_root) / path
    return path.resolve()


def _zpaths(result: Any) -> list[str]:
    if result.returncode != 0:
        return []
    return [p for p in result.stdout.split("\0") if p]


def _dirty_paths(repo_root: str) -> set[str]:
    paths: set[str] = set()
    commands = (
        ["git", "diff", "--name-only", "-z"],
        ["git", "diff", "--cached", "--name-only", "-z"],
        ["git", "ls-files", "--others", "--exclude-standard", "-z"],
    )
    for command in commands:
        paths.update(_zpaths(core.run(command, repo_root)))
    return {os.path.normpath(path) for path in paths}


def _fingerprint(repo_root: str, relative: str) -> list[Any]:
    path = Path(repo_root) / relative
    try:
        stat = path.lstat()
    except OSError:
        return ["missing"]
    if path.is_symlink():
        try:
            return ["symlink", os.readlink(path)]
        except OSError:
            return ["symlink", "unreadable"]
    if path.is_file():
        return ["file", stat.st_size, stat.st_mtime_ns]
    return ["other", stat.st_mode, stat.st_mtime_ns]


def _snapshot(repo_root: str) -> dict[str, Any]:
    head = core.run(["git", "rev-parse", "HEAD"], repo_root)
    return {
        "head": head.stdout.strip() if head.returncode == 0 else None,
        "paths": {
            path: _fingerprint(repo_root, path)
            for path in sorted(_dirty_paths(repo_root))
        },
    }


def _atomic_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _event_path(root: Path, category: str, identity: str) -> Path:
    stamp = f"{time.time_ns():020d}-{os.getpid()}-{_token(identity)}.json"
    return root / category / stamp


def _record_pre(payload: dict[str, Any], repo_root: str, root: Path) -> None:
    tool_id = str(payload.get("tool_use_id") or payload.get("turn_id") or time.time_ns())
    data = {
        "tool_use_id": tool_id,
        "at": time.time_ns(),
        "snapshot": _snapshot(repo_root),
    }
    _atomic_json(root / "pending" / f"{_token(tool_id)}.json", data)


def _clear_events(root: Path) -> None:
    # Other tools can be running concurrently. Their pending pre-snapshots are
    # still valid and must survive this tool establishing a new Git baseline.
    shutil.rmtree(root / "events", ignore_errors=True)


def _record_post(payload: dict[str, Any], repo_root: str, root: Path) -> None:
    tool_id = str(payload.get("tool_use_id") or payload.get("turn_id") or "unknown")
    pending = root / "pending" / f"{_token(tool_id)}.json"
    before_data = _read_json(pending)
    try:
        pending.unlink(missing_ok=True)
    except OSError:
        pass

    after = _snapshot(repo_root)
    before = before_data.get("snapshot") if before_data else None
    unresolved: list[str] = []
    paths: set[str] = set()

    if isinstance(before, dict) and isinstance(before.get("paths"), dict):
        before_paths = before["paths"]
        after_paths = after["paths"]
        paths = {
            path
            for path in set(before_paths) | set(after_paths)
            if before_paths.get(path) != after_paths.get(path)
        }
        if before.get("head") != after.get("head"):
            # A commit, reset, checkout, or rebase creates a new baseline.
            _clear_events(root)
    else:
        unresolved.append(
            f"{payload.get('tool_name', 'tool')} call {tool_id}: pre-tool snapshot unavailable"
        )

    if not paths and not unresolved:
        return

    tool_input = payload.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    event = {
        "at": time.time_ns(),
        "tool": str(payload.get("tool_name") or "tool"),
        "command": command if isinstance(command, str) else "",
        "paths": sorted(paths),
        "unresolved": unresolved,
    }
    _atomic_json(_event_path(root, "events", tool_id), event)


def _record_prompt(payload: dict[str, Any], root: Path) -> None:
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        return
    identity = str(payload.get("turn_id") or time.time_ns())
    _atomic_json(
        _event_path(root, "prompts", identity),
        {"at": time.time_ns(), "prompt": prompt},
    )


def _records(root: Path, category: str) -> list[dict[str, Any]]:
    directory = root / category
    if not directory.is_dir():
        return []
    out = [data for path in directory.glob("*.json") if (data := _read_json(path))]
    return sorted(out, key=lambda item: int(item.get("at") or 0))


def _scan(root: Path, repo_root: str) -> core.WriteScan | None:
    events = _records(root, "events")
    if not events:
        return None
    relative = []
    unresolved = []
    for event in events:
        relative.extend(p for p in event.get("paths", []) if isinstance(p, str))
        unresolved.extend(p for p in event.get("unresolved", []) if isinstance(p, str))
    absolute = []
    seen = set()
    for path in relative:
        value = core._abs(path, repo_root)
        if value not in seen:
            seen.add(value)
            absolute.append(value)
    paths, ignored = core.filter_ignored(absolute, repo_root)
    return core.WriteScan(
        paths=paths,
        outside=[],
        failed_paths=[],
        ignored=ignored,
        records=len(events),
        write_calls=len(events),
        unresolved=list(dict.fromkeys(unresolved)),
    )


def _synthetic_transcript(root: Path, repo_root: str) -> str:
    entries = []
    for prompt in _records(root, "prompts"):
        entries.append(
            (
                int(prompt.get("at") or 0),
                {"type": "user", "message": {"content": prompt.get("prompt", "")}},
            )
        )
    for event in _records(root, "events"):
        command = event.get("command") or "changed: " + ", ".join(event.get("paths", []))
        entries.append(
            (
                int(event.get("at") or 0),
                {
                    "type": "assistant",
                    "cwd": repo_root,
                    "message": {
                        "content": [
                            {
                                "type": "tool_use",
                                "id": f"chatgpt-{event.get('at', 0)}",
                                "name": "Bash" if event.get("tool") == "Bash" else "Update",
                                "input": {"command": command, "file_path": ""},
                            }
                        ]
                    },
                },
            )
        )
    handle, path = tempfile.mkstemp(prefix="harness-commit-context-", suffix=".jsonl")
    with os.fdopen(handle, "w", encoding="utf-8") as stream:
        for _, record in sorted(entries, key=lambda pair: pair[0]):
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
    return path


def _clear_session(root: Path) -> None:
    shutil.rmtree(root, ignore_errors=True)


def _handle_commit(
    payload: dict[str, Any], repo_root: str, root: Path, flags: core.Flags, message: str
) -> None:
    session_id = str(payload.get("session_id") or "unknown")
    scan = _scan(root, repo_root)
    transcript = _synthetic_transcript(root, repo_root)
    try:
        if flags.dry:
            core.finish(
                core.build_dry_run_report(
                    message, session_id, transcript, repo_root, scan, flags
                )
            )

        changed = core.changed_paths(scan)
        widened = ""
        if changed:
            add_result, targets = core.stage_paths(changed, repo_root)
            if add_result is None:
                core.finish(
                    "ChatGPT edited files this session, but none of them still "
                    "exist or are tracked -- nothing to stage."
                )
        else:
            add_result, targets = core.run(["git", "add", "-A"], repo_root), []
            if scan is not None and scan.unresolved:
                widened = (
                    f"; staged the whole tree -- {len(scan.unresolved)} tool "
                    "write(s) had no pre-tool snapshot"
                )

        if add_result.returncode != 0:
            core.finish(f"git add failed:\n{add_result.stderr}")

        scope = ["--", *targets] if targets and not core.in_merge(repo_root) else []
        staged = core.run(["git", "diff", "--cached", "--name-only", *scope], repo_root)
        if not staged.stdout.strip():
            core.finish("Nothing to commit -- working tree matches HEAD.")

        body = ""
        if flags.use_ai:
            try:
                ai = core.generate_commit_message(
                    repo_root, targets if scope else [], True, transcript, message
                )
            except core.AiError as exc:
                core.finish(
                    f"{exc}\n\n"
                    f"{len(staged.stdout.strip().splitlines())} file(s) are still staged -- "
                    "nothing was committed.\nRerun with an explicit message: /commit <message>"
                )
            message, body = ai.subject, ai.body

        commit_args = ["git", "commit", "-m", message]
        if body:
            commit_args += ["-m", body]
        commit_args += ["-m", f"ChatGPT-session: {session_id}", *scope]
        result = core.run(commit_args, repo_root)
        if result.returncode != 0:
            core.finish(f"git commit failed:\n{result.stderr}")

        sha = core.run(["git", "rev-parse", "--short", "HEAD"], repo_root).stdout.strip()
        count = len(staged.stdout.strip().splitlines())
        held_back = len(core.staged_elsewhere(targets, repo_root)) if scope else 0
        suffix = f", {held_back} left staged" if held_back else ""
        _clear_session(root)
        core.finish(f"Committed {sha} ({count} file(s){suffix}){widened}: {message}")
    finally:
        try:
            os.unlink(transcript)
        except OSError:
            pass


def main() -> None:
    core._force_utf8_output()
    payload = json.load(sys.stdin)
    cwd = str(payload.get("cwd") or ".")
    event = payload.get("hook_event_name")
    repo_root = _repo_root(cwd)

    if event == "UserPromptSubmit":
        prompt = str(payload.get("prompt") or "")
        match = core.COMMIT_PATTERN.match(prompt.strip())
        if match:
            flags, message = core.split_flags(match.group(1) or "")
            if not message and not flags.use_ai and not flags.dry:
                core.finish(
                    "Usage: /commit [--dry] [--ai] <message>\n"
                    "  --ai      generate the message from the staged diff "
                    "(makes <message> optional)\n"
                    "            any text after --ai becomes steering guidance"
                )
            if repo_root is None:
                core.finish("Not a git repository -- nothing to commit.")
            root = _session_dir(repo_root, str(payload.get("session_id") or "unknown"))
            _handle_commit(payload, repo_root, root, flags, message)
            return

        if repo_root is not None:
            root = _session_dir(repo_root, str(payload.get("session_id") or "unknown"))
            _record_prompt(payload, root)
        core.allow()

    if repo_root is None:
        core.allow()
    root = _session_dir(repo_root, str(payload.get("session_id") or "unknown"))
    if event == "PreToolUse":
        _record_pre(payload, repo_root, root)
    elif event == "PostToolUse":
        _record_post(payload, repo_root, root)
    core.allow()


if __name__ == "__main__":
    main()
