import json
from pathlib import Path
import subprocess
import sys

import pytest

from scripts.check_local_secrets import check


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/check_local_secrets.py"
CODE = "8675"  # Synthetic credential for a disposable Git repository only.
SECRET = "synthetic-production-session-secret"


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)


@pytest.fixture
def repository(tmp_path):
    git(tmp_path, "init", "-b", "main")
    git(tmp_path, "config", "user.name", "Credential guard test")
    git(tmp_path, "config", "user.email", "test@example.invalid")
    (tmp_path / ".gitignore").write_text(".env*\n.harness/config.local.json\n")
    git(tmp_path, "add", ".gitignore")
    git(tmp_path, "commit", "-m", "initial")
    (tmp_path / ".env.production.local").write_text(
        f'HARNESS_GRILL_CODE="{CODE}"\nHARNESS_GRILL_SESSION_SECRET="{SECRET}"\n',
    )
    return tmp_path


@pytest.mark.parametrize("content", [
    f'const code = "{CODE}";',
    json.dumps({"grill": {"code": CODE}}),
    f"HARNESS_GRILL_CODE={CODE}",
    f"Authorization: Bearer {CODE}",
    f'validCode("{CODE}");',
    f'const secret = "{SECRET}";',
])
def test_cli_blocks_staged_credentials_without_printing_values(repository, content):
    (repository / "fixture.ts").write_text(content)
    git(repository, "add", "fixture.ts")
    # Fixing the working tree must not conceal the credential still in the index.
    (repository / "fixture.ts").write_text("const code = generateTestCode();")

    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--staged"], cwd=repository,
        capture_output=True, text=True,
    )

    assert result.returncode == 1
    assert "fixture.ts" in result.stderr
    assert CODE not in result.stdout + result.stderr
    assert SECRET not in result.stdout + result.stderr


def test_benign_numbers_and_unstaged_credentials_do_not_block_commit(repository):
    (repository / "safe.txt").write_text(f"port: {CODE}\nhash: abc{CODE}def\ncode: {CODE}1\n")
    git(repository, "add", "safe.txt")
    (repository / "unstaged.ts").write_text(f'const code = "{CODE}";')

    assert check(repository, staged=True) == []
    assert check(repository, staged=False) == ["unstaged.ts"]


def test_project_private_configuration_also_supplies_protected_code(repository):
    (repository / ".env.production.local").unlink()
    config = repository / ".harness/config.local.json"
    config.parent.mkdir()
    config.write_text(json.dumps({"grill": {"code": CODE}}))
    (repository / "fixture.ts").write_text(f'const code = "{CODE}";')
    git(repository, "add", "fixture.ts")

    assert check(repository, staged=True) == ["fixture.ts"]


def test_invalid_private_configuration_fails_without_echoing_secrets(repository):
    config = repository / ".harness/config.local.json"
    config.parent.mkdir()
    config.write_text(f'{{"code":"{CODE}", invalid')

    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--staged"], cwd=repository,
        capture_output=True, text=True,
    )

    assert result.returncode == 2
    assert CODE not in result.stdout + result.stderr


def test_app_production_env_is_checked_but_development_examples_are_not(repository):
    app = repository / "apps/grill"
    app.mkdir(parents=True)
    (repository / ".env.production.local").rename(app / ".env.production.local")
    (repository / ".env.development.local").write_text('HARNESS_GRILL_CODE="1234"')
    (repository / "fixture.ts").write_text('const code = "1234";')
    git(repository, "add", "fixture.ts")
    assert check(repository, staged=True) == []

    (repository / "fixture.ts").write_text(f'const code = "{CODE}";')
    git(repository, "add", "fixture.ts")
    assert check(repository, staged=True) == ["fixture.ts"]


def test_installed_git_hook_rejects_credential(repository):
    script = repository / "scripts/check_local_secrets.py"
    script.parent.mkdir()
    script.write_bytes(SCRIPT.read_bytes())
    hook = repository / ".githooks/pre-commit"
    hook.parent.mkdir()
    hook.write_bytes((SCRIPT.parent.parent / ".githooks/pre-commit").read_bytes())
    install = subprocess.run(
        [sys.executable, str(script), "--install-hook"], cwd=repository,
        capture_output=True, text=True,
    )
    assert install.returncode == 0
    (repository / "fixture.ts").write_text(f'const code = "{CODE}";')
    git(repository, "add", "fixture.ts")

    result = subprocess.run(
        ["git", "-C", str(repository), "hook", "run", "pre-commit"],
        capture_output=True, text=True,
    )

    assert result.returncode != 0
    assert "fixture.ts" in result.stderr
    assert CODE not in result.stdout + result.stderr


def test_installation_preserves_an_existing_hook(repository):
    hook = repository / ".git/hooks/pre-commit"
    hook.write_text("#!/bin/sh\nexit 0\n")

    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--install-hook"], cwd=repository,
        capture_output=True, text=True,
    )

    assert result.returncode == 2
    assert hook.read_text() == "#!/bin/sh\nexit 0\n"
    assert subprocess.run(
        ["git", "-C", str(repository), "config", "--get", "core.hooksPath"], capture_output=True,
    ).returncode == 1
