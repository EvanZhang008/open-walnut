/**
 * Every copy a daemon keeps once per Walnut says how two names of one daemon share it
 * (src/providers/daemon-twin-state.ts). 2026-11-20: `bridge.configure` and `host.slice` were pushed
 * per name and the found name's push won, so the phone found the machine unreachable while the
 * Mac slept. The list of commands comes from both daemon twins' own command switches: a new
 * `.configure` or `.sync` fails here until it names its rule.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DAEMON_TWIN_STATE } from '../../src/providers/daemon-twin-state.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** The command names a daemon twin's switch takes that set what it keeps per Walnut. */
function stateCommands(rel: string): string[] {
  const out = new Set<string>()
  for (const m of read(rel).matchAll(/case '([a-zA-Z.]+)'/g)) {
    const cmd = m[1]
    if (/\.(configure|sync)$/.test(cmd) || cmd === 'host.slice' || cmd === 'leader.spawnTemplate') out.add(cmd)
  }
  return [...out].sort()
}

describe('daemon state kept once per Walnut', () => {
  it('names a rule for every such command either daemon twin takes', () => {
    const cmds = [...new Set([...stateCommands('src/providers/daemon-standalone.ts'), ...stateCommands('src/providers/daemon-source.ts')])]
    expect(cmds.length).toBeGreaterThan(10)
    const missing = cmds.filter((c) => !DAEMON_TWIN_STATE[c])
    expect(missing, `say how two names of one daemon share these (daemon-twin-state.ts): ${missing.join(', ')}`).toEqual([])
  })

  it('the pushes the shared rules name read the daemon\'s names', () => {
    // A revert of one of them fails here.
    const conn = read('src/providers/daemon-connection.ts')
    expect(conn).toMatch(/getBridgeConfigForHost\(keeper\)/)
    expect(conn).toMatch(/buildHostSlice\(\[keeper, \.\.\.aliases/)
    expect(read('src/core/host-server/manager.ts')).toMatch(/daemonKeeper\(\)/)
    expect(read('src/core/plugin-jobs/manager.ts')).toMatch(/daemonNames\(\)/)
    expect(read('src/core/host-replica.ts')).toMatch(/daemonTwins\(/)
  })
})
