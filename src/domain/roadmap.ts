/**
 * The project roadmap's document model: a flat markdown checkbox list held in
 * the body of the open issue labelled `[AI]-todo`.
 *
 * The model is pure so that the two places that need it agree by construction.
 * The GitHub boundary parses a body, applies one operation, and serializes it
 * back; the Manager's briefing parses the same body and renders the same
 * positions. A second implementation of the addressing rule in the renderer
 * would be a sync bug the moment either side changed.
 *
 * **A task's address is its position, confirmed by its text.** A mutation names
 * a 1-based position and an `expect` string; the position addresses and `expect`
 * is the ETag, so writing through a stale address is structurally impossible
 * rather than merely discouraged. Positions are absolute over every task line,
 * completed ones included, and are never renumbered per view — the pending-only
 * reminder and the full briefing must name the same task by the same number.
 *
 * This replaces a 4-hex hash of the subject, which changed whenever a subject
 * was edited — the most common operation after completion — and whose
 * collision-resolution pass made an id depend on document order, so reordering
 * two colliding subjects silently repointed a still-valid id at a different
 * task. Position is the natural address here because order *is* this document's
 * semantics: list order is priority and the first unchecked item is next.
 */

/** The document's storage bound. Exceeding it warns rather than refuses. */
export const ROADMAP_BODY_LIMIT = 60_000;

/** Fraction of the bound at which the briefing starts recommending a prune. */
const NEAR_BOUND_RATIO = 0.9;

/** A subject is a point of reference, not a specification. */
export const ROADMAP_SUBJECT_LIMIT = 200;

/**
 * How much of a subject a caller must reproduce to confirm an address. Long
 * enough that reproducing it is real evidence the caller is looking at the task
 * it means, short enough that a 200-character subject does not have to be
 * transcribed in full. Comparing fixed-length truncations is what stops the
 * guard degrading: a caller cannot match with fewer characters than this.
 */
export const EXPECT_PREFIX_CHARS = 40;

export const ROADMAP_TASK_STATUSES = ["pending", "completed", "deleted"] as const;
export type RoadmapTaskStatus = (typeof ROADMAP_TASK_STATUSES)[number];

export interface RoadmapTask {
  /** 1-based over every task line in the document; never written into the body. */
  readonly position: number;
  readonly subject: string;
  readonly completed: boolean;
}

/** Where an insertion or a move lands: after a given position, or before them all. */
export type RoadmapAnchor = number | "top";

/**
 * A parsed body. Non-checkbox lines are carried through verbatim and in place:
 * the user owns this issue, and a heading or a note they added must survive a
 * roadmap tool call untouched.
 */
export interface ParsedRoadmap {
  readonly tasks: readonly RoadmapTask[];
  /**
   * Subjects appearing more than once. No longer an addressing hazard now that
   * position is the address, but still a defect in the document worth telling
   * the user about, so it is reported and never repaired.
   */
  readonly duplicateSubjects: readonly string[];
}

interface TaskEntry {
  readonly kind: "task";
  readonly subject: string;
  readonly completed: boolean;
  /** Indentation and marker style are preserved so a hand-edited body round trips. */
  readonly prefix: string;
}

interface TextEntry {
  readonly kind: "text";
  readonly line: string;
}

type Entry = TaskEntry | TextEntry;

const TASK_LINE = /^(\s*[-*+]\s+)\[([ xX])\]\s?(.*)$/u;

/** Leading list or heading markup, which would nest inside the checkbox we add. */
const LEADING_MARKUP = /^\s*(?:[-*+]|#{1,6}|\d+[.)]|\[[ xX]\])(?:\s|$)/u;

export type SubjectRejection = "empty" | "multiline" | "too-long" | "markup";

/**
 * Structural validation only. "One sentence" is instruction in the skill; the
 * character cap makes the failure mode unreachable without the CLI trying to
 * judge prose. The newline rule is correctness rather than preference: a second
 * line breaks the one-checkbox-per-task parse on the next read.
 */
export function validateSubject(subject: string): SubjectRejection | undefined {
  if (subject.trim().length === 0) return "empty";
  if (/[\r\n]/u.test(subject)) return "multiline";
  if (subject.trim().length > ROADMAP_SUBJECT_LIMIT) return "too-long";
  if (LEADING_MARKUP.test(subject)) return "markup";
  return undefined;
}

export function describeSubjectRejection(rejection: SubjectRejection): string {
  switch (rejection) {
    case "empty": return "--subject must not be empty";
    case "multiline": return "--subject must be a single line; one task is one checkbox";
    case "too-long": return `--subject must be at most ${ROADMAP_SUBJECT_LIMIT} characters; put the detail in an [AI]-spec issue`;
    case "markup": return "--subject must not start with list or heading markup; aboard writes the `- [ ]` itself";
  }
}

/**
 * Whitespace is normalized before comparison because a body round trips through
 * GitHub's editor and a phone keyboard, where a doubled space is noise rather
 * than an edit. Case is not normalized: a case change is a real edit, and the
 * cost of being strict is one loud, self-explaining failure.
 */
function expectationKey(subject: string): string {
  return subject.replace(/\s+/gu, " ").trim().slice(0, EXPECT_PREFIX_CHARS);
}

/**
 * True when `expect` reproduces the stored subject, or exactly its first
 * {@link EXPECT_PREFIX_CHARS} characters. Comparing truncations of both sides
 * means a shorter `expect` cannot match a longer subject, so the guard has a
 * floor rather than accepting any prefix.
 */
export function expectationMatches(stored: string, expect: string): boolean {
  return expectationKey(stored) === expectationKey(expect);
}

function parseEntries(body: string): readonly Entry[] {
  // A blank body is an empty document, not a document of blank lines: keeping
  // the whitespace would push the first task down past leading empty lines.
  if (body.trim().length === 0) return [];
  return body.replace(/\r\n/gu, "\n").split("\n").map((line): Entry => {
    const match = TASK_LINE.exec(line);
    if (match === null) return { kind: "text", line };
    return { kind: "task", prefix: match[1] as string, completed: (match[2] as string).toLowerCase() === "x", subject: (match[3] as string).trim() };
  });
}

/** Indexes into `entries` of the task lines, in document order. */
function taskIndexes(entries: readonly Entry[]): readonly number[] {
  return entries.flatMap((entry, index) => entry.kind === "task" ? [index] : []);
}

function identify(entries: readonly Entry[]): readonly RoadmapTask[] {
  const tasks: RoadmapTask[] = [];
  for (const entry of entries) {
    if (entry.kind !== "task") continue;
    tasks.push({ position: tasks.length + 1, subject: entry.subject, completed: entry.completed });
  }
  return tasks;
}

export function parseRoadmap(body: string): ParsedRoadmap {
  const tasks = identify(parseEntries(body));
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const task of tasks) {
    const key = task.subject.trim();
    if (seen.has(key)) duplicates.add(task.subject);
    seen.add(key);
  }
  return { tasks, duplicateSubjects: [...duplicates] };
}

function serialize(entries: readonly Entry[]): string {
  return entries.map((entry) => entry.kind === "text" ? entry.line : `${entry.prefix}[${entry.completed ? "x" : " "}] ${entry.subject}`).join("\n").trimEnd();
}

/** Where an insertion lands, in entry-index terms. */
function insertionIndex(entries: readonly Entry[], after: RoadmapAnchor | undefined): number | "unknown" {
  const indexes = taskIndexes(entries);
  if (after === undefined) {
    // Default append: after the last task, so a trailing note stays trailing.
    const last = indexes.at(-1);
    return last === undefined ? entries.length : last + 1;
  }
  if (after === "top") {
    const first = indexes[0];
    return first ?? entries.length;
  }
  const target = indexes[after - 1];
  return target === undefined ? "unknown" : target + 1;
}

export interface RoadmapCreateInput {
  readonly subjects: readonly string[];
  /** A position, `top`, or absent for append. */
  readonly after?: RoadmapAnchor | undefined;
}

export interface RoadmapUpdateInput {
  /** 1-based position of the task to change. */
  readonly task: number;
  /** The task's current subject, or exactly its first 40 characters. */
  readonly expect: string;
  readonly subject?: string | undefined;
  readonly status?: RoadmapTaskStatus | undefined;
  readonly after?: RoadmapAnchor | undefined;
}

export type RoadmapEditFailure =
  | { readonly reason: "unknown-position"; readonly field: "task" | "after"; readonly position: number }
  | { readonly reason: "expectation-mismatch"; readonly position: number; readonly expected: string; readonly actual: string }
  | { readonly reason: "invalid-subject"; readonly subject: string; readonly rejection: SubjectRejection };

export type RoadmapEdit<T> =
  | { readonly ok: true; readonly body: string; readonly value: T }
  | { readonly ok: false; readonly failure: RoadmapEditFailure };

/**
 * `shifted` reports whether the edit moved any *other* task's position, which is
 * what decides whether the caller is handed a fresh list. An append and an
 * in-place edit shift nothing and stay cheap; an insert, a move, and a delete
 * renumber everything after them and would otherwise leave the Manager holding
 * stale addresses until the next guard failure taught it so.
 */
export interface RoadmapCreateResult {
  readonly positions: readonly number[];
  readonly shifted: boolean;
}

export interface RoadmapUpdateResult {
  /** The task's position after the edit; absent when it was deleted. */
  readonly position?: number;
  readonly shifted: boolean;
}

/**
 * Appends or inserts new tasks in one edit. A batch is all-or-nothing because
 * the issue edit is a single write: there is no partial application to fall
 * back to, so a subject that trips validation fails the whole call.
 */
export function createTasks(body: string, input: RoadmapCreateInput): RoadmapEdit<RoadmapCreateResult> {
  for (const subject of input.subjects) {
    const rejection = validateSubject(subject);
    if (rejection !== undefined) return { ok: false, failure: { reason: "invalid-subject", subject, rejection } };
  }
  const entries = [...parseEntries(body)];
  const index = insertionIndex(entries, input.after);
  if (index === "unknown") return { ok: false, failure: { reason: "unknown-position", field: "after", position: input.after as number } };
  const before = countTasksBefore(entries, index);
  // Anything still at or after the insertion point is renumbered by it.
  const shifted = taskIndexes(entries).some((entryIndex) => entryIndex >= index);
  const prefix = entries.find((entry): entry is TaskEntry => entry.kind === "task")?.prefix ?? "- ";
  const added: TaskEntry[] = input.subjects.map((subject) => ({ kind: "task", prefix, completed: false, subject: subject.trim() }));
  entries.splice(index, 0, ...added);
  const positions = input.subjects.map((_, offset) => before + offset + 1);
  return { ok: true, body: serialize(entries), value: { positions, shifted } };
}

function countTasksBefore(entries: readonly Entry[], index: number): number {
  return entries.slice(0, index).filter((entry) => entry.kind === "task").length;
}

/**
 * Edits one task in place. `--after` is the reprioritize operation rather than
 * a third verb: moving a task and editing it are the same write to the same
 * document, and splitting them would double the round trips for no gain.
 *
 * `expect` guards the task being changed but deliberately not the `after`
 * anchor: a stale anchor misplaces a task in the priority order, which is
 * visible in the next render and cheap to fix, while a stale `task` would check
 * off or retitle work the user never touched.
 */
export function updateTask(body: string, input: RoadmapUpdateInput): RoadmapEdit<RoadmapUpdateResult> {
  if (input.subject !== undefined) {
    const rejection = validateSubject(input.subject);
    if (rejection !== undefined) return { ok: false, failure: { reason: "invalid-subject", subject: input.subject, rejection } };
  }
  const entries = [...parseEntries(body)];
  const indexes = taskIndexes(entries);
  const index = indexes[input.task - 1];
  if (index === undefined) return { ok: false, failure: { reason: "unknown-position", field: "task", position: input.task } };
  const current = entries[index] as TaskEntry;
  if (!expectationMatches(current.subject, input.expect)) {
    return { ok: false, failure: { reason: "expectation-mismatch", position: input.task, expected: input.expect, actual: current.subject } };
  }

  if (input.status === "deleted") {
    entries.splice(index, 1);
    return { ok: true, body: serialize(entries), value: { shifted: indexes.some((entryIndex) => entryIndex > index) } };
  }

  const edited: TaskEntry = {
    kind: "task",
    prefix: current.prefix,
    subject: input.subject === undefined ? current.subject : input.subject.trim(),
    completed: input.status === undefined ? current.completed : input.status === "completed",
  };
  entries.splice(index, 1, edited);

  if (input.after !== undefined) {
    // The anchor is resolved against the document the caller was looking at,
    // *before* the moved task is lifted out, then shifted down by one if it sat
    // after it. Resolving against the remaining list instead would make the last
    // position unreachable and would read `after: <its own position>` as "after
    // my successor" rather than the no-op it plainly means.
    const target = insertionIndex(entries, input.after);
    if (target === "unknown") return { ok: false, failure: { reason: "unknown-position", field: "after", position: input.after as number } };
    const remaining = entries.filter((_, position) => position !== index);
    const landing = target > index ? target - 1 : target;
    remaining.splice(landing, 0, edited);
    const position = countTasksBefore(remaining, landing) + 1;
    return { ok: true, body: serialize(remaining), value: { position, shifted: position !== input.task } };
  }
  return { ok: true, body: serialize(entries), value: { position: input.task, shifted: false } };
}

export function nearBodyLimit(body: string): boolean {
  return body.length >= ROADMAP_BODY_LIMIT * NEAR_BOUND_RATIO;
}

/**
 * One task, in the single format the whole system uses. The briefing, the
 * reminder, and the list a failed lookup returns all render this, so the data a
 * retry reads looks exactly like the data the call was written against.
 */
function taskLine(task: RoadmapTask): string {
  return `${task.position}. [${task.completed ? "x" : " "}] ${task.subject}`;
}

/** The list a failed lookup returns, so the retry costs no extra call. */
export function numberedTasks(tasks: readonly RoadmapTask[]): readonly string[] {
  return tasks.map(taskLine);
}

/**
 * The roadmap as it appears wherever the Manager reads it. `mode: "pending"` is
 * the periodic reminder's shape: the completed history is still verbatim in the
 * window at that point, so repeating it would make the reminder the largest
 * recurring line item in a long-lived project instead of a flat cost.
 *
 * Filtering happens after positions are assigned, so a pending-only rendering
 * shows the same — deliberately non-contiguous — numbers as the full one.
 */
export function renderTasks(tasks: readonly RoadmapTask[], mode: "full" | "pending"): string {
  const selected = mode === "full" ? tasks : tasks.filter((task) => !task.completed);
  return selected.map(taskLine).join("\n");
}
