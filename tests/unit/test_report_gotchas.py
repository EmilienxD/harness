from harness_cli.manifest import SupportStatus, discover


def test_catalogue_installs_one_shared_skill_and_cli_without_provider_hooks() -> None:
    tool = discover()["report-gotchas"]
    assert tool.version == "2.0.0"
    assert tool.requires == ()
    assert tool.dependencies == ()
    assert len(tool.actions) == 1
    assert tool.actions[0].data["package"] == "harness-report-gotchas-runtime"
    skills = []
    for platform in ("claude", "chatgpt", "pi"):
        assert tool.support_for(platform).status is SupportStatus.SUPPORTED
        assert not tool.fragment_for(platform)
        files = list(tool.expand(platform))
        assert all(entry.root == "skills" for entry in files)
        skills.append(next(entry.source for entry in files if entry.dest == "report-gotchas/SKILL.md"))
    assert len(set(skills)) == 1
