import assert from "node:assert/strict";
import { test } from "node:test";
import { compilePrompt, NOTES_ID, roundPayloadSchema, type AnswerDraft } from "../src/lib/grill-contract.ts";

const payload = roundPayloadSchema.parse({
  questions: [
    {
      id: "Q19",
      question: "Choose?",
      explanation_html: "<p>Choose an option.</p>",
      recommendation: "A",
      options: [{ letter: "A", label: "First", detail: "First choice" }],
    },
  ],
});

test("round notes can produce a reply without answering a question", () => {
  const notes: AnswerDraft = {
    question_id: NOTES_ID,
    selected_option: null,
    note: "Additional context",
    state: "queued",
  };
  assert.ok(compilePrompt(payload, [notes]).length > 0);
});

test("unsent and empty round notes do not create a reply", () => {
  const notes: AnswerDraft = {
    question_id: NOTES_ID,
    selected_option: null,
    note: "Additional context",
    state: "draft",
  };
  assert.equal(compilePrompt(payload, [notes]).length, 0);
  assert.equal(compilePrompt(payload, [{ ...notes, note: " \n ", state: "queued" }]).length, 0);
  assert.equal(compilePrompt(payload, [{ ...notes, note: null, state: "queued" }]).length, 0);
});

test("notes remain separate from generated questions", () => {
  assert.equal(
    roundPayloadSchema.safeParse({
      questions: [{ ...payload.questions[0], id: NOTES_ID }],
    }).success,
    false,
  );
  const answer: AnswerDraft = { question_id: "Q19", selected_option: "A", note: null, state: "queued" };
  const notes: AnswerDraft = {
    question_id: NOTES_ID,
    selected_option: null,
    note: "Additional context",
    state: "queued",
  };
  assert.ok(compilePrompt(payload, [notes, answer]).length > compilePrompt(payload, [answer]).length);
});
