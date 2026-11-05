/**
 * host_exec keep, the server side (src/core/hosts/host-exec-keep.ts): the line it builds, the checks
 * of the call's `keep`, the refusal of a host with no task directory, and what the answer says
 * (src/ops/host-exec-answers.ts). The shell itself is tested against real bash in
 * host-exec-keep-bash.test.ts.
 *
 * MACHINE SAFETY: pure functions; no process, file or network.
 */
import { describe, expect, it } from 'vitest'
import { KEEP_FILE, checkKeep, keepPrefix, keepRefusal, shapedLine } from '../../../src/core/hosts/host-exec-keep.js'
import { failedStepOf, strictLine } from '../../../src/core/hosts/host-exec-strict.js'
import { HostExecError } from '../../../src/core/hosts/host-exec-target.js'
import { strictMark } from '../../../src/providers/host-exec-line.js'
import { permissionRisk } from '../../../src/providers/host-exec-guards.js'
import { cltStubRun, type CltFs } from '../../../src/providers/host-exec-clt.js'
import { runOutcome } from '../../../src/ops/host-exec-answers.js'

const J = 'hx-keep-unit-1'
const thrown = (f: () => void): HostExecError => { try { f() } catch (err) { return err as HostExecError } throw new Error('did not throw') }

describe('the line keep builds', () => {
  it('changes nothing without keep: no line, or strict\'s own line byte for byte', () => {
    expect(shapedLine({ command: 'echo a' }, J)).toBeNull()
    expect(shapedLine({ command: 'echo a', keep: false, cwd: '/x', background: true }, J)).toBeNull()
    expect(shapedLine({ command: 'echo a\nfalse', strict: true }, J)).toBe(strictLine('echo a\nfalse', J))
    expect(shapedLine({ command: 'echo a', strict: true, keep: false }, J)).toBe(strictLine('echo a', J))
    // No shell line (argv): nothing to shape.
    expect(shapedLine({ keep: true }, J)).toBeNull()
    expect(shapedLine({ command: '  ', keep: true }, J)).toBeNull()
  })

  it('puts one physical line before the caller\'s, and nothing after it', () => {
    const command = 'cd repo\nexport A=1\necho "$A"'
    const line = shapedLine({ command, keep: true }, J)!
    const [first, ...rest] = line.split('\n')
    expect(rest).toEqual(['export A=1', 'echo "$A"'])
    expect(first!.endsWith('; cd repo')).toBe(true)
    expect(line.endsWith(command)).toBe(true)
    expect(keepPrefix({ cwdNamed: false, save: true })).not.toContain('\n')
    expect(line.startsWith('if [ -n "${BASH_VERSION:-}" ]; then ')).toBe(true)
    expect(line).toContain(`"$WALNUT_TASK_DIR/${KEEP_FILE}"`)
  })

  it('sets its EXIT trap only for a foreground run, and goes into the kept directory only without cwd', () => {
    const fg = shapedLine({ command: 'true', keep: true }, J)!
    expect(fg).toMatch(/; trap 'walnut_ks=1; [^']*' EXIT; fi; true$/)
    expect(fg).toContain('builtin cd -- "$walnut_kd"')
    const bg = shapedLine({ command: 'true', keep: true, background: true }, J)!
    expect(bg).not.toContain('EXIT')
    expect(bg).toContain('builtin cd -- "$walnut_kd"')
    const withCwd = shapedLine({ command: 'true', keep: true, cwd: '/srv/app' }, J)!
    expect(withCwd).not.toContain('builtin cd')
    expect(withCwd).toContain("' EXIT")
    // A cwd of spaces is none (the daemon runs it in the home directory).
    expect(shapedLine({ command: 'true', keep: true, cwd: '  ' }, J)).toContain('builtin cd')
  })

  it('with strict: keep restores first, and its EXIT trap stands in for strict\'s own', () => {
    const both = shapedLine({ command: 'false', keep: true, strict: true }, J)!
    expect(both.indexOf('walnut_kb=$(builtin declare -px)')).toBeLessThan(both.indexOf('set -e;'))
    expect(both.indexOf("trap 'walnut_ks=1;")).toBeLessThan(both.indexOf('set -e;'))
    expect(both).not.toContain('trap : EXIT')
    expect(both.endsWith(strictLine('false', J, { exitTrap: false }))).toBe(true)
    // A background strict run sets no EXIT trap of keep's: strict keeps its own.
    const bg = shapedLine({ command: 'false', keep: true, strict: true, background: true }, J)!
    expect(bg).toContain('trap : EXIT')
    expect(bg).not.toContain("trap 'walnut_ks=1;")
    expect(strictLine('false', J)).toContain('trap : EXIT')
  })

  it('never lets strict name keep\'s EXIT trap as the failed step (bash 4 names a command of Walnut\'s own)', () => {
    // A job no strictLine made a seal for here: any seal of the right form counts (a server restart).
    const id = 'hx-keep-unit-noseal'
    const M = strictMark(id, 'a1b2c3d4e5f6')
    const trap = /trap 'walnut_ks=1;[^']*' EXIT/.exec(shapedLine({ command: 'true', keep: true }, id)!)![0]
    expect(failedStepOf(`${M} 1 [1]: ${trap}\t(bash 4, bg 0)\n`, id, 1)).toBeNull()
    expect(failedStepOf(`${M} 1 [1]: false\t(bash 4, bg 0)\n`, id, 1)).toMatchObject({ command: 'false' })
  })

  it('leaves the dialog guards reading the caller\'s commands', () => {
    const home = '/Users/sam'
    const line = (command: string, cwd?: string) => shapedLine({ command, keep: true, cwd }, J)!
    expect(permissionRisk(line('cat ~/Desktop/notes.txt'), home, home)).toMatchObject({ path: '/Users/sam/Desktop/notes.txt' })
    expect(permissionRisk(line('du -sh ~'), home, home)).toMatchObject({ how: 'walks' })
    expect(permissionRisk(line('ls -la; echo done'), home, home)).toBeNull()
    // With cwd the guard knows where the run starts; without, the kept directory is not known here.
    expect(permissionRisk(line('cat notes.txt', '/Users/sam/Documents'), '/Users/sam/Documents', home)?.path).toMatch(/^\/Users\/sam\/Documents/)
    const bare: CltFs = { exists: (p) => p === '/usr/bin/git', readlink: () => null }
    expect(cltStubRun(line('git status'), '/usr/bin:/bin', bare)).toBe('git')
    expect(cltStubRun(line('echo hi'), '/usr/bin:/bin', bare)).toBeNull()
  })
})

describe('the call\'s keep', () => {
  it('is a boolean, and only with a shell line, or nothing runs', () => {
    expect(() => checkKeep(undefined, true)).not.toThrow()
    expect(() => checkKeep(false, false)).not.toThrow()
    expect(() => checkKeep(true, true)).not.toThrow()
    for (const bad of ['yes', 'true', 1, null, {}]) expect(thrown(() => checkKeep(bad, true))).toMatchObject({ status: 400, code: 'bad_request' })
    const argv = thrown(() => checkKeep(true, false))
    expect(argv).toMatchObject({ status: 400, code: 'bad_request' })
    expect(argv.message).toContain('give the line as command')
  })

  it('a host with no task directory is refused in keep\'s words; other refusals are left as they are', () => {
    const unset = keepRefusal(new HostExecError('this host has no task directory for this task, so WALNUT_TASK_DIR is unset here; nothing ran', 409, 'task_dir_unset'), 'Build box') as HostExecError
    expect(unset).toMatchObject({ status: 409, code: 'task_dir_unset' })
    expect(unset.message).toContain('keep:true keeps this task\'s shell state in its task directory on Build box')
    expect(unset.message).toContain('Run it without keep')
    const long = keepRefusal(new HostExecError('This line is too long for the Walnut daemon on old to get WALNUT_TASK_DIR (it is older); nothing ran. Write the path itself: /t', 409, 'task_dir_unset', { taskDir: '/t' }), 'old') as HostExecError
    expect(long.message).toMatch(/^keep:true makes this line too long for the older Walnut daemon on old/)
    expect(long.data).toEqual({ taskDir: '/t' })
    const other = new HostExecError('cwd missing', 400, 'cwd_missing')
    expect(keepRefusal(other, 'x')).toBe(other)
    expect(other.message).toBe('cwd missing')
  })
})

describe('what the answer says', () => {
  const body = { host: 'macbox', jobId: 'hx-1', running: false, exitCode: 0, ms: 50, cwd: '/home/u', shell: 'bash', output: '' }
  it('a keep run: where it started, and that its end carries to the next keep call', () => {
    const o = String((runOutcome({ ...body, keep: { saves: true } }, { keep: true }) as { outcome: string }).outcome)
    expect(o).toMatch(/^Exit 0 on macbox \(bash\) after 50 ms\./)
    expect(o).toContain('It started where this task\'s last keep call on macbox ended')
    expect(o).toContain('its directory and exported variables at its end carry to the next keep call there.')
    // With cwd: the run started there, and the answer says so.
    const cwd = String((runOutcome({ ...body, keep: { saves: true } }, { keep: true, cwd: '/home/u' }) as { outcome: string }).outcome)
    expect(cwd).toMatch(/^Exit 0 on macbox in \/home\/u \(bash\)/)
    expect(cwd).toContain('It started in the cwd you gave')
    const running = String((runOutcome({ ...body, running: true, exitCode: null, keep: { saves: true } }, { keep: true }) as { outcome: string }).outcome)
    expect(running).toContain('carry to the next keep call there once it ends')
  })

  it('a background keep run saves nothing; an older server ran it without keep; a call without keep says nothing of it', () => {
    const bg = String((runOutcome({ ...body, running: true, exitCode: null, keep: { saves: false } }, { keep: true, background: true }) as { outcome: string }).outcome)
    expect(bg).toContain('as a background run, its own directory and variables do not carry to the next keep call')
    const old = String((runOutcome(body, { keep: true }) as { outcome: string }).outcome)
    expect(old).toContain('The Walnut server is older than keep, so it ran this without it')
    expect(old).toMatch(/^Exit 0 on macbox in \/home\/u \(bash\)/)
    expect(String((runOutcome(body, {}) as { outcome: string }).outcome)).not.toContain('keep')
  })
})
