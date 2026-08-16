import assert from "node:assert/strict";
import test from "node:test";

import {
  ROADMAP_SUBJECT_LIMIT,
  createTasks,
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

function ids(body: string): readonly string[] {
  return parseRoadmap(body).tasks.map((task) => task.id);
}

test("parsing keeps order, completion, and every line the user wrote", () => {
  const parsed = parseRoadmap(BODY);
  assert.deepEqual(parsed.tasks.map((task) => [task.subject, task.completed]), [
    ["Replace the locator", true],
    ["Pace the reminders", false],
    ["Document the verbs", false],
  ]);
  assert.deepEqual(parsed.duplicateSubjects, []);
  assert.equal(parsed.tasks.every((task) => /^[0-9a-f]{4}$/u.test(task.id)), true);

  // Round trip: an edit that changes one task leaves the heading, the blank
  // lines, and the trailing note exactly where they were. The user owns this
  // issue, so a note they added must survive a roadmap tool call.
  const edited = updateTask(BODY, { task: ids(BODY)[1] as string, status: "completed" });
  assert.ok(edited.ok);
  assert.equal(edited.body, BODY.replace("- [ ] Pace the reminders", "- [x] Pace the reminders"));
});

test("ids survive reordering and unrelated deletion, and follow the subject when it changes", () => {
  const before = ids(BODY);
  // Deleting the first task must not renumber the others: a positional id would
  // shift every one of them, and a deletion made on a phone is exactly the case.
  const deleted = updateTask(BODY, { task: before[0] as string, status: "deleted" });
  assert.ok(deleted.ok);
  assert.deepEqual(ids(deleted.body), before.slice(1));

  const moved = updateTask(BODY, { task: before[2] as string, after: "top" });
  assert.ok(moved.ok);
  assert.deepEqual([...ids(moved.body)].sort(), [...before].sort());
  assert.equal(ids(moved.body)[0], before[2]);

  const renamed = updateTask(BODY, { task: before[1] as string, subject: "Pace reminders on measured growth" });
  assert.ok(renamed.ok);
  assert.notEqual(ids(renamed.body)[1], before[1]);
  assert.equal(renamed.value, ids(renamed.body)[1]);
});

test("identical subjects still get distinct ids, and the duplication is reported", () => {
  const body = "- [ ] Same task\n- [ ] Same task";
  const parsed = parseRoadmap(body);
  assert.equal(parsed.tasks[0]?.id === parsed.tasks[1]?.id, false);
  assert.deepEqual(parsed.duplicateSubjects, ["Same task"]);
  // Each id addresses its own line, so completing one leaves the other pending.
  const edited = updateTask(body, { task: parsed.tasks[1]?.id as string, status: "completed" });
  assert.ok(edited.ok);
  assert.equal(edited.body, "- [ ] Same task\n- [x] Same task");
});

test("an unknown id fails and writes nothing, with the current list available to attach", () => {
  const failed = updateTask(BODY, { task: "zzzz", status: "completed" });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.ok ? undefined : failed.failure, { reason: "unknown-task", id: "zzzz" });
  assert.match(numberedTasks(parseRoadmap(BODY).tasks)[0] as string, /^1\. \[[0-9a-f]{4}\] completed - Replace the locator$/);
});

test("create appends by default, honours --after, and returns ids in subject order", () => {
  const appended = createTasks(BODY, { subjects: ["Third thing"] });
  assert.ok(appended.ok);
  // After the last task, not after the trailing note.
  assert.match(appended.body, /- \[ \] Document the verbs\n- \[ \] Third thing\n\nNotes/u);
  assert.deepEqual(appended.value, [ids(appended.body)[3]]);

  const top = createTasks(BODY, { subjects: ["Urgent one", "Urgent two"], after: "top" });
  assert.ok(top.ok);
  assert.deepEqual(parseRoadmap(top.body).tasks.slice(0, 2).map((task) => task.subject), ["Urgent one", "Urgent two"]);
  assert.deepEqual(top.value, ids(top.body).slice(0, 2));

  const after = createTasks(BODY, { subjects: ["Between"], after: ids(BODY)[0] as string });
  assert.ok(after.ok);
  assert.equal(parseRoadmap(after.body).tasks[1]?.subject, "Between");

  assert.equal(createTasks(BODY, { subjects: ["Nowhere"], after: "zzzz" }).ok, false);
});

test("an empty roadmap takes its first tasks and the whole batch fails together", () => {
  const first = createTasks("", { subjects: ["One", "Two"] });
  assert.ok(first.ok);
  assert.equal(first.body, "- [ ] One\n- [ ] Two");
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

test("rendering carries ids inline, and the reminder mode drops completed history", () => {
  const tasks = parseRoadmap(BODY).tasks;
  const full = renderTasks(tasks, "full");
  assert.equal(full.split("\n").length, 3);
  assert.match(full, /^- \[x\] \[[0-9a-f]{4}\] Replace the locator$/mu);

  const pending = renderTasks(tasks, "pending");
  assert.equal(pending.split("\n").length, 2);
  assert.doesNotMatch(pending, /Replace the locator/u);
});
