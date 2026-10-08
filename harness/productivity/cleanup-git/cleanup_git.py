#!/usr/bin/env python3
"""Read-only Git cleanup facts for hooks and direct agent use."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tomllib
from urllib.parse import urlencode


class FactError(RuntimeError):
    def __init__(self, message: str, returncode: int | None = None):
        super().__init__(message)
        self.returncode = returncode


def command(cwd: Path, *args: str) -> str:
    result = subprocess.run(list(args), cwd=cwd, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=60,
                            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    if result.returncode:
        raise FactError(f"{' '.join(args[:3])}: {result.stderr.strip()}", result.returncode)
    return result.stdout


def iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def collect(cwd: Path | None = None) -> dict:
    cwd = cwd or Path.cwd()
    target = None
    github = shutil.which("gh") is not None
    bare = command(cwd, "git", "rev-parse", "--is-bare-repository").strip() == "true"
    root = Path(command(cwd, "git", "rev-parse", "--absolute-git-dir" if bare else "--show-toplevel").strip())
    common_dir = command(root, "git", "rev-parse", "--path-format=absolute", "--git-common-dir").strip()
    errors: list[str] = []

    def attempt(*args: str, directory: Path = root) -> str | None:
        try:
            return command(directory, *args)
        except (FactError, OSError, subprocess.TimeoutExpired) as error:
            errors.append(str(error))
            return None

    target_source = "remote-default"
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
        target_oid = attempt("git", "rev-parse", "--verify", "--end-of-options", f"{target}^{{commit}}")
        target_oid = target_oid.strip() if target_oid else None
    else:
        target_oid = None
    target_ref = attempt("git", "rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", target) if target_oid else None
    shallow = attempt("git", "rev-parse", "--is-shallow-repository")
    shallow = shallow.strip() == "true" if shallow is not None else None
    protected = {
        "main",
        "master",
        "develop",
        "development",
        "dev",
        "staging",
        "stage",
        "production",
        "prod",
        "release",
        "releases",
        "stable",
        "current",
        "trunk",
        "integration",
        "int",
        "preprod",
        "pre-production",
        "preproduction"
    }
    ref = (target_ref or "").strip()
    if ref.startswith("refs/heads/"):
        protected.add(ref.removeprefix("refs/heads/"))
    elif ref.startswith("refs/remotes/"):
        protected.add(ref.split("/", 3)[-1])
    policy_errors = []
    try:
        raw_policy = command(root, "git", "config", "--null", "--type=bool", "--get-regexp", r"^branch\..*\.deleteMerged$")
    except FactError as error:
        raw_policy = ""
        if error.returncode != 1:
            policy_errors.append(str(error))
            errors.append(str(error))
    retained = set()
    for setting in raw_policy.split("\0"):
        key, _, value = setting.partition("\n")
        if value == "false":
            retained.add(key.removeprefix("branch.").rsplit(".", 1)[0])

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
    registered = []
    for block in raw_worktrees.split("\0\0"):
        if not block.strip("\0"):
            continue
        fields = dict(item.partition(" ")[::2] for item in block.split("\0") if item)
        registered.append(fields)
    for position, fields in enumerate(registered):
        path = Path(fields["worktree"])
        record = {"path": str(path), "branch": fields.get("branch", "").removeprefix("refs/heads/") or None,
                  "head": fields.get("HEAD"), "detached": "detached" in fields,
                  "locked": "locked" in fields, "lock_reason": fields.get("locked"),
                  "prunable": "prunable" in fields, "prune_reason": fields.get("prunable"),
                  "bare": "bare" in fields, "main": position == 0,
                  "current": path.resolve() == root.resolve(),
                  "exists": path.is_dir(), "changes": [], "ignored": [], "operations": [],
                  "status_known": False, "clean": None, "has_submodules": None,
                  "errors": [], "latest_file_change": None, "last_commit_at": None}
        error_start = len(errors)
        identity = []
        if path.is_dir() and "bare" not in fields:
            identity_raw = attempt("git", "rev-parse", "--path-format=absolute", "--absolute-git-dir",
                                   "--git-common-dir", "--show-toplevel", directory=path)
            identity = identity_raw.splitlines() if identity_raw else []
            if len(identity) != 3 or Path(identity[1]).resolve() != Path(common_dir).resolve() or Path(identity[2]).resolve() != path.resolve():
                errors.append(f"Worktree identity does not match its registration: {path}")
                identity = []
        if identity:
            last = attempt("git", "show", "-s", "--format=%H%x00%cI", "HEAD", directory=path)
            if last:
                observed_head, committed = last.strip().split("\0")
                record["last_commit_at"] = committed
                if observed_head != record["head"]:
                    errors.append(f"Worktree HEAD changed during collection: {path}")
            status = attempt("git", "status", "--porcelain=v1", "-z", "--untracked-files=all",
                             "--ignored=matching", "--ignore-submodules=none", directory=path)
            record["status_known"] = status is not None
            pieces = iter((status or "").split("\0"))
            for item in pieces:
                if not item:
                    continue
                name = item[3:]
                if item[:2] == "!!":
                    record["ignored"].append({"path": name, "status": "!!"})
                    continue
                change = {"path": name, "status": item[:2], "modified_at": None}
                if "R" in item[:2] or "C" in item[:2]:
                    change["original_path"] = next(pieces, "")
                try:
                    change["modified_at"] = iso((path / name).lstat().st_mtime)
                except OSError:
                    pass  # Deleted files have no remaining mtime.
                record["changes"].append(change)
            record["clean"] = not bool(status) if status is not None else None
            # Only timestamp changed files; avoid scanning every tracked file.
            times = [change["modified_at"] for change in record["changes"] if change["modified_at"]]
            record["latest_file_change"] = max(times, default=None)
            markers = {"MERGE_HEAD": "merge", "CHERRY_PICK_HEAD": "cherry-pick",
                       "REVERT_HEAD": "revert", "rebase-merge": "rebase",
                       "rebase-apply": "rebase-or-am", "sequencer": "sequencer",
                       "BISECT_LOG": "bisect"}
            record["operations"] = [operation for marker, operation in markers.items()
                                    if (Path(identity[0]) / marker).exists()]
            index = attempt("git", "ls-files", "--stage", "-z", directory=path)
            record["has_submodules"] = any(entry.startswith("160000 ") for entry in index.split("\0")) if index is not None else None
        record["errors"] = errors[error_start:]
        blockers = []
        if record["current"]:
            blockers.append("current-worktree")
        if record["main"] and not record["current"]:
            blockers.append("main-worktree")
        if record["bare"]:
            blockers.append("bare")
        if record["detached"]:
            blockers.append("detached")
        if not record["exists"] or record["prunable"]:
            blockers.append("missing-or-prunable")
        if record["locked"]:
            blockers.append("locked")
        if not record["status_known"] or record["errors"]:
            blockers.append("inspection-failed")
        if record["changes"]:
            blockers.append("local-changes")
        if record["ignored"]:
            blockers.append("ignored-files")
        if record["operations"]:
            blockers.append("operation-in-progress")
        if record["has_submodules"]:
            blockers.append("submodules")
        record["removal_blockers"] = blockers
        for key in ("changes", "ignored"):
            record[f"{key}_count"] = len(record[key])
            record[f"{key}_omitted"] = 0
        worktrees.append(record)

    branches = []
    ref_args = ("git", "for-each-ref", "--format=%(refname:lstrip=2)%00%(objectname)%00%(upstream)%00%(committerdate:iso-strict)", "refs/heads")
    refs = command(root, *ref_args)
    ref_rows = [line.split("\0") for line in refs.splitlines()]
    for name, oid, upstream, committed in ref_rows:
        error_start = len(errors)
        branches.append({"name": name, "head": oid, "upstream": upstream or None,
                         "upstream_comparison": comparison(oid, upstream or None),
                         "target_comparison": comparison(oid, target_oid),
                         "last_commit_at": committed or None, "pull_requests": [],
                         "pr_status": "unknown" if github else "unavailable",
                         "errors": errors[error_start:],
                         "dependents": [row[0] for row in ref_rows if row[2] == f"refs/heads/{name}"],
                         "worktrees": [fields["worktree"] for fields in registered if fields.get("branch") == f"refs/heads/{name}"]})
    repository = attempt("gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner") if github else None
    repository = repository.strip() if repository else None
    issues = []
    if repository:
        def pages(endpoint: str) -> list:
            raw = attempt("gh", "api", "--paginate", "--slurp", endpoint)
            if raw is None:
                return []
            try:
                data = json.loads(raw)
                if not isinstance(data, list) or any(not isinstance(page, list) for page in data):
                    raise ValueError("Expected an array of pages")
                rows = [item for page in data for item in page]
                if any(not isinstance(item, dict) or "number" not in item or "state" not in item for item in rows):
                    raise ValueError("Expected GitHub records")
                return rows
            except (ValueError, TypeError):
                errors.append(f"Malformed GitHub response for {endpoint}")
                return []

        owner = repository.split("/", 1)[0]
        for branch in branches:
            error_start = len(errors)
            query = urlencode({"state": "all", "per_page": 100, "head": f"{owner}:{branch['name']}"})
            for pr in pages(f"repos/{repository}/pulls?{query}"):
                head = pr.get("head") or {}
                # A fork with the same branch name is not evidence about this branch.
                if (head.get("repo") or {}).get("full_name") != repository or head.get("ref") != branch["name"]:
                    continue
                base = pr.get("base") or {}
                branch["pull_requests"].append({"number": pr["number"], "url": pr.get("html_url"),
                    "state": "MERGED" if pr.get("merged_at") else str(pr["state"]).upper(),
                    "draft": bool(pr.get("draft")), "head": head.get("sha"), "base": base.get("ref"),
                    "base_repository": (base.get("repo") or {}).get("full_name"),
                    "local_head_matches": head.get("sha") == branch["head"]})
            branch["pr_status"] = "unknown" if len(errors) > error_start else "collected"
            branch["errors"].extend(errors[error_start:])
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
    for branch in branches:
        branch["merged_into_target"] = None
        if target_oid:
            try:
                command(root, "git", "merge-base", "--is-ancestor", branch["head"], target_oid)
                branch["merged_into_target"] = True
            except (FactError, OSError, subprocess.TimeoutExpired) as error:
                if isinstance(error, FactError) and error.returncode == 1:
                    branch["merged_into_target"] = False
                else:
                    branch["errors"].append(str(error))
                    errors.append(str(error))
        branch["protected"] = branch["name"] in protected | retained or branch["name"].startswith("release/")
        reasons = []
        if branch["protected"]:
            reasons.append("protected")
        if branch["dependents"]:
            reasons.append("dependent-branches")
        if branch["worktrees"]:
            reasons.append("checked-out")
        if any(pr["state"] == "OPEN" for pr in branch["pull_requests"]):
            reasons.append("open-pr")
        preserve = bool(reasons)
        if not target_oid:
            reasons.append("target-unresolved")
        if shallow is not False:
            reasons.append("shallow-or-unknown-history")
        if branch["errors"] or policy_errors:
            reasons.append("inspection-failed")
        if branch["merged_into_target"] is not True:
            reasons.append("merge-not-proven")
        branch["reasons"] = reasons
        branch["decision"] = "preserve" if preserve else "unresolved" if reasons else "eligible"
    final_refs = attempt(*ref_args)
    final_worktrees = attempt("git", "worktree", "list", "--porcelain", "-z")
    final_target = attempt("git", "rev-parse", "--verify", "--end-of-options", f"{target}^{{commit}}") if target_oid else None
    snapshot_consistent = (final_refs == refs and final_worktrees == raw_worktrees and
                           (not target_oid or final_target is not None and final_target.strip() == target_oid))
    if not snapshot_consistent:
        errors.append("Repository refs or worktree registrations changed during collection; refresh the inventory.")
        for branch in branches:
            branch["reasons"].append("snapshot-changed")
            if branch["decision"] == "eligible":
                branch["decision"] = "unresolved"
    return {"kind": "cleanup-git-inventory", "collected_at": datetime.now(timezone.utc).isoformat(),
            "snapshot_consistent": snapshot_consistent,
            "common_dir": common_dir,
            "shallow": shallow, "protected_patterns": ["release/*"],
            "github_status": ("collected" if repository and all(b["pr_status"] == "collected" for b in branches)
                              else "unknown") if github else "unavailable",
            "repository": repository, "root": str(root), "target": target,
            "target_oid": target_oid, "target_source": target_source,
            "branches": branches, "worktrees": worktrees, "in_progress_issues": issues,
            "missing_trust_entries": missing_trust, "errors": errors,
            "collection_policy": "Read-only local snapshot; remote refs were not fetched. Missing facts require investigation, never deletion."}


def render_inventory(facts: dict) -> str:
    """Render inventory types as TOON, with states in tables and keyed details."""
    def quoted(value: str) -> str:
        escapes = {"\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t"}
        return '"' + "".join(escapes.get(c, f"\\u{ord(c):04x}" if ord(c) < 32 else c)
                             for c in value) + '"'

    def scalar(value) -> str:
        if value is None:
            return "null"
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, int):
            return str(value)
        if not isinstance(value, str):
            raise TypeError(f"Unsupported inventory scalar: {type(value).__name__}")
        if (not value or value != value.strip() or value in {"true", "false", "null"}
                or value.startswith(("-", "#"))
                or re.fullmatch(r"[+-]?[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?", value, re.I)
                or any(c in ':"\\[]{},' or ord(c) < 32 for c in value)):
            return quoted(value)
        return value

    def key(value: str) -> str:
        return value if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", value) else quoted(value)

    def fields(value: dict, depth: int) -> list[str]:
        return [line for name, item in value.items() for line in field(key(name), item, depth)]

    def field(name: str, value, depth: int) -> list[str]:
        prefix = "  " * depth
        if isinstance(value, dict):
            return [f"{prefix}{name}:", *fields(value, depth + 1)]
        if not isinstance(value, list):
            return [f"{prefix}{name}: {scalar(value)}"]
        header = f"{prefix}{name}[{len(value)}]"
        if all(not isinstance(item, (dict, list)) for item in value):
            cells = ",".join(scalar(item) for item in value)
            return [header + ":" + (" " + cells if value else "")]
        columns = list(value[0]) if isinstance(value[0], dict) else []
        if columns and all(isinstance(item, dict) and item.keys() == value[0].keys()
                           and all(not isinstance(v, (dict, list)) for v in item.values()) for item in value):
            return [header + "{" + ",".join(key(c) for c in columns) + "}:",
                    *(prefix + "  " + ",".join(scalar(item[c]) for c in columns) for item in value)]
        lines = [header + ":"]
        for item in value:
            if isinstance(item, dict):
                entry = fields(item, depth + 2)
            elif isinstance(item, list):
                entry = field("", item, depth + 1)
            else:
                entry = [scalar(item)]
            if entry:
                entry[0] = prefix + "  - " + entry[0].lstrip()
                lines.extend(entry)
            else:
                lines.append(prefix + "  -")
        return lines

    output = {}
    for name, value in facts.items():
        if name == "kind":
            continue  # The title identifies the inventory.
        if name not in {"branches", "worktrees"} or not value:
            output[name] = value
            continue
        identity = "name" if name == "branches" else "path"
        nested = {k for record in value for k, v in record.items() if isinstance(v, (dict, list))}
        output[name] = [{k: v for k, v in record.items() if k not in nested} for record in value]
        if nested:
            output["branch_details" if name == "branches" else "worktree_details"] = [
                {identity: record[identity], **{k: v for k, v in record.items() if k in nested}}
                for record in value]
    return "# Git cleanup inventory\n" + "\n".join(fields(output, 0))


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")
    try:
        if len(sys.argv) > 1:
            raise FactError("This inventory script takes no arguments; run it from the repository.")
        print(render_inventory(collect()))
    except (ValueError, OSError, FactError, subprocess.TimeoutExpired) as error:
        print(render_inventory({"error": str(error)}), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
