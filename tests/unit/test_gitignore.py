from harness_cli import gitignore

PATTERNS = [".claude/commit-ai.key", ".claude/settings.local.json"]


def test_apply_appends_a_fenced_block():
    out = gitignore.apply("", "commit", PATTERNS)
    assert out.startswith("# >>> harness:commit >>>")
    assert out.endswith("# <<< harness:commit <<<\n")
    assert ".claude/commit-ai.key" in gitignore.existing_patterns(out)


def test_apply_is_idempotent():
    once = gitignore.apply("*.pyc\n", "commit", PATTERNS)
    assert gitignore.apply(once, "commit", PATTERNS) == once


def test_block_patterns_returns_only_patterns_from_the_named_complete_block():
    text = gitignore.apply("own-rule\n", "commit", PATTERNS)
    assert gitignore.block_patterns(text, "commit") == PATTERNS
    assert gitignore.block_patterns(text, "other") == []
    assert gitignore.block_patterns("# >>> harness:commit >>>\npartial\n", "commit") == []


def test_apply_keeps_a_separating_blank_line():
    out = gitignore.apply("*.pyc\n", "commit", PATTERNS)
    assert out.splitlines()[:2] == ["*.pyc", ""]


def test_remove_restores_the_original_text():
    before = "*.pyc\nbuild/\n"
    assert gitignore.remove(gitignore.apply(before, "commit", PATTERNS), "commit") == before


def test_remove_of_an_absent_block_changes_nothing():
    assert gitignore.remove("*.pyc\n", "commit") == "*.pyc\n"


def test_a_pattern_the_user_already_had_is_not_duplicated():
    before = ".claude/commit-ai.key\n"
    out = gitignore.apply(before, "commit", PATTERNS)
    assert out.count(".claude/commit-ai.key") == 1
    # And since we never owned their line, uninstalling must not take it away.
    assert ".claude/commit-ai.key" in gitignore.remove(out, "commit")


def test_all_patterns_already_present_writes_no_block():
    before = "".join(f"{p}\n" for p in PATTERNS)
    assert gitignore.apply(before, "commit", PATTERNS) == before


def test_two_tools_coexist():
    out = gitignore.apply(gitignore.apply("", "commit", ["a.key"]), "other", ["b.key"])
    assert gitignore.existing_patterns(out) == {"a.key", "b.key"}
    assert gitignore.existing_patterns(gitignore.remove(out, "commit")) == {"b.key"}


def test_a_hand_deleted_closing_fence_does_not_eat_the_rest():
    text = "# >>> harness:commit >>>\n.claude/commit-ai.key\nmy-own-rule\n"
    out = gitignore.remove(text, "commit")
    assert "my-own-rule" in out
    assert "harness:commit" not in out


def test_a_commented_line_is_not_a_pattern():
    assert gitignore.existing_patterns("# *.pyc\n\nbuild/\n") == {"build/"}
