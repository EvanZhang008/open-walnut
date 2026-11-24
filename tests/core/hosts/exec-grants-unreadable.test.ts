/**
 * A grants file that cannot be read whole never reads as "no grants", and a refusal says why a
 * task has no grant instead of calling it the user's revoke.
 *
 * 2026-11-24 08:39Z: a data sync's merge left conflict markers in host-exec-grants.json for a
 * few seconds. Every lookup parsed nothing, three tasks' reads on the Mac were refused with "The
 * user revoked this task's grant", which he had not, and any grant write in those seconds would
 * have replaced all 744 grants with the one it made. The class: every lookup and every write of
 * the store, and every refusal that says "revoked".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-exec-grants-unreadable'))
// No refusal below may write a letter: a letter sent here fails the test that caused it.
const sendLetter = vi.hoisted(() => vi.fn(async () => { throw new Error('a letter was sent') }))
vi.mock('../../../src/core/human-inbox/store.js', () => ({ sendLetter, getLetter: vi.fn(async () => null), settleLetter: vi.fn() }))

import * as grants from '../../../src/core/hosts/exec-grants.js'
import { assertMayRead, assertStillGranted, grantFor, mayTendRuns, pinnedGrant } from '../../../src/core/hosts/host-exec-grant.js'
import { HostExecError } from '../../../src/core/hosts/host-exec.js'

const HOST = '__local__'
const MARKED = (body: string) => `<<<<<<< HEAD\n${body}\n=======\n{"grants":[],"asks":[]}\n>>>>>>> origin/main\n`
/** A file as a git merge leaves it: the lines both sides share, and one hunk per side. */
const HUNKS = (common: [string, string], ours: string, theirs: string) => `${common[0]}\n<<<<<<< HEAD\n${ours}\n=======\n${theirs}\n>>>>>>> origin/main\n${common[1]}\n`
const GARBAGE = '{"grants":[{"id":"xg-abcd","taskId":"t1","host":"__local__"'
const CALLER = { sid: 's1', taskId: 't1', taskTitle: 'Task one', host: '__local__' }

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-unreadable-'))
  file = path.join(dir, 'host-exec-grants.json')
  grants.setExecGrantsFileForTest(file)
})
afterEach(() => {
  grants.setExecGrantsFileForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

async function refusal(p: Promise<unknown>): Promise<HostExecError> {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(HostExecError)
  return err as HostExecError
}

describe('a grants file that cannot be read whole', () => {
  it('keeps every grant read before it while it holds conflict markers, then reads the fixed file', async () => {
    const g = await grants.grant('t1', HOST, 'own-host')
    await grants.grant('t2', HOST, 'own-host')
    const whole = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, MARKED(whole))
    expect(grants.findGrant('t1', HOST)?.id).toBe(g.id)
    expect(grants.findGrant('t2', HOST)).toBeDefined()
    expect(grants.grantsFileState()).toMatchObject({ readable: false, why: 'unparsable', trusted: true })
    await expect(assertMayRead('t1', HOST, 'hx-1')).resolves.toBeUndefined()
    await expect(assertStillGranted('t1', HOST, g.id)).resolves.toBe(g.id)
    // Whole again: what it says wins, a revoke another writer made included.
    const s = JSON.parse(whole)
    s.grants = s.grants.map((x: grants.ExecGrant) => (x.taskId === 't1' ? { ...x, revokedAt: Date.now() } : x))
    fs.writeFileSync(file, JSON.stringify(s))
    expect(grants.findGrant('t1', HOST)).toBeUndefined()
    expect(grants.grantsFileState().readable).toBe(true)
  })

  it('keeps the grants while the file is gone for a moment (a rename or a checkout in flight)', async () => {
    await grants.grant('t1', HOST, 'own-host')
    fs.rmSync(file)
    expect(grants.findGrant('t1', HOST)).toBeDefined()
    expect(grants.grantsFileState()).toMatchObject({ readable: false, why: 'missing' })
  })

  it('a write while it is unreadable goes onto the grants read before, and keeps the unreadable file beside it', async () => {
    await grants.grant('t1', HOST, 'own-host')
    const marked = MARKED(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, marked)
    await grants.grant('t2', HOST, 'own-host')
    const now = JSON.parse(fs.readFileSync(file, 'utf8')) as { grants: grants.ExecGrant[] }
    expect(now.grants.map((x) => x.taskId).sort()).toEqual(['t1', 't2'])
    // Kept where the data sync never takes it (local/ is machine-local), never beside the synced file.
    expect(fs.readdirSync(dir).filter((f) => f.includes('unreadable'))).toEqual([])
    const asideDir = path.join(dir, 'local', 'unreadable')
    const aside = fs.readdirSync(asideDir).filter((f) => f.startsWith('host-exec-grants.json.'))
    expect(aside).toHaveLength(1)
    expect(fs.readFileSync(path.join(asideDir, aside[0]), 'utf8')).toBe(marked)
    expect(grants.grantsFileState().readable).toBe(true)
  })

  it('never read whole: no grant, no write over it, and a refusal that says the file cannot be read', async () => {
    fs.writeFileSync(file, GARBAGE)
    expect(grants.findGrant('t1', HOST)).toBeUndefined()
    expect(grants.grantsFileState()).toMatchObject({ readable: false, trusted: false })
    const write = await grants.grant('t2', HOST, 'own-host').then(() => null, (e: unknown) => e)
    expect(write).toMatchObject({ status: 503, code: 'exec_grants_unreadable' })
    expect(fs.readFileSync(file, 'utf8')).toBe(GARBAGE)
    const err = await refusal(assertMayRead('t1', HOST, 'hx-1'))
    expect(err.code).toBe('exec_grants_unreadable')
    expect(err.status).toBe(503)
    expect(err.message).not.toMatch(/the user revoked this/i)
  })

  it('never read whole: a new call makes no grant and sends no letter, on its own host or from another', async () => {
    fs.writeFileSync(file, GARBAGE)
    for (const caller of [CALLER, { ...CALLER, host: 'some-cloud-box' }]) {
      for (const call of [grantFor(caller, HOST, 'ls'), grantFor(caller, HOST, null), pinnedGrant(caller, HOST, 'xg-abcd')]) {
        const err = await refusal(call)
        expect(err).toMatchObject({ status: 503, code: 'exec_grants_unreadable' })
      }
    }
    expect(sendLetter).not.toHaveBeenCalled()
    expect(fs.readFileSync(file, 'utf8')).toBe(GARBAGE)
  })

  it('never read whole but holding both sides of a merge: the grants either side has, a revoke on either side winning', async () => {
    const g = (id: string, task: string, revokedAt?: number) => JSON.stringify({ id, taskId: task, host: HOST, grantedAt: 1, via: 'own-host', runs: 0, ...(revokedAt ? { revokedAt } : {}) })
    fs.writeFileSync(file, HUNKS(['{"grants":[', '],"asks":[]}'], `${g('xg-one1', 't1')},${g('xg-two2', 't2')}`, `${g('xg-one1', 't1', 5)},${g('xg-thr3', 't3')}`))
    expect(grants.grantsFileState()).toMatchObject({ readable: false, why: 'unparsable', trusted: true })
    expect(grants.findGrant('t1', HOST)).toBeUndefined()
    expect(grants.lastRevokedAt('t1', HOST)).toBe(5)
    expect(grants.findGrant('t2', HOST)?.id).toBe('xg-two2')
    expect(grants.findGrant('t3', HOST)?.id).toBe('xg-thr3')
  })

  it('a revoke on the other side of the markers survives a write made while they are there', async () => {
    const one = await grants.grant('t1', HOST, 'own-host')
    const two = await grants.grant('t2', HOST, 'own-host')
    const before = JSON.parse(fs.readFileSync(file, 'utf8')) as { grants: grants.ExecGrant[] }
    const revoked = { ...before, grants: before.grants.map((x) => (x.id === one.id ? { ...x, revokedAt: 7 } : x)) }
    fs.writeFileSync(file, `<<<<<<< HEAD\n${JSON.stringify(before, null, 2)}\n=======\n${JSON.stringify(revoked, null, 2)}\n>>>>>>> origin/main\n`)
    await grants.noteRun(two.id, 'ls')
    const now = JSON.parse(fs.readFileSync(file, 'utf8')) as { grants: grants.ExecGrant[]; lastUpdated?: string }
    expect(now.grants.find((x) => x.id === one.id)?.revokedAt).toBe(7)
    expect(now.grants.find((x) => x.id === two.id)?.runs).toBe(1)
    expect(Date.parse(now.lastUpdated ?? '')).toBeGreaterThan(0)
  })

  it('a closed host stays closed while its file holds conflict markers', async () => {
    await grants.setHostClosed('macbox', true)
    const closedFile = file.replace(/\.json$/, '') + '-closed.json'
    fs.writeFileSync(closedFile, MARKED(fs.readFileSync(closedFile, 'utf8')))
    expect(grants.isHostClosed('macbox')).toBe(true)
  })

  it('closed hosts never read whole: a host either side of the markers closes stays closed', () => {
    const closedFile = file.replace(/\.json$/, '') + '-closed.json'
    fs.writeFileSync(closedFile, HUNKS(['{', '}'], '"closed": ["boxa"]', '"closed": ["boxb"]'))
    expect(grants.isHostClosed('boxa')).toBe(true)
    expect(grants.isHostClosed('boxb')).toBe(true)
    expect(grants.isHostClosed('boxc')).toBe(false)
    expect(grants.closedHostsUnreadable()).toBeNull()
  })

  it('closed hosts never read whole and unreadable: every host counts as closed and the refusal says why, until the user sets one', async () => {
    const closedFile = file.replace(/\.json$/, '') + '-closed.json'
    fs.writeFileSync(closedFile, '{"closed": ["box')
    await grants.grant('t1', HOST, 'own-host')
    expect(grants.isHostClosed('anybox')).toBe(true)
    const err = await refusal(assertMayRead('t1', HOST, 'hx-1'))
    expect(err).toMatchObject({ status: 503, code: 'exec_grants_unreadable' })
    expect(err.message).not.toMatch(/^The user closed/)
    expect(err.message).toMatch(/the user closed nothing/)
    // The user's own write in Settings ends it: a fresh list, the unreadable one kept aside.
    expect(await grants.setHostClosed('anybox', true)).toEqual(['anybox'])
    expect(grants.isHostClosed('otherbox')).toBe(false)
    expect(grants.closedHostsUnreadable()).toBeNull()
    const asideDir = path.join(dir, 'local', 'unreadable')
    expect(fs.readdirSync(asideDir).map((f) => fs.readFileSync(path.join(asideDir, f), 'utf8'))).toEqual(['{"closed": ["box'])
  })

  it('a grants file never read whole: the user\'s grant in Settings writes a fresh file and keeps the old one aside; nothing else does', async () => {
    fs.writeFileSync(file, GARBAGE)
    await expect(grants.grant('t1', HOST, 'own-host')).rejects.toMatchObject({ status: 503 })
    expect(fs.readFileSync(file, 'utf8')).toBe(GARBAGE)
    const g = await grants.grant('t1', HOST, 'settings')
    expect(grants.grantsFileState().readable).toBe(true)
    expect(grants.findGrant('t1', HOST)?.id).toBe(g.id)
    const asideDir = path.join(dir, 'local', 'unreadable')
    expect(fs.readdirSync(asideDir).map((f) => fs.readFileSync(path.join(asideDir, f), 'utf8'))).toEqual([GARBAGE])
  })
})

describe('two copies of the store as one', () => {
  it('an ask a later grant answered is over, a Deny included; one after the grant stands', async () => {
    const { mergeStores } = await import('../../../src/core/hosts/exec-grants-file.js')
    const grant = { id: 'xg-aaaa1', taskId: 't1', host: HOST, grantedAt: 20, via: 'settings' as const, runs: 0, revokedAt: 30 }
    const deny = (at: number) => ({ taskId: 't1', host: HOST, letterId: 'lt-1', askedAt: at, answeredAt: at + 1, sid: 's', state: 'denied' as const })
    expect(mergeStores([{ grants: [grant], asks: [] }, { grants: [], asks: [deny(10)] }]).asks).toEqual([])
    expect(mergeStores([{ grants: [grant], asks: [] }, { grants: [], asks: [deny(40)] }]).asks).toHaveLength(1)
  })
})

describe('a refusal says why the task has no grant', () => {
  it('the user\'s revoke reads as a revoke', async () => {
    const g = await grants.grant('t1', HOST, 'own-host')
    await grants.revokeGrant(g.id)
    const read = await refusal(assertMayRead('t1', HOST, 'hx-1'))
    expect(read.code).toBe('exec_grant_revoked')
    expect(read.message).toMatch(/The user revoked this task's grant/)
    const dispatch = await refusal(assertStillGranted('t1', HOST, g.id))
    expect(dispatch.code).toBe('exec_grant_revoked')
  })

  it('a grant the file no longer lists, that nobody revoked, never reads as the user\'s revoke', async () => {
    const g = await grants.grant('t1', HOST, 'own-host')
    // Another writer (a sync taking the other side, an older copy) replaced the file without it.
    fs.writeFileSync(file, JSON.stringify({ grants: [], asks: [] }))
    for (const p of [assertMayRead('t1', HOST, 'hx-1'), assertStillGranted('t1', HOST, g.id), assertStillGranted('t1', HOST, g.id, true)]) {
      const err = await refusal(p)
      expect(err.code).toBe('exec_grant_missing')
      expect(err.message).toMatch(/did not revoke/)
      expect(err.message).not.toMatch(/the user revoked this/i)
    }
  })
})

describe('a revoke long ago says nothing about a later grant the file lost', () => {
  it('reads as missing, not as the user\'s revoke', async () => {
    const first = await grants.grant('t1', HOST, 'own-host')
    await grants.revokeGrant(first.id)
    const second = await grants.grant('t1', HOST, 'settings')
    // A copy from between the two (the revoke in it, the second grant not yet) replaced the file.
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as { grants: grants.ExecGrant[] }
    fs.writeFileSync(file, JSON.stringify({ ...s, grants: s.grants.filter((x) => x.id !== second.id) }))
    for (const p of [assertMayRead('t1', HOST, 'hx-1'), assertStillGranted('t1', HOST, second.id), assertStillGranted('t1', HOST, second.id, true), grantFor(CALLER, HOST, null)]) {
      const err = await refusal(p)
      expect(err.code).toBe('exec_grant_missing')
      expect(err.message).not.toMatch(/the user revoked/i)
    }
    // A read's next step is a new call, since a read never makes a grant.
    expect((await refusal(assertMayRead('t1', HOST, 'hx-1'))).message).toMatch(/A new host_exec call/)
    // Its runs may still be stopped and listed, and those answers do not say the user revoked it.
    await expect(mayTendRuns(CALLER, HOST)).resolves.toEqual({ revoked: false, grantId: null })
  })
})

describe('class: a refusal says "revoked" only where a revoke was read', () => {
  it('every exec_grant_revoked in src/core/hosts sits behind a revoke check', () => {
    const root = path.resolve(__dirname, '../../../src/core/hosts')
    const offenders: string[] = []
    for (const name of fs.readdirSync(root).filter((f) => f.endsWith('.ts'))) {
      const lines = fs.readFileSync(path.join(root, name), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!line.includes("'exec_grant_revoked'") || /isReadStop|err\.code ===/.test(line)) return
        // The check that read a revoke: within the few lines before the refusal (or on it).
        const before = lines.slice(Math.max(0, i - 6), i + 1).join('\n')
        if (!/revokedAt|wasRevoked\(|lastRevokedAt\(|why === 'revoked'|err\.why/.test(before)) offenders.push(`${name}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('every exec_host_closed in src is made by hostClosedError, which says when the closed list cannot be read', () => {
    const offenders: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts')) {
          fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
            if (/new HostExecError\([\s\S]*'exec_host_closed'/.test(line) && !line.includes("HostExecError(text, 403, 'exec_host_closed', details)")) offenders.push(`${path.relative(root, p)}:${i + 1}`)
          })
        }
      }
    }
    const root = path.resolve(__dirname, '../../../src')
    walk(root)
    // The one construction is hostClosedError's own, which reads the closed list's state first.
    expect(offenders).toEqual([])
    expect(fs.readFileSync(path.join(root, 'core/hosts/host-exec-grant.ts'), 'utf8')).toMatch(/return new HostExecError\(text, 403, 'exec_host_closed', details\)/)
  })
})

describe('a pull applying never lands between a grants write\'s check and its rename', () => {
  it('a grant written while the pull holds the write gate waits for it, then lands on top', async () => {
    const { closeWrites, openWrites } = await import('../../../src/utils/write-gate.js')
    expect(await closeWrites(1000)).toBe(true)
    let done = false
    const p = grants.grant('t1', HOST, 'own-host').then(() => { done = true })
    await new Promise((r) => setTimeout(r, 100))
    expect(done).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
    openWrites()
    await p
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).grants.map((g: grants.ExecGrant) => g.taskId)).toEqual(['t1'])
  })

  it('every write of the grants files reads, changes and renames under the gate', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../src/core/hosts/exec-grants.ts'), 'utf8')
    const renames = src.match(/fs\.promises\.rename\(/g) ?? []
    expect(renames.length).toBeGreaterThan(0)
    expect(src.match(/chain\.then\(\(\) => heldWrite\(async \(\) => \{/g)).toHaveLength(renames.length)
    expect(src.match(/\benterWrite\(/g)).toHaveLength(1)
  })

  it('a grants write that comes while a pull applies reads the file after the pull: a revoke the pull brought is kept', async () => {
    const { closeWrites, openWrites } = await import('../../../src/utils/write-gate.js')
    const g = await grants.grant('t1', HOST, 'own-host')
    expect(await closeWrites(5000)).toBe(true)
    // A write comes while the pull holds the gate: it waits, and has read nothing yet.
    const run = grants.noteRun(g.id, 'ls')
    await new Promise((r) => setTimeout(r, 50))
    // The pull lands a revoke made on another machine.
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    s.grants[0].revokedAt = 1000
    fs.writeFileSync(file, JSON.stringify(s))
    openWrites()
    await run
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).grants[0]).toMatchObject({ revokedAt: 1000, runs: 1 })
  })
})

describe('a file gone a minute is gone', () => {
  afterEach(() => { vi.useRealTimers() })

  it('the grants and the closed hosts survive a moment without their files, and read as none a minute on', async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    await grants.grant('t1', HOST, 'own-host')
    await grants.setHostClosed('macbox', true)
    const closedFile = file.replace(/\.json$/, '') + '-closed.json'
    fs.rmSync(file)
    fs.rmSync(closedFile)
    expect(grants.findGrant('t1', HOST)).toBeDefined()
    expect(grants.isHostClosed('macbox')).toBe(true)
    vi.setSystemTime(Date.now() + grants.MISSING_GRACE_MS + 1)
    expect(grants.findGrant('t1', HOST)).toBeUndefined()
    expect(grants.isHostClosed('macbox')).toBe(false)
    expect(grants.grantsFileState().readable).toBe(true)
  })
})
