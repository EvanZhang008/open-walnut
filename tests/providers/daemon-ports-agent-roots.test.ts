/**
 * The ports scan's roots (daemon-host-services.ts agentRootPids): a running session's CLI and a
 * running ACP worker, including one adopted after a restart, which has a pid and no `proc`
 * (acp-survive.ts). Before, `w.proc!.pid` threw for that worker and ports.list failed.
 * Guard: no daemon module reads an ACP worker's pid through `proc!`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentRootPids } from '../../src/providers/daemon-host-services.js'

describe('the ports scan roots', () => {
  it('takes running sessions and workers, an adopted worker by its pid', () => {
    const sessions = new Map([
      ['s-run', { pid: 4101, state: 'running' }],
      ['s-idle', { pid: 4102, state: 'idle' }],
      ['s-none', { pid: null, state: 'running' }],
    ])
    const workers = new Map<string, { state: string; pid?: number; proc?: { pid?: number } }>([
      ['w-spawned', { state: 'running', proc: { pid: 5201 }, pid: 5201 }],
      ['w-adopted', { state: 'running', pid: 5202 }],
      ['w-proc-only', { state: 'running', proc: { pid: 5203 } }],
      ['w-stopped', { state: 'exited', pid: 5204 }],
      ['w-init', { state: 'running', pid: 1 }],
    ])
    expect([...agentRootPids(sessions, workers)]).toEqual([
      [4101, 's-run'], [5201, 'w-spawned'], [5202, 'w-adopted'], [5203, 'w-proc-only'],
    ])
  })

  it('no daemon module reads a worker pid through a non-null proc', () => {
    const dir = path.resolve(__dirname, '../../src/providers')
    const offenders = fs.readdirSync(dir)
      .filter((f) => /^daemon-.*\.ts$/.test(f) && /\.proc!\.pid/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
    expect(offenders).toEqual([])
  })
})
