"""Catalogue and installation contract for setup-git-worktree-maker."""

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import SupportStatus, discover
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


def test_setup_git_worktree_maker_installs_shared_skill_for_both_platforms(tmp_path):
    tool = discover()["setup-git-worktree-maker"]

    assert tool.support_for(Platform.CLAUDE).status is SupportStatus.SUPPORTED
    assert tool.support_for(Platform.CHATGPT).status is SupportStatus.SUPPORTED

    installed_bodies = []
    for platform in (Platform.CLAUDE, Platform.CHATGPT):
        project = tmp_path / platform.value
        target = Target.for_project(project, platform)
        installer = CatalogueInstaller(
            {tool.name: tool},
            target,
            ReceiptStore.load(tmp_path / f"{platform.value}-receipts.json"),
        )

        installer.reconcile({tool.name})

        installed_skill = target.destination_path(
            "skills", "setup-git-worktree-maker"
        )
        installed_bodies.append(
            (installed_skill / "SKILL.md").read_text(encoding="utf-8")
        )

    assert installed_bodies[0] == installed_bodies[1]
