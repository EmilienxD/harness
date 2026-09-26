import hashlib
import io
import json
import subprocess
from contextlib import nullcontext

import pytest

from harness_cli.catalogue import CatalogueError, resolve_dependencies
from harness_cli import cli
from harness_cli.cli import build_parser
from harness_cli.installer import (
    CatalogueInstaller,
    Change,
    InstallError,
    Target,
    UnownedFileError,
    UnownedHostProductError,
    installed_packages,
    reconcile_targets,
)
from harness_cli.host_actions import (
    HostActionError,
    PreparedAction,
    is_installed,
    prepare,
    uninstall,
)
from harness_cli.manifest import HostAction, ManifestError, discover, load_tool
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


def manager(tools, target, tmp_path):
    return CatalogueInstaller(tools, target, ReceiptStore.load(tmp_path / "receipts.json"))


def test_installer_cli_exposes_catalogue_commands_without_runtime_commands():
    parser = build_parser()
    command = next(action for action in parser._actions if action.dest == "command")
    assert {"install", "uninstall", "upgrade", "list", "info"} <= set(command.choices)
    assert {"run", "ask", "reply", "resume"}.isdisjoint(command.choices)


class InteractiveInput:
    @staticmethod
    def isatty():
        return True


def wire_menu(monkeypatch, tools, ui_factory, installer_factory, installed=()):
    monkeypatch.setattr(cli.sys, "stdin", InteractiveInput())
    monkeypatch.setattr(cli, "discover", lambda: {tool.name: tool for tool in tools})
    monkeypatch.setattr(cli, "terminal_keys", lambda: nullcontext(lambda: ""))
    monkeypatch.setattr(cli, "TerminalUI", ui_factory)
    monkeypatch.setattr(cli, "installation_lock", nullcontext)
    monkeypatch.setattr(cli, "CatalogueInstaller", installer_factory)
    monkeypatch.setattr(
        cli,
        "reconcile_targets",
        lambda requests, overwrite=(), adopt=(): [
            installer.reconcile(requested, overwrite=overwrite, adopt=adopt)
            for installer, requested in requests
        ],
    )
    monkeypatch.setattr(cli.ReceiptStore, "load", lambda: object())
    monkeypatch.setattr(
        cli, "installed_packages", lambda target, store: {name: {"explicit": True} for name in installed}
    )


def test_catalogue_defaults_to_both_providers_and_stops_when_up_to_date(monkeypatch):
    aboard = discover()["aboard"]
    screens = []
    planned = {}

    class FakeUI:
        def __init__(self, read_key):
            pass

        def intro(self, label):
            screens.append(label)

        def multiselect(self, title, options, selected=None, **settings):
            screens.append(title)
            if title == "Select providers":
                assert selected == {0, 1}
                return {0, 1}
            return {0}

        def select(self, title, options, default=0):
            screens.append(title)
            return 0

        def outro(self, message):
            screens.append(message)

    class FakeInstaller:
        def __init__(self, available, target, store):
            self.target = target

        def plan(self, requested):
            planned[self.target.platform] = requested
            return [], []

        def reconcile(self, requested):
            raise AssertionError("nothing should be reconciled when there are no changes")

    wire_menu(monkeypatch, [aboard], FakeUI, FakeInstaller)

    assert cli.catalogue_menu() == 0
    assert screens == [
        "harness",
        "Select providers",
        "Installation scope",
        "Select packages",
        "Catalogue already matches that selection.",
    ]
    assert planned == {Platform.CLAUDE: {"aboard"}, Platform.CHATGPT: {"aboard"}}


def test_catalogue_asks_for_skill_installation_mode(monkeypatch):
    caveman = discover()["caveman"]
    prompts = []
    applied = []

    class FakeUI:
        def __init__(self, read_key):
            pass

        def intro(self, label):
            pass

        def multiselect(self, title, options, selected=None, **settings):
            return {0, 1} if title == "Select providers" else {0}

        def select(self, title, options, default=0):
            prompts.append(title)
            return 1 if title == "Skill installation" else 0

        def note(self, title, lines):
            pass

        def confirm(self, title, default=True):
            return True

        def progress(self, active, complete, action):
            return action()

        def outro(self, message):
            pass

    class FakeInstaller:
        def __init__(self, available, target, store):
            self.target = target
            self.skill_mode = "copy"

        def plan(self, requested):
            return [], [cli.Change("install", "caveman", "selected")]

        def conflicts(self, requested):
            return []

        def unowned_host_products(self, requested):
            return {}

        def reconcile(self, requested, overwrite=(), adopt=()):
            applied.append((self.target.platform, self.skill_mode))

    wire_menu(monkeypatch, [caveman], FakeUI, FakeInstaller)

    assert cli.catalogue_menu() == 0
    assert prompts == ["Installation scope", "Skill installation"]
    assert applied == [(Platform.CLAUDE, "symlink"), (Platform.CHATGPT, "symlink")]


def test_catalogue_uses_the_skills_style_flow_with_only_claude_and_chatgpt(monkeypatch):
    aboard = discover()["aboard"]
    auto = discover()["auto"]
    events = []
    reconciled = {}

    class FakeUI:
        def __init__(self, read_key):
            pass

        def intro(self, label):
            events.append(("intro", label))

        def multiselect(self, title, options, selected=None, **settings):
            events.append(("multiselect", title, [option.label for option in options], settings))
            if title == "Select providers":
                return {0, 1}
            return set(range(len(options)))

        def select(self, title, options, default=0):
            events.append(("select", title, [option.label for option in options]))
            return 0

        def note(self, title, lines):
            events.append(("note", title, tuple(lines)))

        def confirm(self, title, default=True):
            events.append(("confirm", title))
            return True

        def progress(self, active, complete, action):
            events.append(("progress", active, complete))
            return action()

        def outro(self, message):
            events.append(("outro", message))

    class FakeInstaller:
        def __init__(self, available, target, store):
            self.target = target

        def plan(self, requested):
            return [], [cli.Change("install", name, "selected") for name in requested]

        def conflicts(self, requested):
            return []

        def unowned_host_products(self, requested):
            return {}

        def reconcile(self, requested, overwrite=(), adopt=()):
            reconciled[self.target.platform] = requested

    wire_menu(monkeypatch, [aboard, auto], FakeUI, FakeInstaller)

    assert cli.catalogue_menu() == 0
    assert [event[:2] for event in events] == [
        ("intro", "harness"),
        ("multiselect", "Select providers"),
        ("select", "Installation scope"),
        ("multiselect", "Select packages"),
        ("select", "Skill installation"),
        ("note", "Installation Summary"),
        ("confirm", "Proceed with changes?"),
        ("progress", "Applying catalogue changes"),
        ("outro", "Done!  Review installed packages before use."),
    ]
    provider_event = events[1]
    assert provider_event[2] == ["Claude Code", "ChatGPT"]
    package_event = events[3]
    assert package_event[2] == ["aboard"]
    assert [(option.label, option.detail) for option in cli._provider_options()] == [
        ("Claude Code", ""),
        ("ChatGPT", ""),
    ]
    assert reconciled == {
        Platform.CLAUDE: {"aboard"},
        Platform.CHATGPT: {"aboard"},
    }


class ConflictMenuUI:
    """Answer every prompt affirmatively and record the review screens."""

    answer = True

    def __init__(self, read_key):
        pass

    def intro(self, label):
        pass

    def multiselect(self, title, options, selected=None, **settings):
        return {0, 1} if title == "Select providers" else {0}

    def select(self, title, options, default=0):
        return 0

    def note(self, title, lines):
        self.events.append(("note", title, tuple(lines)))

    def confirm(self, title, default=True):
        self.events.append(("confirm", title))
        return self.answer if title != "Proceed with changes?" else True

    def progress(self, active, complete, action):
        return action()

    def outro(self, message):
        self.events.append(("outro", message))

    def cancelled(self, message):
        self.events.append(("cancelled", message))


def wire_conflict_menu(monkeypatch, conflicts, answer):
    events = []
    reconciled = {}

    class FakeUI(ConflictMenuUI):
        pass

    FakeUI.events = events
    FakeUI.answer = answer

    class FakeInstaller:
        def __init__(self, available, target, store):
            self.target = target

        def plan(self, requested):
            return [], [cli.Change("install", name, "selected") for name in requested]

        def conflicts(self, requested):
            return list(conflicts)

        def unowned_host_products(self, requested):
            return {}

        def reconcile(self, requested, overwrite=(), adopt=()):
            reconciled[self.target.platform] = set(overwrite)

    wire_menu(monkeypatch, [discover()["aboard"]], FakeUI, FakeInstaller)
    return events, reconciled


def test_menu_asks_before_overwriting_files_harness_does_not_own(monkeypatch, tmp_path):
    existing = tmp_path / ".claude" / "skills" / "aboard" / "SKILL.md"
    events, reconciled = wire_conflict_menu(monkeypatch, [existing], answer=True)

    assert cli.catalogue_menu() == 0
    assert [event[:2] for event in events] == [
        ("note", "Installation Summary"),
        ("confirm", "Proceed with changes?"),
        ("note", "Existing files"),
        ("confirm", "Overwrite these files?"),
        ("outro", "Done!  Review installed packages before use."),
    ]
    assert str(existing) in "\n".join(events[2][2])
    assert reconciled == {Platform.CLAUDE: {existing}, Platform.CHATGPT: {existing}}


def test_menu_abandons_the_installation_when_the_overwrite_is_refused(monkeypatch, tmp_path):
    existing = tmp_path / ".claude" / "skills" / "aboard" / "SKILL.md"
    events, reconciled = wire_conflict_menu(monkeypatch, [existing], answer=False)

    assert cli.catalogue_menu() == 0
    assert events[-1] == ("cancelled", "Installation cancelled.  No changes made.")
    assert reconciled == {}


def test_already_installed_packages_start_selected(monkeypatch):
    aboard = discover()["aboard"]
    seen = {}

    class FakeUI:
        def __init__(self, read_key):
            pass

        def intro(self, label):
            pass

        def multiselect(self, title, options, selected=None, **settings):
            if title == "Select providers":
                return {0, 1}
            seen["selected"] = selected
            seen["installed"] = {option.label for option in options if option.installed}
            return None

        def select(self, title, options, default=0):
            return 0

        def outro(self, message):
            pass

    wire_menu(monkeypatch, [aboard], FakeUI, None, installed={"aboard"})

    assert cli.catalogue_menu() == 0
    assert seen == {"selected": {0}, "installed": {"aboard"}}


def test_provider_and_scope_prompts_define_the_install_target(monkeypatch):
    aboard = discover()["aboard"]
    planned = []

    class FakeUI:
        def __init__(self, read_key):
            pass

        def intro(self, label):
            pass

        def multiselect(self, title, options, selected=None, **settings):
            return {1} if title == "Select providers" else {0}

        def select(self, title, options, default=0):
            assert [(option.label, option.detail) for option in options] == [
                (
                    "Project",
                    "Install in current directory (committed with your project)",
                ),
                (
                    "Global",
                    "Install in home directory (available across all projects)",
                ),
            ]
            return 1

        def outro(self, message):
            pass

    class FakeInstaller:
        def __init__(self, available, target, store):
            self.target = target

        def plan(self, requested):
            planned.append((self.target.platform, self.target.is_user, requested))
            return [], []

    wire_menu(monkeypatch, [aboard], FakeUI, FakeInstaller)

    assert cli.catalogue_menu() == 0
    assert planned == [(Platform.CHATGPT, True, {"aboard"})]


def test_catalogue_rows_are_grouped_by_category_in_reading_order():
    tools = discover()
    ordered = sorted(tools.values(), key=lambda tool: (cli._category_rank(tool), tool.name))
    categories = list(dict.fromkeys(cli._category(tool) for tool in ordered))

    assert categories[0] == "planning"
    assert categories[-1] == "extension"


def test_catalogue_only_labels_unsupported_selected_providers():
    tools = discover()
    options = {
        tool.name: option
        for tool, option in zip(
            (tools["aboard"], tools["on-edit-block"]),
            cli._tool_options(
                [tools["aboard"], tools["on-edit-block"]],
                set(),
                (Platform.CLAUDE, Platform.CHATGPT),
            ),
        )
    }

    assert options["aboard"].badge == ""
    assert options["on-edit-block"].badge == "ChatGPT not supported"
    claude_only = cli._tool_options(
        [tools["on-edit-block"]], set(), (Platform.CLAUDE,)
    )
    assert claude_only[0].badge == ""


def test_review_scope_does_not_leak_the_installation_path(tmp_path):
    target = Target.for_project(tmp_path, Platform.CLAUDE)

    lines = cli._review_lines(
        [discover()["aboard"]],
        {"aboard"},
        [target],
        {Platform.CLAUDE: []},
    )

    assert lines[0] == "  Install to  Project"
    assert str(tmp_path) not in "\n".join(lines)


def test_dependencies_install_transitively_and_receipts_track_ownership(tmp_path):
    tools = discover()
    target = Target.for_project(tmp_path)
    selected = manager(tools, target, tmp_path)
    resolved, _ = selected.plan({"aboard"})
    receipts = {item.tool.name: item.explicit for item in resolved}
    assert receipts["aboard"] is True
    for dependency in ("auto", "issue-readers"):
        assert receipts[dependency] is False
    assert "address-this" not in receipts
    assert "review-this" not in receipts


def test_uninstall_removes_coupled_dependencies_and_retains_shared_dependencies(tmp_path):
    def package(name, dependencies=""):
        root = tmp_path / name
        root.mkdir()
        (root / "payload").write_text(name)
        (root / "harness.toml").write_text(
            f'name="{name}"\nversion="1.0.0"\ndescription="x"\n'
            f"{dependencies}"
            '[platforms.claude]\nstatus="supported"\n'
            f'[[files]]\nsrc="payload"\ndest="{name}"\n'
        )
        return load_tool(root)

    leaf = package("leaf")
    shared = package("shared", 'dependencies=[{name="leaf"}]\n')
    coupled = package("coupled")
    parent = package(
        "parent",
        'dependencies=[{name="shared"}, {name="coupled", lifecycle="coupled"}]\n',
    )
    tools = {tool.name: tool for tool in (parent, shared, coupled, leaf)}
    selected = manager(tools, Target.for_project(tmp_path / "project"), tmp_path)
    selected.reconcile({"parent"})
    selected.installation["packages"]["parent"].pop("coupledDependencies")

    assert selected.reconcile(set()) == [
        Change("retain", "shared"),
        Change("remove", "parent"),
        Change("remove", "coupled"),
    ]
    assert set(selected.installation["packages"]) == {"shared", "leaf"}
    assert selected.installation["packages"]["shared"]["ownership"] == "retained"
    assert selected.installation["packages"]["leaf"]["ownership"] == "dependency"

    assert selected.reconcile({"shared"}) == []
    assert selected.reconcile(set()) == [Change("retain", "leaf"), Change("remove", "shared")]
    assert selected.reconcile(set()) == [Change("remove", "leaf")]
    assert selected.installation["packages"] == {}


def test_dependency_cycle_is_rejected(tmp_path):
    def package(name, dependency):
        root = tmp_path / name
        root.mkdir()
        (root / "payload").write_text(name)
        (root / "harness.toml").write_text(
            f'name="{name}"\nversion="1.0.0"\ndescription="x"\n'
            f'dependencies=["{dependency}"]\n[platforms.claude]\nstatus="supported"\n'
            f'[[files]]\nsrc="payload"\ndest="{name}"\n'
        )
        return load_tool(root)

    tools = {"a": package("a", "b"), "b": package("b", "a")}
    with pytest.raises(CatalogueError, match="a -> b -> a"):
        resolve_dependencies([tools["a"]], tools)


def test_collision_is_detected_before_writing(tmp_path):
    def package(name):
        root = tmp_path / name
        root.mkdir()
        (root / "payload").write_text(name)
        (root / "harness.toml").write_text(
            f'name="{name}"\nversion="1.0.0"\ndescription="x"\n'
            '[platforms.claude]\nstatus="supported"\n'
            '[[files]]\nsrc="payload"\ndest="same.txt"\n'
        )
        return load_tool(root)

    tools = {name: package(name) for name in ("a", "b")}
    target = Target.for_project(tmp_path / "project")
    with pytest.raises(InstallError, match="file collision"):
        manager(tools, target, tmp_path).reconcile({"a", "b"})
    assert not target.install_root.exists()


@pytest.mark.parametrize("destination", ["..", "C:/outside/payload", "nested/../payload"])
def test_manifest_rejects_destinations_outside_their_logical_root(tmp_path, destination):
    root = tmp_path / "unsafe-destination"
    root.mkdir()
    (root / "payload").write_text("x")
    (root / "harness.toml").write_text(
        'name="unsafe-destination"\nversion="1.0.0"\ndescription="x"\n'
        '[platforms.claude]\nstatus="supported"\n'
        f'[[files]]\nsrc="payload"\ndest="{destination}"\n'
    )

    with pytest.raises(ManifestError, match="unsafe dest"):
        load_tool(root)


@pytest.mark.parametrize("source", ["..", "C:/outside/payload", "nested/../payload"])
def test_manifest_rejects_sources_outside_the_catalogue_package(tmp_path, source):
    root = tmp_path / "unsafe-source"
    root.mkdir()
    (root / "harness.toml").write_text(
        'name="unsafe-source"\nversion="1.0.0"\ndescription="x"\n'
        '[platforms.claude]\nstatus="supported"\n'
        f'[[files]]\nsrc="{source}"\ndest="payload"\n'
    )

    with pytest.raises(ManifestError, match="unsafe src"):
        load_tool(root)


def test_uninstall_does_not_delete_an_identical_preexisting_file(tmp_path):
    root = tmp_path / "identical"
    root.mkdir()
    (root / "payload").write_text("user and catalogue agree")
    (root / "harness.toml").write_text(
        'name="identical"\nversion="1.0.0"\ndescription="x"\n'
        '[platforms.claude]\nstatus="supported"\n'
        '[[files]]\nsrc="payload"\ndest="skills/identical/SKILL.md"\n'
    )
    tool = load_tool(root)
    target = Target.for_project(tmp_path / "project")
    destination = target.install_root / "skills/identical/SKILL.md"
    destination.parent.mkdir(parents=True)
    destination.write_text("user and catalogue agree")
    selected = manager({tool.name: tool}, target, tmp_path)

    selected.reconcile({tool.name})
    selected.reconcile(set())

    assert destination.read_text() == "user and catalogue agree"


def test_uninstall_does_not_remove_an_identical_preexisting_hook(tmp_path):
    root = tmp_path / "identical-hook"
    root.mkdir()
    (root / "payload").write_text("x")
    hook = {"type": "command", "command": "mine"}
    fragment = {"hooks": {"UserPromptSubmit": [{"hooks": [hook]}]}}
    (root / "fragment.json").write_text(json.dumps(fragment))
    (root / "harness.toml").write_text(
        'name="identical-hook"\nversion="1.0.0"\ndescription="x"\n'
        '[platforms.claude]\nstatus="supported"\nfragment="fragment.json"\n'
        '[[files]]\nsrc="payload"\ndest="payload"\n'
    )
    tool = load_tool(root)
    target = Target.for_project(tmp_path / "project")
    target.settings_path.parent.mkdir(parents=True)
    target.settings_path.write_text(json.dumps(fragment))
    selected = manager({tool.name: tool}, target, tmp_path)

    selected.reconcile({tool.name})
    selected.reconcile(set())

    assert target.read_settings() == fragment


def test_removing_one_package_keeps_a_hook_still_required_by_another(tmp_path):
    tools = {}
    for name in ("first", "second"):
        root = tmp_path / name
        root.mkdir()
        (root / "payload").write_text(name)
        (root / "fragment.json").write_text(json.dumps({
            "hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": "shared"}]}]}
        }))
        (root / "harness.toml").write_text(
            f'name="{name}"\nversion="1.0.0"\ndescription="x"\n'
            '[platforms.claude]\nstatus="supported"\nfragment="fragment.json"\n'
            f'[[files]]\nsrc="payload"\ndest="{name}.txt"\n'
        )
        tools[name] = load_tool(root)
    target = Target.for_project(tmp_path / "project")
    selected = manager(tools, target, tmp_path)
    selected.reconcile({"first", "second"})
    selected.reconcile({"second"})

    settings = target.read_settings()
    assert settings["hooks"]["UserPromptSubmit"][0]["hooks"] == [
        {"type": "command", "command": "shared"}
    ]


def test_reconcile_repairs_a_missing_owned_file_at_the_same_version(tmp_path):
    tool = discover()["caveman"]
    target = Target.for_project(tmp_path / "project")
    selected = manager({tool.name: tool}, target, tmp_path)
    selected.reconcile({tool.name})
    skill = target.install_root / "skills/caveman/SKILL.md"
    skill.unlink()

    _resolved, changes = selected.plan({tool.name})
    selected.reconcile({tool.name})

    assert changes == [Change("update", tool.name, "missing installed files")]
    assert skill.is_file()


def test_shared_symlink_skill_upgrades_across_both_providers(tmp_path):
    root = tmp_path / "shared-skill"
    root.mkdir()
    (root / "SKILL.md").write_text("first version", encoding="utf-8")
    manifest = root / "harness.toml"

    def tool(version):
        manifest.write_text(
            f'name="shared-skill"\nversion="{version}"\ndescription="x"\n'
            '[platforms.claude]\nstatus="supported"\n'
            '[platforms.chatgpt]\nstatus="supported"\n'
            '[[files]]\nsrc="SKILL.md"\ndest="shared-skill/SKILL.md"\nroot="skills"\n',
            encoding="utf-8",
        )
        return load_tool(root)

    project = tmp_path / "project"
    project.mkdir()
    store = ReceiptStore.load(tmp_path / "receipts.json")

    def install(selected):
        installers = [
            CatalogueInstaller({selected.name: selected}, Target.for_project(project, platform), store,
                               skill_mode="symlink")
            for platform in (Platform.CLAUDE, Platform.CHATGPT)
        ]
        reconcile_targets([(installer, {selected.name}) for installer in installers])

    install(tool("1.0.0"))
    (root / "SKILL.md").write_text("second version", encoding="utf-8")
    install(tool("1.1.0"))

    assert (project / ".agents/skills/shared-skill/SKILL.md").read_text() == "second version"
    assert (project / ".claude/skills/shared-skill").is_symlink()


def test_shared_skill_is_removed_after_one_provider_upgrades_then_both_uninstall(tmp_path):
    root = tmp_path / "shared-skill"
    root.mkdir()
    manifest = root / "harness.toml"

    def tool(version, content):
        (root / "SKILL.md").write_text(content, encoding="utf-8")
        manifest.write_text(
            f'name="shared-skill"\nversion="{version}"\ndescription="x"\n'
            '[platforms.claude]\nstatus="supported"\n'
            '[platforms.chatgpt]\nstatus="supported"\n'
            '[[files]]\nsrc="SKILL.md"\ndest="shared-skill/SKILL.md"\nroot="skills"\n',
            encoding="utf-8",
        )
        return load_tool(root)

    project = tmp_path / "project"
    project.mkdir()
    store = ReceiptStore.load(tmp_path / "receipts.json")

    def installer(selected, platform):
        return CatalogueInstaller({selected.name: selected}, Target.for_project(project, platform), store,
                                  skill_mode="symlink")

    old = tool("1.0.0", "first")
    reconcile_targets([
        (installer(old, platform), {old.name})
        for platform in (Platform.CLAUDE, Platform.CHATGPT)
    ])
    new = tool("1.1.0", "second")
    installer(new, Platform.CLAUDE).reconcile({new.name})
    installer(new, Platform.CLAUDE).reconcile(set())
    installer(new, Platform.CHATGPT).reconcile(set())

    assert not (project / ".agents/skills/shared-skill/SKILL.md").exists()
    assert not (project / ".claude/skills/shared-skill").is_symlink()


def test_receipt_paths_cannot_escape_the_target_root(tmp_path):
    tool = discover()["caveman"]
    target = Target.for_project(tmp_path / "project")
    store = ReceiptStore.load(tmp_path / "receipts.json")
    installation = store.installation(target.scope_root, target.platform.value, create=True)
    installation["packages"][tool.name] = {
        "version": tool.version,
        "explicit": True,
        "dependencies": [],
        "files": [{"path": str(tmp_path / "outside.txt"), "owned": True, "digest": ""}],
        "actions": [],
    }
    selected = CatalogueInstaller({tool.name: tool}, target, store)

    with pytest.raises(InstallError, match="escapes target root"):
        selected.plan({tool.name})


def test_workspace_files_can_be_limited_to_project_installs(tmp_path):
    root = tmp_path / "scoped"
    root.mkdir()
    (root / "payload").write_text("starter")
    (root / "harness.toml").write_text(
        'name="scoped"\nversion="1.0.0"\ndescription="x"\n'
        '[platforms.claude]\nstatus="supported"\n'
        '[[files]]\nsrc="payload"\ndest=".harness/agent-launcher/config.py"\n'
        'root="workspace"\nscopes=["project"]\nstarter=true\n'
    )
    tool = load_tool(root)

    assert [item.dest for item in tool.expand("claude", "project")] == [
        ".harness/agent-launcher/config.py"
    ]
    assert tool.expand("claude", "user") == []


def test_installed_hook_definitions_keep_uv_as_a_path_command(tmp_path, monkeypatch):
    root = tmp_path / "portable-uv"
    root.mkdir()
    (root / "hook.py").write_text("pass\n")
    (root / "claude.json").write_text(json.dumps({
        "hooks": {"PostToolUse": [{"hooks": [{
            "type": "command",
            "command": "${PYTHON}",
            "args": ["${CLAUDE_DIR}/hooks/hook.py"],
        }]}]},
    }))
    (root / "chatgpt.json").write_text(json.dumps({
        "hooks": {"PostToolUse": [{
            "type": "command",
            "command": '${PYTHON} "${HOOKS_DIR}/hook.py"',
        }]},
    }))
    (root / "harness.toml").write_text(
        'name="portable-uv"\nversion="1.0.0"\ndescription="x"\n'
        '[platforms.claude]\nstatus="supported"\nfragment="claude.json"\n'
        '[platforms.chatgpt]\nstatus="supported"\nfragment="chatgpt.json"\n'
        '[[files]]\nsrc="hook.py"\ndest="hook.py"\nroot="hooks"\n'
    )
    tool = load_tool(root)
    monkeypatch.setattr(
        "harness_cli.installer.shutil.which",
        lambda name: "/opt/uv/bin/uv" if name == "uv" else None,
    )

    claude = Target.for_project(tmp_path / "claude-project", Platform.CLAUDE)
    manager({tool.name: tool}, claude, tmp_path / "claude-receipts").reconcile({tool.name})
    claude_hook = claude.read_settings()["hooks"]["PostToolUse"][0]["hooks"][0]
    assert claude_hook["command"] == "uv"
    assert claude_hook["args"][:3] == ["run", "--no-project", "--no-managed-python"]

    chatgpt = Target.for_project(tmp_path / "chatgpt-project", Platform.CHATGPT)
    manager({tool.name: tool}, chatgpt, tmp_path / "chatgpt-receipts").reconcile({tool.name})
    chatgpt_hook = chatgpt.read_settings()["hooks"]["PostToolUse"][0]
    assert chatgpt_hook["command"].startswith("uv run --no-project --no-managed-python ")
    assert "/opt/uv/bin/uv" not in chatgpt_hook["command"]


@pytest.mark.parametrize("scopes", ['"project"', '["machine"]', '[]'])
def test_manifest_rejects_invalid_file_scopes(tmp_path, scopes):
    root = tmp_path / "invalid-scopes"
    root.mkdir()
    (root / "payload").write_text("x")
    (root / "harness.toml").write_text(
        'name="invalid-scopes"\nversion="1.0.0"\ndescription="x"\n'
        '[platforms.claude]\nstatus="supported"\n'
        f'[[files]]\nsrc="payload"\ndest="payload"\nscopes={scopes}\n'
    )

    with pytest.raises(ManifestError, match="files.scopes"):
        load_tool(root)


def test_manifest_rejects_uv_tool_source_without_full_commit_sha(tmp_path):
    root = tmp_path / "mutable-uv-tool-source"
    root.mkdir()
    (root / "harness.toml").write_text(
        'name="mutable-uv-tool-source"\nversion="1.0.0"\ndescription="x"\n'
        '[platforms.claude]\nstatus="supported"\n'
        '[[actions]]\ntype="uv-tool"\npackage="example"\n'
        'source="git+https://example.test/harness@v1.0.0"\n'
    )

    with pytest.raises(ManifestError, match="full commit SHA"):
        load_tool(root)


def test_receipt_driven_uninstall_keeps_modified_files(tmp_path):
    tool = discover()["caveman"]
    target = Target.for_project(tmp_path / "project")
    selected = manager({tool.name: tool}, target, tmp_path)
    selected.reconcile({tool.name})
    skill = target.install_root / "skills/caveman/SKILL.md"
    skill.write_text("mine")
    selected.reconcile(set())
    assert skill.read_text() == "mine"
    assert selected.installation["packages"] == {}


def transactional_package(tmp_path, name, *, action=False):
    root = tmp_path / name
    root.mkdir()
    (root / "payload").write_text(name)
    (root / "fragment.json").write_text('{"env": {"PACKAGE": "installed"}}')
    manifest = (
        f'name="{name}"\nversion="1.0.0"\ndescription="x"\n'
        'gitignore=["generated"]\n'
        '[platforms.claude]\nstatus="supported"\nfragment="fragment.json"\n'
        f'[[files]]\nsrc="payload"\ndest="{name}.txt"\n'
    )
    if action:
        manifest += (
            '[[actions]]\ntype="uv-tool"\n'
            'source="git+https://example.test/harness@0123456789abcdef0123456789abcdef01234567"\n'
            f'package="{name}-test"\n'
        )
    (root / "harness.toml").write_text(manifest)
    return load_tool(root)


def test_selection_changes_preserve_existing_version_and_payload(tmp_path):
    from dataclasses import replace

    old = transactional_package(tmp_path, "existing")
    new = transactional_package(tmp_path, "addition")
    project = tmp_path / "project"
    store = ReceiptStore.load(tmp_path / "receipts.json")
    target = Target.for_project(project, "claude")
    CatalogueInstaller({old.name: old}, target, store).reconcile({old.name})
    (old.root / "payload").write_text("updated payload")
    latest = replace(old, version="2.0.0")
    installer = CatalogueInstaller({old.name: latest, new.name: new}, target, store)
    installer.update_packages = set()

    changes = installer.reconcile({old.name, new.name})

    assert [(change.action, change.package) for change in changes] == [("install", new.name)]
    assert (target.install_root / "existing.txt").read_text() == "existing"
    assert installed_packages(target, store)[old.name]["version"] == "1.0.0"


@pytest.mark.parametrize("constraint, expected_version", [(">=1.0.0", "1.0.0"), (">=2.0.0", "2.0.0")])
def test_new_selection_updates_dependency_only_when_required(tmp_path, constraint, expected_version):
    from dataclasses import replace
    from harness_cli.manifest import PackageDependency

    old = transactional_package(tmp_path, "dependency")
    parent = transactional_package(tmp_path, "parent")
    project = tmp_path / "project"
    store = ReceiptStore.load(tmp_path / "receipts.json")
    target = Target.for_project(project, "claude")
    CatalogueInstaller({old.name: old}, target, store).reconcile({old.name})
    (old.root / "payload").write_text("updated dependency")
    latest = replace(old, version="2.0.0")
    parent = replace(parent, dependencies=(PackageDependency(old.name, constraint),))
    installer = CatalogueInstaller({old.name: latest, parent.name: parent}, target, store)
    installer.update_packages = set()

    installer.reconcile({old.name, parent.name})

    assert installed_packages(target, store)[old.name]["version"] == expected_version
    assert (target.install_root / "dependency.txt").read_text() == (
        "updated dependency" if expected_version == "2.0.0" else "dependency"
    )


def test_removing_selection_preserves_kept_packages_and_their_old_dependencies(tmp_path):
    from dataclasses import replace
    from harness_cli.manifest import PackageDependency

    kept = transactional_package(tmp_path, "kept")
    removed = transactional_package(tmp_path, "removed")
    dependency = transactional_package(tmp_path, "dependency")
    kept = replace(kept, dependencies=(PackageDependency(dependency.name, lifecycle="coupled"),))
    store = ReceiptStore.load(tmp_path / "receipts.json")
    target = Target.for_project(tmp_path / "project", "claude")
    available = {tool.name: tool for tool in (kept, removed, dependency)}
    CatalogueInstaller(available, target, store).reconcile({kept.name, removed.name})
    available[kept.name] = replace(kept, version="2.0.0", dependencies=())
    (kept.root / "payload").write_text("new kept")
    # User edits to a package being kept must not prevent unrelated removal.
    (target.install_root / "kept.txt").write_text("user edit")
    installer = CatalogueInstaller(available, target, store)
    installer.update_packages = set()

    installer.reconcile({kept.name})

    assert (target.install_root / "kept.txt").read_text() == "user edit"
    assert not (target.install_root / "removed.txt").exists()
    receipt = installed_packages(target, store)[kept.name]
    assert receipt["version"] == "1.0.0"
    assert receipt["dependencies"] == [dependency.name]
    assert receipt["coupledDependencies"] == [dependency.name]
    assert (target.install_root / "dependency.txt").is_file()


@pytest.mark.parametrize("choose_update", [False, True])
def test_menu_optional_updates_are_applied_only_when_selected(tmp_path, monkeypatch, choose_update):
    from dataclasses import replace

    old = transactional_package(tmp_path, "existing")
    addition = transactional_package(tmp_path, "addition")
    project = tmp_path / "project"
    project.mkdir()
    store = ReceiptStore.load(tmp_path / "receipts.json")
    target = Target.for_project(project, "claude")
    CatalogueInstaller({old.name: old}, target, store).reconcile({old.name})
    (old.root / "payload").write_text("updated")
    latest = replace(old, version="2.0.0")
    update_screens = []

    class FakeUI:
        def __init__(self, read_key):
            pass

        def intro(self, message):
            pass

        def multiselect(self, title, options, selected=None, **settings):
            if title == "Select providers":
                return {0}
            if title == "Select packages":
                return set(range(len(options)))
            update_screens.append((options, selected, settings))
            return {0} if choose_update else set()

        def select(self, *args, **kwargs):
            return 0

        def note(self, *args):
            pass

        def confirm(self, *args, **kwargs):
            return True

        def outro(self, *args):
            pass

        def progress(self, label, success, action):
            action()

    monkeypatch.chdir(project)
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(cli.sys, "stdin", InteractiveInput())
    monkeypatch.setattr(cli, "terminal_keys", lambda: nullcontext(lambda: None))
    monkeypatch.setattr(cli, "TerminalUI", FakeUI)
    monkeypatch.setattr(cli, "discover", lambda: {old.name: latest, addition.name: addition})
    monkeypatch.setattr(cli.ReceiptStore, "load", lambda: store)

    assert cli.catalogue_menu() == 0
    assert len(update_screens) == 1
    options, selected, settings = update_screens[0]
    assert [option.label for option in options] == [old.name]
    assert selected == set()
    assert settings["select_all"] is True
    assert (target.install_root / "existing.txt").read_text() == ("updated" if choose_update else "existing")
    assert installed_packages(target, store)[old.name]["version"] == ("2.0.0" if choose_update else "1.0.0")
    assert (target.install_root / "addition.txt").is_file()


def test_multi_target_reconciliation_rolls_every_target_back(tmp_path):
    root = tmp_path / "dual"
    root.mkdir()
    (root / "payload").write_text("catalogue")
    (root / "harness.toml").write_text(
        'name="dual"\nversion="1.0.0"\ndescription="x"\n'
        '[platforms.claude]\nstatus="supported"\n'
        '[platforms.chatgpt]\nstatus="supported"\n'
        '[[files]]\nsrc="payload"\ndest="payload.txt"\n'
    )
    tool = load_tool(root)
    project = tmp_path / "project"
    conflicting = project / ".codex" / "payload.txt"
    conflicting.parent.mkdir(parents=True)
    conflicting.write_text("user-owned")
    store = ReceiptStore.load(tmp_path / "receipts.json")
    claude = CatalogueInstaller({tool.name: tool}, Target.for_project(project, "claude"), store)
    chatgpt = CatalogueInstaller({tool.name: tool}, Target.for_project(project, "chatgpt"), store)

    with pytest.raises(InstallError, match="unowned file"):
        reconcile_targets([(claude, {tool.name}), (chatgpt, {tool.name})])

    assert not (project / ".claude" / "payload.txt").exists()
    assert conflicting.read_text() == "user-owned"
    assert not store.path.exists()


def dual_platform_package(tmp_path):
    root = tmp_path / "dual"
    root.mkdir()
    (root / "payload").write_text("catalogue")
    (root / "harness.toml").write_text(
        'name="dual"\nversion="1.0.0"\ndescription="x"\n'
        '[platforms.claude]\nstatus="supported"\n'
        '[platforms.chatgpt]\nstatus="supported"\n'
        '[[files]]\nsrc="payload"\ndest="payload.txt"\n'
    )
    return load_tool(root)


def test_multi_target_reconciliation_overwrites_every_approved_file(tmp_path):
    tool = dual_platform_package(tmp_path)
    project = tmp_path / "project"
    conflicting = project / ".codex" / "payload.txt"
    conflicting.parent.mkdir(parents=True)
    conflicting.write_text("user-owned")
    store = ReceiptStore.load(tmp_path / "receipts.json")
    claude = CatalogueInstaller({tool.name: tool}, Target.for_project(project, "claude"), store)
    chatgpt = CatalogueInstaller({tool.name: tool}, Target.for_project(project, "chatgpt"), store)

    reconcile_targets([(claude, {tool.name}), (chatgpt, {tool.name})], overwrite={conflicting})

    assert conflicting.read_text() == "catalogue"
    assert (project / ".claude" / "payload.txt").read_text() == "catalogue"


def test_unowned_destination_is_reported_with_the_paths_it_would_overwrite(tmp_path):
    tool = transactional_package(tmp_path, "conflicting")
    project = tmp_path / "project"
    existing = project / ".claude" / "conflicting.txt"
    existing.parent.mkdir(parents=True)
    existing.write_text("written by hand")
    target = Target.for_project(project)
    selected = manager({tool.name: tool}, target, tmp_path)

    with pytest.raises(UnownedFileError) as error:
        selected.reconcile({tool.name})

    assert error.value.paths == (existing.resolve(),)
    assert existing.read_text() == "written by hand"
    assert selected.installation["packages"] == {}


def test_approved_overwrite_installs_the_payload_and_takes_ownership(tmp_path):
    tool = transactional_package(tmp_path, "conflicting")
    project = tmp_path / "project"
    existing = project / ".claude" / "conflicting.txt"
    existing.parent.mkdir(parents=True)
    existing.write_text("written by hand")
    target = Target.for_project(project)
    selected = manager({tool.name: tool}, target, tmp_path)

    selected.reconcile({tool.name}, overwrite={existing})

    assert existing.read_text() == "conflicting"

    selected.reconcile(set())

    assert not existing.exists()


def secretive_package(tmp_path):
    root = tmp_path / "secretive"
    root.mkdir()
    (root / "payload").write_text("secretive")
    (root / "harness.toml").write_text(
        'name="secretive"\nversion="1.0.0"\ndescription="x"\n'
        'workspace_gitignore=[".harness/config.local.json"]\n'
        '[platforms.claude]\nstatus="supported"\n[platforms.chatgpt]\nstatus="supported"\n'
        '[[files]]\nsrc="payload"\ndest="secretive.txt"\n'
    )
    return load_tool(root)


def test_project_install_keeps_secret_ignores_inside_their_directories(tmp_path):
    tool = secretive_package(tmp_path)
    project = tmp_path / "project"
    project.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=project, check=True)
    (project / ".gitignore").write_text("user-rule\n")
    selected = manager({tool.name: tool}, Target.for_project(project), tmp_path)

    selected.reconcile({tool.name})

    assert (project / ".gitignore").read_text() == "user-rule\n"
    assert "config.local.json" in (project / ".harness/.gitignore").read_text().splitlines()
    secret = project / ".harness/config.local.json"
    secret.write_text("{}")
    assert subprocess.run(
        ["git", "check-ignore", "--no-index", "-q", str(secret)], cwd=project
    ).returncode == 0


@pytest.mark.parametrize("platform, directory", [(Platform.CLAUDE, ".claude"), (Platform.CHATGPT, ".codex")])
def test_commit_install_ignores_local_files_without_editing_project_gitignore(tmp_path, platform, directory):
    tool = discover()["commit"]
    project = tmp_path / "project"
    project.mkdir()
    (project / ".gitignore").write_text("user-rule\n")
    selected = manager({tool.name: tool}, Target.for_project(project, platform), tmp_path)

    selected.reconcile({tool.name})

    assert (project / ".gitignore").read_text() == "user-rule\n"
    assert {"commit-ai.key", "settings.local.json"} <= set(
        (project / directory / ".gitignore").read_text().splitlines()
    )


def test_upgrade_moves_existing_secret_ignore_out_of_project_gitignore(tmp_path):
    tool = secretive_package(tmp_path)
    project = tmp_path / "project"
    secret = project / ".harness/config.local.json"
    secret.parent.mkdir(parents=True)
    secret.write_text("{}")
    root_ignore = project / ".gitignore"
    root_ignore.write_text(
        "user-rule\n\n# >>> harness:secretive:claude >>>\n"
        ".harness/config.local.json\n# <<< harness:secretive:claude <<<\n"
    )
    selected = manager({tool.name: tool}, Target.for_project(project), tmp_path)
    selected.installation["packages"][tool.name] = {
        "version": "0.9.0",
        "ownership": "selected",
        "files": [],
        "gitignoreBlock": "secretive:claude",
        "gitignorePatterns": [".harness/config.local.json"],
    }

    selected.reconcile({tool.name})

    assert root_ignore.read_text() == "user-rule\n"
    assert "config.local.json" in (project / ".harness/.gitignore").read_text().splitlines()


def test_shared_workspace_ignore_stays_until_its_last_installation_is_removed(tmp_path):
    tool = secretive_package(tmp_path)
    project = tmp_path / "project"
    project.mkdir()
    store = ReceiptStore.load(tmp_path / "receipts.json")
    claude, chatgpt = (
        CatalogueInstaller({tool.name: tool}, Target.for_project(project, platform), store)
        for platform in (Platform.CLAUDE, Platform.CHATGPT)
    )
    claude.reconcile({tool.name})
    chatgpt.reconcile({tool.name})

    claude.reconcile(set())

    assert "config.local.json" in (project / ".harness/.gitignore").read_text().splitlines()
    assert not (project / ".gitignore").exists()

    chatgpt.reconcile(set())

    assert not (project / ".harness/.gitignore").exists()


def test_uninstall_keeps_ignoring_files_the_user_left_behind(tmp_path):
    tool = secretive_package(tmp_path)
    project = tmp_path / "project"
    secret = project / ".harness" / "config.local.json"
    secret.parent.mkdir(parents=True)
    secret.write_text("{}")
    selected = manager({tool.name: tool}, Target.for_project(project), tmp_path)
    selected.reconcile({tool.name})

    selected.reconcile(set())

    assert "config.local.json" in (project / ".harness/.gitignore").read_text().splitlines()
    assert not (project / ".gitignore").exists()

    selected.reconcile({tool.name})
    secret.unlink()
    selected.reconcile(set())

    assert not (project / ".harness/.gitignore").exists()


def test_failed_host_action_rolls_back_local_installation(monkeypatch, tmp_path):
    tool = transactional_package(tmp_path, "failing", action=True)
    project = tmp_path / "project"
    project.mkdir()
    (project / ".gitignore").write_text("existing\n")
    target = Target.for_project(project)
    selected = manager({tool.name: tool}, target, tmp_path)

    monkeypatch.setattr(
        "harness_cli.installer.prepare_host_action",
        lambda action: PreparedAction(action),
    )
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda action: False)
    monkeypatch.setattr(
        "harness_cli.installer.apply_host_action",
        lambda action: (_ for _ in ()).throw(HostActionError("host failed")),
    )

    with pytest.raises(InstallError, match="host failed"):
        selected.reconcile({tool.name})

    assert (project / ".gitignore").read_text() == "existing\n"
    assert not target.settings_path.exists()
    assert not (target.install_root / "failing.txt").exists()
    assert selected.installation["packages"] == {}
    assert not selected.store.path.exists()


def test_receipt_failure_undoes_completed_host_action(monkeypatch, tmp_path):
    tool = transactional_package(tmp_path, "failing", action=True)
    target = Target.for_project(tmp_path / "project")
    selected = manager({tool.name: tool}, target, tmp_path)
    applied = []
    removed = []

    monkeypatch.setattr(
        "harness_cli.installer.prepare_host_action",
        lambda action: PreparedAction(action),
    )
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda action: False)
    monkeypatch.setattr("harness_cli.installer.apply_host_action", lambda prepared: applied.append(prepared.action))
    monkeypatch.setattr("harness_cli.installer.uninstall_host_action", removed.append)
    monkeypatch.setattr(
        selected.store,
        "save",
        lambda: (_ for _ in ()).throw(OSError("receipt failed")),
    )

    with pytest.raises(InstallError, match="receipt failed"):
        selected.reconcile({tool.name})

    assert removed == applied
    assert not (target.install_root / "failing.txt").exists()
    assert selected.installation["packages"] == {}


def test_failed_upgrade_restores_previous_files_receipt_and_host_action(monkeypatch, tmp_path):
    old = transactional_package(tmp_path, "upgrade", action=True)
    target = Target.for_project(tmp_path / "project")
    selected = manager({old.name: old}, target, tmp_path)
    applied = []
    removed = []

    monkeypatch.setattr(
        "harness_cli.installer.prepare_host_action",
        lambda action: PreparedAction(action),
    )
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda action: False)
    monkeypatch.setattr("harness_cli.installer.apply_host_action", lambda prepared: applied.append(prepared.action))
    monkeypatch.setattr("harness_cli.installer.uninstall_host_action", removed.append)
    selected.reconcile({old.name})
    applied.clear()

    old.root.joinpath("payload").write_text("new")
    manifest = old.root / "harness.toml"
    manifest.write_text(manifest.read_text().replace('version="1.0.0"', 'version="2.0.0"'))
    upgraded = load_tool(old.root)
    selected.available = {upgraded.name: upgraded}
    monkeypatch.setattr(
        selected.store,
        "save",
        lambda: (_ for _ in ()).throw(OSError("receipt failed")),
    )

    with pytest.raises(InstallError, match="receipt failed"):
        selected.reconcile({upgraded.name})

    assert (target.install_root / "upgrade.txt").read_text() == "upgrade"
    assert selected.installation["packages"][old.name]["version"] == "1.0.0"
    assert len(applied) == 2
    assert removed == [upgraded.actions[0]]


def test_later_failure_restores_package_removed_earlier_in_reconciliation(monkeypatch, tmp_path):
    old = transactional_package(tmp_path, "old", action=True)
    failing = transactional_package(tmp_path, "failing", action=True)
    target = Target.for_project(tmp_path / "project")
    selected = manager({old.name: old, failing.name: failing}, target, tmp_path)
    applied = []
    removed = []
    fail_host_action = {"enabled": False}

    def apply(prepared):
        if fail_host_action["enabled"] and prepared.action == failing.actions[0]:
            raise HostActionError("host failed")
        applied.append(prepared.action)

    monkeypatch.setattr(
        "harness_cli.installer.prepare_host_action",
        lambda action: PreparedAction(action),
    )
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda action: False)
    monkeypatch.setattr("harness_cli.installer.apply_host_action", apply)
    monkeypatch.setattr("harness_cli.installer.uninstall_host_action", removed.append)
    selected.reconcile({old.name})
    applied.clear()
    payload = target.install_root / "old.txt"
    before = payload.read_bytes()
    fail_host_action["enabled"] = True

    with pytest.raises(InstallError, match="host failed"):
        selected.reconcile({failing.name})

    assert payload.read_bytes() == before
    assert set(selected.installation["packages"]) == {old.name}
    assert removed == [old.actions[0]]
    assert applied == [old.actions[0]]


def test_every_catalogue_manifest_loads():
    tools = discover()
    assert {"aboard", "subagents", "issue-readers", "issue-writers"} <= tools.keys()
    assert {
        "address-this", "review-this", "harness-cli", "communication-hooks",
        "improve-codebase-architecture", "senior-advisor", "grill-me-in-lavish",
    }.isdisjoint(tools)
    expected_categories = {
        "planning": {
            "audit", "breakdown-help-wanted-issue", "grill-me", "grill-me-in-cloud", "lavish", "prototype",
            "read-all-adrs", "websearch", "writing-adrs",
        },
        "engineering": {"commit", "resolving-merge-conflicts", "setup-git-worktree-maker"},
        "building": {"issue-readers", "issue-writers", "tdd"},
        "shipping": {"setup-help"},
        "productivity": {
            "agent-launcher", "caveman", "setup-command-aliases", "handoff", "handoff-grilling", "mid-prompt-skills", "decisions", "report-gotchas", "subagents", "next-decision",
            "setup-text-replacements", "todo-hitl", "writing-for-agents", "stop-overthinking", "zoom-out",
        },
        "guards": {
            "command-guard", "no-new-documents", "on-edit-block", "on-edit-reminder", "on-read-reminder",
            "prefer-edit-tool", "prefer-fewer-comments", "prefer-read-tool",
            "redirect-subagents", "usage-limit-wait",
        },
        "extension": {"aboard", "auto"},
    }
    actual_categories = {}
    catalogue_root = next(parent for parent in tools["aboard"].root.parents if parent.name == "harness")
    for name, tool in tools.items():
        category = tool.root.relative_to(catalogue_root).parts[0]
        actual_categories.setdefault(category, set()).add(name)
    assert actual_categories == expected_categories


def test_vsix_is_verified_before_host_install(monkeypatch):
    content = b"signed release artifact"
    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: io.BytesIO(content))
    action = HostAction(
        "vscode-extension",
        {
            "url": "https://example.test/download/v1/app.vsix",
            "size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "extension_id": "example.app",
        },
    )
    prepared = prepare(action)
    try:
        assert prepared.artifact.read_bytes() == content
    finally:
        prepared.cleanup()

    broken = HostAction("vscode-extension", {**action.data, "sha256": "0" * 64})
    with pytest.raises(HostActionError, match="SHA-256"):
        prepare(broken)


def test_private_github_vsix_uses_the_logged_in_gh_credential(monkeypatch):
    content = b"private signed release artifact"
    release_url = (
        "https://github.com/example/private/releases/download/aboard-v1.2.3/aboard-1.2.3.vsix"
    )
    asset_url = "https://api.github.com/repos/example/private/releases/assets/123"
    requests = []
    monkeypatch.delenv("GH_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setattr("harness_cli.host_actions.shutil.which", lambda command: f"/bin/{command}")
    monkeypatch.setattr(
        "harness_cli.host_actions.subprocess.run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "secret-token\n", ""),
    )

    def urlopen(request, timeout):
        requests.append(request)
        if request.full_url.endswith("/releases/tags/aboard-v1.2.3"):
            payload = {"assets": [{"name": "aboard-1.2.3.vsix", "url": asset_url}]}
            return io.BytesIO(json.dumps(payload).encode())
        assert request.full_url == asset_url
        assert request.get_header("Authorization") == "Bearer secret-token"
        assert request.get_header("Accept") == "application/octet-stream"
        return io.BytesIO(content)

    monkeypatch.setattr("urllib.request.urlopen", urlopen)
    action = HostAction(
        "vscode-extension",
        {
            "url": release_url,
            "size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "extension_id": "aboard.aboard",
        },
    )

    prepared = prepare(action)
    try:
        assert prepared.artifact.read_bytes() == content
        assert len(requests) == 2
    finally:
        prepared.cleanup()


def test_uninstalling_a_host_product_that_is_already_gone_succeeds(monkeypatch):
    commands = []

    def run(command, capture_output, text):
        commands.append(command)
        if command[1] == "--list-extensions":
            return subprocess.CompletedProcess(command, 0, "other.extension\n", "")
        return subprocess.CompletedProcess(command, 1, "", "Extension 'example.app' is not installed.")

    monkeypatch.setattr(
        "harness_cli.host_actions.shutil.which",
        lambda name: "/bin/code" if name == "code" else None,
    )
    monkeypatch.setattr("harness_cli.host_actions.subprocess.run", run)

    uninstall(HostAction("vscode-extension", {"extension_id": "example.app"}))

    assert all("--uninstall-extension" not in command for command in commands)


def test_removal_survives_a_receipt_artifact_that_no_longer_downloads(monkeypatch, tmp_path):
    tool = transactional_package(tmp_path, "pinned", action=True)
    target = Target.for_project(tmp_path / "project")
    selected = manager({tool.name: tool}, target, tmp_path)
    removed = []

    monkeypatch.setattr(
        "harness_cli.installer.prepare_host_action",
        lambda action: PreparedAction(action),
    )
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda action: False)
    monkeypatch.setattr("harness_cli.installer.apply_host_action", lambda prepared: None)
    monkeypatch.setattr("harness_cli.installer.uninstall_host_action", removed.append)
    selected.reconcile({tool.name})

    monkeypatch.setattr(
        "harness_cli.installer.prepare_host_action",
        lambda action: (_ for _ in ()).throw(HostActionError("HTTP Error 404: Not Found")),
    )

    assert selected.reconcile(set()) == [Change("remove", tool.name)]
    assert removed == [tool.actions[0]]
    assert selected.installation["packages"] == {}
    assert not (target.install_root / "pinned.txt").exists()


def test_reconcile_repairs_a_host_product_that_vanished_at_the_same_version(monkeypatch, tmp_path):
    tool = transactional_package(tmp_path, "hosted", action=True)
    target = Target.for_project(tmp_path / "project")
    selected = manager({tool.name: tool}, target, tmp_path)
    applied = []
    host = {"present": False}

    def apply(prepared):
        applied.append(prepared.action)
        host["present"] = True

    monkeypatch.setattr(
        "harness_cli.installer.prepare_host_action",
        lambda action: PreparedAction(action),
    )
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda action: host["present"])
    monkeypatch.setattr("harness_cli.installer.apply_host_action", apply)
    monkeypatch.setattr("harness_cli.installer.uninstall_host_action", lambda action: None)
    selected.reconcile({tool.name})
    applied.clear()

    assert selected.plan({tool.name})[1] == []

    host["present"] = False

    _resolved, changes = selected.plan({tool.name})
    selected.reconcile({tool.name})

    assert changes == [Change("update", tool.name, "missing host product")]
    assert applied == [tool.actions[0]]
    assert host["present"] is True


def test_repeated_host_product_checks_reuse_one_listing(monkeypatch):
    listings = []
    installed = {"example.app"}

    def run(command, capture_output, text):
        if command[1] == "--list-extensions":
            listings.append(command)
            return subprocess.CompletedProcess(command, 0, "".join(f"{name}\n" for name in installed), "")
        installed.discard(command[2])
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(
        "harness_cli.host_actions.shutil.which",
        lambda name: "/bin/code" if name == "code" else None,
    )
    monkeypatch.setattr("harness_cli.host_actions.subprocess.run", run)
    action = HostAction("vscode-extension", {"extension_id": "example.app"})

    assert is_installed(action)
    assert is_installed(action)
    assert len(listings) == 1

    uninstall(action)

    assert not is_installed(action)
    assert len(listings) == 2


def test_repair_applies_to_each_package_that_lost_files(tmp_path):
    alpha = transactional_package(tmp_path, "alpha")
    zulu = transactional_package(tmp_path, "zulu")
    target = Target.for_project(tmp_path / "project")
    selected = manager({alpha.name: alpha, zulu.name: zulu}, target, tmp_path)
    selected.reconcile({alpha.name, zulu.name})
    lost = target.install_root / "alpha.txt"
    lost.unlink()

    _resolved, changes = selected.plan({alpha.name, zulu.name})
    selected.reconcile({alpha.name, zulu.name})

    assert changes == [Change("update", alpha.name, "missing installed files")]
    assert lost.is_file()


def test_review_lists_additions_before_removals_and_flags_removals(tmp_path):
    lines = cli._review_lines(
        [],
        set(),
        [Target.for_project(tmp_path, Platform.CLAUDE), Target.for_project(tmp_path, Platform.CHATGPT)],
        {
            Platform.CLAUDE: [Change("remove", "issue-writers"), Change("install", "commit")],
            Platform.CHATGPT: [Change("remove", "issue-writers")],
        },
    )
    marked = [line for line in lines if line.startswith("    +") or line.startswith("    -")]

    assert marked == [
        "    + install (1)  commit",
        "    - remove  (1)  issue-writers",
        "    - remove  (1)  issue-writers",
    ]
    assert [line.tone for line in marked] == ["success", "danger", "danger"]


def test_review_lists_retained_packages_without_explanatory_suffix(tmp_path):
    lines = cli._review_lines(
        [],
        set(),
        [Target.for_project(tmp_path, Platform.CLAUDE)],
        {Platform.CLAUDE: [Change("retain", "issue-readers")]},
    )

    assert "    = retain (1)  issue-readers" in lines


def test_removing_the_last_hook_leaves_an_empty_codex_config(tmp_path):
    root = tmp_path / "hooked"
    root.mkdir()
    (root / "payload").write_text("hook")
    (root / "fragment.json").write_text(
        '{"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": "run"}]}]}}'
    )
    (root / "harness.toml").write_text(
        'name="hooked"\nversion="1.0.0"\ndescription="x"\n'
        '[platforms.chatgpt]\nstatus="supported"\nfragment="fragment.json"\n'
        '[[files]]\nsrc="payload"\ndest="hooked.txt"\n'
    )
    tool = load_tool(root)
    target = Target.for_project(tmp_path / "project", Platform.CHATGPT)
    selected = manager({tool.name: tool}, target, tmp_path)
    selected.reconcile({tool.name})

    assert target.settings_path.name == "hooks.json"
    assert target.read_settings()["hooks"]["UserPromptSubmit"]

    selected.reconcile(set())

    assert target.settings_path.is_file()
    assert target.read_settings() == {}


def test_unowned_host_products_are_reported_together_and_by_name(monkeypatch, tmp_path):
    alpha = transactional_package(tmp_path, "alpha", action=True)
    zulu = transactional_package(tmp_path, "zulu", action=True)
    target = Target.for_project(tmp_path / "project")
    selected = manager({alpha.name: alpha, zulu.name: zulu}, target, tmp_path)
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda action: True)

    assert selected.unowned_host_products({alpha.name, zulu.name}) == {
        "alpha": ["uv tool alpha-test"],
        "zulu": ["uv tool zulu-test"],
    }

    with pytest.raises(UnownedHostProductError) as error:
        selected.reconcile({alpha.name, zulu.name})

    assert error.value.products == (
        "uv tool alpha-test (alpha)",
        "uv tool zulu-test (zulu)",
    )
    assert selected.installation["packages"] == {}
    assert not (target.install_root / "alpha.txt").exists()


def test_adopting_an_unowned_host_product_takes_ownership_of_it(monkeypatch, tmp_path):
    tool = transactional_package(tmp_path, "adopted", action=True)
    target = Target.for_project(tmp_path / "project")
    selected = manager({tool.name: tool}, target, tmp_path)
    applied = []
    removed = []

    monkeypatch.setattr(
        "harness_cli.installer.prepare_host_action",
        lambda action: PreparedAction(action),
    )
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda action: True)
    monkeypatch.setattr("harness_cli.installer.apply_host_action", lambda prepared: applied.append(prepared.action))
    monkeypatch.setattr("harness_cli.installer.uninstall_host_action", removed.append)

    selected.reconcile({tool.name}, adopt={tool.name})

    assert applied == [tool.actions[0]]
    assert selected.installation["packages"][tool.name]["actions"] == [
        {"type": "uv-tool", **tool.actions[0].data}
    ]

    selected.reconcile(set())

    assert removed == [tool.actions[0]]


def wire_adoption_menu(monkeypatch, products, answer):
    events = []
    reconciled = {}

    class FakeUI(ConflictMenuUI):
        pass

    FakeUI.events = events
    FakeUI.answer = answer

    class FakeInstaller:
        def __init__(self, available, target, store):
            self.target = target

        def plan(self, requested):
            return [], [cli.Change("install", name, "selected") for name in requested]

        def conflicts(self, requested):
            return []

        def unowned_host_products(self, requested):
            return dict(products)

        def reconcile(self, requested, overwrite=(), adopt=()):
            reconciled[self.target.platform] = set(adopt)

    wire_menu(monkeypatch, [discover()["aboard"]], FakeUI, FakeInstaller)
    return events, reconciled


def test_menu_asks_before_taking_over_host_products_harness_does_not_own(monkeypatch):
    events, reconciled = wire_adoption_menu(
        monkeypatch, {"subagents": ["uv tool harness-subagents-runtime"]}, answer=True
    )

    assert cli.catalogue_menu() == 0
    assert [event[:2] for event in events] == [
        ("note", "Installation Summary"),
        ("confirm", "Proceed with changes?"),
        ("note", "Existing host products"),
        ("confirm", "Take ownership of these?"),
        ("outro", "Done!  Review installed packages before use."),
    ]
    assert "uv tool harness-subagents-runtime  (subagents)" in "\n".join(events[2][2])
    assert reconciled == {Platform.CLAUDE: {"subagents"}, Platform.CHATGPT: {"subagents"}}


def test_menu_abandons_the_installation_when_adoption_is_refused(monkeypatch):
    events, reconciled = wire_adoption_menu(
        monkeypatch, {"subagents": ["uv tool harness-subagents-runtime"]}, answer=False
    )

    assert cli.catalogue_menu() == 0
    assert events[-1] == ("cancelled", "Installation cancelled.  No changes made.")
    assert reconciled == {}
