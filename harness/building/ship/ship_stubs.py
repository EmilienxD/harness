"""Check Python test identities and bodies against a first criteria commit."""
from __future__ import annotations

import argparse
import ast
import copy
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys


class ContractError(ValueError):
    pass


def git(root: Path, *arguments: str) -> str:
    result = subprocess.run(["git", "-C", str(root), *arguments], capture_output=True,
                            text=True, encoding="utf-8", timeout=30)
    if result.returncode:
        raise ContractError(result.stderr.strip())
    return result.stdout


def revision(root: Path, value: str) -> str:
    return git(root, "rev-parse", "--verify", "--end-of-options", value + "^{commit}").strip()


def sources(root: Path, commit: str | None) -> dict[str, str]:
    paths = (git(root, "ls-tree", "-r", "--name-only", "-z", commit) if commit else
             git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"))
    result = {}
    for path in set(paths.split("\0")):
        if not path.endswith(".py"):
            continue
        if commit:
            result[path] = git(root, "show", f"{commit}:{path}")
        elif (root / path).is_file():
            result[path] = (root / path).read_text(encoding="utf-8-sig")
    return result


def declarations(files: dict[str, str]) -> dict[str, dict]:
    tests = {}
    for path, source in files.items():
        tree = ast.parse(source, filename=path)
        def visit(nodes, parents=(), class_context=()):
            for node in nodes:
                if isinstance(node, ast.ClassDef):
                    signature = copy.deepcopy(node)
                    signature.body = []
                    visit(node.body, (*parents, node.name), (*class_context, ast.dump(signature)))
                elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    if node.name.startswith("test") or node.name == "runTest":
                        key = path + "::" + ".".join((*parents, node.name))
                        if key in tests:
                            raise ContractError(f"Duplicate test: {key}")
                        signature = copy.deepcopy(node)
                        signature.body = []
                        tests[key] = {"signature": ast.dump(signature), "classes": class_context,
                                      "docstring": ast.get_docstring(node), "body": ast.dump(ast.Module(body=node.body, type_ignores=[])),
                                      "stub": deliberate_failure(node)}
                    visit(node.body, (*parents, node.name), class_context)
                elif isinstance(node, (ast.If, ast.Try, ast.With, ast.For, ast.While)):
                    visit(node.body, parents, class_context)
                    visit(getattr(node, "orelse", []), parents, class_context)
        visit(tree.body)
    return tests


def deliberate_failure(node: ast.AST) -> bool:
    body = node.body
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
        body = body[1:]
    if len(body) != 1:
        return False
    statement = body[0]
    if isinstance(statement, ast.Assert):
        return isinstance(statement.test, ast.Constant) and statement.test.value is False
    if isinstance(statement, ast.Raise):
        raised = statement.exc.func if isinstance(statement.exc, ast.Call) else statement.exc
        return isinstance(raised, ast.Name) and raised.id in {"AssertionError", "NotImplementedError"}
    if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call):
        function = statement.value.func
        return isinstance(function, ast.Attribute) and isinstance(function.value, ast.Name) and (function.value.id, function.attr) in {("pytest", "fail"), ("self", "fail")}
    return False


def inside(path: str, directories: list[str]) -> bool:
    return any(PurePosixPath(path).is_relative_to(PurePosixPath(directory.replace("\\", "/"))) for directory in directories)


def merged_in(root: Path, anchor: str) -> dict[str, dict]:
    """Tests on the incoming side of merges after the anchor, such as the Lead's target sync."""
    tests: dict[str, dict] = {}
    for merge in git(root, "rev-list", "--merges", f"{anchor}..HEAD").split():
        for parent in git(root, "rev-list", "--parents", "-n", "1", merge).split()[2:]:
            tests.update(declarations(sources(root, parent)))
    return tests


def check(root: Path, base: str, anchor: str, units: list[str], workflows: list[str]) -> dict:
    base, anchor = revision(root, base), revision(root, anchor)
    if git(root, "rev-list", "--parents", "-n", "1", anchor).split()[1:] != [base]:
        raise ContractError("The criteria anchor must be the first commit after the saved base.")
    changed = [path for path in git(root, "diff", "--name-only", "-z", base, anchor).split("\0") if path]
    errors = []
    for path in changed:
        if not ((path.endswith(".py") and inside(path, units)) or (path.endswith(".md") and inside(path, workflows))):
            errors.append(f"Non-criteria file in first commit: {path}")
    before, anchored, current = (declarations(sources(root, commit)) for commit in (base, anchor, None))
    stubs = set(anchored) - set(before)
    for key in sorted(stubs):
        if not anchored[key]["docstring"] or not anchored[key]["stub"]:
            errors.append(f"Anchor requires a docstring and deliberate failing body: {key}")
    for key in before:
        if anchored.get(key) != before[key]:
            errors.append(f"First commit changed an existing test: {key}")
    incoming = merged_in(root, anchor)
    for key in sorted(set(current) - set(anchored)):
        if incoming.get(key) != current[key]:
            errors.append(f"Added test outside the stub contract: {key}")
    for key in sorted(set(anchored) - set(current)):
        # A merged target may legitimately remove a pre-existing test.
        if key in stubs or not incoming or key in incoming:
            errors.append(f"Missing or renamed test: {key}")
    for key in sorted(set(anchored) & set(current)):
        expected, actual = anchored[key], current[key]
        if key not in stubs:
            if expected != actual and incoming.get(key) != actual:
                errors.append(f"Changed existing test: {key}")
        elif any(expected[field] != actual[field] for field in ("signature", "classes", "docstring")):
            errors.append(f"Changed stub identity, signature, decorators, or docstring: {key}")
        elif actual["body"] == expected["body"] or actual["stub"]:
            errors.append(f"Stub remains unimplemented: {key}")
    return {"base": base, "anchor": anchor, "language": "python", "stubs": sorted(stubs),
            "state": "failed" if errors else "pass", "errors": errors}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ship-stubs", description=__doc__)
    parser.add_argument("command", choices=["check"])
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--base", required=True)
    parser.add_argument("--anchor", required=True)
    parser.add_argument("--unit-directory", action="append")
    parser.add_argument("--workflow-directory", action="append")
    args = parser.parse_args(argv)
    try:
        result = check(args.root, args.base, args.anchor, args.unit_directory or ["tests/unit"],
                       args.workflow_directory or ["tests/workflow"])
        print(json.dumps(result, indent=2))
        return 0 if result["state"] == "pass" else 1
    except (ContractError, OSError, SyntaxError, subprocess.TimeoutExpired) as error:
        print(f"ship-stubs: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
