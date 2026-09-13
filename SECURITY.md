# Security Policy

## Supported versions

Security fixes are provided for the latest released version of Harness and the latest released
version of Aboard. Older releases may be asked to upgrade before a fix is evaluated.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Report it through
[GitHub private vulnerability reporting](https://github.com/EmilienxD/harness/security/advisories/new).

Include, when available:

- the affected Harness or Aboard version and platform;
- the prerequisites and smallest reliable reproduction;
- the security boundary that is crossed and its likely impact;
- whether credentials, user files, repositories, or external services are involved; and
- any suggested mitigation or fix.

Reports will be acknowledged as soon as practical. Validated issues will be coordinated privately
until a fix and release guidance are ready. Please allow time for users to update before publishing
technical details.

## Security-sensitive areas

Harness installs executable hooks and tools into Claude Code and ChatGPT projects. Reports are
especially useful when they concern:

- installation paths, symlinks, receipts, rollback, or removal outside the selected scope;
- command construction, shell boundaries, or executable resolution;
- credential, prompt, transcript, or session-state disclosure;
- Aboard's loopback bridge, endpoint records, tokens, workspace binding, or lifecycle admission;
- Auto Run Git, GitHub, worktree, or permission-policy boundaries; or
- release asset pinning, download verification, or dependency substitution.

Unexpected model output by itself is not a vulnerability unless it crosses one of the product's
enforced trust or permission boundaries.

## Safe research

Use repositories, accounts, credentials, and machines you own or are explicitly authorized to
test. Do not access other users' data, disrupt shared services, or run destructive tests against the
Harness E2E fixture without prior coordination. Stop testing and report immediately if you encounter
data that is not yours.

Good-faith research following this policy will not be treated as malicious activity. This statement
does not authorize testing of third-party products or infrastructure.
