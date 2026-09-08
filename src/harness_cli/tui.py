"""Small dependency-free terminal widgets for the catalogue wizard."""

from __future__ import annotations

import os
import shutil
import sys
import textwrap
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Callable, Iterator, Sequence, TextIO


UP = "up"
DOWN = "down"
ENTER = "enter"
ESCAPE = "escape"
SPACE = "space"


@dataclass(frozen=True)
class MenuOption:
    label: str
    detail: str = ""


def _enable_windows_ansi(stream: TextIO) -> bool:
    if os.name != "nt":
        return True
    try:
        import ctypes

        handle = ctypes.windll.kernel32.GetStdHandle(-11)
        mode = ctypes.c_ulong()
        if not ctypes.windll.kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        return bool(ctypes.windll.kernel32.SetConsoleMode(handle, mode.value | 0x0004))
    except (AttributeError, OSError):
        return False


@contextmanager
def terminal_keys(stream: TextIO = sys.stdin) -> Iterator[Callable[[], str]]:
    """Yield a key reader that understands arrows, Enter, Space, and Escape."""

    if os.name == "nt":
        import msvcrt

        def read_windows() -> str:
            value = msvcrt.getwch()
            if value in ("\x00", "\xe0"):
                return {"H": UP, "P": DOWN}.get(msvcrt.getwch(), "")
            if value in ("\r", "\n"):
                return ENTER
            if value == "\x1b":
                return ESCAPE
            if value == " ":
                return SPACE
            if value == "\x03":
                raise KeyboardInterrupt
            return ""

        yield read_windows
        return

    import select
    import termios
    import tty

    descriptor = stream.fileno()
    previous = termios.tcgetattr(descriptor)
    tty.setraw(descriptor)

    def read_posix() -> str:
        value = stream.read(1)
        if value in ("\r", "\n"):
            return ENTER
        if value == " ":
            return SPACE
        if value == "\x03":
            raise KeyboardInterrupt
        if value != "\x1b":
            return ""
        if not select.select([stream], [], [], 0.03)[0]:
            return ESCAPE
        sequence = stream.read(1)
        if sequence != "[" or not select.select([stream], [], [], 0.03)[0]:
            return ESCAPE
        return {"A": UP, "B": DOWN}.get(stream.read(1), "")

    try:
        yield read_posix
    finally:
        termios.tcsetattr(descriptor, termios.TCSADRAIN, previous)


class TerminalUI:
    BLUE = "\x1b[34m"
    GREEN = "\x1b[32m"
    DIM = "\x1b[2m"
    RESET = "\x1b[0m"

    def __init__(
        self,
        read_key: Callable[[], str],
        output: TextIO = sys.stdout,
        color: bool | None = None,
    ) -> None:
        self.read_key = read_key
        self.output = output
        detected = bool(getattr(output, "isatty", lambda: False)())
        self.color = (
            detected and "NO_COLOR" not in os.environ and _enable_windows_ansi(output)
            if color is None
            else color
        )

    def _paint(self, value: str, color: str) -> str:
        return f"{color}{value}{self.RESET}" if self.color else value

    def _clear(self) -> None:
        self.output.write("\x1b[2J\x1b[H")

    def _write(self, value: str) -> None:
        self._clear()
        self.output.write(value.replace("—", ":"))
        self.output.flush()

    def _window(self, cursor: int, count: int) -> tuple[int, int]:
        height = shutil.get_terminal_size((100, 30)).lines
        visible = max(5, height - 7)
        start = min(max(0, cursor - visible + 1), max(0, count - visible))
        return start, min(count, start + visible)

    @staticmethod
    def _detail(label: str, detail: str) -> str:
        if not detail:
            return ""
        width = shutil.get_terminal_size((100, 30)).columns - len(label) - 8
        if width < 8:
            return ""
        return textwrap.shorten(detail, width=width, placeholder="…")

    def choose(
        self,
        title: str,
        options: Sequence[MenuOption],
        default: int = 0,
        note: str = "",
    ) -> int | None:
        cursor = default
        while True:
            lines = [self._paint(f"◆ {title}", self.BLUE), ""]
            if note:
                lines.extend((note, ""))
            for index, option in enumerate(options):
                pointer = self._paint("❯", self.BLUE) if index == cursor else " "
                marker = self._paint("●", self.GREEN) if index == default else "○"
                compact = self._detail(option.label, option.detail)
                detail = f"  {self._paint(compact, self.DIM)}" if compact else ""
                lines.append(f" {pointer} {marker} {option.label}{detail}")
            lines.extend(("", self._paint("↑/↓ move  Enter select  Esc back", self.DIM)))
            self._write("\n".join(lines))
            key = self.read_key()
            if key == UP:
                cursor = (cursor - 1) % len(options)
            elif key == DOWN:
                cursor = (cursor + 1) % len(options)
            elif key == ENTER:
                return cursor
            elif key == ESCAPE:
                return None

    def checklist(
        self,
        title: str,
        options: Sequence[MenuOption],
        selected: set[int] | None = None,
    ) -> set[int] | None:
        chosen = set(selected or ())
        cursor = 0
        count = len(options) + 1
        while True:
            start, end = self._window(cursor, count)
            lines = [self._paint(f"◆ {title}", self.BLUE), ""]
            for index in range(start, end):
                pointer = self._paint("❯", self.BLUE) if index == cursor else " "
                if index == len(options):
                    lines.append(f" {pointer} {self._paint('Continue', self.GREEN)}")
                    continue
                option = options[index]
                box = self._paint("✓", self.GREEN) if index in chosen else " "
                compact = self._detail(option.label, option.detail)
                detail = f"  {self._paint(compact, self.DIM)}" if compact else ""
                lines.append(f" {pointer} [{box}] {option.label}{detail}")
            if start:
                lines.insert(2, self._paint(f"   ↑ {start} more", self.DIM))
            if end < count:
                lines.append(self._paint(f"   ↓ {count - end} more", self.DIM))
            lines.extend(("", self._paint("↑/↓ move  Enter toggle/select  Space toggle  Esc back", self.DIM)))
            self._write("\n".join(lines))
            key = self.read_key()
            if key == UP:
                cursor = (cursor - 1) % count
            elif key == DOWN:
                cursor = (cursor + 1) % count
            elif key in (ENTER, SPACE) and cursor < len(options):
                chosen.symmetric_difference_update({cursor})
            elif key == ENTER:
                return chosen
            elif key == ESCAPE:
                return None

    def message(self, title: str, lines: Sequence[str]) -> None:
        content = [self._paint(f"◆ {title}", self.BLUE), "", *lines]
        self._write("\n".join(content) + "\n")
