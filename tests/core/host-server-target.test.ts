/**
 * Which walnut file a host gets (src/core/host-server/host-target.ts): the probe
 * runs for real with `sh`, here and against stand-in `uname`, `ldd`, `getconf`
 * and `sysctl` that answer as the systems the file is built for (and some it is not).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { HOST_FILE_TARGETS, isHostFileTarget, parseHostTarget, targetProbeScript } from '../../src/core/host-server/host-target.js'

let bin = ''

beforeEach(() => { bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hst-bin-')) })
afterEach(() => { fs.rmSync(bin, { recursive: true, force: true }) })

function tool(name: string, body: string): void {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

/** A system: uname -s / -m, what ldd --version prints (and its exit code), getconf's glibc. */
function system(o: { s: string; m: string; ldd?: { out: string; code: number }; glibc?: string; translated?: string }): void {
  tool('uname', `case "$1" in -s) echo ${JSON.stringify(o.s)} ;; -m) echo ${JSON.stringify(o.m)} ;; esac`)
  if (o.ldd) tool('ldd', `printf '%s\\n' ${JSON.stringify(o.ldd.out)} >&2; exit ${o.ldd.code}`)
  else tool('ldd', 'echo "sh: ldd: not found" >&2; exit 127')
  tool('getconf', o.glibc ? `[ "$1" = GNU_LIBC_VERSION ] && echo "glibc ${o.glibc}"` : 'exit 1')
  tool('sysctl', `echo ${o.translated ?? 0}`)
}

function probe(): string {
  const r = spawnSync('sh', ['-s'], { input: targetProbeScript(), env: { PATH: guardedPath([bin], '/usr/bin:/bin') }, encoding: 'utf8', timeout: 10_000 })
  expect(r.status).toBe(0)
  return r.stdout
}

describe('the target probe, run with sh', () => {
  it('reads this machine as one of the targets', () => {
    const r = spawnSync('sh', ['-s'], { input: targetProbeScript(), encoding: 'utf8', timeout: 10_000 })
    const t = parseHostTarget(r.stdout)
    expect(HOST_FILE_TARGETS).toContain(t.target)
    if (process.platform === 'darwin') expect(t.target).toBe(`darwin-${process.arch}`)
  })

  it('an old glibc Linux on x86_64 gets linux-x64 (the baseline build) and says which glibc', () => {
    system({ s: 'Linux', m: 'x86_64', ldd: { out: 'ldd (GNU libc) 2.26', code: 0 }, glibc: '2.26' })
    expect(parseHostTarget(probe())).toEqual({ target: 'linux-x64', describe: 'Linux x86_64, glibc 2.26' })
  })

  it('glibc 2.17 on aarch64 gets linux-arm64', () => {
    system({ s: 'Linux', m: 'aarch64', ldd: { out: 'ldd (GNU libc) 2.17', code: 0 }, glibc: '2.17' })
    expect(parseHostTarget(probe())).toEqual({ target: 'linux-arm64', describe: 'Linux aarch64, glibc 2.17' })
  })

  it('musl (Alpine) gets the musl builds; ldd exits 1 there and says so on stderr', () => {
    system({ s: 'Linux', m: 'x86_64', ldd: { out: 'musl libc (x86_64)\nVersion 1.2.4', code: 1 } })
    expect(parseHostTarget(probe()).target).toBe('linux-x64-musl')
    system({ s: 'Linux', m: 'aarch64', ldd: { out: 'musl libc (aarch64)', code: 1 } })
    expect(parseHostTarget(probe())).toEqual({ target: 'linux-arm64-musl', describe: 'Linux aarch64, musl' })
  })

  it('no ldd at all reads as glibc (musl\'s loader decides only when it is there)', () => {
    system({ s: 'Linux', m: 'x86_64' })
    const out = probe()
    // /lib/ld-musl-* is the real machine's; on a Mac or a glibc runner there is none.
    const muslLoader = fs.existsSync('/lib') && fs.readdirSync('/lib').some((n) => n.startsWith('ld-musl-'))
    expect(parseHostTarget(out).target).toBe(muslLoader ? 'linux-x64-musl' : 'linux-x64')
  })

  it('macOS, also an x86_64 shell under Rosetta on Apple silicon', () => {
    system({ s: 'Darwin', m: 'arm64' })
    expect(parseHostTarget(probe())).toEqual({ target: 'darwin-arm64', describe: 'macOS arm64' })
    system({ s: 'Darwin', m: 'x86_64', translated: '1' })
    expect(parseHostTarget(probe()).target).toBe('darwin-arm64')
    system({ s: 'Darwin', m: 'x86_64', translated: '0' })
    expect(parseHostTarget(probe()).target).toBe('darwin-x64')
  })

  it('a system or CPU there is no file for says so', () => {
    system({ s: 'FreeBSD', m: 'amd64' })
    expect(() => parseHostTarget(probe())).toThrow(/the host runs FreeBSD on amd64; the walnut file is built for Linux and macOS on x64 and arm64/)
    system({ s: 'Linux', m: 'armv7l', ldd: { out: 'ldd (GNU libc) 2.31', code: 0 } })
    expect(() => parseHostTarget(probe())).toThrow(/Linux on armv7l/)
  })
})

describe('parseHostTarget', () => {
  it('an answer that is not the probe\'s is an error, not a guess', () => {
    expect(() => parseHostTarget('Permission denied (publickey).')).toThrow(/could not tell which system the host runs/)
    expect(() => parseHostTarget('')).toThrow(/could not tell/)
  })

  it('a glibc version it cannot read is left out of the words', () => {
    expect(parseHostTarget('os=Linux\narch=amd64\nlibc=glibc\ntranslated=0\nglibc=\n')).toEqual({ target: 'linux-x64', describe: 'Linux amd64, glibc' })
  })

  it('knows its targets', () => {
    expect(isHostFileTarget('linux-x64-musl')).toBe(true)
    expect(isHostFileTarget('linux-x64-baseline')).toBe(false)
    expect(isHostFileTarget(undefined)).toBe(false)
  })
})
