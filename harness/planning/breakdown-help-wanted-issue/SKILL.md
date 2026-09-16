---
name: breakdown-help-wanted-issue
description: Fetch and breakdown a [AI]-help-wanted labelled Github issue, explore, provide recommandations on what to build and agree with the user.
argument-hint: "[request, issue, or file]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Process the argument supplied by the user; read any referenced issue or file. With no argument, use the oldest open issue labelled `[AI]-help-wanted` in the current repository:

```bash
gh api 'repos/{owner}/{repo}/issues' --method GET -f state=open -f 'labels=[AI]-help-wanted' -f sort=created -f direction=asc -f per_page=100 --paginate --jq '.[] | select(.pull_request == null) | {number,html_url,title,body}'
```

The results are oldest first and exclude pull requests; use the first issue. Read its title and body, and comments when useful; link the source issue to the user. If no issue is found or the lookup fails, explain and ask for a request.

Explore the relevant code, tests, and documentation first. Establish the underlying problem, current behavior, and what the request would change. Ask questions when intent or scope is uncertain, and give concrete recommendations grounded in what you found, including tradeoffs and simpler alternatives.

Work with the user until you agree on the intended behavior, scope, and success criteria. Keep the discussion proportional to the request. This skill clarifies the work; implementation or GitHub changes require a subsequent user request.
