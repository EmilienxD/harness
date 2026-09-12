from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping


@dataclass(frozen=True)
class LaunchOptions:
    system_prompt: str | None = None
    settings: Mapping[str, object] | None = None


@dataclass(frozen=True)
class LaunchConfiguration:
    claude: LaunchOptions
    chatgpt: LaunchOptions


__all__ = ["LaunchConfiguration", "LaunchOptions"]
