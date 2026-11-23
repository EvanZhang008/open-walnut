/**
 * What a version can be as a host's one Walnut service (src/providers/service-roles.ts), said by the
 * version itself: `__daemon --service-roles` (the compiled file prints both roles, any other build
 * none, an older file fails and so takes none), hello's list, and the launcher's goodRoles, asked of
 * the good version's file once per path and carried through to the host's card (host_get).
 * MACHINE SAFETY: the only processes started are this test's own bun children, which print and exit.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createServiceRolesReader, daemonFileSays, programServiceRoles, ROLES_RETRY_MS, serviceRolesFrom, withGoodRoles, type ExecFileLike } from '../../src/providers/service-roles.js'
import { launcherFactsFrom } from '../../src/providers/service-launcher-beat.js'
import { fleetLauncher } from '../../src/core/hosts/host-launcher.js'
import { guardedPath } from '../setup/exec-guard.js'

const ROOT = path.resolve(__dirname, '../..')
const homes: string[] = []
afterAll(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }) })

type Answer = string | 'usage' | 'timeout' | 'eagain'
/**
 * An execFile double: `<exe> __daemon --service-roles` answers by the table: printed words (exit 0),
 * 'usage' (an older file: usage and exit 1), 'timeout' (killed at the timeout), 'eagain' (no spawn).
 */
function fakeExec(answers: Record<string, Answer>): ExecFileLike & { calls: string[]; settle(): void } {
  const pending: Array<() => void> = []
  const calls: string[] = []
  const fn = ((file: string, args: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => {
    calls.push(`${file} ${args.join(' ')}`)
    const answer = answers[file] ?? 'usage'
    const fail = (props: Record<string, unknown>) => Object.assign(new Error(String(props.code ?? 'killed')), props)
    pending.push(() => {
      if (answer === 'usage') cb(fail({ code: 1 }), '')
      else if (answer === 'timeout') cb(fail({ code: null, killed: true, signal: 'SIGTERM' }), '')
      else if (answer === 'eagain') cb(fail({ code: 'EAGAIN' }), '')
      else cb(null, answer)
    })
  }) as ExecFileLike & { calls: string[]; settle(): void }
  fn.calls = calls
  fn.settle = () => { for (const p of pending.splice(0)) p() }
  return fn
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('the roles a program says it can take', () => {
  it('the compiled Walnut file can take both; any other build none', () => {
    expect(programServiceRoles(true)).toEqual(['replica', 'leader'])
    expect(programServiceRoles(false)).toEqual([])
  })

  it('only known roles are read, from a list or printed words', () => {
    expect(serviceRolesFrom('replica leader\n')).toEqual(['replica', 'leader'])
    expect(serviceRolesFrom(['leader', 'boss'])).toEqual(['leader'])
    expect(serviceRolesFrom(undefined)).toEqual([])
    expect(serviceRolesFrom(42)).toEqual([])
  })
})

describe('`__daemon --service-roles`', () => {
  const run = (args: string[]) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-home-'))
    homes.push(home)
    return promisify(execFile)(process.execPath, args, { cwd: ROOT, timeout: 60_000, env: { PATH: guardedPath(), HOME: home } })
  }

  it('the compiled file prints `replica leader`', async () => {
    const { stdout } = await run([path.join(__dirname, 'fixtures', 'service-roles-compiled.ts')])
    expect(stdout.trim()).toBe('replica leader')
  }, 90_000)

  it('the daemon run from source (no compiled file) prints no role', async () => {
    const { stdout } = await run([path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--service-roles'])
    expect(stdout.trim()).toBe('')
  }, 90_000)
})

describe('the launcher\'s good version', () => {
  it('is asked once per path; unknown until that ask settles; a file that does not know the flag takes none', async () => {
    const exec = fakeExec({ '/v/new/walnut': 'replica leader\n', '/v/old/walnut': 'usage' })
    const rolesOf = createServiceRolesReader(exec)
    expect(rolesOf('/v/new/walnut')).toBeUndefined()
    expect(rolesOf('/v/new/walnut')).toBeUndefined()
    expect(rolesOf('/v/old/walnut')).toBeUndefined()
    exec.settle(); await tick()
    expect(rolesOf('/v/new/walnut')).toEqual(['replica', 'leader'])
    expect(rolesOf('/v/old/walnut')).toEqual([])
    expect(exec.calls).toEqual(['/v/new/walnut __daemon --service-roles', '/v/old/walnut __daemon --service-roles'])
    expect(rolesOf('relative')).toBeUndefined()
  })

  // Review point 2: the first hello goes out before the answer; the answer itself tells the daemon
  // (known), which sends its servers the facts again (launcher-facts, daemon-connection-launcher-facts.test.ts).
  it('one ask is enough: once it is answered the daemon is told, and the facts then carry goodRoles', async () => {
    const exec = fakeExec({ '/v/good/walnut': 'replica leader\n' })
    const told: string[] = []
    const rolesOf = createServiceRolesReader(exec, { known: (exe) => { told.push(exe) } })
    const facts = { current: '/v/cur/walnut', good: '/v/good/walnut', phase: 'committed' as const, since: 1 }
    // The first hello: not known yet, the ask starts.
    expect(withGoodRoles(facts, rolesOf)).toEqual(facts)
    exec.settle(); await tick()
    // The push: told at once, with no second hello.
    expect(told).toEqual(['/v/good/walnut'])
    const pushed = withGoodRoles(facts, rolesOf)
    expect(pushed).toEqual({ ...facts, goodRoles: ['replica', 'leader'] })
    expect(exec.calls).toHaveLength(1)
    // The leader's side: the facts as the connection reads them, then the card.
    const read = launcherFactsFrom(JSON.parse(JSON.stringify(pushed)))
    expect(read?.goodRoles).toEqual(['replica', 'leader'])
    expect(fleetLauncher(read)?.goodRoles).toEqual(['replica', 'leader'])
    // An older host's hello has none: the card says nothing, never a guess.
    expect(fleetLauncher(launcherFactsFrom(facts))).not.toHaveProperty('goodRoles')
    expect(withGoodRoles({ ...facts, good: '' }, rolesOf)).toEqual({ ...facts, good: '' })
  })

  // Review point 4: only a real answer is kept for the life of the process.
  it('a timeout or a failed start is no answer: nothing is kept, it is asked again after the retry wait', async () => {
    let now = 1_000
    const answers: Record<string, Answer> = { '/v/slow/walnut': 'timeout', '/v/busy/walnut': 'eagain' }
    const exec = fakeExec(answers)
    const told: string[] = []
    const rolesOf = createServiceRolesReader(exec, { now: () => now, known: (exe) => { told.push(exe) } })
    expect(rolesOf('/v/slow/walnut')).toBeUndefined()
    expect(rolesOf('/v/busy/walnut')).toBeUndefined()
    exec.settle(); await tick()
    expect(rolesOf('/v/slow/walnut')).toBeUndefined()
    expect(rolesOf('/v/busy/walnut')).toBeUndefined()
    expect(told).toEqual([])
    expect(exec.calls).toHaveLength(2)
    now += ROLES_RETRY_MS + 1
    answers['/v/slow/walnut'] = 'replica leader'
    answers['/v/busy/walnut'] = 'usage'
    expect(rolesOf('/v/slow/walnut')).toBeUndefined()
    expect(rolesOf('/v/busy/walnut')).toBeUndefined()
    exec.settle(); await tick()
    expect(rolesOf('/v/slow/walnut')).toEqual(['replica', 'leader'])
    expect(rolesOf('/v/busy/walnut')).toEqual([])
    expect(told).toEqual(['/v/slow/walnut', '/v/busy/walnut'])
    expect(exec.calls).toHaveLength(4)
  })

  // Review round 2, low b: a stable link sends no second hello, so the retry runs by itself.
  it('a file that gave no answer is asked again by its own timer, and the servers hear it', async () => {
    let now = 1_000
    const answers: Record<string, Answer> = { '/v/slow/walnut': 'timeout' }
    const exec = fakeExec(answers)
    const told: string[] = []
    const timers: Array<{ fn: () => void; ms: number }> = []
    const rolesOf = createServiceRolesReader(exec, {
      now: () => now, known: (exe) => { told.push(exe) }, later: (fn, ms) => { timers.push({ fn, ms }) },
    })
    expect(rolesOf('/v/slow/walnut')).toBeUndefined()
    exec.settle(); await tick()
    expect(timers.map((t) => t.ms)).toEqual([ROLES_RETRY_MS])
    now += ROLES_RETRY_MS
    answers['/v/slow/walnut'] = 'replica leader'
    timers.shift()!.fn()                      // no rolesOf call from a hello in between
    exec.settle(); await tick()
    expect(told).toEqual(['/v/slow/walnut'])
    expect(rolesOf('/v/slow/walnut')).toEqual(['replica', 'leader'])
    expect(exec.calls).toHaveLength(2)
    expect(timers, 'a kept answer arms nothing more').toEqual([])
  })

  it('the shared ask returns the last line, or null when the file failed', async () => {
    const exec = fakeExec({ '/v/a': 'warming\nwalnut-daemon-abc\n', '/v/b': 'usage' })
    const a = daemonFileSays('/v/a', '--version', exec)
    const b = daemonFileSays('/v/b', '--version', exec)
    exec.settle()
    expect(await a).toBe('walnut-daemon-abc')
    expect(await b).toBeNull()
  })
})
