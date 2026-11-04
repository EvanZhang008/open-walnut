/**
 * namedOnSignal (src/providers/host-exec-run-id.ts): a CLI stopped while a run's call is out (its
 * caller's timeout, a ^C) prints the run's id before it ends, as a lost answer does. 2026-11-04
 * review: a CLI killed by SIGTERM printed nothing, and the job was found only through host_exec_list.
 *
 * MACHINE SAFETY: a stand-in process; no signal is sent to anything.
 */
import { describe, expect, it } from 'vitest'
import { namedOnSignal, type SignalProc } from '../../src/providers/host-exec-run-id.js'

function standIn() {
  const listeners = new Map<string, Set<() => void>>()
  const killed: string[] = []
  const proc: SignalProc = {
    pid: 4242,
    once: (sig, fn) => { (listeners.get(sig) ?? listeners.set(sig, new Set()).get(sig)!).add(fn) },
    removeListener: (sig, fn) => { listeners.get(sig)?.delete(fn) },
    kill: (pid, sig) => { killed.push(`${pid}:${sig}`) },
  }
  const fire = (sig: string) => { for (const fn of [...(listeners.get(sig) ?? [])]) { listeners.get(sig)!.delete(fn); fn() } }
  const count = () => [...listeners.values()].reduce((n, s) => n + s.size, 0)
  return { proc, fire, killed, count }
}

describe('a stop signal while a run is out', () => {
  it('prints the run\'s id and how to read it, then ends the process by that signal', () => {
    const p = standIn()
    const out: string[] = []
    namedOnSignal('host_exec', { host: 'macbox', job_id: 'hx-sig-0001' }, 'hx-sig-0001', (t) => out.push(t), p.proc)
    expect(p.count()).toBe(3)
    p.fire('SIGTERM')
    expect(out.join('')).toContain('as job hx-sig-0001: do not run it again')
    expect(out.join('')).toContain('walnut tools call host_exec_read')
    // Every handler is off before the signal is raised again, so it ends the process.
    expect(p.count()).toBe(0)
    expect(p.killed).toEqual(['4242:SIGTERM'])
  })

  it('once the call has its answer, a signal prints nothing; an op with no run sets nothing', () => {
    const p = standIn()
    const out: string[] = []
    const answered = namedOnSignal('host_exec', { host: 'macbox' }, 'hx-sig-0002', (t) => out.push(t), p.proc)
    answered()
    expect(p.count()).toBe(0)
    namedOnSignal('task_get', {}, null, (t) => out.push(t), p.proc)
    expect(p.count()).toBe(0)
    expect(out).toEqual([])
  })
})
