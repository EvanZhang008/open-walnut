/**
 * A router area session's note and status are written only by router_route / router_work.
 * Walnut's generic status question (sessions/status-question.ts) and turn summary (runTriage in
 * session-hooks/builtins.ts) never ask it, never arm a timer or a pending report for it, and never
 * rewrite its note. The model is stubbed throughout; an ordinary task is the positive control.
 * The last block is a source guard over every automatic side-question entry.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi, type MockInstance } from 'vitest'
import fs from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { seedLegacySession } from '../helpers/router-history-fixtures.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-status-isolation'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { runTriage, __resetTriageRateLimiter } from '../../src/core/session-hooks/builtins.js'
import {
  armStatusQuestion, askStatus, routerScopedStatus, statusQuestionOwns, STATUS_SETTLE_MS, __resetStatusQuestion,
} from '../../src/core/sessions/status-question.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { isReportPending } from '../../src/core/sessions/report-pending.js'
import { routerAreaProfile } from '../../src/core/router/session-policy.js'
import type { OnTurnCompletePayload } from '../../src/core/session-hooks/types.js'
import type { Task } from '../../src/core/types.js'

const ANSWER = 'EXEC_SUMMARY: Rewritten.\nRECAP: Rewritten.\nFOR_USER_STATE: needs-you\nFOR_USER_ASK: Global ask?\nFOR_USER_NOW: Generic.\nFOR_USER_NEXT: Generic.'
const NOTE = 'router_work findings: berth B12 on Friday.'
const sessions = (sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions

function fakeSession(sid: string) {
  const fake = { sessionId: sid, askSideQuestion: vi.fn(async () => ANSWER), detach: () => {}, kill: () => {}, get active() { return false } }
  sessions.set(sid, fake)
  return fake
}

type Case = { name: string; sid: string; task: Task }
const scoped: Case[] = []
let plain: Case
let selfReport: MockInstance | undefined

async function makeTask(title: string, patch: Partial<Task> = {}): Promise<Task> {
  const { task } = await addTask({ title, project: 'Garden' })
  await updateTaskRaw(task.id, { phase: 'IN_PROGRESS', note: NOTE, ...patch }, { source: 'test' })
  return getTask(task.id)
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const marked = await makeTask('Marked area task', { router_area_id: 'personal' })
  const router = await makeTask('Router node', { org_role: 'router' })
  const profiled = await makeTask('Profiled session task')
  const listed = await makeTask('Registry member task')
  const ordinary = await makeTask('Ordinary task')
  await fs.mkdir(path.join(WALNUT_HOME, 'router'), { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'router', 'areas.json'), JSON.stringify({
    version: 1, routers: [], items: [],
    areas: [{ id: 'personal', name: 'Personal', host: '__local__', taskIds: [listed.id], sources: [] }],
  }))
  // Fault injection keeps each historical area signal independent; the ordinary control uses registration.
  const add = async (name: string, sid: string, task: Task,
    opts: { legacy?: boolean; profile?: ReturnType<typeof routerAreaProfile> } = {}) => {
    const extra = { ...(opts.profile ? { profile: opts.profile } : {}), initialProcessStatus: 'running' as const }
    if (opts.legacy) await seedLegacySession(sid, task.id, 'Garden', '/tmp', extra)
    else await createSessionRecord(sid, task.id, 'Garden', '/tmp', opts.profile ? { profile: opts.profile } : undefined)
    return { name, sid, task }
  }
  scoped.push(
    await add('task marker', 'iso-marked', marked, { legacy: true }),
    await add('router role', 'iso-router', router, { legacy: true }),
    await add('session profile', 'iso-profiled', profiled, { legacy: true, profile: routerAreaProfile('personal', 'work') }),
    await add('registry membership', 'iso-listed', listed, { legacy: true }),
  )
  plain = await add('ordinary', 'iso-plain', ordinary)
})

afterAll(async () => {
  for (const c of [...scoped, plain]) sessions.delete(c.sid)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

beforeEach(() => {
  __resetStatusQuestion()
  __resetTriageRateLimiter()
  selfReport?.mockRestore()
  selfReport = vi.spyOn(sessionRunner, 'requestTurnCompleteSelfReport')
})

const payload = (c: Case) => ({
  sessionId: c.sid, taskId: c.task.id, task: c.task, session: { provider: 'claude-code', cwd: '/tmp' },
  result: 'done', totalCost: 0, duration: 1, turnIndex: 1,
}) as unknown as OnTurnCompletePayload

describe('router area status isolation', () => {
  it('recognizes every area signal and leaves an ordinary task alone', async () => {
    for (const c of scoped) expect(await routerScopedStatus(c.task.id, c.sid), c.name).toBe(true)
    expect(await routerScopedStatus(plain.task.id, plain.sid)).toBe(false)
    expect(await routerScopedStatus('no-such-task', 'no-such-session')).toBe(true)
  })

  it('armStatusQuestion owns the status, arms no timer or pending report, and asks nothing', async () => {
    const fakes = scoped.map((c) => fakeSession(c.sid))
    for (const c of scoped) {
      expect(await armStatusQuestion(c.task.id, c.sid), c.name).toBe(true)
      expect(statusQuestionOwns(c.sid), c.name).toBe(true)
      expect(isReportPending(c.sid), c.name).toBe(false)
    }
    await new Promise((r) => setTimeout(r, STATUS_SETTLE_MS + 400))
    for (const f of fakes) expect(f.askSideQuestion).not.toHaveBeenCalled()
    expect(selfReport).not.toHaveBeenCalled()
    for (const c of scoped) {
      const t = await getTask(c.task.id)
      expect(t.status_report, c.name).toBeUndefined()
      expect(t.phase, c.name).toBe('IN_PROGRESS')
    }
  }, 20_000)

  it('askStatus from the turn end, the reconcile loop and a watch asks nothing and stores nothing', async () => {
    const fakes = scoped.map((c) => fakeSession(c.sid))
    for (const c of scoped) {
      for (const why of ['turn-end', 'reconcile', 'watch'] as const) {
        expect(await askStatus(c.task.id, c.sid, Date.now(), why), `${c.name} ${why}`).toBe(false)
      }
      expect(statusQuestionOwns(c.sid), c.name).toBe(true)
      expect(isReportPending(c.sid), c.name).toBe(false)
      expect((await getTask(c.task.id)).status_report, c.name).toBeUndefined()
    }
    for (const f of fakes) expect(f.askSideQuestion).not.toHaveBeenCalled()
    expect(selfReport).not.toHaveBeenCalled()
  })

  it('runTriage never rewrites the router_work note or summary', async () => {
    const fakes = scoped.map((c) => fakeSession(c.sid))
    for (const c of scoped) {
      await runTriage(payload(c))
      await runTriage(payload(c), { final: true })
      const t = await getTask(c.task.id)
      expect(t.note, c.name).toBe(NOTE)
      expect(t.summary ?? '', c.name).toBe('')
      expect(t.status_report, c.name).toBeUndefined()
    }
    for (const f of fakes) expect(f.askSideQuestion).not.toHaveBeenCalled()
    expect(selfReport).not.toHaveBeenCalled()
  })

  it('positive control: an ordinary task is still asked', async () => {
    const fake = fakeSession(plain.sid)
    await askStatus(plain.task.id, plain.sid, Date.now())
    expect(fake.askSideQuestion).toHaveBeenCalledTimes(1)
  })

  it('a damaged registry fails closed: neither an ordinary nor a registry-only task is asked', async () => {
    const file = path.join(WALNUT_HOME, 'router', 'areas.json')
    const good = await fs.readFile(file, 'utf8')
    const listed = scoped.find((c) => c.name === 'registry membership')!
    for (const broken of ['{"version":1,"areas":"broken","routers":[],"items":[]}', '{"version":1,"areas":[{"id":']) {
      await fs.writeFile(file, broken)
      try {
        for (const c of [plain, listed]) {
          __resetStatusQuestion()
          __resetTriageRateLimiter()
          const fake = fakeSession(c.sid)
          expect(await routerScopedStatus(c.task.id, c.sid), c.name).toBe(true)
          expect(await armStatusQuestion(c.task.id, c.sid), c.name).toBe(true)
          expect(isReportPending(c.sid), c.name).toBe(false)
          expect(await askStatus(c.task.id, c.sid, Date.now()), c.name).toBe(false)
          await runTriage(payload(c), { final: true })
          expect(fake.askSideQuestion, c.name).not.toHaveBeenCalled()
        }
      } finally {
        await fs.writeFile(file, good)
      }
    }
    expect(selfReport).not.toHaveBeenCalled()
    expect(await routerScopedStatus(plain.task.id, plain.sid)).toBe(false)
  })
})

describe('source guard: every automatic side question into a session', () => {
  const ROOT = path.resolve(__dirname, '../..')
  const CALL = /\b(requestTurnCompleteSelfReport|askSideQuestion)\(/g
  const FN = /\bfunction\s+(\w+)\s*[(<]/g
  // file -> enclosing function -> 'gated' (must check routerScopedStatus first) or why it is exempt.
  const ENTRIES: Record<string, Record<string, string>> = {
    'src/core/sessions/status-question.ts': { askStatus: 'gated' },
    'src/core/session-hooks/builtins.ts': {
      runTriage: 'gated',
      titleViaSideQuestion: 'title from the person\'s own words only, no global rules or other tasks',
      titleViaAcpSelfReport: 'ACP title twin; area sessions run only on Claude Code',
    },
    'src/core/diff-summary.ts': {
      summarizeInner: 'a person asks for a file caption in the Changed view',
      triageInner: 'a person opens the Changed view',
    },
    'src/core/sessions/session-extras.ts': { askSessionSideQuestion: 'the person\'s own side question' },
  }

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.tsx?$/.test(e.name)) out.push(p)
    }
    return out
  }

  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, (m: string, a: string) => a + ' '.repeat(m.length - a.length))
  }

  function sites(file: string): Array<{ fn: string; at: number }> {
    const src = stripComments(readFileSync(path.join(ROOT, file), 'utf8'))
    const fns = [...src.matchAll(FN)].map((m) => ({ name: m[1]!, at: m.index! }))
    return [...src.matchAll(CALL)].map((m) => ({ fn: [...fns].reverse().find((f) => f.at < m.index!)?.name ?? '<top>', at: m.index! }))
  }

  function body(file: string, fn: string): string {
    const src = stripComments(readFileSync(path.join(ROOT, file), 'utf8'))
    const start = src.search(new RegExp(`\\bfunction\\s+${fn}\\s*\\(`))
    const next = src.slice(start + 1).search(/\n(export )?(async )?function\s+\w+/)
    return src.slice(start, next < 0 ? undefined : start + 1 + next)
  }

  it('lists every call site outside the providers', () => {
    const found: Record<string, string[]> = {}
    for (const abs of walk(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, abs).split(path.sep).join('/')
      if (rel.startsWith('src/providers/')) continue
      for (const s of sites(rel)) (found[rel] ??= []).push(s.fn)
    }
    for (const [file, fns] of Object.entries(found)) {
      expect(ENTRIES[file], `${file} asks a session automatically; gate it with routerScopedStatus or list why not`).toBeDefined()
      for (const fn of fns) expect(ENTRIES[file]![fn], `${file} ${fn}`).toBeDefined()
    }
  })

  it('gated entries check the area before any model call', () => {
    for (const [file, fns] of Object.entries(ENTRIES)) {
      for (const [fn, why] of Object.entries(fns)) {
        if (why !== 'gated') continue
        const b = body(file, fn)
        const gate = b.indexOf('routerScopedStatus(')
        expect(gate, `${file} ${fn}`).toBeGreaterThan(0)
        expect(gate, `${file} ${fn}`).toBeLessThan(b.search(CALL))
      }
    }
    const runTriage = body('src/core/session-hooks/builtins.ts', 'runTriage')
    expect(runTriage.indexOf('routerScopedStatus(')).toBeLessThan(runTriage.indexOf('triageLastDispatch.get('))
    const arm = body('src/core/sessions/status-question.ts', 'armStatusQuestion')
    expect(arm.indexOf('routerScopedStatus(')).toBeGreaterThan(0)
    expect(arm.indexOf('routerScopedStatus(')).toBeLessThan(arm.indexOf('setTimeout('))
  })
})
