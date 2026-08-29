/**
 * Regression tests for the `web --ephemeral` snapshot registry + reaper.
 *
 * The incident these pin (2026-08-27): 9.8G of snapshot dirs sat in /tmp for 5
 * days. Two independent causes, one test each below — the reaper could only see
 * the CURRENT os.tmpdir() (so a snapshot born under an overridden TMPDIR was
 * invisible forever), and a launcher killed mid-copy never wrote a control file
 * (so the pid-liveness branch could not judge it either).
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
  REGISTRY_MAX_ROWS,
  REGISTRY_ROW_TTL_MS,
  NO_CONTROL_FILE_GRACE_MS,
} from '../../src/commands/ephemeral-registry.js'

let home: string
let elsewhere: string

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

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-registry-home-'))
  // A location that is deliberately NOT under os.tmpdir()'s scan reach, standing
  // in for the TMPDIR=/tmp/<slug>/eph override that stranded the real 9.8G.
  elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-registry-elsewhere-'))
})

afterEach(() => {
  for (const d of [home, elsewhere]) {
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

describe('reapStaleEphemeralDirs', () => {
  it('reaps a snapshot created outside os.tmpdir() (the 9.8G incident)', () => {
    // THE regression: only the registry can find this dir. An os.tmpdir() scan
    // cannot, which is why the real one survived 5 days and 4 ephemeral launches.
    const stranded = makeSnapshot(elsewhere, 'open-walnut-999-abcdef', { pid: DEAD_PID })
    registerEphemeralDir(registryPath(home), stranded)

    reapStaleEphemeralDirs(home)

    expect(fs.existsSync(stranded)).toBe(false)
    expect(readRegistry(registryPath(home))).toEqual([])
  })

  it('reaps a control-file-less dir past the grace period (killed mid-copy)', () => {
    // A launcher killed mid-cpSync never writes ephemeral.json, so the pid branch
    // cannot judge it. Age is the only signal left.
    const halfCopied = makeSnapshot(elsewhere, 'open-walnut-111-nocontrol')
    registerEphemeralDir(registryPath(home), halfCopied)
    const old = Date.now() - (NO_CONTROL_FILE_GRACE_MS + 60_000)
    fs.utimesSync(halfCopied, old / 1000, old / 1000)

    reapStaleEphemeralDirs(home)

    expect(fs.existsSync(halfCopied)).toBe(false)
  })

  it('spares a fresh control-file-less dir (a launcher still copying right now)', () => {
    // Reaping this would delete the snapshot out from under a live launcher.
    const copying = makeSnapshot(elsewhere, 'open-walnut-222-inflight')
    registerEphemeralDir(registryPath(home), copying)

    reapStaleEphemeralDirs(home)

    expect(fs.existsSync(copying)).toBe(true)
    expect(readRegistry(registryPath(home)).map((r) => r.dir)).toEqual([copying])
  })

  it('spares a snapshot whose server is still alive', () => {
    const live = makeSnapshot(elsewhere, 'open-walnut-333-live', { pid: process.pid })
    registerEphemeralDir(registryPath(home), live)

    reapStaleEphemeralDirs(home)

    expect(fs.existsSync(live)).toBe(true)
  })

  it('prunes rows for dirs that vanished on their own', () => {
    // The child cleans up its own snapshot on graceful shutdown, leaving a row
    // pointing at nothing. That row must not accumulate forever.
    const reg = registryPath(home)
    const gone = path.join(elsewhere, 'open-walnut-444-alreadygone')
    registerEphemeralDir(reg, gone)

    reapStaleEphemeralDirs(home)

    expect(readRegistry(reg)).toEqual([])
  })

  it('expires rows older than the TTL even if the dir somehow persists', () => {
    const reg = registryPath(home)
    const live = makeSnapshot(elsewhere, 'open-walnut-555-ancient', { pid: process.pid })
    fs.mkdirSync(path.dirname(reg), { recursive: true })
    fs.writeFileSync(reg, JSON.stringify([
      { dir: live, launcherPid: 1, createdAt: Date.now() - (REGISTRY_ROW_TTL_MS + 60_000) },
    ]))

    reapStaleEphemeralDirs(home)

    expect(readRegistry(reg)).toEqual([])
    expect(fs.existsSync(live)).toBe(true)  // row expired, dir left alone
  })
})

describe('countLiveEphemeralServers', () => {
  it('counts servers outside os.tmpdir() so the concurrency cap holds', () => {
    // Counting only os.tmpdir() under-reports, letting more than the limit run.
    const live = makeSnapshot(elsewhere, 'open-walnut-666-live', { pid: process.pid })
    registerEphemeralDir(registryPath(home), live)

    expect(countLiveEphemeralServers(home)).toBe(1)
  })

  it('does not count a dead server or a dir with no control file', () => {
    registerEphemeralDir(registryPath(home),
      makeSnapshot(elsewhere, 'open-walnut-777-dead', { pid: DEAD_PID }))
    registerEphemeralDir(registryPath(home),
      makeSnapshot(elsewhere, 'open-walnut-888-nocontrol'))

    expect(countLiveEphemeralServers(home)).toBe(0)
  })

  it('dedupes by pid when the registry and the tmpdir scan name the same server', () => {
    // Both candidate sources can yield the same dir; a naive count would double it.
    const reg = registryPath(home)
    const inTmp = makeSnapshot(os.tmpdir(), `open-walnut-dedupe-${process.pid}`, { pid: process.pid })
    try {
      registerEphemeralDir(reg, inTmp)
      expect(countLiveEphemeralServers(home)).toBe(1)
    } finally {
      fs.rmSync(inTmp, { recursive: true, force: true })
    }
  })
})
