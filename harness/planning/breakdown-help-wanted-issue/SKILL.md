---
name: breakdown-help-wanted-issue
description: Developer-invoked only. Agents must not invoke this skill on their own. Break down an unclear request into a concrete solution, provide recommendations on what to build, and agree with the developer.
argument-hint: "[request]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Breakdown an unclear request and turn it into a clear solution.

## Process

### 1. Gather context

If the developer provided the request or passes a reference (a spec path, an issue number, or a URL) as an argument, fetch it and read its full body, plus any relevant reference in that body. Otherwise, treat the oldest open issue labelled `[AI]-help-wanted` as the request. Run: `gh api 'repos/{owner}/{repo}/issues' --method GET -f state=open -f 'labels=[AI]-help-wanted' -f sort=created -f direction=asc -f per_page=100 --paginate --jq '.[] | select(.pull_request == null) | {number,html_url,title,body}'` (or the PowerShell equivalent if you are running PowerShell). If no issue is found or the lookup fails, tell the developer and ask for a request.

(Optional) If you haven't already explored the codebase or read the related contract documents, do so to understand the current state of the code. Look for refactoring opportunities that make the implementation easier. "Make the change easy, then make the easy change."

### 2. Agree on a solution

Establish the underlying problem, current behavior, and what the request would change. Ask questions when intent or scope is uncertain, and give concrete, concise recommendations grounded in what you found, including tradeoffs and simpler alternatives.

Discuss with the developer until you agree on the intended behavior, scope, and success criteria.

The session is done when the solution is completely approved; nothing is left silently assumed. Do not act on it until the developer confirms you have reached a shared understanding.

### 3. Hand off to the developer

Tell the developer that you have reached a shared understanding, summarize the core solution decided upon for the initial problem in 1–3 sentences, and state that you are ready to proceed to the next steps.