
/** The document's storage bound. Exceeding it warns rather than refuses. */
export const ROADMAP_BODY_LIMIT = 60_000;

/** Fraction of the bound at which the briefing starts recommending a prune. */
const NEAR_BOUND_RATIO = 0.9;

/** A subject is a point of reference, not a specification. */
export const ROADMAP_SUBJECT_LIMIT = 200;

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

export interface ParsedRoadmap {
  readonly tasks: readonly RoadmapTask[];
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

function expectationKey(subject: string): string {
  return subject.replace(/\s+/gu, " ").trim().slice(0, EXPECT_PREFIX_CHARS);
}

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

export interface RoadmapCreateResult {
  readonly positions: readonly number[];
  readonly shifted: boolean;
}

export interface RoadmapUpdateResult {
  /** The task's position after the edit; absent when it was deleted. */
  readonly position?: number;
  readonly shifted: boolean;
}

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

function taskLine(task: RoadmapTask): string {
  return `${task.position}. [${task.completed ? "x" : " "}] ${task.subject}`;
}

/** The list a failed lookup returns, so the retry costs no extra call. */
export function numberedTasks(tasks: readonly RoadmapTask[]): readonly string[] {
  return tasks.map(taskLine);
}

export function renderTasks(tasks: readonly RoadmapTask[], mode: "full" | "pending"): string {
  const selected = mode === "full" ? tasks : tasks.filter((task) => !task.completed);
  return selected.map(taskLine).join("\n");
}
