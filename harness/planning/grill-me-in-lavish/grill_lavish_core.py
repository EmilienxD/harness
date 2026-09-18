"""Temporary round inboxes and publication through Lavish."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path


class RoundError(ValueError):
    """Invalid content; a fresh retry path has been reserved."""


def validate_round(data):
    if not isinstance(data, dict):
        raise RoundError("Round must be a JSON object")
    questions = data.get("questions")
    if not isinstance(questions, list) or not questions:
        raise RoundError("questions must be a nonempty array")
    ids = set()
    for question in questions:
        if not isinstance(question, dict):
            raise RoundError("Each question must be an object")
        qid = question.get("id")
        if not isinstance(qid, str) or not re.fullmatch(r"Q[1-9][0-9]*", qid) or qid in ids:
            raise RoundError("Question IDs must be unique Q1, Q2, etc. identifiers")
        ids.add(qid)
        for field in ("question", "explanation_html"):
            if not isinstance(question.get(field), str) or not question[field].strip():
                raise RoundError(f"{qid}: {field} must be nonempty text")
        if "init_js" in question and not isinstance(question["init_js"], str):
            raise RoundError(f"{qid}: init_js must be text")
        options = question.get("options")
        if not isinstance(options, list) or not 1 <= len(options) <= 4:
            raise RoundError(f"{qid}: provide 1–4 options")
        letters = "ABCD"[:len(options)]
        for letter, option in zip(letters, options):
            if not isinstance(option, dict) or option.get("letter") != letter:
                raise RoundError(f"{qid}: options must be labeled consecutively A–D")
            for field in ("label", "detail"):
                if not isinstance(option.get(field), str) or not option[field].strip():
                    raise RoundError(f"{qid} {letter}: {field} is required")
        if question.get("recommendation") not in list(letters):
            raise RoundError(f"{qid}: recommendation must name an available option")


def atomic_write(path: Path, content: str):
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=".grill-", suffix=".tmp")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as file:
            file.write(content)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def render_round(data, round_number):
    validate_round(data)
    template = (Path(__file__).parent / "assets" / "board-template.html").read_text(encoding="utf-8")
    payload = json.dumps(data | {"round": round_number}, ensure_ascii=True).replace("<", "\\u003c")
    if template.count("__GRILL_ME_DATA__") != 1:
        raise RuntimeError("Board template must contain exactly one data marker")
    return template.replace("__GRILL_ME_DATA__", payload)


@dataclass
class Interview:
    directory: Path
    sequence: int = 1
    round: int = 1
    board_revision: int = 0
    opened: bool = False
    waiting: bool = False

    @property
    def source(self) -> Path:
        return self.directory / "inbox" / f"round-{self.sequence:03d}.json"

    @property
    def board(self) -> Path:
        name = "board.html" if self.board_revision == 0 else f"board-{self.board_revision:03d}.html"
        return self.directory / name

    @property
    def assets(self) -> Path:
        return self.directory / "assets" / f"round-{self.sequence:03d}"

    @property
    def assets_url(self) -> str:
        return self.assets.relative_to(self.directory).as_posix() + "/"


class InterviewRuntime:
    def __init__(self, root: Path | None = None):
        self.root = (root or Path(tempfile.gettempdir()) / "harness-grill").resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def key(provider, session):
        return hashlib.sha256(f"{provider}:{session}".encode()).hexdigest()

    @contextmanager
    def claim(self, provider, session):
        """Prevent concurrent hooks from publishing the same round twice."""
        with (self.root / f"{self.key(provider, session)}.lock").open("a+b") as file:
            if file.tell() == 0:
                file.write(b"0")
                file.flush()
            file.seek(0)
            if os.name == "nt":
                import msvcrt
                lock = lambda: msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
                unlock = lambda: msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                lock = lambda: fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                unlock = lambda: fcntl.flock(file, fcntl.LOCK_UN)
            try:
                lock()
            except OSError:
                yield False
                return
            try:
                yield True
            finally:
                file.seek(0)
                unlock()

    def current(self, provider, session):
        path = self.root / f"{self.key(provider, session)}.json"
        if not path.exists():
            return None
        state = json.loads(path.read_text(encoding="utf-8"))
        state["directory"] = Path(state["directory"])
        return Interview(**state)

    def save(self, provider, session, interview):
        atomic_write(self.root / f"{self.key(provider, session)}.json",
                     json.dumps(vars(interview) | {"directory": str(interview.directory)}))

    @staticmethod
    def reserve_fresh(interview):
        while interview.source.exists() or interview.source.is_symlink():
            interview.sequence += 1
        interview.assets.mkdir(parents=True, exist_ok=True)

    def start(self, provider, session, project):
        if self.root.is_relative_to(Path(project).resolve()):
            raise ValueError("Interview runtime directory must be outside the project")
        current = self.current(provider, session)
        if current:
            return self.interrupt(provider, session) or current
        directory = Path(tempfile.mkdtemp(prefix="interview-", dir=self.root))
        (directory / "inbox").mkdir()
        current = Interview(directory)
        current.assets.mkdir(parents=True)
        self.save(provider, session, current)
        return current

    def interrupt(self, provider, session):
        """Abandon an outstanding round when chat takes over."""
        interview = self.current(provider, session)
        if interview is None or not (interview.waiting or interview.source.exists()):
            return None
        if interview.waiting:
            interview.board_revision += 1
            interview.opened = False
            interview.waiting = False
        self.reserve_fresh(interview)
        self.save(provider, session, interview)
        return interview

    def publish(self, provider, session, lavish):
        interview = self.current(provider, session)
        if interview is None or not interview.source.is_file():
            return None
        source = interview.source
        publication = interview.sequence
        if interview.waiting:
            interview.board_revision += 1
            interview.opened = False
        interview.waiting = False
        interview.sequence += 1
        self.reserve_fresh(interview)
        self.save(provider, session, interview)
        try:
            if source.is_symlink():
                raise RoundError("Round source must be a regular file")
            data = json.loads(source.read_text(encoding="utf-8-sig"))
            validate_round(data)
        except (ValueError, UnicodeError) as error:
            raise RoundError(str(error)) from error
        shutil.copyfile(Path(__file__).parent / "assets" / "aboard.svg",
                        interview.directory / "assets" / "aboard.svg")
        atomic_write(interview.board, render_round(data, interview.round))
        interview.waiting = True
        self.save(provider, session, interview)
        if not interview.opened:
            lavish.open(interview.board)
            interview.opened = True
            self.save(provider, session, interview)
        feedback = lavish.poll(interview.board)
        feedback_file = interview.directory / f"feedback-{publication:03d}.json"
        atomic_write(feedback_file, json.dumps(feedback))
        review = feedback.get("session", {})
        interview.waiting = review.get("status") == "waiting"
        if review.get("status") in {"ended", "browser_disconnected", "user-ended"} or review.get("session_ended"):
            interview.board_revision += 1
            interview.opened = False
        elif not interview.waiting and not feedback.get("artifact_failures"):
            interview.round += 1
        self.save(provider, session, interview)
        return feedback, feedback_file
