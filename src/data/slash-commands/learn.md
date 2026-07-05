---
description: Distill a workflow, doc, or conversation into a reusable skill
---
[/learn] The user wants you to learn a reusable skill from their request and save it.

The request is open-ended and may mix two kinds of content, in any order: SOURCES to gather (directories, file paths, URLs, "what we just did", pasted notes) AND REQUIREMENTS that shape the skill (what to focus on, what to leave out, scope, naming). Treat EVERY part of the request as load-bearing — prose after a path or link is the user telling you what they want from that source. Never gather the first source and ignore the rest. If no request text was given, distill the workflow from THIS conversation: review the steps taken and capture them.

Do this:
1. Gather every source the user named, using the tools you already have — `file_read` for local files, `web_fetch` for URLs, the current conversation history if they referred to something you just did, and pasted text as-is. For codebase exploration, delegate to a session. If scope is ambiguous, make a reasonable choice and note it; do not stall.
2. Apply every requirement/focus/constraint in the request to the skill you author — these govern what the SKILL.md covers, not just which sources you read.
3. Confirm the skill name + category + one-line description with the user (creating a NEW skill always requires confirmation), then author ONE skill via `skill_manage` (action="create").

Follow these authoring standards exactly (HARDLINE — same rules a maintainer enforces in review):

**Frontmatter (passed as skill_manage params):**
- name: lowercase-hyphenated, ≤64 chars, no spaces.
- description: ONE sentence, **≤60 characters**, ends with a period. State the capability, not the implementation. No marketing words (powerful, comprehensive, seamless, robust). Do NOT repeat the skill name. This rule is NOT cosmetic: the skill index injects the description into every session and routing depends on it — anything vague or over-long breaks routing. COUNT the characters before saving; skill_manage hard-rejects >60.
  - Good (≤60): `Search arXiv papers by keyword, author, or ID.`
  - Bad: `A comprehensive skill that lets the agent search arXiv for academic papers using keywords and authors.`
- type: `action` for a procedure/how-to; `knowledge` for curated stable facts about a topic.
- category: pick a sensible grouping (finance, career, projects, walnut, ...). Reuse an existing category when one fits.

**Body — action skills use this section order (omit a section only if genuinely empty):**
1. `# <Human Title>` + 2-3 sentence intro: what it does, what it does NOT do, key dependency stance.
2. `## When to Use` — bullet list of concrete trigger phrases.
3. `## Prerequisites` — exact env vars, install steps, credentials.
4. `## Procedure` — numbered steps with copy-paste-exact commands.
5. `## Pitfalls` — known limits, things that look broken but aren't.
6. `## Verification` — a single check that proves it worked.

**Body — knowledge skills:** freeform but concise (~100 lines): stable facts, decisions and their WHY, key references. No episodic events ("last Tuesday we...") — those belong in the daily log.

**Quality bar:**
- Prefer exact commands, URLs, signatures, and config keys that appear VERBATIM in the source. NEVER invent flags, paths, or APIs — if you didn't see it in the source, don't write it.
- Keep it tight and scannable: ~100 lines simple, ~200 complex. Don't re-paste source docs.
- Don't write a router/index skill that only points at other skills.
- When updating later: replace outdated facts in place — never append duplicates.

When done, tell the user the skill name, its category, and a one-line summary of what it captured.
