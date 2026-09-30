"""Deterministic Lead tool actions. Executed only by the real provider's shell tool."""
import json
from pathlib import Path
import re
import subprocess
import sys

root = Path(__file__).resolve().parent
fixture = json.loads((root / "fixture.json").read_text(encoding="utf-8"))
repo = root / "repository"
record_path = root / "run.json"
record = json.loads(record_path.read_text(encoding="utf-8")) if record_path.exists() else {}
record.setdefault("issues", dict(fixture["issues"]))
for key in ("base", "anchor", "children", "prs", "feedback", "reports", "created_issues", "merged", "syncs", "launch_refusals", "released"):
    record.setdefault(key, [] if key in {"created_issues", "merged", "launch_refusals", "released"} else {})
target = fixture["target"]
repository = fixture["repository"]


def run(*args, cwd=repo, ok=(0,)):
    result = subprocess.run(list(args), cwd=cwd, capture_output=True, text=True, encoding="utf-8")
    if result.returncode not in ok:
        raise RuntimeError(f"{' '.join(args[:3])} failed with exit {result.returncode}: {result.stderr.strip()[:500]}")
    return result.stdout.strip()


def worktree(unit):
    return root / f"wt-{unit}"


def issue(unit):
    return record["issues"][unit]


def lookup(child):
    return json.loads(run("harness", "loop", "lookup", record["children"][child]))


def reported(child, expected):
    info = lookup(child)
    report = info["last_report"]
    assert report and report["event"] == "report" and expected in report["report"], f"{child} has not reported {expected}"
    assert info["wait"]["state"] == "waiting", f"{child} is not waiting for the Lead"
    record["reports"].setdefault(child, []).append(report)
    return info


def gate(child, info):
    count = re.search(rf"HARNESS_SHIP_REPORT_{child}_(\d+)", info["last_report"]["report"]).group(1)
    return f"HARNESS_SHIP_GATE_{child}_{count}"


def ensure_label(name):
    existing = {item["name"] for item in json.loads(run("gh", "label", "list", "--repo", repository, "--limit", "200", "--json", "name"))}
    if name not in existing:
        run("gh", "label", "create", name, "--repo", repository)


def claim(unit):
    ensure_label("[AI]-in-progress")
    run("gh", "issue", "edit", str(issue(unit)), "--repo", repository, "--add-label", "[AI]-in-progress")


def prepare(unit):
    spec = fixture["units"][unit]
    run("git", "fetch", "--quiet", "origin", target)
    start = run("git", "rev-parse", f"origin/{target}")
    # The project's worktree script is the only supported way to create a worktree.
    run(sys.executable, str(root / "make_worktree.py"), str(worktree(unit)), f"{fixture['branch_prefix']}-{unit}", start)
    record["base"][unit] = run("git", "rev-parse", "HEAD", cwd=worktree(unit))
    for relative, content in spec["criteria"].items():
        path = worktree(unit) / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    red = subprocess.run([sys.executable, "-m", "pytest", spec["test"], "-q", "-p", "no:cacheprovider"], cwd=worktree(unit), capture_output=True, text=True)
    assert red.returncode == 1 and "1 failed" in red.stdout, "criteria stub must fail on its deliberate assertion"
    (root / "evidence").mkdir(exist_ok=True)
    (root / "evidence" / f"anchor-{unit}-red.txt").write_text(red.stdout, encoding="utf-8")
    run("git", "add", *spec["criteria"], cwd=worktree(unit))
    run("git", "commit", "-m", "Define success criteria", cwd=worktree(unit))
    record["anchor"][unit] = run("git", "rev-parse", "HEAD", cwd=worktree(unit))


def launch(unit, child):
    result = subprocess.run(["harness", "loop", "launch", "--cwd", str(worktree(unit)), "--prompt-file", str(root / f"implementer-{child}.md")],
                            cwd=repo, capture_output=True, text=True, encoding="utf-8")
    if result.returncode:
        return result.stderr.strip()
    record["children"][child] = json.loads(result.stdout)["session_id"]
    return None


def release(child, info=None):
    info = info or lookup(child)
    run("harness", "loop", "release", record["children"][child], "--wait-token", info["wait"]["token"])
    assert lookup(child)["active"] is False
    record["released"].append(child)


def publish(unit, draft, body):
    # Stage only this unit's work; checkout-local configuration is never delivered.
    spec = fixture["units"][unit]
    run("git", "add", "--", *[path for path in (spec["module"], spec["test"], spec["workflow"]) if (worktree(unit) / path).exists()], cwd=worktree(unit))
    if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=worktree(unit)).returncode:
        run("git", "commit", "-m", f"Deliver {unit}", cwd=worktree(unit))
    run("git", "push", "--quiet", "--set-upstream", "origin", f"{fixture['branch_prefix']}-{unit}", cwd=worktree(unit))
    (root / f"pr-{unit}.md").write_text(body, encoding="utf-8")
    if unit in record["prs"]:
        run("gh", "pr", "edit", record["prs"][unit], "--body-file", str(root / f"pr-{unit}.md"), cwd=worktree(unit))
        return
    arguments = ["gh", "pr", "create", "--repo", repository, "--base", target, "--head", f"{fixture['branch_prefix']}-{unit}",
                 "--title", f"E2E ship {unit}", "--body-file", str(root / f"pr-{unit}.md")]
    record["prs"][unit] = run(*arguments, *(["--draft"] if draft else []), cwd=worktree(unit))


def comment(unit, text):
    (root / f"comment-{unit}.md").write_text(text, encoding="utf-8")
    run("gh", "issue", "comment", str(issue(unit)), "--repo", repository, "--body-file", str(root / f"comment-{unit}.md"))


def sync(unit):
    before = run("git", "rev-parse", "HEAD", cwd=worktree(unit))
    run("git", "fetch", "--quiet", "origin", target, cwd=worktree(unit))
    run("git", "merge", "--no-edit", f"origin/{target}", cwd=worktree(unit))
    record["syncs"][unit] = record["syncs"].get(unit, 0) + 1
    return before != run("git", "rev-parse", "HEAD", cwd=worktree(unit))


def closeout(unit, child, expected, mode):
    info = reported(child, expected)
    spec = fixture["units"][unit]
    # One target sync per acceptance; these fixtures are built on the latest target.
    assert not sync(unit), "target moved; a confirming round would be required"
    run("test-workflows", "confirm", spec["workflow"], cwd=worktree(unit))
    status = json.loads(run("test-workflows", "status", cwd=worktree(unit)))
    assert all(item["state"] == "passed" for item in status["workflows"]), status
    contract = json.loads(run("ship-stubs", "check", "--base", record["base"][unit], "--anchor", record["anchor"][unit], cwd=worktree(unit)))
    assert contract["state"] == "pass", contract
    record.setdefault("contracts", {})[unit] = contract
    body = (f"Adds the {unit} staging greeting CLI so users can verify delivery. It fills the anchored stub and greeting workflow.\n\n"
            f"Staging: run python {spec['module']}; expect Hello staging.\n\nNew tools: none needed.\n\nRefs #{issue(unit)}\n")
    publish(unit, False, body)
    if mode == "ready":
        run("gh", "pr", "ready", record["prs"][unit], cwd=worktree(unit))
    comment(unit, f"Delivered as {record['prs'][unit]}; every stub test and workflow passed. Awaiting staging verification.\n")
    if mode == "merge":
        run("gh", "pr", "merge", record["prs"][unit], "--squash", cwd=worktree(unit))
        record["merged"].append(unit)
    release(child, info)


def blocker(unit, child, expected, kind):
    reported(child, expected)
    labels = ["[AI]-help-wanted"] + (["[AI]-auto-merge"] if kind == "auto" else [])
    for label in labels:
        ensure_label(label)
    (root / "blocker.md").write_text(f"Prerequisite for #{issue(unit)}: provide the missing greeting prerequisite.\n", encoding="utf-8")
    url = run("gh", "issue", "create", "--repo", repository, "--title", f"E2E ship prerequisite {fixture['branch_prefix']}",
              "--body-file", str(root / "blocker.md"), *[item for label in labels for item in ("--label", label)])
    number = int(url.rstrip("/").split("/")[-1])
    record["created_issues"].append(number)
    record["issues"]["blk"] = number
    original = json.loads(run("issue-context", str(issue(unit))))
    prerequisite = json.loads(run("issue-context", str(number)))
    run("gh", "api", "graphql", "-f", "query=mutation($issue:ID!,$blocker:ID!){addBlockedBy(input:{issueId:$issue,blockingIssueId:$blocker}){issue{number}}}",
        "-f", f"issue={original['id']}", "-f", f"blocker={prerequisite['id']}")
    linked = json.loads(run("issue-context", str(issue(unit))))
    assert [item["number"] for item in linked["blocked_by"]] == [number], linked["blocked_by"]


def decision(unit, child, question):
    info = lookup(child)
    body = f"Work preserved for a decision.\n\nQuestion: {question}\n\nRefs #{issue(unit)}\n"
    publish(unit, True, body)
    ensure_label("[AI]-needs-decision")
    run("gh", "issue", "edit", str(issue(unit)), "--repo", repository, "--add-label", "[AI]-needs-decision")
    comment(unit, f"Decision needed: {question} Draft: {record['prs'][unit]}\n")
    release(child, info)


def loop_limits():
    config = json.loads((repo / ".harness" / "config.json").read_text(encoding="utf-8")).get("loop", {})
    return config.get("maxFeedback", 3), config.get("maxImplementers", 2)


def resume(child, info, extra=""):
    (root / f"resume-{child}.md").write_text(f"{gate(child, info)}\n{extra}Implement the greeting, fill the stub, run the stub test and workflow, and report evidence.\n", encoding="utf-8")
    record.setdefault("resumed", []).append(json.loads(run("harness", "loop", "resume", record["children"][child], "--file", str(root / f"resume-{child}.md")))["session_id"])


def log(text):
    # Retained beside the fixture: the Lead's tool output lives only in its transcript.
    with open(root.parent / f"{root.name}.driver.log", "a", encoding="utf-8") as handle:
        handle.write(f"{' '.join(sys.argv[1:])}: {text}\n")


def failed(kind, value, traceback):
    log(f"{kind.__name__}: {value}")
    sys.__excepthook__(kind, value, traceback)


sys.excepthook = failed
log("start")
step, *args = sys.argv[1:]
if step == "select":
    (unit,) = args
    context = json.loads(run("issue-context", "--select"))
    assert context["number"] == issue(unit), f"selected {context['number']}"
    claim(unit)
    prepare(unit)
elif step == "leaves":
    parent, order = args
    leaves = json.loads(run("issue-context", str(issue(parent)), "--leaves"))
    record["leaf_order"] = [item["number"] for item in leaves]
    assert record["leaf_order"] == [issue(key) for key in order.split(",")], record["leaf_order"]
elif step == "claim":
    claim(args[0])
elif step == "prepare":
    prepare(args[0])
elif step == "launch":
    unit, child = args
    error = launch(unit, child)
    assert error is None, error
elif step == "feedback":
    child, rounds, expected = args
    info = reported(child, expected)
    max_feedback, _ = loop_limits()
    assert record["feedback"].get(child, 0) < max_feedback, "feedback budget exhausted"
    (root / f"feedback-{child}.md").write_text(f"{gate(child, info)}\nFill the stub and implement the greeting, then report each check with evidence.\n", encoding="utf-8")
    run("harness", "loop", "feedback", record["children"][child], "--wait-token", info["wait"]["token"], "--file", str(root / f"feedback-{child}.md"))
    record["feedback"][child] = record["feedback"].get(child, 0) + 1
    assert record["feedback"][child] == int(rounds)
elif step == "release":
    release(args[0])
elif step == "closeout":
    closeout(*args)
elif step == "blocker":
    blocker(*args)
elif step == "decision":
    unit, child = args
    decision(unit, child, "The greeting depends on an unavailable external service; implement it without that service?")
elif step == "sync-resume":
    unit, child = args
    assert sync(unit), "the delivered prerequisite must reach the original branch"
    resume(child, lookup(child))
elif step == "resume-pr":
    unit, child = args
    pr = record["prs"][unit]
    view = json.loads(run("gh", "pr", "view", pr, "--json", "body,reviews,comments,headRefName,isDraft"))
    decisions = [item["body"] for item in view["reviews"] + view["comments"] if "Decision:" in item["body"]]
    assert decisions, "the user's review decision was not found"
    assert view["headRefName"] == f"{fixture['branch_prefix']}-{unit}" and f"Refs #{issue(unit)}" in view["body"]
    listed = run("git", "worktree", "list", "--porcelain")
    assert f"branch refs/heads/{view['headRefName']}" in listed, "the branch worktree must be reused"
    info = lookup(child)
    percent = (info["context_usage"] or {}).get("used_percentage")
    fresh_percent = json.loads((repo / ".harness" / "config.json").read_text(encoding="utf-8")).get("loop", {}).get("freshContextPercent", 65)
    assert info["active"] is False and (percent is None or percent < fresh_percent), info
    (root / "review.md").write_text("\n".join(decisions), encoding="utf-8")
    resume(child, info, f"Apply the review decision in {root / 'review.md'}.\n")
elif step == "fresh":
    unit, old, new, expected = args
    info = reported(old, expected)
    max_feedback, _ = loop_limits()
    assert record["feedback"].get(old, 0) >= max_feedback, "fresh implementer is only required after the feedback budget"
    refusal = launch(unit, new)
    assert refusal, "a second active implementer in one worktree must be refused"
    record["launch_refusals"].append(refusal)
    release(old, info)
    inputs = root / f"inputs-{new}"
    inputs.mkdir(exist_ok=True)
    (inputs / "original-prompt.md").write_text((root / f"implementer-{old}.md").read_text(encoding="utf-8"), encoding="utf-8")
    (inputs / "branch.diff").write_text(run("git", "diff", record["base"][unit], cwd=worktree(unit)), encoding="utf-8")
    (inputs / "last-report.json").write_text(json.dumps(info["last_report"]), encoding="utf-8")
    (inputs / "problems.md").write_text("- The stub test still fails after one feedback round.\n", encoding="utf-8")
    error = launch(unit, new)
    assert error is None, error
elif step == "cap":
    unit, child, expected = args
    reported(child, expected)
    _, max_implementers = loop_limits()
    assert len(record["children"]) >= max_implementers, "implementer cap is not exhausted"
    decision(unit, child, f"Two implementers could not make the greeting pass; how should it proceed?")
else:
    raise ValueError("Unknown fixture action")
record_path.write_text(json.dumps(record), encoding="utf-8")
log("complete")
print(json.dumps({"step": step, "complete": True}))
print("HARNESS_SHIP_STEP_OK")
