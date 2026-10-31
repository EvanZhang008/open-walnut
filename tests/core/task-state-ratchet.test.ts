/**
 * Ratchets for the one task status (2026-10-30, the user: "fix the real root cause, the foundation";
 * four fixes in a day were readers that decided "needs you", "waiting" or "snoozed" on their own).
 *
 * 1. Every reminder path asks the snooze. A server file that reads what a task asks of the user
 *    (`user_status`, or the NEED_ACTION phase) and reaches someone on its own (a message into a
 *    session, a letter, a notification) must consult the snooze (src/core/snooze.ts, or the
 *    `snoozed` mark of the derived status), or be listed below with why it is not a reminder.
 * 2. No new reader decides the state from the phase. A file that compares a task's phase with
 *    NEED_ACTION or WAITING is listed with its count; a new one fails. A reader of what the user is
 *    asked reads `user_status` (server), `taskUserState` / `taskNeedsAction` (web), TeamStatusModel
 *    (iOS). Phase writes, phase pickers and agent-facing phase edges are the listed ones.
 * 3. One set of names (the user: "what is needs you, what is working, what is snooze waiting ...
 *    and completed"). No string a person reads uses an old state word ("need you", "needs me",
 *    "handed back to you", "Stuck"), and no file keeps its own map of the four states' names: it
 *    imports USER_STATE_LABELS. The two copies that cannot import it (the Board frame, iOS) must
 *    equal it.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { USER_STATE_LABELS } from '../../src/core/user-status.js'

const ROOT = path.resolve(__dirname, '../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) } else if (/\.(?:tsx?|m?js)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}
const rel = (f: string) => path.relative(ROOT, f)
const code = (text: string) => text.split('\n').filter((l) => !/^\s*(?:\*|\/\/|\/\*)/.test(l)).join('\n')

// ── 1. Reminder paths ──

const READS_ASK = /user_status|'NEED_ACTION'/
const REACHES = /\b(?:sendMessageToSession|deliverToSession|holdNotice|sendLetter|sendLetterOnce|addNotification)\(/
const ASKS_SNOOZE = /snoozedUntil|snoozeEndedMs|readSnoozedUntil|\.snoozed\b/

/** Reaches someone and reads the state, but is no reminder of what the user is asked. */
const NOT_REMINDERS: Record<string, string> = {
  'src/core/sessions/machine-wake.ts': 'resumes work a machine stop interrupted; it reminds no one of an ask',
  'src/core/org/lead-waits.ts': 'wakes a lead for its worker: team work, not a reminder to the user, so a snooze does not stop it',
  'src/core/routines/run-start-deps.ts': 'a routine start failure writes NEED_ACTION; the derived status applies the snooze',
}

describe('every reminder path asks the snooze', () => {
  const paths = walk(path.join(ROOT, 'src')).filter((f) => {
    const src = code(fs.readFileSync(f, 'utf8'))
    return READS_ASK.test(src) && REACHES.test(src)
  }).map(rel)

  it('finds the known reminder paths (the scan still sees them)', () => {
    for (const f of ['src/core/sessions/needs-recheck.ts', 'src/core/sessions/letter-recheck.ts', 'src/core/task-wait-until.ts', 'src/core/org/lead-waits.ts']) {
      expect(paths, f).toContain(f)
    }
  })

  it('each one consults the snooze or is listed as no reminder', () => {
    // Asked in code, not in a comment that names the snooze.
    const ignoring = paths.filter((f) => !NOT_REMINDERS[f] && !ASKS_SNOOZE.test(code(fs.readFileSync(path.join(ROOT, f), 'utf8'))))
    expect(ignoring, `A path reminds about a task without asking the snooze (src/core/snooze.ts): ${ignoring.join(', ')}`).toEqual([])
  })

  it('the paths that do not hold the state still ask: the status push, the letter gate, the org digest, the Brief', () => {
    expect(fs.readFileSync(path.join(ROOT, 'src/core/sessions/status-push.ts'), 'utf8')).toMatch(/c\.to\.snoozed \? \[parent\]/)
    expect(fs.readFileSync(path.join(ROOT, 'src/core/human-inbox/letter-ops.ts'), 'utf8')).toMatch(/admitSnoozedLetter\(/)
    // Main's org digest raises a failed session from its record, not from the status: it skips a snoozed one.
    expect(fs.readFileSync(path.join(ROOT, 'src/core/org/org-store.ts'), 'utf8')).toMatch(/task\.user_status\?\.snoozed/)
    // The Brief lists a snoozed task under Waiting / snoozed with its date, never as an ask.
    expect(fs.readFileSync(path.join(ROOT, 'src/core/sessions/brief.ts'), 'utf8')).toMatch(/snoozed\?\.until\) words = `snoozed until/)
  })

  it('a listed exemption still exists', () => {
    for (const f of Object.keys(NOT_REMINDERS)) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true)
  })
})

// ── 2. Readers of the state ──

const PHASE_READ = /phase\s*[!=]==\s*['"](?:NEED_ACTION|WAITING)['"]|['"](?:NEED_ACTION|WAITING)['"]\s*[!=]==\s*[\w.?]*phase\b/g

/**
 * Files that compare a phase with NEED_ACTION or WAITING, with how many times. Each is a phase
 * write, a phase picker or label, an agent-facing phase edge, a park rule, or the one fallback
 * for a task with no derived status. Lower a count when you move a reader to the one status.
 */
const PHASE_READERS: Record<string, number> = {
  'src/core/boards/board-lanes.ts': 2,
  'src/core/human-inbox/item-status.ts': 2,
  'src/core/offline-merge/apply-fields.ts': 1,
  'src/core/offline-merge/patch-check.ts': 1,
  'src/core/org/org-store.ts': 1,
  'src/core/peers/envelope-kit.ts': 1,
  'src/core/phase.ts': 4,
  'src/core/routines/trigger-api.ts': 2,
  'src/core/session-health-monitor.ts': 1,
  'src/core/session-hooks/builtins.ts': 2,
  'src/core/sessions/letter-recheck.ts': 1,
  'src/core/sessions/machine-wake.ts': 2,
  'src/core/sessions/outside-wait.ts': 4,
  'src/core/sessions/promise-alarm.ts': 1,
  'src/core/sessions/report-phase.ts': 3,
  'src/core/sessions/restart-loss.ts': 2,
  'src/core/sessions/session-request-notify.ts': 1,
  'src/core/sessions/team-stop.ts': 3,
  'src/core/sessions/unanswered-at-stop.ts': 1,
  'src/core/status-consistency.ts': 2,
  'src/core/task-manager.ts': 7,
  'src/core/task-outbox.ts': 1,
  'src/core/task-projection.ts': 1,
  'src/core/task-wait-resume.ts': 1,
  'src/core/task-wait-until.ts': 4,
  'src/core/user-status.ts': 4,
  'src/ops/tasks.ts': 2,
  'src/providers/daemon-source.ts': 1,
  'src/web/routes/api-v1.ts': 5,
  'src/web/routes/tasks.ts': 1,
  'web/src/components/board/board-overview-model.ts': 3,
  'web/src/components/board/kanban/kanban-card-model.ts': 5,
  'web/src/components/common/Icons.tsx': 1,
  'web/src/components/org/org-answered.ts': 1,
  'web/src/components/org/org-channels-model.ts': 1,
  'web/src/components/sessions/SessionPanel.tsx': 1,
  'web/src/components/sessions/TaskQuickActions.tsx': 2,
  'web/src/components/tasks/AgentSearchResultRows.tsx': 1,
  'web/src/components/tasks/FocusSatelliteCards.tsx': 1,
  'web/src/components/tasks/footer-scope.ts': 1,
  'web/src/components/tasks/status-sections.ts': 3,
  'web/src/components/tasks/StatusSections.tsx': 3,
  'web/src/components/tasks/TaskDetailPane.tsx': 1,
  'web/src/components/tasks/TaskStatusControl.tsx': 8,
  'web/src/components/tasks/TodoFilterFooter.tsx': 1,
  'web/src/components/tasks/TodoPanel.tsx': 9,
  'web/src/hooks/useTasks.ts': 2,
  'web/src/utils/session-status.ts': 2,
}

describe('no new reader decides the state from the phase', () => {
  const found = new Map<string, number>()
  for (const dir of ['src', 'web/src']) {
    for (const f of walk(path.join(ROOT, dir))) {
      const n = (code(fs.readFileSync(f, 'utf8')).match(PHASE_READ) ?? []).length
      if (n) found.set(rel(f), n)
    }
  }

  it('no file reads the phase as a state beyond the listed ones', () => {
    const grown = [...found].filter(([f, n]) => n > (PHASE_READERS[f] ?? 0)).map(([f, n]) => `${f} (${n}, listed ${PHASE_READERS[f] ?? 0})`)
    expect(grown, 'A reader decides needs/waiting from the phase. Read user_status (server), taskUserState / taskNeedsAction '
      + `(web/src/utils/session-status.ts) instead; if this is a phase write or picker, list it here: ${grown.join(', ')}`).toEqual([])
  })

  it('a listed count that went down is lowered here (the ratchet only turns one way)', () => {
    const shrunk = Object.entries(PHASE_READERS).filter(([f, n]) => (found.get(f) ?? 0) < n).map(([f, n]) => `${f} (${found.get(f) ?? 0}, listed ${n})`)
    expect(shrunk).toEqual([])
  })
})

// ── 3. One set of names ──

/** An old state word inside a string literal (quotes, backticks or a Swift string). */
const OLD_WORD = /(['"`])[^'"`\n]*(?:(?:\d|\}|\))\s*need you|\bneeds me|\b[Hh]anded back to you|Needs you: handed back)\b[^'"`\n]*\1|(['"`])(?:Stuck|needs? you)\2|(['"`])Stuck\. /
/** A count of tasks in the old words: `${n} ${n === 1 ? 'needs' : 'need'} you` (a noun between, "2 cards need you", is a sentence). */
const OLD_COUNT = /\$?\{[\w.]+\}\s*\$?\{[^{}]*'needs'\s*:\s*'need'\}\s*you/
/** A file that writes its own map of the four states' names. */
const OWN_MAP = /\bneeds:\s*['"]Needs you['"]/

/** Strings that use one of the words for something other than a task's state. */
const OLD_WORD_OK: Record<string, string> = {
  'src/integrations/mail/digest.ts': 'counts mail messages that need the user, not tasks',
  'web/src/components/sessions/TriggerPickerPopover.tsx': 'an example prompt the user may type, not a state',
  'src/core/user-status.ts': 'its doc names the retired words',
}
const OWN_MAP_OK: Record<string, string> = {
  'src/core/user-status.ts': 'the names themselves',
  'web/src/components/board/board-elements.frame.js': 'runs in the Board iframe and cannot import; checked equal below',
  'src/host-server/alone-page.ts': 'inline page script of a host serving alone; it names session states (idle, stopped), not task states',
}

function walkAll(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walkAll(p, out) } else if (/\.(?:tsx?|m?js|swift)$/.test(e.name) && !/(?:\.test\.tsx?|Tests\.swift)$/.test(e.name)) out.push(p)
  }
  return out
}

describe('one set of state names', () => {
  const files = ['src', 'web/src', 'ios-native/Walnut'].flatMap((d) => walkAll(path.join(ROOT, d)))

  it('no string a person reads uses an old state word', () => {
    const hits = files.filter((f) => !OLD_WORD_OK[rel(f)] && (OLD_WORD.test(code(fs.readFileSync(f, 'utf8'))) || OLD_COUNT.test(code(fs.readFileSync(f, 'utf8'))))).map(rel)
    expect(hits, 'Use the names in USER_STATE_LABELS (src/core/user-status.ts): Needs you, Working, Waiting / snoozed, '
      + `Completed; stateCountLabel for a count. Or list the file with why the word is not a task state: ${hits.join(', ')}`).toEqual([])
  })

  it('no file keeps its own map of the state names', () => {
    const hits = files.filter((f) => !OWN_MAP_OK[rel(f)] && OWN_MAP.test(code(fs.readFileSync(f, 'utf8')))).map(rel)
    expect(hits, `Import USER_STATE_LABELS instead: ${hits.join(', ')}`).toEqual([])
  })

  it('the copies that cannot import the names equal them', () => {
    const frame = fs.readFileSync(path.join(ROOT, 'web/src/components/board/board-elements.frame.js'), 'utf8')
    const ios = fs.readFileSync(path.join(ROOT, 'ios-native/Walnut/Views/Tasks/TeamStatusModel.swift'), 'utf8')
    for (const [state, label] of Object.entries(USER_STATE_LABELS)) {
      expect(frame, `frame USER.${state}`).toContain(`${state}: '${label}'`)
      expect(ios, `iOS .${state}`).toContain(`case .${state}: return "${label}"`)
    }
  })

  it('a listed exception still uses the word (the list only shrinks)', () => {
    const stale = Object.keys(OLD_WORD_OK).filter((f) => !fs.existsSync(path.join(ROOT, f)) || !OLD_WORD.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
    expect(stale).toEqual([])
  })
})

// ── 4. One writer of the stored state, behind the snooze ──

/** A literal state other than Done written into a task's stored status. */
const WRITES_STATE = /user_status\s*[:=]\s*\{\s*state:\s*(?!\s)(?!'done')/
const STATE_WRITERS_OK: Record<string, string> = {
  'src/core/org/team-note.ts': 'a stand-in for a task never derived, in the lead\'s note only: working or waiting, never needs',
}

describe('the stored state has one writer, and it applies the snooze', () => {
  it('only the sync writes a state other than Done (user-status-sync.ts stores deriveUserStatus)', () => {
    const hits = walk(path.join(ROOT, 'src')).filter((f) => !STATE_WRITERS_OK[rel(f)] && WRITES_STATE.test(code(fs.readFileSync(f, 'utf8')))).map(rel)
    expect(hits, `A file writes user_status itself; store deriveUserStatus through user-status-sync.ts instead: ${hits.join(', ')}`).toEqual([])
    const sync = fs.readFileSync(path.join(ROOT, 'src/core/user-status-sync.ts'), 'utf8')
    expect(sync).toMatch(/const next = deriveUserStatus\(input, nowMs\)/)
    expect(sync).toMatch(/snoozedUntil: snoozedUntil\(task, facts\.tasksById, nowMs\)/)
  })

  it('every derived state passes the snooze: deriveUserStatus has one exit, through snoozeOf', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/user-status.ts'), 'utf8')
    const body = src.slice(src.indexOf('export function deriveUserStatus('), src.indexOf('\n}\n', src.indexOf('export function deriveUserStatus(')))
    expect(body).toMatch(/const derived = derive\(input, nowMs\);\s*const out = snoozeOf\(input, derived, nowMs\) \?\? derived;/)
    expect(body.match(/\breturn\b/g)).toHaveLength(1)
  })
})
