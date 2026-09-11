/**
 * Regression tests for the `web --ephemeral` snapshot registry + reaper.
 *
 * The incident these pin (2026-08-27): 9.8G of snapshot dirs sat in /tmp for 5
 * days. Two independent causes, one test each below — the reaper could only see
 * the CURRENT os.tmpdir() (so a snapshot born under an overridden TMPDIR was
 * invisible forever), and a launcher killed mid-copy never wrote a control file
 * (so the pid-liveness branch could not judge it either).
 *
 * The second incident (2026-09-10): the fix for the first one deleted every
 * `open-walnut-*` directory in the tmp base that had no control file and was
 * older than an hour — which described the deploy script's stage directory for
 * the LIVE production server (`open-walnut-stage.<epoch>.<pid>`) and its rollback
 * snapshot (`open-walnut-lkg`). This suite itself used to be one of the
 * triggers: it called the reaper against the REAL os.tmpdir(), so any
 * `npm run test:quick` took production's web assets away. Every call below
 * therefore scans a private directory, and the reaper only ever deletes the
 * one directory shape the launcher creates.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  registryPath,
  readRegistry,
  registerEphemeralDir,
  unregisterEphemeralDir,
  reapStaleEphemeralDirs,
  countLiveEphemeralServers,
  isEphemeralSnapshotDir,
  EPHEMERAL_DIR_RE,
  REGISTRY_MAX_ROWS,
  REGISTRY_ROW_TTL_MS,
  NO_CONTROL_FILE_GRACE_MS,
} from '../../src/commands/ephemeral-registry.js'

let home: string
let elsewhere: string
/** Stands in for os.tmpdir(): the only directory the scan half may look at. */
let scanBase: string

/** A dead pid: claim our own child-less pid space by using an absurd value. */
const DEAD_PID = 2 ** 22

function makeSnapshot(parent: string, name: string, control?: { pid: number }): string {
  const dir = path.join(parent, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'payload.bin'), 'x'.repeat(1024))
  if (control) {
    fs.writeFileSync(path.join(dir, 'ephemeral.json'),
      JSON.stringify({ pid: control.pid, port: 1234, tmpDir: dir }))
  }
  return dir
}

function backdate(dir: string, ageMs: number): void {
  const old = (Date.now() - ageMs) / 1000
  fs.utimesSync(dir, old, old)
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-registry-home-'))
  // A location that is deliberately NOT under the scan base, standing in for the
  // TMPDIR=/tmp/<slug>/eph override that stranded the real 9.8G.
  elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-registry-elsewhere-'))
  scanBase = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-registry-scan-'))
})

afterEach(() => {
  for (const d of [home, elsewhere, scanBase]) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

describe('ephemeral registry', () => {
  it('stores the registry under WALNUT_HOME/tmp so snapshots never copy it', () => {
    // web.ts's snapshot filter excludes WALNUT_HOME/tmp; if the registry ever moved
    // out of there it would start copying itself into every snapshot.
    expect(registryPath(home)).toBe(path.join(home, 'tmp', 'ephemeral-registry.json'))
  })

  it('round-trips rows and drops one on unregister', () => {
    const reg = registryPath(home)
    registerEphemeralDir(reg, '/tmp/a')
    registerEphemeralDir(reg, '/tmp/b')
    expect(readRegistry(reg).map((r) => r.dir)).toEqual(['/tmp/a', '/tmp/b'])

    unregisterEphemeralDir(reg, '/tmp/a')
    expect(readRegistry(reg).map((r) => r.dir)).toEqual(['/tmp/b'])
  })

  it('treats a corrupt or absent registry as empty, never throwing', () => {
    const reg = registryPath(home)
    expect(readRegistry(reg)).toEqual([])          // absent

    fs.mkdirSync(path.dirname(reg), { recursive: true })
    fs.writeFileSync(reg, '{not json at all')
    expect(readRegistry(reg)).toEqual([])          // corrupt

    fs.writeFileSync(reg, '{"shape":"wrong"}')
    expect(readRegistry(reg)).toEqual([])          // not an array

    fs.writeFileSync(reg, '[{"dir":"/tmp/ok","launcherPid":1,"createdAt":1},{"junk":true}]')
    expect(readRegistry(reg).map((r) => r.dir)).toEqual(['/tmp/ok'])  // filters bad rows
  })

  it('caps the registry so a prune failure cannot grow it without bound', () => {
    const reg = registryPath(home)
    for (let i = 0; i < REGISTRY_MAX_ROWS + 25; i++) registerEphemeralDir(reg, `/tmp/d${i}`)
    const rows = readRegistry(reg)
    expect(rows.length).toBe(REGISTRY_MAX_ROWS)
    // Keeps the NEWEST rows — the oldest are the least likely to still exist.
    expect(rows[rows.length - 1].dir).toBe(`/tmp/d${REGISTRY_MAX_ROWS + 24}`)
  })
})

describe('snapshot dir shape', () => {
  it('matches exactly what the launcher creates: open-walnut-<ppid>-<6 mkdtemp chars>', () => {
    expect(isEphemeralSnapshotDir('/var/folders/x/T/open-walnut-1-0cvzgN')).toBe(true)
    expect(isEphemeralSnapshotDir('/tmp/open-walnut-48346-VaPPEv')).toBe(true)
    // The real mkdtemp output shape, end to end.
    const real = fs.mkdtempSync(path.join(scanBase, 'open-walnut-12345-'))
    expect(isEphemeralSnapshotDir(real)).toBe(true)
  })

  it('rejects every other open-walnut-* tenant of the tmp base', () => {
    for (const name of [
      'open-walnut-stage.1789069958.82644',  // dev-prod's live server dist
      'open-walnut-lkg',                     // dev-prod's rollback snapshot
      'open-walnut-test-runtime-10800',      // vitest runtime dirs
      'open-walnut-devprod-smoke.log',
      'open-walnut-dev-prod.last-success',
      'open-walnut-1-0cvzgN-extra',
      'open-walnut--0cvzgN',
      'open-walnut-1-0cvzg',                 // five chars, not six
    ]) {
      expect(EPHEMERAL_DIR_RE.test(name), name).toBe(false)
    }
  })
})

describe('reapStaleEphemeralDirs', () => {
  it('reaps a snapshot created outside the tmp base (the 9.8G incident)', () => {
    // THE regression: only the registry can find this dir. A tmp-base scan
    // cannot, which is why the real one survived 5 days and 4 ephemeral launches.
    const stranded = makeSnapshot(elsewhere, 'open-walnut-999-abcdef', { pid: DEAD_PID })
    registerEphemeralDir(registryPath(home), stranded)

    reapStaleEphemeralDirs(home, { tmpBase: scanBase })

    expect(fs.existsSync(stranded)).toBe(false)
    expect(readRegistry(registryPath(home))).toEqual([])
  })

  it('reaps a control-file-less dir past the grace period (killed mid-copy)', () => {
    // A launcher killed mid-cpSync never writes ephemeral.json, so the pid branch
    // cannot judge it. Age is the only signal left.
    const halfCopied = makeSnapshot(elsewhere, 'open-walnut-111-noCtrl')
    registerEphemeralDir(registryPath(home), halfCopied)
    backdate(halfCopied, NO_CONTROL_FILE_GRACE_MS + 60_000)

    reapStaleEphemeralDirs(home, { tmpBase: scanBase })

    expect(fs.existsSync(halfCopied)).toBe(false)
  })

  it('reaps an unregistered dead snapshot found by the tmp-base scan (pre-registry builds)', () => {
    const legacy = makeSnapshot(scanBase, 'open-walnut-222-legacy', { pid: DEAD_PID })

    reapStaleEphemeralDirs(home, { tmpBase: scanBase })

    expect(fs.existsSync(legacy)).toBe(false)
  })

  it('spares a fresh control-file-less dir (a launcher still copying right now)', () => {
    // Reaping this would delete the snapshot out from under a live launcher.
    const copying = makeSnapshot(elsewhere, 'open-walnut-222-inFlyt')
    registerEphemeralDir(registryPath(home), copying)

    reapStaleEphemeralDirs(home, { tmpBase: scanBase })

    expect(fs.existsSync(copying)).toBe(true)
    expect(readRegistry(registryPath(home)).map((r) => r.dir)).toEqual([copying])
  })

  it('spares a snapshot whose server is still alive', () => {
    const live = makeSnapshot(elsewhere, 'open-walnut-333-aLiveX', { pid: process.pid })
    registerEphemeralDir(registryPath(home), live)

    reapStaleEphemeralDirs(home, { tmpBase: scanBase })

    expect(fs.existsSync(live)).toBe(true)
  })

  // 2026-09-10: the live production server's staged dist and its rollback
  // snapshot share the tmp base and the `open-walnut-` prefix, have no
  // ephemeral.json, and are always older than an hour by the time anyone runs
  // an ephemeral launch or this test tier. They must never be candidates.
  it('never touches other open-walnut-* tenants of the tmp base, however stale', () => {
    const stage = path.join(scanBase, 'open-walnut-stage.1789069958.82644')
    const lkg = path.join(scanBase, 'open-walnut-lkg')
    const runtime = path.join(scanBase, 'open-walnut-test-runtime-10800')
    // On Linux os.tmpdir() IS /tmp, where the daemon keeps the session JSONLs:
    // the only copy of every conversation. The old prefix scan would have taken it.
    const streams = path.join(scanBase, 'open-walnut-streams')
    for (const d of [stage, lkg, runtime, streams]) {
      fs.mkdirSync(path.join(d, 'dist', 'web', 'static'), { recursive: true })
      fs.writeFileSync(path.join(d, 'dist', 'web', 'static', 'index.html'), '<html/>')
      backdate(d, NO_CONTROL_FILE_GRACE_MS * 48)
    }
    // A genuine dead snapshot next to them still goes, proving the reaper ran.
    const dead = makeSnapshot(scanBase, 'open-walnut-444-deadXx', { pid: DEAD_PID })

    reapStaleEphemeralDirs(home, { tmpBase: scanBase })

    expect(fs.existsSync(dead)).toBe(false)
    for (const d of [stage, lkg, runtime, streams]) {
      expect(fs.existsSync(path.join(d, 'dist', 'web', 'static', 'index.html')), d).toBe(true)
    }
  })

  it('never deletes a registry row that names a non-snapshot path; the row is dropped instead', () => {
    // A registry is a hint written by an earlier build. If one ever pointed at
    // a real directory (a bug, a hand edit, a different tool's file), the reaper
    // must not turn that into `rm -rf` of user data.
    const notOurs = path.join(elsewhere, 'notes')
    fs.mkdirSync(notOurs, { recursive: true })
    fs.writeFileSync(path.join(notOurs, 'important.md'), '# keep me')
    backdate(notOurs, NO_CONTROL_FILE_GRACE_MS * 48)
    const reg = registryPath(home)
    registerEphemeralDir(reg, notOurs)
    registerEphemeralDir(reg, elsewhere)

    reapStaleEphemeralDirs(home, { tmpBase: scanBase })

    expect(fs.existsSync(path.join(notOurs, 'important.md'))).toBe(true)
    expect(fs.existsSync(elsewhere)).toBe(true)
    expect(readRegistry(reg)).toEqual([])
  })

  it('prunes rows for dirs that vanished on their own', () => {
    // The child cleans up its own snapshot on graceful shutdown, leaving a row
    // pointing at nothing. That row must not accumulate forever.
    const reg = registryPath(home)
    const gone = path.join(elsewhere, 'open-walnut-444-goneXx')
    registerEphemeralDir(reg, gone)

    reapStaleEphemeralDirs(home, { tmpBase: scanBase })

    expect(readRegistry(reg)).toEqual([])
  })

  it('expires rows older than the TTL even if the dir somehow persists', () => {
    const reg = registryPath(home)
    const live = makeSnapshot(elsewhere, 'open-walnut-555-oldOne', { pid: process.pid })
    fs.mkdirSync(path.dirname(reg), { recursive: true })
    fs.writeFileSync(reg, JSON.stringify([
      { dir: live, launcherPid: 1, createdAt: Date.now() - (REGISTRY_ROW_TTL_MS + 60_000) },
    ]))

    reapStaleEphemeralDirs(home, { tmpBase: scanBase })

    expect(readRegistry(reg)).toEqual([])
    expect(fs.existsSync(live)).toBe(true)  // row expired, dir left alone
  })
})

describe('countLiveEphemeralServers', () => {
  it('counts servers outside the tmp base so the concurrency cap holds', () => {
    // Counting only the tmp base under-reports, letting more than the limit run.
    const live = makeSnapshot(elsewhere, 'open-walnut-666-aLiveX', { pid: process.pid })
    registerEphemeralDir(registryPath(home), live)

    expect(countLiveEphemeralServers(home, { tmpBase: scanBase })).toBe(1)
  })

  it('does not count a dead server or a dir with no control file', () => {
    registerEphemeralDir(registryPath(home),
      makeSnapshot(elsewhere, 'open-walnut-777-deadXx', { pid: DEAD_PID }))
    registerEphemeralDir(registryPath(home),
      makeSnapshot(elsewhere, 'open-walnut-888-noCtrl'))

    expect(countLiveEphemeralServers(home, { tmpBase: scanBase })).toBe(0)
  })

  it('dedupes by pid when the registry and the tmp-base scan name the same server', () => {
    // Both candidate sources can yield the same dir; a naive count would double it.
    const reg = registryPath(home)
    const inTmp = makeSnapshot(scanBase, 'open-walnut-999-dedupe', { pid: process.pid })
    registerEphemeralDir(reg, inTmp)
    expect(countLiveEphemeralServers(home, { tmpBase: scanBase })).toBe(1)
  })
})
