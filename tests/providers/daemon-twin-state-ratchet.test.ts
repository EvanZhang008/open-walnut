/**
 * Every copy a daemon keeps once per Walnut says how two names of one daemon share it
 * (src/providers/daemon-twin-state.ts). 2026-11-20: `bridge.configure` and `host.slice` were pushed
 * per name and the found name's push won, so the phone found the machine unreachable while the
 * Mac slept. The list of commands comes from the daemon's own command switch: a new
 * `.configure` or `.sync` fails here until it names its rule.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DAEMON_TWIN_STATE } from '../../src/providers/daemon-twin-state.js'
import { daemonRuntimeText } from '../helpers/daemon-runtime-text.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** The command names the daemon's switch takes that set what it keeps per Walnut. */
function stateCommands(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/case '([a-zA-Z.]+)'/g)) {
    const cmd = m[1]
    if (/\.(configure|sync)$/.test(cmd) || cmd === 'host.slice' || cmd === 'leader.spawnTemplate') out.add(cmd)
  }
  return [...out].sort()
}

describe('daemon state kept once per Walnut', () => {
  it('names a rule for every such command the daemon takes', () => {
    // The whole runtime: a command's inner switch may sit in an area module (daemon-transcripts.ts).
    const cmds = stateCommands(daemonRuntimeText())
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
    expect(read('src/core/host-replica.ts')).toMatch(/daemonKeeperAlias\(/)
  })
})
