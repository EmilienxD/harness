import io

from harness_cli.tui import DOWN, ENTER, ESCAPE, MenuOption, TerminalUI


def ui_for(*keys):
    pending = iter(keys)
    output = io.StringIO()
    return TerminalUI(lambda: next(pending), output, color=False), output


def test_choice_uses_arrows_and_enter():
    ui, output = ui_for(DOWN, ENTER)

    assert ui.choose("Platform", (MenuOption("Both"), MenuOption("Claude"))) == 1
    assert "↑/↓ move  Enter select  Esc back" in output.getvalue()


def test_choice_escape_returns_to_previous_question():
    ui, _ = ui_for(ESCAPE)

    assert ui.choose("Scope", (MenuOption("Project"), MenuOption("User"))) is None


def test_checklist_selects_items_with_enter():
    ui, output = ui_for(ENTER, DOWN, ENTER, DOWN, ENTER)

    selected = ui.checklist("Tools", (MenuOption("A"), MenuOption("B")))

    assert selected == {0, 1}
    assert "[✓] A" in output.getvalue()


def test_rendered_cli_text_never_uses_an_em_dash():
    ui, output = ui_for(ENTER)

    ui.choose("Review — install", (MenuOption("Apply", "safe — and quick"),))

    assert "—" not in output.getvalue()
