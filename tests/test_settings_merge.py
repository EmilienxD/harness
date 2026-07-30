from harness_cli.settings_merge import merge, unmerge


def hook(command, *args):
    return {"type": "command", "command": command, "args": list(args)}


def group(*hooks, matcher=None):
    entry = {"hooks": list(hooks)}
    if matcher is not None:
        entry["matcher"] = matcher
    return entry


COMMIT = {"hooks": {"UserPromptSubmit": [group(hook("python", "/x/commit.py"))]}}
PUBLISH = {"hooks": {"UserPromptSubmit": [group(hook("python", "/x/publish.py"))]}}


def test_merge_into_empty():
    assert merge({}, COMMIT) == COMMIT


def test_merge_is_idempotent():
    once = merge({}, COMMIT)
    assert merge(once, COMMIT) == once


def test_merge_stacks_two_tools_in_one_group():
    both = merge(merge({}, COMMIT), PUBLISH)
    entries = both["hooks"]["UserPromptSubmit"]
    assert len(entries) == 1
    assert len(entries[0]["hooks"]) == 2


def test_merge_keeps_user_hooks_and_other_keys():
    user = {
        "model": "opus",
        "hooks": {"UserPromptSubmit": [group(hook("bash", "/mine.sh"))]},
        "permissions": {"allow": ["Bash(ls:*)"]},
    }
    merged = merge(user, COMMIT)
    assert merged["model"] == "opus"
    assert merged["permissions"]["allow"] == ["Bash(ls:*)"]
    commands = [h["args"][0] for h in merged["hooks"]["UserPromptSubmit"][0]["hooks"]]
    assert commands == ["/mine.sh", "/x/commit.py"]


def test_different_matchers_stay_separate():
    a = {"hooks": {"PreToolUse": [group(hook("x"), matcher="Bash")]}}
    b = {"hooks": {"PreToolUse": [group(hook("y"), matcher="Write")]}}
    merged = merge(a, b)
    assert len(merged["hooks"]["PreToolUse"]) == 2


def test_permission_strings_dedupe():
    base = {"permissions": {"allow": ["Bash(ls:*)"]}}
    merged = merge(base, {"permissions": {"allow": ["Bash(ls:*)", "Bash(gh:*)"]}})
    assert merged["permissions"]["allow"] == ["Bash(ls:*)", "Bash(gh:*)"]


def test_scalars_are_overwritten():
    assert merge({"model": "sonnet"}, {"model": "opus"}) == {"model": "opus"}


def test_unmerge_is_inverse_of_merge():
    base = {"model": "opus", "hooks": {"UserPromptSubmit": [group(hook("bash", "/mine.sh"))]}}
    assert unmerge(merge(base, COMMIT), COMMIT) == base


def test_unmerge_from_empty_base_leaves_nothing():
    assert unmerge(merge({}, COMMIT), COMMIT) == {}


def test_unmerge_only_removes_own_entries():
    stacked = merge(merge({}, COMMIT), PUBLISH)
    remaining = unmerge(stacked, COMMIT)
    assert remaining == PUBLISH


def test_unmerge_ignores_absent_fragment():
    base = {"model": "opus"}
    assert unmerge(base, COMMIT) == base


def test_unmerge_leaves_user_edited_values_alone():
    merged = merge({}, {"model": "opus"})
    merged["model"] = "sonnet"
    assert unmerge(merged, {"model": "opus"}) == {"model": "sonnet"}


def test_reinstall_with_reresolved_interpreter_replaces_in_place():
    # The installer resolved ${PYTHON} to a bare name for an existing install
    # but to an absolute path now: same hook, new command. It must replace the
    # old entry, not stack a second one.
    old = merge({}, {"hooks": {"PreToolUse": [group(hook("python3", "/x/h.py"), matcher="Edit")]}})
    fragment = {"hooks": {"PreToolUse": [group(hook("/usr/bin/python3", "/x/h.py"), matcher="Edit")]}}
    merged = merge(old, fragment)
    assert merged["hooks"]["PreToolUse"][0]["hooks"] == [hook("/usr/bin/python3", "/x/h.py")]


def test_unmerge_matches_hook_despite_interpreter_drift():
    # Resolution can differ between install and uninstall (PATH changed,
    # interpreter removed); the entry the installer wrote is still its own.
    installed = merge({}, {"hooks": {"PreToolUse": [group(hook("/usr/bin/python3", "/x/h.py"), matcher="Edit")]}})
    fragment = {"hooks": {"PreToolUse": [group(hook("python3", "/x/h.py"), matcher="Edit")]}}
    assert unmerge(installed, fragment) == {}


def test_exec_hooks_with_different_args_still_stack():
    merged = merge(
        {"hooks": {"PreToolUse": [group(hook("python", "/x/a.py"), matcher="Edit")]}},
        {"hooks": {"PreToolUse": [group(hook("python", "/x/b.py"), matcher="Edit")]}},
    )
    assert len(merged["hooks"]["PreToolUse"][0]["hooks"]) == 2


def test_empty_args_commands_are_identified_by_command():
    a = {"hooks": {"PreToolUse": [group(hook("make lint"), matcher="Edit")]}}
    b = {"hooks": {"PreToolUse": [group(hook("make test"), matcher="Edit")]}}
    merged = merge(a, b)
    assert len(merged["hooks"]["PreToolUse"][0]["hooks"]) == 2
