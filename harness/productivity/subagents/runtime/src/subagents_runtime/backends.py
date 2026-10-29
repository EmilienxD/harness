"""Execution-host API, independent of provider and workflow selection.

Hosts can implement the loopback protocol or supply a backend factory through
Python entry points in ``harness.subagents.backends``. Factories are installed
in the runtime's managed environment and return ExecutionBackend objects.
"""
from __future__ import annotations

from importlib.metadata import entry_points
from pathlib import Path
from typing import Protocol


class ExecutionBackend(Protocol):
    name: str
    supports_live_continuation: bool

    def probe(self, request, cwd: Path) -> bool:
        """Select without effects. Invalid configuration must raise, not decline."""
        ...

    def progress_path(self, execution_id: str, owner_id: str) -> Path:
        """Return the provider JSON event stream without exposing host layout."""
        ...

    def launch(self, request, request_id: str, agent_number: int, cwd: Path) -> str:
        """Use the persisted reservation; never retry an uncertain launch."""
        ...


def installed_backends() -> list[ExecutionBackend]:
    from subagents_runtime.bridge_backend import BridgeBackend
    from subagents_runtime.standalone_backend import StandaloneBackend
    return [*(entry.load()() for entry in sorted(entry_points(group="harness.subagents.backends"), key=lambda item: item.name)), BridgeBackend(), StandaloneBackend()]


def select_backend(request, cwd: Path) -> ExecutionBackend:
    for backend in installed_backends():
        if backend.probe(request, cwd):
            return backend
    raise RuntimeError("No execution backend is available")


def get_backend(name: str) -> ExecutionBackend:
    for backend in installed_backends():
        if backend.name == name:
            return backend
    from subagents_runtime.sessions import SessionError
    raise SessionError(f"Execution backend {name!r} is not installed")


def supports_live_continuation(name: str) -> bool:
    return get_backend(name).supports_live_continuation
