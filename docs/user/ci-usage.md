# CI usage and releases

Harness uses a release-first policy for its private GitHub repository. Pushes,
pull requests, and schedules do not start workflows. Checks and reference updates
run through GitHub Actions' **Run workflow** button or `gh workflow run`.

## Free-account budget

For a private repository on GitHub Free,
[GitHub's billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
provides $12 of included monthly compute, 500 MB of artifact storage shared with
Packages, and a separate 10 GB cache allowance per repository. One third of the
compute allowance is **$4**, equivalent to about **667 standard Linux minutes**.
The allowance is shared across the owner's private repositories and other eligible
compute usage; it is not reserved for Harness.

[Runner prices](https://docs.github.com/en/billing/reference/actions-runner-pricing)
are $0.006/minute for standard Linux and $0.010/minute for Windows. Each job rounds
up to a whole minute. Public repositories using standard runners have free compute.

| Workflow | Trigger | Jobs and configured timeout budget |
| --- | --- | --- |
| Release Aboard | Manual, version required | One Linux job, 15 minutes (about $0.09) |
| Harness CI | Manual | Linux Python 3.11 tests and distribution validation, plus selection/result jobs; 25 minutes total (about $0.15) |
| Harness CI with `full=true` | Explicit manual opt-in | Four Python compatibility jobs, Linux/Windows real-CLI E2E, distribution and selection/result jobs; about $0.89 total |
| Aboard CI | Manual | One Linux job, 15 minutes (about $0.09) |
| Update documentation references | Manual | One Linux job, 10 minutes (about $0.06) |
| Verify release pins | Manual | One Linux job, 5 minutes (about $0.03) |

These are planning estimates from configured timeouts, not measured successful
durations or enforced monthly caps. Runner setup, cleanup, rounding, retries, and
other repositories need headroom. For example, **20 releases plus 10 default
Harness CI runs** budget about **$3.30**, below the $4 target before that overhead.
Routine background usage is zero. Full compatibility runs are expensive and should
normally run locally. Check account usage before requesting them.

Workflows do not upload Actions artifacts; Aboard publishes its VSIX directly to
a GitHub Release. Standard runners in a public repository do not consume the
private-repository compute allowance. Making the repository public does not
automatically re-enable disabled workflows or restore their removed triggers.

## Running checks and releasing

```powershell
gh workflow run ci.yml
gh workflow run ci.yml -f full=true
gh workflow run aboard-ci.yml
gh workflow run update-references.yml
gh workflow run verify-release-pins.yml
gh workflow run release-aboard.yml -f version=<version-in-apps/aboard/package.json>
```

Release Aboard checks out `main`, validates matching package/lockfile versions,
installs dependencies, runs the npm audit, unit tests and VS Code integration tests,
and packages the VSIX before publishing an immutable `aboard-v<version>` release.
It then opens a catalogue-pin pull request. Retries reuse an already-published asset.
The budget change preserves these checks and publication behavior. There is no
separate Python/PyPI publication workflow in this repository.

During the audit, the four non-release workflows were disabled through GitHub's API
to stop existing automatic triggers immediately; Release Aboard remained active.
After these manual-only workflow definitions reach the default branch, re-enable
whichever checks you need, then dispatch them:

```powershell
gh workflow enable ci.yml
gh workflow enable aboard-ci.yml
gh workflow enable update-references.yml
gh workflow enable verify-release-pins.yml
```

Do not enable the old definitions before that change lands, since they still have
push, pull-request, or scheduled triggers.

Release jobs can be blocked by account billing restrictions or dependency-audit
failures. Resolve those failures before publication; changing repository visibility
does not repair dependency vulnerabilities.
