from harness_cli.manifest import SupportStatus, discover


def test_catalogue_installs_one_shared_skill_without_host_cli_or_provider_hooks() -> None:
    tool = discover()["report-gotchas"]
    assert tool.version == "2.1.0"
    assert tool.requires == ("git", "uv")
    assert tool.dependencies == ()
    assert not tool.actions
    skills = []
    for platform in ("claude", "chatgpt", "pi"):
        assert tool.support_for(platform).status is SupportStatus.SUPPORTED
        assert not tool.fragment_for(platform)
        files = list(tool.expand(platform))
        assert all(entry.root == "skills" for entry in files)
        skills.append(next(entry.source for entry in files if entry.dest == "report-gotchas/SKILL.md"))
    assert len(set(skills)) == 1
