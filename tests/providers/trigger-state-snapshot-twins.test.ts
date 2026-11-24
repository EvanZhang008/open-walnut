/**
 * Ratchet: triggers.state.snapshot (trigger-state-snapshot-v1) is wired into the daemon.
 * It dispatches the command, tracks running checks apart from the armed map (so a check
 * a configure disarmed mid-run still blocks a snapshot), takes every rule from
 * trigger-state-snapshot-core.ts, and never writes; the core is hashed in both version lists.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ADVERTISED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { daemonRuntimeText } from '../helpers/daemon-runtime-text.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8')
// The whole runtime: daemon-standalone.ts and its area modules (the commands are daemon-trigger-commands.ts).
const standaloneSrc = daemonRuntimeText()
/** The body of a named function, up to the next top-level function. */
function bodyOf(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  const next = src.slice(start + 1).search(/\n(?:async )?function /)
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next)
}

describe('trigger-state-snapshot-v1 in the daemon', () => {
  it('the daemon dispatches the command through the command drain', () => {
    expect(standaloneSrc).toMatch(/case 'triggers\.state\.snapshot': return daemonCommands\.run\(\(\) => triggerCommands\.cmdTriggersStateSnapshot\(ws, id as number, cmd\)\)/)
  })

  it('tracks running checks across a disarm, added before the spawn and removed in finally', () => {
    expect(standaloneSrc).toMatch(/const triggerChecksRunning = new Set/)
    const run = bodyOf(standaloneSrc, 'runTrigger')
    const added = run.indexOf('triggerChecksRunning.add(entry)')
    expect(added).toBeGreaterThan(-1)
    expect(added).toBeLessThan(run.indexOf('runCheckProcess('))
    expect(run).toMatch(/finally \{\s*entry\.running = false;?\s*triggerChecksRunning\.delete\(entry\);?\s*\}/)
  })

  it('takes every rule from the core, behind the configure gate, and never writes', () => {
    const cmd = bodyOf(standaloneSrc, 'cmdTriggersStateSnapshot')
    expect(cmd).toContain("triggersConfigureGate.run('triggers.configure'")
    expect(cmd).toMatch(/takeTriggerStateSnapshot\(\{/)
    expect(cmd).toMatch(/socketTriggerScope: ws\.data\?\.triggerScope/)
    expect(cmd).toMatch(/socketGatewayHome: gatewayClientHomes\.get\(ws\)/)
    expect(cmd).toMatch(/checkRunning: \[\.\.\.triggerChecksRunning\]/)
    expect(cmd).toMatch(/hostDeliveryInFlight: hostDeliveriesInFlight\.has\(key\)/)
    expect(cmd).toMatch(/statePath: \(h, tid\) => triggerStatePath\(h, tid\)/)
    // Read only: no persist, no state read that migrates or coerces, no script.
    for (const banned of ['persistTriggerState', 'readTriggerState', 'coerceHostState', 'emptyHostState', 'runCheckProcess', 'writeFileSync', 'renameSync', 'unlinkSync', 'utimesSync']) {
      expect(cmd, banned).not.toContain(banned)
    }
  })

  it('the daemon imports the core and advertises the capability', () => {
    expect(standaloneSrc).toMatch(/import \{ takeTriggerStateSnapshot \} from '\.\/trigger-state-snapshot-core\.js'/)
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('trigger-state-snapshot-v1')
  })

  it('the core is hashed in both version lists', () => {
    expect(read('scripts/build-daemon.sh')).toContain('src/providers/trigger-state-snapshot-core.ts')
    expect(read('src/providers/daemon-version-check.ts')).toContain("'src/providers/trigger-state-snapshot-core.ts'")
  })

  it('the commands are not reachable from the bridge or a follower', () => {
    for (const list of ['BRIDGE_ALLOWED_COMMANDS', 'FOLLOWER_ALLOWED_COMMANDS']) {
      const start = standaloneSrc.indexOf(`${list} = new Set([`)
      if (start === -1) continue
      expect(standaloneSrc.slice(start, standaloneSrc.indexOf('])', start)), list).not.toContain('triggers.state.snapshot')
      expect(standaloneSrc.slice(start, standaloneSrc.indexOf('])', start)), list).not.toContain('triggers.state.seed')
    }
  })
})

describe('trigger-state-seed-v1 in the daemon', () => {
  it('dispatches the command through the drain, refuses a foreign home, and takes every rule from the core behind the configure gate', () => {
    expect(standaloneSrc).toMatch(/case 'triggers\.state\.seed': return daemonCommands\.run\(\(\) => triggerCommands\.cmdTriggersStateSeed\(ws, id as number, cmd\)\)/)
    const cmd = bodyOf(standaloneSrc, 'cmdTriggersStateSeed')
    expect(cmd).toMatch(/refuseForeignHome\(ws, id, cmd, 'triggers\.state\.seed'\)/)
    expect(cmd).toContain("triggersConfigureGate.run('triggers.configure'")
    expect(cmd).toContain('seedTriggerState({')
    for (const fact of ['configured:', 'armed: armedTriggers.has(key)', 'draining: drainingTriggers.has(key)', 'checkRunning: [...triggerChecksRunning]', 'hostDeliveryInFlight: hostDeliveriesInFlight.has(key)']) {
      expect(cmd, fact).toContain(fact)
    }
    expect(cmd).toMatch(/statePath: \(h, tid\) => triggerStatePath\(h, tid\)/)
    // Every write is the core's: no persist, no coerced state read, no script.
    for (const banned of ['persistTriggerState', 'readTriggerState', 'coerceHostState', 'runCheckProcess', 'writeFileSync', 'renameSync']) {
      expect(cmd, banned).not.toContain(banned)
    }
  })

  it('the daemon imports the core and advertises the capability; both version lists hash it', () => {
    expect(standaloneSrc).toMatch(/import \{ seedTriggerState \} from '\.\/trigger-state-seed-core\.js'/)
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('trigger-state-seed-v1')
    expect(read('scripts/build-daemon.sh')).toContain('src/providers/trigger-state-seed-core.ts')
    expect(read('src/providers/daemon-version-check.ts')).toContain("'src/providers/trigger-state-seed-core.ts'")
  })
})
