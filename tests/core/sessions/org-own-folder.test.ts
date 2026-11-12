/**
 * A VP, lead or router node runs in its own task directory (src/core/sessions/org-own-folder.ts):
 * the start rule for every org role, a person's named folder, a non-org task unchanged, and the
 * decision whether a spawn moves a session there.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const taskDirs = new Map<string, string | null>()
vi.mock('../../../src/core/sessions/task-dir-place.js', () => ({
  taskDirForHost: vi.fn(async (taskId: string, host?: string | null) => {
    const key = `${host || '__local__'}:${taskId}`
    return taskDirs.has(key) ? taskDirs.get(key)! : `/state/tasks/${taskId}`
  }),
}))
const linked: string[] = []
vi.mock('../../../src/core/hosts/link.js', () => ({
  link: vi.fn(async (host: string) => { linked.push(host); return {} }),
}))

import {
  ownFolderMoveDecision, ownFolderStartCwd, personNamedCwd, runsInOwnFolder,
} from '../../../src/core/sessions/org-own-folder.js'

beforeEach(() => { taskDirs.clear(); linked.length = 0 })

describe('runsInOwnFolder', () => {
  it.each([
    ['lead', true], ['router', true], ['main', false], [undefined, false],
  ] as const)('org_role %s -> %s', (role, own) => {
    expect(runsInOwnFolder({ org_role: role as never })).toBe(own)
  })
  it('no task', () => expect(runsInOwnFolder(null)).toBe(false))
})

describe('personNamedCwd', () => {
  it('a person named a folder: their start source, no calling session', () => {
    expect(personNamedCwd({ cwd: '/repo', source: 'api-v1' })).toBe(true)
    expect(personNamedCwd({ cwd: '/repo', source: 'quick-start' })).toBe(true)
    expect(personNamedCwd({ cwd: '/repo', source: 'cli' })).toBe(true)
  })
  it('an agent, Walnut itself or no folder is not a person naming one', () => {
    expect(personNamedCwd({ cwd: '/repo', source: 'api-v1', callerSid: 'sid-1' })).toBe(false)
    expect(personNamedCwd({ cwd: '/repo', source: 'engine-switch' })).toBe(false)
    expect(personNamedCwd({ cwd: '/repo', source: 'api-agent' })).toBe(false)
    expect(personNamedCwd({ source: 'api-v1' })).toBe(false)
  })
})

describe('ownFolderStartCwd', () => {
  const lead = { id: 'lead-1', org_role: 'lead' as const }

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

  it('an agent naming a repository for a lead does not put it there', async () => {
    expect(await ownFolderStartCwd(lead, '', { cwd: '/repo', callerSid: 's-1', source: 'api-v1' })).toEqual({ kind: 'own', cwd: '/state/tasks/lead-1' })
    expect(await ownFolderStartCwd(lead, '', { cwd: '/repo', source: 'engine-switch' })).toEqual({ kind: 'own', cwd: '/state/tasks/lead-1' })
    expect(await ownFolderStartCwd(lead, '', { workspace: { provider: 'x' }, callerSid: 's-1', source: 'api-v1' })).toEqual({ kind: 'own', cwd: '/state/tasks/lead-1' })
  })

  it('a person naming a folder for this start keeps it', async () => {
    expect(await ownFolderStartCwd(lead, '', { cwd: '/repo', source: 'api-v1' })).toEqual({ kind: 'person' })
    expect(await ownFolderStartCwd(lead, '', { cwd: '/repo', source: 'quick-start' })).toEqual({ kind: 'person' })
  })

  it('a remote host that has not said its root is asked once, then the start is refused rather than run in a repository', async () => {
    taskDirs.set('devbox:lead-1', null)
    await expect(ownFolderStartCwd(lead, 'devbox', { source: 'org-autostart' })).rejects.toThrow(/own task directory/)
    expect(linked).toEqual(['devbox'])
  })
})

describe('ownFolderMoveDecision', () => {
  const lead = { org_role: 'lead' as const, phase: 'IN_PROGRESS' as const }
  const rec = { cwd: '/repo', engine: 'claude' as const }
  const own = '/state/tasks/lead-1'

  it('a lead in a repository moves', () => {
    expect(ownFolderMoveDecision({ task: lead, record: rec, ownDir: own })).toEqual({ move: true })
  })
  it.each([
    ['a task outside the org', { task: { phase: 'TODO' as const }, record: rec, ownDir: own }, 'not-org-node'],
    ['Main', { task: { org_role: 'main' as const, phase: 'TODO' as const }, record: rec, ownDir: own }, 'not-org-node'],
    ['already in its folder', { task: lead, record: { ...rec, cwd: `${own}/` }, ownDir: own }, 'already-own'],
    ['a folder a person named', { task: lead, record: { ...rec, cwdByPerson: '/repo' }, ownDir: own }, 'person-chose'],
    ['a fork (side question)', { task: lead, record: rec, ownDir: own, fork: true }, 'fork'],
    ['a lane session', { task: lead, record: { ...rec, lane: 'side' }, ownDir: own }, 'fork'],
    ['an ACP engine', { task: lead, record: { ...rec, engine: 'codex' as const }, ownDir: own }, 'not-claude-code'],
    ['own folder unknown on its host', { task: lead, record: rec, ownDir: null }, 'own-folder-unknown'],
    ['no record', { task: lead, record: null, ownDir: own }, 'no-record'],
    ['an archived record', { task: lead, record: { ...rec, archived: true }, ownDir: own }, 'no-record'],
  ])('%s stays', (_name, input, why) => {
    expect(ownFolderMoveDecision(input as Parameters<typeof ownFolderMoveDecision>[0])).toEqual({ move: false, why })
  })
  it('a person\'s folder no longer in use does not hold the session back', () => {
    expect(ownFolderMoveDecision({ task: lead, record: { ...rec, cwd: '/other', cwdByPerson: '/repo' }, ownDir: own })).toEqual({ move: true })
  })
})
