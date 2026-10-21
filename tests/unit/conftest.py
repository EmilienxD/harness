import pytest
import json
import shutil
import tarfile

from harness_cli import host_actions, pi_packages


@pytest.fixture(autouse=True)
def forget_cached_host_products():
    """Keep one test's host inventory from answering another test's probe."""
    host_actions.forget_host_products()
    yield
    host_actions.forget_host_products()


@pytest.fixture(autouse=True)
def fake_pi_packages(monkeypatch, tmp_path):
    """Unit tests isolate Pi/npm processes; real lifecycle coverage lives in E2E."""
    calls = []

    def run(operation, source, scope_root, is_user):
        calls.append((operation, source, scope_root, is_user))
        name, archive = source.removeprefix("npm:").split("@file:", 1)
        platform = scope_root if is_user else scope_root / ".pi"
        destination = platform / "npm/node_modules" / name
        assert destination.resolve().is_relative_to(tmp_path.resolve())
        if destination.exists():
            shutil.rmtree(destination)
        settings_path = platform / "settings.json"
        settings = json.loads(settings_path.read_text(encoding="utf-8-sig")) if settings_path.is_file() else {}
        packages = settings.setdefault("packages", [])
        if operation == "install":
            with tarfile.open(archive, "r:gz") as tar:
                for member in tar.getmembers():
                    path = destination / member.name.removeprefix("package/")
                    assert path.resolve().is_relative_to(destination.resolve())
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with tar.extractfile(member) as content:
                        path.write_bytes(content.read())
            if source not in [entry.get("source") if isinstance(entry, dict) else entry for entry in packages]:
                packages.append(source)
        else:
            settings["packages"] = [entry for entry in packages
                                    if (entry.get("source") if isinstance(entry, dict) else entry) != source]
            if not settings["packages"]:
                del settings["packages"]
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(json.dumps(settings), encoding="utf-8")

    monkeypatch.setattr(pi_packages, "run", run)
    return calls
