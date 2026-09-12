import io

from harness_cli.tui import (
    BACKSPACE,
    DOWN,
    END,
    ENTER,
    ESCAPE,
    SPACE,
    MenuOption,
    TerminalUI,
    Toggle,
)


def ui_for(*keys):
    pending = iter(keys)
    output = io.StringIO()
    return TerminalUI(lambda: next(pending), output, color=False), output


def options():
    return (
        MenuOption("audit", "Audits a codebase", group="planning"),
        MenuOption("commit", "Stages and commits", group="shipping", installed=True),
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
    assert "SHIPPING" in output.getvalue()


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
