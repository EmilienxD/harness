---
name: review-pr
description: Reopen the aboard session that owns the open pull request and hand it to you. Takes no arguments. Intentionally empty - handled entirely by a UserPromptSubmit hook, no model call.
disable-model-invocation: true
---

<!-- Intentionally empty. The UserPromptSubmit hook intercepts "/review-pr" and
     exits 2 before this content is ever loaded into context, so nothing below
     this line is read by the agent. This file exists only so /review-pr appears
     in the skill/command listing and autocomplete.

     The command takes no arguments on purpose: it focuses or resumes the session
     that built the pull request currently in flight, which the extension already
     knows. It is a handoff, not a review request. -->
