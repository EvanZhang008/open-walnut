import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  PLANNED_RESTART_TTL_MS, lastPlannedStopFile, parsePlannedRestart, plannedRestartFile, plannedRestartReasons,
  readLastPlannedStop, sameBuildRestartReasons, takePlannedRestart, writePlannedRestart,
} from '../../src/core/planned-restart.js'
import { markServerStopping, noteServerStopReason, resetServerStopping, serverStopWords } from '../../src/core/server-stopping.js'

const ROOT = path.resolve(__dirname, '../..')

let home = ''
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-planned-')) })
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

describe('planned-restart marker', () => {
  it('is written in local/ (never synced) and taken once: read, then removed', async () => {
    const now = Date.parse('2026-11-04T06:52:21.000Z')
    await writePlannedRestart(home, { reason: 'companion-update', build: '0.9.1-abc123def' }, now)
    const file = plannedRestartFile(home)
    expect(file).toBe(path.join(home, 'local', 'planned-restart.json'))
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ at: '2026-11-04T06:52:21.000Z', reason: 'companion-update', build: '0.9.1-abc123def' })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(await takePlannedRestart(home, now + 1000)).toEqual({ at: now, reason: 'companion-update', build: '0.9.1-abc123def' })
    expect(fs.existsSync(file)).toBe(false)
    expect(await takePlannedRestart(home, now + 2000)).toBeNull()
  })

  it('says nothing when absent, stale, from the future, garbage, or of an unknown reason, and removes what it found', async () => {
    const now = Date.parse('2026-11-04T06:52:21.000Z')
    expect(await takePlannedRestart(home, now)).toBeNull()
    for (const raw of [
      JSON.stringify({ at: new Date(now - PLANNED_RESTART_TTL_MS - 1).toISOString(), reason: 'deploy' }),
      JSON.stringify({ at: new Date(now + 120_000).toISOString(), reason: 'deploy' }),
      JSON.stringify({ at: new Date(now).toISOString(), reason: 'because' }),
      '{ not json',
    ]) {
      fs.mkdirSync(path.join(home, 'local'), { recursive: true })
      fs.writeFileSync(plannedRestartFile(home), raw)
      expect(await takePlannedRestart(home, now), raw).toBeNull()
      expect(fs.existsSync(plannedRestartFile(home))).toBe(false)
    }
  })

  it('reads the deploy script\'s shape: whole-second ISO, an empty build, a numeric at', () => {
    const now = Date.parse('2026-11-04T06:52:30.000Z')
    expect(parsePlannedRestart('{"at":"2026-11-04T06:52:21Z","reason":"deploy","build":""}\n', now))
      .toEqual({ at: Date.parse('2026-11-04T06:52:21Z'), reason: 'deploy' })
    expect(parsePlannedRestart(JSON.stringify({ at: now - 5, reason: 'deploy', build: 'a1b2c3d4e' }), now))
      .toEqual({ at: now - 5, reason: 'deploy', build: 'a1b2c3d4e' })
    expect(parsePlannedRestart(JSON.stringify({ at: now, reason: 'deploy', build: 'x y/../z' }), now)).toEqual({ at: now, reason: 'deploy' })
  })
})

describe('the last planned stop', () => {
  it('the stopping server\'s take records what it took, with its own pid; a plain take records nothing', async () => {
    const now = Date.parse('2026-11-20T20:28:35.000Z')
    await writePlannedRestart(home, { reason: 'app-update' }, now)
    expect(await takePlannedRestart(home, now + 10)).toEqual({ at: now, reason: 'app-update' })
    expect(fs.existsSync(lastPlannedStopFile(home))).toBe(false)
    expect(await readLastPlannedStop(home)).toBeNull()

    await writePlannedRestart(home, { reason: 'app-update' }, now)
    await takePlannedRestart(home, now + 20, { stopping: true })
    expect(await readLastPlannedStop(home)).toEqual({ reason: 'app-update', pid: process.pid, takenAt: now + 20 })
    expect(fs.statSync(lastPlannedStopFile(home)).mode & 0o777).toBe(0o600)
    // A stop with no marker (a crash, a bare SIGTERM) leaves the older record as it was: the
    // next boot matches it to the server that recorded it, and that one is not the last boot.
    expect(await takePlannedRestart(home, now + 30, { stopping: true })).toBeNull()
    expect((await readLastPlannedStop(home))?.takenAt).toBe(now + 20)
  })

  it('the record keeps the build a deploy\'s marker named, so the next boot can tell whether that deploy took', async () => {
    const now = Date.parse('2026-11-25T04:48:21.000Z')
    await writePlannedRestart(home, { reason: 'deploy', build: 'fab039c49' }, now)
    await takePlannedRestart(home, now + 5, { stopping: true })
    expect(await readLastPlannedStop(home)).toEqual({ reason: 'deploy', pid: process.pid, takenAt: now + 5, build: 'fab039c49' })
    // A record an older Walnut wrote has no build, and reads as before.
    fs.writeFileSync(lastPlannedStopFile(home), JSON.stringify({ reason: 'deploy', pid: 7, takenAt: now }))
    expect(await readLastPlannedStop(home)).toEqual({ reason: 'deploy', pid: 7, takenAt: now })
    fs.writeFileSync(lastPlannedStopFile(home), JSON.stringify({ reason: 'deploy', pid: 7, takenAt: now, build: 'no spaces allowed' }))
    expect(await readLastPlannedStop(home)).toEqual({ reason: 'deploy', pid: 7, takenAt: now })
  })

  it('a starting server\'s sweep of a fresh marker nobody took records it with pid 0', async () => {
    const now = Date.parse('2026-11-21T08:52:29.000Z')
    await writePlannedRestart(home, { reason: 'app-update' }, now)
    await takePlannedRestart(home, now + 15_000, { atBoot: true })
    expect(await readLastPlannedStop(home)).toEqual({ reason: 'app-update', pid: 0, takenAt: now })
    expect(fs.existsSync(plannedRestartFile(home))).toBe(false)
  })

  it('reads nothing from a missing, garbled or foreign record', async () => {
    expect(await readLastPlannedStop(home)).toBeNull()
    fs.mkdirSync(path.join(home, 'local'), { recursive: true })
    for (const raw of ['{ nope', '{"reason":"because","pid":1,"takenAt":1}', '{"reason":"deploy","pid":"1","takenAt":1}', '{"reason":"deploy","pid":1}', '{"reason":"deploy","pid":-1,"takenAt":1}']) {
      fs.writeFileSync(lastPlannedStopFile(home), raw)
      expect(await readLastPlannedStop(home), raw).toBeNull()
    }
  })
})

// The class: every tool that stops the server on purpose leaves a marker, and every marker's
// reason is one the server knows, words for and a decision on whether it comes back on its
// build. A new writer or a new reason fails here until it is decided (2026-11-20: Mac app
// updates stopped the server with none, and the server.restarts alarm counted them).
describe('every planned restart reason is known everywhere', () => {
  it('each reason has words for the work a stop cuts short, and a stated build expectation', () => {
    const newBuild = ['deploy', 'companion-update']
    try {
      for (const reason of plannedRestartReasons) {
        resetServerStopping(); markServerStopping(); noteServerStopReason(reason)
        expect(serverStopWords(), reason).not.toBe('')
        expect(newBuild.includes(reason) !== sameBuildRestartReasons.includes(reason), `${reason}: list it in newBuild here or in sameBuildRestartReasons`).toBe(true)
      }
    } finally { resetServerStopping() }
  })

  it('every writer of the marker in the repo writes a known reason', () => {
    const files = execFileSync('git', ['grep', '-l', 'planned-restart.json', '--', 'scripts', 'desktop', 'src'], { cwd: ROOT, encoding: 'utf8' })
      // The module itself and the data-home manifest only name the file.
      .split('\n').filter((f) => f && f !== 'src/core/planned-restart.ts' && !f.startsWith('src/core/home-manifest/'))
    expect(files.sort()).toEqual(['desktop/AppUpdateBridge.swift', 'desktop/apply-update.sh', 'scripts/dev-prod.sh'])
    for (const f of files) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
      const reasons = [...text.matchAll(/\\?"reason\\?":\s*\\?"([a-z-]+)\\?"/g)].map((m) => m[1]!)
      expect(reasons.length, `${f} writes a reason`).toBeGreaterThan(0)
      for (const r of reasons) expect(plannedRestartReasons as readonly string[], `${f}: ${r}`).toContain(r)
    }
  })

  // Every way the Mac app stops a server or quits for another app is listed with what it does
  // about the marker: a new one fails here until someone decides it. The app's own quit and a
  // person's Retry or Reset stay restarts that count.
  it('every way the Mac app stops a server is decided: an update writes the marker first', () => {
    const decided: Record<string, 'writes the marker' | 'counted'> = {
      'AppUpdateBridge.swift:stopServerForUpdate': 'writes the marker',
      'DesktopUpdateBridge.swift:restart': 'writes the marker',
      'main.swift:applicationWillTerminate': 'counted',
      'main.swift:retryStart': 'counted',
      'main.swift:resetConfig': 'counted',
    }
    const found: string[] = []
    for (const file of fs.readdirSync(path.join(ROOT, 'desktop')).filter((f) => f.endsWith('.swift'))) {
      const text = fs.readFileSync(path.join(ROOT, 'desktop', file), 'utf8')
      for (const m of text.matchAll(/(?<!func )\bstopServer\(\)|\bapp\.terminate\(\)/g)) {
        const before = text.slice(0, m.index)
        const fn = [...before.matchAll(/\bfunc (\w+)\(/g)].pop()?.[1] ?? '?'
        const key = `${file}:${fn}`
        found.push(key)
        if (decided[key] !== 'writes the marker') continue
        const body = text.slice(before.lastIndexOf(`func ${fn}(`), m.index)
        expect(body, `${key} writes the marker before it stops the server`).toContain('writeAppUpdatePlannedRestart(')
      }
    }
    expect([...new Set(found)].sort()).toEqual(Object.keys(decided).sort())
  })

  it('apply-update.sh writes the marker before it ends a host, and by hand before the new app opens', () => {
    const sh = fs.readFileSync(path.join(ROOT, 'desktop/apply-update.sh'), 'utf8')
    const hosts = sh.indexOf('ending the session hosts of the old app')
    expect(sh.lastIndexOf('write_planned_restart', hosts)).toBeGreaterThan(sh.indexOf('if [ -n "$old_hosts" ]'))
    const opens = sh.lastIndexOf('"$open_app" $open_flags "$target"')
    expect(sh.slice(sh.lastIndexOf('say "updated $target"', opens), opens)).toContain('[ "$pid" = 0 ] && [ -z "$old_hosts" ] && write_planned_restart')
  })
})
