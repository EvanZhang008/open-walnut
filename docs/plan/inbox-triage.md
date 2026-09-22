# Inbox Triage

An opt-in routine that reads a BATCH of new mail and Slack instead of one message at a
time, works out what each item means for work the user already has, keeps the project
tracking notes true, and asks the user about anything that needs a decision.

It is off by default (`triage.enabled: false`). Settings has its own section, `Inbox
Triage`, which is the only place a normal user turns it on.

## Why a new session every run

Every run mints a NEW task and a NEW session. That is the load-bearing decision, and it
is deliberate rather than convenient: a single long-lived triage session would carry its
memory in a context window, which means the memory dies with the session, cannot be read
or corrected by the user, and grows until it is compacted away. Forcing a clean session
per run means the only memory that survives is memory that was written down somewhere a
human can open.

So the persistence layer is the feature, not a side effect of it:

| Layer | Where | What it holds | How a run gets it | How a run updates it |
|---|---|---|---|---|
| Standing memory | `~/.open-walnut/memory/agents/triage/MEMORY.md` | Durable rules the runs learned: "this newsletter is FYI only", "#cis-dev belongs to project CIS", preferences the user gave in a letter reply | Injected by `buildLaneProfile` on a `claude` engine; carried in `messagePrefix` on an ACP engine | `memory_write` at the end of a run, only for something new |
| Working state | `notes/Walnut/Triage/State.md` (vault) | `## Awaiting` (the `rq-`/`lt-` ids a run is waiting on), `## Watching`, `## Recently handled` (message ids and permalinks, for dedup), `## Notes for next run` | The envelope carries the note's body verbatim | Rewritten at the end of a run, under the hash it read |
| Project tracking | `notes/Projects/<Project>/Tracking.md` | One level above the task board: status, workstreams, open questions, a log. See [the tracking note section](#the-tracking-note) | `project_tracking_get` on demand | `note_edit` per entry, under the hash it read |
| Run journal | `notes/Walnut/Triage/Runs/YYYY-MM.md` | One line per run: when, how many items, what it did, which letters it sent, which tasks it asked | The previous line rides the envelope | Appended at the end of a run, by heading anchor |

The skill's last step names all four, and the run instructions repeat the ones the server
enforces. The runner verifies the working-state half softly: if `State.md`'s frontmatter
`updated` is older than the run's start, it records a warning and the NEXT envelope opens
with "the previous run did not update State.md". It never retries a run automatically.

## The shape of the routine

Nothing about triage is a new scheduling concept. It is four existing routine parts
composed, which is why the routines page can show it, disable it, and report its history
like any other routine:

```
schedule      { kind: 'every', everyMs }                              the clock
wake          { events, countField: 'count', threshold, skipWhenIdle } the counter
initProcessor { actionId: 'inbox-triage-batch', timeoutSeconds: 30 }   the batch
executor      { type: 'claude-code', config: { agentId: 'triage', … } } a new task+session
```

`wake` is the "every N messages" half of the user's request, and it is a gate on an
existing schedule rather than a new schedule kind: each source's poll tick publishes one
bus event carrying how many new items it brought, the counter adds that number, and
crossing the threshold fires the routine early. The counter is decremented by the number
observed at dispatch rather than zeroed, so items that arrive while a run is in flight
are not swallowed. `skipWhenIdle` makes a TIMED fire with zero new items a `skipped` run
with no executor call at all, which is what keeps an idle mailbox free.

`initProcessor` runs BEFORE the executor and is the only place a fire can be declined
without a session being minted, which is why the active-hours window is enforced there
and not in the routine or in the config reader.

The executor is the generic `claude-code` one, extended with four optional fields
(`agentId`, `walnutAgent`, `project`, `titleTemplate`). Without them it behaves exactly as
it did, pinned by a test. With them a run's task is filed under the project `Ask Inbox
Triage` with `pinTier: null` (never on the pinned board), and the run shows up in the Ask
drawer under the agent "Inbox Triage", which makes the drawer's per agent list the run
history.

Exactly ONE routine exists, ever. `bootstrap.ts` finds its own routine by the init
processor's action id first (a marker the routine form cannot erase, because the form does
not render `initProcessor`) and by name second, so renaming the routine does not produce a
second one on the next enable. Enabling creates no task and no session; disabling
disables the routine and leaves the notes and the run history alone.

## What a run may do on its own

`mode` is the ONLY difference between `ask` and `assist`, and it is a difference in what a
run may do WITHOUT ASKING, never in what may leave the machine.

| | `ask` (default) | `assist` |
|---|---|---|
| Read mail, Slack, tasks, notes | yes | yes |
| Update `State.md`, the run journal, `Tracking.md` | yes | yes |
| Ask a task what it knows (`task_send`, `expectReply`) | yes | yes |
| Create or update a task | letter | yes |
| One-click unsubscribe | letter | yes |
| Mark mail read | letter | only with `auto_mark_read: true` |
| Send mail | `mail_request_send` | `mail_request_send` |
| Post to Slack | `slack_request_post` | `slack_request_post` |
| Mark Slack read | approval | approval |
| Unsubscribe by writing to a list | `mail_unsubscribe_request` | `mail_unsubscribe_request` |

Nothing in either mode sends mail or posts to Slack directly. Those go through the
approval ledger the console's own Send button uses, so a decision letter answered with
"reply for me" produces a DRAFT plus a second approval letter, and nothing leaves the
machine on the run's own authority.

## Letters: one summary, three decisions

A run may send one summary letter (anything that is not `action_required`) and at most
three `action_required` decision letters. The fourth is refused by the server with a
sentence the model can act on, naming the summary letter to fold the rest into.

Two reasons the budget is enforced server-side and not left to the prompt. First, every
letter badges the bell AND pushes to the phone, and letter pushes are deliberately
independent of the "is a browser open" gate, so a run that sent one letter per item would
turn a quiet batch into twenty banners. Second, the check has to be somewhere the model
cannot route around: it lives in `sendLetterAsCaller`, the one server-side place a letter
is minted from a caller's session, shared by the HTTP route and the cloud replica's relay.
Putting it in the op declaration would have made it advisory, because the op's `bind`
becomes an HTTP call from the caller's own process.

The budget is keyed on the run's SESSION, which is why "per run" needs no run id, no reset
schedule, and no cleanup after a crashed run: a new run is a new session by construction.
Identity comes from the task's `agent_id: 'triage'` stamp rather than from its project
name, so renaming the project cannot switch the budget off. A sender with no task, or a
task that is not a triage run, is not tallied at all and its send proceeds untouched.

A decision letter with no buttons is refused the same way. A letter asking for a decision
with nothing to press is a dead end in a human's inbox.

An answer goes back to the run that asked, waking a stopped session with `--resume`.
Decision letters an EARLIER run left unanswered are withdrawn when a later run takes their
item over, which leaves answered letters, the current run's own, and every other sender's
letters alone.

## The tracking note

The "one level above a task" layer the user asked for is a note per project at
`notes/Projects/<Project>/Tracking.md`, not a new entity. A project is still the single
grouping layer; the tracking note is its living document, the same way a task has a note.

```markdown
---
project: <exact project name>
kind: project-tracking
updated: 2026-09-21T14:10Z
---
## Status
One sentence on where this stands, then the next milestone.
## Workstreams
| Item | State | Owner task | Last update | Source |
| Design review | in progress | [[task:ab12cd34]] | Sep 21 | mail: RFC v3 from the platform list |
## Open questions
- Who owns the migration window? (raised in mail, Sep 20, unclaimed)
## Log
- 2026-09-21 14:10 triage: RFC v3 arrived (mail); asked task ab12cd34, reply: "aware, reviewing"
```

The directory name folds through the same `projectSafeName` rules the rest of the project
layer uses (`/`, `\` and NUL become `-`, `..` is folded, 60 characters max); a name that
folds to nothing gets no note. The vault-relative path is stored in
`task_projects.metadata.tracking_note`, so renaming a project keeps its note (the note is
deliberately NOT moved, and a test pins that).

Two ops: `project_tracking_get` (read) and `project_tracking_ensure` (writes the skeleton
once and records the metadata, so "one note per project" is a server rule rather than a
convention the model has to remember). An existing note with that path is ADOPTED, never
overwritten. Editing the Workstreams table requires the hash from the last read; appending
to `## Log` uses the heading anchor and needs no read, which is what lets two runs log
concurrently without a conflict.

The project detail pane renders the note with `fetchNoteContent` plus `renderNoteMarkdown`
and an "Open in Notes" link. It deliberately does not embed the notes page.

## Configuration

```yaml
triage:
  enabled: false          # opt-in
  every: 30m              # floor 5m; "0" means off, same vocabulary as heartbeat
  every_messages: 20      # wake threshold; 0 means the clock is the only trigger
  sources: [mail, slack]  # absent means both; an empty array means clock only
  mode: ask               # ask | assist
  auto_mark_read: false   # assist only, and mail only; Slack is never auto-marked
  active_hours: 08:00-22:00  # local; an empty string means 24/7

defaults:
  engine: claude          # every Walnut-initiated session inherits this
```

Every default and every clamp lives in the reader (`src/core/triage/config.ts`) rather
than in `DEFAULT_CONFIG`, because config-manager spreads a parsed `config.yaml` over its
defaults at the TOP level: a default seeded under `triage` would be dropped by any config
file that has a `triage:` section at all. The same reader holds the 5 minute floor, so a
typo'd `30s` cannot mint a session every half minute. Unknown source names are dropped
rather than failing the read.

`defaults.engine` is not triage-specific. It is the global answer to "which engine does
Walnut use when nobody said", and it is inherited by the Ask drawer's lane conversations,
the mail and Slack AI actions, routines, and triage runs. An explicit engine in a request
still wins. On an ACP engine, a Walnut-agent session gets its persona and memory through
`messagePrefix`, because ACP has no system-prompt channel.

## Limits

| Limit | Default | On breach |
|---|---|---|
| batch interval | 30m, floor 5m | clamped up, logged once |
| wake threshold | 20 items | 0 disables the counter, clock only |
| batch action timeout | 30s | the run fails before a session is minted |
| summary letters per run | 1 | server refuses, names the existing summary |
| decision letters per run | 3 | server refuses, tells the run to fold the rest into the summary |
| decision letter with no buttons | not allowed | refused with the same sentence |
| active hours | 08:00-22:00 local | the batch action declines the fire, no session |
| timed fire with zero new items | skipped | recorded as `skipped`, no executor call |

## Where the code lives

| Piece | File |
|---|---|
| Config reader, defaults, clamps, active-hours helper | `src/core/triage/config.ts` |
| Types and every constant | `src/core/triage/types.ts` |
| The one routine: create, patch, disable | `src/core/triage/bootstrap.ts` |
| What the run is told about letters and its mode | `src/core/triage/letter-rules.ts` |
| The letter budget and the withdrawal | `src/core/human-inbox/triage-quota.ts` |
| The console agent | `src/core/agent-registry.ts` |
| The skill the run loads | `src/data/skills/walnut-inbox-triage/SKILL.md` |
| Settings section | `web/src/components/settings/sections/TriageSection.tsx` |
| The wake gate (types, counter, subscription) | `src/core/cron/`, `src/core/routines/wake-events.ts` |
| A run's task and session | `src/core/routines/executors/claude-code.ts` |
| The tracking note skeleton and path rule | `src/core/tracking-note.ts`, `src/ops/work.ts` |

## Deliberately not done

- Reusing one session for X minutes. The user asked for a separate session per run first,
  precisely so the persistence layer has to exist; session reuse is an optimisation to
  make later, on top of notes that already work.
- Archiving a run's task automatically after 14 days.
- `[[task:…]]` inside the vault shows as an unresolved link. Accepted.
- Slack is never auto-marked read, in either mode.
