/**
 * Follower reads never touch a place macOS guards (src/providers/follower-reads-core.ts deps.guarded).
 *
 * 2026-11-26: a host Mac's spawn journal named a session once run in ~/Desktop. The service's first
 * follower read built the ownership roots, and fs.realpathSync of that cwd opened ~/Desktop: the open
 * waited on the consent dialog it put on the screen, the whole loop with it, so the service wrote no
 * heartbeat and its launcher killed it 60 s later, at every start (`host_exec` there answered 503
 * meanwhile). Every guarded place is enumerated from MAC_PROTECTED_IN_HOME, so a place added to that
 * list is covered here without a new case.
 */
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { createFollowerReads } from '../../src/providers/follower-reads-core.js'
import { MAC_PROTECTED_IN_HOME, isMacGuarded } from '../../src/core/hosts/mac-places.js'

const HOME = '/Users/marina'
const A = '/fixture/marina-home'

function make(cwds: string[]) {
  const touched: string[] = []
  const journal = cwds.map((cwd, i) => JSON.stringify({ sid: `s${i}`, cwd })).join('\n') + '\n'
  const owners = Object.fromEntries(cwds.map((_, i) => [`s${i}`, A]))
  const r = createFollowerReads({
    path, homeDir: HOME,
    // Every path not guarded exists as itself; a guarded one must never get here.
    realpath: (p) => { touched.push(p); return p },
    guarded: (p) => isMacGuarded(p, HOME, 'darwin'),
    sliceOwner: (sid) => owners[sid], journalOwner: () => undefined,
    liveSessions: () => [{ sid: 'live', cwd: `${HOME}/work` }],
    journalSize: () => journal.length,
    readJournal: () => journal,
    replica: { list: () => null, read: () => null, readMany: () => null },
    log: () => {},
  })
  owners.live = A
  return { r, touched }
}

const guardedPlaces = [...MAC_PROTECTED_IN_HOME.map((p) => `${HOME}/${p}`), '/Volumes/Backup', `${HOME}/Pictures/Photos Library.photoslibrary`]

describe('a guarded place is never resolved on the loop', () => {
  it.each(guardedPlaces)('a session cwd in %s is no root, and nothing under it is opened', (place) => {
    const cwd = `${place}/project`
    const { r, touched } = make([cwd, `${HOME}/work`])
    // An ordinary read builds the roots (the journal's cwds included).
    expect('pass' in r.gate(A, { cmd: 'fs.read', path: `${HOME}/work/a.ts` })).toBe(true)
    // A read under the guarded cwd is not this Walnut's: refused, never resolved.
    expect('refuse' in r.gate(A, { cmd: 'fs.read', path: `${cwd}/a.ts` })).toBe(true)
    expect(touched.filter((p) => isMacGuarded(p, HOME, 'darwin'))).toEqual([])
  })

  it('folded case is the same place, as the Mac\'s disk compares (~/desktop is ~/Desktop)', () => {
    const { r, touched } = make([`${HOME}/desktop/oreo`])
    expect('refuse' in r.gate(A, { cmd: 'fs.read', path: `${HOME}/desktop/oreo/x` })).toBe(true)
    expect(touched.some((p) => p.toLowerCase().includes('/desktop'))).toBe(false)
  })

  it('a link into a guarded place is refused, and a shallower root of another Walnut never takes it', () => {
    const touched: string[] = []
    const B = '/fixture/acme-home'
    const r = createFollowerReads({
      path, homeDir: HOME,
      // ~/link resolves into ~/Desktop/proj (a symlink); everything else is itself.
      realpath: (p) => { touched.push(p); return p.startsWith(`${HOME}/link`) ? p.replace(`${HOME}/link`, `${HOME}/Desktop/proj`) : p },
      guarded: (p) => isMacGuarded(p, HOME, 'darwin'),
      sliceOwner: (sid) => (sid === 'sb' ? B : A), journalOwner: () => undefined,
      liveSessions: () => [{ sid: 'sa', cwd: `${HOME}/Desktop/proj` }, { sid: 'sb', cwd: HOME }],
      journalSize: () => -1, readJournal: () => '',
      replica: { list: () => null, read: () => null, readMany: () => null },
      log: () => {},
    })
    expect('refuse' in r.gate(B, { cmd: 'fs.read', path: `${HOME}/link/secret.txt` })).toBe(true)
    expect('pass' in r.gate(B, { cmd: 'fs.read', path: `${HOME}/notes.txt` })).toBe(true)
  })

  it('off a Mac nothing is guarded: a Desktop cwd is an ordinary root', () => {
    expect(isMacGuarded(`${HOME}/Desktop/x`, HOME, 'linux')).toBe(false)
    expect(isMacGuarded(`${HOME}/work/x`, HOME, 'darwin')).toBe(false)
  })
})
