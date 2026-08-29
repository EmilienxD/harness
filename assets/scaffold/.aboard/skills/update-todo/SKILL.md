---
name: update-todo
description: Write or evolve the aboard project roadmap issue, one task at a time
argument-hint: "[roadmap change]"
disable-model-invocation: true
---

Apply the user's argument to the roadmap if there is one, otherwise write the first one.

## If the roadmap is already in your context

Apply granular `todo_create` and `todo_update` calls against the positions you already hold — read each task's position and current subject off the newest roadmap block. There is no fetch step and no full-body rewrite.

Then tell the user what moved, in one or two sentences. Not the whole document — they can read it on GitHub.

## If the roadmap section says this project has no roadmap yet

A roadmap is derived, never invented: it says what is left to do, which only means something against what already exists and what the user is trying to reach. So before anything else, settle **what this one can be derived from**. Three answers, and they do not mix.

This is the one write in the project where guessing is expensive — the roadmap sets the priority order every later session reads as the through-line, and a wrong one is corrected by the user task by task rather than fixed in one pass.

### From a reference the user gave you

The argument names source material — a file path, an issue number, or a URL. Read it in full, comments included, and derive the roadmap from it. The codebase survey below is redundant when that material already states the intent a survey exists to reconstruct. Ask only about what it leaves genuinely open, then write.

### From the code

The Repository section reports source files and commits. When there is real code, take it as the roadmap's evidence, in three steps, strictly in this order — each step's output is the next one's input.

1. **Delegate the survey.** Run an `Explore` agent over the repository, at very thorough breadth, and ask it to report in under 400 words: what the project is and does, its main components and what each is for, work that is visibly unfinished (TODO/FIXME comments, stubbed functions, empty test files, disabled code paths), and anything that looks broken, missing, or half-migrated — what is there, not a proposed plan. Delegate this rather than reading the repository yourself: a project-wide survey is the largest read you would ever perform, and it would land in the longest-lived context in the system and be lost at the first compaction.
2. **Interview the user before proceeding.** One bounded round of numbered questions, each grounded in something the survey actually found: what matters most next, what is deliberately unbuilt, what they consider done that the code makes look unfinished, whether anything the survey called broken is intentional. Never ask what the code already proves — that is what the survey was for. **End your turn on the questions.** Do not call `todo_create` in the same turn you ask them, do not draft a list "for them to correct", and do not proceed on an assumed answer.
3. **Write it in one `todo_create` call**, once they have answered. Ten to twenty tasks, most important first, as a single batch. Where their answers disagree with what the survey implied, follow the answers: they are the authority on priority and intent.

### From neither

The repository holds no code, or only a README, a licence, or an untouched framework scaffold — the Repository section says so outright, and one commit is the same signal in weaker form. There is nothing to survey, and a roadmap inferred from the project's name is fiction the user then has to delete. So do not run the survey, and do not write.

Ask instead, in plain text: what they are building and for whom, and what the first working version has to do. Then recommend `/brainstorm` — a roadmap is a sequence of decisions, and on a project this early those decisions do not exist yet; that conversation is what creates them. Say what the loop is, so they can see they are being pointed somewhere rather than turned away: the brainstormer converges on durable planning material, then `/update-todo <that issue or path>` turns it into the first roadmap.

If they would rather skip the brainstorm, write it directly — but only once their answer carries what a roadmap needs: what is being built, the stack or platform wherever it constrains the order of work, and what the first milestone is. Below that bar, say plainly that anything you wrote would be guesswork, and ask for the missing piece instead of filling it in yourself. A roadmap written here is a build order — scaffold, then the first vertical slice, then the next capability — not a survey of unfinished work, so ten to twenty tasks may be more than this project can honestly support. Write the ones that are real.
