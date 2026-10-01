#!/usr/bin/env python3
"""Read-only cleanup inventory, injected only on explicit skill invocation."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tomllib


MAX_CHANGES = 50


class FactError(RuntimeError):
    pass


def command(cwd: Path, *args: str) -> str:
    result = subprocess.run(list(args), cwd=cwd, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=60,
                            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    if result.returncode:
        raise FactError(f"{' '.join(args[:3])}: {result.stderr.strip()}")
    return result.stdout


def iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def collect(cwd: Path, target: str | None = None) -> dict:
    root = Path(command(cwd, "git", "rev-parse", "--show-toplevel").strip())
    errors: list[str] = []

    def attempt(*args: str, directory: Path = root) -> str | None:
        try:
            return command(directory, *args)
        except (FactError, OSError, subprocess.TimeoutExpired) as error:
            errors.append(str(error))
            return None

    target_source = "invocation" if target else "remote-default"
    if not target:
        try:
            target = command(root, "git", "symbolic-ref", "refs/remotes/origin/HEAD").strip()
        except FactError:
            target_source = "conventional-fallback; confirm with project instructions"
            for candidate in ("main", "master"):
                try:
                    command(root, "git", "rev-parse", "--verify", candidate)
                    target = candidate
                    break
                except FactError:
                    pass
    if target:
        # Resolve once to make every comparison use the same observed snapshot.
        target_oid = attempt("git", "rev-parse", "--verify", f"{target}^{{commit}}")
        target_oid = target_oid.strip() if target_oid else None
    else:
        target_oid = None

    def comparison(ref: str, base: str | None) -> dict | None:
        if not base:
            return None
        counts = attempt("git", "rev-list", "--left-right", "--count", f"{base}...{ref}")
        if counts is None:
            return None
        behind, ahead = map(int, counts.split())
        return {"ahead": ahead, "behind": behind}

    worktrees = []
    raw_worktrees = command(root, "git", "worktree", "list", "--porcelain", "-z")
    for block in raw_worktrees.split("\0\0"):
        if not block.strip("\0"):
            continue
        fields = dict(item.partition(" ")[::2] for item in block.split("\0") if item)
        path = Path(fields["worktree"])
        record = {"path": str(path), "branch": fields.get("branch", "").removeprefix("refs/heads/") or None,
                  "head": fields.get("HEAD"), "detached": "detached" in fields,
                  "locked": fields.get("locked"), "prunable": fields.get("prunable"),
                  "exists": path.is_dir(), "changes": [], "latest_file_change": None,
                  "last_commit_at": None}
        if path.is_dir() and "bare" not in fields:
            last = attempt("git", "show", "-s", "--format=%cI", "HEAD", directory=path)
            record["last_commit_at"] = last.strip() if last else None
            status = attempt("git", "status", "--porcelain=v1", "-z", "--untracked-files=all", directory=path)
            pieces = iter((status or "").split("\0"))
            for item in pieces:
                if not item:
                    continue
                name = item[3:]
                change = {"path": name, "status": item[:2], "modified_at": None}
                if "R" in item[:2] or "C" in item[:2]:
                    change["original_path"] = next(pieces, "")
                try:
                    change["modified_at"] = iso((path / name).lstat().st_mtime)
                except OSError:
                    pass  # Deleted files have no remaining mtime.
                record["changes"].append(change)
            if len(record["changes"]) > MAX_CHANGES:
                # Keep the injected inventory bounded; the agent can list the rest with git status.
                record["changes_omitted"] = len(record["changes"]) - MAX_CHANGES
                del record["changes"][MAX_CHANGES:]
            paths = attempt("git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", directory=path)
            latest = None
            for name in set((paths or "").split("\0")) - {""}:
                try:
                    mtime = (path / name).lstat().st_mtime
                    latest = mtime if latest is None else max(latest, mtime)
                except OSError:
                    pass
            record["latest_file_change"] = iso(latest) if latest is not None else None
        worktrees.append(record)

    branches = []
    refs = command(root, "git", "for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(upstream)%00%(committerdate:iso-strict)", "refs/heads")
    for line in refs.splitlines():
        name, oid, upstream, committed = line.split("\0")
        branches.append({"name": name, "head": oid, "upstream": upstream or None,
                         "upstream_comparison": comparison(oid, upstream or None),
                         "target_comparison": comparison(oid, target_oid),
                         "last_commit_at": committed or None, "pull_requests": [],
                         "worktrees": [w["path"] for w in worktrees if w["branch"] == name]})

    repository = attempt("gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner")
    repository = repository.strip() if repository else None
    issues = []
    if repository:
        def pages(endpoint: str) -> list:
            raw = attempt("gh", "api", "--paginate", "--slurp", endpoint)
            if raw is None:
                return []
            try:
                return [item for page in json.loads(raw) for item in page]
            except (ValueError, TypeError):
                errors.append(f"Malformed GitHub response for {endpoint}")
                return []

        for pr in pages(f"repos/{repository}/pulls?state=all&per_page=100"):
            head = pr.get("head") or {}
            # A fork with the same branch name is not evidence about this local branch.
            if (head.get("repo") or {}).get("full_name") != repository:
                continue
            for branch in branches:
                if branch["name"] == head.get("ref"):
                    branch["pull_requests"].append({"number": pr["number"], "url": pr.get("html_url"),
                        "state": "MERGED" if pr.get("merged_at") else str(pr["state"]).upper(),
                        "draft": bool(pr.get("draft")), "head": head.get("sha"),
                        "base": (pr.get("base") or {}).get("ref")})
        issues = [{"number": issue["number"], "title": issue["title"], "url": issue.get("html_url")}
                  for issue in pages(f"repos/{repository}/issues?state=open&labels=%5BAI%5D-in-progress&per_page=100")
                  if "pull_request" not in issue]
    missing_trust = []
    trust_path = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "config.toml"
    try:
        config = tomllib.loads(trust_path.read_text(encoding="utf-8"))
        known = {os.path.normcase(str(Path(w["path"]).resolve())) for w in worktrees}
        for name, settings in config.get("projects", {}).items():
            path = Path(name)
            if isinstance(settings, dict) and settings.get("trust_level") == "trusted" and path.is_absolute() and not path.exists():
                missing_trust.append({"path": name, "config": str(trust_path),
                    "registered_worktree": os.path.normcase(str(path.resolve())) in known,
                    "association": "verify repository ownership before proposing removal"})
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as error:
        errors.append(f"Cannot read Codex trust entries: {error}")
    return {"repository": repository, "root": str(root), "target": target,
            "target_oid": target_oid, "target_source": target_source,
            "branches": branches, "worktrees": worktrees, "in_progress_issues": issues,
            "missing_trust_entries": missing_trust, "errors": errors,
            "collection_policy": "Read-only local snapshot; remote refs were not fetched. Missing facts require investigation, never deletion."}


def handle(payload: dict) -> dict | None:
    if payload.get("hook_event_name", "UserPromptSubmit") != "UserPromptSubmit":
        return None
    prompt = payload.get("prompt", "")
    if not isinstance(prompt, str):
        return None
    match = re.match(r"^\s*[/$]cleanup-git(?:\s+(.*))?\s*$", prompt, re.DOTALL)
    if not match:
        return None
    args = shlex.split(match.group(1) or "")
    target = args[args.index("--target") + 1] if "--target" in args else None
    facts = collect(Path(payload.get("cwd") or os.getcwd()), target)
    return {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": json.dumps(facts, ensure_ascii=False)}}


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        result = handle(payload) if isinstance(payload, dict) else None
        if result:
            print(json.dumps(result, ensure_ascii=False))
    except (ValueError, IndexError, OSError, FactError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
              "additionalContext": f"cleanup-git could not finish its read-only inventory: {error}. Gather missing facts before proposing actions."}}))


if __name__ == "__main__":
    main()
