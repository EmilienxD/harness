#!/usr/bin/env python3
"""Shared plumbing for the redirect-subagents hook scripts.

Installed next to them into `.claude/hooks/` so the three event scripts stay
import-free of any package: each one adds its own directory to sys.path and
imports this module.

Layout this tool reads and writes. The state root is the anchored session
project root (see root()); user-level config is read from home:

    <root>/.claude/harness-redirect-subagents/subagents.json   project subagent definitions
    <root>/.claude/harness-redirect-subagents/<job>/           background + deferred job state
    ~/.claude/harness-redirect-subagents/subagents.json        user-level definitions (fallback)

Environment variables (all optional):

    REDIRECT_SUBAGENTS_CLAUDER_BIN  clauder executable for the "clauder"
                                    backend (default "clauder"); prepend
                                    extra argv by separating with ';', e.g.
                                    "uvx;--from;clauder;clauder"
    REDIRECT_SUBAGENTS_BACKEND      fallback command template for entries with
                                    profile/model/effort but no "command"
                                    (default "clauder run {profile} -p --model
                                    {model} --effort {effort} --system-prompt
                                    {system_prompt}")
    LOG_LEVEL                       logging verbosity (default INFO)
"""
import json
import logging
import os
import sys
import time
from pathlib import Path

logging.basicConfig(
    level=getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("redirect-subagents")

# Job state is machine-local runtime state nobody should commit.
JOBS_REL = Path(".claude") / "harness-redirect-subagents"

# User-level definitions: apply (as a fallback under project config) only in
# projects the file explicitly names, so a global config never intercepts
# subagents in an unrelated checkout.
USER_CONFIG = Path.home() / ".claude" / "harness-redirect-subagents" / "subagents.json"


def root() -> Path:
    """Directory all session state is relative to: the session's project root.

    Determined by looking for the anchored marker this tool leaves behind —
    walking up from cwd, because an allowed Bash `cd` or a `--add-dir` walk
    can move the agent's cwd below the project root between hook calls. When
    no marker exists yet (first hook of a session, anywhere), cwd becomes the
    root and the marker is written there.
    """
    here = Path.cwd()
    for parent in [here, *here.parents]:
        if (parent / JOBS_REL / "root").is_file():
            return parent
    try:
        marker = here / JOBS_REL / "root"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(str(here), encoding="utf-8")
    except OSError:  # cwd not writable; this run uses it and anchors nothing
        pass
    return here


def project_config() -> Path:
    """The project-level config file this tool installs and reads."""
    return root() / JOBS_REL / "subagents.json"


def jobs_root() -> Path:
    return root() / JOBS_REL


def emit_json_output(data: dict) -> None:
    """Emit JSON to stdout as ASCII-safe bytes (Unicode preserved).

    Non-ASCII chars are emitted as JSON escapes so the payload survives
    consumers that decode hook stdout with the Windows system codepage
    instead of UTF-8; JSON parsing restores the original Unicode.
    """
    try:
        sys.stdout.buffer.write(json.dumps(data, ensure_ascii=True).encode("ascii"))
        sys.stdout.buffer.write(b"\n")
        sys.stdout.buffer.flush()
    except (AttributeError, OSError):
        print(json.dumps(data, ensure_ascii=True))
        sys.stdout.flush()


def _load_config(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _normalize(data: dict) -> dict:
    """Canonical mapping form for every entry.

    A plain string is the "self" shorthand: "Explore": "auto" runs that
    subagent through `claude -p --model auto --agent Explore`. Profile-based
    clauder entries and the shorthand send prompts over stdin by default; this
    preserves multiline prompts on platforms where Claude's positional prompt
    is split at the first newline. Other backends keep the historical argv
    default. {"command": ...} takes precedence over the profile/model/effort
    template.
    """
    out = {}
    for agent, entry in data.items():
        if isinstance(entry, str) and entry:
            out[str(agent)] = {
                "command": f"claude;-p;--model;{entry};--agent;{{agent}};{{prompt}}",
                "_append_prompt": False,
            }
        elif isinstance(entry, dict):
            out[str(agent)] = dict(entry)
    return out


def load_subagents() -> dict:
    """The subagent registry in effect for this session: {subagent_type: entry}.

    Project config (`.claude/harness-redirect-subagents/subagents.json`) wins
    on a name; entries defined only in the user-level file apply when that
    file's `projects` list names this project root. Every entry carries its
    own `_cwd`: the config file's base directory, which is where the backend
    runs — the project for project entries, home for user entries.
    """
    project = _normalize(_load_config(project_config()))
    for entry in project.values():
        entry.setdefault("_cwd", str(root()))

    user = _load_config(USER_CONFIG)
    if not user:
        return project
    projects = user.get("projects")
    if not isinstance(projects, list) or str(root()) not in projects:
        return project
    user_entries = _normalize(user.get("agents", {}))
    for entry in user_entries.values():
        entry.setdefault("_cwd", str(Path.home()))
    return {**user_entries, **project}  # project wins name conflicts


def clauder_command() -> list[str]:
    """Executable (and any launcher argv) for the "clauder" backend."""
    return os.environ.get("REDIRECT_SUBAGENTS_CLAUDER_BIN", "clauder").split(";")


def command_template() -> str:
    """Fallback command for entries that set profile/model/effort but no "command"."""
    return os.environ.get(
        "REDIRECT_SUBAGENTS_BACKEND",
        "clauder run {profile} -p --model {model} --effort {effort} --system-prompt {system_prompt} --agent {agent}",
    )


def build_backend(cfg: dict) -> str:
    """Name of the executable a config entry's command starts with."""
    template = cfg.get("command") or command_template()
    return template.split(";")[0].split(" ")[0]


def clauder_available() -> bool:
    import shutil

    return shutil.which(clauder_command()[0]) is not None


def build_cmd(cfg: dict, prompt: str, agent: str | None = None) -> list[str]:
    """The backend argv for one redirected subagent run.

    An explicit "command" template wins; otherwise REDIRECT_SUBAGENTS_BACKEND
    (defaulting to `clauder run …`) is used. The template is split into argv
    words on ';' and whitespace. Substitution fields are {prompt}, {agent},
    {system_prompt} and every other key of the config entry, so a custom
    backend can name whatever flags its own CLI takes. {agent} is available
    only when no explicit system_prompt is configured: the two Claude CLI
    options represent alternative ways to select the subagent's instructions.
    A word left holding an
    unsubstantiated {placeholder} — the entry never set that key — is dropped,
    and the flag it was the value for drops with it.
    """
    fields = {k: v for k, v in cfg.items() if not k.startswith("_") and k != "command"}
    if agent and not cfg.get("system_prompt"):
        fields["agent"] = agent

    template = cfg.get("command") or command_template()
    _append_prompt = append_prompt(cfg)
    parts: list[str] = []

    def drop_flag_for(missing: str) -> None:
        """Take the flag whose value just disappeared ("--model" once
        "{model}" resolved to nothing) — otherwise the next word, up to and
        including the prompt itself, is silently consumed as its value.
        Flags in _VALUELESS_FLAGS are complete statements on their own
        (`claude -p` takes no operand), so they are never the orphan.
        """
        if parts and parts[-1].startswith("-") and parts[-1] not in _VALUELESS_FLAGS:
            logger.debug("Dropping %s: its value %s is unset", parts[-1], missing)
            parts.pop()

    for word in template.split(";"):
        for w in word.split():
            for key, value in fields.items():
                w = w.replace("{" + key + "}", str(value))
            if "{prompt}" in w:
                if _append_prompt:
                    w = w.replace("{prompt}", prompt)
                else:
                    # Same rule as an unset config field: {prompt} with the
                    # field off means nothing for that flag to carry.
                    drop_flag_for("{prompt}")
                    continue
            if "{" in w or "}" in w:
                # A {placeholder} with no matching config key stayed: the entry
                # left that field unset, so anything it was part of goes.
                drop_flag_for(w)
                continue
            if w:
                parts.append(w)

    # No {prompt} anywhere in the template: the prompt is the trailing
    # operand, appended after every drop above so it can never be mistaken
    # for a missing flag's value.
    if "{prompt}" not in template and _append_prompt:
        parts.append(prompt)
    # A "clauder" executable segment is resolved through REDIRECT_SUBAGENTS_CLAUDER_BIN.
    if parts and parts[0] == "clauder":
        parts = [*clauder_command(), *parts[1:]]
    return parts


def append_prompt(cfg: dict) -> bool:
    """Whether this backend receives its prompt as a positional argv item."""
    return bool(cfg.get("_append_prompt", build_backend(cfg) != "clauder"))


def prompt_input(cfg: dict, prompt: str) -> str | None:
    """Prompt to pipe to the backend, or None when it is already in argv."""
    return None if append_prompt(cfg) else prompt


# Flags that take no value of their own, so the *next* flag is never mistaken
# for their missing operand.
_VALUELESS_FLAGS = {"-p", "--print", "--verbose", "--help", "-h", "--version"}




def jobs_dir() -> Path:
    d = jobs_root()
    d.mkdir(parents=True, exist_ok=True)
    return d


def job_dir(job_id: str) -> Path:
    return jobs_dir() / job_id


def is_done(job_id: str) -> bool:
    return (job_dir(job_id) / "done").exists()


def job_result(job_id: str) -> tuple[bool, str]:
    """(ok, text) for a finished job."""
    d = job_dir(job_id)
    try:
        code = int((d / "exit_code").read_text(encoding="utf-8").strip())
    except (FileNotFoundError, ValueError):
        code = -1
    stdout = (d / "stdout.log").read_text(encoding="utf-8", errors="replace").strip() if (d / "stdout.log").exists() else ""
    stderr = (d / "stderr.log").read_text(encoding="utf-8", errors="replace").strip() if (d / "stderr.log").exists() else ""
    if code == 0:
        return True, stdout
    return False, stderr or stdout or f"[subagent {job_id} exited with code {code}, no output]"


def job_meta(job_id: str) -> dict:
    return json.loads((job_dir(job_id) / "meta.json").read_text(encoding="utf-8"))


def write_meta(meta: dict) -> None:
    (job_dir(meta["job_id"]) / "meta.json").write_text(json.dumps(meta), encoding="utf-8")


def open_job_ids(session_id: str | None, done: bool | None = None) -> list[str]:
    """Job IDs owned by this session, oldest first.

    `done` filters on completion: True = finished, False = still running,
    None = either. "Open" means undelivered — a delivered job is history.
    """
    if not session_id or not jobs_dir().is_dir():
        return []
    metas = []
    for meta_path in jobs_dir().glob("*/meta.json"):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if meta.get("session_id") == session_id and not meta.get("delivered"):
            if done is None or is_done(meta["job_id"]) == done:
                metas.append(meta)
    metas.sort(key=lambda m: m.get("started_at", 0))
    return [m["job_id"] for m in metas]


def report_chunk(job_id: str) -> str:
    """How one finished job reads when handed back to the agent."""
    ok, text = job_result(job_id)
    agent = job_meta(job_id).get("agent", "?")
    label = "result" if ok else "failure"
    return f"[{agent} background subagent {job_id} {label}]\n{text}"


def deliver_report(job_ids: list[str]) -> str:
    """Mark jobs delivered and return their combined report, or "" if empty."""
    if not job_ids:
        return ""
    chunks = []
    for job_id in job_ids:
        chunks.append(report_chunk(job_id))
        meta = job_meta(job_id)
        meta["delivered"] = True
        meta["finished_at"] = meta.get("finished_at") or time.time()
        write_meta(meta)
    logger.info("Delivering output for %d background subagent(s): %s", len(job_ids), job_ids)
    return "\n\n---\n\n".join(chunks)




def is_deferrable(cfg: dict) -> bool:
    """Only clauder-backed entries defer when clauder is missing — an explicit
    "command" was the user's own choice of backend and failing it loudly is
    more honest than rerouting it."""
    return build_backend(cfg) == "clauder"


def defer_job(agent: str, prompt: str, session_id: str | None) -> str | None:
    """Record a subagent to re-run via `claude -p` on a later turn; None on failure."""
    import uuid

    job_id = uuid.uuid4().hex[:12]
    try:
        path = jobs_dir() / f"defer-{job_id}.json"
        path.write_text(json.dumps({
            "job_id": job_id,
            "agent": agent,
            "prompt": prompt,
            "session_id": session_id,
            "started_at": time.time(),
        }), encoding="utf-8")
    except OSError as e:
        logger.error("Could not defer subagent for later: %s", e)
        return None
    logger.info("Deferred subagent %s (job %s) — clauder not available", agent, job_id)
    return job_id


def pop_deferred(session_id: str | None) -> dict | None:
    """Oldest deferred job for this session, removed from disk; None if there is none."""
    d = jobs_root()
    if not session_id or not d.is_dir():
        return None
    paths = sorted(d.glob("defer-*.json"), key=lambda p: p.stat().st_mtime)
    for path in paths:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if payload.get("session_id") != session_id:
            continue
        path.unlink(missing_ok=True)
        return payload
    return None


def deferred_config(agent: str) -> dict | None:
    """The fallback a deferred job re-runs through: `claude -p --agent <name>`,
    with no model flag (the default model of whichever auth `claude` uses)."""
    cfg = load_subagents().get(agent)
    if cfg is None or not is_deferrable(cfg):
        return None
    return {
        "command": "claude;-p;--agent;{agent};{prompt}",
        "_append_prompt": False,
        "_cwd": cfg.get("_cwd", str(root())),
    }
