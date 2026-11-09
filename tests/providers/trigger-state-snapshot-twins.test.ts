/**
 * Ratchet: triggers.state.snapshot (trigger-state-snapshot-v1) is wired the same way
 * in both daemon twins. Each dispatches the command, tracks running checks apart from
 * the armed map (so a check a configure disarmed mid-run still blocks a snapshot),
 * takes every rule from trigger-state-snapshot-core.ts, and never writes. The source
 * twin advertises the capability only when its sidecar carries the rules, so an old
 * sidecar fails closed; the core is hashed in both version lists.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ADVERTISED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8')
const standaloneSrc = read('src/providers/daemon-standalone.ts')
const templateSrc = read('src/providers/daemon-source.ts')

/** The body of a named function, up to the next top-level function. */
function bodyOf(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  const next = src.slice(start + 1).search(/\n(?:async )?function /)
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next)
}

describe('trigger-state-snapshot-v1 twins', () => {
  it('both twins dispatch the command through the command drain', () => {
    expect(standaloneSrc).toMatch(/case 'triggers\.state\.snapshot': return daemonCommands\.run\(\(\) => cmdTriggersStateSnapshot\(ws, id as number, cmd\)\)/)
    expect(templateSrc).toMatch(/case 'triggers\.state\.snapshot': return daemonCommands\.run\(function \(\) \{ return cmdTriggersStateSnapshot\(ws, id, cmd\); \}\)/)
  })

  it('both track running checks across a disarm, added before the spawn and removed in finally', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/(?:const|var) triggerChecksRunning = new Set/)
      const run = bodyOf(src, 'runTrigger')
      const added = run.indexOf('triggerChecksRunning.add(entry)')
      expect(added).toBeGreaterThan(-1)
      expect(added).toBeLessThan(run.indexOf('runCheckProcess('))
      expect(run).toMatch(/finally \{\s*entry\.running = false;?\s*triggerChecksRunning\.delete\(entry\);?\s*\}/)
    }
  })

  it('both take every rule from the core, behind the configure gate, and never write', () => {
    for (const [src, gate] of [[standaloneSrc, 'triggersConfigureGate'], [templateSrc, 'sessionStartGate']] as const) {
      const cmd = bodyOf(src, 'cmdTriggersStateSnapshot')
      expect(cmd).toContain(`${gate}.run('triggers.configure'`)
      expect(cmd).toMatch(/takeTriggerStateSnapshot\(\{/)
      expect(cmd).toMatch(/socketTriggerScope: ws(?:\.data\?)?\.triggerScope/)
      expect(cmd).toMatch(/socketGatewayHome: gatewayClientHomes\.get\(ws\)/)
      expect(cmd).toMatch(/checkRunning: \[\.\.\.triggerChecksRunning\]/)
      expect(cmd).toMatch(/hostDeliveryInFlight: hostDeliveriesInFlight\.has\(key\)/)
      expect(cmd).toMatch(/statePath: (?:\(h, tid\) => |function \(h, tid\) \{ return )triggerStatePath\(h, tid\)/)
      // Read only: no persist, no state read that migrates or coerces, no script.
      for (const banned of ['persistTriggerState', 'readTriggerState', 'coerceHostState', 'emptyHostState', 'runCheckProcess', 'writeFileSync', 'renameSync', 'unlinkSync', 'utimesSync']) {
        expect(cmd, banned).not.toContain(banned)
      }
    }
  })

  it('the standalone twin imports the core; the source twin gates the capability on the sidecar', () => {
    expect(standaloneSrc).toMatch(/import \{ takeTriggerStateSnapshot \} from '\.\/trigger-state-snapshot-core\.js'/)
    expect(read('src/providers/trigger-check-sidecar.ts')).toMatch(/export \* from '\.\/trigger-state-snapshot-core\.js'/)
    expect(templateSrc).toMatch(/SIDECAR_GATED_CAPABILITIES = new Set\(\[[^\]]*'trigger-state-snapshot-v1'/)
    expect(templateSrc).toMatch(/typeof triggerCheckCore\.takeTriggerStateSnapshot === 'function'\) caps\.push\('trigger-state-snapshot-v1'\)/)
    const cmd = bodyOf(templateSrc, 'cmdTriggersStateSnapshot')
    expect(cmd).toMatch(/typeof triggerCheckCore\.takeTriggerStateSnapshot !== 'function'[\s\S]*reason: 'sidecar_missing'/)
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('trigger-state-snapshot-v1')
  })

  it('the core is hashed in both version lists', () => {
    expect(read('scripts/build-daemon.sh')).toContain('src/providers/trigger-state-snapshot-core.ts')
    expect(read('src/providers/daemon-version-check.ts')).toContain("'src/providers/trigger-state-snapshot-core.ts'")
  })

  it('the command is not reachable from the bridge or a follower', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      for (const list of ['BRIDGE_ALLOWED_COMMANDS', 'FOLLOWER_ALLOWED_COMMANDS']) {
        const start = src.indexOf(`${list} = new Set([`)
        if (start === -1) continue
        expect(src.slice(start, src.indexOf('])', start)), list).not.toContain('triggers.state.snapshot')
      }
    }
  })
})
