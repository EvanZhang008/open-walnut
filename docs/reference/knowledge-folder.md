# The knowledge folder

What agents read as standing knowledge lives in one folder, one format (Markdown), apart from the
user's own notes (`src/core/knowledge/`; 2026-11-19, the user: "I want a unified way, to store all
these ... we can have an artifacts folder, which has skills, memory?"; his lead picked the
recommended layout for him).

```
WALNUT_HOME/knowledge/
  org/skills/<name>/SKILL.md              the org's skills
  nodes/<taskId>/skills/<name>/SKILL.md   a task's own skills
  nodes/<taskId>/notes/*.md               its memory folder (Walnut's moved prompt blocks, its own notes)
  nodes/<taskId>/MEMORY.md                a copy of its MEMORY.md
  nodes/<taskId>/guidance.md              the team guidance its reflection writes
  nodes/<taskId>/reflections/<date>.md    its reflection's day records
  shared/notes/*.md                       the memory folder every session shares
  .moved.json, .backup/<stamp>/           the move's record and what it copied from
```

## Who reads what

- **Skills**: Main and a VP read the index of their own and the org's skills after a compaction and
  in a new conversation (`own-readback.ts`). Every other session gets the org's skills index in the
  `team-guidance` message hint (`team-guidance-hint.ts`) at its start, after a compaction and when it
  changes. Any session reads a skill whole with `agent_skill_read`.
- **Memory folder**: the node it belongs to, on demand (`agent_memory_read {"file"}`).
- **MEMORY.md**: the task record stays its source (offline hosts and older clients write it there);
  the file is a copy for reading it beside the rest, written again whenever the memory changes.
- **Team guidance**: the sessions a node manages, through the same hint.

A `SKILL.md` is the common format (front matter, then the text): `name`, `description`, `at`, `by`,
`by_name`, `kind`, `scope`, each value a JSON string. A person may edit one in place; Walnut reads
the edit. Writes through Walnut (`agent_skill_write`) are still screened for injection.

## The move, and the places it came from

The primary runs the move at every boot (`migrate.ts`):

1. **Once**: `agent-skills/` and `agent-memory/` are copied whole to `knowledge/.backup/<stamp>/`
   before anything else, and `knowledge/.moved.json` records it. A backup that fails moves nothing.
2. **Every boot**: a skills scope or a memory-folder file whose old place is newer (never moved, or
   written by the release before this one after a roll back) is brought in. Newer files in the
   knowledge folder are never overwritten.
3. Each node's `MEMORY.md` is copied, and kept current while the server runs.

The old places are still written: every skills change writes the whole scope's JSON file
(`agent-skills/<taskId>.json`, `_org.json`) under the same lock the release before takes, and a
node's own note is written to `agent-memory/<taskId>/` too. A memory-folder file missing in the new
folder is read from the old one.

## Going back

The release before this one reads `agent-skills/*.json` and `agent-memory/`, which are current, so
deploying it is the whole roll back. To also remove the folder, with the server stopped, remove
`knowledge/org/skills`, `knowledge/shared`, `knowledge/nodes/<id>/{skills,notes,MEMORY.md}` and
`knowledge/.moved.json` (`guidance.md` and `reflections/` belong to the reflection duty). The backup
holds the old folders as they were at the move. Coming forward again, the next boot brings in what
the release before changed meanwhile.

Limits: "newer" is a file's time, so a restore or a sync that rewrites `agent-skills/*.json` makes
it the newer side (what it replaces is copied to `knowledge/.backup/reconcile-<stamp>/` first). A
note the release before deleted after a roll back comes back on the way forward. A scope's folder
counts as moved only once it holds its `.moved` mark, written after its last skill, and a read
that fails for any reason but a missing file refuses the write rather than reading fewer skills.

Not done yet: the Notes page does not show the folder (it reads `notes/` only), and the MEMORY.md
copy is not read back (an edit there is overwritten by the next memory change).

Ratchets: `tests/core/knowledge/knowledge-move.test.ts`, `tests/core/hints/team-guidance-hint.test.ts`.
