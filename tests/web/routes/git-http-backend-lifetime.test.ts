/**
 * A `git http-backend` never outlives what it serves (src/web/routes/git-http.ts).
 *
 * 2026-10-09: four receive-packs orphaned by a deploy restart (detached, so
 * their own process group; systemd keeps a stopped unit's leftovers) had spun
 * the companion's two cores for four days. Two bounds now: the backends still
 * in flight are SIGKILLed when the server exits, and where coreutils `timeout`
 * exists (Linux) a backend runs under it with a one-hour cap.
 *
 * The reap is exercised on a process this test spawned itself, never on
 * anything else.
 */
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  BACKEND_MAX_SECONDS, backendCommand, reapLiveBackends, _liveBackendsForTesting,
} from '../../../src/web/routes/git-http.js'

describe('git http-backend lifetime', () => {
  it('runs under timeout when the box has it, as the group leader, with a kill after the grace', () => {
    expect(backendCommand('/usr/bin/timeout')).toEqual({
      cmd: '/usr/bin/timeout', args: ['-k', '10', String(BACKEND_MAX_SECONDS), 'git', 'http-backend'],
    })
    expect(backendCommand(null)).toEqual({ cmd: 'git', args: ['http-backend'] })
    expect(BACKEND_MAX_SECONDS).toBe(3600)
  })

  it('the backends still in flight are SIGKILLed with their whole group at exit', async () => {
    // Our own stand-in: a detached group with a grandchild, like http-backend → receive-pack.
    const child = spawn('sh', ['-c', 'sleep 30 & wait'], { detached: true, stdio: 'ignore' })
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on('exit', (_code, signal) => resolve(signal)))
    expect(child.pid).toBeGreaterThan(1)
    _liveBackendsForTesting().add(child.pid!)
    expect(reapLiveBackends()).toBe(1)
    expect(await exited).toBe('SIGKILL')
    // The grandchild went with the group.
    expect(() => process.kill(-child.pid!, 0)).toThrow()
    expect(_liveBackendsForTesting().size).toBe(0)
  })

  it('a pid that cannot be a child of ours is never signalled', () => {
    _liveBackendsForTesting().add(1)
    _liveBackendsForTesting().add(0)
    expect(reapLiveBackends()).toBe(0)
  })
})
