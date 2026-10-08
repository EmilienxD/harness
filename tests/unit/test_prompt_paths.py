import hashlib
import re
from pathlib import PurePosixPath

import pytest

from subagents_runtime import sessions
from subagents_runtime.delegation import enable_delegation, process_inbox
from subagents_runtime.prompt_paths import FILE_REFERENCE, normalize_file_references


@pytest.mark.parametrize(
    "path",
    [
        r"src\core.py",
        "src/core.py",
        r"C:\project\src\core.py",
        r"\\server\share\core.py",
        r"..\src\core.py",
        "README.md",
        ".env",
    ],
)
@pytest.mark.parametrize("quote", ["", '"', "'", "`"])
def test_file_reference_path_conversion(path, quote, tmp_path):
    converted = normalize_file_references(f"@{quote}{path}{quote}", tmp_path)
    converted_path = converted[1:-1] if quote else converted

    assert PurePosixPath(converted_path).parts == PurePosixPath(path.replace("\\", "/")).parts
    assert set(converted_path).isdisjoint({"@", "\\"})
    if quote:
        assert converted[0] == converted[-1] == quote


def test_markdown_punctuation_spaces_and_unrelated_text(tmp_path):
    converted = normalize_file_references(
        'Read (`@src\\core.py`), @"C:\\a project\\notes.md"; '
        'contact dev@example.com or @owner and '
        'https://example.com/@src/file. Regex: \\d+\\s.',
        tmp_path,
    )

    # Check the file syntax and independent non-path tokens, not instruction wording.
    assert re.findall(r"\(`([^`]+)`\),", converted) == ["src/core.py"]
    assert re.findall(r'"([^"]+)";', converted) == ["C:/a project/notes.md"]
    assert FILE_REFERENCE.findall(converted) == ["owner"]
    assert re.findall(r"\S+@\S+", converted) == [
        "dev@example.com", "https://example.com/@src/file."
    ]
    assert re.findall(r"\\[ds][+.]*", converted) == [r"\d+", r"\s."]


def test_extensionless_files_and_directories_are_resolved_in_child_cwd(tmp_path):
    (tmp_path / "LICENSE").touch()
    (tmp_path / "src").mkdir()
    converted = normalize_file_references("@LICENSE @src @owner", tmp_path)

    assert FILE_REFERENCE.findall(converted) == ["owner"]
    assert [PurePosixPath(token).name for token in converted.split()[:2]] == ["LICENSE", "src"]


@pytest.mark.parametrize("provider", ["claude", "chatgpt", "codex"])
@pytest.mark.parametrize("retry", [False, True])
def test_launch_and_resume_normalize_using_child_provider_and_preserve_request_hash(
    tmp_path, monkeypatch, provider, retry
):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    # Exercise cross-provider dispatch and continuations with no provider metadata.
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "work-with-agent").inbox
    body = r"Inspect @src\core.py."
    (inbox / "first.md").write_text(
        f"---\ntask: general\nmode: auto\nprovider: {provider}\n---\n{body}",
        encoding="utf-8",
    )
    references = []

    def adapter(request, *_args):
        references.extend(re.findall(r"(@?)(src[/\\]core\.py)", request.prompt))
        return "saved-conversation"

    if retry:
        def crash_before_spawn(*_args):
            raise KeyboardInterrupt()

        with pytest.raises(KeyboardInterrupt):
            process_inbox("parent", launch=crash_before_spawn)
        with sessions._connect() as connection:
            connection.execute(
                "UPDATE executions SET reservation_pid=2147483647,reservation_birth='dead'"
            )

    [first] = process_inbox("parent", launch=adapter)
    assert first.status == "launched"
    with sessions._connect() as connection:
        digest = connection.execute(
            "SELECT prompt_hash FROM requests WHERE id=?", (first.request_id,)
        ).fetchone()[0]
        connection.execute(
            "UPDATE executions SET state='exited' WHERE request_id=?", (first.request_id,)
        )
        connection.execute(
            "UPDATE requests SET state='succeeded' WHERE id=?", (first.request_id,)
        )
    assert digest == hashlib.sha256(body.encode()).hexdigest()
    (inbox / "next.md").write_text(
        f"---\nresume: agent-1\n---\n{body}", encoding="utf-8"
    )
    [continued] = process_inbox("parent", launch=adapter)
    assert continued.status == "launched", continued.reason
    assert continued.child_session_id == first.child_session_id
    assert references == (
        [("@", r"src\core.py")] * 2
        if provider == "claude"
        else [("", "src/core.py")] * 2
    )
