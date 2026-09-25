/**
 * Runtime checks for the remote daemon (remote-runtime.ts): bun must RUN
 * before it is used, the installer's own output is kept, and a runtime-shaped
 * start failure moves once along bun → binary → node.
 *
 * The probe and install scripts are EXECUTED under /bin/sh with a fake HOME and
 * fake `bun` / `curl` / `bash` on a pinned PATH, so no real bun is found, no
 * network is touched, and nothing is installed anywhere but the temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildBunInstallScript, buildBunProbeScript, installTailForError, isRuntimeStartFailure,
  nextRuntimeAfterStartFailure, parseBunInstall, parseBunProbe, type RemoteRuntime,
} from '../../src/providers/remote-runtime.js'

let root = ''
let home = ''
let bin = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-runtime-'))
  home = path.join(root, 'home')
  bin = path.join(root, 'bin')
  fs.mkdirSync(path.join(home, '.bun', 'bin'), { recursive: true })
  fs.mkdirSync(bin)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function fakeBun(body: string): void {
  fs.writeFileSync(path.join(home, '.bun', 'bin', 'bun'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

function sh(script: string): string {
  return execFileSync('/bin/sh', ['-s'], { input: script, encoding: 'utf-8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home } })
}

describe('bun probe, executed', () => {
  it('a bun that answers its version is used', () => {
    fakeBun('echo 1.1.30')
    expect(parseBunProbe(sh(buildBunProbeScript()))).toEqual({ path: path.join(home, '.bun/bin/bun'), ok: true, version: '1.1.30' })
  })

  it('a bun killed by SIGILL (a CPU the build does not support) is "no bun", with why', () => {
    fakeBun('kill -ILL $$')
    const p = parseBunProbe(sh(buildBunProbeScript()))
    expect(p.ok).toBe(false)
    expect(p.path).toBe(path.join(home, '.bun/bin/bun'))
    expect(p.error).toMatch(/illegal instruction/)
  })

  it('a bun that fails with a loader error keeps the stderr tail', () => {
    fakeBun("echo \"bun: /lib64/libc.so.6: version \\`GLIBC_2.27' not found (required by bun)\" >&2; exit 1")
    const p = parseBunProbe(sh(buildBunProbeScript()))
    expect(p.ok).toBe(false)
    expect(p.error).toContain('GLIBC_2.27')
  })

  it('an empty answer with exit 0 is not a version', () => {
    fakeBun('exit 0')
    expect(parseBunProbe(sh(buildBunProbeScript())).ok).toBe(false)
  })

  it('no bun anywhere reads as missing', () => {
    expect(parseBunProbe(sh(buildBunProbeScript()))).toEqual({ path: null, ok: false })
  })
})

describe('bun install, executed with a fake curl', () => {
  const logPath = () => path.join(root, 'daemon', 'bun-install.log')

  it('a failed download is a failure (the old `curl | bash` reported success here), and its words are kept', () => {
    fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\necho "curl: (6) Could not resolve host: bun.sh" >&2\nexit 6\n', { mode: 0o755 })
    const r = parseBunInstall(sh(buildBunInstallScript(logPath())))
    expect(r.rc).toBe(6)
    expect(r.logPath).toBe(logPath())
    expect(r.tail).toContain('Could not resolve host: bun.sh')
    expect(fs.readFileSync(logPath(), 'utf-8')).toContain('Could not resolve host')
    expect(installTailForError(r)).toContain('Could not resolve host')
  })

  it('the installer script runs and its own failure is reported with its output', () => {
    fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\necho \'echo "error: unzip is required to install bun" >&2; exit 1\'\n', { mode: 0o755 })
    const r = parseBunInstall(sh(buildBunInstallScript(logPath())))
    expect(r.rc).toBe(1)
    expect(r.tail).toContain('unzip is required')
  })

  it('a working installer reports 0', () => {
    fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\necho 'mkdir -p "$HOME/.bun/bin"; printf "#!/bin/sh\\necho 1.2.0\\n" > "$HOME/.bun/bin/bun"; chmod +x "$HOME/.bun/bin/bun"; echo installed'\n`, { mode: 0o755 })
    const r = parseBunInstall(sh(buildBunInstallScript(logPath())))
    expect(r.rc).toBe(0)
    expect(parseBunProbe(sh(buildBunProbeScript()))).toMatchObject({ ok: true, version: '1.2.0' })
  })

  it('no curl on the host says so', () => {
    // A PATH with the few tools the script needs and no curl.
    const noCurl = path.join(root, 'no-curl')
    fs.mkdirSync(noCurl)
    for (const tool of ['mkdir', 'dirname', 'tail']) {
      fs.symlinkSync(execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).trim(), path.join(noCurl, tool))
    }
    const r = parseBunInstall(execFileSync('/bin/sh', ['-s'], {
      input: buildBunInstallScript(logPath()), encoding: 'utf-8', env: { PATH: noCurl, HOME: home },
    }))
    expect(r.rc).toBe(127)
    expect(r.tail).toContain('curl is not installed')
  })
})

describe('runtime-shaped start failures and the fallback chain (pure)', () => {
  it.each([
    'nohup: failed to run command \'/home/me/.bun/bin/bun\': Exec format error',
    'bun: /lib64/libc.so.6: version `GLIBC_2.27\' not found (required by bun)',
    'sh: line 1: 70592 Illegal instruction: 4  nohup /x/bun daemon.cjs --start',
    'Startup log: walnut-daemon-exit=132',
    'Startup log: walnut-daemon-exit=126',
    '/tmp/open-walnut/daemon-linux-x64: cannot execute binary file',
  ])('runtime-shaped: %s', (text) => {
    expect(isRuntimeStartFailure(text)).toBe(true)
  })

  it.each([
    "daemon failed to start (port='', status='') Startup log: Error: listen EADDRINUSE",
    'Startup log: walnut-daemon-exit=1',
    'Permission denied (publickey).',
  ])('not runtime-shaped: %s', (text) => {
    expect(isRuntimeStartFailure(text)).toBe(false)
  })

  const next = (failed: RemoteRuntime, tried: RemoteRuntime[], haveBinary = true) =>
    nextRuntimeAfterStartFailure(failed, 'walnut-daemon-exit=132', { haveBinary, tried: new Set(tried) })

  it('bun → binary → node, once each, and then nothing (never a loop)', () => {
    expect(next('bun', ['bun'])).toBe('binary')
    expect(next('binary', ['bun', 'binary'])).toBe('node')
    expect(next('node', ['bun', 'binary', 'node'])).toBeNull()
  })

  it('no prebuilt binary for the host: bun goes straight to node', () => {
    expect(next('bun', ['bun'], false)).toBe('node')
  })

  it('a failure that is not about the runtime does not fall back', () => {
    expect(nextRuntimeAfterStartFailure('bun', 'EADDRINUSE', { haveBinary: true, tried: new Set(['bun']) })).toBeNull()
  })
})
