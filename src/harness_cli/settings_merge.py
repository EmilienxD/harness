"""Idempotent, reversible merging of settings fragments into settings.json.

The whole point of this module is that installing twice must be a no-op, and
uninstalling must remove exactly what installing added — nothing the user wrote
themselves. That means list entries need a stable identity: appending blindly
would duplicate hook entries and silently run every hook twice.
"""

from __future__ import annotations

import json
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
                # property of the machine, re-resolved on every install. Keying
                # by args means an upgrade replaces the interpreter string in
                # place instead of stacking a duplicate hook, and uninstall
                # removes the entry even if the resolution drifted since.
                return ("command", item.get("type", "command"), tuple(args))
            return ("command", item.get("type", "command"), item["command"])
        return ("obj", json.dumps(item, sort_keys=True))
    if isinstance(item, (list, dict)):
        return ("obj", json.dumps(item, sort_keys=True))
    return ("scalar", type(item).__name__, item)


def _merge_lists(base: list, incoming: list) -> list:
    out = list(base)
    index = {identity(v): i for i, v in enumerate(out)}
    for item in incoming:
        key = identity(item)
        if key in index:
            existing = out[index[key]]
            if isinstance(existing, dict) and isinstance(item, dict):
                out[index[key]] = merge(existing, item)
            else:
                out[index[key]] = item
        else:
            index[key] = len(out)
            out.append(item)
    return out


def merge(base: dict, fragment: dict) -> dict:
    """Deep-merge `fragment` into `base`, returning a new dict.

    Dicts recurse, lists merge by entry identity, scalars are overwritten.
    """
    out = dict(base)
    for key, value in fragment.items():
        current = out.get(key)
        if isinstance(current, dict) and isinstance(value, dict):
            out[key] = merge(current, value)
        elif isinstance(current, list) and isinstance(value, list):
            out[key] = _merge_lists(current, value)
        else:
            out[key] = value
    return out


def _unmerge_lists(base: list, incoming: list) -> list:
    out = list(base)
    for item in incoming:
        key = identity(item)
        for i, existing in enumerate(out):
            if identity(existing) != key:
                continue
            if isinstance(existing, dict) and isinstance(item, dict) and "hooks" in item:
                pruned = unmerge(existing, item)
                # A matcher group whose hooks all belonged to us is ours to drop.
                if not pruned.get("hooks"):
                    del out[i]
                else:
                    out[i] = pruned
            else:
                del out[i]
            break
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


def dumps(settings: dict) -> str:
    return json.dumps(settings, indent=2, ensure_ascii=False) + "\n"
