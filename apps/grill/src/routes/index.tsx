import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, CircleHelp, Folder, LoaderCircle, Lock, PanelLeft, Send, Trash2, X } from "lucide-react";
import type { AnswerDraft, GrillQuestion } from "@/lib/grill-contract";
import {
  isShortcutEditingTarget,
  matchesShortcut,
  shortcutAria,
  shortcutLabel,
  SHORTCUTS,
  shortcutTitle,
} from "@/lib/keyboard-shortcuts";

export const Route = createFileRoute("/")({ component: GrillBoard });

type SessionSummary = {
  id: string;
  provider: string;
  provider_session_id: string;
  display_title: string | null;
  project_name: string | null;
  project_path: string | null;
  last_activity_at: string;
  expires_at: string;
  active_round_id: string | null;
  active_round_number: number | null;
  answered_count: number;
  question_count: number;
  aboard: { terminal_state: string } | null;
};
type RoundSummary = { id: string; number: number; status: "active" | "superseded"; created_at: string };
type Answer = AnswerDraft & { updated_at: string; queued_at: string | null };
type Round = {
  id: string;
  session_id: string;
  number: number;
  status: "active" | "superseded";
  payload: { questions: GrillQuestion[] };
  answers: Answer[];
};
type SessionDetail = {
  session: SessionSummary;
  rounds: RoundSummary[];
  aboard: { terminal_state: string; last_heartbeat_at: string } | null;
};

class ApiError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json()) as { error?: { message?: string; code?: string } } & T;
  if (!response.ok) throw new ApiError(body.error?.message ?? "Request failed", body.error?.code ?? "request_failed");
  return body;
}

function requestedSession(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("session");
}

const PROVIDERS: Record<string, { name: string; icon: string }> = {
  claude: { name: "Claude", icon: "/anthropic.svg" },
  chatgpt: { name: "ChatGPT", icon: "/openai.svg" },
};

function ProviderTag({ provider }: { provider: string }) {
  const known = PROVIDERS[provider];
  return (
    <span className="provider-tag">
      {known ? <img src={known.icon} alt="" /> : null}
      {known?.name ?? provider}
    </span>
  );
}

function ProviderIcon({ provider }: { provider: string }) {
  const known = PROVIDERS[provider];
  return known ? <img src={known.icon} alt="" /> : null;
}

function sessionTitle(session: SessionSummary): string {
  return session.display_title || `${PROVIDERS[session.provider]?.name ?? session.provider} session`;
}

function daysUntilPurge(session: SessionSummary): number {
  return Math.max(0, Math.ceil((Date.parse(session.expires_at) - Date.now()) / 86_400_000));
}

function CopyIcon({ size = 17 }: { size?: number }) {
  return (
    <svg viewBox="0 0 460 460" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M425.934,0H171.662c-18.122,0-32.864,14.743-32.864,32.864v77.134h30V32.864c0-1.579,1.285-2.864,2.864-2.864h254.272c1.579,0,2.864,1.285,2.864,2.864v254.272c0,1.58-1.285,2.865-2.864,2.865h-74.729v30h74.729c18.121,0,32.864-14.743,32.864-32.865V32.864C458.797,14.743,444.055,0,425.934,0z" />
      <path d="M288.339,139.998H34.068c-18.122,0-32.865,14.743-32.865,32.865v254.272C1.204,445.257,15.946,460,34.068,460h254.272c18.122,0,32.865-14.743,32.865-32.864V172.863C321.206,154.741,306.461,139.998,288.339,139.998z M288.341,430H34.068c-1.58,0-2.865-1.285-2.865-2.864V172.863c0-1.58,1.285-2.865,2.865-2.865h254.272c1.58,0,2.865,1.285,2.865,2.865v254.273h0.001C291.206,428.715,289.92,430,288.341,430z" />
    </svg>
  );
}

function GrillBoard() {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(requestedSession);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [review, setReview] = useState<{ roundId: string; prompt: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState("");
  const cache = useRef(new Map<string, Round>());
  const page = useRef<HTMLElement>(null);
  const activeRound = useRef<HTMLDivElement>(null);
  const scrolledSession = useRef<string | null>(null);

  useEffect(() => {
    setRailOpen(window.matchMedia("(min-width: 901px)").matches);
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const result = await api<{ sessions: SessionSummary[] }>("sessions");
      setAuthorized(true);
      setSessions(result.sessions);
      setError("");
      setSelected(
        (current) =>
          current ??
          (result.sessions[0] ? `${result.sessions[0].provider}:${result.sessions[0].provider_session_id}` : null),
      );
    } catch (cause) {
      if ((cause as ApiError).code === "unauthorized") setAuthorized(false);
      else setError((cause as Error).message);
    }
  }, []);

  /** Superseded rounds are frozen, so polling only refetches the round that can still change. */
  const loadRounds = useCallback(async (summaries: RoundSummary[]) => {
    const loaded: Round[] = [];
    for (const summary of summaries) {
      const cached = cache.current.get(summary.id);
      if (cached && summary.status === "superseded" && cached.status === "superseded") {
        loaded.push(cached);
        continue;
      }
      const result = await api<{ round: Round }>(`rounds/${summary.id}`);
      cache.current.set(summary.id, result.round);
      loaded.push(result.round);
    }
    setRounds(loaded);
  }, []);

  const loadSelected = useCallback(async () => {
    if (!selected) {
      setDetail(null);
      setRounds([]);
      return;
    }
    const separator = selected.indexOf(":");
    try {
      if (separator < 1) return;
      const next = await api<SessionDetail>(
        `sessions/${encodeURIComponent(selected.slice(0, separator))}/${encodeURIComponent(selected.slice(separator + 1))}`,
      );
      setDetail(next);
      await loadRounds(next.rounds);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSwitching(false);
    }
  }, [loadRounds, selected]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);
  useEffect(() => {
    if (authorized) void loadSelected();
  }, [authorized, loadSelected]);
  useEffect(() => {
    if (!authorized) return;
    const timer = window.setInterval(() => {
      void (async () => {
        await loadSessions();
        await loadSelected();
      })();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [authorized, loadSessions, loadSelected]);

  useLayoutEffect(() => {
    if (!selected || rounds.length === 0 || scrolledSession.current === selected) return;
    const scroller = page.current;
    if (!scroller) return;
    const target = activeRound.current;
    if (target) {
      const targetTop = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTop = Math.max(0, targetTop - 24);
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
    scrolledSession.current = selected;
  }, [rounds.length, selected]);

  const chooseSession = useCallback(
    (session: SessionSummary) => {
      const key = `${session.provider}:${session.provider_session_id}`;
      if (!window.matchMedia("(min-width: 901px)").matches) setRailOpen(false);
      // Re-selecting the current session would leave the spinner waiting on a load that never reruns.
      if (key === selected) return;
      setSelected(key);
      setRounds([]);
      setReview(null);
      setSwitching(true);
      window.history.replaceState(null, "", `/?session=${encodeURIComponent(key)}`);
    },
    [selected],
  );

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.isComposing || isShortcutEditingTarget(event.target) || deleteTarget || review || shortcutsOpen) return;
      if (matchesShortcut(event, "help")) {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (matchesShortcut(event, "toggleSessions")) {
        event.preventDefault();
        setRailOpen((current) => !current);
        return;
      }
      if (matchesShortcut(event, "closeOverlay") && railOpen && !window.matchMedia("(min-width: 901px)").matches) {
        event.preventDefault();
        setRailOpen(false);
        return;
      }
      const direction = matchesShortcut(event, "previousSession") ? -1 : matchesShortcut(event, "nextSession") ? 1 : 0;
      if (!direction || sessions.length === 0) return;
      const current = sessions.findIndex(
        (session) => `${session.provider}:${session.provider_session_id}` === selected,
      );
      const target = current < 0 ? 0 : Math.min(sessions.length - 1, Math.max(0, current + direction));
      if (target === current) return;
      event.preventDefault();
      const session = sessions[target];
      if (session) chooseSession(session);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [chooseSession, deleteTarget, railOpen, review, selected, sessions, shortcutsOpen]);

  const closeReview = useCallback(() => setReview(null), []);

  const deleteSession = useCallback(
    async (session: SessionSummary) => {
      const key = `${session.provider}:${session.provider_session_id}`;
      await api(`sessions/${encodeURIComponent(session.provider)}/${encodeURIComponent(session.provider_session_id)}`, {
        method: "DELETE",
      });
      const remaining = sessions.filter((item) => item.id !== session.id);
      setSessions(remaining);
      cache.current.clear();
      if (selected === key) {
        const next = remaining[0];
        const nextKey = next ? `${next.provider}:${next.provider_session_id}` : null;
        setSelected(nextKey);
        setDetail(null);
        setRounds([]);
        setReview(null);
        setSwitching(Boolean(nextKey));
        window.history.replaceState(null, "", nextKey ? `/?session=${encodeURIComponent(nextKey)}` : "/");
      }
    },
    [selected, sessions],
  );

  const reloadRound = useCallback(async (id: string) => {
    const result = await api<{ round: Round }>(`rounds/${id}`);
    cache.current.set(id, result.round);
    setRounds((current) => current.map((item) => (item.id === id ? result.round : item)));
  }, []);

  if (authorized === null)
    return (
      <div className="center">
        <LoaderCircle className="spin" size={18} /> Loading board…
      </div>
    );
  if (!authorized) return <CodeGate onSuccess={() => void loadSessions()} />;

  const online = Boolean(detail?.aboard);
  const aboardReady = detail?.aboard?.terminal_state === "awaiting-user";
  const reviewed = review && rounds.find((item) => item.id === review.roundId);
  const orderedRounds = [...rounds].sort((left, right) => left.number - right.number);
  // One divider marks where frozen history ends and the current round begins.
  const currentRoundStart = orderedRounds.findIndex((item) => item.status === "active");
  return (
    <>
      <div className={`shell ${railOpen ? "is-open" : ""}`} inert={deleteTarget || shortcutsOpen ? true : undefined}>
        <aside className="rail">
          <div className="rail__brand">
            <button
              className="icon-button rail-toggle"
              aria-label="Hide sessions"
              aria-keyshortcuts={shortcutAria("toggleSessions")}
              aria-expanded={true}
              title={shortcutTitle("Hide sessions", "toggleSessions")}
              onClick={() => setRailOpen(false)}
            >
              <PanelLeft size={17} />
            </button>
            <span className="brand">
              <span className="brand__mark" aria-hidden="true">
                <img src="/logo.svg" alt="" />
              </span>
              <span className="brand__name">Grill-Me</span>
            </span>
          </div>
          <div className="rail__title">Recent sessions</div>
          <nav className="rail__list">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={`session-row ${selected === `${session.provider}:${session.provider_session_id}` ? "is-selected" : ""}`}
              >
                <button className="session-row__select" onClick={() => chooseSession(session)}>
                  <span className="session-row__title">
                    <ProviderIcon provider={session.provider} />
                    <b>{sessionTitle(session)}</b>
                  </span>
                  <span
                    className={`session-row__project ${session.project_name ? "" : "is-unknown"}`}
                    title={session.project_path ?? session.project_name ?? "Unknown project"}
                  >
                    <Folder size={13} aria-hidden="true" />
                    <strong>{session.project_name ?? "Unknown project"}</strong>
                    {session.project_path ? (
                      <span className="session-row__path" dir="rtl">
                        <bdi dir="ltr">{session.project_path}</bdi>
                      </span>
                    ) : null}
                  </span>
                  <span className="session-row__summary">
                    <span>Round {session.active_round_number ?? "—"}</span>
                    <span aria-hidden="true">•</span>
                    <span>
                      {session.answered_count}/{session.question_count} queued
                    </span>
                    {session.aboard ? <em>• {session.aboard.terminal_state}</em> : null}
                  </span>
                </button>
                <button
                  type="button"
                  className="session-row__delete"
                  aria-label={`Delete ${sessionTitle(session)}`}
                  onClick={() => setDeleteTarget(session)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </nav>
          <button
            type="button"
            className="rail__shortcuts"
            aria-keyshortcuts={shortcutAria("help")}
            onClick={() => setShortcutsOpen(true)}
          >
            <CircleHelp size={15} /> Keyboard shortcuts <kbd>{shortcutLabel("help")}</kbd>
          </button>
        </aside>
        <button className="scrim" aria-label="Close sessions" onClick={() => setRailOpen(false)} />
        <div className="content">
          {!railOpen && (
            <button
              className="icon-button rail-toggle"
              aria-label="Show sessions"
              aria-keyshortcuts={shortcutAria("toggleSessions")}
              aria-expanded={false}
              title={shortcutTitle("Show sessions", "toggleSessions")}
              onClick={() => setRailOpen(true)}
            >
              <PanelLeft size={17} />
            </button>
          )}
          {detail && (
            <span
              className={`aboard-badge ${online ? "is-online" : ""}`}
              role="status"
              title={online ? `Aboard ${detail.aboard?.terminal_state ?? "online"}` : "Aboard offline"}
            >
              <span className="aboard-badge__dot" aria-hidden="true" />
              ABOARD
              <span className="visually-hidden">{online ? "online" : "offline"}</span>
            </span>
          )}
          <main ref={page} className={railOpen ? "page" : "page is-rail-closed"}>
            <div className="page__inner">
              {error && (
                <div className="banner">
                  {error}
                  <button aria-label="Dismiss" onClick={() => setError("")}>
                    <X size={16} />
                  </button>
                </div>
              )}
              {switching || (selected && !detail) ? (
                <div className="loading">
                  <LoaderCircle className="spin" size={22} />
                </div>
              ) : !detail || rounds.length === 0 ? (
                <div className="empty">
                  <h2>No grill session selected</h2>
                </div>
              ) : (
                <>
                  <div className={reviewed ? "rounds is-behind" : "rounds"} inert={reviewed ? true : undefined}>
                    {orderedRounds.map((item, index) => (
                      <div key={item.id}>
                        {index > 0 && index === currentRoundStart && (
                          <div className="round-split">
                            <span className="round-split__label">
                              <Lock size={13} aria-hidden="true" /> Read only
                            </span>
                            <span className="round-split__line" />
                          </div>
                        )}
                        <div
                          ref={item.status === "active" ? activeRound : undefined}
                          className={item.status === "active" ? "round-card is-active" : "round-card"}
                        >
                          <Questionnaire
                            round={item}
                            shortcutActive={item.status === "active" && !reviewed && !shortcutsOpen && !deleteTarget}
                            onReload={() => reloadRound(item.id)}
                            onReview={async () => {
                              const result = await api<{ prompt: string }>(`rounds/${item.id}/prompt-preview`, {
                                method: "POST",
                                body: "{}",
                              });
                              setReview({ roundId: item.id, prompt: result.prompt });
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  {reviewed && review && (
                    <PromptModal
                      round={reviewed}
                      session={detail.session}
                      prompt={review.prompt}
                      aboardReady={aboardReady}
                      onClose={closeReview}
                      onReload={() => reloadRound(reviewed.id)}
                    />
                  )}
                </>
              )}
            </div>
          </main>
        </div>
      </div>
      {deleteTarget && (
        <DeleteSessionModal
          session={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async () => {
            await deleteSession(deleteTarget);
            setDeleteTarget(null);
          }}
        />
      )}
      {shortcutsOpen && <ShortcutHelpModal onClose={() => setShortcutsOpen(false)} />}
    </>
  );
}

function ShortcutHelpModal({ onClose }: { onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButton.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (matchesShortcut(event, "closeOverlay")) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  return (
    <div className="shortcut-modal" role="dialog" aria-modal="true" aria-labelledby="shortcut-title">
      <button type="button" className="shortcut-modal__scrim" aria-label="Close keyboard shortcuts" onClick={onClose} />
      <div className="shortcut-modal__card">
        <div className="shortcut-modal__top">
          <div>
            <span className="eyebrow">Reference</span>
            <h2 id="shortcut-title">Keyboard shortcuts</h2>
          </div>
          <button
            ref={closeButton}
            type="button"
            className="icon-button"
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
        <div className="shortcut-modal__list">
          {Object.entries(SHORTCUTS).map(([id, shortcut]) => (
            <div key={id} className="shortcut-modal__row">
              <span>
                <b>{shortcut.description}</b>
                <small>{shortcut.scope}</small>
              </span>
              <kbd>{shortcutLabel(id as keyof typeof SHORTCUTS)}</kbd>
            </div>
          ))}
        </div>
        <p>Shortcuts are paused while you type or interact with question content.</p>
      </div>
    </div>
  );
}

function DeleteSessionModal({
  session,
  onCancel,
  onConfirm,
}: {
  session: SessionSummary;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelButton.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (matchesShortcut(event, "closeOverlay") && !busy) {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [busy, onCancel]);

  const confirm = async () => {
    setBusy(true);
    setMessage("");
    try {
      await onConfirm();
    } catch (cause) {
      setMessage((cause as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-session-title">
      <button
        type="button"
        className="delete-modal__scrim"
        aria-label="Cancel session deletion"
        disabled={busy}
        onClick={onCancel}
      />
      <div className="delete-modal__card">
        <h2 id="delete-session-title">Delete this session?</h2>
        <dl className="delete-modal__facts">
          <div>
            <dt>Session</dt>
            <dd>{sessionTitle(session)}</dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>
              <ProviderTag provider={session.provider} />
            </dd>
          </div>
          <div>
            <dt>Progress</dt>
            <dd>
              Round {session.active_round_number ?? "—"}
              <span aria-hidden="true"> · </span>
              {session.answered_count}/{session.question_count} queued
            </dd>
          </div>
          <div>
            <dt>Auto-purge</dt>
            <dd>In {daysUntilPurge(session)} days</dd>
          </div>
        </dl>
        {message && <span className="delete-modal__error">{message}</span>}
        <div className="delete-modal__actions">
          <button ref={cancelButton} type="button" className="delete-modal__cancel" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="delete-modal__confirm" disabled={busy} onClick={() => void confirm()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : null}
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

function CodeGate({ onSuccess }: { onSuccess: () => void }) {
  const [digits, setDigits] = useState(["", "", "", ""]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState("");
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const code = digits.join("");

  useEffect(() => {
    inputs.current[0]?.focus();
  }, []);

  const open = async (event: React.FormEvent) => {
    event.preventDefault();
    if (code.length !== 4 || busy) return;
    setBusy(true);
    setMessage("");
    try {
      await api("access", { method: "POST", body: JSON.stringify({ code }) });
      onSuccess();
    } catch (cause) {
      const failure = cause as ApiError;
      if (failure.code === "too_many_attempts") setMessage(failure.message);
      setFailed(true);
      window.setTimeout(() => {
        setDigits(["", "", "", ""]);
        setFailed(false);
        inputs.current[0]?.focus();
      }, 500);
    } finally {
      setBusy(false);
    }
  };

  const change = (index: number, value: string) => {
    const digit = value.replace(/\D/gu, "").slice(-1);
    setDigits((current) => current.map((item, position) => (position === index ? digit : item)));
    if (digit && index < 3) inputs.current[index + 1]?.focus();
  };

  const keyDown = (index: number, event: React.KeyboardEvent) => {
    if (event.key === "Backspace" && !digits[index] && index > 0) inputs.current[index - 1]?.focus();
  };

  const paste = (event: React.ClipboardEvent) => {
    event.preventDefault();
    const pasted = event.clipboardData.getData("text").replace(/\D/gu, "").slice(0, 4);
    if (!pasted) return;
    setDigits(["", "", "", ""].map((_item, index) => pasted[index] ?? ""));
    inputs.current[Math.min(pasted.length, 3)]?.focus();
  };

  return (
    <main className="gate">
      <form className="gate__inner" onSubmit={open}>
        <span className="gate__mark">
          <img src="/logo.svg" alt="" />
        </span>
        <h1>Enter access code</h1>
        <div className="gate__code">
          <div className={`gate__digits ${failed ? "is-error" : ""}`} onPaste={paste}>
            {digits.map((digit, index) => (
              <input
                // The four fields are positional, so their index is their identity.
                key={index}
                ref={(element) => {
                  inputs.current[index] = element;
                }}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={1}
                value={digit}
                aria-label={`Digit ${index + 1}`}
                onChange={(event) => change(index, event.target.value)}
                onKeyDown={(event) => keyDown(index, event)}
              />
            ))}
          </div>
          {message ? <div className="gate__message">{message}</div> : null}
          <button className="submit" disabled={busy || code.length !== 4}>
            {busy ? <LoaderCircle className="spin" size={17} /> : "Open"}
          </button>
        </div>
      </form>
    </main>
  );
}

function Questionnaire({
  round,
  shortcutActive,
  onReload,
  onReview,
}: {
  round: Round;
  shortcutActive: boolean;
  onReload: () => Promise<void>;
  onReview: () => Promise<void>;
}) {
  const readOnly = round.status !== "active";
  const [active, setActive] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const questions = round.payload.questions;

  useEffect(() => {
    setActive(0);
  }, [round.id]);

  const answerFor = (id: string) => round.answers.find((answer) => answer.question_id === id);
  const queuedCount = round.answers.filter((answer) => answer.state === "queued").length;

  const reviewPrompt = useCallback(async () => {
    setReviewing(true);
    try {
      await onReview();
    } finally {
      setReviewing(false);
    }
  }, [onReview]);

  useEffect(() => {
    if (!shortcutActive) return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.isComposing || isShortcutEditingTarget(event.target)) return;
      if (matchesShortcut(event, "previousQuestion")) {
        event.preventDefault();
        setActive((current) => Math.max(0, current - 1));
        return;
      }
      if (matchesShortcut(event, "nextQuestion")) {
        event.preventDefault();
        setActive((current) => Math.min(questions.length - 1, current + 1));
        return;
      }
      if (matchesShortcut(event, "reviewPrompt") && queuedCount > 0 && !reviewing) {
        event.preventDefault();
        void reviewPrompt();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [questions.length, queuedCount, reviewPrompt, reviewing, shortcutActive]);

  const advance = (index: number) => {
    const next = questions.findIndex(
      (question, position) => position > index && answerFor(question.id)?.state !== "queued",
    );
    const target = next >= 0 ? next : questions.findIndex((question) => answerFor(question.id)?.state !== "queued");
    if (target >= 0 && target !== index) window.setTimeout(() => setActive(target), 420);
  };

  const map = useMemo(() => {
    const size = Math.min(7, questions.length);
    const start = Math.min(Math.max(0, active - Math.floor(size / 2)), questions.length - size);
    return questions.slice(start, start + size).map((question, offset) => ({ question, index: start + offset }));
  }, [active, questions]);

  return (
    <div className="deck-wrap">
      <div
        className={`deck ${active === questions.length - 2 ? "is-penult" : ""} ${active === questions.length - 1 ? "is-last" : ""}`}
      >
        {questions.map((question, index) => (
          <QuestionCard
            key={question.id}
            round={round}
            question={question}
            answer={answerFor(question.id)}
            readOnly={readOnly}
            hidden={index !== active}
            canReview={queuedCount > 0}
            reviewing={reviewing}
            shortcutsEnabled={shortcutActive && index === active}
            map={
              <div className="question-map" role="navigation" aria-label="Question navigation">
                {map.map((entry) => (
                  <button
                    key={entry.question.id}
                    className={`map-btn ${entry.index === active ? "is-active" : ""} ${answerFor(entry.question.id)?.state === "queued" ? "is-queued" : ""}`}
                    aria-current={entry.index === active}
                    onClick={() => setActive(entry.index)}
                  >
                    {entry.question.id}
                  </button>
                ))}
              </div>
            }
            onReload={onReload}
            onQueued={() => advance(index)}
            onReview={reviewPrompt}
          />
        ))}
      </div>
    </div>
  );
}

function QuestionCard({
  round,
  question,
  answer,
  readOnly,
  hidden,
  canReview,
  reviewing,
  shortcutsEnabled,
  map,
  onReload,
  onQueued,
  onReview,
}: {
  round: Round;
  question: GrillQuestion;
  answer: Answer | undefined;
  readOnly: boolean;
  hidden: boolean;
  canReview: boolean;
  reviewing: boolean;
  shortcutsEnabled: boolean;
  map: React.ReactNode;
  onReload: () => Promise<void>;
  onQueued: () => void;
  onReview: () => Promise<void>;
}) {
  const [selection, setSelection] = useState(answer?.selected_option ?? "");
  const [note, setNote] = useState(answer?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const noteField = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setSelection(answer?.selected_option ?? "");
    setNote(answer?.note ?? "");
  }, [answer?.selected_option, answer?.note, round.id]);

  const queued = answer?.state === "queued";
  const unchanged = selection === (answer?.selected_option ?? "") && note === (answer?.note ?? "");

  // Only queueing touches the database; radio and note edits stay local until then.
  const canQueue = !readOnly && !busy && !(queued && unchanged) && Boolean(answer || selection || note.trim());

  const queue = useCallback(async () => {
    setBusy(true);
    setMessage("");
    try {
      await api(`rounds/${round.id}/answers/${question.id}`, {
        method: "PUT",
        body: JSON.stringify({ selected_option: selection || null, note: note || null, state: "queued" }),
      });
      await onReload();
      onQueued();
    } catch (cause) {
      setMessage((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }, [note, onQueued, onReload, question.id, round.id, selection]);

  useEffect(() => {
    if (!shortcutsEnabled) return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const editing = isShortcutEditingTarget(event.target);
      if (matchesShortcut(event, "queueAnswer") && (!editing || event.target === noteField.current)) {
        if (!canQueue) return;
        event.preventDefault();
        void queue();
        return;
      }
      if (editing || !matchesShortcut(event, "selectOption") || readOnly) return;
      const option = question.options.find((item) => item.letter.toLocaleLowerCase() === event.key.toLocaleLowerCase());
      if (!option) return;
      event.preventDefault();
      setSelection(option.letter);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [canQueue, question.options, queue, readOnly, shortcutsEnabled]);

  return (
    <article className="question" hidden={hidden} inert={hidden}>
      <div className="question__pad">
        <div className="question__top">
          <div className="qid-slot">{hidden ? null : map}</div>
          <span className="round-label">Round {round.number}</span>
        </div>
        <h2>{question.question}</h2>
        <Explanation question={question} />
        <form
          className="answer-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!readOnly && !busy) void queue();
          }}
        >
          <div className="options">
            {question.options.map((option) => (
              <label key={option.letter} className="option">
                <input
                  type="radio"
                  name={`${round.id}-${question.id}`}
                  checked={selection === option.letter}
                  disabled={readOnly}
                  aria-keyshortcuts={shortcutAria("selectOption", option.letter)}
                  onChange={() => setSelection(option.letter)}
                />
                <span className="option__copy">
                  <span className="option__label">
                    {option.letter}. {option.label}
                  </span>
                  <span className="option__detail">{option.detail}</span>
                </span>
                <span className="option__badges">
                  {option.letter === question.recommendation && <span className="rec-badge">Recommended</span>}
                  {queued && answer?.selected_option === option.letter && <span className="sel-badge">Selected</span>}
                </span>
              </label>
            ))}
          </div>
          <div className="freeform">
            <button
              type="button"
              className="text-link"
              disabled={readOnly}
              onClick={() => {
                setSelection("");
                noteField.current?.focus();
              }}
            >
              Write my own answer
            </button>
            <textarea
              ref={noteField}
              disabled={readOnly}
              maxLength={2000}
              value={note}
              aria-label="Add context or write your own answer"
              onChange={(event) => setNote(event.target.value)}
              placeholder="Add context or write your own answer..."
            />
          </div>
          <div className="question__foot">
            <button
              type="submit"
              className="submit"
              disabled={!canQueue}
              aria-keyshortcuts={shortcutAria("queueAnswer")}
              title={shortcutTitle(queued ? "Update answer" : "Queue answer", "queueAnswer")}
            >
              {busy ? <LoaderCircle className="spin" size={16} /> : readOnly ? <Lock size={16} /> : <Check size={16} />}
              {queued ? "Update answer" : "Queue answer"}
            </button>
            <button
              type="button"
              className="submit round-submit is-ghost"
              disabled={!canReview || reviewing}
              aria-keyshortcuts={shortcutAria("reviewPrompt")}
              title={shortcutTitle("Review prompt", "reviewPrompt")}
              onClick={() => void onReview()}
            >
              {reviewing ? <LoaderCircle className="spin" size={16} /> : null} Review prompt
            </button>
            <span className="form-message" role="alert">
              {message}
            </span>
          </div>
        </form>
      </div>
    </article>
  );
}

function Explanation({ question }: { question: GrillQuestion }) {
  const root = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!question.init_js || !root.current) return;
    try {
      new Function("root", `"use strict";\n${question.init_js}`)(root.current);
    } catch {
      setFailed(true);
    }
  }, [question.id, question.init_js, question.explanation_html]);
  return (
    <>
      <div
        ref={root}
        id={`explanation-${question.id}`}
        className="explanation"
        dangerouslySetInnerHTML={{ __html: question.explanation_html }}
      />
      {failed && <div className="explanation-error">This question's interactive explanation could not initialize.</div>}
    </>
  );
}

function PromptModal({
  round,
  session,
  prompt,
  aboardReady,
  onClose,
  onReload,
}: {
  round: Round;
  session: SessionSummary;
  prompt: string;
  aboardReady: boolean;
  onClose: () => void;
  onReload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");
  const readOnly = round.status !== "active";
  const confirmation = useRef<number>(undefined);

  // The confirmation timer has to outlive re-renders, so only unmounting cancels it.
  useEffect(() => () => window.clearTimeout(confirmation.current), []);

  const confirmCopy = useCallback(() => {
    setCopied(true);
    window.clearTimeout(confirmation.current);
    confirmation.current = window.setTimeout(() => setCopied(false), 2_000);
  }, []);

  const snapshot = useCallback(
    async (reason: "copy" | "aboard") => {
      setBusy(reason);
      setMessage("");
      try {
        // A historical round cannot record snapshots, so its copy comes straight from the preview.
        if (readOnly) {
          await navigator.clipboard.writeText(prompt);
          confirmCopy();
          return;
        }
        const result = await api<{ snapshot: { id: string; prompt: string } }>(`rounds/${round.id}/prompt-snapshots`, {
          method: "POST",
          body: JSON.stringify({ reason, expected_prompt: prompt }),
        });
        if (reason === "copy") {
          await navigator.clipboard.writeText(result.snapshot.prompt);
          confirmCopy();
        } else {
          await api(`prompt-snapshots/${result.snapshot.id}/deliveries`, { method: "POST", body: "{}" });
          setMessage("Delivery queued for Aboard.");
        }
        await onReload();
      } catch (cause) {
        setMessage((cause as Error).message);
      } finally {
        setBusy("");
      }
    },
    [confirmCopy, onReload, prompt, readOnly, round.id],
  );

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.isComposing || isShortcutEditingTarget(event.target)) return;
      if (matchesShortcut(event, "closeOverlay")) {
        event.preventDefault();
        onClose();
        return;
      }
      if (matchesShortcut(event, "copyPrompt") && prompt && !busy) {
        event.preventDefault();
        void snapshot("copy");
        return;
      }
      if (matchesShortcut(event, "sendPrompt") && prompt && !readOnly && aboardReady && !busy) {
        event.preventDefault();
        void snapshot("aboard");
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [aboardReady, busy, onClose, prompt, readOnly, snapshot]);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Prompt review">
      <button type="button" className="modal__scrim" aria-label="Back to questions" onClick={onClose} />
      <div className="modal__card">
        <div className="modal__top">
          <button type="button" className="icon-button" aria-label="Back to questions" onClick={onClose}>
            <ChevronLeft size={17} />
          </button>
          <span className="modal__label">
            {session.display_title || "Grill review"}
            <span aria-hidden="true">•</span>
            <ProviderTag provider={session.provider} />
            <span aria-hidden="true">•</span>
            Round {round.number}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label={copied ? "Prompt copied" : "Copy prompt"}
            aria-keyshortcuts={shortcutAria("copyPrompt")}
            disabled={!prompt || Boolean(busy)}
            title={shortcutTitle(copied ? "Prompt copied" : "Copy prompt", "copyPrompt")}
            onClick={() => void snapshot("copy")}
          >
            {busy === "copy" ? (
              <LoaderCircle className="spin" size={16} />
            ) : copied ? (
              <Check size={17} />
            ) : (
              <CopyIcon size={16} />
            )}
          </button>
        </div>
        <pre>{prompt || "Nothing is queued yet."}</pre>
        <div className="modal__foot">
          {message && (
            <span className="modal__message" role="alert">
              {message}
            </span>
          )}
          <button
            type="button"
            className="submit modal__send"
            disabled={!prompt || readOnly || !aboardReady || Boolean(busy)}
            aria-keyshortcuts={shortcutAria("sendPrompt")}
            title={
              readOnly
                ? "Historical rounds cannot be sent"
                : aboardReady
                  ? shortcutTitle("Send via Aboard", "sendPrompt")
                  : "Aboard is not awaiting input"
            }
            onClick={() => void snapshot("aboard")}
          >
            {busy === "aboard" ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />} Send via Aboard
          </button>
        </div>
      </div>
    </div>
  );
}
