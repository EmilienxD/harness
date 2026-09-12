import json

from harness_cli.cli import main


def test_install_is_non_interactive_and_emits_one_json_result(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))

    assert main(["install", "caveman", "--platform", "claude", "--json"]) == 0

    captured = capsys.readouterr()
    result = json.loads(captured.out)
    assert captured.err == ""
    assert result == {
        "schemaVersion": 1,
        "command": "install",
        "ok": True,
        "scope": "project",
        "root": str(tmp_path.resolve()),
        "platforms": ["claude"],
        "dryRun": False,
        "results": [
            {
                "platform": "claude",
                "product": "Claude Code",
                "status": "changed",
                "changes": [
                    {"action": "install", "package": "caveman", "reason": "selected"}
                ],
                "skipped": [],
            }
        ],
        "summary": {
            "targets": 1,
            "changedTargets": 1,
            "unchangedTargets": 0,
            "failedTargets": 0,
            "changes": 1,
            "skipped": 0,
        },
    }
    assert (tmp_path / ".claude/skills/caveman/SKILL.md").is_file()


def test_list_json_reports_installed_catalogue_packages(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    assert main(["install", "caveman", "--platform", "claude", "--json"]) == 0
    capsys.readouterr()

    assert main(["list", "--installed", "--platform", "claude", "--json"]) == 0

    captured = capsys.readouterr()
    result = json.loads(captured.out)
    assert captured.err == ""
    assert result["schemaVersion"] == 1
    assert result["command"] == "list"
    assert result["ok"] is True
    assert result["scope"] == "project"
    assert result["platforms"] == ["claude"]
    assert result["packages"] == [
        {
            "name": "caveman",
            "available": True,
            "version": "1.0.4",
            "description": "Ultra-compressed communication mode (~75% fewer tokens)",
            "category": "productivity",
            "docs": "https://github.com/EmilienxD/harness/blob/main/harness/productivity/caveman/SKILL.md",
            "support": {"claude": {"status": "supported"}},
            "installed": [
                {"platform": "claude", "version": "1.0.4", "ownership": "explicit"}
            ],
        }
    ]


def test_list_installed_surfaces_packages_missing_from_the_pinned_catalogue(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.chdir(tmp_path)
    state = tmp_path / "state"
    monkeypatch.setenv("HARNESS_STATE_DIR", str(state))
    assert main([
        "install", "caveman", "stop-overthinking", "--platform", "claude", "--json"
    ]) == 0
    capsys.readouterr()
    receipts_path = state / "receipts.json"
    receipts = json.loads(receipts_path.read_text(encoding="utf-8"))
    installation = next(iter(receipts["installations"].values()))
    installation["packages"]["retired-caveman"] = installation["packages"].pop("caveman")
    receipts_path.write_text(json.dumps(receipts), encoding="utf-8")

    assert main(["list", "--installed", "--platform", "claude", "--json"]) == 0

    result = json.loads(capsys.readouterr().out)
    assert [package["name"] for package in result["packages"]] == [
        "stop-overthinking",
        "retired-caveman",
    ]
    assert result["packages"][0]["available"] is True
    assert result["packages"][1] == {
        "name": "retired-caveman",
        "available": False,
        "installed": [
            {"platform": "claude", "version": "1.0.4", "ownership": "explicit"}
        ],
    }


def test_info_json_exposes_dependency_and_platform_contract(capsys):
    assert main(["info", "subagents", "--json"]) == 0

    captured = capsys.readouterr()
    result = json.loads(captured.out)
    assert captured.err == ""
    assert result["schemaVersion"] == 1
    assert result["command"] == "info"
    assert result["ok"] is True
    package = result["packages"][0]
    assert package["name"] == "subagents"
    assert package["category"] == "productivity"
    assert package["platforms"] == {
        "claude": {"status": "supported"},
        "chatgpt": {"status": "supported"},
    }
    assert package["dependencies"] == [
        {"name": "prototype", "constraint": ">=1.1.0,<2.0.0"},
        {"name": "websearch", "constraint": ">=1.1.0,<2.0.0"},
        {"name": "grill-me", "constraint": ">=1.0.3,<2.0.0"},
        {"name": "issue-readers", "constraint": ">=1.0.0,<2.0.0"},
    ]
    assert package["actions"] == ["uv-tool"]


def test_uninstall_removes_only_named_explicit_packages(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    assert main(
        ["install", "caveman", "stop-overthinking", "--platform", "claude", "--json"]
    ) == 0
    capsys.readouterr()

    assert main(["uninstall", "caveman", "--platform", "claude", "--json"]) == 0

    captured = capsys.readouterr()
    result = json.loads(captured.out)
    assert captured.err == ""
    assert result["command"] == "uninstall"
    assert result["results"][0]["changes"] == [
        {"action": "remove", "package": "caveman", "reason": ""}
    ]
    assert not (tmp_path / ".claude/skills/caveman/SKILL.md").exists()
    assert (tmp_path / ".claude/skills/stop-overthinking/SKILL.md").is_file()


def test_upgrade_reconciles_existing_selection_to_current_catalogue(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    state = tmp_path / "state"
    monkeypatch.setenv("HARNESS_STATE_DIR", str(state))
    assert main(["install", "caveman", "--platform", "claude", "--json"]) == 0
    capsys.readouterr()
    receipts_path = state / "receipts.json"
    receipts = json.loads(receipts_path.read_text(encoding="utf-8"))
    installation = next(iter(receipts["installations"].values()))
    installation["packages"]["caveman"]["version"] = "0.9.0"
    receipts_path.write_text(json.dumps(receipts), encoding="utf-8")

    assert main(["upgrade", "--platform", "claude", "--json"]) == 0

    result = json.loads(capsys.readouterr().out)
    assert result["command"] == "upgrade"
    assert result["results"][0]["changes"] == [
        {"action": "upgrade", "package": "caveman", "reason": "0.9.0 -> 1.0.4"}
    ]
    updated = json.loads(receipts_path.read_text(encoding="utf-8"))
    installation = next(iter(updated["installations"].values()))
    assert installation["packages"]["caveman"]["version"] == "1.0.4"


def test_json_operational_errors_keep_stdout_machine_readable(capsys):
    assert main(["install", "not-a-package", "--json"]) == 1

    captured = capsys.readouterr()
    assert captured.err == ""
    assert json.loads(captured.out) == {
        "schemaVersion": 1,
        "command": "install",
        "ok": False,
        "error": {
            "type": "operation",
            "message": "unknown catalogue package(s): not-a-package",
        },
    }


def test_uninstall_rejects_an_unknown_package_that_is_not_installed(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))

    assert main(["uninstall", "not-a-package", "--json"]) == 1

    captured = capsys.readouterr()
    assert captured.err == ""
    assert json.loads(captured.out) == {
        "schemaVersion": 1,
        "command": "uninstall",
        "ok": False,
        "error": {
            "type": "operation",
            "message": "unknown catalogue package(s): not-a-package",
        },
    }


def test_json_usage_errors_are_distinct_and_do_no_work(capsys):
    assert main(["uninstall", "--json"]) == 2

    captured = capsys.readouterr()
    assert captured.err == ""
    assert json.loads(captured.out) == {
        "schemaVersion": 1,
        "command": "uninstall",
        "ok": False,
        "error": {
            "type": "usage",
            "message": "specify package names or use --all",
        },
    }


def test_argparse_errors_are_json_when_requested(capsys):
    assert main(["install", "caveman", "--platform", "cursor", "--json"]) == 2

    captured = capsys.readouterr()
    assert captured.err == ""
    result = json.loads(captured.out)
    assert result["command"] == "install"
    assert result["ok"] is False
    assert result["error"]["type"] == "usage"
    assert "invalid choice" in result["error"]["message"]


def test_install_dry_run_reports_plan_without_writing(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    state = tmp_path / "state"
    monkeypatch.setenv("HARNESS_STATE_DIR", str(state))

    assert main(
        ["install", "caveman", "--platform", "claude", "--dry-run", "--json"]
    ) == 0

    result = json.loads(capsys.readouterr().out)
    assert result["dryRun"] is True
    assert result["results"][0]["changes"] == [
        {"action": "install", "package": "caveman", "reason": "selected"}
    ]
    assert not (tmp_path / ".claude").exists()
    assert not state.exists()


def test_project_root_must_be_an_existing_directory_even_for_dry_run(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    missing = tmp_path / "mistyped-project"

    assert main([
        "install", "caveman", "--root", str(missing), "--dry-run", "--json"
    ]) == 2

    captured = capsys.readouterr()
    assert captured.err == ""
    assert json.loads(captured.out) == {
        "schemaVersion": 1,
        "command": "install",
        "ok": False,
        "error": {
            "type": "usage",
            "message": f"project root is not an existing directory: {missing}",
        },
    }
    assert not missing.exists()
    assert not (tmp_path / "state").exists()


def test_install_all_is_explicit_and_cannot_be_combined_with_names(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))

    assert main(["install", "--all", "--platform", "claude", "--dry-run", "--json"]) == 0
    result = json.loads(capsys.readouterr().out)
    installed = {
        change["package"]
        for change in result["results"][0]["changes"]
        if change["reason"] == "selected"
    }
    catalogue = json.loads(_run_json(capsys, ["list", "--json"]))["packages"]
    assert installed == {
        package["name"]
        for package in catalogue
        if package["support"]["claude"]["status"] == "supported"
    }

    assert main(["install", "caveman", "--all", "--json"]) == 2
    assert json.loads(capsys.readouterr().out)["error"]["type"] == "usage"


def _run_json(capsys, arguments):
    assert main(arguments) == 0
    return capsys.readouterr().out


def test_target_failures_are_structured_and_return_one(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    state = tmp_path / "state"
    monkeypatch.setenv("HARNESS_STATE_DIR", str(state))
    assert main(["install", "caveman", "--platform", "claude", "--json"]) == 0
    capsys.readouterr()
    installed = tmp_path / ".claude/skills/caveman/SKILL.md"
    installed.write_text("user change", encoding="utf-8")
    receipts_path = state / "receipts.json"
    receipts = json.loads(receipts_path.read_text(encoding="utf-8"))
    installation = next(iter(receipts["installations"].values()))
    installation["packages"]["caveman"]["version"] = "0.9.0"
    receipts_path.write_text(json.dumps(receipts), encoding="utf-8")

    assert main(["upgrade", "--platform", "claude", "--json"]) == 1

    captured = capsys.readouterr()
    assert captured.err == ""
    result = json.loads(captured.out)
    assert result["ok"] is False
    assert result["summary"] == {
        "targets": 1,
        "changedTargets": 0,
        "unchangedTargets": 0,
        "failedTargets": 1,
        "changes": 1,
        "skipped": 0,
    }
    assert result["results"][0]["status"] == "failed"
    assert "installed file was modified" in result["results"][0]["error"]


def test_invalid_nested_receipt_is_reported_as_an_operation_error(tmp_path, monkeypatch, capsys):
    state = tmp_path / "state"
    state.mkdir()
    (state / "receipts.json").write_text(
        json.dumps({"version": 1, "installations": {"bad": {"packages": {"x": []}}}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("HARNESS_STATE_DIR", str(state))

    assert main(["list", "--json"]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["error"]["type"] == "operation"
