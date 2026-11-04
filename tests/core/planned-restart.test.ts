import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PLANNED_RESTART_TTL_MS, parsePlannedRestart, plannedRestartFile, takePlannedRestart, writePlannedRestart,
} from '../../src/core/planned-restart.js'

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
