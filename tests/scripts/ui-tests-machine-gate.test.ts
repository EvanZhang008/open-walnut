/**
 * ios-native/tests/ui/machine-gate-wait.sh: run-ui-tests.sh waits for a calm machine before EVERY
 * xcodebuild on a test lane's simulator, as the simulator queue does before each round. On
 * 2026-11-07 the XCUITest runs of one held lane were 22.7% of the runnable threads in the Mac's
 * over-limit samples: the queue's gate judged only the lease's start, never the runs inside it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const LIB = path.resolve(__dirname, '../../ios-native/tests/ui/machine-gate-wait.sh')
const RUNNER = path.resolve(__dirname, '../../ios-native/tests/ui/run-ui-tests.sh')
const LANE_UDID = '11111111-2222-3333-4444-555555555555'
let dir = ''

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uitest-gate-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** A fake gate: answers WAIT for its first `waits` calls, then CALM; logs its arguments. */
function fakeGate(waits: number): string {
  const gate = path.join(dir, 'machine-gate.sh')
  fs.writeFileSync(gate, [
    '#!/bin/bash',
    `echo "$*" >> "${dir}/calls"`,
    `n=$(( $(cat "${dir}/n" 2>/dev/null || echo 0) + 1 )); echo $n > "${dir}/n"`,
    `if [ $n -le ${waits} ]; then echo "WAIT only 10% of the CPU is idle"; exit 1; fi`,
    'echo "CALM load 3 on 14 CPUs"',
  ].join('\n'))
  return gate
}

function run(udid: string, env: Record<string, string>) {
  const r = spawnSync('/bin/bash', ['-c', `. "${LIB}"; uitest_machine_gate "$1" "the build"; echo RETURNED`, '_', udid], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: dir, WALNUT_UITEST_GATE_POLL: '0', ...env },
  })
  const calls = fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n') : []
  return { status: r.status, out: r.stdout + r.stderr, calls }
}

describe('a calm machine before every xcodebuild of a test lane', () => {
  it('waits while the gate says WAIT, then goes on, leaving its own simulator out', () => {
    const r = run(LANE_UDID, { WALNUT_MACHINE_GATE: fakeGate(2), SIM_LANE: 'b' })
    expect(r.status).toBe(0)
    expect(r.out).toContain('waiting for a calm machine before the build: only 10% of the CPU is idle')
    expect(r.out).toContain('RETURNED')
    expect(r.calls).toEqual(Array(3).fill(`--exclude ${LANE_UDID}`))
  })

  it('exits 6 when the machine stays busy past the wait', () => {
    const r = run(LANE_UDID, { WALNUT_MACHINE_GATE: fakeGate(1000), SIM_LANE: 'b', WALNUT_UITEST_GATE_WAIT: '0' })
    expect(r.status).toBe(6)
    expect(r.out).toContain('the machine stayed busy for 0s before the build')
    expect(r.out).not.toContain('RETURNED')
  })

  it('finds the gate and the lane simulator through ~/.config/walnut/machine-gate.env, and the queue script', () => {
    const gate = fakeGate(0)
    fs.mkdirSync(path.join(dir, '.config/walnut'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.config/walnut/machine-gate.env'), `WALNUT_SIM_QUEUE_SCRIPT=${path.join(dir, 'sim-queue.sh')}\nWALNUT_MACHINE_GATE_UDID=${LANE_UDID}\n`)
    const r = run(LANE_UDID.toLowerCase(), {})
    expect(r.status).toBe(0)
    expect(r.calls).toEqual([`--exclude ${LANE_UDID.toLowerCase()}`])
    expect(fs.existsSync(gate)).toBe(true)
  })

  it('leaves any other simulator, and a machine with no gate, alone', () => {
    const gate = fakeGate(1000)
    expect(run('99999999-2222-3333-4444-555555555555', { WALNUT_MACHINE_GATE: gate, WALNUT_MACHINE_GATE_UDID: LANE_UDID }).calls).toEqual([])
    expect(run(LANE_UDID, { WALNUT_MACHINE_GATE: path.join(dir, 'none.sh'), SIM_LANE: 'b' })).toMatchObject({ status: 0, calls: [] })
    expect(run(LANE_UDID, { SIM_LANE: 'b' })).toMatchObject({ status: 0, calls: [] })
  })

  it('RATCHET: every xcodebuild run-ui-tests.sh starts is right after the gate', () => {
    const lines = fs.readFileSync(RUNNER, 'utf8').split('\n')
    const runs = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^\s*(run_heavy\s+)?xcodebuild\b/.test(l))
    expect(runs.length).toBeGreaterThanOrEqual(2)
    for (const { i } of runs) expect(lines[i - 1], `line ${i + 1}`).toMatch(/^\s*uitest_machine_gate "\$UDID" /)
    expect(lines.some((l) => /^\. .*machine-gate-wait\.sh"$/.test(l))).toBe(true)
  })
})
