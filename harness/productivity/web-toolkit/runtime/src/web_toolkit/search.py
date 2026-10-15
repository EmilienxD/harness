"""Web search through public engine result pages rendered in the shared browser.

Each engine reads its own result page with a small DOM extractor.  Engines are
tried in order and the first one that returns results answers the search, so a
blocked or empty engine costs one page load before the next takes over.
"""

from __future__ import annotations

import base64
import functools
import re
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from urllib.parse import parse_qs, quote_plus, urlsplit

from web_toolkit import browser, download

SEARCH_TIMEOUT = 12
LIMIT = 10
EMPTY_AFTER_LOAD = 3.0
STOPWORDS = {"the", "and", "for", "from", "with", "how", "what", "why", "when", "where", "who", "does", "are", "you", "your", "can", "not"}

# Run only when an engine shows no results, so result snippets cannot trigger it.
BLOCKED = r"""(() => {
  const text = (document.title + ' ' + (document.body ? document.body.innerText.slice(0, 3000) : '')).toLowerCase();
  return /\/sorry\/|captcha|challenge|blocked/.test(location.href)
    || /unusual traffic|are you a robot|not a robot|verify you are human|captcha|anomaly|access denied/.test(text);
})()"""


@dataclass(frozen=True)
class Result:
    title: str
    url: str
    snippet: str


@dataclass(frozen=True)
class Engine:
    name: str
    address: str
    extractor: str
    unwrap: Callable[[str], str | None]

    def url(self, query: str) -> str:
        return self.address.format(query=quote_plus(query))


def _host(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()


def _direct(*internal_hosts: str) -> Callable[[str], str | None]:
    """Keep result links as they are, dropping the engine's own ads and navigation."""
    def unwrap(url: str) -> str | None:
        host = _host(url)
        return None if any(host == domain or host.endswith(f".{domain}") for domain in internal_hosts) else url
    return unwrap


def _bing(url: str) -> str | None:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if host != "bing.com" and not host.endswith(".bing.com"):
        return url
    encoded = parse_qs(parts.query).get("u", [""])[0]
    if not encoded.startswith("a1"):
        return None
    payload = encoded[2:]
    try:
        target = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    return target if target.startswith(("http://", "https://")) else None


@functools.lru_cache(maxsize=256)
def _follow(url: str) -> str | None:
    """Resolve an opaque redirect link; cached because result pages are polled repeatedly."""
    target = download.redirect_target(url)
    return target if target and target.startswith(("http://", "https://")) else None


def _is_google(url: str) -> bool:
    return bool(re.search(r"(^|\.)google\.[a-z.]+$", _host(url)))


def _google(url: str) -> str | None:
    parts = urlsplit(url)
    if not _is_google(url):
        return url
    if parts.path == "/url":
        query = parse_qs(parts.query)
        target = (query.get("q") or query.get("url") or [""])[0]
        return target if target.startswith(("http://", "https://")) else None
    if parts.path == "/goto":
        # Result links carry an opaque token; only Google's redirect reveals the page.
        target = _follow(url)
        return target if target and not _is_google(target) else None
    return None


# Engines are tried in this order, most reliable first.
ENGINES: dict[str, Engine] = {
    engine.name: engine
    for engine in (
        Engine(
            "duckduckgo",
            "https://duckduckgo.com/?q={query}&kl=us-en&ia=web",
            """[...document.querySelectorAll('article[data-testid="result"]')].map(item => {
                 const link = item.querySelector('h2 a');
                 const snippet = item.querySelector('[data-result="snippet"], [data-testid="result-snippet"]');
                 return link && {title: link.innerText, url: link.href, snippet: snippet ? snippet.innerText : ''};
               }).filter(Boolean)""",
            _direct("duckduckgo.com"),
        ),
        Engine(
            "startpage",
            "https://www.startpage.com/sp/search?query={query}",
            """[...document.querySelectorAll('div.result')].map(item => {
                 const link = item.querySelector('a.result-title, a.result-link');
                 const title = item.querySelector('h2, .wgl-title');
                 const snippet = item.querySelector('p.description');
                 return link && {title: (title || link).innerText, url: link.href, snippet: snippet ? snippet.innerText : ''};
               }).filter(Boolean)""",
            _direct("startpage.com"),
        ),
        Engine(
            "bing",
            "https://www.bing.com/search?q={query}&setlang=en-US&cc=US",
            """[...document.querySelectorAll('#b_results > li.b_algo')].map(item => {
                 const link = item.querySelector('h2 a');
                 const snippet = item.querySelector('.b_caption p, p[class*="b_lineclamp"], .b_algoSlug');
                 return link && {title: link.textContent, url: link.href, snippet: snippet ? snippet.textContent : ''};
               }).filter(Boolean)""",
            _bing,
        ),
        Engine(
            "google",
            "https://www.google.com/search?q={query}&hl=en",
            """[...new Set(document.querySelectorAll('#search a:has(h3), #rso a:has(h3)'))].map(link => {
                 const block = link.closest('[data-hveid], .MjjYud, .g');
                 const snippet = block && block.querySelector('.VwiC3b, [data-sncf], [style*="-webkit-line-clamp"]');
                 return {title: link.querySelector('h3').innerText, url: link.href, snippet: snippet ? snippet.innerText : ''};
               })""",
            _google,
        ),
    )
}


def _matches(url: str, domains: list[str]) -> bool:
    host = _host(url)
    return any(host == domain or host.endswith(f".{domain}") for domain in domains)


def _domain(value: str) -> str:
    return value.strip().lower().split("://", 1)[-1].split("/", 1)[0]


def _filters(query: str) -> tuple[list[str], list[str]]:
    """The domains a query's site: operators allow and its -site: operators exclude."""
    sites, excluded = [], []
    for negated, value in re.findall(r"(?:^|[\s(])(-?)site:([^\s()]+)", query, flags=re.IGNORECASE):
        (excluded if negated else sites).append(_domain(value))
    return sites, excluded


def _clean(engine: Engine, raw: list[dict], sites: list[str], excluded: list[str]) -> list[Result]:
    results: list[Result] = []
    seen: set[str] = set()
    # Unwrapping may resolve redirects over the network; do a page's links at once.
    with ThreadPoolExecutor(max_workers=10) as pool:
        urls = list(pool.map(engine.unwrap, (str(item.get("url", "")) for item in raw)))
    for item, url in zip(raw, urls):
        if not url or not url.startswith(("http://", "https://")) or url in seen:
            continue
        # Engines treat site: operators as hints; the filters are enforced here.
        if (sites and not _matches(url, sites)) or (excluded and _matches(url, excluded)):
            continue
        seen.add(url)
        title = " ".join(str(item.get("title", "")).split()) or url
        snippet = " ".join(str(item.get("snippet", "")).split()).removesuffix("Read more")
        results.append(Result(title, url, snippet))
    return results


def _relevant(query: str, results: list[Result]) -> bool:
    """Whether most results mention a query term.

    Engines that suspect automation may answer with unrelated pages instead of a
    challenge; those must fall through to the next engine like a block.
    """
    words = [word for word in query.lower().split() if not word.startswith("-") and ":" not in word]
    terms = {term for term in re.findall(r"\w{3,}", " ".join(words)) if term not in STOPWORDS}
    if not terms:
        return True
    hits = sum(any(term in f"{r.title} {r.url} {r.snippet}".lower() for term in terms) for r in results)
    return hits * 2 >= len(results)


def _run(tab: browser.Tab, engine: Engine, query: str, sites: list[str], excluded: list[str]) -> tuple[str, list[Result]]:
    if error := tab.navigate(engine.url(query)):
        return f"failed to load ({error})", []
    probe = f"({{ready: document.readyState, results: {engine.extractor}}})"
    deadline = time.monotonic() + SEARCH_TIMEOUT
    loaded_at = None
    previous: list[Result] | None = None
    while time.monotonic() < deadline:
        time.sleep(0.2)
        state = tab.evaluate(probe)
        if not state:
            continue
        results = _clean(engine, state.get("results") or [], sites, excluded)
        # Wait for one unchanged poll so streamed result lists are complete.
        if results and previous == results:
            return ("ok", results) if _relevant(query, results) else ("unrelated results", [])
        previous = results
        if not results and tab.evaluate(BLOCKED):
            return "blocked", []
        if state.get("ready") == "complete":
            loaded_at = loaded_at or time.monotonic()
            if not results and time.monotonic() - loaded_at > EMPTY_AFTER_LOAD:
                return "no results", []
    return ("ok", previous) if previous and _relevant(query, previous) else ("timed out", [])


def search(query: str) -> tuple[list[Result], list[tuple[str, str]]]:
    """Return the first answering engine's results, and why each engine failed when none answers."""
    sites, excluded = _filters(query)
    failures: list[tuple[str, str]] = []
    with browser.tab() as tab:
        for engine in ENGINES.values():
            status, results = _run(tab, engine, query, sites, excluded)
            if results:
                return results[:LIMIT], []
            failures.append((engine.name, status))
    return [], failures
