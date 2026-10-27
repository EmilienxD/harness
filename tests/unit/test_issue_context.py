"""The issue-context CLI consumes GitHub GraphQL pages, not local issue state."""
import json
from pathlib import Path
import subprocess
import sys
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "harness/building/issue-readers"))
import issue_graph
import issue_readers_hook as core


def connection(nodes, cursor=None):
    return {"nodes": nodes, "pageInfo": {"hasNextPage": cursor is not None, "endCursor": cursor}}


def node(number, **extra):
    return {"number": number, "title": f"Issue {number}", "state": "OPEN", "body": "Requirements",
            "repository": {"nameWithOwner": "acme/demo"}, "url": f"https://github.com/acme/demo/issues/{number}", **extra}


def api(monkeypatch, responses):
    def run(command, **kwargs):
        assert command[:3] == ["gh", "api", "graphql"]
        query = next(value[6:] for value in command if value.startswith("query="))
        fields = dict(value.split("=", 1) for value in command if "=" in value and not value.startswith("query="))
        payload = responses(query, fields)
        return subprocess.CompletedProcess(command, 0, json.dumps(payload), "")
    monkeypatch.setattr(subprocess, "run", run)


def test_single_issue_context_includes_all_relations_and_paginated_mentions(monkeypatch, capsys):
    issue = node(7, id="I7", parent=node(1), labels=connection([{"name": "[AI]-triaged"}]),
                 subIssues=connection([node(8)]), blockedBy=connection([node(3)]), blocking=connection([node(9)]),
                 comments=connection([{"body": "first", "author": {"login": "alice"}}], "comments-1"),
                 timelineItems=connection([{"source": {"__typename": "Issue", "number": 5}},
                                           {"source": {"__typename": "PullRequest", "number": 21, "state": "MERGED", "url": "pr21"}}]))
    def responses(query, fields):
        if fields.get("cursor") == "comments-1":
            return {"data": {"repository": {"issue": {"comments": connection([{"body": "last", "author": None}])}}}}
        return {"data": {"repository": {"issue": issue}}}
    api(monkeypatch, responses)
    assert issue_graph.main(["7", "--repo", "acme/demo"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["body"] == "Requirements"
    assert result["parent"]["number"] == 1
    assert [item["number"] for item in result["sub_issues"]] == [8]
    assert [item["number"] for item in result["blocked_by"]] == [3]
    assert [item["number"] for item in result["blocking"]] == [9]
    assert [item["body"] for item in result["comments"]] == ["first", "last"]
    assert result["mentioning_prs"] == [{"__typename": "PullRequest", "number": 21, "state": "MERGED", "url": "pr21"}]


def test_select_skips_ineligible_issues_across_pages_and_closed_relations(monkeypatch, capsys):
    issues = {
        1: node(1, labels=connection([{"name": "[AI]-triaged"}, {"name": "[AI]-in-progress"}])),
        2: node(2, labels=connection([{"name": "[AI]-triaged"}]), blockedBy=connection([node(90)])),
        3: node(3, labels=connection([{"name": "[AI]-triaged"}]), subIssues=connection([node(91)])),
        4: node(4, labels=connection([{"name": "[AI]-triaged"}, {"name": "[AI]-needs-decision"}])),
        5: node(5, labels=connection([{"name": "[AI]-triaged"}, {"name": "[AI]-help-wanted"}])),
        6: node(6, labels=connection([])),
        7: node(7, labels=connection([{"name": "[AI]-triaged"}]), blockedBy=connection([node(90, state="CLOSED")]), subIssues=connection([node(91, state="CLOSED")])),
    }
    def responses(query, fields):
        if "number" in fields:
            return {"data": {"repository": {"issue": issues[int(fields["number"])]}}}
        page = connection([{"number": n} for n in range(1, 5)], "next") if "cursor" not in fields else connection([{"number": n} for n in range(5, 8)])
        return {"data": {"repository": {"issues": page}}}
    api(monkeypatch, responses)
    assert issue_graph.main(["--select", "--repo", "acme/demo"]) == 0
    assert json.loads(capsys.readouterr().out)["number"] == 7


def test_parent_expands_open_leaves_in_dependency_order_and_rejects_cycles(monkeypatch, capsys):
    issues = {1: node(1, subIssues=connection([node(3), node(2), node(4, state="CLOSED")])),
              2: node(2), 3: node(3, blockedBy=connection([node(2)])), 4: node(4, state="CLOSED")}
    api(monkeypatch, lambda query, fields: {"data": {"repository": {"issue": issues[int(fields["number"])]}}})
    assert issue_graph.main(["1", "--leaves", "--repo", "acme/demo"]) == 0
    assert [item["number"] for item in json.loads(capsys.readouterr().out)] == [2, 3]
    issues[2]["blockedBy"] = connection([node(3)])
    assert issue_graph.main(["1", "--leaves", "--repo", "acme/demo"]) == 2
    assert "cycle" in capsys.readouterr().err.lower()


def test_select_reads_paginated_blockers_before_claiming(monkeypatch, capsys):
    def responses(query, fields):
        if "number" not in fields:
            return {"data": {"repository": {"issues": connection([{"number": 1}])}}}
        if fields.get("cursor") == "more-blockers":
            return {"data": {"repository": {"issue": {"blockedBy": connection([node(9)])}}}}
        return {"data": {"repository": {"issue": node(1, labels=connection([{"name": "[AI]-triaged"}]), blockedBy=connection([], "more-blockers"))}}}
    api(monkeypatch, responses)
    assert issue_graph.main(["--select", "--repo", "acme/demo"]) == 1
    assert json.loads(capsys.readouterr().out) is None


@pytest.mark.parametrize("payload", [{"data": {"repository": {"issue": None}}},
                                     {"data": {}, "errors": [{"message": "API access denied"}]}])
def test_lookup_errors_never_masquerade_as_no_eligible_work(payload, monkeypatch, capsys):
    api(monkeypatch, lambda query, fields: payload)
    assert issue_graph.main(["42", "--repo", "acme/demo"]) == 2
    assert capsys.readouterr().err


@pytest.mark.parametrize("reader", ["bounded", "paginated"])
@pytest.mark.parametrize("response, stderr, returncode", [
    ({"data": {"repository": None}, "errors": [{"type": "NOT_FOUND", "path": ["repository"]}]}, "Repository not found", 1),
    ({"data": {"repository": {"issue": None}}, "errors": [{"type": "FORBIDDEN", "path": ["repository", "issue"]}]}, "Access denied", 1),
    ({"data": {"repository": {"issue": None}}, "errors": [
        {"type": "NOT_FOUND", "path": ["repository", "issue"]},
        {"type": "RATE_LIMITED", "path": ["repository"]},
    ]}, "Rate limited", 1),
    ({"data": {"repository": {"issue": None}}}, "Network failure", 1),
    (None, "Authentication required", 1),
    (None, "", 1),
    ({"data": {"repository": None}}, "", 0),
    ({"data": {"repository": {}}}, "", 0),
])
def test_github_failures_still_block_instead_of_becoming_missing_issues(reader, response, stderr, returncode, monkeypatch, tmp_path):
    monkeypatch.setattr(subprocess, "run", lambda command, **kwargs:
                        subprocess.CompletedProcess(command, returncode, json.dumps(response), stderr))
    with pytest.raises(core.Blocked) as stopped:
        if reader == "bounded":
            core.fetch_issue("acme/demo", 99, tmp_path, "address-this")
        else:
            issue_graph.get_issue("acme/demo", 99, tmp_path)
    assert not isinstance(stopped.value, core.IssueNotFound)


def test_missing_issue_remains_an_error_for_explicit_context_lookup(monkeypatch, capsys):
    payload = {"data": {"repository": {"issue": None}}, "errors": [
        {"type": "NOT_FOUND", "path": ["repository", "issue"], "message": "Missing issue"},
    ]}
    monkeypatch.setattr(subprocess, "run", lambda command, **kwargs:
                        subprocess.CompletedProcess(command, 1, json.dumps(payload), "gh: Missing issue"))
    assert issue_graph.main(["99", "--repo", "acme/demo"]) == 2
    assert capsys.readouterr().err
