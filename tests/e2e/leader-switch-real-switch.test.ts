/**
 * The manual leader switch with real servers (docs/reference/leader-switch.md), the rehearsal's main
 * scenario (scripts/leader-switch/rehearsal.ts) as assertions: two real servers as their own
 * processes on synthetic homes in a temp folder, three local witnesses, and the real
 * `walnut leader switch` command. No :3456, no ~/.open-walnut. The product's permit clocks: the
 * switch and the switch back commit inside the handover's lease, as the product does.
 *
 * The other scenarios are in the leader-switch-real-*.test.ts files (tests/helpers/leader-switch-real.ts).
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { rehearseSwitchAndBack } from '../../scripts/leader-switch/rehearsal.js'
import { failed, portsFrom, realSwitchRoot } from '../helpers/leader-switch-real.js'

const root = realSwitchRoot('switch')
const ports = portsFrom(0)

describe('the manual leader switch, real servers: switch and back', () => {
  it('switches under load, keeps every acknowledged write, never has two leaders, keeps the old home as a standby that leads nothing and changes nothing (witnesses online and unreachable), and switches back with A leading again', async () => {
    // The rehearsal's own lines, kept so a red run names its failed checks in full and shows what led to them.
    const lines: string[] = []
    const r = await rehearseSwitchAndBack(path.join(root, 'main'), () => {}, { ...ports(), log: (line) => { lines.push(line) } })
    const red = failed(r.checks.all)
    expect(red, red.length ? `failed checks:\n${red.join('\n')}\n--- rehearsal log, last 80 lines ---\n${lines.slice(-80).join('\n')}` : '').toEqual([])
    expect(r.checks.all.length).toBeGreaterThan(20)
    expect(r.downtimeMs).toBeGreaterThan(0)
  }, 600_000)
})
