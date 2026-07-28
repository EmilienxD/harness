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
