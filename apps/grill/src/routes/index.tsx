import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronLeft, CircleHelp, Folder, LoaderCircle, Lock, PanelLeft, Send, Trash2, X } from "lucide-react";
import type { HLJSApi } from "highlight.js";
import type { AnswerDraft, GrillQuestion } from "@/lib/grill-contract";
import {
  ignoresShortcuts,
  leaveTextEntry,
  shortcutLetter,
  matchesShortcut,
  shortcutLabel,
  SHORTCUTS,
  useShortcuts,
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
  aboard: { workspace_name: string | null; workspace_path: string | null } | null;
};
type RoundSummary = { id: string; number: number; status: "active" | "superseded"; created_at: string };
type Answer = AnswerDraft & { updated_at: string; queued_at: string | null };
type AnswerBody = { selected_option: string | null; note: string | null };
type SaveAnswer = (roundId: string, questionId: string, body: AnswerBody, keepalive: boolean) => Promise<void>;
type Round = {
  id: string;
  session_id: string;
  number: number;
  status: "active" | "superseded";
  payload: { questions: GrillQuestion[] };
  answers: Answer[];
  prompt_snapshots: Array<{ reason: "copy" | "aboard"; grill_deliveries: Array<{ status: string }> }>;
};
type SessionDetail = {
  session: SessionSummary;
  rounds: RoundSummary[];
  aboard: {
    workspace_name: string | null;
    workspace_path: string | null;
    last_heartbeat_at: string;
  } | null;
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

/** A two-second in-place checkmark, shared by every action that confirms without a message. */
function useConfirmation(): [boolean, () => void] {
  const [confirmed, setConfirmed] = useState(false);
  const timer = useRef<number>(undefined);
  // The timer has to outlive re-renders, so only unmounting cancels it.
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const confirm = useCallback(() => {
    setConfirmed(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setConfirmed(false), 2_000);
  }, []);
  return [confirmed, confirm];
}

/** Resolves once Aboard reports that the provider confirmed the prompt; the server expires deliveries after 30 seconds. */
async function awaitDelivery(id: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const { delivery } = await api<{ delivery: { status: string; failure_message: string | null } }>(
      `deliveries/${id}`,
    );
    if (delivery.status === "submitted-to-terminal") return;
    if (delivery.status === "failed") throw new Error(delivery.failure_message ?? "Aboard could not send the prompt.");
    if (delivery.status === "expired" || Date.now() >= deadline)
      throw new Error("Aboard did not confirm the prompt in time.");
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  }
}

/**
 * Safari only lets a tap write to the clipboard before the handler first awaits, so the write
 * starts at once and receives the text as a promise that the snapshot request settles later.
 */
function copyText(text: Promise<string>): Promise<void> {
  const copy =
    typeof ClipboardItem === "undefined"
      ? text.then((value) => navigator.clipboard.writeText(value))
      : navigator.clipboard.write([
          new ClipboardItem({ "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })) }),
        ]);
  // Browser clipboard errors are long and technical, such as Safari's NotAllowedError.
  return copy.catch(() => {
    throw new Error("Copy failed. Try again.");
  });
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
  const [displayedRoundId, setDisplayedRoundId] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState("");
  const shortcuts = useShortcuts();
  const cache = useRef(new Map<string, Round>());
  const page = useRef<HTMLElement>(null);
  const activeRound = useRef<HTMLDivElement>(null);
  const roundElements = useRef(new Map<string, HTMLDivElement>());
  const scrolledActiveRound = useRef<{ session: string; roundId: string | null } | null>(null);
  // Answer saves bump the generation when they start and finish, so polls can detect answers read before them.
  const writes = useRef({ pending: 0, generation: 0 });

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
    const generation = writes.current.generation;
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
    // A save that overlapped this poll makes its answers older than the board's; the next poll catches up.
    const overlapped = writes.current.pending > 0 || writes.current.generation !== generation;
    setRounds((current) =>
      overlapped ? loaded.map((round) => current.find((item) => item.id === round.id) ?? round) : loaded,
    );
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
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [authorized, loadSessions, loadSelected]);

  useLayoutEffect(() => {
    if (!selected || rounds.length === 0) return;
    const scroller = page.current;
    if (!scroller) return;
    const active = rounds.find((round) => round.status === "active") ?? rounds.at(-1);
    const previous = scrolledActiveRound.current;
    if (previous?.session === selected && previous.roundId === (active?.id ?? null)) return;
    const target = activeRound.current;
    if (target) {
      const targetTop = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTop = Math.max(0, targetTop - 24);
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
    setDisplayedRoundId(active?.id ?? null);
    scrolledActiveRound.current = { session: selected, roundId: active?.id ?? null };
  }, [rounds, selected]);

  useEffect(() => {
    const scroller = page.current;
    if (!scroller || rounds.length === 0) return;
    let frame = 0;
    const updateDisplayedRound = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const anchor = scroller.getBoundingClientRect().top + 24;
        let closest: { id: string; distance: number } | null = null;
        for (const round of rounds) {
          const element = roundElements.current.get(round.id);
          if (!element) continue;
          const distance = Math.abs(element.getBoundingClientRect().top - anchor);
          if (!closest || distance < closest.distance) closest = { id: round.id, distance };
        }
        if (closest) setDisplayedRoundId(closest.id);
      });
    };
    updateDisplayedRound();
    scroller.addEventListener("scroll", updateDisplayedRound, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", updateDisplayedRound);
    };
  }, [rounds]);

  const scrollToRound = useCallback((id: string) => {
    const scroller = page.current;
    const target = roundElements.current.get(id);
    if (!scroller || !target) return;
    setDisplayedRoundId(id);
    const targetTop = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTo({ top: Math.max(0, targetTop - 24), behavior: "auto" });
  }, []);

  const chooseSession = useCallback(
    (session: SessionSummary) => {
      const key = `${session.provider}:${session.provider_session_id}`;
      if (!window.matchMedia("(min-width: 901px)").matches) setRailOpen(false);
      // Re-selecting the current session would leave the spinner waiting on a load that never reruns.
      if (key === selected) return;
      setSelected(key);
      setRounds([]);
      setDisplayedRoundId(null);
      setReview(null);
      setSwitching(true);
      window.history.replaceState(null, "", `/?session=${encodeURIComponent(key)}`);
    },
    [selected],
  );

  useEffect(() => {
    window.addEventListener("keydown", leaveTextEntry, true);
    return () => window.removeEventListener("keydown", leaveTextEntry, true);
  }, []);

  useEffect(() => {
    if (!shortcuts.enabled) return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (ignoresShortcuts(event) || deleteTarget || review || shortcutsOpen) return;
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
      const scroll = matchesShortcut(event, "scrollUp") ? -1 : matchesShortcut(event, "scrollDown") ? 1 : 0;
      if (scroll) {
        // The board scrolls inside the page element, so native arrow keys either miss it or
        // move a focused radio group; the page scrolls whatever holds focus instead.
        event.preventDefault();
        page.current?.scrollBy({ top: scroll * ARROW_SCROLL_STEP, behavior: "instant" });
        return;
      }
      if (matchesShortcut(event, "closeOverlay") && railOpen && !window.matchMedia("(min-width: 901px)").matches) {
        event.preventDefault();
        setRailOpen(false);
        return;
      }
      const direction = matchesShortcut(event, "previousRound") ? -1 : matchesShortcut(event, "nextRound") ? 1 : 0;
      if (!direction || rounds.length === 0) return;
      event.preventDefault();
      const ordered = [...rounds].sort((left, right) => left.number - right.number);
      const fallback = ordered.findIndex((round) => round.status === "active");
      const current = ordered.findIndex((round) => round.id === displayedRoundId);
      const origin = current >= 0 ? current : fallback >= 0 ? fallback : ordered.length - 1;
      const target = Math.min(ordered.length - 1, Math.max(0, origin + direction));
      const round = ordered[target];
      if (round) scrollToRound(round.id);
    };
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [deleteTarget, displayedRoundId, railOpen, review, rounds, scrollToRound, shortcuts.enabled, shortcutsOpen]);

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

  const saveAnswer = useCallback<SaveAnswer>(async (roundId, questionId, body, keepalive) => {
    writes.current.pending += 1;
    writes.current.generation += 1;
    try {
      const { answer } = await api<{ answer: Answer | null }>(`rounds/${roundId}/answers/${questionId}`, {
        method: "PUT",
        body: JSON.stringify({ ...body, state: "queued" }),
        keepalive,
      });
      const merge = (round: Round): Round => ({
        ...round,
        answers: [...round.answers.filter((item) => item.question_id !== questionId), ...(answer ? [answer] : [])],
      });
      const cached = cache.current.get(roundId);
      if (cached) cache.current.set(roundId, merge(cached));
      setRounds((current) => current.map((item) => (item.id === roundId ? merge(item) : item)));
    } finally {
      writes.current.pending -= 1;
      writes.current.generation += 1;
    }
  }, []);

  if (authorized === null)
    return (
      <div className="center">
        <LoaderCircle className="spin" size={18} /> Loading board…
      </div>
    );
  if (!authorized) return <CodeGate onSuccess={() => void loadSessions()} />;

  const online = Boolean(detail?.aboard);
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
              aria-keyshortcuts={shortcuts.aria("toggleSessions")}
              aria-expanded={true}
              title={shortcuts.title("Hide sessions", "toggleSessions")}
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
                      {session.answered_count}/{session.question_count} answered
                    </span>
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
          {shortcuts.enabled && (
            <button
              type="button"
              className="rail__shortcuts"
              aria-keyshortcuts={shortcuts.aria("help")}
              onClick={() => setShortcutsOpen(true)}
            >
              <CircleHelp size={15} /> Keyboard shortcuts <kbd>{shortcutLabel("help")}</kbd>
            </button>
          )}
        </aside>
        <button className="scrim" aria-label="Close sessions" onClick={() => setRailOpen(false)} />
        <div className="content">
          {!railOpen && (
            <button
              className="icon-button rail-toggle"
              aria-label="Show sessions"
              aria-keyshortcuts={shortcuts.aria("toggleSessions")}
              aria-expanded={false}
              title={shortcuts.title("Show sessions", "toggleSessions")}
              onClick={() => setRailOpen(true)}
            >
              <PanelLeft size={17} />
            </button>
          )}
          {detail && (
            <span
              className={`aboard-badge ${online ? "is-online" : ""}`}
              role="status"
              title={
                online
                  ? `Aboard online in ${detail.aboard?.workspace_path ?? detail.aboard?.workspace_name ?? "an unknown project"}`
                  : "Aboard offline"
              }
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
                          ref={(element) => {
                            if (element) roundElements.current.set(item.id, element);
                            else roundElements.current.delete(item.id);
                            if (item.status === "active") activeRound.current = element;
                          }}
                          className={item.status === "active" ? "round-card is-active" : "round-card"}
                        >
                          <Questionnaire
                            round={item}
                            shortcutActive={
                              shortcuts.enabled &&
                              item.id === displayedRoundId &&
                              !reviewed &&
                              !shortcutsOpen &&
                              !deleteTarget
                            }
                            onSave={saveAnswer}
                            onRevealRound={() => scrollToRound(item.id)}
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
                      aboardReady={online}
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
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [onClose]);

  return (
    <div className="shortcut-modal" role="dialog" aria-modal="true" aria-labelledby="shortcut-title">
      <button type="button" className="shortcut-modal__scrim" aria-label="Close keyboard shortcuts" onClick={onClose} />
      <div className="shortcut-modal__card">
        <div className="shortcut-modal__top">
          <div>
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
  return (
    <ConfirmModal
      title="Delete this session?"
      cancelLabel="Cancel session deletion"
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
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
            {session.answered_count}/{session.question_count} answered
          </dd>
        </div>
        <div>
          <dt>Auto-purge</dt>
          <dd>In {daysUntilPurge(session)} days</dd>
        </div>
      </dl>
    </ConfirmModal>
  );
}

/** A confirmation card: Cancel takes focus, Escape cancels, and a failed confirm keeps the card open with its error. */
function ConfirmModal({
  title,
  cancelLabel,
  tone = "danger",
  onCancel,
  onConfirm,
  children,
}: {
  title: string;
  /** Names what the scrim cancels, for assistive technology. */
  cancelLabel: string;
  tone?: "danger" | "neutral";
  onCancel: () => void;
  onConfirm: () => Promise<void>;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const cancelButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    cancelButton.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (matchesShortcut(event, "closeOverlay") && !busy) {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
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
    <div className="delete-modal" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
      <button
        type="button"
        className="delete-modal__scrim"
        aria-label={cancelLabel}
        disabled={busy}
        onClick={onCancel}
      />
      <div className="delete-modal__card">
        <h2 id={titleId}>{title}</h2>
        {children}
        {message && <span className="delete-modal__error">{message}</span>}
        <div className="delete-modal__actions">
          <button ref={cancelButton} type="button" className="delete-modal__cancel" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={tone === "neutral" ? "delete-modal__confirm is-neutral" : "delete-modal__confirm"}
            disabled={busy}
            onClick={() => void confirm()}
          >
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

/** Idle time after the last keystroke before a note saves, and how long continuous typing may defer it. */
const NOTE_SAVE_DELAY = 800;
// Matches the browser's own arrow-key scroll distance.
const ARROW_SCROLL_STEP = 40;
const NOTE_SAVE_MAX_WAIT = 4_000;

type Draft = { selection: string; note: string };

/** The draft as the server stores it, so local edits and server echoes compare equal. */
function storedDraft(draft: Draft, noneLetter: string): Draft {
  const note = draft.note.trim() ? draft.note : "";
  const option = draft.selection !== noneLetter ? draft.selection : "";
  // An empty answer is deleted, and a note without an option is stored as "None of these".
  if (!option && !note) return { selection: "", note: "" };
  return { selection: option || noneLetter, note };
}

const draftKey = (draft: Draft) => JSON.stringify([draft.selection, draft.note]);

function Questionnaire({
  round,
  shortcutActive,
  onSave,
  onRevealRound,
  onReview,
}: {
  round: Round;
  shortcutActive: boolean;
  onSave: SaveAnswer;
  onRevealRound: () => void;
  onReview: () => Promise<void>;
}) {
  const readOnly = round.status !== "active";
  const [active, setActive] = useState(0);
  const deck = useRef<HTMLDivElement>(null);
  const [reviewing, setReviewing] = useState(false);
  const flushers = useRef(new Map<string, () => Promise<boolean>>());
  const questions = round.payload.questions;

  useEffect(() => {
    setActive(0);
  }, [round.id]);

  const answerFor = (id: string) => round.answers.find((answer) => answer.question_id === id);
  const answeredCount = round.answers.filter((answer) => answer.state === "queued").length;
  // An active round's newest edit may still be saving, so its review stays available and saves first.
  const canReview = !readOnly || answeredCount > 0;

  const registerFlush = useCallback((id: string, flush: () => Promise<boolean>) => {
    flushers.current.set(id, flush);
    return () => {
      flushers.current.delete(id);
    };
  }, []);

  const reviewPrompt = useCallback(async () => {
    setReviewing(true);
    try {
      // The server compiles the preview, so every pending edit must land before it is requested.
      const saved = await Promise.all(questions.map((question) => flushers.current.get(question.id)?.() ?? true));
      const failed = saved.indexOf(false);
      if (failed >= 0) {
        setActive(failed);
        return;
      }
      await onReview();
    } finally {
      setReviewing(false);
    }
  }, [onReview, questions]);

  // A new question starts reading from the top of the round, as on page load.
  const showQuestion = useCallback(
    (index: number) => {
      setActive(index);
      onRevealRound();
    },
    [onRevealRound],
  );

  useEffect(() => {
    if (!shortcutActive) return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (ignoresShortcuts(event)) return;
      if (matchesShortcut(event, "previousQuestion")) {
        event.preventDefault();
        showQuestion(Math.max(0, active - 1));
        return;
      }
      if (matchesShortcut(event, "nextQuestion")) {
        event.preventDefault();
        showQuestion(Math.min(questions.length - 1, active + 1));
        return;
      }
      if (matchesShortcut(event, "reviewPrompt") && canReview && !reviewing) {
        event.preventDefault();
        deck.current?.querySelector(".question:not([hidden]) .round-submit")?.scrollIntoView({ block: "nearest" });
        void reviewPrompt();
      }
    };
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [active, canReview, questions.length, reviewPrompt, reviewing, shortcutActive, showQuestion]);

  const map = useMemo(() => {
    const size = Math.min(7, questions.length);
    const start = Math.min(Math.max(0, active - Math.floor(size / 2)), questions.length - size);
    return questions.slice(start, start + size).map((question, offset) => ({ question, index: start + offset }));
  }, [active, questions]);

  return (
    <div className="deck-wrap">
      <div
        ref={deck}
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
            canReview={canReview}
            reviewing={reviewing}
            shortcutsEnabled={shortcutActive && index === active}
            map={
              <div className="question-map" role="navigation" aria-label="Question navigation">
                {map.map((entry) => (
                  <button
                    key={entry.question.id}
                    className={`map-btn ${entry.index === active ? "is-active" : ""} ${answerFor(entry.question.id)?.state === "queued" ? "is-queued" : ""}`}
                    aria-current={entry.index === active}
                    onClick={() => showQuestion(entry.index)}
                  >
                    {entry.question.id}
                  </button>
                ))}
              </div>
            }
            onSave={onSave}
            registerFlush={registerFlush}
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
  onSave,
  registerFlush,
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
  onSave: SaveAnswer;
  registerFlush: (id: string, flush: () => Promise<boolean>) => () => void;
  onReview: () => Promise<void>;
}) {
  // "None of these" takes the letter after the last option; it is stored as no selected option.
  const noneLetter = String.fromCharCode(
    Math.max(64, ...question.options.map((option) => option.letter.toUpperCase().charCodeAt(0))) + 1,
  );
  const { selection: serverSelection, note: serverNote } = storedDraft(
    answer ? { selection: answer.selected_option ?? noneLetter, note: answer.note ?? "" } : { selection: "", note: "" },
    noneLetter,
  );
  const [selection, setSelection] = useState(serverSelection);
  const [note, setNote] = useState(serverNote);
  const [syncedKey, setSyncedKey] = useState(() => draftKey({ selection: serverSelection, note: serverNote }));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState("");
  const [saved, confirmSaved] = useConfirmation();
  const shortcuts = useShortcuts();
  const noteField = useRef<HTMLTextAreaElement>(null);
  const options = useRef<HTMLDivElement>(null);
  // Timers, page-hide listeners, and unmounting read these refs so they always save the newest edit.
  const latest = useRef<Draft>({ selection: serverSelection, note: serverNote });
  const synced = useRef(syncedKey);
  const inFlight = useRef(false);
  const queue = useRef(Promise.resolve(true));
  const timer = useRef<number>(undefined);
  const firstEdit = useRef(0);

  const stored = storedDraft({ selection, note }, noneLetter);
  const dirty = draftKey(stored) !== syncedKey;
  // A note without an option is answered as "None of these", so that radio shows it.
  const shownSelection = stored.selection || selection;

  // Another device's change replaces the fields only when this card has nothing unsaved of its own.
  useEffect(() => {
    const key = draftKey({ selection: serverSelection, note: serverNote });
    if (key === synced.current || inFlight.current || draftKey(latest.current) !== synced.current) return;
    latest.current = { selection: serverSelection, note: serverNote };
    synced.current = key;
    setSyncedKey(key);
    setSelection(serverSelection);
    setNote(serverNote);
  }, [serverSelection, serverNote]);

  const sendLatest = useCallback(
    async (keepalive: boolean): Promise<boolean> => {
      const target = latest.current;
      const key = draftKey(target);
      if (key === synced.current) {
        setFailure("");
        return true;
      }
      inFlight.current = true;
      setSaving(true);
      try {
        await onSave(
          round.id,
          question.id,
          {
            selected_option: target.selection && target.selection !== noneLetter ? target.selection : null,
            note: target.note || null,
          },
          keepalive,
        );
        synced.current = key;
        setSyncedKey(key);
        setFailure("");
        if (draftKey(latest.current) === key) confirmSaved();
        return true;
      } catch (cause) {
        setFailure((cause as Error).message);
        return false;
      } finally {
        inFlight.current = false;
        setSaving(false);
      }
    },
    [confirmSaved, noneLetter, onSave, question.id, round.id],
  );

  const flush = useCallback(
    (keepalive = false) => {
      window.clearTimeout(timer.current);
      firstEdit.current = 0;
      // Saves run one at a time, so a slow response can never land after a newer edit.
      const run = queue.current.then(() => sendLatest(keepalive));
      queue.current = run;
      return run;
    },
    [sendLatest],
  );

  const edit = useCallback(
    (next: Draft, delay: number) => {
      setSelection(next.selection);
      setNote(next.note);
      latest.current = storedDraft(next, noneLetter);
      if (!delay) {
        void flush();
        return;
      }
      const now = Date.now();
      firstEdit.current ||= now;
      window.clearTimeout(timer.current);
      // Continuous typing still saves every few seconds instead of waiting for a pause.
      const wait = Math.min(delay, firstEdit.current + NOTE_SAVE_MAX_WAIT - now);
      timer.current = window.setTimeout(() => void flush(), Math.max(0, wait));
    },
    [flush, noneLetter],
  );

  const chooseNone = useCallback(() => {
    edit({ selection: noneLetter, note }, 0);
    noteField.current?.focus();
  }, [edit, noneLetter, note]);

  useEffect(() => registerFlush(question.id, flush), [flush, question.id, registerFlush]);

  // Leaving the question saves at once instead of waiting out the typing delay.
  useEffect(() => {
    if (hidden) void flush();
  }, [flush, hidden]);

  useEffect(() => {
    if (readOnly) return;
    // keepalive lets the final save outlive a closing tab or a switch to another session.
    const hide = () => {
      if (document.visibilityState === "hidden") void flush(true);
    };
    const leave = () => void flush(true);
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", leave);
      void flush(true);
    };
  }, [flush, readOnly]);

  useEffect(() => {
    if (!shortcutsEnabled || readOnly) return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (ignoresShortcuts(event)) return;
      if (matchesShortcut(event, "focusNote")) {
        event.preventDefault();
        noteField.current?.focus();
        return;
      }
      if (!matchesShortcut(event, "selectOption")) return;
      const letter = shortcutLetter(event);
      const reveal = (target: string) =>
        options.current?.querySelector(`[data-option="${target}"]`)?.scrollIntoView({ block: "nearest" });
      if (letter === noneLetter.toLocaleLowerCase()) {
        event.preventDefault();
        chooseNone();
        reveal(noneLetter);
        return;
      }
      const option = question.options.find((item) => item.letter.toLocaleLowerCase() === letter);
      if (!option) return;
      event.preventDefault();
      edit({ selection: option.letter, note }, 0);
      reveal(option.letter);
    };
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [chooseNone, edit, noneLetter, note, question.options, readOnly, shortcutsEnabled]);

  return (
    <article className="question" hidden={hidden} inert={hidden}>
      <div className="question__pad">
        <div className="question__top">
          <div className="qid-slot">{hidden ? null : map}</div>
          <span className="round-label">Round {round.number}</span>
        </div>
        <h2>{question.question}</h2>
        <Explanation question={question} />
        <div className="answer-form">
          <div ref={options} className="options">
            {question.options.map((option) => (
              <label key={option.letter} className="option" data-option={option.letter}>
                <input
                  type="radio"
                  name={`${round.id}-${question.id}`}
                  checked={shownSelection === option.letter}
                  disabled={readOnly}
                  aria-keyshortcuts={shortcuts.aria("selectOption", option.letter)}
                  onChange={() => edit({ selection: option.letter, note }, 0)}
                />
                <span className="option__copy">
                  <span className="option__label">
                    {option.letter}. {option.label}
                  </span>
                  <span className="option__detail">{option.detail}</span>
                </span>
                <span className="option__badges">
                  {option.letter === question.recommendation && <span className="rec-badge">Recommended</span>}
                </span>
              </label>
            ))}
            <label className="option" data-option={noneLetter}>
              <input
                type="radio"
                name={`${round.id}-${question.id}`}
                checked={shownSelection === noneLetter}
                disabled={readOnly}
                aria-keyshortcuts={shortcuts.aria("selectOption", noneLetter)}
                onChange={chooseNone}
              />
              <span className="option__copy">
                <span className="option__label">{noneLetter}. None of these</span>
                <span className="option__detail">Write your own answer below.</span>
              </span>
            </label>
          </div>
          <div className="freeform">
            <textarea
              ref={noteField}
              disabled={readOnly}
              maxLength={2000}
              value={note}
              aria-label="Add context or write your own answer"
              aria-keyshortcuts={shortcuts.aria("focusNote")}
              title={shortcuts.title("Additional context", "focusNote")}
              onChange={(event) => edit({ selection, note: event.target.value }, NOTE_SAVE_DELAY)}
              onBlur={() => void flush()}
              placeholder="Add context or write your own answer..."
            />
          </div>
          <div className="question__foot">
            {readOnly ? null : failure ? (
              <span className="save-status is-error" role="alert">
                {failure}
                <button type="button" onClick={() => void flush()}>
                  Retry
                </button>
              </span>
            ) : (
              <span className="save-status" role="status">
                {saving || dirty ? (
                  <>
                    <LoaderCircle className="spin" size={14} /> Saving…
                  </>
                ) : saved ? (
                  <>
                    <Check size={14} /> Saved
                  </>
                ) : null}
              </span>
            )}
            <button
              type="button"
              className="submit round-submit"
              disabled={!canReview || reviewing}
              aria-keyshortcuts={shortcuts.aria("reviewPrompt")}
              title={shortcuts.title("Review prompt", "reviewPrompt")}
              onClick={() => void onReview()}
            >
              {reviewing ? <LoaderCircle className="spin" size={16} /> : null} Review prompt
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

let highlighter: Promise<HLJSApi> | undefined;

/** highlight.js loads only once an explanation shows code, with shells the common bundle lacks. */
function loadHighlighter(): Promise<HLJSApi> {
  highlighter ??= Promise.all([
    import("highlight.js/lib/common"),
    import("highlight.js/lib/languages/powershell"),
    import("highlight.js/lib/languages/dockerfile"),
  ]).then(([{ default: hljs }, powershell, dockerfile]) => {
    hljs.registerLanguage("powershell", powershell.default);
    hljs.registerLanguage("dockerfile", dockerfile.default);
    return hljs;
  });
  return highlighter;
}

// Below this relevance, a guessed language is usually wrong, such as an ASCII tree read as CSS.
const MIN_AUTO_RELEVANCE = 3;
const highlightedText = new WeakMap<Element, string>();

function highlightCode(hljs: HLJSApi, root: HTMLElement) {
  for (const block of root.querySelectorAll<HTMLElement>("pre > code")) {
    const text = block.textContent ?? "";
    // Unchanged output is skipped, and markup the agent wrote itself is kept.
    if (highlightedText.get(block) === text || block.children.length) continue;
    const classes = `${block.className} ${block.parentElement?.className ?? ""}`;
    if (/\bnohighlight\b/u.test(classes)) continue;
    const language = /\blang(?:uage)?-([\w+#-]+)/u.exec(classes)?.[1];
    let html: string;
    if (language) {
      // A named language highlight.js does not know, such as "text", stays plain.
      if (!hljs.getLanguage(language)) continue;
      html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } else {
      const guess = hljs.highlightAuto(text);
      if (guess.relevance < MIN_AUTO_RELEVANCE) continue;
      html = guess.value;
    }
    block.innerHTML = html;
    block.classList.add("hljs");
    highlightedText.set(block, text);
  }
}

function Explanation({ question }: { question: GrillQuestion }) {
  const root = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // React 19 rewrites innerHTML whenever this object's identity changes, which would reset open
  // <details>, dropdowns, and init_js listeners on every poll; only new HTML may replace the DOM.
  const html = useMemo(() => ({ __html: question.explanation_html }), [question.explanation_html]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let live = true;
    const refresh = () => {
      if (element.querySelector("pre > code"))
        void loadHighlighter().then((hljs) => live && highlightCode(hljs, element));
    };
    refresh();
    // New HTML and init_js can replace or add code samples later, so those are highlighted too.
    const observer = new MutationObserver(refresh);
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      live = false;
      observer.disconnect();
    };
  }, []);
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
        dangerouslySetInnerHTML={html}
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
  const [copied, confirmCopy] = useConfirmation();
  const [sent, confirmSend] = useConfirmation();
  const [confirmingResend, setConfirmingResend] = useState(false);
  const [message, setMessage] = useState("");
  const shortcuts = useShortcuts();
  const readOnly = round.status !== "active";
  // Only a confirmed delivery counts: retrying after a failed send needs no warning.
  const alreadySent = round.prompt_snapshots.some(
    (item) =>
      item.reason === "aboard" && item.grill_deliveries.some((delivery) => delivery.status === "submitted-to-terminal"),
  );

  const snapshot = useCallback(
    async (reason: "copy" | "aboard") => {
      setBusy(reason);
      setMessage("");
      try {
        const record = () =>
          api<{ snapshot: { id: string; prompt: string } }>(`rounds/${round.id}/prompt-snapshots`, {
            method: "POST",
            body: JSON.stringify({ reason, expected_prompt: prompt }),
          }).then((result) => result.snapshot);
        if (reason === "copy") {
          // A historical round cannot record snapshots, so its copy comes straight from the preview.
          const text = readOnly ? Promise.resolve(prompt) : record().then((recorded) => recorded.prompt);
          // A failed snapshot fails the copy too, and settles first, so its own error is the one reported.
          await Promise.all([text, copyText(text)]);
          confirmCopy();
          if (readOnly) return;
        } else {
          const recorded = await record();
          const { delivery } = await api<{ delivery: { id: string } }>(`prompt-snapshots/${recorded.id}/deliveries`, {
            method: "POST",
            body: "{}",
          });
          await awaitDelivery(delivery.id);
          confirmSend();
        }
        await onReload();
      } catch (cause) {
        setMessage((cause as Error).message);
      } finally {
        setBusy("");
      }
    },
    [confirmCopy, confirmSend, onReload, prompt, readOnly, round.id],
  );

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      // This listener registers before the warning's, so it must stand down or Escape would close both.
      if (ignoresShortcuts(event) || confirmingResend) return;
      if (matchesShortcut(event, "closeOverlay")) {
        event.preventDefault();
        onClose();
        return;
      }
      if (shortcuts.enabled && matchesShortcut(event, "copyPrompt") && prompt && !busy) {
        event.preventDefault();
        void snapshot("copy");
        return;
      }
    };
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [aboardReady, busy, confirmingResend, onClose, prompt, readOnly, shortcuts.enabled, snapshot]);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Prompt review">
      <button
        type="button"
        className="modal__scrim"
        aria-label="Back to questions"
        inert={confirmingResend ? true : undefined}
        onClick={onClose}
      />
      <div className="modal__card" inert={confirmingResend ? true : undefined}>
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
            aria-keyshortcuts={shortcuts.aria("copyPrompt")}
            disabled={!prompt || Boolean(busy)}
            title={shortcuts.title(copied ? "Prompt copied" : "Copy prompt", "copyPrompt")}
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
        <pre>{prompt || "Nothing is answered yet."}</pre>
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
            title={
              readOnly
                ? "Historical rounds cannot be sent"
                : sent
                  ? "Prompt sent"
                  : aboardReady
                    ? "Send via Aboard"
                    : "Aboard is not connected to this session"
            }
            onClick={() => (alreadySent ? setConfirmingResend(true) : void snapshot("aboard"))}
          >
            {busy === "aboard" ? (
              <LoaderCircle className="spin" size={14} />
            ) : sent ? (
              <Check size={14} />
            ) : (
              <Send size={14} />
            )}{" "}
            Send via Aboard
          </button>
        </div>
      </div>
      {confirmingResend && (
        <ConfirmModal
          title="Re-send for this round?"
          cancelLabel="Cancel re-send"
          tone="neutral"
          onCancel={() => setConfirmingResend(false)}
          onConfirm={async () => {
            // The send reports its own progress on the button, so the warning closes first.
            setConfirmingResend(false);
            void snapshot("aboard");
          }}
        >
          <p className="delete-modal__note">This round&apos;s prompt was already sent to the session.</p>
        </ConfirmModal>
      )}
    </div>
  );
}
