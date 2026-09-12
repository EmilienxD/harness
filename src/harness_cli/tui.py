"""Small dependency-free terminal widgets for the catalogue installer.

``picker`` is the main screen: a grouped, searchable list whose confirm action
lives in a footer that stays on screen no matter how long the catalogue grows.
"""

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
LEFT = "left"
RIGHT = "right"
ENTER = "enter"
ESCAPE = "escape"
SPACE = "space"
TAB = "tab"
BACKSPACE = "backspace"
PAGE_UP = "pageup"
PAGE_DOWN = "pagedown"
HOME = "home"
END = "end"

_WINDOWS_KEYS = {
    "H": UP,
    "P": DOWN,
    "K": LEFT,
    "M": RIGHT,
    "I": PAGE_UP,
    "Q": PAGE_DOWN,
    "G": HOME,
    "O": END,
}
_CSI_KEYS = {"A": UP, "B": DOWN, "C": RIGHT, "D": LEFT, "H": HOME, "F": END}
_CSI_NUMBERS = {"1": HOME, "4": END, "5": PAGE_UP, "6": PAGE_DOWN, "7": HOME, "8": END}


@dataclass(frozen=True)
class MenuOption:
    """One selectable row.

    ``group`` renders a category heading above the first row that carries it,
    ``badge`` a short right-hand qualifier, and ``installed`` the marker that
    lets the picker describe a selection as additions and removals.
    """

    label: str
    detail: str = ""
    group: str = ""
    badge: str = ""
    installed: bool = False


@dataclass(frozen=True)
class Toggle:
    """A header setting cycled with a single key instead of a wizard step."""

    key: str
    label: str
    value: str
    detail: str = ""


@dataclass(frozen=True)
class PickerResult:
    """``action`` is ``confirm``, ``cancel``, or ``toggle``."""

    action: str
    selected: set[int]
    toggle: int = -1


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
    """Yield a key reader that returns a named key or a single printable character."""

    with _hidden_cursor():
        if os.name == "nt":
            import msvcrt

            def read_windows() -> str:
                value = msvcrt.getwch()
                if value in ("\x00", "\xe0"):
                    return _WINDOWS_KEYS.get(msvcrt.getwch(), "")
                return _translate(value)

            yield read_windows
            return

        import select
        import termios
        import tty

        descriptor = stream.fileno()
        previous = termios.tcgetattr(descriptor)
        tty.setraw(descriptor)

        def pending() -> bool:
            return bool(select.select([stream], [], [], 0.03)[0])

        def read_posix() -> str:
            value = stream.read(1)
            if value != "\x1b":
                return _translate(value)
            if not pending():
                return ESCAPE
            introducer = stream.read(1)
            if introducer not in ("[", "O") or not pending():
                return ESCAPE
            final = stream.read(1)
            if not final.isdigit():
                return _CSI_KEYS.get(final, "")
            digits = final
            while pending():
                extra = stream.read(1)
                if not extra.isdigit():
                    break
                digits += extra
            return _CSI_NUMBERS.get(digits, "")

        try:
            yield read_posix
        finally:
            termios.tcsetattr(descriptor, termios.TCSADRAIN, previous)


def _translate(value: str) -> str:
    if value in ("\r", "\n"):
        return ENTER
    if value == "\x1b":
        return ESCAPE
    if value == "\t":
        return TAB
    if value in ("\x08", "\x7f"):
        return BACKSPACE
    if value == " ":
        return SPACE
    if value == "\x03":
        raise KeyboardInterrupt
    return value if value.isprintable() else ""


@contextmanager
def _hidden_cursor(output: TextIO = sys.stdout) -> Iterator[None]:
    visible = bool(getattr(output, "isatty", lambda: False)())
    if visible:
        output.write("\x1b[?25l")
        output.flush()
    try:
        yield
    finally:
        if visible:
            output.write("\x1b[?25h\x1b[0m")
            output.flush()


class TerminalUI:
    RESET = "\x1b[0m"
    BOLD = "\x1b[1m"
    DIM = "\x1b[2m"
    GREEN = "\x1b[32m"
    YELLOW = "\x1b[33m"
    BLUE = "\x1b[34m"
    MAGENTA = "\x1b[35m"
    CYAN = "\x1b[36m"

    def __init__(
        self,
        read_key: Callable[[], str],
        output: TextIO = sys.stdout,
        color: bool | None = None,
    ) -> None:
        self.read_key = read_key
        self.output = output
        self.live = bool(getattr(output, "isatty", lambda: False)())
        self.color = (
            self.live and "NO_COLOR" not in os.environ and _enable_windows_ansi(output)
            if color is None
            else color
        )

    # Rendering primitives -------------------------------------------------

    def _paint(self, value: str, *codes: str) -> str:
        return f"{''.join(codes)}{value}{self.RESET}" if self.color and value else value

    def _size(self) -> tuple[int, int]:
        size = shutil.get_terminal_size((100, 30))
        return max(52, min(size.columns - 2, 96)), max(12, size.lines)

    def _write(self, lines: Sequence[str]) -> None:
        body = "\n".join(lines).replace("—", ":")
        if self.live:
            body = "\x1b[H" + "\x1b[K\n".join(body.split("\n")) + "\x1b[K\x1b[J"
        self.output.write(body + "\n")
        self.output.flush()

    def _rule(self, width: int) -> str:
        return self._paint("─" * width, self.DIM)

    def _heading(self, title: str, width: int, right: str = "", compact: bool = False) -> list[str]:
        left = self._paint(f"◆ {title}", self.BOLD, self.CYAN)
        pad = max(1, width - len(title) - len(right) - 2)
        banner = f" {left}{' ' * pad}{self._paint(right, self.DIM)}" if right else f" {left}"
        return [banner, ""] if compact else ["", banner, ""]

    @staticmethod
    def _fit(value: str, width: int) -> str:
        if width < 4:
            return ""
        return value if len(value) <= width else value[: width - 1] + "…"

    def _hints(self, pairs: Sequence[tuple[str, str]], width: int) -> str:
        rendered = [
            f"{self._paint(key, self.BOLD, self.YELLOW)} {self._paint(action, self.DIM)}"
            for key, action in pairs
        ]
        plain = "  ".join(f"{key} {action}" for key, action in pairs)
        if len(plain) + 1 <= width:
            return " " + "  ".join(rendered)
        half = (len(pairs) + 1) // 2
        return "\n".join(
            (" " + "  ".join(rendered[:half]), " " + "  ".join(rendered[half:]))
        )

    # Widgets --------------------------------------------------------------

    def picker(
        self,
        title: str,
        options: Sequence[MenuOption],
        selected: set[int] | None = None,
        toggles: Sequence[Toggle] = (),
        confirm: str = "Install",
    ) -> PickerResult:
        """Browse, filter, and select rows on one screen with a fixed action bar."""

        chosen = set(selected or ())
        cursor = 0
        offset = 0
        query = ""
        searching = False
        shortcuts = {toggle.key: index for index, toggle in enumerate(toggles)}

        while True:
            visible = _matching(options, query)
            cursor = min(cursor, max(0, len(visible) - 1))
            rows = _rows(options, visible)
            width, height = self._size()
            compact = height < 28
            hints = self._hints(
                self._picker_hints(options, chosen, toggles, searching, confirm), width
            )
            chrome = (10 if compact else 15) + len(toggles) + hints.count("\n")
            capacity = min(max(3, height - chrome), max(1, len(rows)))
            offset = _scroll(rows, visible, cursor, offset, capacity)
            focus = options[visible[cursor]] if visible else None

            lines = self._heading(
                title, width, f"{len(chosen)} of {len(options)} selected", compact
            )
            lines.extend(self._toggle_lines(toggles, width, compact))
            lines.append(self._search_line(query, searching, len(visible), len(options), width))
            lines.append(f" {self._rule(width)}")
            lines.extend(
                self._list_lines(options, rows, visible, chosen, cursor, offset, capacity, width)
            )
            lines.append(f" {self._rule(width)}")
            lines.extend(self._focus_lines(focus, width, compact))
            if not compact:
                lines.append("")
            lines.append(hints)
            self._write(lines)

            key = self.read_key()
            if searching:
                searching, query, handled = _search_key(key, query)
                if handled:
                    cursor = 0
                    offset = 0
                    continue
            if key in (UP, LEFT):
                cursor = (cursor - 1) % len(visible) if visible else 0
            elif key in (DOWN, RIGHT):
                cursor = (cursor + 1) % len(visible) if visible else 0
            elif key == PAGE_UP:
                cursor = max(0, cursor - capacity)
            elif key == PAGE_DOWN:
                cursor = min(max(0, len(visible) - 1), cursor + capacity)
            elif key == HOME:
                cursor = 0
            elif key == END:
                cursor = max(0, len(visible) - 1)
            elif key == SPACE and visible:
                chosen.symmetric_difference_update({visible[cursor]})
            elif key in shortcuts:
                return PickerResult("toggle", chosen, shortcuts[key])
            elif key == "/":
                searching = True
            elif key == "a":
                chosen.update(visible)
            elif key == "n":
                chosen.difference_update(visible)
            elif key == ENTER:
                return PickerResult("confirm", chosen)
            elif key in (ESCAPE, "q"):
                return PickerResult("cancel", chosen)

    def _toggle_lines(
        self, toggles: Sequence[Toggle], width: int, compact: bool = False
    ) -> list[str]:
        if not toggles:
            return []
        gutter = max(len(toggle.label) for toggle in toggles) + 2
        column = max(len(toggle.value) for toggle in toggles) + 2
        lines = []
        for toggle in toggles:
            hint = self._paint(f"[{toggle.key}]", self.BOLD, self.YELLOW)
            label = self._paint(toggle.label.ljust(gutter), self.DIM)
            value = self._paint(toggle.value.ljust(column), self.BOLD)
            detail = self._fit(toggle.detail, width - gutter - column - 6)
            suffix = self._paint(detail, self.DIM) if detail else ""
            lines.append(f" {hint} {label}{value}{suffix}")
        return lines if compact else [*lines, ""]

    def _search_line(self, query: str, searching: bool, shown: int, total: int, width: int) -> str:
        if searching:
            return f" {self._paint('Search', self.DIM)}  {query}{self._paint('▏', self.CYAN)}"
        if query:
            counter = self._paint(f"({shown} of {total})", self.DIM)
            return f" {self._paint('Filter', self.DIM)}  {self._paint(query, self.MAGENTA)}  {counter}"
        return f" {self._paint('Press / to search', self.DIM)}"

    def _list_lines(
        self,
        options: Sequence[MenuOption],
        rows: Sequence[tuple[str, object]],
        visible: Sequence[int],
        chosen: set[int],
        cursor: int,
        offset: int,
        capacity: int,
        width: int,
    ) -> list[str]:
        if not visible:
            return ["", self._paint("   Nothing matches that search.", self.DIM), *[""] * capacity]
        focused = visible[cursor]
        column = min(28, max(len(options[index].label) for index in visible) + 2)
        lines = [self._paint(f"   ↑ {offset} more", self.DIM) if offset else ""]
        for kind, payload in rows[offset : offset + capacity]:
            if kind == "group":
                lines.append(self._paint(f"  {str(payload).upper()}", self.BOLD, self.BLUE))
                continue
            index = int(payload)  # type: ignore[arg-type]
            lines.append(self._row(options[index], index == focused, index in chosen, column, width))
        remaining = len(rows) - offset - capacity
        lines.append(self._paint(f"   ↓ {remaining} more", self.DIM) if remaining > 0 else "")
        return lines

    def _row(
        self, option: MenuOption, focused: bool, chosen: bool, column: int, width: int
    ) -> str:
        pointer = self._paint("❯", self.BOLD, self.CYAN) if focused else " "
        box = self._paint("✓", self.GREEN) if chosen else self._paint("○", self.DIM)
        mark = self._paint("●", self.GREEN) if option.installed else " "
        label = self._fit(option.label, column - 2).ljust(column)
        label = self._paint(label, self.BOLD) if focused or chosen else label
        detail = self._fit(option.detail, width - column - 8)
        suffix = self._paint(detail, self.DIM) if detail else ""
        return f" {pointer} {box} {mark} {label}{suffix}"

    def _focus_lines(
        self, focus: MenuOption | None, width: int, compact: bool = False
    ) -> list[str]:
        depth = 0 if compact else 2
        if focus is None:
            return [""] * (depth + 1)
        meta = [self._paint(focus.label, self.BOLD)]
        if focus.badge:
            meta.append(self._paint(focus.badge, self.DIM))
        if focus.installed:
            meta.append(self._paint("installed", self.GREEN))
        body = textwrap.wrap(focus.detail, width=width - 2)[:depth]
        return [
            " " + self._paint(" · ", self.DIM).join(meta),
            *(f" {self._paint(line, self.DIM)}" for line in body),
            *[""] * (depth - len(body)),
        ]

    def _picker_hints(
        self,
        options: Sequence[MenuOption],
        chosen: set[int],
        toggles: Sequence[Toggle],
        searching: bool,
        confirm: str,
    ) -> list[tuple[str, str]]:
        if searching:
            return [("type", "filter"), ("↵", "keep filter"), ("esc", "clear")]
        added = sum(1 for index in chosen if not options[index].installed)
        removed = sum(1 for index, option in enumerate(options) if option.installed and index not in chosen)
        parts = []
        if added:
            parts.append(f"+{added}")
        if removed:
            parts.append(f"-{removed}")
        label = f"{confirm} ({', '.join(parts)})" if parts else f"{confirm}"
        hints = [("↑↓", "move"), ("space", "select"), ("/", "search"), ("a/n", "all/none")]
        hints.extend((f"[{toggle.key}]", toggle.label.lower()) for toggle in toggles)
        hints.extend((("↵", label), ("esc", "quit")))
        return hints

    def choose(
        self,
        title: str,
        options: Sequence[MenuOption],
        default: int = 0,
        note: str = "",
    ) -> int | None:
        cursor = default
        while True:
            width, _ = self._size()
            lines = self._heading(title, width)
            if note:
                lines.extend(note.split("\n"))
                lines.extend(("", f" {self._rule(width)}", ""))
            column = max(len(option.label) for option in options) + 3
            for index, option in enumerate(options):
                pointer = self._paint("❯", self.BOLD, self.CYAN) if index == cursor else " "
                label = option.label.ljust(column)
                label = self._paint(label, self.BOLD) if index == cursor else label
                detail = self._fit(option.detail, width - column - 4)
                suffix = self._paint(detail, self.DIM) if detail else ""
                lines.append(f" {pointer} {label}{suffix}")
            lines.append("")
            lines.append(self._hints((("↑↓", "move"), ("↵", "select"), ("esc", "back")), width))
            self._write(lines)
            key = self.read_key()
            if key in (UP, LEFT):
                cursor = (cursor - 1) % len(options)
            elif key in (DOWN, RIGHT):
                cursor = (cursor + 1) % len(options)
            elif key in (ENTER, SPACE):
                return cursor
            elif key in (ESCAPE, "q"):
                return None

    def message(self, title: str, lines: Sequence[str]) -> None:
        width, _ = self._size()
        self._write([*self._heading(title, width), *lines, ""])


def _matching(options: Sequence[MenuOption], query: str) -> list[int]:
    if not query:
        return list(range(len(options)))
    needle = query.lower()
    return [
        index
        for index, option in enumerate(options)
        if needle in f"{option.label} {option.group} {option.detail}".lower()
    ]


def _rows(options: Sequence[MenuOption], visible: Sequence[int]) -> list[tuple[str, object]]:
    rows: list[tuple[str, object]] = []
    group = None
    for index in visible:
        if options[index].group and options[index].group != group:
            group = options[index].group
            rows.append(("group", group))
        rows.append(("option", index))
    return rows


def _scroll(
    rows: Sequence[tuple[str, object]],
    visible: Sequence[int],
    cursor: int,
    offset: int,
    capacity: int,
) -> int:
    if not visible or len(rows) <= capacity:
        return 0
    position = rows.index(("option", visible[cursor]))
    if position < offset:
        offset = position
    elif position >= offset + capacity:
        offset = position - capacity + 1
    if offset and rows[offset][0] == "option" and rows[offset - 1][0] == "group":
        offset -= 1
    return max(0, min(offset, len(rows) - capacity))


def _search_key(key: str, query: str) -> tuple[bool, str, bool]:
    """Return the next search mode, query, and whether the key was consumed."""

    if key == ESCAPE:
        return False, "", True
    if key == ENTER:
        return False, query, True
    if key == BACKSPACE:
        return True, query[:-1], True
    if key == SPACE:
        return True, query + " ", True
    if len(key) == 1 and key.isprintable():
        return True, query + key, True
    return True, query, False
