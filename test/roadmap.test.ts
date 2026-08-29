import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECT_PREFIX_CHARS,
  ROADMAP_SUBJECT_LIMIT,
  createTasks,
  expectationMatches,
  numberedTasks,
  parseRoadmap,
  renderTasks,
  updateTask,
  validateSubject,
} from "../src/domain/roadmap.js";

const BODY = [
  "# Roadmap",
  "",
  "- [x] Replace the locator",
  "- [ ] Pace the reminders",
  "- [ ] Document the verbs",
  "",
  "Notes the user keeps here.",
].join("\n");

function subjects(body: string): readonly string[] {
  return parseRoadmap(body).tasks.map((task) => task.subject);
}

test("parsing keeps order, completion, and every line the user wrote", () => {
  const parsed = parseRoadmap(BODY);
  assert.deepEqual(parsed.tasks.map((task) => [task.position, task.subject, task.completed]), [
    [1, "Replace the locator", true],
    [2, "Pace the reminders", false],
    [3, "Document the verbs", false],
  ]);
  assert.deepEqual(parsed.duplicateSubjects, []);

  const edited = updateTask(BODY, { task: 2, expect: "Pace the reminders", status: "completed" });
  assert.ok(edited.ok);
  assert.equal(edited.body, BODY.replace("- [ ] Pace the reminders", "- [x] Pace the reminders"));
  // An in-place edit renumbers nothing, so the caller keeps its addresses.
  assert.deepEqual(edited.value, { position: 2, shifted: false });
});

test("positions are absolute over the whole document and never renumbered per view", () => {
  const tasks = parseRoadmap(BODY).tasks;
  const pendingPositions = renderTasks(tasks, "pending")
    .split("\n")
    .map((line) => Number(line.split(".")[0]));
  assert.deepEqual(pendingPositions, [2, 3]);
  for (const task of tasks) {
    assert.match(renderTasks(tasks, "full"), new RegExp(`^${task.position}\\. \\[[ x]\\] ${task.subject}$`, "mu"));
  }
});

test("a subject edit does not move the task, which is the whole point of positional addressing", () => {
  const renamed = updateTask(BODY, { task: 2, expect: "Pace the reminders", subject: "Pace reminders on measured growth" });
  assert.ok(renamed.ok);
  assert.deepEqual(renamed.value, { position: 2, shifted: false });
  assert.equal(parseRoadmap(renamed.body).tasks[1]?.subject, "Pace reminders on measured growth");
  // And the new text addresses the same position immediately afterwards.
  const again = updateTask(renamed.body, { task: 2, expect: "Pace reminders on measured growth", status: "completed" });
  assert.ok(again.ok);
});

test("expect is the ETag: a stale subject writes nothing", () => {
  // The user retitled task 2 on their phone; the Manager still holds the old text.
  const drifted = BODY.replace("- [ ] Pace the reminders", "- [ ] Something else entirely");
  const failed = updateTask(drifted, { task: 2, expect: "Pace the reminders", status: "completed" });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.ok ? undefined : failed.failure, {
    reason: "expectation-mismatch",
    position: 2,
    expected: "Pace the reminders",
    actual: "Something else entirely",
  });
});

test("expect takes the whole subject or exactly its first 40 characters, and nothing shorter", () => {
  const long = `- [ ] ${"a".repeat(60)}`;
  const stored = "a".repeat(60);
  assert.equal(expectationMatches(stored, stored), true);
  assert.equal(expectationMatches(stored, "a".repeat(EXPECT_PREFIX_CHARS)), true);
  // One character short of the floor is not a match: comparing fixed-length
  // truncations is what stops the guard degrading into "any prefix will do".
  assert.equal(expectationMatches(stored, "a".repeat(EXPECT_PREFIX_CHARS - 1)), false);
  assert.equal(updateTask(long, { task: 1, expect: "a".repeat(EXPECT_PREFIX_CHARS), status: "completed" }).ok, true);
  assert.equal(updateTask(long, { task: 1, expect: "a", status: "completed" }).ok, false);

  // A short subject must be reproduced in full.
  assert.equal(expectationMatches("Short one", "Short one"), true);
  assert.equal(expectationMatches("Short one", "Short"), false);

  // Whitespace is noise from a phone keyboard or GitHub's editor, not an edit.
  assert.equal(expectationMatches("Pace  the\treminders", "Pace the reminders"), true);
  // Case is a real edit and is not normalized away.
  assert.equal(expectationMatches("Pace the reminders", "pace the reminders"), false);
});

test("an out-of-range position fails and writes nothing, with the current list available to attach", () => {
  const failed = updateTask(BODY, { task: 9, expect: "Anything", status: "completed" });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.ok ? undefined : failed.failure, { reason: "unknown-position", field: "task", position: 9 });
  assert.deepEqual(numberedTasks(parseRoadmap(BODY).tasks), [
    "1. [x] Replace the locator",
    "2. [ ] Pace the reminders",
    "3. [ ] Document the verbs",
  ]);
});

test("a move reports the new position and that other tasks shifted", () => {
  const toTop = updateTask(BODY, { task: 3, expect: "Document the verbs", after: "top" });
  assert.ok(toTop.ok);
  assert.deepEqual(toTop.value, { position: 1, shifted: true });
  assert.deepEqual(subjects(toTop.body), ["Document the verbs", "Replace the locator", "Pace the reminders"]);

  // Moving to the very end must work: the anchor resolves against the document
  // the caller was looking at, before the moved task is lifted out of it.
  const toEnd = updateTask(BODY, { task: 1, expect: "Replace the locator", after: 3 });
  assert.ok(toEnd.ok);
  assert.deepEqual(toEnd.value, { position: 3, shifted: true });
  assert.deepEqual(subjects(toEnd.body), ["Pace the reminders", "Document the verbs", "Replace the locator"]);

  const backwards = updateTask(BODY, { task: 3, expect: "Document the verbs", after: 1 });
  assert.ok(backwards.ok);
  assert.deepEqual(subjects(backwards.body), ["Replace the locator", "Document the verbs", "Pace the reminders"]);

  // Anchoring to a task's own position is a no-op rather than a slot forward.
  const still = updateTask(BODY, { task: 2, expect: "Pace the reminders", after: 2 });
  assert.ok(still.ok);
  assert.deepEqual(still.value, { position: 2, shifted: false });
  assert.deepEqual(subjects(still.body), subjects(BODY));

  const nowhere = updateTask(BODY, { task: 2, expect: "Pace the reminders", after: 9 });
  assert.equal(nowhere.ok, false);
  assert.deepEqual(nowhere.ok ? undefined : nowhere.failure, { reason: "unknown-position", field: "after", position: 9 });
});

test("a move carries the subject edit with it, in one write", () => {
  const both = updateTask(BODY, { task: 3, expect: "Document the verbs", subject: "Document the two todo tools", after: "top" });
  assert.ok(both.ok);
  assert.deepEqual(subjects(both.body), ["Document the two todo tools", "Replace the locator", "Pace the reminders"]);
});

test("deletion shifts only when something followed the deleted task", () => {
  const first = updateTask(BODY, { task: 1, expect: "Replace the locator", status: "deleted" });
  assert.ok(first.ok);
  assert.deepEqual(first.value, { shifted: true });
  assert.deepEqual(subjects(first.body), ["Pace the reminders", "Document the verbs"]);

  const last = updateTask(BODY, { task: 3, expect: "Document the verbs", status: "deleted" });
  assert.ok(last.ok);
  assert.deepEqual(last.value, { shifted: false });
});

test("identical subjects are addressed by position and the duplication is reported", () => {
  const body = "- [ ] Same task\n- [ ] Same task";
  const parsed = parseRoadmap(body);
  assert.deepEqual(parsed.tasks.map((task) => task.position), [1, 2]);
  assert.deepEqual(parsed.duplicateSubjects, ["Same task"]);
  // Position disambiguates what text alone cannot, so completing one leaves the
  // other pending — duplicates are a defect in the document, not in addressing.
  const edited = updateTask(body, { task: 2, expect: "Same task", status: "completed" });
  assert.ok(edited.ok);
  assert.equal(edited.body, "- [ ] Same task\n- [x] Same task");
});

test("create appends by default, honours after, and returns positions in subject order", () => {
  const appended = createTasks(BODY, { subjects: ["Third thing"] });
  assert.ok(appended.ok);
  // After the last task, not after the trailing note.
  assert.match(appended.body, /- \[ \] Document the verbs\n- \[ \] Third thing\n\nNotes/u);
  // A plain append renumbers nothing, so no fresh list is owed to the caller.
  assert.deepEqual(appended.value, { positions: [4], shifted: false });

  const top = createTasks(BODY, { subjects: ["Urgent one", "Urgent two"], after: "top" });
  assert.ok(top.ok);
  assert.deepEqual(top.value, { positions: [1, 2], shifted: true });
  assert.deepEqual(subjects(top.body).slice(0, 2), ["Urgent one", "Urgent two"]);

  const between = createTasks(BODY, { subjects: ["Between"], after: 1 });
  assert.ok(between.ok);
  assert.deepEqual(between.value, { positions: [2], shifted: true });
  assert.equal(parseRoadmap(between.body).tasks[1]?.subject, "Between");

  // Anchoring to the last task is an append by another name, and shifts nothing.
  const atEnd = createTasks(BODY, { subjects: ["Tail"], after: 3 });
  assert.ok(atEnd.ok);
  assert.deepEqual(atEnd.value, { positions: [4], shifted: false });

  const nowhere = createTasks(BODY, { subjects: ["Nowhere"], after: 9 });
  assert.equal(nowhere.ok, false);
  assert.deepEqual(nowhere.ok ? undefined : nowhere.failure, { reason: "unknown-position", field: "after", position: 9 });
});

test("an empty roadmap takes its first tasks and the whole batch fails together", () => {
  const first = createTasks("", { subjects: ["One", "Two"] });
  assert.ok(first.ok);
  assert.equal(first.body, "- [ ] One\n- [ ] Two");
  assert.deepEqual(first.value, { positions: [1, 2], shifted: false });
  // A blank body is an empty document, not a document of blank lines.
  const blank = createTasks("\n  \n", { subjects: ["One"] });
  assert.ok(blank.ok);
  assert.equal(blank.body, "- [ ] One");

  // The issue edit is one write, so there is no partial application to fall
  // back to: a bad subject anywhere fails the batch.
  const rejected = createTasks("", { subjects: ["Fine", "Bad\nsubject"] });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ok ? undefined : rejected.failure.reason, "invalid-subject");
});

test("subject validation is structural, not stylistic", () => {
  assert.equal(validateSubject("A perfectly ordinary task"), undefined);
  assert.equal(validateSubject("   "), "empty");
  assert.equal(validateSubject("One\ntwo"), "multiline");
  assert.equal(validateSubject("x".repeat(ROADMAP_SUBJECT_LIMIT + 1)), "too-long");
  // Pre-formatted markup would nest inside the checkbox aboard writes itself.
  for (const subject of ["- [ ] Already a checkbox", "# A heading", "* A bullet", "1. A numbered item"]) {
    assert.equal(validateSubject(subject), "markup", subject);
  }
  // A subject that merely mentions markdown is fine; only leading markup is not.
  assert.equal(validateSubject("Render the `- [ ]` prefix ourselves"), undefined);
});

test("rendering leads with the position, and the reminder mode drops completed history", () => {
  const tasks = parseRoadmap(BODY).tasks;
  const full = renderTasks(tasks, "full");
  assert.equal(full.split("\n").length, 3);
  assert.equal(full.split("\n")[0], "1. [x] Replace the locator");

  const pending = renderTasks(tasks, "pending");
  assert.equal(pending.split("\n").length, 2);
  assert.doesNotMatch(pending, /Replace the locator/u);
  // The failure list and the briefing render the same lines, so the data a
  // retry reads looks exactly like the data the call was written against.
  assert.deepEqual(numberedTasks(tasks), full.split("\n"));
});
