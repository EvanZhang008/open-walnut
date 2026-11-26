/**
 * The process manager (the session daemon runtime: daemon-standalone.ts and what it loads) holds no
 * task logic of its own; what it still holds is listed here and the list only gets shorter
 * (docs/plan/one-service-every-host.md, phase 4: "no task logic outside the service").
 *
 * Task logic is what decides about the user's work: the daemon's own answers for an away leader
 * (its read copy, journal, search and board), and trigger judging (a check's verdict, a clock's
 * schedule, which session takes a fire). The host's own Walnut service (src/replica/) does all of it
 * with the real code; the daemon keeps its copy only for a host with no service, until the last step
 * of phase 4 deletes it.
 *
 * Holds:
 *   1. every module of src/core/ the runtime loads is named below, as task logic still left or as a
 *      plain helper the process needs (transcript parsing, text, prices), so a new one is a choice;
 *   2. every entry of TASK_LOGIC_LEFT is still loaded (an entry whose module left is deleted here);
 *   3. TASK_LOGIC_LEFT never grows past its count;
 *   4. only the modules named in TASK_LOGIC_CALLERS load task logic, so it does not spread into the
 *      process code.
 */
import { describe, expect, it } from 'vitest'
import { walkDaemonImports } from '../helpers/daemon-import-graph.js'

const LAST_STEP = 'goes with the daemon\'s own answers, in the last step of phase 4'
const TRIGGERS = 'trigger judging, moves into the service in the last step of phase 4'

/** Task logic the runtime still loads, and what takes it out. Only ever delete from this list. */
const TASK_LOGIC_LEFT: Record<string, string> = {
  'src/providers/offline-host-core.ts': LAST_STEP,
  'src/providers/offline-journal-core.ts': LAST_STEP,
  'src/providers/host-journal-core.ts': LAST_STEP,
  'src/providers/offline-search-core.ts': LAST_STEP,
  'src/providers/offline-board-core.ts': LAST_STEP,
  'src/providers/host-replica-core.ts': LAST_STEP,
  'src/core/human-inbox/letter-check.ts': LAST_STEP,
  'src/core/peers/envelope-kit.ts': LAST_STEP,
  'src/providers/trigger-check-core.ts': TRIGGERS,
  'src/providers/trigger-clock-core.ts': TRIGGERS,
  'src/providers/trigger-envelope-core.ts': TRIGGERS,
  'src/providers/trigger-state-seed-core.ts': TRIGGERS,
  'src/providers/trigger-state-snapshot-core.ts': TRIGGERS,
  'src/providers/clock-schedule-core.ts': TRIGGERS,
  'src/providers/clock-host-start-core.ts': TRIGGERS,
  'src/core/routines/host-trigger-target.ts': TRIGGERS,
  'src/core/routines/trigger-watches.ts': TRIGGERS,
  'src/core/routines/trigger-label.ts': TRIGGERS,
  'src/core/cron/trigger-timing.ts': TRIGGERS,
}
/** The count on 2026-11-24. Lower it when an entry goes; never raise it. */
const TASK_LOGIC_MAX = 19

/** Modules of src/core/ the runtime loads that are no task logic: pure helpers of the process itself. */
const CORE_HELPERS = new Set([
  // The locked-note format (a stub and an envelope, parsing only): the replica and the offline host copy answer its stub.
  'src/core/notes/locked-note.ts',
  'src/core/notes/locked-note-format.ts',
  'src/core/bash-file-ops.ts',
  // The places macOS guards (a path test, node:path only): the daemon never opens one on its loop.
  'src/core/hosts/mac-places.ts',
  'src/core/drained-sends.ts',
  'src/core/hints/hint-format.ts',
  'src/core/history-parse.ts',
  // Reads which tasks a chat message names, for the transcript parser.
  'src/core/org/message-about.ts',
  'src/core/history-parser-version.ts',
  'src/core/session-effort.ts',
  'src/core/sessions/cli-error-reply.ts',
  'src/core/sessions/legacy-hint-lines.ts',
  'src/core/sessions/open-items-text.ts',
  'src/core/sessions/prompt-cache.ts',
  'src/core/sessions/send-rules.ts',
  'src/core/sessions/side-thread-digest.ts',
  'src/core/sessions/side-thread-warmup.ts',
  'src/core/sessions/user-text-projection.ts',
  'src/core/sessions/walnut-commands.ts',
  'src/core/stream/compaction-notice.ts',
  'src/core/stream/hook-notice.ts',
  'src/core/text-cut.ts',
  'src/core/transcript-chain-leaf.ts',
  'src/core/transcript-chain-prefilter.ts',
  'src/core/transcript-chain.ts',
  'src/core/usage/price-data.ts',
  'src/core/usage/price-resolve.ts',
  'src/core/usage/pricing.ts',
  'src/core/usage/session-cost-pricing.ts',
])

/** The process modules allowed to load task logic (the runtime wires it in; task logic loads its own parts). */
const TASK_LOGIC_CALLERS = new Set([
  // The trigger area (daemon-trigger-*.ts) takes its trigger logic from the runtime as one dep
  // (daemon-module-deps.ts HostTriggerJudge), so it is no caller.
  'src/providers/daemon-standalone.ts',
])

describe('the process manager holds no task logic of its own', () => {
  const graph = walkDaemonImports()

  it('resolves every relative import of the runtime', () => {
    expect(graph.unresolved).toEqual([])
  })

  it('names every module of src/core/ it loads, as task logic left or as a helper', () => {
    const unnamed = [...graph.files].filter((f) => f.startsWith('src/core/') && !(f in TASK_LOGIC_LEFT) && !CORE_HELPERS.has(f))
    // A new one: task logic belongs in the service (src/replica/, core/), never in the daemon; a
    // plain helper (parsing, text) goes in CORE_HELPERS.
    expect(unnamed.sort()).toEqual([])
  })

  it('still loads every entry of TASK_LOGIC_LEFT and CORE_HELPERS (delete one that left)', () => {
    const gone = [...Object.keys(TASK_LOGIC_LEFT), ...CORE_HELPERS, ...TASK_LOGIC_CALLERS].filter((f) => !graph.files.has(f))
    expect(gone).toEqual([])
  })

  it('never holds more task logic than it did', () => {
    expect(Object.keys(TASK_LOGIC_LEFT).length).toBeLessThanOrEqual(TASK_LOGIC_MAX)
  })

  it('loads task logic only from the runtime and from task logic itself', () => {
    const spread: string[] = []
    for (const [file, imports] of graph.imports) {
      if (file in TASK_LOGIC_LEFT || TASK_LOGIC_CALLERS.has(file)) continue
      for (const target of imports) if (target in TASK_LOGIC_LEFT) spread.push(`${file} -> ${target}`)
    }
    expect(spread.sort()).toEqual([])
  })
})
