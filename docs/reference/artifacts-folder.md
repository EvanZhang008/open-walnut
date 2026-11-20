# The artifacts folder

One place per task for everything it makes and keeps, apart from the user's own notes
(`src/core/artifacts/`). 2026-11-19, the user: "I want a unified way, to store all these ... we can
have an artifacts folder, which has skills, memory?"; 2026-11-20: "each session has a assign
location to store all the artifacts ... the folder should be named as artifacts, skills, memory,
drawing whatever for that project", and "only use now location please, migrate all": nothing writes
the places it replaced. Its first name, for one day, was `knowledge/`.

```
WALNUT_HOME/artifacts/
  org/skills/<name>/SKILL.md              the org's skills
  nodes/<taskId>/skills/<name>/SKILL.md   a task's own skills
  nodes/<taskId>/notes/*.md               its memory folder (Walnut's moved prompt blocks, its own notes)
  nodes/<taskId>/MEMORY.md                its MEMORY.md (node-memory.ts)
  nodes/<taskId>/guidance.md              the team guidance its reflection writes
  nodes/<taskId>/reflections/<date>.md    its reflection's day records
  nodes/<taskId>/drawings/                its drawings (drawingsDirOf)
  shared/notes/*.md, shared/drawings/     what belongs to no one task
  .moved.json, .backup/<stamp>/           the move's record and the whole of what it started from
  .backup/taken/<run>/                    what was taken in from an old place later, and what it replaced
```

By task id, not by project: a task that moves to another project keeps its folder, and what spans
tasks goes in `shared/`. Paths come only from `paths.ts` (`nodeArtifactsDir`, `skillsDirOf`,
`notesDirOf`, `memoryCopyOf`, `drawingsDirOf`).

## Who reads what

- **Skills**: Main and a VP read the index of their own and the org's skills after a compaction and
  in a new conversation (`own-readback.ts`). Every other session gets the org's skills index in the
  `team-guidance` message hint (`team-guidance-hint.ts`) at its start, after a compaction and when it
  changes. Any session reads a skill whole with `agent_skill_read`.
- **Memory folder**: the node it belongs to, on demand (`agent_memory_read {"file"}`).
- **MEMORY.md**: the node at every turn end and after a compaction, anyone with `agent_memory_read`
  (`GET /api/v1/tasks/:id/agent-memory`). It is no field of the task any more.
- **Team guidance**: the sessions a node manages, through the same hint.
- **A person**: with the one tree on (below), the Notes page shows every file of it, the notes and
  the artifacts alike; before that, the artifacts folder in a file browser.

A `SKILL.md` is the common format (front matter, then the text): `name`, `description`, `at`, `by`,
`by_name`, `kind`, `scope`, each value a JSON string. A `MEMORY.md` has `at`, `by`, `by_name`,
`by_at`, `refused_at`, `refused_chars`, `ops` (offline writes applied), `hash` (of the text) and
`kind: "memory"`. A person may edit either in place; Walnut reads the edit. A MEMORY.md whose text no
longer matches its `hash` is dated by the file's time; a sync or a touch that only moves the time
changes nothing, so a turn-end rewrite asked over that file still lands.
Writes through Walnut (`agent_skill_write`) are still screened for injection.

## One tree with the notes (experimental `notes_unified`)

2026-11-20, the user: "can we unified the note and the artifacts? ... artifacts/walnut-project/
prject0name/skills|notes|memory|drawing ... I want all the artifact need for a project inlcude
drawaing wthat ever, is stored here." With the switch on (Settings, default off), the next start
moves the vault and the artifacts folder into one tree by project (`src/core/artifacts/unify/`):

```
WALNUT_HOME/artifacts/
  projects/<project>/notes/          the vault's folder of that project (Projects/<name>/, or a top folder named like it)
  projects/<project>/skills/         the skills of its tasks
  projects/<project>/memory/<taskId>/  a task's MEMORY.md, memory folder, guidance, reflections
  projects/<project>/drawings/       its drawings
  notes/                             every other vault file, its path unchanged under notes/
  skills/                            the org's skills
  memory/<taskId>/, memory/_shared/notes/   a task with no project, what belongs to no task
  drawings/                          the drawings of no project
  .unified.json                      the record: the map, every move, the backup
```

The vault's root is the tree from then on (`notesRoot()`), so the Notes page shows all of it.

- **The move**: a copy-on-write clone of everything into `.unify-stage/`, a sha256 of every file on
  both sides (the counts must match), then the record (`switching`), then two renames: the old
  `notes/` and `nodes/`, `org/`, `shared/` into `.backup/unify-<stamp>/`, the stage into place, the
  record `live`. A stop in between is finished at the next start; until then nothing makes an
  empty `notes/` (the boot keeps the tree's layout), and a `notes/` something made anyway goes
  beside the backup. A file written to the old places after they were listed is taken from the
  backup into the tree. A check that fails moves nothing; a vault that is a link (to a synced
  folder) is left where it is.
- **Names clash** (any case, as APFS): the later file gets " 2" (a drawing's files together), a skill
  folder "-2". The real vault had none.
- **Nothing is rewritten inside a note.** Every old path still opens: `movedNotePath`
  (`src/core/notes/note-path-moves.ts`, the record's exact entries, then its folder rules) is asked
  by every resolver of a note path, the path-form links of the index, and the web client, which gets
  the map with the notes list (`tests/core/notes/path-form-links-moved.test.ts` fails on a new
  resolver that does not ask). What names a note by path is re-pointed: the Notes index (hashes
  kept), the search index's note docs (vectors kept), the bookmarks, each replica's
  `notes_exclude`, each project's tracking note.
- **A task that changes project** takes its memory folder and its drawings' task folder along
  (`task-homes.ts`, one move at a time per task, to the project the task has when it runs); its
  skills stay with the project they were made in. **A renamed project** takes its whole folder,
  and the record's map follows, so an old path still lands.
- **What is left out stays out**: each replica's `notes_exclude` and the search's
  `excluded_folders` follow their folders (a project's whole notes folder stands for the project).
- **`knowledge/`** becomes a folder of links (marked `.walnut-links`) into the tree, so a path an
  older message named still opens without a second copy of the notes for Obsidian.
- **Off again**: the next start puts every file where it was (the record's exact entries; a file
  made in the tree meanwhile by its folder: a task's memory to `nodes/<id>/`, a new project's notes
  to `Projects/<name>/`), checked by hash the same way and recorded (`rolling-back`) so a stop part
  way is finished, then re-points the records back; the tree is kept in
  `.backup/unified-tree-<stamp>/`. A `notes/` something made meanwhile keeps its files. An older
  release started on the tree sees an empty vault: turn the switch off and start once first.

Limits: a replica (the cloud companion) has no map yet, so an old path-form link reads unresolved
there; a raw `artifacts/nodes/<id>/...` path a message named in the last day opens only through
Walnut's ops, not as a file.

## The places before it

`agent-skills/<key>.json`, `agent-memory/<key>/*.md` and a task row's `agent_memory` are never
written by this release (`tests/core/artifacts/legacy-places-ratchet.test.ts` fails on any code that
does, `migrate.ts` and `rollback.ts` aside). Who may still write them: an older release after a roll
back, or a sync that brings a row an older box wrote. So they are an inbox, emptied before any read
or write of what they hold and at every boot (`migrate.ts`):

- a skill is added where the folder lacks it, or replaces the folder's when it differs and its file
  is the later; a folder's skill is never removed by it
- a note is copied where the folder lacks it, or when it differs and is the later
- a MEMORY.md is merged with the file, losing no line: the one that holds the other whole is kept,
  and two that each hold lines the other lacks are both kept, the row's under a heading saying so
- each is then moved to `artifacts/.backup/taken/<run>/`, with the folder's own version of anything
  it replaced; a row's memory is cleared only once its file holds it
- the folder's first name, `knowledge/`, is renamed to `artifacts/` first thing at boot; one an older
  release wrote again beside it is merged file by file (the later wins, the other is kept) and moved
  to the backups
- `knowledge/` then stays a link to `artifacts/` (relative; a junction on Windows), so a path an
  earlier message named (the reflection's nightly note of 2026-11-20 03:45 did) still opens; nothing
  of Walnut's writes through it, and nothing Walnut gives a session names the old places
  (`tests/core/artifacts/legacy-places-ratchet.test.ts`)

The backup is made before the first take, whichever comes first (the boot move or a read).

The offline journal is unchanged: a MEMORY.md append an offline host saved (`agent-memory` records)
is applied to the file when the Mac drains it, with the op key in the file, so a redrain writes once.

## The backup

The first boot of this release, before it touches anything, copies `agent-skills/`, `agent-memory/`,
the artifacts folder (its backups aside) and every row's MEMORY.md (`memories.json`) to
`artifacts/.backup/<stamp>/`, and records it in `.moved.json` (version 2; `earlier` names the
backup the release before made). A backup that fails moves nothing.

## Going back

With Walnut stopped, `bun scripts/artifacts-rollback.ts` writes the old places back from the folder
(`rollback.ts`): each skills scope to its JSON file, each note to `agent-memory/`, the skills, notes,
guidance and reflections to `knowledge/`, a real folder again in place of the link (the release just before this one reads them there), and
each MEMORY.md onto its task's row, moving the file to `.backup/rolled-back/` so coming forward again
takes the row whole (the older release may have rewritten it). `.moved.json` goes back to version
1. Then start the older release. Coming forward again, the first boot backs everything up anew and
takes in what the older release wrote meanwhile.

Limits: "later" is a file's time, so a restore that rewrites an old JSON file makes it the later
side (what it replaces stays in the backups). A note or a skill the older release deleted after a
roll back comes back on the way forward. A read that fails for any reason but a missing file
refuses the write rather than reading fewer skills or an empty memory.

Ratchets: `tests/core/artifacts/unify-*.test.ts`, `tests/core/notes/note-path-moves.test.ts`,
`tests/core/notes/path-form-links-moved.test.ts`, `tests/core/artifacts/artifacts-move.test.ts`, `tests/core/artifacts/legacy-places-ratchet.test.ts`,
`tests/core/hints/team-guidance-hint.test.ts`.
