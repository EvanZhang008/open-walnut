/**
 * Class guard: every source a message into a session can carry is on one side of a plugin program
 * run's adoption (phase.ts inputAdoptsPluginRun, types.ts PLUGIN_RUN_TAG). A person's or another
 * task's message makes the run a regular task; the program's own send and everything Walnut sends by
 * itself (notices, the restart, retry and recovery kicks, a compaction, a trigger's or a routine's
 * delivery) do not. The sources are enumerated from the code: every `source:` of a call that puts a
 * line into a session (tests/helpers/send-call-sites.ts), of a SESSION_SEND emit and of a send-now,
 * and every positional source of an applySessionPhase(..., 'session:input', ...). A source found
 * there and missing from SIDE fails until someone writes down which side it is on.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SRC, callSites, walk } from '../helpers/send-call-sites.js'
import { inputAdoptsPluginRun, PROGRAM_RUN_SEND_SOURCE, REOPENING_SEND_SOURCES } from '../../src/core/phase.js'

type Side = 'adopts' | 'not'

/** Written out here, never read from the code under test. */
const SIDE: Record<string, Side> = {
  // A person typed it (the console, the phone, the terminal, a chat surface, a letter's answer, a button).
  ui: 'adopts', mobile: 'adopts', cli: 'adopts', 'web-api': 'adopts', 'api-v1': 'adopts', chat: 'adopts', 'human-inbox': 'adopts',
  // Another task: its task_send ('peer'; an outside caller's plain send rides it too), a task calling a
  // person's route, and a host's delivery of a peer's message replayed after the Mac was away.
  peer: 'adopts', 'api-agent': 'adopts', 'offline-handover': 'adopts',
  // The program's own message into its run.
  [PROGRAM_RUN_SEND_SOURCE]: 'not',
  // Walnut by itself: notices, kicks that re-deliver a row whose own send already counted, recovery,
  // compaction, waits and triggers, routines, the router's reopen, a start's first line.
  'walnut-notify': 'not', 'auto-recover': 'not', 'auto-continue': 'not', restart: 'not', retry: 'not', 'web-ui-retry': 'not',
  'cold-hold': 'not', 'delivery-retry': 'not', 'lane-redeliver': 'not', 'folder-moved': 'not', 'engine-switch': 'not', 'agent-ready': 'not',
  'session-runner': 'not', 'idle-compact': 'not', 'context-compact': 'not', 'context-recovery': 'not', 'safeguard-switch': 'not', 'usage-limit-wait': 'not', 'cloud-fallback': 'not',
  'wait-until': 'not', 'trigger-host-delivery': 'not', 'routine-trigger': 'not', 'routine-watcher': 'not',
  'router-delivery': 'not', 'router-runtime': 'not', 'start-queue': 'not', 'task-description': 'not', 'session-start': 'not',
  'brief-refresh': 'not', 'choice-recheck': 'not', 'thread-recheck': 'not', 'title-topic': 'not', topic: 'not',
  'app-state': 'not', subagent: 'not', 'subagent-runner': 'not', transfer: 'not', 'notification-fix': 'not', 'health-alarm': 'not',
  'background-work-ended': 'not', 'pr-watch': 'not', 'change-watch': 'not', 'machine-recovered': 'not', 'org-reflection': 'not',
  'org-autostart': 'not', 'browser-automation': 'not', 'side-thread-digest': 'not', workspace: 'not',
  // A person's words that never reach the run's own session as a send (a side question goes to its
  // fork; a start's first line is no session:input), so they cannot adopt it there.
  'side-thread': 'not', 'quick-start': 'not',
  // Not send sources: a sentBy value, a log label or a fallback name found inside a send call.
  agent: 'not', human: 'not', person: 'not', unknown: 'not', 'web-ui': 'not', 'session.ts:handleSend': 'not', 'session.ts:handleSendSdk': 'not',
  // The leader's label for the task side of a send its host ran (leader-tasks.ts); the send's own
  // source rides `sendSource`, which is what adoption reads, as for handleSend's label.
  'host-judged:send': 'not',
}

/** `const NAME = '...'` constants of src whose name says SOURCE, so a send naming one is read too. */
function sourceConstants(files: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bconst ([A-Z_]*SOURCE[A-Z_]*) = '([^']+)'/g)) out.set(m[1], m[2])
  }
  return out
}

function foundSources(): Map<string, string[]> {
  const files = walk(SRC)
  const consts = sourceConstants(files)
  const found = new Map<string, string[]>()
  const note = (source: string, where: string) => found.set(source, [...(found.get(source) ?? []), where])
  // The literals and named constants in an expression that gives a source (`a ? 'x' : 'y'`, `r.source ?? 'z'`).
  const read = (expr: string, where: string) => {
    for (const m of expr.matchAll(/'([^']+)'/g)) note(m[1], where)
    for (const m of expr.matchAll(/\b([A-Z_]*SOURCE[A-Z_]*)\b/g)) if (consts.has(m[1])) note(consts.get(m[1])!, where)
  }
  for (const s of callSites()) for (const x of s.sources) if (!x.startsWith('<') && !x.includes('${')) note(x, `${s.file}:${s.line}`)
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const rel = path.relative(ROOT, f)
    for (const m of text.matchAll(/\b(?:sendMessageToSession|deliverToSession|continueTaskConversation|performSessionSend|sendQueuedNow|startSessionForTask)\(|EventNames\.SESSION_SEND,/g)) {
      for (const s of [...text.slice(m.index!, m.index! + 900).matchAll(/\bsource:\s*([^,}\n]+)/g)].slice(0, 3)) read(s[1], rel)
    }
    for (const m of text.matchAll(/applySessionPhase\([^,()]+,\s*'session:input',\s*([^,)]+)/g)) read(m[1], rel)
  }
  // The bus sources session-send-core.ts computes for a send (a person's own CLI, a caller's, the program's).
  for (const s of ['cli', 'peer', PROGRAM_RUN_SEND_SOURCE]) note(s, 'src/core/sessions/session-send-core.ts')
  return found
}

describe('every source of a message into a session is on one side of a program run\'s adoption', () => {
  const found = foundSources()

  it('every source found in the code is classified', () => {
    const missing = [...found.keys()].filter((s) => !(s in SIDE)).map((s) => `${s} (${found.get(s)!.slice(0, 2).join(', ')})`)
    expect(missing, 'a source this guard does not know: add it to SIDE with its side').toEqual([])
    // The scan still finds the ones that matter.
    expect([...found.keys()]).toEqual(expect.arrayContaining(['ui', 'mobile', 'peer', 'walnut-notify', 'restart', 'retry', 'auto-recover', 'offline-handover', 'trigger-host-delivery', 'router-delivery', 'program-run']))
  })

  it.each(Object.entries(SIDE))('"%s" is on the side the table says', (source, side) => {
    expect(inputAdoptsPluginRun(source)).toBe(side === 'adopts')
  })

  it('every reopening source is in the table, and only the program\'s own send among them does not adopt', () => {
    for (const s of REOPENING_SEND_SOURCES) expect(SIDE[s], s).toBe(s === PROGRAM_RUN_SEND_SOURCE ? 'not' : 'adopts')
    expect(inputAdoptsPluginRun(undefined)).toBe(false)
    expect(inputAdoptsPluginRun('something-new')).toBe(false)
  })
})
