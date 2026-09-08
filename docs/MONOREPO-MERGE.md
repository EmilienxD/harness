# Aboard monorepo merge

The repository boundary should be:

```text
Harness repository
├── harness/          catalogue packages
├── src/harness_cli/  Python installer and session CLI
└── apps/aboard/      VS Code extension and its npm package
```

Do not flatten Aboard into the Python project, publish the VSIX in the Python wheel, use Git
submodules, or copy only the current Aboard tree. A history-preserving subtree gives one clone and
one issue/release surface while keeping the two build systems independent.

After the Harness and Aboard redesign changes are committed on their respective branches, import
Aboard without squashing:

```bash
git remote add aboard C:/Users/emb/dev/aboard
git fetch aboard dev
git subtree add --prefix=apps/aboard aboard dev
```

Omitting `--squash` is intentional: the subtree merge commit has both repositories' histories as
ancestors, so blame and log remain useful. Run this with a clean Harness worktree because
`git subtree add` creates the history-joining commit itself.

Then make one monorepo follow-up commit that:

1. changes Aboard's `repository.url` to the Harness repository;
2. updates Aboard workflows to run from `apps/aboard` and adds path filters;
3. publishes VSIX assets with `aboard-v<version>` tags;
4. updates `harness/aboard/harness.toml` with the release URL, exact byte size, and SHA-256;
5. updates repository-level ignore and contributor docs without duplicating either build's rules.

Keep releases independent. Harness Python tags can remain `v<version>`; Aboard uses
`aboard-v<version>`. The installer consumes only an immutable Aboard release artifact and therefore
does not need Node.js or Aboard source at runtime.

Once the merged repository is verified, archive the old Aboard repository rather than deleting it.
Its default-branch README should point to the monorepo, and no new releases should be published from
the archived repository.
