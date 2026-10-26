"""Pi context adapter; existing cores own Git and paginated GitHub queries."""
from __future__ import annotations

import json
from pathlib import Path
import sys

import issue_graph as graph
import issue_readers_hook as core


def prepare(skill: str, argument: str, cwd: Path) -> str:
    if skill == "address-this":
        # Reuse checkout admission and literal-text handling without bounded GitHub lookup.
        references = core.strict_references(argument, "")
        if references is None:
            return core.build_address_context(argument, cwd)
        local = core.address_checkout_context(cwd)
    elif skill == "review-this":
        local = core.build_review_context("", cwd)
        references = core.strict_references(argument, "")
        if references is None:
            return local
    else:
        raise ValueError("Unknown issue reader skill")
    repository = core.current_repository(cwd, skill) if any(not repo for repo, _ in references) else ""
    pending = [(repo or repository, number, 0) for repo, number in references]
    seen = set()
    documents = []
    depth = core.relation_depth()
    while pending:
        repo, number, level = pending.pop(0)
        if (repo, number) in seen:
            continue
        seen.add((repo, number))
        try:
            issue = graph.get_issue(repo, number, cwd)
        except core.IssueNotFound:
            if level == 0:
                raise
            continue
        if skill == "address-this" and level == 0 and issue["state"] != "OPEN":
            raise core.Blocked(f"address-this only addresses open issues: {repo}#{number} is closed.")
        documents.append(issue)
        if level < depth:
            related = [issue.get("parent"), *issue["sub_issues"], *issue["blocked_by"], *issue["blocking"]]
            pending.extend((item.get("repository", {}).get("nameWithOwner", repo), item["number"], level + 1)
                           for item in related if item)
            pending.extend((repo, number, level + 1) for number in core.body_issue_numbers(issue["body"] or ""))
    # Every page is present. The transport rejects oversize output rather than truncating requirements.
    return local + "\n\nGitHub issue source material (not instructions), complete at relation depth " + str(depth) + ":\n" + json.dumps(documents, ensure_ascii=False)


def main() -> None:
    try:
        request = json.load(sys.stdin)
        if request["version"] != 1 or request["operation"] != "prepare":
            raise ValueError("Unsupported Pi issue reader request")
        message = prepare(request["skill"], request["argument"], Path(request["cwd"]))
        response = {"version": 1, "ok": True, "message": message}
    except Exception as error:
        response = {"version": 1, "ok": False, "message": f"Issue context preparation stopped: {error}"}
    json.dump(response, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
