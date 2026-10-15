"""Turn fetched bodies into agent-readable text."""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass
from typing import Any

HTML_TYPES = {"text/html", "application/xhtml+xml"}
TEXT_TYPES = {
    "application/json", "application/ld+json", "application/xml", "application/javascript",
    "application/x-javascript", "application/yaml", "application/x-yaml", "application/toml",
}


@dataclass(frozen=True)
class Content:
    text: str
    title: str | None = None


class UnsupportedContent(Exception):
    pass


def is_html(content_type: str) -> bool:
    return content_type in HTML_TYPES or content_type == ""


def decode(body: bytes, charset: str | None) -> str:
    if charset:
        try:
            return body.decode(charset, errors="replace")
        except LookupError:
            pass
    from trafilatura.utils import decode_file

    return decode_file(body)


def _has_class(*names: str) -> str:
    return " or ".join(f"contains(concat(' ', normalize-space(@class), ' '), ' {name} ')" for name in names)


OUTSIDE_CONTENT = "not(ancestor::main or ancestor::article)"
# Elements a reader never sees, and site navigation, which pages without a clear main
# content would otherwise lead with.  Hidden tab panels stay: they hold alternative
# content.  Elements wrapping the page's content stay too: open modals and anti-flicker
# snippets hide the whole page that way.
NOT_CONTENT = (
    "//template | //dialog[not(@open)]"
    " | (//*[@hidden][not(@role='tabpanel')] | //*[@aria-hidden='true']"
    " | //*[contains(translate(@style, ' ', ''), 'display:none')]"
    f" | //nav[{OUTSIDE_CONTENT}] | //header[{OUTSIDE_CONTENT}]"
    f" | //*[@role='navigation' or @role='banner'][{OUTSIDE_CONTENT}])"
    "[not(self::html or self::body or .//main or .//article or .//h1)]"
)
# Syntax highlighters (Shiki, Expressive Code, Prism) put each code line in its own element.
LINE_CLASSES = ("line", "ec-line", "token-line")
CODE_LINES = f".//*[{_has_class(*LINE_CLASSES)}][not(ancestor::*[{_has_class(*LINE_CLASSES)}])]"
PLAIN_LANGUAGES = {"", "text", "txt", "plaintext", "plain", "none", "nohighlight"}


def _label_icon_cells(tree: Any) -> None:
    """Give table cells that only hold an icon the icon's accessible label as text."""
    for cell in tree.iter("td", "th"):
        if cell.text_content().strip():
            continue
        labels = cell.xpath("(.//*[@aria-label or @title or @alt])[1]")
        if labels:
            label = labels[0]
            cell.text = label.get("aria-label") or label.get("title") or label.get("alt")


def _code_language(pre: Any) -> str:
    candidates = [pre, *pre.iterchildren("code"), pre.getparent()]
    for element in candidates:
        if element is None:
            continue
        if language := element.get("data-language") or element.get("data-lang"):
            break
        found = re.search(r"(?:^|\s)(?:language|lang)-([\w+#.-]+)", element.get("class") or "")
        if found:
            language = found.group(1)
            break
    else:
        language = ""
    return "" if language.lower() in PLAIN_LANGUAGES else language


def _code_text(pre: Any) -> str:
    # Copy buttons and line-number gutters are page furniture, not code.
    for widget in pre.xpath(".//button | .//*[@aria-hidden='true'] | .//script | .//style"):
        widget.drop_tree()
    lines = pre.xpath(CODE_LINES)
    if lines:
        # Expressive Code keeps line numbers beside each line's text in a "code" child.
        return "\n".join(
            (line.xpath(f"./*[{_has_class('code')}]") or [line])[0].text_content().rstrip("\n") for line in lines
        )
    for line_break in pre.iter("br"):
        line_break.tail = "\n" + (line_break.tail or "")
    return pre.text_content()


def _extract_code_blocks(tree: Any) -> dict[str, str]:
    """Replace each <pre> with a marked paragraph; return the fenced block for each marker.

    trafilatura deletes <figure> elements, which highlighters wrap around code,
    and flattens per-line markup into one line, so code is restored afterwards.
    The paragraph keeps the code text so length and link-density heuristics
    judge it as they would the original block.
    """
    nonce = secrets.token_hex(6)
    blocks = {}
    for index, pre in enumerate(list(tree.iter("pre"))):
        if any(ancestor.tag == "pre" for ancestor in pre.iterancestors()):
            continue
        code = _code_text(pre).strip("\n")
        if not code.strip():
            continue
        fence = "`" * max([3, *(len(run) + 1 for run in re.findall(r"`+", code))])
        key = f"{nonce}n{index}"
        blocks[key] = f"{fence}{_code_language(pre)}\n{code}\n{fence}"
        for ancestor in pre.iterancestors("figure"):
            ancestor.tag = "div"
        replacement = pre.makeelement("p")
        replacement.text = f"wtcode{key}a {code} wtcode{key}z"
        replacement.tail = pre.tail
        pre.getparent().replace(pre, replacement)
    return blocks


def _restore_code_blocks(text: str, blocks: dict[str, str]) -> str:
    def fenced(found: re.Match[str]) -> str:
        # Inside list items and definitions the marker shares a line with surrounding text.
        before = "" if found.start() == 0 or text[found.start() - 1] == "\n" else "\n"
        after = "" if found.end() == len(text) or text[found.end()] == "\n" else "\n"
        return before + blocks[found.group(1)] + after

    text = re.sub(r"wtcode([0-9a-f]{12}n\d+)a.*?wtcode\1z", fenced, text, flags=re.DOTALL)
    return re.sub(r"wtcode[0-9a-f]{12}n\d+[az]", "", text)


def html_to_markdown(html: str, url: str) -> Content:
    import trafilatura
    from trafilatura.utils import load_html

    tree = load_html(html)
    if tree is None:
        return Content(html.strip())
    # trafilatura resolves fragment and relative links against the site root, not the page.
    tree.make_links_absolute(url, resolve_base_href=True, handle_failures="ignore")
    metadata = trafilatura.extract_metadata(tree, default_url=url)
    # trafilatura deletes every <aside>; inside the main content they are callouts (tips, notes).
    for aside in tree.xpath("//main//aside | //article//aside | //*[@role='main']//aside"):
        aside.tag = "div"
    _label_icon_cells(tree)
    blocks = _extract_code_blocks(tree)
    for element in tree.xpath(NOT_CONTENT):
        if element.getparent() is not None:
            element.drop_tree()
    text = trafilatura.extract(
        tree, url=url, output_format="markdown", include_links=True, include_tables=True,
        include_formatting=True, include_images=False, include_comments=False, favor_recall=True,
        deduplicate=False,
    )
    if not text:
        # Listings and app shells defeat main-content extraction; keep their visible text.
        text = trafilatura.html2txt(tree) or ""
    if blocks:
        text = _restore_code_blocks(text, blocks)
    return Content(text.strip(), metadata.title if metadata else None)


def pdf_to_text(body: bytes) -> Content:
    import pypdfium2

    document = pypdfium2.PdfDocument(body)
    try:
        pages = []
        for index in range(len(document)):
            page = document[index]
            textpage = page.get_textpage()
            pages.append(f"## Page {index + 1}\n\n{textpage.get_text_range().replace(chr(13), '').strip()}")
            textpage.close()
            page.close()
        title = document.get_metadata_dict().get("Title") or None
    finally:
        document.close()
    return Content("\n\n".join(pages), title)


def convert(body: bytes, content_type: str, charset: str | None, url: str) -> Content:
    if content_type == "application/pdf" or body.startswith(b"%PDF-"):
        return pdf_to_text(body)
    if is_html(content_type):
        return html_to_markdown(decode(body, charset), url)
    if content_type.startswith("text/") or content_type in TEXT_TYPES or content_type.endswith(("+json", "+xml")):
        return Content(decode(body, charset or "utf-8"))
    raise UnsupportedContent(f"unsupported content type {content_type} ({len(body)} bytes)")
