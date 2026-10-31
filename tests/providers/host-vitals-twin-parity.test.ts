/**
 * Host vitals ('host-vitals-v1', `host.vitals`) are wired the same way in both
 * daemon twins: the bun binary imports host-vitals-core.ts, the JS source twin
 * inlines its factory as text. This pins the wiring (command, capability,
 * bridge and follower exclusion, version/build lists, the ledger directory and
 * its start at boot) and runs the INLINED text against a real ledger, so a
 * factory that grew a module-scope reference fails here instead of on a host.
 */
import { afterAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vm from 'node:vm'
import { createHostVitals, type HostVitalsDeps } from '../../src/providers/host-vitals-core.js'
import { ADVERTISED_DAEMON_CAPABILITIES, REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const standalone = read('src/providers/daemon-standalone.ts')
const source = read('src/providers/daemon-source.ts')
const CORE = 'src/providers/host-vitals-core.ts'

function setLiteral(src: string, name: string): string {
  const start = src.indexOf(name + ' = new Set([')
  expect(start, name).toBeGreaterThan(0)
  const end = src.indexOf('])', start)
  return src.slice(start, end).split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
}

describe('host vitals twin wiring', () => {
  it('both twins dispatch host.vitals, start the ledger at boot and keep it under HOME', () => {
    for (const src of [standalone, source]) {
      expect(src).toContain("case 'host.vitals':")
      expect(src).toMatch(/hostVitals\.start\(\);?\n\s+console\.log\(port\)/)
      expect(src).toContain("path.join(HOME_DIR, '.open-walnut', 'tmp', 'host-vitals')")
      expect(src).toContain("path.join(DAEMON_DIR, 'host-vitals')")
    }
  })

  it('the capability is advertised, not required', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('host-vitals-v1')
    expect(REQUIRED_DAEMON_CAPABILITIES as readonly string[]).not.toContain('host-vitals-v1')
  })

  it('the command is not reachable over the bridge or from a follower', () => {
    for (const src of [standalone, source]) {
      expect(setLiteral(src, 'BRIDGE_ALLOWED_COMMANDS')).not.toContain("'host.vitals'")
      expect(setLiteral(src, 'FOLLOWER_ALLOWED_COMMANDS')).not.toContain("'host.vitals'")
    }
  })

  it('the core is in the version hash list and the binary build list, right after host facts', () => {
    const versionList = read('src/providers/daemon-version-check.ts')
    const build = read('scripts/build-daemon.sh')
    expect(versionList).toContain(`'${CORE}'`)
    expect(build).toContain(CORE)
    expect(versionList.indexOf('host-facts-core.ts')).toBeLessThan(versionList.indexOf(CORE))
    expect(build.indexOf('host-facts-core.ts')).toBeLessThan(build.indexOf(CORE))
  })

  it('the source twin inlines the factory once and still parses', () => {
    expect(source).toContain("['__CREATE_HOST_VITALS__', createHostVitals.toString()]")
    const out = getDaemonSource()
    expect(out).not.toContain('__CREATE_HOST_VITALS__')
    expect(() => new vm.Script(out, { filename: 'daemon-source.js' })).not.toThrow()
    expect(createHostVitals.toString()).not.toContain('`')
  })
})

describe('the inlined factory behaves like the imported one', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-vitals-twin-')))
  afterAll(() => { if (tmp.includes('walnut-vitals-twin-')) fs.rmSync(tmp, { recursive: true, force: true }) })
  const strict = <T>(fn: T): T => new Function('"use strict"; return (' + String(fn) + ')')() as T
  const T0 = Date.UTC(2026, 9, 20, 6)

  async function run(factory: typeof createHostVitals, name: string) {
    const clock = { t: T0 }
    const deps: HostVitalsDeps = {
      fs, os, execFile: () => null, platform: process.platform === 'darwin' ? 'darwin' : 'linux',
      dir: path.join(tmp, name), startedAt: T0 - 60_000, linked: () => clock.t < T0 + 5 * 60_000, running: () => 4,
      now: () => clock.t,
    }
    const v = factory(deps)
    for (let i = 0; i < 10; i++) { await v.tick(); clock.t += 60_000 }
    const r = await v.vitals({ days: 1 })
    return {
      lines: fs.readFileSync(path.join(tmp, name, '2026-10-20.jsonl'), 'utf8').trim().split('\n').map((l) => { const o = JSON.parse(l); return [o.m, o.c, o.s, o.d] }),
      windows: r.history.windows,
      outages: r.history.outages,
      coverageFrom: r.history.coverageFrom,
      buckets: r.history.buckets.length,
      memKnown: r.stats.memAvailBytes !== null,
    }
  }

  it('tick and vitals give the same answers', async () => {
    const imported = await run(createHostVitals, 'imported')
    const inlined = await run(strict(createHostVitals), 'inlined')
    expect(imported.lines).toHaveLength(10)
    expect(imported.windows[0]).toMatchObject({ days: 1, minutes: 10, up: 10, linked: 5, drops: 1 })
    expect(imported.memKnown).toBe(true)
    expect(inlined).toEqual(imported)
  })
})
