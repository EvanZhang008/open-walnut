/**
 * The doctor's local probes that touch the machine: the login-shell PATH
 * capture (a real child process, bounded), the read-only dtach answer, and the
 * PATH helpers. The shells here are tiny scripts in a temp dir, so nothing
 * reads the developer's own rc files.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-doctor-local'))

import {
  captureLoginShellPath, killLeftoverProbes, liveProbeChildren, localCompiler, readConfigReadOnly, readOnlyLocalDtach,
  sessionPath, summarizePath, PATH_ENTRIES_SHOWN,
} from '../../../src/core/diagnostics/local-probes.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-doctor-local-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

/** A fake login shell: must be named like a real one for the capture script to apply. */
function fakeShell(name: string, body: string): string {
  const sub = fs.mkdtempSync(path.join(dir, 'sh-'))
  const file = path.join(sub, name)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

describe('captureLoginShellPath', () => {
  it('reads the marked PATH line the login shell prints', async () => {
    const shell = fakeShell('bash', 'echo "rc noise"; printf "\\n__WALNUT_LOGIN_PATH__=/opt/tools/bin:/usr/bin\\n"')
    expect(await captureLoginShellPath({ SHELL: shell, HOME: dir }, 2_000)).toBe('/opt/tools/bin:/usr/bin')
  })

  it('gives up on a shell that hangs, within the deadline', async () => {
    const shell = fakeShell('zsh', 'sleep 5')
    const started = Date.now()
    expect(await captureLoginShellPath({ SHELL: shell, HOME: dir }, 200)).toBeNull()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('answers null for no shell, an unknown shell, or a missing one', async () => {
    expect(await captureLoginShellPath({}, 200)).toBeNull()
    expect(await captureLoginShellPath({ SHELL: fakeShell('fish', 'exit 0') }, 200)).toBeNull()
    expect(await captureLoginShellPath({ SHELL: path.join(dir, 'nope', 'bash') }, 200)).toBeNull()
  })
})

describe('readOnlyLocalDtach', () => {
  it('prefers Walnut\'s own copy, then ~/.local/bin, then the PATH one, and never builds', async () => {
    const tmp = fs.mkdtempSync(path.join(dir, 'tmp-'))
    const home = fs.mkdtempSync(path.join(dir, 'home-'))
    const pathDir = fs.mkdtempSync(path.join(dir, 'path-'))
    const exe = (file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 }) }
    expect(await readOnlyLocalDtach(tmp, pathDir, home)).toEqual({ found: false, path: null, source: null })
    exe(path.join(pathDir, 'dtach'))
    expect(await readOnlyLocalDtach(tmp, pathDir, home)).toEqual({ found: true, path: path.join(pathDir, 'dtach'), source: 'system' })
    exe(path.join(home, '.local', 'bin', 'walnut-dtach'))
    expect(await readOnlyLocalDtach(tmp, pathDir, home)).toEqual({ found: true, path: path.join(home, '.local', 'bin', 'walnut-dtach'), source: 'walnut' })
    exe(path.join(tmp, 'bin', 'walnut-dtach'))
    expect(await readOnlyLocalDtach(tmp, pathDir, home)).toEqual({ found: true, path: path.join(tmp, 'bin', 'walnut-dtach'), source: 'walnut' })
    // Read-only: nothing new appeared anywhere.
    expect(fs.readdirSync(tmp)).toEqual(['bin'])
  })
})

describe('localCompiler', () => {
  // Review round 1, item 6: the compiler is its own probe, answered even when the claude preflight is not.
  it('finds cc, gcc or clang on the given PATH only', () => {
    const pathDir = fs.mkdtempSync(path.join(dir, 'cc-'))
    expect(localCompiler(pathDir)).toEqual({ found: false, name: null })
    fs.writeFileSync(path.join(pathDir, 'clang'), '#!/bin/sh\n', { mode: 0o755 })
    expect(localCompiler(pathDir)).toEqual({ found: true, name: 'clang' })
  })
})

describe('readConfigReadOnly', () => {
  // Review round 1, item 14: the CLI reads config.yaml as it is and never restores it from .bak.
  it('answers null for a missing or empty file and never creates one', async () => {
    const home = fs.mkdtempSync(path.join(dir, 'cfg-'))
    const file = path.join(home, 'config.yaml')
    fs.writeFileSync(`${file}.bak`, 'version: 1\nagent:\n  main_model: claude-opus-5-5\n')
    expect(await readConfigReadOnly(file)).toBeNull()
    expect(fs.existsSync(file)).toBe(false)
    fs.writeFileSync(file, '   \n')
    expect(await readConfigReadOnly(file)).toBeNull()
    fs.writeFileSync(file, 'version: 1\nagent:\n  main_model: claude-opus-5-5\n')
    expect((await readConfigReadOnly(file))?.agent?.main_model).toBe('claude-opus-5-5')
  })
})

describe('killLeftoverProbes', () => {
  // Review round 1, item 14: a probe child a deadline gave up on must not keep the CLI alive.
  it('ends a probe child that is still running', async () => {
    const shell = fakeShell('bash', 'sleep 30')
    const answer = captureLoginShellPath({ SHELL: shell, HOME: dir }, 20_000)
    await new Promise((r) => setTimeout(r, 50))
    expect(liveProbeChildren()).toBe(1)
    const started = Date.now()
    expect(killLeftoverProbes()).toBe(1)
    expect(liveProbeChildren()).toBe(0)
    expect(await answer).toBeNull()
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe('PATH helpers', () => {
  it('summarizes a PATH as its first entries plus the count', () => {
    const many = Array.from({ length: 20 }, (_, i) => `/p${i}`).join(':')
    expect(summarizePath(many)).toEqual({ entries: Array.from({ length: PATH_ENTRIES_SHOWN }, (_, i) => `/p${i}`), count: 20 })
    expect(summarizePath(undefined)).toEqual({ entries: [], count: 0 })
  })

  it('builds the session PATH: login shell first, then the daemon fallbacks, then inherited', () => {
    const p = sessionPath('/login/bin', { HOME: '/home/alice', PATH: '/inherited/bin:/login/bin' }).split(':')
    expect(p[0]).toBe('/login/bin')
    expect(p[1]).toBe('/home/alice/.toolbox/bin')
    expect(p[p.length - 1]).toBe('/inherited/bin')
    expect(p.filter((x) => x === '/login/bin')).toHaveLength(1)
  })
})
