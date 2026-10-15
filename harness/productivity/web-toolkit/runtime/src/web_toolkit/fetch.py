"""Fetch one URL: plain HTTP first, the shared browser when a page needs one."""

from __future__ import annotations

import re
import time
from dataclasses import dataclass

from web_toolkit import browser, download, extract

RENDER_TIMEOUT = 25
BLOCKED_STATUSES = {401, 403, 429, 503}
# Bot challenges and interstitials that a real browser usually clears on its own.
CHALLENGE = re.compile(
    r"just a moment\.\.\.|cf-chl|challenge-platform|checking your browser|enable javascript and cookies"
    r"|captcha-delivery|px-captcha|_incapsula_resource|blocked by network security|verify you are human"
    r"|prove your humanity",
    re.IGNORECASE,
)
# A rendered page is still challenging the browser while its title says so.
CHALLENGE_TITLE = re.compile(
    r"just a moment|attention required|checking your browser|please wait|verif|prove your humanity|security check",
    re.IGNORECASE,
)
SHELL_TEXT_LIMIT = 1500
# An application root that scripts fill in after load.
EMPTY_MOUNT = re.compile(r'<div id="(?:root|app|__next|__nuxt|svelte)"[^>]*>\s*</div>', re.IGNORECASE)


class FetchError(Exception):
    pass


@dataclass(frozen=True)
class Page:
    url: str
    status: int | None
    title: str | None
    text: str
    note: str | None = None


@dataclass(frozen=True)
class _Html:
    url: str
    status: int | None
    html: str
    content: extract.Content

    def page(self, note: str | None = None) -> Page:
        return Page(self.url, self.status, self.content.title, self.content.text, note)


def _needs_browser(document: _Html) -> bool:
    if document.status in BLOCKED_STATUSES or CHALLENGE.search(document.html[:200_000]):
        return True
    if document.status is not None and document.status >= 400:
        # A browser would receive the same error page.
        return False
    # Client-rendered applications ship scripts and little text, or an empty application root.
    if EMPTY_MOUNT.search(document.html):
        return True
    return len(document.content.text) < SHELL_TEXT_LIMIT and "<script" in document.html.lower()


def _render(url: str) -> _Html:
    """Load ``url`` in the shared browser and wait for its DOM to settle."""
    with browser.tab() as tab:
        if error := tab.navigate(url):
            raise FetchError(f"browser could not load {url}: {error}")
        probe = "[document.readyState, document.title, document.documentElement.outerHTML.length]"
        deadline = time.monotonic() + RENDER_TIMEOUT
        previous = None
        while time.monotonic() < deadline:
            time.sleep(0.25)
            state = tab.evaluate(probe)
            if not state:
                continue
            ready, title, size = state
            if ready == "complete" and size == previous and not CHALLENGE_TITLE.search(title or ""):
                break
            previous = size
        html = tab.evaluate("document.documentElement.outerHTML") or ""
        location = tab.evaluate("location.href") or url
        # The current document's HTTP status, after any challenge reloads; 0 when unknown.
        status = tab.evaluate("performance.getEntriesByType('navigation')[0]?.responseStatus") or None
    return _Html(location, status, html, extract.html_to_markdown(html, location))


def fetch(url: str) -> Page:
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", url):
        url = f"https://{url}"
    try:
        response = download.get(url)
    except Exception as exc:
        try:
            return _render(url).page()
        except (browser.BrowserError, FetchError) as browser_exc:
            raise FetchError(f"{exc}; browser fallback failed: {browser_exc}") from exc
    note = "The body exceeded 25 MB and was truncated." if response.truncated else None
    if not extract.is_html(response.content_type) or response.body.startswith(b"%PDF-"):
        try:
            content = extract.convert(response.body, response.content_type, response.charset, response.url)
        except extract.UnsupportedContent as exc:
            raise FetchError(str(exc)) from exc
        return Page(response.url, response.status, content.title, content.text, note)
    html = extract.decode(response.body, response.charset)
    document = _Html(response.url, response.status, html, extract.html_to_markdown(html, response.url))
    if not _needs_browser(document):
        return document.page(note)
    try:
        rendered = _render(response.url)
    except (browser.BrowserError, FetchError) as exc:
        return document.page(f"The page may be incomplete; browser rendering failed: {exc}")
    better = response.status != 200 or len(rendered.content.text) >= len(document.content.text)
    return rendered.page() if better else document.page(note)
