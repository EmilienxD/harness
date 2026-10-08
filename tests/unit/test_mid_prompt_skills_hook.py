"""Tests for the mid-prompt-skills hook."""
import io
import json
import re
import sys
import tempfile
from pathlib import Path

import pytest

HOOK_DIR = Path(__file__).resolve().parents[2] / "harness" / "productivity" / "mid-prompt-skills"

sys.path.insert(0, str(HOOK_DIR))

import mid_prompt_skills_hook as hook  # noqa: E402


@pytest.fixture
def env(tmp_path, monkeypatch):
    config = tmp_path / "config"
    project = tmp_path / "work" / "project"
    (project / ".git").mkdir(parents=True)
    config.mkdir()
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(config))
    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()
    monkeypatch.setattr(hook, "MANAGED_ROOTS", ())
    return {"config": config, "project": project}


def skill(root, name, body, frontmatter="disable-model-invocation: true"):
    directory = root / ".claude" / "skills" / name if root.name != "config" else root / "skills" / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "SKILL.md").write_text(f"---\ndescription: {name}\n{frontmatter}\n---\n{body}\n", encoding="utf-8")
    return directory


def run(payload, provider="claude"):
    old_stdin, old_stdout = sys.stdin, sys.stdout
    old_argv = sys.argv
    cap = io.StringIO()
    sys.stdin = io.StringIO(json.dumps(payload))
    sys.stdout = cap
    sys.argv = [str(HOOK_DIR / "mid_prompt_skills_hook.py"), f"--{provider}"]
    try:
        code = hook.main()
    finally:
        sys.stdin, sys.stdout = old_stdin, old_stdout
        sys.argv = old_argv
    assert code == 0
    out = cap.getvalue().strip()
    return json.loads(out) if out else {}


def submit(env, prompt, session="s1"):
    return run({
        "hook_event_name": "UserPromptSubmit", "session_id": session, "cwd": str(env["project"]), "prompt": prompt,
    })


def expansion(env, prompt, name, args, session="s1"):
    return run({
        "hook_event_name": "UserPromptExpansion", "session_id": session, "cwd": str(env["project"]),
        "expansion_type": "slash_command", "command_name": name, "command_args": args, "prompt": prompt,
    })


def context(output):
    return output.get("hookSpecificOutput", {}).get("additionalContext", "")


def chatgpt_skill(project, name, body):
    directory = project / ".agents" / "skills" / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: Test skill.\n---\n\n{body}\n",
        encoding="utf-8",
    )
    return directory


def test_mid_prompt_skill_is_injected_with_its_arguments(env):
    directory = skill(env["project"], "probe", "PROBE-BODY")

    output = submit(env, "Please look. /probe mid one")

    assert output["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"
    text = context(output)
    assert "<command-name>/probe</command-name>" in text
    assert "<command-args>mid one</command-args>" in text
    assert f"Base directory for this skill: {directory}" in text
    assert "PROBE-BODY\n\nARGUMENTS: mid one" in text


def test_chatgpt_mid_prompt_skill_is_injected_without_repeating_a_leading_skill(env):
    chatgpt_skill(env["project"], "lead", "LEAD-BODY")
    directory = chatgpt_skill(env["project"], "probe", "PROBE-BODY")

    output = run({
        "hook_event_name": "UserPromptSubmit",
        "session_id": "s1",
        "cwd": str(env["project"]),
        "prompt": "$lead first, then use $probe with this request",
    }, "chatgpt")

    text = context(output)
    assert output["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"
    assert "LEAD-BODY" not in text
    assert "PROBE-BODY" in text
    assert f"Base directory for this skill: {directory}" in text
    assert "ARGUMENTS:" not in text


def test_chatgpt_linked_mid_prompt_skill_uses_the_selected_skill_path(env, tmp_path):
    selected = tmp_path / "plugin-cache" / "probe"
    selected.mkdir(parents=True)
    path = selected / "SKILL.md"
    path.write_text(
        "---\nname: probe\ndescription: Test skill.\n---\n\nLINKED-PROBE-BODY\n",
        encoding="utf-8",
    )

    output = run({
        "hook_event_name": "UserPromptSubmit",
        "session_id": "s1",
        "cwd": str(env["project"]),
        "prompt": f"Please inspect this. [$probe]({path.as_posix()}) carefully",
    }, "chatgpt")

    text = context(output)
    assert "LINKED-PROBE-BODY" in text
    assert f"<skill-path>{path}</skill-path>" in text


def test_chatgpt_package_installs_the_hook_and_fragment():
    manifest = (HOOK_DIR / "harness.toml").read_text(encoding="utf-8")
    fragment = json.loads((HOOK_DIR / "chatgpt" / "hooks.fragment.json").read_text(encoding="utf-8"))

    assert '[platforms.chatgpt]\nstatus = "supported"' in manifest
    assert 'platforms = ["claude", "chatgpt"]' in manifest
    command = fragment["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
    assert command.endswith('mid_prompt_skills_hook.py" --chatgpt')


def test_skills_claude_code_expanded_are_not_injected_again(env):
    skill(env["project"], "lead", "LEAD-BODY")
    skill(env["project"], "tail", "TAIL-BODY")
    prompt = "/lead first /tail second"

    assert expansion(env, prompt, "lead", "first /tail second") == {}
    text = context(submit(env, prompt))

    assert "LEAD-BODY" not in text
    assert "TAIL-BODY\n\nARGUMENTS: second" in text


def test_only_the_expanded_occurrence_of_a_repeated_skill_is_skipped(env):
    skill(env["project"], "probe", "PROBE-BODY")
    prompt = "/probe first. Later /probe second"

    expansion(env, prompt, "probe", "first. Later /probe second")
    text = context(submit(env, prompt))

    assert "ARGUMENTS: second" in text
    assert "ARGUMENTS: first" not in text


def test_an_expansion_recorded_for_another_prompt_does_not_suppress_injection(env):
    skill(env["project"], "probe", "PROBE-BODY")

    expansion(env, "/probe earlier", "probe", "earlier")
    text = context(submit(env, "Now /probe later"))

    assert "ARGUMENTS: later" in text


def test_expansions_are_scoped_to_their_session(env):
    skill(env["project"], "probe", "PROBE-BODY")
    prompt = "/probe same"

    expansion(env, prompt, "probe", "same", session="other")
    text = context(submit(env, prompt, session="s1"))

    assert "ARGUMENTS: same" in text


def test_arguments_end_at_the_line_or_the_next_skill(env):
    skill(env["project"], "first", "FIRST-BODY")
    skill(env["project"], "second", "SECOND-BODY")

    text = context(submit(env, "- Q1: B. Keep it. /first alpha beta\n- Q2: A. /second gamma /first delta"))

    assert re.findall(r"<command-args>(.*?)</command-args>", text, re.DOTALL) == ["alpha beta", "gamma", "delta"]
    assert text.endswith("FIRST-BODY\n\nARGUMENTS: delta")


def test_a_skill_without_arguments_gets_no_arguments_line(env):
    skill(env["project"], "probe", "PROBE-BODY")

    text = context(submit(env, "Use /probe\nthen continue"))

    assert "<command-args></command-args>" in text
    assert "ARGUMENTS:" not in text


def test_prompts_without_known_skills_add_nothing(env):
    skill(env["project"], "probe", "PROBE-BODY")

    assert submit(env, "Read /usr/bin/env and https://example.com/probe then run `/probe` or a/probe") == {}
    assert submit(env, "Nothing to see") == {}


def test_skills_inside_fenced_code_blocks_are_ignored(env):
    skill(env["project"], "probe", "PROBE-BODY")

    assert submit(env, "Example:\n```\n/probe inside\n```\n") == {}
    assert "ARGUMENTS: outside" in context(submit(env, "```text\n/probe inside\n```\nthen /probe outside"))


def test_argument_placeholders_are_substituted_like_claude_code(env):
    skill(env["project"], "probe", r"all=$ARGUMENTS first=$0 second=$ARGUMENTS[1] missing=$5 kept=\$1 double=\\$0 other=\$HOME")

    text = context(submit(env, 'Then /probe "hello world" two'))

    assert r'all="hello world" two first=hello world second=two missing=$5 kept=$1 double=\\hello world other=\$HOME' in text
    assert "ARGUMENTS:" not in text


def test_named_arguments_expand_even_when_missing(env):
    skill(env["project"], "probe", "issue=$issue branch=[$branch] issues=$issues", "arguments: [issue, branch]")

    text = context(submit(env, "Then /probe 42"))

    assert "issue=42 branch=[] issues=$issues" in text
    assert "ARGUMENTS:" not in text


def test_named_arguments_accept_a_yaml_list(env):
    skill(env["project"], "probe", "issue=$issue branch=$branch", "arguments:\n  - issue\n  - branch")

    assert "issue=42 branch=main" in context(submit(env, "Then /probe 42 main"))


def test_an_unfilled_indexed_placeholder_still_appends_the_arguments(env):
    skill(env["project"], "probe", "second=$1")

    assert "second=$1\n\nARGUMENTS: only" in context(submit(env, "Then /probe only"))


def test_argument_text_is_never_expanded_again(env):
    skill(env["project"], "probe", "Summarize $0")

    assert "Summarize $ARGUMENTS from yesterday" in context(submit(env, 'Then /probe "$ARGUMENTS from yesterday"'))


def test_claude_variables_are_substituted(env):
    directory = skill(env["project"], "probe", "dir=${CLAUDE_SKILL_DIR} session=${CLAUDE_SESSION_ID} project=${CLAUDE_PROJECT_DIR}")

    text = context(submit(env, "Then /probe", session="abc-123"))

    assert f"dir={directory.as_posix()} session=abc-123 project={env['project']}" in text


def test_skills_resolve_managed_then_personal_then_project(env, tmp_path, monkeypatch):
    skill(env["project"], "shared", "PROJECT-BODY")
    skill(env["project"], "local", "PROJECT-ONLY-BODY")
    skill(env["config"], "shared", "PERSONAL-BODY")
    skill(env["config"], "personal", "PERSONAL-ONLY-BODY")
    managed = tmp_path / "managed"
    skill(managed, "personal", "MANAGED-BODY")
    monkeypatch.setattr(hook, "MANAGED_ROOTS", (managed,))

    text = context(submit(env, "Run /shared then /local then /personal"))

    assert "PERSONAL-BODY" in text and "PROJECT-BODY" not in text
    assert "PROJECT-ONLY-BODY" in text
    assert "MANAGED-BODY" in text and "PERSONAL-ONLY-BODY" not in text


def test_project_skills_load_from_parents_up_to_the_repository_root(env):
    nested = env["project"] / "packages" / "web"
    nested.mkdir(parents=True)
    skill(env["project"], "root", "ROOT-BODY")
    skill(env["project"].parent, "outside", "OUTSIDE-BODY")

    text = run({"hook_event_name": "UserPromptSubmit", "session_id": "s1", "cwd": str(nested), "prompt": "Go /root then /outside"})

    assert "ROOT-BODY" in context(text)
    assert "OUTSIDE-BODY" not in context(text)


def test_command_files_resolve_with_namespaced_names_and_lose_to_skills(env):
    commands = env["project"] / ".claude" / "commands"
    (commands / "frontend").mkdir(parents=True)
    (commands / "frontend" / "component.md").write_text("COMPONENT-BODY $ARGUMENTS\n", encoding="utf-8")
    (commands / "probe.md").write_text("COMMAND-BODY\n", encoding="utf-8")
    skill(env["project"], "probe", "SKILL-BODY")

    text = context(submit(env, "Build /frontend:component Button then /probe"))

    assert "<command-name>/frontend:component</command-name>" in text
    assert "COMPONENT-BODY Button" in text
    assert "SKILL-BODY" in text and "COMMAND-BODY" not in text


@pytest.mark.parametrize("frontmatter", ["user-invocable: false", "user-invocable: No", "context: fork"])
def test_skills_claude_code_would_not_run_inline_are_not_injected(env, frontmatter):
    skill(env["project"], "probe", "PROBE-BODY", frontmatter)

    assert submit(env, "Then /probe now") == {}


def test_model_invocable_skills_are_injected_too(env):
    skill(env["project"], "probe", "PROBE-BODY", "user-invocable: true")

    assert "PROBE-BODY" in context(submit(env, "Then /probe now"))


@pytest.mark.parametrize("settings", [
    lambda env: env["config"] / "settings.json",
    lambda env: env["project"] / ".claude" / "settings.json",
    lambda env: env["project"] / ".claude" / "settings.local.json",
])
def test_skills_turned_off_in_settings_are_not_injected(env, settings):
    skill(env["project"], "probe", "PROBE-BODY")
    skill(env["project"], "other", "OTHER-BODY")
    path = settings(env)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"skillOverrides": {"probe": "off", "other": "user-invocable-only"}}), encoding="utf-8")

    text = context(submit(env, "Then /probe and /other"))

    assert "PROBE-BODY" not in text
    assert "OTHER-BODY" in text


def test_command_names_cannot_leave_the_commands_directory(env):
    (env["project"] / ".claude" / "commands").mkdir(parents=True)
    (env["project"] / ".claude" / "secret.md").write_text("SECRET-BODY\n", encoding="utf-8")

    assert submit(env, "Then /x:..:..:secret now") == {}
