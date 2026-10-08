# Zoom out

## Use it

Invoke `/zoom-out` in Claude Code or `$zoom-out` in ChatGPT with the code area you want to understand, for example `$zoom-out authentication middleware`.

## What happens

The agent moves up a level of abstraction and maps relevant modules and callers using the project's domain vocabulary. Use it when you need to see how an unfamiliar area fits into the rest of the codebase before examining individual functions.

## Practical note

Name a package, module, or feature that exists in the current project. The output is a map of its place in the system and the callers around it, which you can use to choose what to inspect next.
