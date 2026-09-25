/**
 * Remote commands run through `sh -s` with Walnut's markers (remote-sh.ts), so
 * a login shell that prints a banner, or that is not a POSIX shell at all,
 * cannot corrupt an answer the connect path parses as JSON or a port.
 *
 * MACHINE SAFETY: a fake `ssh` on PATH stands in for the real one. It never
 * opens a connection: it plays sshd, handing the remote command line to a fake
 * LOGIN SHELL (`$FAKE_LOGIN_SHELL -c <line>`), which is how the real sshd runs
 * `ssh host <line>`. Everything lives in a temp dir; PATH is restored after.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  REMOTE_BEGIN_MARKER, REMOTE_END_MARKER, RemoteCommandError, RemoteShellNoiseError, extractMarkedOutput,
  isSshTransportFailure, markedUploadCommand, runRemoteSh, shDataCommand, userShellPathScript, wrapRemoteScript,
} from '../../src/providers/remote-sh.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { classifyHostConnectError } from '../../src/core/sessions/host-connect-hint.js'

let dir = ''
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = ['PATH', 'FAKE_LOGIN_SHELL', 'FAKE_SSH_FAIL', 'FAKE_SSH_LOG']

function write(name: string, body: string): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, body, { mode: 0o755 })
  return p
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-remote-sh-'))
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  // sshd: skip the options, take the host, hand the rest to the login shell.
  write('ssh', [
    '#!/bin/sh',
    'while [ $# -gt 0 ]; do case "$1" in -o|-p|-L|-S) shift 2;; -*) shift;; *) break;; esac; done',
    'shift',
    'if [ -n "$FAKE_SSH_FAIL" ]; then echo "me@devbox: Permission denied (publickey)." >&2; exit 255; fi',
    '[ -n "$FAKE_SSH_LOG" ] && printf "%s\\n" "$*" >> "$FAKE_SSH_LOG"',
    'exec "$FAKE_LOGIN_SHELL" -c "$*"',
  ].join('\n'))
  // A bash whose rc prints a banner before AND a line after every command.
  write('banner-shell', [
    '#!/bin/sh',
    'echo "Welcome to devbox, last login from 10.0.0.1"',
    'echo "{\\"not\\": \\"the answer\\"}"',
    '/bin/sh -c "$2"; rc=$?',
    'echo "logout banner"',
    'exit $rc',
  ].join('\n'))
  // A csh-like login shell: rejects POSIX-only syntax, and greets on stdout.
  write('csh-like', [
    '#!/bin/sh',
    'case "$2" in *\'$(\'*|*\'2>&1\'*|*\'||\'*) echo "Illegal variable name." >&2; exit 1;; esac',
    'echo "csh: welcome"',
    'exec /bin/sh -c "$2"',
  ].join('\n'))
  // A login shell that never runs the command (a ForceCommand, a menu).
  write('restricted-shell', '#!/bin/sh\necho "This account is restricted."\nexit 0\n')
  process.env.PATH = `${dir}:${process.env.PATH}`
})

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

const SSH = ['-o', 'BatchMode=yes', 'me@devbox']
/** Bash-flavoured script, the kind checkDaemonRunning sends. */
const JSON_SCRIPT = 'PID=$(echo 4242); PORT=$(echo 32100 2>&1) || true; echo "{\\"running\\":true,\\"pid\\":$PID,\\"port\\":$PORT}"'

describe('wrapRemoteScript / extractMarkedOutput (pure)', () => {
  it('keeps only the text between the markers, whatever surrounds it', () => {
    const out = `banner\n${REMOTE_BEGIN_MARKER}\n42\n\n${REMOTE_END_MARKER}\nlogout\n`
    expect(extractMarkedOutput(out)).toEqual({ found: true, body: '42' })
  })

  it('a reply without both markers is not an answer', () => {
    expect(extractMarkedOutput('just a banner\n').found).toBe(false)
    expect(extractMarkedOutput(`${REMOTE_BEGIN_MARKER}\ncut off`).found).toBe(false)
  })

  it('an exit inside the script still reaches the END marker, with its status', () => {
    let out = ''
    let code = 0
    try {
      out = execFileSync('/bin/sh', ['-s'], { input: wrapRemoteScript('echo hi; exit 3'), encoding: 'utf-8' })
    } catch (e) {
      out = String((e as { stdout: string }).stdout)
      code = (e as { status: number }).status
    }
    expect(code).toBe(3)
    expect(extractMarkedOutput(out)).toEqual({ found: true, body: 'hi' })
  })

  it('a command that reads stdin cannot swallow the rest of the script', () => {
    const out = execFileSync('/bin/sh', ['-s'], { input: wrapRemoteScript('cat; echo after'), encoding: 'utf-8' })
    expect(extractMarkedOutput(out)).toEqual({ found: true, body: 'after' })
  })
})

describe('runRemoteSh against fake login shells', () => {
  it('a banner before and after the payload is ignored', async () => {
    process.env.FAKE_LOGIN_SHELL = path.join(dir, 'banner-shell')
    const out = await runRemoteSh(SSH, JSON_SCRIPT, 10_000)
    expect(JSON.parse(out)).toEqual({ running: true, pid: 4242, port: 32100 })
  })

  it('a csh-like login shell only ever sees `sh -s`, so bash syntax still runs', async () => {
    process.env.FAKE_LOGIN_SHELL = path.join(dir, 'csh-like')
    process.env.FAKE_SSH_LOG = path.join(dir, 'ssh.log')
    const out = await runRemoteSh(SSH, JSON_SCRIPT, 10_000)
    expect(JSON.parse(out).port).toBe(32100)
    // Proof it was the wrapper that made the difference: the same script as a
    // bare remote command line is rejected by that shell.
    expect(() => execFileSync(path.join(dir, 'csh-like'), ['-c', JSON_SCRIPT], { stdio: 'pipe' })).toThrow()
    expect(fs.readFileSync(path.join(dir, 'ssh.log'), 'utf-8').trim().split('\n').pop()).toBe('sh -s')
    delete process.env.FAKE_SSH_LOG
  })

  it('a zero exit without markers is shell_noise, with the first 200 chars of what came back', async () => {
    process.env.FAKE_LOGIN_SHELL = path.join(dir, 'restricted-shell')
    const err = await runRemoteSh(SSH, 'echo hi', 10_000).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RemoteShellNoiseError)
    expect((err as RemoteShellNoiseError).preview).toBe('This account is restricted.')
    expect(isSshTransportFailure(err)).toBe(true)
    expect(classifyHostConnectError((err as Error).message, 'me@devbox').kind).toBe('shell_noise')
  })

  it("ssh's own failure (exit 255) keeps its stderr for the classifier and counts as a dead link", async () => {
    process.env.FAKE_SSH_FAIL = '1'
    try {
      const err = await runRemoteSh(SSH, 'echo hi', 10_000).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(RemoteCommandError)
      expect((err as RemoteCommandError).code).toBe(255)
      expect((err as Error).message.split('\n')[0]).toBe('Command failed: ssh me@devbox sh -s')
      expect((err as Error).message).toContain('Permission denied (publickey).')
      expect(isSshTransportFailure(err)).toBe(true)
    } finally { delete process.env.FAKE_SSH_FAIL }
  })

  it('a script that fails is an error but not a dead link', async () => {
    process.env.FAKE_LOGIN_SHELL = path.join(dir, 'banner-shell')
    const err = await runRemoteSh(SSH, 'echo oops >&2; exit 4', 10_000).catch((e: unknown) => e)
    expect((err as RemoteCommandError).code).toBe(4)
    expect((err as Error).message).toContain('oops')
    expect(isSshTransportFailure(err)).toBe(false)
  })

  it('DaemonConnection.sshExec rides the same path (banner + csh-like shell)', async () => {
    const conn = new DaemonConnection('devbox', { hostname: 'devbox', user: 'me' })
    const exec = (conn as unknown as { sshExec(c: string, t?: number): Promise<string> }).sshExec.bind(conn)
    process.env.FAKE_LOGIN_SHELL = path.join(dir, 'banner-shell')
    expect(JSON.parse(await exec(JSON_SCRIPT)).pid).toBe(4242)
    process.env.FAKE_LOGIN_SHELL = path.join(dir, 'csh-like')
    expect(JSON.parse(await exec(JSON_SCRIPT)).pid).toBe(4242)
  })
})

describe('upload commands (stdin carries data)', () => {
  it('wrap one line in `sh -c` and mark the verification output', async () => {
    const target = path.join(dir, 'up load.bin')
    const cmd = markedUploadCommand(target, `wc -c < '${target}'`)
    expect(cmd.startsWith("sh -c '")).toBe(true)
    // Through the csh-like login shell, exactly as ssh would hand it over.
    const out = execFileSync(path.join(dir, 'csh-like'), ['-c', cmd], { input: 'hello', encoding: 'utf-8' })
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello')
    const marked = extractMarkedOutput(out)
    expect(marked.found && marked.body.trim()).toBe('5')
  })

  it('refuses a line csh or fish would misread', () => {
    expect(() => shDataCommand('a\nb')).toThrow()
    expect(() => shDataCommand('printf "x\\n"')).toThrow()
    expect(() => shDataCommand('echo hi!')).toThrow()
  })
})

describe('userShellPathScript: the node PATH still comes from the user\'s own shell', () => {
  const preamble = 'PATH="/from/preamble:$PATH"; export PATH'

  function runWithShell(shell: string): string {
    const script = `${userShellPathScript(preamble)}\nprintf '%s\\n' "$PATH"`
    return execFileSync('/bin/sh', ['-s'], { input: script, encoding: 'utf-8', env: { PATH: '/usr/bin:/bin', SHELL: shell, HOME: dir } }).trim()
  }

  it('a POSIX-family login shell runs the preamble and only its PATH comes back (its noise does not)', () => {
    // Named zsh so the case matches; prints noise on stdout like an rc would.
    const zsh = write('zsh', '#!/bin/sh\necho "p10k instant prompt noise"\nPATH="/from/zsh-rc:$PATH"; export PATH\nexec /bin/sh -c "$2"\n')
    const got = runWithShell(zsh)
    expect(got.split(':').slice(0, 2)).toEqual(['/from/preamble', '/from/zsh-rc'])
  })

  it('a csh or fish login shell falls back to running the preamble in sh', () => {
    const fish = write('fish', '#!/bin/sh\necho "fish cannot run POSIX" >&2\nexit 127\n')
    expect(runWithShell(fish).split(':')[0]).toBe('/from/preamble')
  })
})
