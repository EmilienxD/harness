"""Durable temporary interview inboxes and provider-neutral Lavish lifecycle."""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path


class RoundError(ValueError):
    """Invalid content; a fresh retry path has been reserved."""


def validate_round(data):
    if not isinstance(data, dict):
        raise RoundError("Round must be a JSON object")
    if data.get("cancel") is True:
        return
    if data.get("complete") is True:
        if not isinstance(data.get("summary"), str) or not data["summary"].strip():
            raise RoundError("Completion requires a nonempty summary")
        return
    questions = data.get("questions")
    if not isinstance(questions, list) or not questions:
        raise RoundError("questions must be a nonempty array")
    ids = set()
    for question in questions:
        if not isinstance(question, dict):
            raise RoundError("Each question must be an object")
        qid = question.get("id")
        if not isinstance(qid, str) or not re.fullmatch(r"Q[1-9][0-9]*", qid) or qid in ids:
            raise RoundError("Question IDs must be unique Q1, Q2, … identifiers")
        ids.add(qid)
        for field in ("question", "explanation_html"):
            if not isinstance(question.get(field), str) or not question[field].strip():
                raise RoundError(f"{qid}: {field} must be nonempty text")
        for field in ("init_js",):
            if field in question and not isinstance(question[field], str):
                raise RoundError(f"{qid}: {field} must be text")
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
    phase: str = "ready"
    feedback: dict | None = None
    notified: bool = False
    opened: bool = False
    publication: int | None = None
    board_revision: int = 0
    replace_review: bool = False
    retiring_board: str | None = None
    opening_attempted: bool = False

    @property
    def source(self) -> Path:
        return self.directory / "inbox" / f"round-{self.sequence:03d}.json"

    @property
    def board(self) -> Path:
        name = "board.html" if self.board_revision == 0 else f"board-{self.board_revision:03d}.html"
        return self.directory / name

    @property
    def receipt(self) -> Path:
        # Existing waiting interviews retain their original receipt on upgrade.
        name = "feedback-receipt.json" if self.publication is None else f"feedback-receipt-{self.publication:03d}.json"
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

    @contextmanager
    def claim(self, provider, session):
        """Serialize hooks per conversation without blocking unrelated sessions."""
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

    def connect(self):
        connection = sqlite3.connect(self.root / "interviews.sqlite", timeout=30)
        connection.execute("CREATE TABLE IF NOT EXISTS interviews (id TEXT PRIMARY KEY, state TEXT NOT NULL)")
        return connection

    @staticmethod
    def key(provider, session):
        return hashlib.sha256(f"{provider}:{session}".encode()).hexdigest()

    def current(self, provider, session):
        connection = self.connect()
        try:
            row = connection.execute("SELECT state FROM interviews WHERE id=?", (self.key(provider, session),)).fetchone()
            if row is None:
                return None
            state = json.loads(row[0])
            state["directory"] = Path(state["directory"])
            return Interview(**state)
        finally:
            connection.close()

    def save(self, provider, session, interview):
        state = vars(interview) | {"directory": str(interview.directory)}
        connection = self.connect()
        try:
            with connection:
                connection.execute("INSERT OR REPLACE INTO interviews VALUES (?,?)", (self.key(provider, session), json.dumps(state)))
        finally:
            connection.close()

    def start(self, provider, session, project):
        current = self.current(provider, session)
        if current and current.phase not in {"complete", "paused"}:
            return current
        if self.root.is_relative_to(Path(project).resolve()):
            raise ValueError("Interview runtime directory must be outside the project")
        directory = Path(tempfile.mkdtemp(prefix="interview-", dir=self.root))
        (directory / "inbox").mkdir()
        current = Interview(directory)
        current.assets.mkdir(parents=True)
        self.save(provider, session, current)
        return current

    @staticmethod
    def reserve_fresh(interview):
        while interview.source.exists():
            interview.sequence += 1
        interview.assets.mkdir(parents=True, exist_ok=True)

    def publish(self, provider, session, lavish):
        interview = self.current(provider, session)
        if interview is not None and interview.phase == "closing":
            return self.close(provider, session, lavish)
        if interview is None or interview.phase not in {"ready", "paused"} or not interview.source.is_file():
            return interview
        source = interview.source
        try:
            if source.is_symlink():
                raise RoundError("Round source must be a regular file")
            data = json.loads(source.read_text(encoding="utf-8-sig"))
            validate_round(data)
            if interview.phase == "paused" and not (data.get("complete") is True or data.get("cancel") is True):
                raise RoundError("A paused review accepts only cancellation or completion; invoke the skill explicitly for further review")
        except (ValueError, UnicodeError) as error:
            interview.sequence += 1
            self.reserve_fresh(interview)
            self.save(provider, session, interview)
            raise RoundError(str(error)) from error
        if data.get("complete") is True or data.get("cancel") is True:
            if interview.board.exists():
                atomic_write(interview.board, render_round(data, interview.round))
            interview.phase = "closing"
            interview.feedback = None
            self.save(provider, session, interview)
            return self.close(provider, session, lavish)
        if interview.replace_review:
            interview.retiring_board = str(interview.board)
            interview.board_revision += 1
            interview.opened = False
            interview.opening_attempted = False
            interview.replace_review = False
            self.save(provider, session, interview)
        atomic_write(interview.board, render_round(data, interview.round))
        interview.publication = interview.sequence
        # Reserve the next fresh source before opening. The current input remains
        # immutable, including when a transport error needs recovery.
        interview.sequence += 1
        self.reserve_fresh(interview)
        interview.phase = "opening"
        interview.feedback = None
        interview.notified = False
        self.save(provider, session, interview)
        return self.open(provider, session, lavish)

    def close(self, provider, session, lavish):
        interview = self.current(provider, session)
        if interview is None or interview.phase == "complete":
            return interview
        if interview.phase != "closing":
            interview.phase = "closing"
            interview.feedback = None
            self.save(provider, session, interview)
        if interview.retiring_board:
            lavish.end(Path(interview.retiring_board))
            interview.retiring_board = None
            self.save(provider, session, interview)
        if interview.opened or interview.opening_attempted:
            lavish.end(interview.board)
            interview.opened = False
            interview.opening_attempted = False
        interview.phase = "complete"
        interview.replace_review = False
        self.save(provider, session, interview)
        return interview

    def open(self, provider, session, lavish):
        interview = self.current(provider, session)
        if interview.phase == "opening":
            if interview.retiring_board:
                lavish.end(Path(interview.retiring_board))
                interview.retiring_board = None
                self.save(provider, session, interview)
            if not interview.opened:
                # Opening may succeed before the transport returns. Persist
                # that possibility so cancellation can still close the review.
                interview.opening_attempted = True
                self.save(provider, session, interview)
                lavish.open(interview.board)
                interview.opened = True
                interview.opening_attempted = False
            interview.phase = "waiting"
            self.save(provider, session, interview)
        return interview

    def wait(self, provider, session, lavish):
        interview = self.current(provider, session)
        if interview is None or interview.phase != "waiting":
            return interview
        receipt = interview.receipt
        feedback = json.loads(receipt.read_text(encoding="utf-8")) if receipt.exists() else lavish.poll(interview.board, receipt)
        atomic_write(receipt, json.dumps(feedback))
        status = feedback.get("session", {}).get("status")
        if status == "waiting":
            receipt.unlink()
            return interview
        atomic_write(interview.directory / f"feedback-{interview.round:03d}.json", json.dumps(feedback))
        atomic_write(interview.directory / "feedback-latest.json", json.dumps(feedback))
        interview.feedback = feedback
        interview.notified = False
        self.reserve_fresh(interview)
        review_session = feedback.get("session", {})
        if status in {"ended", "browser_disconnected", "user-ended"} or review_session.get("session_ended"):
            interview.phase = "paused"
        else:
            interview.phase = "ready"
            # Fatal rendering feedback repairs this round rather than treating
            # it as a submitted answer batch.
            if not feedback.get("artifact_failures"):
                interview.round += 1
        self.save(provider, session, interview)
        receipt.unlink(missing_ok=True)
        return interview
