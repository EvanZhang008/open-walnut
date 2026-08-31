---
name: register-repo
description: >-
  Register a repository: start a Claude Code session that explores the
  codebase and creates a structured profile. Use when the user says
  "register repo", "add this repo", or wants a repository profile created.
---

# Register Repository (session-driven)

The user wants to register a repository. Hand it to a Claude Code session: the session does the exploration, not you.

1. **Figure out the path** from user input, task context, or ask if unclear.
2. **Find the session-side skill**: look in `<available_skills>` for `walnut-register-repo` and note its `<location>` path.
3. **Start a session** (`session_start`) with:
   - `working_directory`: the target repo path
   - `prompt`: "Read the skill at {location} and follow its instructions to explore this codebase and register it as a repository." Include any extra context the user provided.
4. **After the session completes**, verify with `file_read source='repos/{slug}'`.

Do NOT investigate the codebase yourself. Do NOT ask the user a bunch of questions. The session + skill handles everything.
