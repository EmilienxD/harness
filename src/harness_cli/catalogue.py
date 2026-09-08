"""Dependency resolution and version validation for catalogue packages."""

from __future__ import annotations

import re
from dataclasses import dataclass

from harness_cli.manifest import Tool


class CatalogueError(ValueError):
    pass


_VERSION = re.compile(r"^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$")
_CLAUSE = re.compile(r"^(==|=|>=|<=|>|<|~=|\^)?\s*(\d+(?:\.\d+){0,2})$")


def _version(value: str) -> tuple[int, int, int]:
    match = _VERSION.fullmatch(value.strip())
    if not match:
        raise CatalogueError(f"catalogue version '{value}' is not a supported semantic version")
    return tuple(int(part or 0) for part in match.groups())


def satisfies(version: str, constraint: str) -> bool:
    if not constraint:
        return True
    actual = _version(version)
    for raw in constraint.split(","):
        match = _CLAUSE.fullmatch(raw.strip())
        if not match:
            raise CatalogueError(f"unsupported version constraint '{constraint}'")
        operator, wanted_text = match.groups()
        wanted = _version(wanted_text)
        if operator in (None, "=", "==") and actual != wanted:
            return False
        if operator == ">=" and actual < wanted:
            return False
        if operator == "<=" and actual > wanted:
            return False
        if operator == ">" and actual <= wanted:
            return False
        if operator == "<" and actual >= wanted:
            return False
        if operator == "~=" and not (actual >= wanted and actual < (wanted[0], wanted[1] + 1, 0)):
            return False
        if operator == "^" and not (actual >= wanted and actual < (wanted[0] + 1, 0, 0)):
            return False
    return True


@dataclass(frozen=True)
class ResolvedPackage:
    tool: Tool
    explicit: bool


def resolve_dependencies(requested: list[Tool], available: dict[str, Tool]) -> list[ResolvedPackage]:
    """Return dependencies before dependents and reject cycles/mismatches."""

    explicit = {tool.name for tool in requested}
    visiting: list[str] = []
    visited: set[str] = set()
    result: list[ResolvedPackage] = []

    def visit(tool: Tool) -> None:
        if tool.name in visiting:
            cycle = visiting[visiting.index(tool.name):] + [tool.name]
            raise CatalogueError(f"dependency cycle: {' -> '.join(cycle)}")
        if tool.name in visited:
            return
        visiting.append(tool.name)
        for dependency in tool.dependencies:
            target = available.get(dependency.name)
            if target is None:
                raise CatalogueError(f"{tool.name} depends on unknown package {dependency.name}")
            if not satisfies(target.version, dependency.constraint):
                requested_version = dependency.constraint or "any version"
                raise CatalogueError(
                    f"{tool.name} requires {target.name}{requested_version}, "
                    f"but the catalogue contains {target.version}"
                )
            visit(target)
        visiting.pop()
        visited.add(tool.name)
        result.append(ResolvedPackage(tool, tool.name in explicit))

    for package in requested:
        visit(package)
    return result
