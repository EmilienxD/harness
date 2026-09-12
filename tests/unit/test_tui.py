import io
import math
import os
import re
import shutil

from harness_cli.tui import (
    BACKSPACE,
    DOWN,
    END,
    ENTER,
    ESCAPE,
    RIGHT,
    SPACE,
    MenuOption,
    TerminalUI,
    Toggle,
    _translate,
)


def ui_for(*keys):
    pending = iter(keys)
    output = io.StringIO()
    return TerminalUI(lambda: next(pending), output, color=False), output


def options():
    return (
        MenuOption("audit", "Audits a codebase", group="planning"),
        MenuOption("commit", "Stages and commits", group="engineering", installed=True),
        MenuOption("zoom-out", "Maps a codebase area", group="productivity"),
    )


def test_choice_uses_arrows_and_enter():
    ui, output = ui_for(DOWN, ENTER)

    assert ui.choose("Platform", (MenuOption("Both"), MenuOption("Claude"))) == 1
    assert "↑↓ move" in output.getvalue()
    assert "esc back" in output.getvalue()


def test_choice_escape_returns_to_previous_question():
    ui, _ = ui_for(ESCAPE)

    assert ui.choose("Scope", (MenuOption("Project"), MenuOption("User"))) is None


def test_picker_toggles_with_space_and_confirms_with_enter():
    ui, output = ui_for(SPACE, DOWN, SPACE, ENTER)

    result = ui.picker("Catalogue", options())

    assert result.action == "confirm"
    assert result.selected == {0, 1}
    assert "✓ " in output.getvalue()


def test_picker_shows_the_confirm_action_without_scrolling():
    ui, output = ui_for(ENTER)

    ui.picker("Catalogue", options(), {0}, confirm="Apply")

    first_frame = output.getvalue()
    assert "↵ Apply" in first_frame
    assert "Press / to search" in first_frame
    assert "1 of 3 selected" in first_frame


def test_picker_counts_additions_and_removals_against_installed_rows():
    ui, output = ui_for(ENTER)

    ui.picker("Catalogue", options(), {0}, confirm="Apply")

    assert "↵ Apply (+1, -1)" in output.getvalue()


def test_picker_groups_rows_under_category_headings():
    ui, output = ui_for(ENTER)

    ui.picker("Catalogue", options())

    assert "PLANNING" in output.getvalue()
    assert "ENGINEERING" in output.getvalue()


def test_picker_describes_the_focused_row_in_full():
    ui, output = ui_for(DOWN, ESCAPE)

    ui.picker("Catalogue", options())

    assert "commit · installed" in output.getvalue()
    assert "Stages and commits" in output.getvalue()


def test_picker_jumps_to_the_last_row_with_end():
    ui, output = ui_for(END, ESCAPE)

    ui.picker("Catalogue", options())

    assert "❯ ○   zoom-out" in output.getvalue()


def test_picker_filters_with_a_search_query():
    ui, output = ui_for("/", "z", "o", "o", ENTER, SPACE, ENTER)

    result = ui.picker("Catalogue", options())

    assert result.selected == {2}
    assert "Filter  zoo  (1 of 3)" in output.getvalue()


def test_picker_search_escape_clears_the_query():
    ui, output = ui_for("/", "z", ESCAPE, ENTER)

    ui.picker("Catalogue", options())

    assert output.getvalue().count("Press / to search") == 2


def test_picker_backspace_edits_the_search_query():
    ui, output = ui_for("/", "z", "q", BACKSPACE, ENTER, ENTER)

    ui.picker("Catalogue", options())

    assert "Filter  z  (1 of 3)" in output.getvalue()


def test_picker_selects_and_clears_every_visible_row():
    ui, _ = ui_for("a", ENTER)
    assert ui.picker("Catalogue", options()).selected == {0, 1, 2}

    ui, _ = ui_for("n", ENTER)
    assert ui.picker("Catalogue", options(), {0, 1, 2}).selected == set()


def test_picker_clears_only_the_rows_matching_the_filter():
    ui, _ = ui_for("/", "z", ENTER, "n", ENTER)

    assert ui.picker("Catalogue", options(), {0, 1, 2}).selected == {0, 1}


def test_picker_escape_cancels():
    ui, _ = ui_for(ESCAPE)

    assert ui.picker("Catalogue", options()).action == "cancel"


def test_picker_reports_a_toggle_shortcut_and_keeps_the_selection():
    ui, output = ui_for(SPACE, "t")

    result = ui.picker(
        "Catalogue",
        options(),
        toggles=(Toggle("p", "Install to", "This project"), Toggle("t", "Platforms", "Claude")),
    )

    assert result.action == "toggle"
    assert result.toggle == 1
    assert result.selected == {0}
    assert "[t] Platforms" in output.getvalue()


def test_rendered_cli_text_never_uses_an_em_dash():
    ui, output = ui_for(ENTER)

    ui.choose("Review — install", (MenuOption("Apply", "safe — and quick"),))

    assert "—" not in output.getvalue()


def test_multiselect_uses_the_skills_style_select_all_flow():
    ui, output = ui_for(SPACE, ENTER)

    selected = ui.multiselect(
        "Select packages",
        options(),
        selected=set(),
        required=True,
        select_all=True,
        select_groups=True,
    )

    assert selected == {0, 1, 2}
    rendered = output.getvalue()
    assert "◆  Select packages" in rendered
    assert "Select All (0/3)" in rendered
    assert "Select All (3/3)" in rendered
    assert "Description" in rendered
    assert "◇  Select packages" in rendered


def test_clearing_select_all_preserves_previously_installed_packages():
    ui, _ = ui_for(SPACE, ENTER)
    package_options = (
        MenuOption("installed", installed=True),
        MenuOption("new"),
    )

    selected = ui.multiselect(
        "Select packages",
        package_options,
        selected={0, 1},
        select_all=True,
    )

    assert selected == {0}


def test_multiselect_group_headings_select_the_whole_category():
    ui, output = ui_for(DOWN, SPACE, ENTER)

    selected = ui.multiselect(
        "Select packages",
        options(),
        required=True,
        select_all=True,
        select_groups=True,
    )

    assert selected == {0}
    assert "▾ Planning" in output.getvalue()


def test_select_collapses_to_the_chosen_answer():
    writes = []

    class Output(io.StringIO):
        def write(self, value):
            writes.append(value)
            return super().write(value)

    pending = iter((DOWN, ENTER))
    output = Output()
    ui = TerminalUI(lambda: next(pending), output, color=False)

    assert ui.select(
        "Installation scope",
        (
            MenuOption("Project", "Install in current directory (committed with your project)"),
            MenuOption("Global", "Install in home directory (available across all projects)"),
        ),
    ) == 1

    rendered = output.getvalue()
    assert "◆  Installation scope" in rendered
    assert "● Global" in rendered
    assert "❯" not in rendered
    assert "◇  Installation scope" in rendered
    assert "│  Global" in rendered
    assert "Install in current directory" in writes[0]
    assert "Install in home directory" not in writes[0]
    assert "Install in current directory" not in writes[1]
    assert "Install in home directory" in writes[1]


def test_flow_chrome_renders_summary_confirmation_and_outro():
    ui, output = ui_for(ENTER)

    ui.intro("harness")
    ui.note("Installation Summary", ("Project  C:/work", "Packages  +2"))
    assert ui.confirm("Proceed with changes?") is True
    ui.outro("Done!  Review installed packages before use.")

    rendered = output.getvalue()
    assert "┌  harness" in rendered
    assert "Installation Summary" in rendered
    assert "Project  C:/work" in rendered
    assert "──" not in rendered
    assert "◇  Proceed with changes?" in rendered
    assert "└  Done!  Review installed packages before use." in rendered


def test_progress_replaces_the_active_status_with_completion():
    ui, output = ui_for()

    assert ui.progress("Applying catalogue changes", "Catalogue updated", lambda: 7) == 7

    rendered = output.getvalue()
    assert "◆  Applying catalogue changes" in rendered
    assert "◇  Catalogue updated" in rendered


def test_multiselect_fits_its_active_frame_inside_a_short_terminal(monkeypatch):
    writes = []

    class Output(io.StringIO):
        def write(self, value):
            writes.append(value)
            return super().write(value)

    ui = TerminalUI(lambda: ESCAPE, Output(), color=False)
    monkeypatch.setattr(ui, "_size", lambda: (80, 12))

    ui.multiselect(
        "Select packages",
        tuple(MenuOption(f"package-{index}", "description") for index in range(20)),
        select_all=True,
    )

    first_frame = writes[0].strip().splitlines()
    assert len(first_frame) <= 11
    assert any("↓" in line and "more" in line for line in first_frame)


def test_multiselect_filters_as_the_user_types_without_a_search_mode():
    ui, output = ui_for("q", SPACE, ENTER)

    selected = ui.multiselect(
        "Select packages",
        (MenuOption("qa"), MenuOption("review")),
        required=True,
    )

    assert selected == {0}
    assert "Search: q" in output.getvalue()


def test_group_expand_key_does_not_move_focus_from_a_package():
    ui, _ = ui_for(DOWN, RIGHT, SPACE, ENTER)

    selected = ui.multiselect(
        "Select packages",
        (MenuOption("one", group="group"), MenuOption("two", group="group")),
        required=True,
        select_groups=True,
    )

    assert selected == {0}


def test_multiselect_can_hide_search_for_a_short_provider_list():
    ui, output = ui_for(ESCAPE)

    ui.multiselect(
        "Select providers",
        (MenuOption("Claude Code"), MenuOption("ChatGPT")),
        searchable=False,
    )

    assert "Search:" not in output.getvalue()
    assert "↑↓ move, space select, enter confirm" in output.getvalue()
    assert "Description" not in output.getvalue()


def test_live_prompt_redraw_counts_wrapped_terminal_rows(monkeypatch):
    writes = []

    class Output(io.StringIO):
        @staticmethod
        def isatty():
            return True

        def write(self, value):
            writes.append(value)
            return super().write(value)

    pending = iter((DOWN, ESCAPE))
    monkeypatch.setattr(shutil, "get_terminal_size", lambda fallback: os.terminal_size((20, 20)))
    ui = TerminalUI(lambda: next(pending), Output(), color=False)

    ui.multiselect(
        "Select providers",
        (MenuOption("Claude Code"), MenuOption("ChatGPT")),
        searchable=False,
    )

    first_frame = writes[0].removesuffix("\n")
    expected_rows = sum(
        max(1, math.ceil(ui._display_width(line) / 20)) for line in first_frame.split("\n")
    )
    redraw = re.match(r"\x1b\[(\d+)A", writes[1])
    assert redraw is not None
    assert int(redraw.group(1)) == expected_rows


def test_ctrl_c_is_translated_to_the_same_cancel_key_as_escape():
    assert _translate("\x03") == ESCAPE


def test_cancelled_prompt_only_colors_the_status_markers_and_final_message_red():
    ui = TerminalUI(lambda: ESCAPE, io.StringIO(), color=True)

    assert ui.multiselect("Select providers", (MenuOption("Claude Code"),)) is None
    ui.cancelled("Installation cancelled.  No changes made.")

    rendered = ui.output.getvalue()
    assert (
        f"{TerminalUI.RED}■{TerminalUI.RESET}  "
        f"{TerminalUI.BOLD}{TerminalUI.STRIKE}Select providers{TerminalUI.RESET}"
    ) in rendered
    assert f"{TerminalUI.RED}│  Cancelled{TerminalUI.RESET}" not in rendered
    assert "│  Cancelled" in rendered
    assert (
        f"{TerminalUI.RED}■{TerminalUI.RESET}  "
        f"{TerminalUI.RED}Installation cancelled.  No changes made.{TerminalUI.RESET}"
    ) in rendered
