"""web-toolkit fetch behavior through its CLI against a local HTTP server."""

import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from web_toolkit import search
from web_toolkit.extract import html_to_markdown
from web_toolkit.search import ENGINES, Result, _relevant

RUNTIME = Path(__file__).resolve().parents[2] / "harness/productivity/web-toolkit/runtime/src"

ARTICLE = """<!doctype html><html><head><title>Release notes</title></head><body>
<nav><a href="/">Home</a> | <a href="/docs">Docs</a></nav>
<main><article><h1>Release notes</h1>
<p>Version 2.0 introduces streaming responses and removes the legacy polling API entirely.</p>
<h2>Migration</h2><p>Replace every call to <code>poll()</code> with <code>stream()</code>, as described in the
<a href="#guide">migration guide</a> and the <a href="/docs/stream">stream reference</a>.</p>
<p>Applications that relied on polling intervals should move that logic into stream handlers.</p>
</article></main></body></html>"""

# Markup patterns from real documentation sites (Starlight, Tailwind, Stack Overflow, rustdoc, GitHub).
DOCS = """<!doctype html><html><head><title>Updater</title></head><body>
<header><nav><a href="/">Home</a> <a href="/blog">Blog</a> <a href="/pricing">Pricing</a></nav></header>
<main><article><h1>Updater</h1>
<p>Automatically update your application with an update server or a static JSON file served from a CDN.</p>
<table><tr><th>Platform</th><th>Level</th></tr>
<tr><td>windows</td><td><div title="Full support"><svg aria-label="Full support"></svg></div></td></tr>
<tr><td>ios</td><td><div title="No support"><svg aria-label="No support"></svg></div></td></tr></table>
<p>To sign your updates you need two keys. Run this to create the keys in the home folder:</p>
<div class="expressive-code"><figure class="frame not-content"><figcaption class="header"></figcaption>
<pre data-language="sh"><code><div class="ec-line"><div class="gutter"><div class="ln" aria-hidden="true">1</div></div>
<div class="code"><span>pnpm tauri signer generate</span><span> -w ~/.tauri/myapp.key</span></div></div></code></pre>
<div class="copy"><button title="Copy to clipboard" data-code="pnpm tauri signer generate -w ~/.tauri/myapp.key">
<div></div></button></div></figure></div>
<p>Start by creating a new Vite project if you do not have one set up already, then install the plugin.</p>
<pre class="shiki" tabindex="0"><code><span class="line"><span>npm create</span><span> vite@latest my-project</span></span><span class="line"><span>cd</span><span> my-project</span></span></code></pre>
<aside class="starlight-aside starlight-aside--tip"><p class="starlight-aside__title">Tip</p>
<div class="starlight-aside__content"><p>Custom variables are not supported, but you can define a custom target.</p>
<div class="expressive-code"><figure class="frame"><pre data-language="rust"><code><div class="ec-line"><div class="code">let target = "linux-x86_64";</div></div><div class="ec-line"><div class="code">builder.target(target);</div></div></code></pre></figure></div></div></aside>
<p>Yield returns values one at a time; an iterable produces its items whenever you loop over it:</p>
<pre class="lang-py s-code-block"><div data-nosnippet=""><button type="button"><svg aria-hidden="true"></svg>Copy</button></div><code>&gt;&gt;&gt; for i in mylist:
...    print(i)</code></pre>
<p>Vectors grow as elements are pushed onto them, reallocating their buffer when the capacity runs out.</p>
<div class="example-wrap"><pre class="rust rust-example-rendered"><code>let mut vec = Vec::new();
vec.push(1);</code></pre><a class="test-arrow" href="https://play.rust-lang.org/?code=x">Run</a></div>
<ol><li>Build the bundle with the private key in your environment: <pre><code>export KEY=$(cat ~/.tauri/myapp.key)</code></pre></li></ol>
<div role="tabpanel" hidden><pre><code>cargo add tauri-plugin-updater</code></pre></div>
<div hidden>There was an error while loading. Please reload this page.</div>
<dialog><h1>Block user</h1><p>Prevent this user from interacting with your repositories.</p></dialog>
</article></main></body></html>"""

CHALLENGE = """<!doctype html><html><head><title>Just a moment...</title></head><body>
<p>Checking your browser before accessing the site.</p><script src="/cdn-cgi/challenge-platform/x.js"></script>
</body></html>"""


def pdf(text: str) -> bytes:
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


ROUTES = {
    "/article": (200, "text/html; charset=utf-8", ARTICLE.encode()),
    "/data.json": (200, "application/json", b'{"name": "web-toolkit", "tags": ["fetch"]}'),
    "/paper.pdf": (200, "application/pdf", pdf("Attention is all you need")),
    "/missing": (404, "text/plain", b"no such page"),
    "/gone": (404, "text/html", b"<html><head><title>Page not found</title><script src='/app.js'></script></head>"
              b"<body><h1>Page not found</h1><p>We could not find that page.</p></body></html>"),
    "/challenge": (403, "text/html", CHALLENGE.encode()),
    "/archive.zip": (200, "application/zip", b"PK\x03\x04" + bytes(64)),
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/old", "/goto?url=CAESWgHr"):
            self.send_response(301 if self.path == "/old" else 302)
            self.send_header("Location", "/article" if self.path == "/old" else "https://sqlite.org/wal.html")
            self.end_headers()
            return
        status, content_type, body = ROUTES[self.path]
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


@pytest.fixture(scope="module")
def server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_port}"
    httpd.shutdown()


def web(*args, tmp_path):
    env = {
        **os.environ,
        "PYTHONPATH": str(RUNTIME),
        "HARNESS_STATE_DIR": str(tmp_path / "state"),
        # No browser: these pages must be served by plain HTTP alone.
        "WEB_TOOLKIT_BROWSER": str(tmp_path / "missing-browser"),
    }
    result = subprocess.run(
        [sys.executable, "-m", "web_toolkit", *args], capture_output=True, text=True, encoding="utf-8", env=env,
    )
    return result.returncode, result.stdout, result.stderr


def split(output):
    header, _, body = output.partition("\n\n")
    return dict(line.split(": ", 1) for line in header.splitlines()), body.removesuffix("\n")


def test_html_becomes_markdown_with_page_relative_links(server, tmp_path):
    code, out, err = web("fetch", f"{server}/old", tmp_path=tmp_path)

    assert (code, err) == (0, "")
    header, body = split(out)
    assert header["URL"] == f"{server}/article"
    assert header["Title"] == "Release notes"
    assert "Status" not in header
    assert "## Migration" in body
    assert f"({server}/article#guide)" in body
    assert f"({server}/docs/stream)" in body


def test_highlighted_code_blocks_keep_their_lines_and_language():
    body = html_to_markdown(DOCS, "https://docs.example/updater/").text

    # Expressive Code: per-line divs inside a <figure>, line-number gutter, copy button.
    assert "```sh\npnpm tauri signer generate -w ~/.tauri/myapp.key\n```" in body
    # Shiki: per-line spans without newline characters between them.
    assert "```\nnpm create vite@latest my-project\ncd my-project\n```" in body
    # A copy button inside the <pre>.
    assert "```py\n>>> for i in mylist:\n...    print(i)\n```" in body
    # A run link beside the block, which a short placeholder would lose to link-density pruning.
    assert "```\nlet mut vec = Vec::new();\nvec.push(1);\n```" in body
    # A block inside a list item still starts on its own line.
    assert "environment: \n```\nexport KEY=$(cat ~/.tauri/myapp.key)\n```" in body
    assert "Copy" not in body


def test_callouts_tab_panels_and_icon_cells_survive_while_hidden_page_furniture_does_not():
    body = html_to_markdown(DOCS, "https://docs.example/updater/").text

    assert "Custom variables are not supported" in body
    assert "```rust\nlet target = \"linux-x86_64\";\nbuilder.target(target);\n```" in body
    assert "```\ncargo add tauri-plugin-updater\n```" in body
    assert "| windows | Full support |" in body and "| ios | No support |" in body
    for hidden in ("There was an error while loading", "Block user", "Pricing"):
        assert hidden not in body


def test_long_content_is_read_in_windows(server, tmp_path):
    _, full, _ = web("fetch", f"{server}/article", "--max-chars", "0", tmp_path=tmp_path)
    total = len(split(full)[1])

    _, first, _ = web("fetch", f"{server}/article", "--max-chars", "100", tmp_path=tmp_path)
    _, rest, _ = web("fetch", f"{server}/article", "--offset", "100", "--max-chars", "0", tmp_path=tmp_path)

    first_header, first_body = split(first)
    assert first_header["Content"] == f"characters 0-100 of {total}; continue with --offset 100"
    assert split(rest)[0]["Content"] == f"characters 100-{total} of {total}"
    assert first_body + split(rest)[1] == split(full)[1]


def test_raw_prints_the_html_source(server, tmp_path):
    code, out, _ = web("fetch", f"{server}/article", "--raw", "--max-chars", "0", tmp_path=tmp_path)

    assert code == 0
    assert split(out)[1] == ARTICLE


def test_pdf_text_is_extracted_per_page(server, tmp_path):
    code, out, _ = web("fetch", f"{server}/paper.pdf", tmp_path=tmp_path)

    assert code == 0
    body = split(out)[1]
    assert body.startswith("## Page 1")
    assert "Attention is all you need" in body


def test_text_formats_print_unchanged(server, tmp_path):
    code, json_out, _ = web("fetch", f"{server}/data.json", tmp_path=tmp_path)

    assert code == 0
    assert split(json_out)[1] == '{"name": "web-toolkit", "tags": ["fetch"]}'


def test_http_errors_exit_1_and_still_print_the_error_page(server, tmp_path):
    code, out, err = web("fetch", f"{server}/missing", tmp_path=tmp_path)

    assert code == 1
    assert "404" in err
    header, body = split(out)
    assert header["Status"] == "404"
    assert body == "no such page"


def test_short_html_error_pages_keep_their_status_instead_of_rendering(server, tmp_path):
    code, out, _ = web("fetch", f"{server}/gone", tmp_path=tmp_path)

    assert code == 1
    header, body = split(out)
    assert header["Status"] == "404"
    assert "Note" not in header
    assert "We could not find that page." in body


def test_binary_content_fails_with_a_reason(server, tmp_path):
    code, out, err = web("fetch", f"{server}/archive.zip", tmp_path=tmp_path)

    assert (code, out) == (1, "")
    assert "application/zip" in err


def test_challenge_without_a_browser_returns_the_http_page_with_a_note(server, tmp_path):
    code, out, _ = web("fetch", f"{server}/challenge", tmp_path=tmp_path)

    assert code == 1
    header, _ = split(out)
    assert header["Status"] == "403"
    assert "browser rendering failed" in header["Note"]
    assert "WEB_TOOLKIT_BROWSER" in header["Note"]


def test_search_without_a_browser_fails_with_a_reason(tmp_path):
    code, out, err = web("search", "anything", tmp_path=tmp_path)

    assert (code, out) == (1, "")
    assert "WEB_TOOLKIT_BROWSER" in err


def test_unrelated_engine_results_do_not_answer_the_query():
    on_topic = [Result("Support installing a tool from a git subdirectory", "https://github.com/astral-sh/uv/issues/1", "")]
    off_topic = [
        Result("Publix: Where Shopping is a Pleasure", "https://www.publix.com/", "Weekly ad and deals"),
        Result("Wedding night details", "https://dokhleh.com/articles/wedding-night-details", ""),
    ]

    assert _relevant("uv tool install from git subdirectory", on_topic)
    assert not _relevant("uv tool install from git subdirectory", off_topic)
    assert not _relevant("uv tool install (site:github.com OR site:astral.sh) -site:pypi.org", off_topic)


def test_engine_redirect_links_resolve_to_their_destination():
    bing = "https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9kb2NzLnB5dGhvbi5vcmcvMy8&ntb=1"
    google = "https://www.google.com/url?q=https://sqlite.org/wal.html&sa=U"

    assert ENGINES["bing"].unwrap(bing) == "https://docs.python.org/3/"
    assert ENGINES["google"].unwrap(google) == "https://sqlite.org/wal.html"
    assert ENGINES["google"].unwrap("https://www.google.com/search?q=next") is None
    assert ENGINES["duckduckgo"].unwrap("https://duckduckgo.com/y.js?ad=1") is None
    assert ENGINES["duckduckgo"].unwrap("https://sqlite.org/wal.html") == "https://sqlite.org/wal.html"


def test_google_opaque_result_links_resolve_through_their_redirect(server, monkeypatch):
    from web_toolkit import download

    redirect_target = download.redirect_target
    # Google's /goto tokens carry no destination; the redirect is served locally here.
    monkeypatch.setattr(download, "redirect_target", lambda url: redirect_target(url.replace("https://www.google.com", server)))
    search._follow.cache_clear()

    assert ENGINES["google"].unwrap("https://www.google.com/goto?url=CAESWgHr") == "https://sqlite.org/wal.html"
    assert download.redirect_target(f"{server}/article") is None
