/**
 * A VP, lead or router node runs in its own task directory (src/core/sessions/org-own-folder.ts):
 * the start rule for every org role, a person's picked folder, a non-org task unchanged, the
 * decision whether a spawn moves a session there, and the move itself against a host that may
 * hold the session elsewhere, be too old to say, or refuse the start that follows.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const taskDirs = new Map<string, string | null>()
const made: string[] = []
vi.mock('../../../src/core/sessions/task-dir-place.js', () => ({
  taskDirForHost: vi.fn(async (taskId: string, host?: string | null) => {
    const key = `${host || '__local__'}:${taskId}`
    return taskDirs.has(key) ? taskDirs.get(key)! : `/state/tasks/${taskId}`
  }),
  ensureTaskDirOnHost: vi.fn(async (taskId: string, host?: string | null) => { made.push(taskId); return { path: `/state/tasks/${taskId}`, host: host || '__local__' } }),
}))
const linked: string[] = []
vi.mock('../../../src/core/hosts/link.js', () => ({
  link: vi.fn(async (host: string) => { linked.push(host); await new Promise((r) => setTimeout(r, 20)); return {} }),
}))
const env = { ephemeral: false }
vi.mock('../../../src/constants.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/constants.js')>()),
  get IS_EPHEMERAL() { return env.ephemeral },
  WALNUT_HOME: '/home/me/.open-walnut',
}))
const tasks = new Map<string, Record<string, unknown>>()
vi.mock('../../../src/core/task-manager.js', () => ({
  getTask: vi.fn(async (id: string) => { const t = tasks.get(id); if (!t) throw new Error('No task found matching'); return t }),
}))
let record: Record<string, unknown> | null = null
const writes: Array<Record<string, unknown>> = []
vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: vi.fn(async () => record && { ...record }),
  updateSessionRecordConditionally: vi.fn(async (_sid: string, updates: Record<string, unknown>, when: (r: Record<string, unknown>) => boolean) => {
    if (!record || !when(record)) return null
    writes.push(updates)
    record = { ...record, ...updates }
    for (const [k, v] of Object.entries(updates)) if (v === undefined) delete record[k]
    return record
  }),
}))
const daemon = { connected: true, caps: new Set(['cli-holder-v1']), holders: [] as Array<unknown>, journaledHome: null as string | null, asked: 0 }
/** cli.holder as RemoteSessionManager.cliHolder answers it, on the start's own link. */
const cliHolder = async (_sid: string) => {
  if (!daemon.connected) return { state: 'unknown' as const, detail: 'connection closed' }
  if (!daemon.caps.has('cli-holder-v1')) return { state: 'too-old' as const }
  daemon.asked++
  if (daemon.holders.shift()) return { state: 'held' as const, detail: 'live pid 4242' }
  return { state: 'free' as const, ...(daemon.journaledHome ? { journaledHome: daemon.journaledHome } : {}) }
}
const pooled = { conn: null as null | { hasCapability: (c: string) => boolean } }
vi.mock('../../../src/providers/daemon-connection.js', () => ({ getConnectedDaemonConnection: vi.fn(() => pooled.conn) }))
const conversation = { moves: [] as Array<{ from: string | null; to: string }>, answer: 'moved' as 'moved' | 'in-place' | 'missing' | 'unknown' | Error, backAnswer: 'moved' as 'moved' | Error }
vi.mock('../../../src/core/sessions/folder-gone.js', () => ({
  moveConversation: vi.fn(async (rec: { cwd: string | null }, to: string) => {
    const back = conversation.moves.length > 0
    const answer = back ? conversation.backAnswer : conversation.answer
    if (answer instanceof Error) throw answer
    if (answer === 'moved') conversation.moves.push({ from: rec.cwd, to })
    return answer
  }),
}))

import {
  handedDownCwd, moveToOwnFolderBeforeSpawn, ownFolderConflictNotice, ownFolderMoveDecision, ownFolderMoveDue, ownFolderStartCwd, personNamedCwd, runsInOwnFolder,
  HELD_ELSEWHERE_MS, MOVE_RETRY_MS, TRANSIENT_RETRY_MS,
} from '../../../src/core/sessions/org-own-folder.js'

const SID = 'aaaaaaaa-1111-4222-8333-444444444444'
const LEAD = 'lead-1'
const OWN = `/state/tasks/${LEAD}`

beforeEach(() => {
  taskDirs.clear(); linked.length = 0; made.length = 0; writes.length = 0
  env.ephemeral = false
  tasks.clear()
  tasks.set(LEAD, { id: LEAD, org_role: 'lead', phase: 'IN_PROGRESS' })
  record = { claudeSessionId: SID, taskId: LEAD, cwd: '/repo', engine: 'claude' }
  Object.assign(daemon, { connected: true, caps: new Set(['cli-holder-v1']), holders: [], journaledHome: null, asked: 0 })
  Object.assign(conversation, { moves: [], answer: 'moved', backAnswer: 'moved' })
  pooled.conn = null
})

describe('runsInOwnFolder', () => {
  it.each([
    ['lead', true], ['router', true], ['main', false], [undefined, false],
  ] as const)('org_role %s -> %s', (role, own) => {
    expect(runsInOwnFolder({ org_role: role as never })).toBe(own)
  })
  it('no task', () => expect(runsInOwnFolder(null)).toBe(false))
})

describe('personNamedCwd: only a folder the person picked', () => {
  it('the draft\'s folder picker says so (cwdChosen), on a person\'s request', () => {
    expect(personNamedCwd({ cwd: '/repo', cwdChosen: true, source: 'api-v1' })).toBe(true)
    expect(personNamedCwd({ cwd: '/repo', cwdChosen: true, source: 'quick-start' })).toBe(true)
  })
  it('a folder the client filled in is no choice: the board\'s ▶ (task.cwd or the last launch), Snooze until, an older client', () => {
    expect(personNamedCwd({ cwd: '/repo', source: 'quick-start' })).toBe(false)
    expect(personNamedCwd({ cwd: '/repo', source: 'api-v1' })).toBe(false)
    expect(personNamedCwd({ cwd: '/repo', cwdChosen: false, source: 'cli' })).toBe(false)
  })
  it('an agent, Walnut itself or no folder is not a person picking one', () => {
    expect(personNamedCwd({ cwd: '/repo', cwdChosen: true, source: 'api-v1', callerSid: 'sid-1' })).toBe(false)
    expect(personNamedCwd({ cwd: '/repo', cwdChosen: true, source: 'engine-switch' })).toBe(false)
    expect(personNamedCwd({ cwdChosen: true, source: 'api-v1' })).toBe(false)
  })
})

describe('ownFolderStartCwd', () => {
  const lead = { id: LEAD, org_role: 'lead' as const }

  it('a task outside the org keeps whatever its plan named', async () => {
    expect(await ownFolderStartCwd({ id: 't-1' }, '', { cwd: '/repo', source: 'api-agent' })).toBeNull()
    expect(await ownFolderStartCwd({ id: 't-1' }, '', { source: 'org-autostart' })).toBeNull()
  })

  it('Main keeps its own start (an ask in Walnut\'s data folder)', async () => {
    expect(await ownFolderStartCwd({ id: 'main', org_role: 'main' }, '', { source: 'org-autostart' })).toBeNull()
  })

  it.each(['lead', 'router'] as const)('a %s with no folder named starts in its task directory on its host', async (role) => {
    expect(await ownFolderStartCwd({ id: 'n-1', org_role: role }, '', { source: 'org-autostart' })).toEqual({ kind: 'own', cwd: '/state/tasks/n-1' })
    expect(await ownFolderStartCwd({ id: 'n-1', org_role: role }, 'devbox', { source: 'api-v1' })).toEqual({ kind: 'own', cwd: '/state/tasks/n-1' })
  })

  it('the board\'s ▶ on a lead (its task.cwd or the last launch, no pick) starts it in its own directory', async () => {
    expect(await ownFolderStartCwd(lead, '', { cwd: '/repo', source: 'quick-start' })).toEqual({ kind: 'own', cwd: OWN })
  })

  it('an agent naming a repository for a lead does not put it there', async () => {
    expect(await ownFolderStartCwd(lead, '', { cwd: '/repo', cwdChosen: true, callerSid: 's-1', source: 'api-v1' })).toEqual({ kind: 'own', cwd: OWN })
    expect(await ownFolderStartCwd(lead, '', { cwd: '/repo', source: 'engine-switch' })).toEqual({ kind: 'own', cwd: OWN })
  })

  it('a folder the person picked for this start is kept', async () => {
    expect(await ownFolderStartCwd(lead, '', { cwd: '/repo', cwdChosen: true, source: 'api-v1' })).toEqual({ kind: 'person' })
    expect(await ownFolderStartCwd(lead, '', { cwd: '/repo', cwdChosen: true, source: 'quick-start' })).toEqual({ kind: 'person' })
  })

  it('a remote host that has not said its root is linked once for all the plans of one start, then refused rather than run in a repository', async () => {
    taskDirs.set('devbox:lead-1', null)
    const plans = await Promise.allSettled([1, 2, 3].map(() => ownFolderStartCwd(lead, 'devbox', { source: 'org-autostart' })))
    expect(plans.every((p) => p.status === 'rejected' && /own task directory/.test(String(p.reason)))).toBe(true)
    expect(linked).toEqual(['devbox'])
  })

  it('a preview (the Org page\'s draft, an inbox plan) never waits on a host link, and answers with no folder yet', async () => {
    taskDirs.set('devbox2:lead-1', null)
    expect(await ownFolderStartCwd(lead, 'devbox2', { source: 'human-inbox' }, { preview: true })).toEqual({ kind: 'own', cwd: null })
    expect(linked).toEqual([])
  })
})

describe('ownFolderMoveDecision', () => {
  const lead = { org_role: 'lead' as const, phase: 'IN_PROGRESS' as const }
  const rec = { cwd: '/repo', engine: 'claude' as const }
  const NOW = Date.parse('2026-11-12T12:00:00Z')
  const ago = (ms: number) => new Date(NOW - ms).toISOString()

  it('a lead in a repository moves', () => {
    expect(ownFolderMoveDecision({ task: lead, record: rec, ownDir: OWN, now: NOW })).toEqual({ move: true })
  })
  it.each([
    ['a task outside the org', { task: { phase: 'TODO' as const }, record: rec, ownDir: OWN }, 'not-org-node'],
    ['Main', { task: { org_role: 'main' as const, phase: 'TODO' as const }, record: rec, ownDir: OWN }, 'not-org-node'],
    ['a test server on a copy of the data', { task: lead, record: rec, ownDir: OWN, ephemeral: true }, 'ephemeral'],
    ['already in its folder', { task: lead, record: { ...rec, cwd: `${OWN}/` }, ownDir: OWN }, 'already-own'],
    ['a folder a person picked', { task: lead, record: { ...rec, cwdByPerson: '/repo' }, ownDir: OWN }, 'person-chose'],
    ['a start in the task\'s isolated workspace', { task: { ...lead, workspace: { anchor: '/repo', root: '/ws/lead-1' } }, record: { ...rec, cwd: '/ws/lead-1/app' }, ownDir: OWN }, 'workspace'],
    ['a fork (side question)', { task: lead, record: rec, ownDir: OWN, fork: true }, 'fork'],
    ['a lane session', { task: lead, record: { ...rec, lane: 'side' }, ownDir: OWN }, 'fork'],
    ['an ACP engine', { task: lead, record: { ...rec, engine: 'codex' as const }, ownDir: OWN }, 'not-claude-code'],
    ['own folder unknown on its host', { task: lead, record: rec, ownDir: null }, 'own-folder-unknown'],
    ['no record', { task: lead, record: null, ownDir: OWN }, 'no-record'],
    ['an archived record', { task: lead, record: { ...rec, archived: true }, ownDir: OWN }, 'no-record'],
    ['open in a terminal lately', { task: lead, record: { ...rec, heldElsewhere: { at: ago(HELD_ELSEWHERE_MS - 60_000), host: '', holder: 'terminal' as const } }, ownDir: OWN }, 'held-elsewhere'],
    ['a lasting failure for this folder today', { task: lead, record: { ...rec, ownFolderMove: { from: '/repo', why: 'move-failed', at: ago(3_600_000) } }, ownDir: OWN }, 'failed-recently'],
    ['a CLI still running within the hour', { task: lead, record: { ...rec, ownFolderMove: { from: '/repo', why: 'process-running', at: ago(TRANSIENT_RETRY_MS - 60_000) } }, ownDir: OWN }, 'failed-recently'],
    ['its history in two places, even a month later', { task: lead, record: { ...rec, ownFolderMove: { from: '/repo', why: 'history-conflict', at: ago(30 * MOVE_RETRY_MS) } }, ownDir: OWN }, 'failed-for-good'],
  ])('%s stays', (_name, input, why) => {
    expect(ownFolderMoveDecision({ now: NOW, ...input } as Parameters<typeof ownFolderMoveDecision>[0])).toEqual({ move: false, why })
  })
  it.each([
    ['a person\'s folder no longer in use', { ...rec, cwd: '/other', cwdByPerson: '/repo' }],
    ['a terminal hold a day old', { ...rec, heldElsewhere: { at: ago(HELD_ELSEWHERE_MS + 60_000), host: '', holder: 'terminal' as const } }],
    ['a failure a day old', { ...rec, ownFolderMove: { from: '/repo', why: 'move-failed', at: ago(MOVE_RETRY_MS + 60_000) } }],
    ['a passing failure an hour old', { ...rec, ownFolderMove: { from: '/repo', why: 'host-unasked', at: ago(TRANSIENT_RETRY_MS + 60_000) } }],
    ['a failure for another folder', { ...rec, ownFolderMove: { from: '/elsewhere', why: 'move-failed', at: ago(60_000) } }],
  ])('%s does not hold it back', (_name, record) => {
    expect(ownFolderMoveDecision({ task: lead, record, ownDir: OWN, now: NOW })).toEqual({ move: true })
  })
  it('a workspace does not keep a session that runs in the repository it was made from', () => {
    const task = { ...lead, workspace: { anchor: '/repo', root: '/ws/lead-1' } }
    expect(ownFolderMoveDecision({ task: task as never, record: rec, ownDir: OWN, now: NOW })).toEqual({ move: true })
  })
})

describe('moveToOwnFolderBeforeSpawn', () => {
  const move = (cwd = '/repo') => moveToOwnFolderBeforeSpawn({ sessionId: SID, taskId: LEAD, cwd, host: null, cliHolder })

  it('moves the conversation when the host says no CLI of it runs, points the record there, and can put it back', async () => {
    const res = await move()
    expect(res?.cwd).toBe(OWN)
    expect(conversation.moves).toEqual([{ from: '/repo', to: OWN }])
    expect(record).toMatchObject({ cwd: OWN, folderMoved: { from: '/repo', to: OWN, by: 'walnut', why: 'own-folder' } })
    // The start that followed was refused: back where it was, the record too.
    expect(await res!.undo!()).toBe('/repo')
    expect(conversation.moves).toEqual([{ from: '/repo', to: OWN }, { from: OWN, to: '/repo' }])
    expect(record!.cwd).toBe('/repo')
    expect(record!.folderMoved).toBeUndefined()
  })

  it('an undo that cannot move the conversation back leaves it, and the record, in the new folder', async () => {
    const res = await move()
    conversation.backAnswer = new Error('target exists')
    expect(await res!.undo!()).toBe(OWN)
    expect(record!.cwd).toBe(OWN)
  })

  it('a CLI of the session on the host (a terminal\'s claude -r) is asked again, then left alone for an hour', async () => {
    daemon.holders = [{ kind: 'live', pid: 4242, unrecorded: true }, { kind: 'live', pid: 4242 }, { kind: 'live', pid: 4242 }]
    expect(await move()).toBeNull()
    expect(daemon.asked).toBe(3)
    expect(conversation.moves).toEqual([])
    expect(record!.cwd).toBe('/repo')
    expect(record!.ownFolderMove).toMatchObject({ from: '/repo', why: 'process-running' })
    expect(ownFolderMoveDecision({ task: tasks.get(LEAD) as never, record: record as never, ownDir: OWN })).toEqual({ move: false, why: 'failed-recently' })
    expect(ownFolderMoveDecision({ task: tasks.get(LEAD) as never, record: record as never, ownDir: OWN, now: Date.now() + TRANSIENT_RETRY_MS + 1 })).toEqual({ move: true })
  })

  it('a CLI just stopped that leaves the table on the second ask: moved', async () => {
    daemon.holders = [{ kind: 'live', pid: 4242 }]
    expect((await move())?.cwd).toBe(OWN)
  })

  it('a daemon too old to say who holds it: nothing moves, recorded, so the next spawns do not try for a day', async () => {
    daemon.caps = new Set()
    expect(await move()).toBeNull()
    expect(conversation.moves).toEqual([])
    expect(record!.ownFolderMove).toMatchObject({ from: '/repo', why: 'daemon-too-old' })
    expect(ownFolderMoveDecision({ task: tasks.get(LEAD) as never, record: record as never, ownDir: OWN }).move).toBe(false)
  })

  it('a session the spawn journal says another Walnut started is never moved', async () => {
    daemon.journaledHome = '/home/someone/.open-walnut'
    expect(await move()).toBeNull()
    expect(conversation.moves).toEqual([])
    expect(record!.ownFolderMove).toMatchObject({ why: 'other-walnut' })
    daemon.journaledHome = '/home/me/.open-walnut/'
    record!.ownFolderMove = undefined
    expect((await move())?.cwd).toBe(OWN)
  })

  it('a host with no link, or one whose answer is lost: left, and asked again an hour later', async () => {
    daemon.connected = false
    expect(await move()).toBeNull()
    expect(record!.ownFolderMove).toMatchObject({ why: 'host-unasked' })
  })

  it('a conflict or a missing transcript is recorded once', async () => {
    conversation.answer = new Error('history is in two places')
    expect(await move()).toBeNull()
    expect(record!.ownFolderMove).toMatchObject({ from: '/repo', why: 'move-failed' })
    conversation.answer = 'missing'
    record!.ownFolderMove = undefined
    expect(await move()).toBeNull()
    expect(record!.ownFolderMove).toMatchObject({ why: 'transcript-missing' })
  })

  it('its history in two places: moved neither, never tried again for that folder, and the node told once naming both files', async () => {
    conversation.answer = Object.assign(new Error('two places'), { extra: { code: 'history_conflict', files: ['/p/a/s.jsonl', '/p/b/s.jsonl'] } })
    expect(await move()).toBeNull()
    expect(record!.ownFolderMove).toMatchObject({ from: '/repo', why: 'history-conflict', files: ['/p/a/s.jsonl', '/p/b/s.jsonl'] })
    expect(ownFolderMoveDecision({ task: tasks.get(LEAD) as never, record: record as never, ownDir: OWN, now: Date.now() + 365 * MOVE_RETRY_MS })).toEqual({ move: false, why: 'failed-for-good' })
    const text = ownFolderConflictNotice(record!.ownFolderMove as never)
    expect(text).toContain('/p/a/s.jsonl and /p/b/s.jsonl')
    expect(text).toContain('will not try again')
    expect(text).toContain('merged nothing')
    // A later spawn: not tried, nothing rewritten, so the told mark stays.
    record!.ownFolderMove = { ...(record!.ownFolderMove as object), told: true }
    daemon.asked = 0
    expect(await move()).toBeNull()
    expect(daemon.asked).toBe(0)
    expect(record!.ownFolderMove).toMatchObject({ why: 'history-conflict', told: true })
  })

  it('a conversation another spawn already moved there: spawned there, with nothing of this one\'s to put back', async () => {
    conversation.answer = 'in-place'
    const res = await move()
    expect(res).toEqual({ cwd: OWN })
    expect(res!.undo).toBeUndefined()
  })

  it('the undo asks the host again: a CLI that started anyway keeps the conversation where it writes', async () => {
    const res = await move()
    daemon.holders = [{ kind: 'live', pid: 77 }]
    expect(await res!.undo!()).toBe(OWN)
    expect(conversation.moves).toEqual([{ from: '/repo', to: OWN }])
    expect(record!.cwd).toBe(OWN)
  })

  it('never on a test server', async () => {
    env.ephemeral = true
    expect(await move()).toBeNull()
    expect(daemon.asked).toBe(0)
    expect(conversation.moves).toEqual([])
  })

  it('a record already in its own folder while the runner still holds the old one spawns in the record\'s', async () => {
    record!.cwd = OWN
    expect(await move('/repo')).toEqual({ cwd: OWN })
    expect(conversation.moves).toEqual([])
  })

  it('a task outside the org is untouched, with no question to the host', async () => {
    tasks.set(LEAD, { id: LEAD, phase: 'IN_PROGRESS' })
    expect(await move()).toBeNull()
    expect(daemon.asked).toBe(0)
  })
})

describe('handedDownCwd', () => {
  it('a node moved into its own folder hands on the folder it was moved from', () => {
    expect(handedDownCwd({ cwd: OWN, folderMoved: { from: '/repo', to: OWN, at: '', by: 'walnut', why: 'own-folder' } })).toBe('/repo')
  })
  it('any other session hands on its own folder', () => {
    expect(handedDownCwd({ cwd: OWN })).toBe(OWN)
    expect(handedDownCwd({ cwd: '/tasks/x', folderMoved: { from: '/gone', to: '/tasks/x', at: '', by: 'human' } })).toBe('/tasks/x')
    expect(handedDownCwd({ cwd: '/elsewhere', folderMoved: { from: '/repo', to: OWN, at: '', by: 'walnut', why: 'own-folder' } })).toBe('/elsewhere')
  })
})

describe('ownFolderMoveDue', () => {
  const task = { id: LEAD, org_role: 'lead', phase: 'IN_PROGRESS' } as never
  const rec = { claudeSessionId: SID, cwd: '/repo', engine: 'claude' } as never
  it('due for a lead in a repository on a daemon that can say who holds it, or one not linked yet', async () => {
    expect(await ownFolderMoveDue(rec, task)).toBe(true)
    pooled.conn = { hasCapability: (c) => c === 'cli-holder-v1' }
    expect(await ownFolderMoveDue(rec, task)).toBe(true)
  })
  it('not due on a linked daemon too old to say: its move would be left, so no respawn for it', async () => {
    pooled.conn = { hasCapability: () => false }
    expect(await ownFolderMoveDue(rec, task)).toBe(false)
  })
})
