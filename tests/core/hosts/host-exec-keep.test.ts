/**
 * host_exec keep, the server side (src/core/hosts/host-exec-keep.ts): the line it builds, the checks
 * of the call's `keep`, the read of the pointer from the host, keep's mark, what the answer says
 * (src/ops/host-exec-answers.ts), and the refusals in keep's words. The shell itself is tested against
 * real bash in host-exec-keep-bash.test.ts, the whole call in tests/e2e/host-exec-e2e.test.ts.
 *
 * MACHINE SAFETY: pure functions and fakes; no process, file or network.
 */
import { describe, expect, it } from 'vitest'
import { KEEP_POINTER, KEEP_SAVE_NAMES, KEEP_UNSET_FUNCTIONS, checkKeep, daemonCwd, keepAnswer, keepMarkWhy, keepPrefix, keepRefusal, keptDirOf, keptState, pointerOf, shapedLine, trapFirstLine, withKeepMarkSaid, withoutKeepMark } from '../../../src/core/hosts/host-exec-keep.js'
import { failedStepOf, sealFor, strictLine } from '../../../src/core/hosts/host-exec-strict.js'
import { HostExecError } from '../../../src/core/hosts/host-exec-target.js'
import { strictMark } from '../../../src/providers/host-exec-line.js'
import { permissionRisk } from '../../../src/providers/host-exec-guards.js'
import { cltStubRun, type CltFs } from '../../../src/providers/host-exec-clt.js'
import { runOutcome } from '../../../src/ops/host-exec-answers.js'

const J = 'hx-keep-unit-1'
/** The run's seal (strict's): made when the line is shaped. */
const sealOf = (jobId: string) => { shapedLine({ command: 'true', keep: true }, jobId); return sealFor(jobId)! }
const NULLS = '0</dev/null 1>/dev/null 2>/dev/null 3>/dev/null 4>/dev/null 5>/dev/null 6>/dev/null 7>/dev/null 8>/dev/null 9>/dev/null'
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

  it('puts one physical line before the caller\'s, and nothing after it; the generation the server read rides in it', () => {
    const command = 'cd repo\nexport A=1\necho "$A"'
    const line = shapedLine({ command, keep: true }, J, { gen: '1793899242-123-456' })!
    const [first, ...rest] = line.split('\n')
    expect(rest).toEqual(['export A=1', 'echo "$A"'])
    expect(first!.endsWith('; cd repo')).toBe(true)
    expect(line.endsWith(command)).toBe(true)
    for (const gen of [null, 'g1', 'shell'] as const) {
      for (const enter of [false, true]) for (const save of [false, true]) expect(keepPrefix({ gen, enter, save, seal: sealOf(J) })).not.toContain('\n')
    }
    expect(line.startsWith('if [ -n "${BASH_VERSION:-}" ]; then ')).toBe(true)
    expect(line).toContain('walnut_kh="$WALNUT_TASK_DIR/host-exec"; walnut_kg=1793899242-123-456;')
    expect(line).toContain('walnut_kf="$walnut_kh/keep.d/$walnut_kg.sh"')
    // None kept: no generation, nothing sourced.
    expect(shapedLine({ command, keep: true }, J)).toContain('walnut_kg=;')
    // Only a name of letters, digits and - ever goes into the line.
    for (const bad of ['a b', 'a;b', '$(x)', 'a/b', '']) expect(() => shapedLine({ command, keep: true }, J, { gen: bad })).toThrow()
  })

  it('its EXIT trap: first the line that removes tracing, functions and aliases with no lookup; then the save, in a subshell, one snapshot then the pointer', () => {
    const seal = sealOf(J)
    const trap = unquote(trapOf(shapedLine({ command: 'true', keep: true }, J)!)!)
    const [first, second, ...rest] = trap.split('\n')
    expect(first).toBe(trapFirstLine(seal))
    expect(first).toBe(`{ POSIXLY_CORRECT=y || \\:; \\trap - ERR DEBUG; \\set +xveu; \\unset -f ${KEEP_UNSET_FUNCTIONS.join(' ')} && \\set +o posix; } ${NULLS}`
      + ` || { \\trap -- $'\\nwalnut keep ${seal}: could not save (the line made a function the save needs readonly)' RETURN; { \\trap -p RETURN; } >&2; \\exit; }`
      + '; { \\builtin unset -v POSIXLY_CORRECT; } 2>/dev/null; \\builtin shopt -u expand_aliases')
    // In the group and on its failure, only special builtins (found before any function in posix mode), each quoted (no alias).
    const group = first!.slice(0, first!.indexOf(` } ${NULLS}`))
    expect(group.split(/; | && | \|\| /).map((c) => c.replace(/^\{ /, '').split(' ')[0])).toEqual(['POSIXLY_CORRECT=y', '\\:', '\\trap', '\\set', '\\unset', '\\set'])
    expect(KEEP_UNSET_FUNCTIONS).toEqual(expect.arrayContaining(['builtin', 'exec']))
    // No assignment to a walnut_ name before the save's subshell: a readonly name cannot change the run's exit code.
    expect(`${first}\n${second}`).not.toMatch(/\bwalnut_\w+=/)
    expect(second).toBe('\\builtin set +af; \\builtin shopt -u nocasematch nullglob failglob')
    // The shell waits for the save with its stderr on /dev/null (a reaped job's notice goes nowhere); the save says why on fd 4.
    expect(rest[0]).toBe('\\exec 4>&-; \\exec 4>&2; {')
    expect(rest[1]).toBe('(')
    expect(rest[rest.length - 1]).toBe(') >/dev/null; } 2>/dev/null')
    const save = rest.join('\n')
    expect(save).toContain(`\\builtin printf "\\nwalnut keep ${seal}: could not save (%s)\\n"`)
    expect(rest.slice(1).join('\n')).not.toMatch(/>&2/)
    // The names it assigns lose what the line made of them first; a readonly one then stops it.
    expect(save).toContain(`{ \\builtin unset -n ${KEEP_SAVE_NAMES.join(' ')}; \\builtin unset -v ${KEEP_SAVE_NAMES.join(' ')}; \\builtin unset -v GLOBIGNORE; } 2>/dev/null`)
    expect(save.indexOf('\\builtin unset -n')).toBeLessThan(save.indexOf('&& \\builtin printf ok;'))
    // One snapshot, written once; then the pointer, through a temp file and one mv; then the old snapshots.
    const snap = save.indexOf('>| "$walnut_kq/$walnut_g.sh"')
    const ptr = save.indexOf('>| "$walnut_kh/keep.current.$walnut_g"')
    const mv = save.indexOf('mv -f -- "$walnut_kh/keep.current.$walnut_g" "$walnut_kh/keep.current"')
    const sweep = save.indexOf('walnut_a=("$walnut_kq"/[0-9]*-*.sh)')
    expect(snap).toBeGreaterThan(0)
    expect(snap).toBeLessThan(ptr)
    expect(ptr).toBeLessThan(mv)
    expect(mv).toBeLessThan(sweep)
    expect(save).toContain('\\builtin printf "%s\\n%s" "$walnut_g" "$walnut_kd"')
    expect(save).toContain('walnut_g=$walnut_t-$$-$RANDOM')
    // Un-exported before the first program starts.
    for (const program of ['date', 'mkdir', 'mv', 'rm']) expect(save.indexOf('export -n'), program).toBeLessThan(save.indexOf(`command -p ${program}`))
    // Every command the save runs is a backslash-quoted builtin (no alias, no function), a program through it.
    const code = save.replace(/"(?:[^"\\]|\\.)*"/g, '""')
    for (const name of ['printf', 'declare', 'compgen', 'export', 'set', 'shopt', 'trap', 'umask', 'pwd', 'command', 'unset', 'exit', 'continue']) {
      const uses = [...code.matchAll(new RegExp(`(?<![\\w-])${name}(?![\\w=-])`, 'g'))]
      for (const m of uses) expect(code.slice(Math.max(0, m.index! - 9), m.index), name).toBe('\\builtin ')
    }
    for (const name of ['date', 'mv', 'mkdir', 'rm']) {
      const uses = [...code.matchAll(new RegExp(`(?<![\\w-])${name}(?![\\w=-])`, 'g'))]
      expect(uses.length, name).toBeGreaterThan(0)
      for (const m of uses) expect(code.slice(Math.max(0, m.index! - 11), m.index), name).toBe('command -p ')
    }
    // exec keeps its redirections only bare: quoted (no alias), the first line removed any function of that name.
    expect([...code.matchAll(/(?<![\w-])exec(?![\w=-])/g)]).toHaveLength(2)
  })

  it('sets its EXIT trap only for a foreground run; the shell reads the pointer only when the server could not, and enters the directory only with no cwd named', () => {
    const fg = shapedLine({ command: 'true', keep: true }, J, { gen: 'g1' })!
    expect(trapOf(fg)).not.toBeNull()
    expect(fg).not.toContain('builtin cd')
    expect(fg).not.toContain('walnut_kg=$(<')
    const shell = shapedLine({ command: 'true', keep: true }, J, { shellCd: true })!
    expect(shell).toContain('walnut_kg=$(< "$walnut_kh/keep.current"); walnut_kg=${walnut_kg%%"$walnut_nl"*}; case $walnut_kg in (*[!A-Za-z0-9-]*) walnut_kg=;; esac')
    expect(shell).toContain('builtin cd -- "$walnut_kd"')
    const bg = shapedLine({ command: 'true', keep: true, background: true }, J, { shellCd: true })!
    expect(bg).not.toContain('EXIT')
    expect(bg).toContain('builtin cd -- "$walnut_kd"')
    const withCwd = shapedLine({ command: 'true', keep: true, cwd: '/srv/app' }, J, { shellCd: true })!
    expect(withCwd).not.toContain('builtin cd')
    expect(withCwd).toContain('walnut_kg=$(<')
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
    expect(failedStepOf(`${M} 1 [1]: trap '${trapFirstLine('0123456789ab')}\n`, id, 1)).toBeNull()
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
    // The daemon is given a directory that ends in white space as `<dir>/.`: its refusal may name that.
    const dotted = keepRefusal(new HostExecError('`trap` would read /Users/sam/Desktop /., which macOS guards: it shows a permission dialog. Nothing ran.', 409, 'may_prompt'), 'macbox', '/Users/sam/Desktop ') as HostExecError
    expect(dotted.message).toMatch(/^This keep call would start in \/Users\/sam\/Desktop , where/)
    const plainPrompt = new HostExecError('dialog', 409, 'may_prompt')
    expect((keepRefusal(plainPrompt, 'macbox', null) as HostExecError).message).toBe('dialog')
    const other = new HostExecError('cwd missing', 400, 'cwd_missing')
    expect(keepRefusal(other, 'x')).toBe(other)
    expect(other.message).toBe('cwd missing')
  })
})

describe('the snapshot, read from the host', () => {
  const conn = (caps: string[], root: string | null = '/state/tasks') => ({ hasCapability: (c: string) => caps.includes(c), taskDirRoot: root })
  const answer = (text: string) => ({ ok: true, data: Buffer.from(text).toString('base64'), bytesRead: Buffer.byteLength(text), fileSize: Buffer.byteLength(text), eof: true })

  it('one fs.readRange of keep.current in the task\'s directory there: its generation and its directory, as one', async () => {
    const asked: Array<Record<string, unknown>> = []
    const kept = await keptState(conn(['fs.readRange']), 'task-1', async (p) => { asked.push(p); return answer('1793899242-12-34\n/home/u/my dir\nx') })
    expect(kept).toEqual({ gen: '1793899242-12-34', dir: '/home/u/my dir\nx' })
    expect(asked).toEqual([{ path: `/state/tasks/task-1/${KEEP_POINTER}`, start: 0, length: 64 + 1 + 4096 + 1 }])
  })

  it('no file, an empty or unreadable one, or one that is not a generation and a path: no snapshot', async () => {
    const none = async (reply: Record<string, unknown>) => keptState(conn(['fs.readRange']), 'task-1', async () => reply)
    const empty = { gen: null, dir: null }
    expect(await none({ ok: false, error: 'fs.readRange failed: ENOENT: no such file or directory (ENOENT)' })).toEqual(empty)
    expect(await none({ ok: false, error: 'fs.readRange failed: not a regular file (ENOTFILE)' })).toEqual(empty)
    for (const text of ['', 'g1', 'g1\n', '\n/a', 'g 1\n/a', 'g;1\n/a', `${'g'.repeat(65)}\n/a`, 'g1\nrelative/dir']) expect(await none(answer(text)), JSON.stringify(text)).toEqual(empty)
    expect(await none({ ...answer('g1\n/a'), fileSize: 9000 })).toEqual(empty)
    expect(pointerOf(Buffer.from('g-1\n/a b '))).toEqual({ gen: 'g-1', dir: '/a b ' })
    expect(keptDirOf(Buffer.from([0x2f, 0xff]))).toBeNull()
    expect(keptDirOf(Buffer.from('/a\0b'))).toBeNull()
    expect(keptDirOf(Buffer.from(`/${'a'.repeat(4096)}`))).toBeNull()
    expect(keptDirOf(Buffer.from('/été'))).toBe('/été')
  })

  it('a host that cannot hand it over: the shell reads it itself', async () => {
    const never = async (): Promise<Record<string, unknown>> => { throw new Error('not asked') }
    expect(await keptState(conn([]), 'task-1', never)).toEqual({ shellCd: true })
    expect(await keptState(conn(['fs.readRange'], null), 'task-1', never)).toEqual({ shellCd: true })
    expect(await keptState(conn(['fs.readRange']), '../escape', never)).toEqual({ shellCd: true })
    expect(await keptState(conn(['fs.readRange']), 'task-1', async () => ({ ok: false, error: 'out of scope for this Walnut' }))).toEqual({ shellCd: true })
    // A read lost on the way ends the call (nothing ran yet).
    await expect(keptState(conn(['fs.readRange']), 'task-1', async () => { throw new HostExecError('lost', 503, 'host_offline') })).rejects.toMatchObject({ code: 'host_offline' })
  })

  it('a kept directory that ends in white space goes to the daemon as <dir>/., which its trim leaves whole', () => {
    for (const dir of ['/a b ', '/a\t', '/a\n', '/odd  ']) {
      expect(daemonCwd(dir)).toBe(`${dir}/.`)
      expect(daemonCwd(dir).trim()).toBe(`${dir}/.`)
    }
    for (const dir of ['/a b', '/', '/x/y']) expect(daemonCwd(dir)).toBe(dir)
  })
})

describe('what the answer says', () => {
  const body = { host: 'macbox', jobId: 'hx-1', running: false, exitCode: 0, signal: null, ms: 50, cwd: '/home/u/app', shell: 'bash', output: '' }
  const outcome = (b: Record<string, unknown>, args: Record<string, unknown>) => String((runOutcome(b, args) as { outcome: string }).outcome)
  const WHY = 'it cannot be written in the task directory'
  const sentence = (why: string) => `walnut: keep could not save this run's state (${why}); the next keep call starts from the last saved one\n`

  it('reads keep\'s mark with the run\'s seal anywhere in the output, in either form, and says it on a line of its own', () => {
    const id = 'hx-keep-unit-mark'
    const seal = sealOf(id)
    const mark = (why: string) => `\nwalnut keep ${seal}: could not save (${why})\n`
    const byTrap = (why: string) => `trap -- '\nwalnut keep ${seal}: could not save (${why})' RETURN\n`
    for (const [output, shown] of [
      [mark(WHY), sentence(WHY)],
      [`out\n${mark(WHY)}`, `out\n${sentence(WHY)}`],
      // Output with no line end: the mark's own newline keeps the sentence on its line.
      [`no-newline${mark(WHY)}`, `no-newline\n${sentence(WHY)}`],
      [byTrap(WHY), sentence(WHY)],
      [`no-newline${byTrap(WHY)}`, `no-newline\n${sentence(WHY)}`],
      [`a\n${byTrap(WHY)}`, `a\n${sentence(WHY)}`],
      // At the very end with no newline after it (an output cut there).
      [`x${mark(WHY).trimEnd()}`, `x\n${sentence(WHY)}`],
    ]) {
      expect(keepMarkWhy(output, id), JSON.stringify(output)).toBe(WHY)
      expect(withKeepMarkSaid(output, id), JSON.stringify(output)).toBe(shown)
    }
    expect(keepMarkWhy(`${mark('first')}${mark(WHY)}`, id)).toBe(WHY)
    expect(withoutKeepMark(`a\n${mark(WHY)}`, id)).toBe('a\n')
    // What the run printed itself: the sentence, a mark with another seal or none, the mark of another run.
    for (const output of [sentence(WHY), `\nwalnut keep 0123456789ab: could not save (${WHY})\n`, `\nwalnut keep: could not save (${WHY})\n`, `walnut keep ${seal}: could not save (${WHY})\n`]) {
      expect(keepMarkWhy(output, id), output).toBeNull()
      expect(withKeepMarkSaid(output, id), output).toBe(output)
    }
    expect(keepMarkWhy(mark(WHY), 'hx-keep-unit-other')).toBeNull()
    expect(withKeepMarkSaid(mark(WHY), 'hx-keep-unit-other')).toBe(mark(WHY))
  })

  it('keep in the answer: saved false only when the run\'s mark says so; gone; not entered; entered in the shell', () => {
    const id = 'hx-keep-unit-answer'
    const marked = `x\nwalnut keep ${sealOf(id)}: could not save (${WHY})\n`
    const a = (o: Partial<Parameters<typeof keepAnswer>[0]>) => keepAnswer({ background: false, out: body, output: '', jobId: id, keptDir: '/home/u/app', shellCd: false, ...o })
    expect(a({})).toEqual({ saves: true })
    expect(a({ output: marked })).toEqual({ saves: true, saved: false, why: WHY })
    // The sentence printed by the run is not the mark.
    expect(a({ output: sentence(WHY) })).toEqual({ saves: true })
    // Still running, or a background run: nothing said about the save yet.
    expect(a({ out: { ...body, running: true }, output: marked })).toEqual({ saves: true })
    expect(a({ background: true, output: marked })).toEqual({ saves: false })
    expect(a({ out: { ...body, cwd: '/home/u' }, gone: '/home/u/app' })).toEqual({ saves: true, gone: '/home/u/app' })
    expect(a({ out: { ...body, exitCode: null, signal: null } })).toEqual({ saves: true, notEntered: '/home/u/app' })
    expect(a({ out: { ...body, exitCode: null, signal: 'SIGTERM' } })).toEqual({ saves: true })
    expect(a({ keptDir: null, shellCd: true })).toEqual({ saves: true, shellCd: true })
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
    const failed = outcome({ ...body, keep: { saves: true, saved: false, why: WHY } }, { keep: true })
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
