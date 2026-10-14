# Skill mechanics

The skill-specific branch of [`writing-for-agents`](SKILL.md): what changes when the document is a skill (frontmatter, the invocation choice, and router skills). Everything else about writing it is the universal reference in `SKILL.md`.

## Invocation

Two choices, trading the two loads:

- A **model-invoked** skill keeps a `description`, so the agent can fire it autonomously, and other skills can reach it. You can still type its name: model-invocation always _includes_ user reach; a description only ever adds agent discovery, never removes the human's. The description is the skill's top-level context pointer, forced to stay loaded at all times: permanent context load in exchange for discoverability. A model-invoked skill whose content is all reference is also one home for shared reference: another skill can invoke it, so reference needed by several skills lives in one place. Mechanics: omit `disable-model-invocation`, and write a model-facing description carrying the trigger branches (the pointer-writing rules in `SKILL.md` apply in full).
- A **user-invoked** skill requires explicit user invocation (`/skill-name` in Claude Code, `$skill-name` in Codex, `/skill:name` in Pi); a general request for the underlying task does not invoke the skill. Set `disable-model-invocation: true` for Claude Code and Pi and `policy.allow_implicit_invocation: false` in ChatGPT metadata. Claude Code omits its description from agent context, but an agent can still discover the file directly. Begin the description with "User-invoked only. Agents must not invoke this skill on their own." followed by a human-facing summary. It spends cognitive load: you are the index that must remember it exists.

Pick model-invocation only when the agent must reach the skill on its own, or another skill must. If it only ever fires by hand, make it user-invoked.

Shared reference that two user-invoked skills both need can live in neither: neither may invoke the other autonomously. Push it to a plain file outside the skill system: external reference any skill can point at.

## Pi mechanics

Pi discovers directory-based skills recursively in `.pi/skills/` for a project and `~/.pi/agent/skills/` for the user; `PI_CODING_AGENT_DIR` changes the user agent directory. It also discovers `.agents/skills/` in the project ancestry and `~/.agents/skills/`. Keep the declared name and directory name aligned for portability. A duplicate name keeps the first discovered skill and produces a startup warning; check diagnostics to confirm the intended source. Reload after editing an installed skill.

Use portable `name` and `description` frontmatter, with `license`, `compatibility`, and `metadata` as needed. Pi honors `disable-model-invocation: true`. Its `enableSkillCommands` setting controls interactive command discovery; manually entered `/skill:name` commands still work when discovery is disabled.

Pi appends `/skill:name` arguments as a user request after the loaded instructions. Describe how to interpret the accompanying request instead of relying on Claude's `$ARGUMENTS` substitution. Resolve bundled references and scripts relative to the skill directory. Claude-specific argument hints, fork context, and tool declarations do not supply Pi execution or permission behavior; require actually available tools and report capability gaps explicitly.

## Splitting by invocation

The invocation cut of splitting (the sequence cut lives in `SKILL.md`): split off a model-invoked skill when you have a distinct leading word that should trigger it on its own (a trigger word you actually use in your prompts), or another skill must reach it. You pay context load for the new always-loaded description, so that independent reach has to be worth it.

## Router skills

When user-invoked skills multiply past what you can remember, that piled-up cognitive load is cured by a **router skill**: one user-invoked skill that names the others and when to reach for each, so the human has one skill to remember instead of many. It can only hint, never fire them: each requires explicit user invocation.
