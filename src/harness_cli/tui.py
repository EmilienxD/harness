"""Dependency-free, Clack-style terminal widgets for the catalogue installer.

Active prompts redraw in place and collapse to compact answers, preserving a
readable provider, scope, package, review, confirmation, and progress history.
"""

from __future__ import annotations

import os
import re
import shutil
import sys
import textwrap
import unicodedata
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Callable, Iterator, Sequence, TextIO, TypeVar


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
T = TypeVar("T")

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
_ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


class Line(str):
    """A note line that names its meaning rather than its colour.

    Callers describe intent — a removal is ``danger`` — and leave the palette
    to the UI.  Subclassing ``str`` keeps plain lines and toned ones
    interchangeable everywhere a sequence of lines is accepted.
    """

    tone: str

    def __new__(cls, text: str, tone: str = "") -> "Line":
        line = super().__new__(cls, text)
        line.tone = tone
        return line


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
        return ESCAPE
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
    RED = "\x1b[31m"
    STRIKE = "\x1b[9m"
    _TONES = {
        "danger": (RED,),
        "success": (GREEN,),
        "accent": (CYAN,),
        "muted": (DIM,),
    }

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
        return max(1, min(size.columns - 2, 96)), max(6, size.lines)

    def _write(self, lines: Sequence[str]) -> None:
        body = "\n".join(lines).replace("—", ":")
        if self.live:
            body = "\x1b[H" + "\x1b[K\n".join(body.split("\n")) + "\x1b[K\x1b[J"
        self.output.write(body + "\n")
        self.output.flush()

    def _write_prompt(self, lines: Sequence[str], previous_height: int = 0) -> int:
        """Redraw one compact prompt without clearing unrelated terminal history."""

        rendered_body = "\n".join(lines).replace("—", ":")
        body = rendered_body
        if self.live and previous_height:
            body = f"\x1b[{previous_height}A\x1b[J" + body
        self.output.write(body + "\n")
        self.output.flush()
        columns = max(1, shutil.get_terminal_size((100, 30)).columns)
        return sum(
            max(1, (self._display_width(line) + columns - 1) // columns)
            for line in rendered_body.split("\n")
        )

    @staticmethod
    def _display_width(value: str) -> int:
        plain = _ANSI_ESCAPE.sub("", value)
        return sum(
            0
            if unicodedata.combining(char)
            else 2
            if unicodedata.east_asian_width(char) in "WFA"
            else 1
            for char in plain
        )

    def _cancel_prompt(self, title: str, previous_height: int) -> None:
        self._write_prompt(
            [
                self._paint("■", self.RED) + "  " + self._paint(title, self.BOLD, self.STRIKE),
                "│  Cancelled",
            ],
            previous_height,
        )

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

    def intro(self, label: str) -> None:
        self._write_prompt(
            [self._paint("┌", self.CYAN) + "  " + self._paint(label, self.BOLD)]
        )

    def note(self, title: str, lines: Sequence[str]) -> None:
        width, _ = self._size()
        rendered = [
            self._paint("◇", self.GREEN)
            + "  "
            + self._paint(title, self.BOLD),
            self._paint("│", self.DIM),
        ]
        for line in lines:
            codes = self._TONES.get(getattr(line, "tone", ""), ())
            for wrapped in textwrap.wrap(line.replace("—", ":"), max(1, width - 4)) or [""]:
                rendered.append(self._paint("│", self.DIM) + "  " + self._paint(wrapped, *codes))
        rendered.append(self._paint("│", self.DIM))
        self._write_prompt(rendered)

    def confirm(self, title: str, default: bool = True) -> bool | None:
        value = default
        previous_height = 0
        while True:
            yes = (
                self._paint("Yes", self.BOLD, self.GREEN)
                if value
                else self._paint("Yes", self.DIM)
            )
            no = (
                self._paint("No", self.BOLD, self.GREEN)
                if not value
                else self._paint("No", self.DIM)
            )
            lines = [
                self._paint("◆", self.GREEN) + "  " + self._paint(title, self.BOLD),
                self._paint("│", self.DIM) + f"  {yes} {self._paint('/', self.DIM)} {no}",
                self._paint("│", self.DIM)
                + "  "
                + self._paint("←→ choose, enter confirm", self.DIM),
                self._paint("└", self.DIM),
            ]
            previous_height = self._write_prompt(lines, previous_height)
            key = self.read_key()
            if key in (LEFT, RIGHT, SPACE, TAB):
                value = not value
            elif key in ("y", "Y"):
                value = True
            elif key in ("n", "N"):
                value = False
            elif key == ENTER:
                answer = "Yes" if value else "No"
                self._write_prompt(
                    [
                        self._paint("◇", self.GREEN)
                        + "  "
                        + self._paint(title, self.BOLD),
                        self._paint("│", self.DIM) + "  " + answer,
                    ],
                    previous_height,
                )
                return value
            elif key == ESCAPE:
                self._cancel_prompt(title, previous_height)
                return None

    def outro(self, message: str) -> None:
        self._write_prompt([self._paint("└", self.GREEN) + "  " + message.replace("—", ":")])

    def cancelled(self, message: str = "Installation cancelled.") -> None:
        self._write_prompt([self._paint("■", self.RED) + "  " + self._paint(message, self.RED)])

    def progress(self, active: str, complete: str, action: Callable[[], T]) -> T:
        """Run a synchronous installer action behind a compact status line."""

        self._write_prompt([self._paint("◆", self.GREEN) + "  " + active])
        try:
            result = action()
        except Exception:
            self._write_prompt([self._paint("■", self.RED) + "  " + active + " failed"], 1)
            raise
        self._write_prompt([self._paint("◇", self.GREEN) + "  " + complete], 1)
        return result

    def multiselect(
        self,
        title: str,
        options: Sequence[MenuOption],
        selected: set[int] | None = None,
        *,
        required: bool = False,
        select_all: bool = False,
        select_groups: bool = False,
        searchable: bool = True,
        max_visible: int = 20,
    ) -> set[int] | None:
        """Run the compact searchable multi-select used by the installer flow."""

        chosen = set(selected or ())
        collapsed: set[str] = set()
        cursor = 0
        query = ""
        previous_height = 0

        while True:
            visible = _matching(options, query)
            grouped = select_groups and not query
            entries = _select_entries(options, visible, grouped, collapsed)
            navigable: list[tuple[str, object]] = []
            if select_all and options and not query:
                navigable.append(("all", tuple(range(len(options)))))
            navigable.extend(entries)
            cursor = min(cursor, max(0, len(navigable) - 1))
            focused = navigable[cursor] if navigable else None
            lines = self._multiselect_lines(
                title,
                options,
                chosen,
                navigable,
                collapsed,
                cursor,
                query,
                searchable,
                max_visible,
            )
            previous_height = self._write_prompt(lines, previous_height)

            key = self.read_key()
            if key == ENTER:
                if not required or chosen:
                    labels = [options[index].label for index in sorted(chosen)]
                    summary = ", ".join(labels[:3])
                    if len(labels) > 3:
                        summary += f" +{len(labels) - 3} more"
                    self._write_prompt(
                        [
                            self._paint("◇", self.GREEN)
                            + "  "
                            + self._paint(title, self.BOLD),
                            self._paint("│", self.DIM) + "  " + self._paint(summary, self.DIM),
                        ],
                        previous_height,
                    )
                    return chosen
            elif key == ESCAPE:
                self._cancel_prompt(title, previous_height)
                return None
            elif key == UP:
                cursor = max(0, cursor - 1)
            elif key == DOWN:
                cursor = min(max(0, len(navigable) - 1), cursor + 1)
            elif key == PAGE_UP:
                cursor = max(0, cursor - max_visible)
            elif key == PAGE_DOWN:
                cursor = min(max(0, len(navigable) - 1), cursor + max_visible)
            elif key == HOME:
                cursor = 0
            elif key == END:
                cursor = max(0, len(navigable) - 1)
            elif key == LEFT and focused and grouped:
                group = _entry_group(options, focused)
                if group:
                    collapsed.add(group)
                    cursor = _group_cursor(options, visible, select_all, collapsed, group)
            elif key == RIGHT and focused and grouped and focused[0] == "group":
                group = _entry_group(options, focused)
                if group in collapsed:
                    collapsed.discard(group)
            elif key == SPACE and focused:
                _toggle_entry(chosen, options, focused)
            elif key == BACKSPACE:
                query = query[:-1]
                cursor = 0
            elif searchable and len(key) == 1 and key.isprintable():
                query += key
                cursor = 0

    def _multiselect_lines(
        self,
        title: str,
        options: Sequence[MenuOption],
        chosen: set[int],
        navigable: Sequence[tuple[str, object]],
        collapsed: set[str],
        cursor: int,
        query: str,
        searchable: bool,
        max_visible: int,
    ) -> list[str]:
        bar = self._paint("│", self.DIM)
        width, height = self._size()
        focused_entry = navigable[cursor] if navigable else None
        show_detail = height >= 16 and bool(_entry_detail(options, focused_entry))
        footer_height = 5 if show_detail else 1
        header_height = 5 if searchable else 4
        visible_capacity = min(
            max_visible,
            max(1, height - 1 - header_height - footer_height - 1),
        )
        lines = [self._paint("◆", self.GREEN) + "  " + self._paint(title, self.BOLD)]
        lines.append(bar)
        if searchable:
            lines.append(
                f"{bar}  {self._paint('Search:', self.DIM)} "
                f"{query}{self._paint('▏', self.CYAN)}"
            )
        controls = "↑↓ move, space select, enter confirm"
        if any(entry[0] == "group" for entry in navigable):
            controls = "↑↓ move, ←→ collapse/expand, space select, enter confirm"
        control_rows = max(
            1,
            (self._display_width(f"{bar}  {controls}") + width - 1) // max(1, width),
        )
        lines.extend((f"{bar}  {self._paint(controls, self.DIM)}", bar))
        header_height += control_rows - 1

        start = max(
            0,
            min(
                cursor - visible_capacity // 2,
                len(navigable) - visible_capacity,
            ),
        )
        end = min(len(navigable), start + visible_capacity)
        for position, entry in enumerate(navigable[start:end], start=start):
            kind, payload = entry
            focused = position == cursor
            pointer = self._paint("❯", self.CYAN) if focused else " "
            indices = list(payload) if kind in {"all", "group"} else [int(payload)]
            count = sum(index in chosen for index in indices)
            marker = (
                self._paint("●", self.GREEN)
                if indices and count == len(indices)
                else self._paint("◐", self.YELLOW)
                if count
                else self._paint("○", self.DIM)
            )
            if kind == "all":
                label = f"Select All ({len(chosen)}/{len(options)})"
                label = self._paint(label, self.BOLD)
            elif kind == "group":
                group = str(options[indices[0]].group) if indices else ""
                disclosure = "▸" if group in collapsed else "▾"
                label = f"{self._paint(disclosure, self.DIM)} {group.replace('-', ' ').title()}"
                label = self._paint(label, self.BOLD)
            else:
                option = options[indices[0]]
                group_entry = next(
                    (
                        candidate
                        for candidate in navigable
                        if candidate[0] == "group"
                        and _entry_group(options, candidate) == option.group
                    ),
                    None,
                )
                group_indices = (
                    list(group_entry[1]) if group_entry else []  # type: ignore[arg-type]
                )
                tree = ""
                if group_indices:
                    branch = "└─" if indices[0] == group_indices[-1] else "├─"
                    tree = self._paint(branch, self.DIM) + " "
                label = tree + self._fit(option.label, max(1, width - 6))
                hints = [
                    value
                    for value in (option.badge, "installed" if option.installed else "")
                    if value
                ]
                if hints:
                    available = max(0, width - len(option.label) - 11)
                    hint = self._fit("; ".join(hints), available)
                    if hint:
                        label += self._paint(f" ({hint})", self.DIM)
            if focused:
                label = self._paint(label, self.BOLD)
            lines.append(f"{bar} {pointer} {marker} {label}")

        if not navigable:
            lines.append(f"{bar}  {self._paint('No matches found', self.DIM)}")
        hidden = []
        if start:
            hidden.append(f"↑ {start} more")
        if end < len(navigable):
            hidden.append(f"↓ {len(navigable) - end} more")
        if hidden:
            lines.append(f"{bar}  {self._paint('  '.join(hidden), self.DIM)}")

        if show_detail:
            detail = _entry_detail(options, focused_entry)
            lines.extend((bar, f"{bar}  {self._paint('Description', self.DIM)}"))
            wrapped = textwrap.wrap(detail, max(1, width - 5))[:2]
            lines.extend(f"{bar}  {self._paint(line, self.DIM)}" for line in wrapped)
            lines.extend(f"{bar}  " for _ in range(2 - len(wrapped)))
        lines.append(self._paint("└", self.DIM))
        return lines

    def select(
        self,
        title: str,
        options: Sequence[MenuOption],
        default: int = 0,
    ) -> int | None:
        """Choose one option and retain a compact answer in terminal history."""

        cursor = default
        previous_height = 0
        while True:
            bar = self._paint("│", self.DIM)
            width, _ = self._size()
            lines = [
                self._paint("◆", self.GREEN) + "  " + self._paint(title, self.BOLD),
                bar,
            ]
            for index, option in enumerate(options):
                focused = index == cursor
                marker = (
                    self._paint("●", self.GREEN)
                    if focused
                    else self._paint("○", self.DIM)
                )
                label = self._paint(option.label, self.BOLD) if focused else option.label
                line = f"{bar} {marker} {label}"
                if focused and option.detail:
                    detail = textwrap.wrap(
                        f"({option.detail})", max(1, width - len(option.label) - 6)
                    )
                    line += " " + self._paint(detail[0], self.DIM)
                    lines.append(line)
                    lines.extend(f"{bar}    {self._paint(part, self.DIM)}" for part in detail[1:])
                else:
                    lines.append(line)
            lines.extend((bar, self._paint("└", self.DIM)))
            previous_height = self._write_prompt(lines, previous_height)
            key = self.read_key()
            if key in (UP, LEFT):
                cursor = (cursor - 1) % len(options)
            elif key in (DOWN, RIGHT):
                cursor = (cursor + 1) % len(options)
            elif key in (ENTER, SPACE):
                self._write_prompt(
                    [
                        self._paint("◇", self.GREEN)
                        + "  "
                        + self._paint(title, self.BOLD),
                        self._paint("│", self.DIM) + "  " + options[cursor].label,
                    ],
                    previous_height,
                )
                return cursor
            elif key in (ESCAPE, "q"):
                self._cancel_prompt(title, previous_height)
                return None

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


def _select_entries(
    options: Sequence[MenuOption],
    visible: Sequence[int],
    select_groups: bool,
    collapsed: set[str],
) -> list[tuple[str, object]]:
    """Build navigable group and option rows for the compact multi-select."""

    if not select_groups:
        return [("option", index) for index in visible]
    entries: list[tuple[str, object]] = []
    position = 0
    while position < len(visible):
        index = visible[position]
        group = options[index].group
        if not group:
            entries.append(("option", index))
            position += 1
            continue
        indices = []
        while position < len(visible) and options[visible[position]].group == group:
            indices.append(visible[position])
            position += 1
        entries.append(("group", tuple(indices)))
        if group not in collapsed:
            entries.extend(("option", item) for item in indices)
    return entries


def _entry_group(options: Sequence[MenuOption], entry: tuple[str, object]) -> str:
    kind, payload = entry
    if kind == "all":
        return ""
    if kind == "option":
        return options[int(payload)].group
    indices = list(payload)  # type: ignore[arg-type]
    return options[indices[0]].group if indices else ""


def _entry_detail(options: Sequence[MenuOption], entry: tuple[str, object] | None) -> str:
    if entry is None:
        return ""
    kind, payload = entry
    if kind == "all":
        return f"Select or clear all {len(options)} packages."
    if kind == "group":
        indices = list(payload)  # type: ignore[arg-type]
        group = options[indices[0]].group if indices else "this category"
        return f"Select or clear all {len(indices)} packages in {group}."
    return options[int(payload)].detail


def _toggle_entry(
    selected: set[int], options: Sequence[MenuOption], entry: tuple[str, object]
) -> None:
    kind, payload = entry
    indices = list(payload) if kind in {"all", "group"} else [int(payload)]
    if indices and all(index in selected for index in indices):
        selected.difference_update(
            index for index in indices if kind != "all" or not options[index].installed
        )
    else:
        selected.update(indices)


def _group_cursor(
    options: Sequence[MenuOption],
    visible: Sequence[int],
    select_all: bool,
    collapsed: set[str],
    group: str,
) -> int:
    entries = _select_entries(options, visible, True, collapsed)
    position = next(
        (
            index
            for index, entry in enumerate(entries)
            if entry[0] == "group" and _entry_group(options, entry) == group
        ),
        0,
    )
    return position + int(select_all)


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
