/**
 * Router area session entry points: every way a conversation can start refuses an area task
 * before it touches anything, and no new start or resume path can skip the shared gates.
 *
 *   1. quickStartSession(existingTaskId = an area task) is refused after the host gate, before
 *      any task or session-record write and any SESSION_START event. A refused host gate
 *      reads no task (positive control, so the mocks are proven live).
 *   2. forkSessionToTask(area source) is refused before the target task is read, before any
 *      task or session record is made and before any event. An ordinary source passes the
 *      area check and stops at the next guard (positive control).
 *   3. A class ratchet over src/providers/claude-code-session.ts: it enumerates every CLI spawn
 *      site (send() with the spawn signature) and every ClaudeCodeSession construction, and
 *      fails when one appears in a method it does not know. A fresh start must be reached only
 *      from entries that run assertStartRouting first; a resume must resolve its launch policy
 *      through resolveResumeArgs before it spawns.
 *
 * ZERO real side effects: constants point at a temp home; tasks, session records, the area
 * file and the host gate are fakes; the transport factory is a stub that is asserted never to
 * run, so no daemon, CLI, socket or network is touched and no process is signalled.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import type { RouterAreasFile } from '../../src/core/router/areas.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-session-entry'))

const h = vi.hoisted(() => ({
  tasks: new Map<string, Record<string, unknown>>(),
  records: new Map<string, Record<string, unknown>>(),
  areas: { value: null as unknown, error: null as Error | null },
  daemonMcp: true,
}))

const m = vi.hoisted(() => ({
  getTask: vi.fn(),
  addTask: vi.fn(async () => { throw new Error('addTask must not run') }),
  updateTask: vi.fn(async () => { throw new Error('updateTask must not run') }),
  updateTaskRaw: vi.fn(async () => { throw new Error('updateTaskRaw must not run') }),
  getSessionByClaudeId: vi.fn(),
  getSessionsForTask: vi.fn(async () => []),
  createSessionRecord: vi.fn(async () => { throw new Error('createSessionRecord must not run') }),
  updateSessionRecord: vi.fn(async () => { throw new Error('updateSessionRecord must not run') }),
  hostStartGate: vi.fn(async () => ({ error: 'host gate reached (test stop)' })),
  createSessionManager: vi.fn(() => { throw new Error('no transport may be made') }),
}))

vi.mock('../../src/core/task-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTask: m.getTask,
  addTask: m.addTask,
  updateTask: m.updateTask,
  updateTaskRaw: m.updateTaskRaw,
}))
vi.mock('../../src/core/session-tracker.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSessionByClaudeId: m.getSessionByClaudeId,
  getSessionsForTask: m.getSessionsForTask,
  createSessionRecord: m.createSessionRecord,
  updateSessionRecord: m.updateSessionRecord,
}))
vi.mock('../../src/core/router/areas.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readRouterAreas: vi.fn(async () => {
    if (h.areas.error) throw h.areas.error
    return h.areas.value
  }),
}))
vi.mock('../../src/core/sessions/host-start-gate.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hostStartGate: m.hostStartGate,
}))
// Never imported by the paths under test; mocked so an accidental spawn fails loudly, not for real.
vi.mock('../../src/providers/session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createSessionManager: m.createSessionManager,
  registerSessionManager: vi.fn(),
  unregisterSessionManager: vi.fn(),
}))

vi.mock('../../src/core/hosts/link.js', () => ({ link: vi.fn(async () => ({ hasCapability: () => h.daemonMcp })) }))

import { startSessionForTask } from '../../src/core/sessions/task-start.js'
import { bus } from '../../src/core/event-bus.js'
import { quickStartSession, QuickStartError } from '../../src/core/sessions/quick-start.js'
import { forkSessionToTask, SessionControlError } from '../../src/core/sessions/session-controls.js'
import { routerAreaProfile } from '../../src/core/router/session-policy.js'
import { WALNUT_HOME } from '../../src/constants.js'

const AREA_ID = 'personal'
const AREAS: RouterAreasFile = {
  version: 1,
  areas: [{ id: AREA_ID, name: 'Personal', host: '__local__', taskIds: ['t-work', 't-router', 't-unmarked'], sources: [] }],
  routers: [{ taskId: 't-router', areaId: AREA_ID, paused: false }],
  items: [],
}

let emitSpy: ReturnType<typeof vi.spyOn> | undefined

beforeEach(() => {
  h.tasks.clear()
  h.records.clear()
  h.areas.value = structuredClone(AREAS)
  h.areas.error = null
  h.daemonMcp = true
  for (const fn of Object.values(m)) fn.mockClear()
  m.getTask.mockImplementation(async (id: string) => {
    const task = h.tasks.get(id)
    if (!task) throw new Error(`Task not found: ${id}`)
    return task
  })
  m.getSessionByClaudeId.mockImplementation(async (sid: string) => h.records.get(sid))
  emitSpy?.mockRestore()
  emitSpy = vi.spyOn(bus, 'emit')
  h.tasks.set('t-work', { id: 't-work', title: 'area work', source: 'local', router_area_id: AREA_ID, phase: 'IN_PROGRESS' })
  h.tasks.set('t-router', { id: 't-router', title: 'router', source: 'local', router_area_id: AREA_ID, org_role: 'router', phase: 'IN_PROGRESS' })
  h.tasks.set('t-unmarked', { id: 't-unmarked', title: 'listed, mark missing', source: 'local', phase: 'IN_PROGRESS' })
  h.tasks.set('t-plain', { id: 't-plain', title: 'ordinary', source: 'local', phase: 'IN_PROGRESS' })
})

/** Nothing outside the area check ran: no host gate, no write, no event, no transport. */
function expectUntouched(scopeTask?: string): void {
  expect(m.hostStartGate).not.toHaveBeenCalled()
  expect(m.addTask).not.toHaveBeenCalled()
  expect(m.updateTask).not.toHaveBeenCalled()
  expect(m.updateTaskRaw).not.toHaveBeenCalled()
  expect(m.createSessionRecord).not.toHaveBeenCalled()
  expect(m.updateSessionRecord).not.toHaveBeenCalled()
  if (scopeTask) expect(m.getSessionsForTask.mock.calls).toEqual([[scopeTask]])
  else expect(m.getSessionsForTask).not.toHaveBeenCalled()
  expect(m.createSessionManager).not.toHaveBeenCalled()
  expect(emitSpy!).not.toHaveBeenCalled()
}

function quick(existingTaskId: string) {
  return quickStartSession({ message: 'hello', cwd: WALNUT_HOME, existingTaskId, source: 'quick-start', hostGate: { checked: true } })
}

describe('area start prerequisites', () => {
  it('refuses missing daemon MCP support before writing a task or session', async () => {
    h.daemonMcp = false
    await expect(startSessionForTask({ taskIdPrefix: 't-work', idle: true, source: 'api-agent' }))
      .rejects.toMatchObject({ statusCode: 409, body: { code: 'area_tools_unavailable' } })
    expectUntouched()
  })
})

describe('quickStartSession on an existing area task', () => {
  it('refuses a marked work task after host readiness, before any write or event', async () => {
    await expect(quick('t-work')).rejects.toBeInstanceOf(QuickStartError)
    await expect(quick('t-work')).rejects.toMatchObject({ statusCode: 409 })
    expectUntouched()
  })

  it('refuses a router task the same way', async () => {
    await expect(quick('t-router')).rejects.toMatchObject({ statusCode: 409 })
    expectUntouched()
  })

  it('refuses a task listed in the area file whose durable mark is missing', async () => {
    await expect(quick('t-unmarked')).rejects.toMatchObject({ statusCode: 409 })
    expectUntouched()
  })

  it('fails closed for a marked task when the area file cannot be read', async () => {
    h.areas.error = new Error('corrupt areas.json')
    await expect(quick('t-work')).rejects.toThrow()
    expectUntouched()
  })

  it('an ordinary task reaches a refused host gate before its task is read (control)', async () => {
    await expect(quickStartSession({ message: 'hello', cwd: WALNUT_HOME, existingTaskId: 't-plain', source: 'quick-start' })).rejects.toThrow('host gate reached')
    expect(m.hostStartGate).toHaveBeenCalledTimes(1)
    expect(m.getTask).not.toHaveBeenCalled()
    expect(m.addTask).not.toHaveBeenCalled()
    expect(emitSpy!).not.toHaveBeenCalled()
  })

  it('an unreadable area file does not precede a refused host gate', async () => {
    h.areas.error = new Error('corrupt areas.json')
    await expect(quickStartSession({ message: 'hello', cwd: WALNUT_HOME, existingTaskId: 't-plain', source: 'quick-start' })).rejects.toThrow('host gate reached')
    expect(m.hostStartGate).toHaveBeenCalledTimes(1)
    expect(m.getTask).not.toHaveBeenCalled()
  })

  it.each([
    ['No task found matching ID prefix "gone"', 404],
    ['Ambiguous ID prefix "t" matches 2 tasks. Be more specific.', 400],
  ])('preserves task lookup refusal %s without any writes', async (message, statusCode) => {
    m.getTask.mockRejectedValue(new Error(message))
    await expect(quick('gone')).rejects.toMatchObject({ statusCode })
    expectUntouched()
  })

  it('does not hide a task store failure as not found', async () => {
    m.getTask.mockRejectedValue(new Error('Task store unreadable'))
    await expect(quick('t-work')).rejects.toThrow('Task store unreadable')
    expectUntouched()
  })
})

describe('forkSessionToTask from an area source', () => {
  const SRC = 'src-session'

  it('refuses a source carrying an area profile, before the target task is read', async () => {
    h.records.set(SRC, { claudeSessionId: SRC, taskId: 't-work', cwd: WALNUT_HOME, profile: routerAreaProfile(AREA_ID, 'work') })
    await expect(forkSessionToTask(SRC, { task_id: 't-plain' })).rejects.toMatchObject({ statusCode: 409, extra: { code: 'area_scoped' } })
    expect(m.getTask).not.toHaveBeenCalled()
    expectUntouched()
  })

  it('refuses an area task\'s session with no profile (made before it joined), into a new child task too', async () => {
    h.records.set(SRC, { claudeSessionId: SRC, taskId: 't-unmarked', cwd: WALNUT_HOME })
    await expect(forkSessionToTask(SRC, { create_child_task: true, child_title: 'copy' }))
      .rejects.toBeInstanceOf(SessionControlError)
    expect(m.getTask.mock.calls.map(([id]) => id)).not.toContain('t-plain')
    expectUntouched('t-unmarked')
  })

  it('fails closed on an unreadable area file for a marked source, reading only the source task', async () => {
    h.areas.error = new Error('corrupt areas.json')
    h.records.set(SRC, { claudeSessionId: SRC, taskId: 't-work', cwd: WALNUT_HOME })
    await expect(forkSessionToTask(SRC, { task_id: 't-plain' })).rejects.toMatchObject({ statusCode: 409 })
    expect(m.getTask.mock.calls.map(([id]) => id)).not.toContain('t-plain')
    expectUntouched()
  })

  it('an ordinary source passes the area check and stops at the next guard (control)', async () => {
    // Codex sessions cannot fork: the guard right after the area check stops this one.
    h.records.set(SRC, { claudeSessionId: SRC, taskId: 't-plain', cwd: WALNUT_HOME, engine: 'codex' })
    await expect(forkSessionToTask(SRC, { task_id: 't-plain' })).rejects.toMatchObject({ statusCode: 409, extra: { code: 'ACP_FORK_UNSUPPORTED' } })
    expectUntouched('t-plain')
  })
})

// ── Class ratchet over the session runner's spawn sites ─────────────────────────────

const RUNNER_SRC = readFileSync(path.resolve(import.meta.dirname, '../../src/providers/claude-code-session.ts'), 'utf8')
const LINES = RUNNER_SRC.split('\n')
/** A class member's own line: two-space indent, optional modifiers, a name and "(". */
const METHOD_RE = /^ {2}(?:(?:private|public|protected|static|async|override)\s+)*([A-Za-z_$][\w$]*)\s*\(/

/** The class member whose body holds line `index`, with the line it starts on. */
function enclosingMethod(index: number): { name: string; start: number } {
  for (let i = index; i >= 0; i--) {
    const match = METHOD_RE.exec(LINES[i]!)
    if (match && !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(match[1]!)) return { name: match[1]!, start: i }
  }
  throw new Error(`no enclosing method for line ${index + 1}`)
}

function linesMatching(re: RegExp): number[] {
  return LINES.flatMap((line, i) => (re.test(line) ? [i] : []))
}

function textBetween(from: number, to: number): string {
  return LINES.slice(from, to + 1).join('\n')
}

/** Every CLI spawn passes the session's permission_prompt setting in send()'s spawn signature. */
const SPAWN_SITE = /\.send\([^\n]*permission_prompt/
const FRESH_START = 'handleStart'
const RESUMES = new Set(['performNativeReinitialize', 'processNextNow'])

describe('runner spawn sites stay behind the shared gates', () => {
  it('every spawn site lives in a known start or resume method', () => {
    const sites = linesMatching(SPAWN_SITE)
    expect(sites.length, 'the spawn-site pattern must still find spawns').toBeGreaterThan(0)
    const owners = new Set(sites.map((i) => enclosingMethod(i).name))
    // A new spawn site must be classified here (fresh start behind assertStartRouting, or a
    // resume behind resolveResumeArgs) before this test passes.
    expect([...owners].sort()).toEqual([FRESH_START, ...RESUMES].sort())
  })

  it('every ClaudeCodeSession construction lives in a known method', () => {
    const owners = new Set(linesMatching(/new ClaudeCodeSession\(/).map((i) => enclosingMethod(i).name))
    expect([...owners].sort()).toEqual(['attachToExisting', FRESH_START, ...RESUMES].sort())
  })

  it('a fresh start is reached only from entries that run assertStartRouting first', () => {
    const calls = linesMatching(new RegExp(`this\\.${FRESH_START}\\(`))
    expect(calls.length).toBeGreaterThan(0)
    const entries: string[] = []
    for (const call of calls) {
      const owner = enclosingMethod(call)
      entries.push(owner.name)
      // The bus entry: the SESSION_START case of init(), up to its handleStart call.
      const caseStart = owner.name === 'init'
        ? LINES.slice(owner.start, call + 1).map((l, k) => [l, owner.start + k] as const)
          .filter(([l]) => l.includes('case EventNames.SESSION_START:')).at(-1)?.[1]
        : owner.start
      expect(caseStart, `${owner.name} must call ${FRESH_START} from its SESSION_START case`).toBeDefined()
      const before = textBetween(caseStart!, call)
      // No other case label between the SESSION_START case and the call.
      expect(before.slice(before.indexOf('\n') + 1)).not.toMatch(/\bcase EventNames\./)
      expect(before, `${owner.name} must run the shared gate before ${FRESH_START}`).toMatch(/await this\.assertStartRouting\(/)
    }
    expect([...new Set(entries)].sort()).toEqual(['init', 'startSession'])
  })

  it('every resume resolves its launch policy before it spawns', () => {
    for (const site of linesMatching(SPAWN_SITE)) {
      const owner = enclosingMethod(site)
      if (!RESUMES.has(owner.name)) continue
      expect(textBetween(owner.start, site), `${owner.name} must call resolveResumeArgs before line ${site + 1}`)
        .toMatch(/await this\.resolveResumeArgs\(sessionId\)/)
    }
  })
})
