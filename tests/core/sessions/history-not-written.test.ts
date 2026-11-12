/**
 * A session with no transcript yet reads as no conversation, never "History unavailable"
 * (src/core/sessions/history-not-written.ts; 2026-11-11: the Personal router, started idle by the
 * org, waited for its first mail and its page read "History unavailable: Session history file not
 * found" for hours). The last block is the class guard: every place that answers
 * `historyUnavailable` asks the one predicate first.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const tasks = new Map<string, { org_role?: string }>()
vi.mock('../../../src/core/task-manager.js', () => ({
  getTask: async (id: string) => {
    const t = tasks.get(id)
    if (!t) throw new Error(`Task ${id} not found`)
    return { id, ...t }
  },
}))

// The host's answer for the transcript's own path: null = proven absent, undefined = cannot tell.
let ownPath: string | null | undefined = null
const ownCalls: string[] = []
vi.mock('../../../src/core/daemon-file-reader.js', () => ({
  DaemonFileReader: class {
    constructor(readonly host: string) {}
    async ownSessionPath(sid: string, cwd: string) { ownCalls.push(`${this.host}|${sid}|${cwd}`); return ownPath }
  },
}))

const { historyNotWrittenYet, transcriptNotWrittenYet } = await import('../../../src/core/sessions/history-not-written.js')
import type { SessionRecord } from '../../../src/core/types.js'

const NOW = Date.parse('2026-11-11T12:00:00.000Z')
const HOURS_AGO = new Date(NOW - 6 * 3600_000).toISOString()
const record = (extra: Partial<SessionRecord> = {}): SessionRecord => ({
  claudeSessionId: 's1', taskId: 't-plain', project: '', process_status: 'idle', mode: 'default',
  last_status_change: HOURS_AGO, startedAt: HOURS_AGO, lastActiveAt: HOURS_AGO, messageCount: 1, ...extra,
} as SessionRecord)

beforeEach(() => {
  ownPath = null
  ownCalls.length = 0
  tasks.clear()
  tasks.set('t-plain', {})
  tasks.set('t-router', { org_role: 'router' })
})

describe('a missing transcript that is the normal state', () => {
  it('a session started with no message reads as no conversation, idle or reaped', async () => {
    for (const process_status of ['idle', 'running', 'stopped'] as const) {
      expect(await historyNotWrittenYet(record({ startedIdle: true, process_status }), NOW), process_status).toBe(true)
    }
  })

  it('a router session reads as no conversation even without the flag (started before it existed)', async () => {
    expect(await historyNotWrittenYet(record({ taskId: 't-router' }), NOW)).toBe(true)
    expect(await historyNotWrittenYet(record({ taskId: 't-router', process_status: 'stopped' }), NOW)).toBe(true)
  })

  it('still shows the fault for a failed session, and for an ordinary one past its startup window', async () => {
    expect(await historyNotWrittenYet(record({ startedIdle: true, process_status: 'error' }), NOW)).toBe(false)
    expect(await historyNotWrittenYet(record({ taskId: 't-router', process_status: 'error' }), NOW)).toBe(false)
    expect(await historyNotWrittenYet(record(), NOW)).toBe(false)
    expect(await historyNotWrittenYet(record({ taskId: 'gone' }), NOW)).toBe(false)
    // Another host may be unreachable: its own answer stays.
    expect(await historyNotWrittenYet(record({ startedIdle: true, host: 'devbox' }), NOW)).toBe(false)
    expect(await historyNotWrittenYet(record({ startedIdle: true, host: '__local__' }), NOW)).toBe(true)
  })

  it('keeps the launch grace: a session seconds old is still booting', async () => {
    const fresh = new Date(NOW - 2_000).toISOString()
    expect(await historyNotWrittenYet(record({ startedAt: fresh, last_status_change: fresh }), NOW)).toBe(true)
  })
})

describe('a history read answers no conversation at once when the own path proves it', () => {
  const routerRec = (extra: Partial<SessionRecord> = {}) => record({ taskId: 't-router', cwd: '/work/tasks/router-1', ...extra })
  it('a router with no turn and no file at its own path: no read needed', async () => {
    expect(await transcriptNotWrittenYet(routerRec(), NOW)).toBe(true)
    expect(ownCalls).toEqual(['__local__|s1|/work/tasks/router-1'])
  })

  it('reads as usual when the file is there, cannot be told, or the session ever had a turn', async () => {
    ownPath = '/home/x/.claude/projects/-work-tasks-router-1/s1.jsonl'
    expect(await transcriptNotWrittenYet(routerRec(), NOW)).toBe(false)
    ownPath = undefined
    expect(await transcriptNotWrittenYet(routerRec(), NOW)).toBe(false)
    ownPath = null
    expect(await transcriptNotWrittenYet(routerRec({ firstTurnAt: HOURS_AGO }), NOW)).toBe(false)
    expect(await transcriptNotWrittenYet(routerRec({ promptCache: { requestAt: HOURS_AGO } } as Partial<SessionRecord>), NOW)).toBe(false)
    expect(await transcriptNotWrittenYet(routerRec({ forkedFromSessionId: 's0' }), NOW)).toBe(false)
    expect(await transcriptNotWrittenYet(routerRec({ cwd: undefined }), NOW)).toBe(false)
  })

  it('never for an ordinary session, a failed one, or one on another host', async () => {
    expect(await transcriptNotWrittenYet(record({ cwd: '/work/a' }), NOW)).toBe(false)
    expect(await transcriptNotWrittenYet(routerRec({ process_status: 'error' }), NOW)).toBe(false)
    expect(await transcriptNotWrittenYet(routerRec({ host: 'devbox' }), NOW)).toBe(false)
    // A session in its launch seconds reads as usual: its transcript may land under another folder any moment.
    const fresh = new Date(NOW - 2_000).toISOString()
    expect(await transcriptNotWrittenYet(record({ cwd: '/work/a', startedAt: fresh, last_status_change: fresh }), NOW)).toBe(false)
    expect(ownCalls).toEqual([])
  })
})

// The source, read once for both guards below.
const ROOT = path.resolve(import.meta.dirname, '../../..')
let sourceCache: Array<{ file: string; lines: string[] }> | undefined
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [])
const sources = () => (sourceCache ??= walk(path.join(ROOT, 'src')).map((file) => ({ file, lines: fs.readFileSync(file, 'utf8').split('\n') })))

describe('every "History unavailable" answer asks historyNotWrittenYet first', () => {
  it('finds each site and the predicate within the lines before it', () => {
    const sites: string[] = []
    for (const { file, lines } of sources()) {
      lines.forEach((line, i) => {
        if (!/historyUnavailable:\s*(reason|unavailableHistoryReason)\b/.test(line)) return
        const rel = `${path.relative(ROOT, file)}:${i + 1}`
        sites.push(rel)
        const before = lines.slice(Math.max(0, i - 14), i).join('\n')
        expect(before, `${rel} answers historyUnavailable without asking historyNotWrittenYet`).toMatch(/historyNotWrittenYet\(/)
      })
    }
    // The four known sites: the web history route (two) and the core history reads (two).
    expect(sites.length).toBeGreaterThanOrEqual(4)
  }, 180_000)
})

describe('every transcript find walks one level under a projects root', () => {
  it('names TRANSCRIPT_FIND_DEPTH, never a deeper literal (each session folder held thousands of reads)', () => {
    const sites: string[] = []
    for (const { file, lines } of sources()) {
      lines.forEach((line, i) => {
        // send('fs.find', ...) or the move client's sendOn(conn, host, 'fs.find', ...)
        if (!/\bsend(?:On)?\((?:[^,()]*,\s*){0,2}'fs\.find'/.test(line)) return
        const call = lines.slice(i, i + 5).join('\n')
        if (!/\.jsonl'/.test(call)) return
        const rel = `${path.relative(ROOT, file)}:${i + 1}`
        sites.push(rel)
        expect(call, `${rel} finds a transcript with its own depth`).toMatch(/maxDepth:\s*TRANSCRIPT_FIND_DEPTH/)
      })
    }
    // The transcript reader, its probe, and the task move's lookup.
    expect(sites.length).toBeGreaterThanOrEqual(3)
  }, 180_000)
})
