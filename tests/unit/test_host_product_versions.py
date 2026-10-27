import json
import pytest

from harness_cli import host_actions
from harness_cli.manifest import HostAction


@pytest.mark.parametrize("site_directory", ["Lib/site-packages", "lib/python3.13/site-packages"])
@pytest.mark.parametrize("difference", [None, "commit", "repository", "subdirectory", "missing-metadata"])
def test_uv_revision_check_reads_installed_distribution(tmp_path, monkeypatch, site_directory, difference):
    package = "example-runtime"
    commit = "a" * 40
    distribution = tmp_path / package / site_directory / "example_runtime-1.0.0.dist-info"
    distribution.mkdir(parents=True)
    (distribution / "METADATA").write_text("Name: example-runtime\nVersion: 1.0.0\n")
    direct = {
        "url": "https://github.com/example/runtime",
        "vcs_info": {"vcs": "git", "commit_id": commit},
        "subdirectory": "runtime",
    }
    if difference == "commit":
        direct["vcs_info"]["commit_id"] = "b" * 40
    elif difference == "repository":
        direct["url"] = "https://github.com/example/another-runtime"
    elif difference == "subdirectory":
        direct["subdirectory"] = "other-runtime"
    if difference != "missing-metadata":
        (distribution / "direct_url.json").write_text(json.dumps(direct))
    monkeypatch.setattr(host_actions.shutil, "which", lambda name: "uv")
    monkeypatch.setattr(host_actions, "_listing", lambda command: [str(tmp_path)])
    action = HostAction("uv-tool", {
        "package": package,
        "source": f"git+https://github.com/example/runtime.git@{commit}#subdirectory=runtime",
    })

    assert host_actions.is_current(action) is (difference is None)


def test_local_uv_source_checks_the_installed_version(tmp_path, monkeypatch):
    source = tmp_path / "source"
    source.mkdir()
    (source / "pyproject.toml").write_text('[project]\nversion="2.0.0"\n')
    distribution = tmp_path / "example" / "Lib/site-packages/example-1.0.0.dist-info"
    distribution.mkdir(parents=True)
    (distribution / "METADATA").write_text("Name: example\nVersion: 1.0.0\n")
    (distribution / "direct_url.json").write_text(json.dumps({"url": source.as_uri()}))
    monkeypatch.setattr(host_actions.shutil, "which", lambda name: "uv")
    monkeypatch.setattr(host_actions, "_listing", lambda command: [str(tmp_path)])
    action = HostAction("uv-tool", {"package": "example", "source": str(source)})

    assert not host_actions.is_current(action)
    (distribution / "METADATA").write_text("Name: example\nVersion: 2.0.0\n")
    assert host_actions.is_current(action)


@pytest.mark.parametrize("installed", [None, "1.2.2", "1.2.3", "1.2.4"])
def test_extension_revision_check_uses_the_pinned_artifact_version(monkeypatch, installed):
    monkeypatch.setattr(host_actions, "_vscode_executable", lambda: "code")

    def listing(command):
        assert command == ["code", "--list-extensions", "--show-versions"]
        return [] if installed is None else [f"example.extension@{installed}"]

    monkeypatch.setattr(host_actions, "_listing", listing)
    action = HostAction("vscode-extension", {
        "extension_id": "example.extension",
        "url": "https://example.test/releases/download/v1.2.3/extension-1.2.3.vsix",
    })

    assert host_actions.is_current(action) is (installed == "1.2.3")


@pytest.mark.parametrize("installed", [None, "1.2.2", "1.2.3", "1.2.4"])
def test_npm_revision_check_uses_exact_version(monkeypatch, installed):
    monkeypatch.setattr(host_actions, "_npm_command", lambda: ["npm"])
    inventory = {"dependencies": {} if installed is None else {"example": {"version": installed}}}
    monkeypatch.setattr(host_actions, "_listing", lambda command: [json.dumps(inventory)])
    action = HostAction("npm-tool", {"package": "example", "version": "1.2.3"})

    assert host_actions.is_current(action) is (installed == "1.2.3")
    assert host_actions.is_installed(action) is (installed is not None)
