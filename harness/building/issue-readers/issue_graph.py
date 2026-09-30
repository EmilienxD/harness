"""Full, paginated GitHub context for agent-led issue delivery."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys

from issue_readers_hook import Blocked, current_repository, graphql, ISSUE_URL


IDENTITY = "id number title state url repository{nameWithOwner}"
PAGE = "pageInfo{hasNextPage endCursor}"
CONNECTIONS = {
    "labels": "name",
    "subIssues": IDENTITY,
    "blockedBy": IDENTITY,
    "blocking": IDENTITY,
    "comments": "id author{login} body createdAt url",
    "timelineItems": "... on CrossReferencedEvent {source{__typename ... on PullRequest {id number title state isDraft url repository{nameWithOwner}}}}",
}
EXCLUDED = {"[AI]-in-progress", "[AI]-needs-decision", "[AI]-help-wanted"}


def connection_query(field: str, *, after: bool = False) -> str:
    args = "first:100" + (",after:$cursor" if after else "")
    if field == "timelineItems":
        args += ",itemTypes:[CROSS_REFERENCED_EVENT]"
    return f"{field}({args}){{nodes{{{CONNECTIONS[field]}}} {PAGE}}}"


def issue_query(fields: str, *, after: bool = False) -> str:
    variables = "$owner:String!,$repo:String!,$number:Int!" + (",$cursor:String" if after else "")
    return f"query({variables}){{repository(owner:$owner,name:$repo){{issue(number:$number){{{fields}}}}}}}"


def variables(repository: str, number: int | None = None) -> dict:
    owner, separator, repo = repository.partition("/")
    if not separator or not owner or not repo or "/" in repo:
        raise Blocked("Use a repository in OWNER/REPO form.")
    return {"owner": owner, "repo": repo, **({"number": number} if number else {})}


def get_issue(repository: str, number: int, cwd: Path) -> dict:
    values = variables(repository, number)
    fields = f"{IDENTITY} body createdAt author{{login}} parent{{{IDENTITY}}} "
    fields += " ".join(connection_query(field) for field in CONNECTIONS)
    raw = (graphql(issue_query(fields), values, cwd).get("repository") or {}).get("issue")
    if not raw:
        raise Blocked(f"Issue {repository}#{number} was not found.")
    collected = {}
    for field in CONNECTIONS:
        page = raw.get(field) or {}
        nodes = list(page.get("nodes") or [])
        seen = set()
        while (page.get("pageInfo") or {}).get("hasNextPage"):
            cursor = page["pageInfo"].get("endCursor")
            if not cursor or cursor in seen:
                raise Blocked(f"GitHub pagination stalled for {repository}#{number} {field}.")
            seen.add(cursor)
            data = graphql(issue_query(connection_query(field, after=True), after=True),
                           {**values, "cursor": cursor}, cwd)
            page = data["repository"]["issue"][field]
            nodes.extend(page.get("nodes") or [])
        collected[field] = [node for node in nodes if node]
    result = {key: value for key, value in raw.items() if key not in CONNECTIONS}
    result["repository"] = repository
    result["labels"] = [label["name"] for label in collected["labels"]]
    for source, dest in (("subIssues", "sub_issues"), ("blockedBy", "blocked_by"),
                         ("blocking", "blocking"), ("comments", "comments")):
        result[dest] = collected[source]
    prs = {}
    for event in collected["timelineItems"]:
        source = event.get("source") or {}
        if source.get("__typename") == "PullRequest":
            prs[source.get("url") or source.get("id")] = source
    result["mentioning_prs"] = list(prs.values())
    return result


def eligible(issue: dict) -> bool:
    labels = set(issue["labels"])
    return (issue["state"] == "OPEN" and "[AI]-triaged" in labels and not labels & EXCLUDED
            and not any(item["state"] == "OPEN" for item in issue["blocked_by"])
            and not any(item["state"] == "OPEN" for item in issue["sub_issues"]))


def select_issue(repository: str, cwd: Path) -> dict | None:
    query = ('query($owner:String!,$repo:String!,$cursor:String){repository(owner:$owner,name:$repo){'
             'issues(first:100,after:$cursor,states:[OPEN],labels:["[AI]-triaged"],orderBy:{field:CREATED_AT,direction:ASC})'
             '{nodes{number} ' + PAGE + '}}}')
    cursor = None
    seen = set()
    while True:
        page = graphql(query, {**variables(repository), "cursor": cursor}, cwd)["repository"]["issues"]
        for candidate in page["nodes"]:
            issue = get_issue(repository, candidate["number"], cwd)
            if eligible(issue):
                return issue
        if not page["pageInfo"]["hasNextPage"]:
            return None
        cursor = page["pageInfo"].get("endCursor")
        if not cursor or cursor in seen:
            raise Blocked("GitHub issue selection pagination stalled.")
        seen.add(cursor)


def leaf_issues(issue: dict, cwd: Path) -> list[dict]:
    """Expand the sub-issue tree, then topologically order its open leaves."""
    documents = {}
    descendants = {}
    visiting = set()

    def identity(item: dict, fallback: str) -> tuple[str, int]:
        repo = item.get("repository") or fallback
        return (repo.get("nameWithOwner", fallback) if isinstance(repo, dict) else repo, item["number"])

    def visit(document: dict) -> list[tuple[str, int]]:
        key = identity(document, issue["repository"])
        if key in visiting:
            raise Blocked("Sub-issue cycle prevents delivery ordering.")
        if key in descendants:
            return descendants[key]
        visiting.add(key)
        documents[key] = document
        leaves = []
        for child in document["sub_issues"]:
            child_key = identity(child, key[0])
            leaves.extend(visit(get_issue(*child_key, cwd)))
        if not document["sub_issues"] and document["state"] == "OPEN":
            leaves = [key]
        visiting.remove(key)
        descendants[key] = list(dict.fromkeys(leaves))
        return descendants[key]

    leaves = visit(issue)
    dependencies = {key: set() for key in leaves}
    for ancestor, document in documents.items():
        for blocker in document["blocked_by"]:
            if blocker["state"] != "OPEN":
                continue
            blocker_key = identity(blocker, ancestor[0])
            for leaf in descendants[ancestor]:
                dependencies[leaf].update(descendants.get(blocker_key, []))
    pending = list(leaves)
    ordered = []
    while pending:
        ready = next((key for key in pending if not dependencies[key].intersection(pending)), None)
        if ready is None:
            raise Blocked("Dependency cycle prevents leaf delivery ordering.")
        pending.remove(ready)
        ordered.append(documents[ready])
    return ordered


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="issue-context")
    parser.add_argument("issue", nargs="?", help="issue number or GitHub issue URL")
    parser.add_argument("--repo", help="OWNER/REPO; defaults to the checkout remote")
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    parser.add_argument("--select", action="store_true", help="oldest eligible open triaged issue")
    parser.add_argument("--leaves", action="store_true", help="expand to open leaves in dependency order")
    args = parser.parse_args(argv)
    try:
        reference = ISSUE_URL.fullmatch(args.issue or "")
        repository = (f"{reference[1]}/{reference[2]}" if reference else args.repo) or current_repository(args.cwd, "issue-context")
        if args.select:
            if args.issue or args.leaves:
                raise Blocked("--select does not accept an issue or --leaves.")
            result = select_issue(repository, args.cwd)
        else:
            number = int(reference[3] if reference else (args.issue or "0").removeprefix("#"))
            if number <= 0:
                raise Blocked("Supply a positive issue number or --select.")
            result = get_issue(repository, number, args.cwd)
            if args.leaves:
                result = leaf_issues(result, args.cwd)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result is not None else 1
    except (Blocked, ValueError, OSError, subprocess.TimeoutExpired, KeyError, TypeError) as error:
        print(f"issue-context: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
