/**
 * How the host side of host_exec (src/providers/host-exec-core.ts, host-exec-v2) runs a
 * line, with REAL shells: the login shell (zsh here, as on a Mac) sets up the environment
 * from the user's profile, then bash runs the line, so zsh's rules never read it
 * (2026-11-03: `echo ===` failed "== not found" and `log show` hit the zsh builtin on a
 * user's Mac). The child gets WALNUT_TASK_DIR, the caller task's directory on this host,
 * made with its marker (a command writing `> $WALNUT_TASK_DIR/x.txt` wrote `/x.txt`), and
 * a line that reads it is refused where the host has none. Every reply names the shell.
 *
 * MACHINE SAFETY: HOME, the task root and the state dir are temp paths; the commands only
 * echo and printf.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { BASH_CANDIDATES, createHostExec, findBash, shellPlan, HOST_EXEC_VERSION, LINE_ENV } from '../../src/providers/host-exec-core.js'
import { LEGACY_RUNNER } from '../../src/core/hosts/host-exec-legacy.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-exec-shell-')))
afterAll(() => { if (root.includes('walnut-host-exec-shell-')) fs.rmSync(root, { recursive: true, force: true }) })

const ZSH = ['/bin/zsh', '/usr/bin/zsh'].find((f) => fs.existsSync(f))
// The guard's refusing ssh/claude first, then the system tools the shells need.
const SYSTEM_PATH = guardedPath([], '/usr/bin:/bin')

function hostExec(name: string, shell: string, opts: { taskRoot?: boolean; bash?: string | null } = {}) {
  const dir = path.join(root, name)
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  // The user's profiles: each login shell reads its own (zsh .zprofile, sh/bash .profile).
  const profile = 'export FROM_PROFILE=yes\nexport PATH=$HOME/bin:$PATH\n'
  fs.writeFileSync(path.join(home, '.zprofile'), profile)
  fs.writeFileSync(path.join(home, '.profile'), profile)
  fs.mkdirSync(path.join(home, 'bin'))
  fs.writeFileSync(path.join(home, 'bin', 'my-tool'), '#!/bin/sh\necho my-tool ran\n', { mode: 0o755 })
  // Prints the variable without the line naming it (a line that names it is refused where it is unset).
  fs.writeFileSync(path.join(home, 'bin', 'show-task-dir'), '#!/bin/sh\necho "[${WALNUT_TASK_DIR-unset}]"\n', { mode: 0o755 })
  const core = createHostExec({
    spawn: (cmd, args, o) => spawn(cmd, args, o),
    killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
    shell, home, taskDirRoot: opts.taskRoot === false ? null : path.join(dir, 'tasks'), stateDir: path.join(dir, 'state'),
    // ZDOTDIR: zsh reads its profiles from the test home, never the real one.
    env: { PATH: SYSTEM_PATH, HOME: home, ZDOTDIR: home },
    // Never the real ps and log, even where this suite runs on a Mac.
    promptProbe: null,
    ...(opts.bash !== undefined ? { bash: opts.bash } : {}),
  })
  return { core, dir, home }
}

describe('host_exec runs the line in bash after the login shell', () => {
  it('plans the hop from the login shell to bash, and none from bash itself', () => {
    expect(shellPlan('/bin/zsh', '/bin/bash', 'echo ===')).toEqual({ args: ['-l', '-c', "exec /bin/bash -c 'echo ==='"], shell: 'bash', loginShell: 'zsh' })
    expect(shellPlan('/usr/local/bin/bash', '/bin/bash', 'echo hi')).toEqual({ args: ['-l', '-c', 'echo hi'], shell: 'bash', loginShell: 'bash' })
    expect(shellPlan('/bin/zsh', null, 'echo hi')).toEqual({ args: ['-l', '-c', "exec /bin/sh -c 'echo hi'"], shell: 'sh', loginShell: 'zsh' })
    expect(shellPlan('/bin/sh', null, 'echo hi')).toEqual({ args: ['-l', '-c', 'echo hi'], shell: 'sh', loginShell: 'sh' })
    // host-exec-v2 is advertised from version 2 on (3 added exec.read `until`).
    expect(HOST_EXEC_VERSION).toBeGreaterThanOrEqual(2)
    expect(findBash(SYSTEM_PATH)).toMatch(/\/bash$/)
  })

  it('prefers a Homebrew or MacPorts bash 5 over a Mac\'s /bin/bash 3.2, and the legacy runner tries the same list', () => {
    const on = (...files: string[]) => (f: string) => files.includes(f)
    expect(findBash('/usr/bin:/bin', on('/bin/bash', '/opt/homebrew/bin/bash'))).toBe('/opt/homebrew/bin/bash')
    expect(findBash('/usr/bin:/bin', on('/bin/bash', '/usr/local/bin/bash'))).toBe('/usr/local/bin/bash')
    expect(findBash('/usr/bin:/bin', on('/bin/bash', '/opt/local/bin/bash'))).toBe('/opt/local/bin/bash')
    expect(findBash('/usr/bin:/bin', on('/bin/bash', '/usr/bin/bash'))).toBe('/bin/bash')
    expect(findBash('/nix/bin:/usr/bin', on('/nix/bin/bash'))).toBe('/nix/bin/bash')
    expect(findBash('/usr/bin', on())).toBeNull()
    expect(/for b in ([^;]+); do/.exec(LEGACY_RUNNER)?.[1].split(' ')).toEqual(BASH_CANDIDATES)
  })

  it.skipIf(!ZSH)('zsh as the login shell: its profile sets the environment, bash reads the line', async () => {
    const { core } = hostExec('zsh', ZSH!)
    const r = await core.run({ jobId: 'hx-zsh-0001', taskId: 'task-zsh', command: 'echo ===; echo "$FROM_PROFILE"; my-tool; [ -n "$BASH_VERSION" ] && echo bash' })
    expect(r).toMatchObject({ running: false, exitCode: 0, shell: 'bash', loginShell: 'zsh' })
    expect(r.output).toBe('===\nyes\nmy-tool ran\nbash\n')
    // `log` is a zsh builtin ("too many arguments"); in bash it is whatever program PATH has.
    const log = await core.run({ jobId: 'hx-zsh-0002', taskId: 'task-zsh', command: 'log show --last 1m 2>&1; true' })
    expect(log.output).not.toContain('too many arguments')
    // An unmatched glob and a `?` are words to bash, not a "no matches found" stop.
    const glob = await core.run({ jobId: 'hx-zsh-0003', taskId: 'task-zsh', command: 'echo nomatch-*.xyz http://x/?a=1' })
    expect(glob).toMatchObject({ exitCode: 0, output: 'nomatch-*.xyz http://x/?a=1\n' })
    // argv goes the same way, its arguments never parsed.
    const argv = await core.run({ jobId: 'hx-zsh-0004', taskId: 'task-zsh', argv: ['printf', '%s|', '===', "it's $HOME"] })
    expect(argv).toMatchObject({ exitCode: 0, output: "===|it's $HOME|", shell: 'bash' })
  })

  it('sh as the login shell: its .profile applies, bash runs the line', async () => {
    const { core } = hostExec('sh', '/bin/sh')
    const r = await core.run({ jobId: 'hx-sh-00001', taskId: 'task-sh', command: 'echo "$FROM_PROFILE"; my-tool; [ -n "$BASH_VERSION" ] && echo bash' })
    expect(r).toMatchObject({ exitCode: 0, output: 'yes\nmy-tool ran\nbash\n', shell: 'bash', loginShell: 'sh' })
  })

  it('under fish or csh the line rides the environment, never their quoting', async () => {
    const plan = shellPlan('/opt/homebrew/bin/fish', '/bin/bash', "printf '%s\\n' a\\b")
    expect(plan).toEqual({
      args: ['-l', '-c', `exec /bin/bash -c '__walnut_line=$${LINE_ENV}; unset ${LINE_ENV}; eval "$__walnut_line"'`],
      shell: 'bash', loginShell: 'fish', env: { [LINE_ENV]: "printf '%s\\n' a\\b" },
    })
    expect(shellPlan('/bin/tcsh', '/bin/bash', 'echo hi').args[0]).toBe('-c') // csh takes -l only alone
    // A stand-in login shell named fish (this machine has none): the hop and bash reading the line
    // from the environment, backslashes, quotes and newlines intact, the variable gone before it runs.
    const { core, home } = hostExec('fishy', '/bin/sh')
    const fish = path.join(home, 'fish')
    fs.writeFileSync(fish, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 })
    const viaFish = createHostExec({
      spawn: (cmd, args, o) => spawn(cmd, args, o),
      killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
      shell: fish, home, taskDirRoot: null, stateDir: path.join(root, 'fishy', 'state2'),
      env: { PATH: SYSTEM_PATH, HOME: home }, promptProbe: null,
    })
    const line = "printf '%s|' 'a\\b' \"it's\" $'tab\\tx'\necho\necho \"[${WALNUT_HOST_EXEC_LINE-unset}]\""
    const r = await viaFish.run({ jobId: 'hx-fish-0001', taskId: 'task-fish', command: line })
    expect(r).toMatchObject({ exitCode: 0, shell: 'bash', loginShell: 'fish', output: "a\\b|it's|tab\tx|\n[unset]\n" })
    void core
  })

  it('a host with no bash runs the line in sh, and says so', async () => {
    const { core } = hostExec('nobash', ZSH ?? '/bin/sh', { bash: null })
    const r = await core.run({ jobId: 'hx-nob-00001', taskId: 'task-nob', command: 'echo ===' })
    expect(r).toMatchObject({ exitCode: 0, output: '===\n', shell: 'sh' })
  })
})

describe('host_exec sets WALNUT_TASK_DIR to the caller task\'s directory', () => {
  it('the child writes into the task directory, made with its marker, where the logs are too', async () => {
    const { core, dir } = hostExec('taskdir', '/bin/sh')
    const taskDir = path.join(dir, 'tasks', 'task-td-1')
    const r = await core.run({ jobId: 'hx-td-000001', taskId: 'task-td-1', home: '/data/walnut-home', command: 'printf %s "$WALNUT_TASK_DIR" > "$WALNUT_TASK_DIR/x.txt"; cat "$WALNUT_TASK_DIR/x.txt"' })
    expect(r).toMatchObject({ exitCode: 0, output: taskDir, taskDir })
    expect(fs.readFileSync(path.join(taskDir, 'x.txt'), 'utf8')).toBe(taskDir)
    expect(r.logFile).toBe(path.join(taskDir, 'host-exec', 'hx-td-000001.log'))
    // The marker makes it a task directory like a session's: the sweep cleans it up, its owner named.
    expect(JSON.parse(fs.readFileSync(path.join(taskDir, '.walnut-task.json'), 'utf8'))).toMatchObject({ taskId: 'task-td-1', home: '/data/walnut-home' })
    // A read names it too.
    expect(await core.read({ jobId: 'hx-td-000001' })).toMatchObject({ taskDir, shell: 'bash' })
  })

  it('where the host keeps no task directory, the variable is unset and a line that reads it is refused', async () => {
    const { core } = hostExec('notaskdir', '/bin/sh', { taskRoot: false })
    const plain = await core.run({ jobId: 'hx-ntd-00001', taskId: 'task-ntd', command: 'show-task-dir' })
    expect(plain).toMatchObject({ exitCode: 0, output: '[unset]\n', taskDir: null })
    await expect(core.run({ jobId: 'hx-ntd-00002', taskId: 'task-ntd', command: 'echo hi > "$WALNUT_TASK_DIR/x.txt"' }))
      .rejects.toMatchObject({ code: 'task_dir_unset' })
    // A task id that cannot be a directory name gets none either.
    const odd = hostExec('oddid', '/bin/sh')
    await expect(odd.core.run({ jobId: 'hx-odd-00001', taskId: '../escape', command: 'ls "$WALNUT_TASK_DIR"' })).rejects.toMatchObject({ code: 'task_dir_unset' })
    expect(fs.existsSync(path.join(odd.dir, 'escape'))).toBe(false)
  })
})
