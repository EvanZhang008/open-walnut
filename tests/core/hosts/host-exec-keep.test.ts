/**
 * host_exec keep, the server side (src/core/hosts/host-exec-keep.ts): the line it builds, the checks
 * of the call's `keep`, the read of the kept directory from the host, what the answer says
 * (src/ops/host-exec-answers.ts), and the refusals in keep's words. The shell itself is tested against
 * real bash in host-exec-keep-bash.test.ts, the whole call in tests/e2e/host-exec-e2e.test.ts.
 *
 * MACHINE SAFETY: pure functions and fakes; no process, file or network.
 */
import { describe, expect, it } from 'vitest'
import { KEEP_CWD_FILE, KEEP_FILE, TRAP_FIRST_LINE, checkKeep, keepAnswer, keepPrefix, keepRefusal, keptCwd, keptDirOf, notSavedWhy, shapedLine } from '../../../src/core/hosts/host-exec-keep.js'
import { failedStepOf, strictLine } from '../../../src/core/hosts/host-exec-strict.js'
import { HostExecError } from '../../../src/core/hosts/host-exec-target.js'
import { strictMark } from '../../../src/providers/host-exec-line.js'
import { permissionRisk } from '../../../src/providers/host-exec-guards.js'
import { cltStubRun, type CltFs } from '../../../src/providers/host-exec-clt.js'
import { runOutcome } from '../../../src/ops/host-exec-answers.js'

const J = 'hx-keep-unit-1'
const thrown = (f: () => void): HostExecError => { try { f() } catch (err) { return err as HostExecError } throw new Error('did not throw') }
/** keep's EXIT trap as the line registers it: one $'...' word. */
const trapOf = (line: string) => /; trap \$'((?:[^'\\]|\\.)*)' EXIT; \} 3>&2 2>\/dev\/null; fi; /.exec(line)?.[1] ?? null
/** That word as bash reads it (only the escapes the encoder writes: \\, \n, \047). */
const unquote = (w: string) => w.replace(/\\(047|.)/g, (_, c: string) => (c === 'n' ? '\n' : c === '047' ? "'" : c))

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
    for (const shellCd of [false, true]) expect(keepPrefix({ shellCd, save: true })).not.toContain('\n')
    expect(line.startsWith('if [ -n "${BASH_VERSION:-}" ]; then ')).toBe(true)
    expect(line).toContain(`"$WALNUT_TASK_DIR/${KEEP_FILE}"`)
  })

  it('its EXIT trap: first the line that turns off tracing, verbose and aliases; then the save, in a subshell, writing both files', () => {
    const trap = unquote(trapOf(shapedLine({ command: 'true', keep: true }, J)!)!)
    const [first, second, ...rest] = trap.split('\n')
    expect(first).toBe(TRAP_FIRST_LINE)
    expect(first).toBe('{ \\builtin set +xv; } 2>/dev/null 3>/dev/null 4>/dev/null 5>/dev/null 6>/dev/null 7>/dev/null 8>/dev/null 9>/dev/null; \\builtin shopt -u expand_aliases')
    // No assignment before the save's subshell: a readonly name cannot change the run's exit code.
    expect(`${first}\n${second}`).not.toMatch(/\bwalnut_\w+=/)
    expect(second).toMatch(/^\\builtin set \+eua \+o posix; \\builtin trap - ERR DEBUG; /)
    // The shell waits for the save with its stderr on /dev/null (a reaped job's notice goes nowhere); the save says why on fd 4.
    expect(rest[0]).toBe('{ \\builtin unset -f exec; } 2>/dev/null; \\exec 4>&-; \\exec 4>&2; {')
    expect(rest[1]).toBe('(')
    expect(rest[rest.length - 1]).toBe(') >/dev/null; } 2>/dev/null')
    expect(rest.join('\n')).toContain('keep could not save')
    expect(rest.slice(1).join('\n')).not.toMatch(/>&2/)
    const save = rest.join('\n')
    expect(save).toContain('/keep.cwd')
    expect(save).toContain('\\builtin export -n "$walnut_n"')
    // Un-exported before the first program starts.
    expect(save.indexOf('export -n')).toBeLessThan(save.indexOf('command -p mkdir'))
    expect(save.indexOf('export -n')).toBeLessThan(save.indexOf('command -p mv'))
    // Every command the save runs is a backslash-quoted builtin (no alias, no function), a program through it.
    const code = save.replace(/"(?:[^"\\]|\\.)*"/g, '""')
    for (const name of ['printf', 'declare', 'compgen', 'export', 'set', 'shopt', 'trap', 'umask', 'pwd', 'command', 'unset', 'exit', 'mv', 'mkdir', 'rm']) {
      const uses = [...code.matchAll(new RegExp(`(?<![\\w-])${name}(?![\\w=-])`, 'g'))]
      for (const m of uses) expect(code.slice(Math.max(0, m.index! - 12), m.index), name).toMatch(/(?:\\builtin |command -p )$/)
    }
    // exec keeps its redirections only bare: quoted (no alias), after any function of that name is gone.
    expect(code).toContain('{ \\builtin unset -f exec; } 2>/dev/null; \\exec 4>&-; \\exec 4>&2; {')
    expect([...code.matchAll(/(?<![\w-])exec(?![\w=-])/g)]).toHaveLength(3)
  })

  it('sets its EXIT trap only for a foreground run, and enters the kept directory in the shell only when asked and no cwd is named', () => {
    const fg = shapedLine({ command: 'true', keep: true }, J)!
    expect(trapOf(fg)).not.toBeNull()
    expect(fg).not.toContain('builtin cd')
    expect(shapedLine({ command: 'true', keep: true }, J, { shellCd: true })).toContain('builtin cd -- "$walnut_kd"')
    const bg = shapedLine({ command: 'true', keep: true, background: true }, J, { shellCd: true })!
    expect(bg).not.toContain('EXIT')
    expect(bg).toContain('builtin cd -- "$walnut_kd"')
    const withCwd = shapedLine({ command: 'true', keep: true, cwd: '/srv/app' }, J, { shellCd: true })!
    expect(withCwd).not.toContain('builtin cd')
    expect(trapOf(withCwd)).not.toBeNull()
    // A cwd of spaces is none (the daemon runs it in the home directory).
    expect(shapedLine({ command: 'true', keep: true, cwd: '  ' }, J, { shellCd: true })).toContain('builtin cd')
  })

  it('with strict: keep restores first, and its EXIT trap stands in for strict\'s own', () => {
    const both = shapedLine({ command: 'false', keep: true, strict: true }, J)!
    expect(both.indexOf('walnut_kb=$(builtin declare -px)')).toBeLessThan(both.indexOf('set -e;'))
    expect(both.indexOf("trap $'")).toBeLessThan(both.indexOf('set -e;'))
    expect(both).not.toContain('trap : EXIT')
    expect(both.endsWith(strictLine('false', J, { exitTrap: false }))).toBe(true)
    // A background strict run sets no EXIT trap of keep's: strict keeps its own.
    const bg = shapedLine({ command: 'false', keep: true, strict: true, background: true }, J)!
    expect(bg).toContain('trap : EXIT')
    expect(bg).not.toContain("trap $'")
    expect(strictLine('false', J)).toContain('trap : EXIT')
  })

  it('never lets strict name keep\'s EXIT trap as the failed step (bash 4 names a command of Walnut\'s own, as bash writes it back)', () => {
    // A job no strictLine made a seal for here: any seal of the right form counts (a server restart).
    const id = 'hx-keep-unit-noseal'
    const M = strictMark(id, 'a1b2c3d4e5f6')
    // bash 4's $BASH_COMMAND for it: single quotes, the trap's first line up to its newline.
    expect(failedStepOf(`${M} 1 [1]: trap '${TRAP_FIRST_LINE}\n`, id, 1)).toBeNull()
    expect(failedStepOf(`${M} 1 [1]: false\t(bash 4, bg 0)\n`, id, 1)).toMatchObject({ command: 'false' })
  })

  it('leaves the dialog guards reading the caller\'s commands, against the cwd the run gets', () => {
    const home = '/Users/sam'
    const line = (command: string, cwd?: string) => shapedLine({ command, keep: true, cwd }, J)!
    expect(permissionRisk(line('cat ~/Desktop/notes.txt'), home, home)).toMatchObject({ path: '/Users/sam/Desktop/notes.txt' })
    expect(permissionRisk(line('du -sh ~'), home, home)).toMatchObject({ how: 'walks' })
    expect(permissionRisk(line('ls -la; echo done'), home, home)).toBeNull()
    // The kept directory is the run's cwd (host-exec.ts): the guard reads a relative path there.
    expect(permissionRisk(line('cat notes.txt'), '/Users/sam/Documents', home)?.path).toMatch(/^\/Users\/sam\/Documents/)
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

  it('a host with no task directory is refused in keep\'s words; a dialog in the kept directory names it; other refusals are left as they are', () => {
    const unset = keepRefusal(new HostExecError('this host has no task directory for this task, so WALNUT_TASK_DIR is unset here; nothing ran', 409, 'task_dir_unset'), 'Build box') as HostExecError
    expect(unset).toMatchObject({ status: 409, code: 'task_dir_unset' })
    expect(unset.message).toContain('keep:true keeps this task\'s shell state in its task directory on Build box')
    expect(unset.message).toContain('Run it without keep')
    const long = keepRefusal(new HostExecError('This line is too long for the Walnut daemon on old to get WALNUT_TASK_DIR (it is older); nothing ran. Write the path itself: /t', 409, 'task_dir_unset', { taskDir: '/t' }), 'old') as HostExecError
    expect(long.message).toMatch(/^keep:true makes this line too long for the older Walnut daemon on old/)
    expect(long.data).toEqual({ taskDir: '/t' })
    const prompt = keepRefusal(new HostExecError('`cat` would read /Users/sam/Desktop/a, which macOS guards. Nothing ran.', 409, 'may_prompt', { prompt: 'cat' }), 'macbox', '/Users/sam/Desktop') as HostExecError
    expect(prompt.message).toMatch(/Nothing ran\. This keep call starts in \/Users\/sam\/Desktop, where this task's last keep call on macbox ended: give cwd to start somewhere else\.$/)
    expect(prompt.data).toEqual({ prompt: 'cat', keptDir: '/Users/sam/Desktop' })
    // The guard found the kept directory itself (the server's `cd` there, the host's `trap` word): said as the start.
    for (const program of ['cd', 'trap']) {
      const own = keepRefusal(new HostExecError(`\`${program}\` would read /Users/sam/Desktop, which macOS guards: it shows a permission dialog. Nothing ran.`, 409, 'may_prompt'), 'macbox', '/Users/sam/Desktop') as HostExecError
      expect(own.message).toMatch(/^This keep call would start in \/Users\/sam\/Desktop, where this task's last keep call on macbox ended, and macOS guards that place: .* Nothing ran\. Give cwd to start somewhere else, or ask the user first and call again with allow_prompts: true\.$/)
      expect(own.message).not.toContain(`\`${program}\``)
    }
    const plainPrompt = new HostExecError('dialog', 409, 'may_prompt')
    expect((keepRefusal(plainPrompt, 'macbox', null) as HostExecError).message).toBe('dialog')
    const other = new HostExecError('cwd missing', 400, 'cwd_missing')
    expect(keepRefusal(other, 'x')).toBe(other)
    expect(other.message).toBe('cwd missing')
  })
})

describe('the kept directory, read from the host', () => {
  const conn = (caps: string[], root: string | null = '/state/tasks') => ({ hasCapability: (c: string) => caps.includes(c), taskDirRoot: root })
  const answer = (text: string) => ({ ok: true, data: Buffer.from(text).toString('base64'), bytesRead: Buffer.byteLength(text), fileSize: Buffer.byteLength(text), eof: true })

  it('one fs.readRange of keep.cwd in the task\'s directory there: its path is the run\'s cwd', async () => {
    const asked: Array<Record<string, unknown>> = []
    const kept = await keptCwd(conn(['fs.readRange']), 'task-1', async (p) => { asked.push(p); return answer('/home/u/my dir\nx') })
    expect(kept).toEqual({ dir: '/home/u/my dir\nx' })
    expect(asked).toEqual([{ path: `/state/tasks/task-1/${KEEP_CWD_FILE}`, start: 0, length: 4097 }])
  })

  it('no file, an empty or unreadable one, or one that is not a path: no kept directory', async () => {
    const none = async (reply: Record<string, unknown>) => keptCwd(conn(['fs.readRange']), 'task-1', async () => reply)
    expect(await none({ ok: false, error: 'fs.readRange failed: ENOENT: no such file or directory (ENOENT)' })).toEqual({ dir: null })
    expect(await none({ ok: false, error: 'fs.readRange failed: not a regular file (ENOTFILE)' })).toEqual({ dir: null })
    expect(await none(answer(''))).toEqual({ dir: null })
    expect(await none(answer('relative/dir'))).toEqual({ dir: null })
    expect(await none({ ...answer('/a'), fileSize: 9000 })).toEqual({ dir: null })
    expect(keptDirOf(Buffer.from([0x2f, 0xff]))).toBeNull()
    expect(keptDirOf(Buffer.from('/a\0b'))).toBeNull()
    expect(keptDirOf(Buffer.from(`/${'a'.repeat(4096)}`))).toBeNull()
    expect(keptDirOf(Buffer.from('/été'))).toBe('/été')
  })

  it('a host that cannot hand it over: the shell enters it itself', async () => {
    const never = async (): Promise<Record<string, unknown>> => { throw new Error('not asked') }
    expect(await keptCwd(conn([]), 'task-1', never)).toEqual({ shellCd: true })
    expect(await keptCwd(conn(['fs.readRange'], null), 'task-1', never)).toEqual({ shellCd: true })
    expect(await keptCwd(conn(['fs.readRange']), '../escape', never)).toEqual({ shellCd: true })
    expect(await keptCwd(conn(['fs.readRange']), 'task-1', async () => ({ ok: false, error: 'out of scope for this Walnut' }))).toEqual({ shellCd: true })
    // A read lost on the way ends the call (nothing ran yet).
    await expect(keptCwd(conn(['fs.readRange']), 'task-1', async () => { throw new HostExecError('lost', 503, 'host_offline') })).rejects.toMatchObject({ code: 'host_offline' })
  })
})

describe('what the answer says', () => {
  const body = { host: 'macbox', jobId: 'hx-1', running: false, exitCode: 0, signal: null, ms: 50, cwd: '/home/u/app', shell: 'bash', output: '' }
  const outcome = (b: Record<string, unknown>, args: Record<string, unknown>) => String((runOutcome(b, args) as { outcome: string }).outcome)
  const notSaved = 'walnut: keep could not save this run\'s state (it cannot be written in the task directory); the next keep call starts from the last saved one\n'

  it('reads why a save did not complete from the run\'s own line, and only that line', () => {
    expect(notSavedWhy(`out\n${notSaved}`)).toBe('it cannot be written in the task directory')
    expect(notSavedWhy(notSaved.trimEnd())).toBe('it cannot be written in the task directory')
    expect(notSavedWhy('walnut: keep could not save this run\'s state (x)\n')).toBeNull()
    expect(notSavedWhy('a walnut: keep could not save this run\'s state (x); the next keep call starts from the last saved one\n')).toBeNull()
    expect(notSavedWhy('')).toBeNull()
  })

  it('keep in the answer: saved false only when the run said so; gone; not entered; entered in the shell', () => {
    const kept = { dir: '/home/u/app' }
    expect(keepAnswer({ background: false, out: body, kept })).toEqual({ saves: true })
    expect(keepAnswer({ background: false, out: { ...body, output: `x\n${notSaved}` }, kept })).toEqual({ saves: true, saved: false, why: 'it cannot be written in the task directory' })
    // Still running, or a background run: nothing said about the save yet.
    expect(keepAnswer({ background: false, out: { ...body, running: true, output: notSaved }, kept })).toEqual({ saves: true })
    expect(keepAnswer({ background: true, out: { ...body, output: notSaved }, kept })).toEqual({ saves: false })
    expect(keepAnswer({ background: false, out: { ...body, cwd: '/home/u' }, kept, gone: '/home/u/app' })).toEqual({ saves: true, gone: '/home/u/app' })
    expect(keepAnswer({ background: false, out: { ...body, exitCode: null, signal: null }, kept })).toEqual({ saves: true, notEntered: '/home/u/app' })
    expect(keepAnswer({ background: false, out: { ...body, exitCode: null, signal: 'SIGTERM' }, kept })).toEqual({ saves: true })
    expect(keepAnswer({ background: false, out: body, kept: { shellCd: true } })).toEqual({ saves: true, shellCd: true })
  })

  it('a keep run: where it started, and that its end carries to the next keep call', () => {
    const o = outcome({ ...body, keep: { saves: true } }, { keep: true })
    expect(o).toMatch(/^Exit 0 on macbox in \/home\/u\/app \(bash\) after 50 ms\./)
    expect(o).toContain('It started where this task\'s last keep call on macbox ended')
    expect(o).toContain('its directory and exported variables at its end carry to the next keep call there.')
    const cwd = outcome({ ...body, keep: { saves: true } }, { keep: true, cwd: '/home/u/app' })
    expect(cwd).toMatch(/^Exit 0 on macbox in \/home\/u\/app \(bash\)/)
    expect(cwd).toContain('It started in the cwd you gave')
    expect(outcome({ ...body, running: true, exitCode: null, keep: { saves: true } }, { keep: true })).toContain('carry to the next keep call there once it ends')
  })

  it('a kept directory that is gone, a save that did not complete, a shell that could not start, a shell that entered it itself', () => {
    const gone = outcome({ ...body, cwd: '/home/u', keep: { saves: true, gone: '/home/u/app' } }, { keep: true })
    expect(gone).toMatch(/^Exit 0 on macbox in \/home\/u \(bash\)/)
    expect(gone).toContain('The kept directory /home/u/app is gone; this run started in /home/u, with the exported variables')
    const failed = outcome({ ...body, keep: { saves: true, saved: false, why: 'it cannot be written in the task directory' } }, { keep: true })
    expect(failed).toContain('its state was not saved (it cannot be written in the task directory), so the next keep call starts from the last saved one.')
    expect(failed).not.toContain('carry to the next keep call')
    const notEntered = outcome({ ...body, exitCode: null, signal: null, keep: { saves: true, notEntered: '/home/u/app' } }, { keep: true })
    expect(notEntered).toMatch(/^Did not start on macbox in \/home\/u\/app \(bash\)\. Its shell could not start in the kept directory \/home\/u\/app/)
    const shell = outcome({ ...body, cwd: '/home/u', keep: { saves: true, shellCd: true } }, { keep: true })
    expect(shell).toMatch(/^Exit 0 on macbox \(bash\)/)
    expect(shell).toContain('could not hand Walnut the kept directory, so the shell entered it itself')
  })

  it('a background keep run saves nothing; an older server ran it without keep; a call without keep says nothing of it', () => {
    expect(outcome({ ...body, running: true, exitCode: null, keep: { saves: false } }, { keep: true, background: true })).toContain('as a background run, its own directory and variables do not carry to the next keep call')
    const old = outcome(body, { keep: true })
    expect(old).toContain('The Walnut server is older than keep, so it ran this without it')
    expect(old).toMatch(/^Exit 0 on macbox in \/home\/u\/app \(bash\)/)
    expect(outcome(body, {})).not.toContain('keep')
  })
})
