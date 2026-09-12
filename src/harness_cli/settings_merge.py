"""Idempotent, reversible merging of settings fragments into settings.json.

The whole point of this module is that installing twice must be a no-op, and
uninstalling must remove exactly what installing added — nothing the user wrote
themselves. That means list entries need a stable identity: appending blindly
would duplicate hook entries and silently run every hook twice.
"""

from __future__ import annotations

import json
import shlex
from typing import Any

Json = Any


def identity(item: Json) -> tuple:
    """A stable key describing 'the same entry' across installs.

    Claude Code settings contain three shapes of list entry that matter:
    permission rule strings, hook matcher groups (`{matcher, hooks:[...]}`), and
    individual hook commands (`{type, command, args}`).
    """
    if isinstance(item, dict):
        if "hooks" in item:
            return ("matcher", item.get("matcher", ""))
        if "command" in item:
            args = item.get("args")
            if isinstance(args, list) and args:
                # Exec-form hook: the script and its arguments are the entry's
                # identity; which interpreter launches it (${PYTHON}) is a
                # property of the machine, re-resolved on every install. The
                # interpreter itself sits before the script in argv, under any
                # number of option flags the resolver happens to emit (`uv run
                # --no-project`, `uv run --managed-python`, a bare path), so
                # the identity must skip to the operands rather than key by
                # raw argv: two writes of one hook with a stale or revised
                # prefix are one hook, and keeping both would fire it twice.
                # Keying by script+args also survives an interpreter upgrade,
                # replacing the launch string in place instead of stacking.
                return ("command", item.get("type", "command"), _operand_tail(args))
            operands = _command_operand_tail(item["command"])
            if operands is not None:
                return ("command", item.get("type", "command"), operands)
            return ("command", item.get("type", "command"), item["command"])
        return ("obj", json.dumps(item, sort_keys=True))
    if isinstance(item, (list, dict)):
        return ("obj", json.dumps(item, sort_keys=True))
    return ("scalar", type(item).__name__, item)


def _operand_tail(args: list) -> tuple:
    """The hook's own argv: script path plus its arguments, launcher flags stripped.

    `${PYTHON}` expands to things like `uv run --no-project` (plus whatever
    flags that install's resolver emitted) or a bare interpreter path with
    no args at all. None of that identifies the hook — the script it runs
    does. Two writes of one hook may carry whatever launcher flags an older
    or newer resolver happened to emit (`--managed-python` vs
    `--no-managed-python` is the one a real settings file turned up), so
    `-`-prefixed tokens are dropped anywhere before the hook itself is
    identified: by the first token that ends in a script suffix (`.py`,
    `.sh`, …) or is a path. Everything from there on is the hook.
    """
    for i, arg in enumerate(args):
        a = str(arg)
        if a.endswith((".py", ".sh", ".js", ".ts", ".ps1", ".bash")) or "/" in a or "\\" in a:
            return tuple(args[i:])
    for i, arg in enumerate(args):
        if arg != "run" and not str(arg).startswith("-"):
            return tuple(args[i:])
    return tuple(args)


def _command_operand_tail(command) -> tuple | None:
    """Normalize a shell-form hook command around the script it launches.

    ChatGPT stores a hook's complete command in one string, so launcher flags,
    quoting, and absolute-versus-project-relative installation paths otherwise
    make successive spellings of the same hook look unrelated.  Only commands
    containing a recognizable script are folded; arbitrary shell commands keep
    their exact-string identity.
    """
    if not isinstance(command, str):
        return None
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        return None
    for i, token in enumerate(tokens):
        normalized = token.replace("\\", "/")
        if not normalized.lower().endswith((".py", ".sh", ".js", ".ts", ".ps1", ".bash")):
            continue
        for root in (".codex/hooks/", ".claude/hooks/"):
            marker = f"/{root}"
            if marker in normalized:
                normalized = root + normalized.rsplit(marker, 1)[1]
                break
        return (normalized, *tokens[i + 1 :])
    return None


def normalize_scope(matcher) -> tuple | None:
    """A hook group's matcher, folded to its semantic scope.

    A group with no `matcher` fires its hooks unconditionally — which is also
    exactly what an explicit `""` or `".*"` matcher does, so all spellings of
    match-everything share one scope. Returns None for things that aren't
    hook groups, so they fall back to plain identity below.
    """
    if not (isinstance(matcher, dict) and "hooks" in matcher):
        return None
    m = matcher.get("matcher", "")
    return ("matcher", "_any_" if m in ("", "*", ".*") else m)


def _is_group(item) -> bool:
    return isinstance(item, dict) and "hooks" in item


def _merge_lists(base: list, incoming: list, *, hook_event: bool | None = None) -> list:
    # A list whose items include hook groups (`{"hooks": [...]}`) is a hook
    # event's group list. Groups there key by *scope*, not exact identity:
    # any group whose scope matches the incoming group's — whether we
    # installed it or the user wrote it — is merged into, never duplicated.
    # Two groups with the same scope would both fire on the event, running
    # every hook present in both twice; folding every spelling of
    # match-everything ("", ".*", missing) into one canonical no-`matcher`
    # group keeps Claude Code firing each hook exactly once, which is the
    # only correct layout no matter who authored the file.
    #
    # `hook_event` is inherited from the parent recursion when that is known:
    # the `hooks` list *inside* a group holds commands, not groups, so its
    # own items never declare it — but commands there still key by operand
    # identity, and only at the group level does the scope pass apply.
    if hook_event is None:
        hook_event = any(_is_group(v) for v in (*base, *incoming))
    out = list(base)
    if hook_event and not any(_is_group(v) for v in (*base, *incoming)):
        # This is the command list inside one matcher group.  Older merging
        # could already have left two shell-form spellings of the same hook in
        # the base file.  Normalize the base itself so a reinstall heals that
        # state instead of merely updating one of the duplicate entries.
        deduped: list = []
        positions: dict[tuple, int] = {}
        for entry in out:
            key = identity(entry)
            if key in positions:
                deduped[positions[key]] = entry
            else:
                positions[key] = len(deduped)
                deduped.append(entry)
        out = deduped
    index = {normalize_scope(v) or identity(v): i for i, v in enumerate(out)}
    for item in incoming:
        key = normalize_scope(item) or identity(item)
        if key in index:
            existing = out[index[key]]
            if isinstance(existing, dict) and isinstance(item, dict):
                out[index[key]] = merge(existing, item, hook_event=hook_event)
            else:
                out[index[key]] = item
        else:
            index[key] = len(out)
            out.append(item)
    if hook_event:
        # Coalesce same-scope groups into their first sibling. A file can
        # already carry twins (e.g. one group written with an explicit ""
        # matcher, back when only exact identity matched) whose hooks would
        # otherwise keep firing once per group; folding them through merge
        # dedupes shared hooks by identity and keeps each group's own hooks.
        first: dict[tuple, int] = {}
        collapsed: list = []
        for group in out:
            scope = normalize_scope(group)
            if scope is None or scope not in first:
                if scope is not None:
                    first[scope] = len(collapsed)
                collapsed.append(group)
            else:
                collapsed[first[scope]] = merge(collapsed[first[scope]], group)
        out = [_flatten_group(v) if _is_group(v) else v for v in collapsed]
    return out


def _flatten_group(group: dict) -> dict:
    """Write a match-everything group's scope the canonical way: no `matcher` key."""
    if group.get("matcher") in ("", "*", ".*"):
        return {k: v for k, v in group.items() if k != "matcher"}
    return group


def merge(base: dict, fragment: dict, *, hook_event: bool | None = None) -> dict:
    """Deep-merge `fragment` into `base`, returning a new dict.

    Dicts recurse, lists merge by entry identity, scalars are overwritten.
    Hook-group lists merge by scope instead — see `_merge_lists`.
    """
    out = dict(base)
    for key, value in fragment.items():
        current = out.get(key)
        if key == "args" and isinstance(current, list) and isinstance(value, list):
            # A command's argv is positional and atomic — merging it element-
            # by-element would union two launcher prefixes ("--no-managed-
            # python" alongside "--managed-python") into nonsense argv. The
            # fragment is the fresher resolution of the same hook; it wins.
            out[key] = value
        elif isinstance(current, dict) and isinstance(value, dict):
            out[key] = merge(current, value)
        elif isinstance(current, list) and isinstance(value, list):
            out[key] = _merge_lists(current, value, hook_event=hook_event)
        else:
            out[key] = value
    return out


def _unmerge_lists(base: list, incoming: list) -> list:
    # The mirror image of `_merge_lists`. Where merging keyed hook groups by
    # scope, unmerging removes the incoming group's hooks from *every* base
    # group of the same scope — not just the exact-identity twin the fragment
    # was last seen in. A scope-collapsed merge can leave the same hook
    # identity in a user group and in one we wrote, and uninstall must back
    # both copies out or the hook stays wired after we promised to remove it.
    hook_event = any(_is_group(v) for v in (*base, *incoming))
    out = list(base)
    for item in incoming:
        scope = normalize_scope(item) if hook_event else None
        if scope is not None:
            for i in range(len(out) - 1, -1, -1):
                if normalize_scope(out[i]) != scope:
                    continue
                pruned = unmerge_group(out[i], item)
                if "hooks" in pruned:
                    out[i] = pruned
                else:
                    # A group whose hooks all belonged to us is ours to drop.
                    del out[i]
            continue
        key = identity(item)
        for i, existing in enumerate(out):
            if identity(existing) != key:
                continue
            if _is_group(existing) and _is_group(item):
                pruned = unmerge(existing, item)
                if not pruned.get("hooks"):
                    del out[i]
                else:
                    out[i] = pruned
            else:
                del out[i]
            break
    return out


def unmerge_group(existing: dict, fragment_group: dict) -> dict:
    """Prune one fragment group's hooks out of one existing group.

    Only the `hooks` list is touched: `matcher` (and anything else on the
    group) stays exactly as the user has it. Removal goes by hook identity,
    and every matching copy is removed — an existing file may carry the same
    hook more than once. A group left with no hooks fires nothing, so it is
    dropped by the caller.
    """
    keys = {identity(h) for h in fragment_group.get("hooks", [])}
    hooks = [h for h in existing.get("hooks", []) if identity(h) not in keys]
    out = dict(existing)
    if hooks:
        out["hooks"] = hooks
    else:
        out.pop("hooks", None)
    return out


def unmerge(base: dict, fragment: dict) -> dict:
    """Remove from `base` exactly what `merge(_, fragment)` would have added.

    Values the user has since changed are left alone: only entries that still
    match the fragment are removed. Containers left empty are pruned.
    """
    out = dict(base)
    for key, value in fragment.items():
        if key not in out:
            continue
        current = out[key]
        if isinstance(current, dict) and isinstance(value, dict):
            pruned = unmerge(current, value)
            if pruned:
                out[key] = pruned
            else:
                del out[key]
        elif isinstance(current, list) and isinstance(value, list):
            pruned_list = _unmerge_lists(current, value)
            if pruned_list:
                out[key] = pruned_list
            else:
                del out[key]
        elif current == value:
            del out[key]
    return out


def additions(base: dict, fragment: dict) -> dict:
    """Return only settings entries that merging ``fragment`` adds to ``base``.

    This is used for ownership receipts: an entry already present in the
    user's settings must not become Harness-owned merely because its spelling
    happens to equal our fragment.
    """
    out: dict = {}
    for key, value in fragment.items():
        if key not in base:
            out[key] = json.loads(json.dumps(value))
            continue
        current = base[key]
        if isinstance(current, dict) and isinstance(value, dict):
            child = additions(current, value)
        elif isinstance(current, list) and isinstance(value, list):
            child = _list_additions(current, value)
        elif current == value:
            child = None
        else:
            # Scalar replacement is intentionally recorded.  Unmerge will
            # leave it alone if the user subsequently edits the value.
            child = value
        if child not in (None, {}, []):
            out[key] = child
    return out


def remove_shared(fragment: dict, shared: list[dict]) -> dict:
    """Remove contributions also supplied by another installed package."""
    if not shared:
        return fragment
    out: dict = {}
    for key, value in fragment.items():
        peers = [item[key] for item in shared if key in item]
        if not peers:
            out[key] = value
            continue
        current = value
        if isinstance(current, dict) and all(isinstance(peer, dict) for peer in peers):
            child = remove_shared(current, peers)
        elif isinstance(current, list) and all(isinstance(peer, list) for peer in peers):
            child = _remove_shared_list(current, peers)
        elif any(current == peer for peer in peers):
            child = None
        else:
            child = current
        if child not in (None, {}, []):
            out[key] = child
    return out


def _remove_shared_list(base: list, peers: list[list]) -> list:
    all_peers = [item for peer in peers for item in peer]
    hook_event = any(_is_group(v) for v in (*base, *all_peers))
    if not hook_event:
        shared_ids = {identity(item) for item in all_peers}
        return [item for item in base if identity(item) not in shared_ids]
    out: list = []
    for group in base:
        scope = normalize_scope(group)
        if scope is None:
            if identity(group) not in {identity(item) for item in all_peers}:
                out.append(group)
            continue
        shared_hooks = {
            identity(hook)
            for peer in all_peers
            if normalize_scope(peer) == scope
            for hook in peer.get("hooks", [])
        }
        hooks = [hook for hook in group.get("hooks", []) if identity(hook) not in shared_hooks]
        if hooks:
            updated = dict(group)
            updated["hooks"] = hooks
            out.append(updated)
    return out


def _list_additions(base: list, incoming: list) -> list:
    hook_event = any(_is_group(v) for v in (*base, *incoming))
    if not hook_event:
        existing = {identity(item) for item in base}
        return [item for item in incoming if identity(item) not in existing]
    out: list = []
    for item in incoming:
        scope = normalize_scope(item)
        if scope is None:
            if identity(item) not in {identity(v) for v in base}:
                out.append(item)
            continue
        groups = [v for v in base if normalize_scope(v) == scope]
        existing_hooks = {
            identity(hook)
            for group in groups
            for hook in group.get("hooks", [])
        }
        hooks = [hook for hook in item.get("hooks", []) if identity(hook) not in existing_hooks]
        if hooks:
            group = dict(item)
            group["hooks"] = hooks
            out.append(group)
    return out


def dumps(settings: dict) -> str:
    return json.dumps(settings, indent=2, ensure_ascii=False) + "\n"
