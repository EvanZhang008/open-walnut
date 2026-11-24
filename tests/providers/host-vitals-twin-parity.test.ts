/**
 * Host vitals ('host-vitals-v1', `host.vitals`) in the daemon: daemon-standalone.ts
 * imports host-vitals-core.ts. This pins the wiring (command, capability, bridge and
 * follower exclusion, version/build lists, the ledger directory and its start at
 * boot) and runs the core against a real ledger.
 */
import { afterAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHostVitals, type HostVitalsDeps } from '../../src/providers/host-vitals-core.js'
import { ADVERTISED_DAEMON_CAPABILITIES, REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { readTwinText, twinText } from '../helpers/standalone-twin-text.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => twinText(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'))
// The whole runtime: the vitals ledger is created in daemon-host-transfer.ts.
const standalone = readTwinText('src/providers/daemon-standalone.ts')
const CORE = 'src/providers/host-vitals-core.ts'

function setLiteral(src: string, name: string): string {
  const start = src.indexOf(name + ' = new Set([')
  expect(start, name).toBeGreaterThan(0)
  const end = src.indexOf('])', start)
  return src.slice(start, end).split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
}

describe('host vitals daemon wiring', () => {
  it('the daemon dispatches host.vitals, starts the ledger at boot and keeps it under HOME', () => {
    expect(standalone).toContain("case 'host.vitals':")
    expect(standalone).toMatch(/hostVitals\.start\(\);?\n\s+(console\.log\(port\)|(if \(LISTEN\) )?options\.onListening\?\.\(port\))/)
    expect(standalone).toContain("path.join(HOME_DIR, '.open-walnut', 'tmp', 'host-vitals')")
    expect(standalone).toContain("path.join(DAEMON_DIR, 'host-vitals')")
  })

  it('the capability is advertised, not required', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('host-vitals-v1')
    expect(REQUIRED_DAEMON_CAPABILITIES as readonly string[]).not.toContain('host-vitals-v1')
  })

  it('the command is not reachable over the bridge or from a follower', () => {
    expect(setLiteral(standalone, 'BRIDGE_ALLOWED_COMMANDS')).not.toContain("'host.vitals'")
    expect(setLiteral(standalone, 'FOLLOWER_ALLOWED_COMMANDS')).not.toContain("'host.vitals'")
  })

  it('the core is in the version hash list and the binary build list, right after host facts', () => {
    const versionList = read('src/providers/daemon-version-check.ts')
    const build = read('scripts/build-daemon.sh')
    expect(versionList).toContain(`'${CORE}'`)
    expect(build).toContain(CORE)
    expect(versionList.indexOf('host-facts-core.ts')).toBeLessThan(versionList.indexOf(CORE))
    expect(build.indexOf('host-facts-core.ts')).toBeLessThan(build.indexOf(CORE))
  })
})

describe('the vitals core keeps a ledger', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-vitals-twin-')))
  afterAll(() => { if (tmp.includes('walnut-vitals-twin-')) fs.rmSync(tmp, { recursive: true, force: true }) })
  const T0 = Date.UTC(2026, 9, 20, 6)

  // A host with none of the tools: each command fails at once. A stub that never called back
  // left every GPU read (nvidia-smi, ioreg) to its 8 s timeout, four of them a test, and the
  // test ran 32 s, past the quick tier's 30 s (2026-11-01, runs 41283845821 and 41287770979:
  // the timeout reads "STACK_TRACE_ERROR" in the report).
  const noTool: HostVitalsDeps['execFile'] = (_file, _args, _opts, cb) => {
    cb(Object.assign(new Error('not installed'), { code: 'ENOENT' }), '', '')
    return null
  }

  async function run(factory: typeof createHostVitals, name: string) {
    const clock = { t: T0 }
    const deps: HostVitalsDeps = {
      fs, os, execFile: noTool, platform: process.platform === 'darwin' ? 'darwin' : 'linux',
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

  it('tick and vitals answer from the ledger', async () => {
    const began = Date.now()
    const imported = await run(createHostVitals, 'imported')
    // Nothing here waits on a real command: well inside the 30 s test timeout on any runner.
    expect(Date.now() - began).toBeLessThan(10_000)
    expect(imported.lines).toHaveLength(10)
    expect(imported.windows[0]).toMatchObject({ days: 1, minutes: 10, up: 10, linked: 5, drops: 1 })
    expect(imported.memKnown).toBe(true)
  })
})
