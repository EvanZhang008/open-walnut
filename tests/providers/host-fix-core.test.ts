/**
 * Host fixes (src/providers/host-fix-core.ts): the daemon half of `host.fix`.
 *
 * Only the host is faked: execFile answers from a script (nothing is installed,
 * no network), the fs records writes, and the runtime resolves commands from a
 * map. The real argv construction, sudo classification, idempotency and the
 * one-fix-at-a-time guard all run. The factory is also re-materialized from its
 * toString(), because that text is what the source-deployed daemon twin runs.
 *
 * The resumable Claude Code download runs against a fake downloads.claude.ai
 * (an in-memory fs, a clock, a line that cuts off or ignores Range), and once
 * more with the real curl, sha256 tool and fs over file://.
 */
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHostFix, type HostFixDeps } from '../../src/providers/host-fix-core.js'
import { createClaudeInstall } from '../../src/providers/claude-install-core.js'
import { createClaudeDownload } from '../../src/providers/claude-download-core.js'
import { createDtachBuild } from '../../src/providers/dtach-build-core.js'
import { getDaemonSource, validateFoldInjection } from '../../src/providers/daemon-source.js'
import { createHostRuntime } from '../../src/providers/host-runtime-core.js'
import { ADVERTISED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { foldLine, initialFoldState, assembleSnapshot } from '../../src/providers/daemon-fold.js'
import { createDaemonCommandDrain } from '../../src/providers/daemon-command-drain.js'
import type { ClaudeProbe } from '../../src/providers/host-runtime-core.js'

const HOME = '/home/dev'
const TMP = '/tmp'
const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'
const DTACH_HELP = 'dtach - version 0.9, compiled on Sep 24 2026\nUsage: dtach -a <socket> <options>\n'

type Reply = { code: number; stdout?: string; stderr?: string; errCode?: string }
type Script = (file: string, args: string[], opts: Record<string, unknown>) => Reply | Promise<Reply>

interface Call { file: string; args: string[]; env: Record<string, unknown>; cwd?: unknown; detached?: unknown }

/** A fake host: `bins` is what `command -v` / resolveOnPath find; `claude` answers probeClaude per path. */
function fakeHost(opts: {
  bins?: Record<string, string>
  script?: Script
  platform?: string
  uid?: number
  claude?: Record<string, ClaudeProbe>
}) {
  const bins: Record<string, string> = { ...(opts.bins ?? {}) }
  const claude: Record<string, ClaudeProbe> = { ...(opts.claude ?? {}) }
  const calls: Call[] = []
  const written: Record<string, Buffer> = {}
  const renamed: Array<[string, string]> = []
  const script: Script = opts.script ?? (() => ({ code: 0 }))
  const execFile: HostFixDeps['execFile'] = (file, args, o, cb) => {
    calls.push({ file, args, env: o.env as Record<string, unknown>, cwd: o.cwd, detached: o.detached })
    // `command -v "$1"`: answered from the bins map, like the shell would.
    if (file === '/bin/sh' && args[1] === 'command -v "$1"') {
      const hit = bins[args[3]!]
      queueMicrotask(() => cb(hit ? null : Object.assign(new Error('exit 1'), { code: 1 }), hit ? hit + '\n' : '', ''))
      return { stdin: { end: () => {} } }
    }
    void Promise.resolve(script(file, args, o)).then((r) => {
      const err = r.code === 0 && !r.errCode ? null
        : r.errCode ? Object.assign(new Error(`spawn ${file} ${r.errCode}`), { code: r.errCode })
          : Object.assign(new Error(`exit ${r.code}`), { code: r.code })
      cb(err, r.stdout ?? '', r.stderr ?? '')
    })
    return { stdin: { end: () => {} } }
  }
  let tmpN = 0
  const fakeFs = {
    mkdtempSync: (prefix: string) => `${prefix}${++tmpN}`,
    writeFileSync: (p: string, data: Buffer) => { written[String(p)] = Buffer.from(data) },
    mkdirSync: () => undefined,
    renameSync: (a: string, b: string) => { renamed.push([String(a), String(b)]) },
    unlinkSync: () => undefined,
    rmdirSync: () => undefined,
    realpathSync: (p: string) => String(p),
  }
  const deps: HostFixDeps = {
    execFile,
    fs: fakeFs as unknown as HostFixDeps['fs'],
    env: { HOME, PATH: `${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin` },
    os: { platform: () => opts.platform ?? 'linux', tmpdir: () => TMP, uid: () => opts.uid ?? 1000 },
    runtime: {
      resolveOnPath: (cmd) => (cmd.includes('/') ? (claude[cmd]?.found ? cmd : null) : bins[cmd] ?? null),
      probeClaude: async (command) => {
        const p = command.includes('/') ? command : bins[command]
        return (p && claude[p]) || { found: false }
      },
    },
    claudeInstall: createClaudeInstall, claudeDownload: createClaudeDownload, dtachBuild: createDtachBuild,
  }
  return { deps, calls, bins, claude, written, renamed, fix: createHostFix(deps) }
}

const cmdLine = (c: Call) => [c.file, ...c.args].join(' ')
const APT_OPTS = '-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold'
const nonProbe = (calls: Call[]) => calls.filter((c) => !(c.file === '/bin/sh' && c.args[1] === 'command -v "$1"'))

// ── install-compiler ─────────────────────────────────────────────────────────

describe('install-compiler', () => {
  it('detects the package manager in the order dnf, yum, apt-get, apk, zypper, and uses the first found', async () => {
    const h = fakeHost({
      bins: { sudo: '/usr/bin/sudo', yum: '/usr/bin/yum', 'apt-get': '/usr/bin/apt-get' },
      script: (file) => {
        if (file === '/usr/bin/sudo') h.bins.gcc = '/usr/bin/gcc'
        return { code: 0, stdout: 'Complete!' }
      },
    })
    const r = await h.fix.run('install-compiler')
    const probed = h.calls.filter((c) => c.args[1] === 'command -v "$1"').map((c) => c.args[3])
    expect(probed).toEqual(['dnf', 'yum'])
    expect(nonProbe(h.calls).map(cmdLine)).toEqual(['/usr/bin/sudo -n /usr/bin/yum install -y gcc glibc-devel'])
    // sudo's own messages are read in the C locale.
    expect(nonProbe(h.calls)[0]!.env.LC_ALL).toBe('C')
    expect(r).toMatchObject({ action: 'install-compiler', ok: true, packageManager: 'yum' })
    expect(r.needsPassword).toBeUndefined()
  })

  it('names gcc plus the C headers for each package manager', () => {
    const { fix } = fakeHost({})
    expect(fix.packageArgs('dnf')).toEqual(['install', '-y', 'gcc', 'glibc-devel'])
    expect(fix.packageArgs('yum')).toEqual(['install', '-y', 'gcc', 'glibc-devel'])
    expect(fix.packageArgs('zypper')).toEqual(['install', '-y', 'gcc', 'glibc-devel'])
    expect(fix.packageArgs('apt-get')).toEqual(['install', '-y', 'gcc', 'libc6-dev'])
    expect(fix.packageArgs('apk')).toEqual(['add', 'gcc', 'musl-dev'])
  })

  it('a sudo that wants a password is needsPassword, with the exact command to run by hand, and nothing is retried', async () => {
    const h = fakeHost({
      bins: { sudo: '/usr/bin/sudo', 'apt-get': '/usr/bin/apt-get' },
      script: () => ({ code: 1, stderr: 'sudo: a password is required\n' }),
    })
    const r = await h.fix.run('install-compiler')
    expect(r).toMatchObject({
      ok: false, error: 'needs-password', needsPassword: true, packageManager: 'apt-get',
      manualCommand: 'sudo apt-get install -y gcc libc6-dev',
    })
    // A password refusal is not the environment-variable refusal: one call, no retry.
    expect(nonProbe(h.calls)).toHaveLength(1)
  })

  it('a package manager failure is not a password refusal', async () => {
    const h = fakeHost({
      bins: { sudo: '/usr/bin/sudo', dnf: '/usr/bin/dnf' },
      script: () => ({ code: 1, stdout: 'Last metadata expiration check', stderr: 'Error: Failed to download metadata for repo' }),
    })
    const r = await h.fix.run('install-compiler')
    expect(r).toMatchObject({ ok: false, error: 'package-manager-failed', manualCommand: 'sudo dnf install -y gcc glibc-devel' })
    expect(r.needsPassword).toBeUndefined()
    expect(h.fix.classifySudo({ code: 1, stdout: '', stderr: 'alice is not in the sudoers file.  This incident will be reported.\n' })).toBe('not-allowed')
    expect(h.fix.classifySudo({ code: 1, stdout: '', stderr: 'sudo: a terminal is required to read the password\n' })).toBe('password')
    expect(h.fix.classifySudo({ code: 100, stdout: '', stderr: 'E: Could not get lock /var/lib/dpkg/lock\n' })).toBeNull()
  })

  it('a fresh apt host refreshes its package lists once, then installs', async () => {
    let installs = 0
    const h = fakeHost({
      bins: { sudo: '/usr/bin/sudo', 'apt-get': '/usr/bin/apt-get' },
      script: (_file, args) => {
        if (args.includes('update')) return { code: 0 }
        installs++
        if (installs === 1) return { code: 100, stderr: 'E: Unable to locate package gcc' }
        h.bins.gcc = '/usr/bin/gcc'
        return { code: 0 }
      },
    })
    const r = await h.fix.run('install-compiler')
    expect(nonProbe(h.calls).map(cmdLine)).toEqual([
      `/usr/bin/sudo -n DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get ${APT_OPTS} install -y gcc libc6-dev`,
      `/usr/bin/sudo -n DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get ${APT_OPTS} update`,
      `/usr/bin/sudo -n DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get ${APT_OPTS} install -y gcc libc6-dev`,
    ])
    for (const c of nonProbe(h.calls)) expect(c.env).toMatchObject({ LC_ALL: 'C', DEBIAN_FRONTEND: 'noninteractive' })
    expect(r.ok).toBe(true)
  })

  it('a sudoers rule that only names apt-get refuses the frontend variable: the next call goes without it', async () => {
    const h = fakeHost({
      bins: { sudo: '/usr/bin/sudo', 'apt-get': '/usr/bin/apt-get' },
      script: (_file, args) => {
        if (args.includes('DEBIAN_FRONTEND=noninteractive')) return { code: 1, stderr: 'sudo: sorry, you are not allowed to set the following environment variables: DEBIAN_FRONTEND\n' }
        h.bins.gcc = '/usr/bin/gcc'
        return { code: 0 }
      },
    })
    const r = await h.fix.run('install-compiler')
    expect(nonProbe(h.calls).map(cmdLine)).toEqual([
      `/usr/bin/sudo -n DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get ${APT_OPTS} install -y gcc libc6-dev`,
      `/usr/bin/sudo -n /usr/bin/apt-get ${APT_OPTS} install -y gcc libc6-dev`,
    ])
    expect(r).toMatchObject({ ok: true, packageManager: 'apt-get' })
  })

  it('on the deadline the whole process group gets SIGTERM, then SIGKILL, and the fix answers timeout', async () => {
    vi.useFakeTimers()
    try {
      const kills: Array<[number, string]> = []
      const h = fakeHost({ bins: { sudo: '/usr/bin/sudo', yum: '/usr/bin/yum' } })
      // A package manager that never exits: its child object has a pid and no callback ever comes.
      const hung: HostFixDeps['execFile'] = (file, args, o, cb) => {
        h.calls.push({ file, args, env: o.env as Record<string, unknown>, detached: o.detached })
        if (file === '/bin/sh') {
          const hit = h.bins[args[3]!]
          queueMicrotask(() => cb(hit ? null : Object.assign(new Error('exit 1'), { code: 1 }), hit ? hit + '\n' : '', ''))
          return { stdin: { end: () => {} } }
        }
        return { pid: 4242, stdin: { end: () => {} } }
      }
      const fix = createHostFix({ ...h.deps, execFile: hung, kill: (pid, sig) => { kills.push([pid, sig]) } })
      const done = fix.run('install-compiler')
      await vi.advanceTimersByTimeAsync(300_000)
      expect(kills).toEqual([[-4242, 'SIGTERM']])
      await vi.advanceTimersByTimeAsync(5_000)
      expect(kills).toEqual([[-4242, 'SIGTERM'], [-4242, 'SIGKILL']])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await done).toMatchObject({ ok: false, error: 'timeout' })
      // Every child runs in its own process group, which is what makes -pid reach apt/dpkg too.
      expect(h.calls.every((c) => c.detached === true)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('as root it runs the package manager without sudo (apk shown)', async () => {
    const h = fakeHost({
      uid: 0, bins: { apk: '/sbin/apk' },
      script: () => { h.bins.cc = '/usr/bin/cc'; return { code: 0 } },
    })
    const r = await h.fix.run('install-compiler')
    expect(nonProbe(h.calls).map(cmdLine)).toEqual(['/sbin/apk add gcc musl-dev'])
    expect(r).toMatchObject({ ok: true, packageManager: 'apk' })
  })

  it('refuses on macOS without running anything', async () => {
    const h = fakeHost({ platform: 'darwin', bins: { sudo: '/usr/bin/sudo' } })
    const r = await h.fix.run('install-compiler')
    expect(r).toMatchObject({ ok: false, error: 'darwin-needs-command-line-tools', manualCommand: 'xcode-select --install' })
    expect(h.calls).toEqual([])
  })

  it('is idempotent: a compiler already there is skipped, no sudo', async () => {
    const h = fakeHost({ bins: { gcc: '/usr/bin/gcc', sudo: '/usr/bin/sudo', yum: '/usr/bin/yum' } })
    const r = await h.fix.run('install-compiler')
    expect(r).toMatchObject({ ok: true, skipped: true })
    expect(h.calls).toEqual([])
  })

  it('no known package manager, and no sudo, each say so', async () => {
    expect(await fakeHost({ bins: { sudo: '/usr/bin/sudo' } }).fix.run('install-compiler')).toMatchObject({ ok: false, error: 'no-package-manager' })
    expect(await fakeHost({ bins: { yum: '/usr/bin/yum' } }).fix.run('install-compiler'))
      .toMatchObject({ ok: false, error: 'no-sudo', manualCommand: 'sudo yum install -y gcc glibc-devel' })
  })
})

// ── install-claude-native ────────────────────────────────────────────────────

const NATIVE: ClaudeProbe = { found: true, kind: 'native', needsNode: false }
const NPM: ClaudeProbe = { found: true, kind: 'npm', needsNode: true, nodeFound: false }
const BIN = `${HOME}/.local/bin/claude`

describe('install-claude-native', () => {
  it('downloads the official installer with curl, runs it with bash under HOME, then verifies ~/.local/bin/claude --version', async () => {
    const h = fakeHost({
      bins: { curl: '/usr/bin/curl', bash: '/bin/bash', claude: BIN },
      claude: { [BIN]: { ...NPM, path: BIN } },
      script: (file) => {
        if (file === '/bin/bash') h.claude[BIN] = { ...NATIVE, path: BIN }
        if (file === BIN) return { code: 0, stdout: '2.1.280 (Claude Code)\n' }
        return { code: 0 }
      },
    })
    const r = await h.fix.run('install-claude-native')
    const [dl, inst, ver] = nonProbe(h.calls)
    expect(dl!.file).toBe('/usr/bin/curl')
    expect(dl!.args).toEqual(['-fsSL', '-o', `${TMP}/walnut-claude-install-1/install.sh`, 'https://claude.ai/install.sh'])
    expect(inst!.file).toBe('/bin/bash')
    expect(inst!.args).toEqual([`${TMP}/walnut-claude-install-1/install.sh`])
    expect(inst!.env.HOME).toBe(HOME)
    expect(inst!.cwd).toBe(HOME)
    expect(cmdLine(ver!)).toBe(`${BIN} --version`)
    expect(r).toMatchObject({ ok: true, claude: { path: BIN, kind: 'native', version: '2.1.280' } })
    expect(r.skipped).toBeUndefined()
  })

  it('on a Mac whose login keychain is locked it never runs the installer (its `claude install` reads the keychain)', async () => {
    const h = fakeHost({
      platform: 'darwin',
      bins: { curl: '/usr/bin/curl', bash: '/bin/bash', claude: BIN },
      claude: { [BIN]: { ...NPM, path: BIN } },
      script: (file) => (file === '/usr/bin/osascript' ? { code: 0, stdout: 'status 2\n' } : { code: 0 }),
    })
    expect(await h.fix.run('install-claude-native')).toMatchObject({ ok: false, error: 'keychain-locked', manualCommand: 'curl -fsSL https://claude.ai/install.sh | bash' })
    expect(nonProbe(h.calls).map((c) => c.file)).toEqual(['/usr/bin/osascript'])
  })

  it('falls back to wget when curl is missing', async () => {
    const h = fakeHost({
      bins: { wget: '/usr/bin/wget', bash: '/bin/bash' },
      script: (file) => {
        if (file === '/bin/bash') { h.claude[BIN] = { ...NATIVE, path: BIN }; h.bins.claude = BIN }
        if (file === BIN) return { code: 0, stdout: '2.1.280\n' }
        return { code: 0 }
      },
    })
    const r = await h.fix.run('install-claude-native')
    expect(nonProbe(h.calls)[0]).toMatchObject({ file: '/usr/bin/wget', args: ['-q', '-O', `${TMP}/walnut-claude-install-1/install.sh`, 'https://claude.ai/install.sh'] })
    expect(r.ok).toBe(true)
  })

  it('never runs the installer when a native claude is already found', async () => {
    const h = fakeHost({
      bins: { curl: '/usr/bin/curl', bash: '/bin/bash', claude: BIN },
      claude: { [BIN]: { ...NATIVE, path: BIN } },
      script: () => ({ code: 0, stdout: '2.1.280\n' }),
    })
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: true, skipped: true, claude: { version: '2.1.280' } })
    expect(nonProbe(h.calls).map((c) => c.file)).toEqual([BIN])
  })

  it('no curl and no wget, or a failed download, stop before bash runs', async () => {
    const none = fakeHost({ bins: { bash: '/bin/bash' } })
    expect(await none.fix.run('install-claude-native')).toMatchObject({ ok: false, error: 'no-downloader', manualCommand: INSTALL })
    expect(none.calls).toEqual([])
    const offline = fakeHost({
      bins: { curl: '/usr/bin/curl', bash: '/bin/bash' },
      script: () => ({ code: 6, stderr: 'curl: (6) Could not resolve host: claude.ai' }),
    })
    const r = await offline.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: false, error: 'download-failed', manualCommand: INSTALL })
    expect(r.log).toContain('Could not resolve host')
    expect(nonProbe(offline.calls).map((c) => c.file)).toEqual(['/usr/bin/curl'])
  })

  it('an npm claude earlier on PATH still wins after the install: shadowed, not ok', async () => {
    const other = '/usr/local/bin/claude'
    const h = fakeHost({
      bins: { curl: '/usr/bin/curl', bash: '/bin/bash', claude: other },
      claude: { [other]: { ...NPM, path: other } },
      script: (file) => {
        if (file === '/bin/bash') h.claude[BIN] = { ...NATIVE, path: BIN }
        if (file === BIN) return { code: 0, stdout: '2.1.280\n' }
        return { code: 0 }
      },
    })
    expect(await h.fix.run('install-claude-native')).toMatchObject({ ok: false, error: 'shadowed', shadowedBy: other, claude: { kind: 'native' } })
  })
})

// ── install-claude-native: the native installer's steps, resumable ───────────

const RELEASES = 'https://downloads.claude.ai/claude-code-releases'
const DL = `${HOME}/.claude/downloads`
const VERSIONS_DIR = `${HOME}/.local/share/claude/versions`
const CURL = '/usr/bin/curl'
const SHA = '/usr/bin/sha256sum'
const ZSTD = '/usr/bin/zstd'
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'linux-x64-musl', 'linux-arm64-musl']
const SMALL = `${CURL} -fsSL --connect-timeout 30 --max-time 60`
/** The big download; --max-time is what is left before the 2 minutes kept for checking and installing. */
const resume = (part: string, url: string, secs = 43 * 60) => `${CURL} -fsSL -C - --connect-timeout 30 --speed-limit 1024 --speed-time 120 --max-time ${secs} -o ${part} ${url}`
const MIN = 60_000
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
/** A stand-in binary whose bytes name its release, so a mix-up shows. */
const binaryOf = (v: string, size = 3000) => Buffer.alloc(size, `claude ${v};`)

interface Served {
  binary: Buffer
  /** The compressed build: gzip here, which the fake zstd unpacks. */
  zst?: Buffer
  /** What manifest.json / manifest.zst.json name as the checksum (default: the real one). */
  checksum?: string
  zstChecksum?: string
  /** The server no longer has this release (404). */
  gone?: boolean
  /** manifest.json lists other platforms only. */
  noEntry?: boolean
}

/** How the line behaves for the big downloads (`curl -C -`); mutable mid-test. */
interface Line {
  /** Bytes one run brings before the line cuts it (curl 18). Default: all of it. */
  chunk?: number
  /** A server or proxy that answers a Range request with the whole file: curl 33. */
  ignoreRange?: boolean
  /** Every run fails at once with this curl exit code and brings nothing. */
  down?: number
  /** Clock time each run takes. */
  stepMs?: number
  /** A resumed request answered 416: curl fails on it ('error', exit 22) or forgives it and adds nothing ('forgive'). */
  range416?: 'error' | 'forgive'
}

/**
 * A host whose curl talks to a fake downloads.claude.ai: an in-memory fs (so
 * parts, renames and modes are real state), a clock that download runs move,
 * and a `claude install` that links ~/.local/bin/claude.
 */
function releaseHost(opts: {
  latest?: string | null
  releases?: Record<string, Served>
  files?: Record<string, Buffer>
  line?: Line
  zstd?: boolean
  installCode?: number
  platform?: string
  machine?: string
  musl?: 'loader' | 'ldd'
  rosetta?: boolean
  /** Commands on PATH besides the defaults; '' removes one. */
  bins?: Record<string, string>
  /** A native claude already there (update-claude), at this version. */
  installed?: string
  /** The big download never answers (its pid is `hangPid`, 4242 by default); `kill` sees the signals. */
  hang?: boolean
  hangPid?: number
  /** No sleep seam: pauses are real timers (and cancel() must end them). */
  realSleep?: boolean
  /** Any other command that never answers (pid `hangPid`). */
  hangWhen?: (file: string, args: string[]) => boolean
  /** Every claude probe never answers; `probes` counts them. */
  probeHang?: boolean
  /** An npm build's launcher script already at ~/.local/bin/claude, and no node to run it. */
  npmLauncher?: boolean
  kill?: (pid: number, signal: string) => void
  /** deps.now follows Date.now (for vi.useFakeTimers) instead of the fake clock. */
  realClock?: boolean
  /** The release server this fake answers for (default downloads.claude.ai). */
  base?: string
  env?: Record<string, string>
  /** First say on any command; undefined lets the fake host answer. */
  before?: (file: string, args: string[]) => { code: number; stdout?: string; stderr?: string; killed?: boolean } | undefined
}) {
  const releases = opts.releases ?? {}
  const line: Line = { ...(opts.line ?? {}) }
  const files = new Map<string, Buffer>(Object.entries(opts.files ?? {}))
  if (opts.musl === 'loader') files.set('/lib/libc.musl-x86_64.so.1', Buffer.from('elf'))
  const modes = new Map<string, number>()
  const calls: Call[] = []
  const downloads: Array<{ url: string; from: number; present: string[] }> = []
  const sleeps: number[] = []
  const logged: Array<{ msg: string; data?: Record<string, unknown> }> = []
  const probes: string[] = []
  const clock = { t: 1_800_000_000_000 }
  const state = { installed: opts.installed ?? '', installCode: opts.installCode ?? 0, cpFails: false, hang: !!opts.hang }
  const platform = opts.platform ?? 'linux'
  const bins: Record<string, string> = {
    curl: CURL, sha256sum: SHA, uname: '/usr/bin/uname', ldd: '/usr/bin/ldd', bash: '/bin/bash', cp: '/bin/cp',
    ...(platform === 'darwin' ? { sysctl: '/usr/sbin/sysctl' } : {}),
    ...(opts.zstd ? { zstd: ZSTD } : {}),
  }
  for (const [k, v] of Object.entries(opts.bins ?? {})) { if (v) bins[k] = v; else delete bins[k] }
  const claude: Record<string, ClaudeProbe> = {}
  if (state.installed) { bins.claude = BIN; claude[BIN] = { ...NATIVE, path: BIN } }
  if (opts.npmLauncher) {
    files.set(BIN, Buffer.from(NPM_LAUNCHER))
    claude[BIN] = { found: true, path: BIN, kind: 'npm', needsNode: true, nodeFound: false }
  }

  const enoent = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' })
  const dlFiles = () => [...files.keys()].filter((k) => k.startsWith(DL + '/')).sort()
  const fakeFs = {
    mkdtempSync: (prefix: string) => `${prefix}1`,
    writeFileSync: (p: string, d: Buffer | string) => { files.set(String(p), Buffer.from(d)) },
    mkdirSync: () => undefined,
    renameSync: (a: string, b: string) => {
      const d = files.get(a)
      if (!d) throw enoent(a)
      files.delete(a); files.set(b, d)
      if (modes.has(a)) { modes.set(b, modes.get(a)!); modes.delete(a) }
    },
    unlinkSync: (p: string) => { if (!files.delete(p)) throw enoent(p); modes.delete(p) },
    rmdirSync: () => undefined,
    realpathSync: (p: string) => (p === BIN && state.installed ? `${VERSIONS_DIR}/${state.installed}` : p),
    statSync: (p: string) => {
      const d = files.get(p)
      if (!d) throw enoent(p)
      return { isFile: () => true, size: d.length }
    },
    readdirSync: (dir: string) => [...files.keys()].filter((k) => path.posix.dirname(k) === dir).map((k) => path.posix.basename(k)),
    chmodSync: (p: string, m: number) => { if (!files.has(p)) throw enoent(p); modes.set(p, m) },
  }

  type Answer = { code: number; body?: Buffer }
  const serve = (url: string): Answer => {
    const base = opts.base ?? RELEASES
    if (!url.startsWith(base + '/')) return { code: 6 }
    const rest = url.slice(base.length + 1)
    if (rest === 'latest') return opts.latest === null ? { code: 404 } : { code: 0, body: Buffer.from((opts.latest ?? '2.1.317') + '\n') }
    const [v, ...tail] = rest.split('/')
    const r = releases[v!]
    if (!r || r.gone) return { code: 404 }
    const name = tail.join('/')
    const entry = (checksum: string, size: number) => ({ binary: 'claude', checksum, size })
    if (name === 'manifest.json' || name === 'manifest.zst.json') {
      if (name === 'manifest.zst.json' && !r.zst) return { code: 404 }
      const e = name === 'manifest.json' ? entry(r.checksum ?? sha(r.binary), r.binary.length) : entry(r.zstChecksum ?? sha(r.zst!), r.zst!.length)
      const listed = r.noEntry ? ['darwin-arm64'] : PLATFORMS
      // darwin entries carry a nested object after the checksum, as the real ones do.
      const platforms = Object.fromEntries(listed.map((p) => [p, p.startsWith('darwin') ? { ...e, app: { checksum: 'f'.repeat(64), size: 9 } } : e]))
      return { code: 0, body: Buffer.from(JSON.stringify({ version: v, platforms }, null, 2)) }
    }
    const [plat, file] = tail
    if (tail.length === 2 && PLATFORMS.includes(plat!) && file === 'claude') return { code: 0, body: r.binary }
    if (tail.length === 2 && PLATFORMS.includes(plat!) && file === 'claude.zst' && r.zst) return { code: 0, body: r.zst }
    return { code: 404 }
  }
  const httpError = (a: Answer) => (a.code === 404
    ? { code: 22, stderr: 'curl: (22) The requested URL returned error: 404\n' }
    : { code: a.code, stderr: `curl: (${a.code}) Could not resolve host\n` })

  const answerFor = (file: string, args: string[]): { code: number; stdout?: string; stderr?: string; killed?: boolean } => {
    const first = opts.before?.(file, args)
    if (first) return first
    if (file === '/usr/bin/uname') return { code: 0, stdout: (opts.machine ?? 'x86_64') + '\n' }
    if (file === '/usr/sbin/sysctl') return { code: 0, stdout: opts.rosetta ? '1\n' : '0\n' }
    if (file === '/usr/bin/ldd') {
      return { code: 0, stdout: opts.musl === 'ldd' ? '\t/lib/ld-musl-x86_64.so.1 (0x7f0)\n' : '\tlinux-vdso.so.1 (0x7ffd)\n\tlibc.so.6 => /lib64/libc.so.6 (0x7f0)\n' }
    }
    if (file === SHA || file === '/usr/bin/shasum') {
      const target = args[args.length - 1]!
      const d = files.get(target)
      return d ? { code: 0, stdout: `${sha(d)}  ${target}\n` } : { code: 1, stderr: `${file}: ${target}: No such file or directory\n` }
    }
    if (file === ZSTD) {
      const out = args[args.indexOf('-o') + 1]!
      try { files.set(out, zlib.gunzipSync(files.get(args[args.length - 1]!)!)) } catch { return { code: 1, stderr: 'zstd: not in zstd format\n' } }
      return { code: 0 }
    }
    if (file === CURL && args.includes('-C')) {
      const out = args[args.indexOf('-o') + 1]!
      const url = args[args.length - 1]!
      const have = files.get(out)
      downloads.push({ url, from: have ? have.length : -1, present: dlFiles() })
      clock.t += line.stepMs ?? 0
      if (line.down) return { code: line.down, stderr: `curl: (${line.down}) Failed to connect\n` }
      const a = serve(url)
      if (a.code !== 0) return httpError(a)
      const body = a.body!
      const from = have ? have.length : 0
      if (from > 0 && line.ignoreRange) return { code: 33, stderr: "curl: (33) HTTP server doesn't seem to support byte ranges. Cannot resume.\n" }
      if (from > 0 && line.range416 === 'error') return { code: 22, stderr: 'curl: (22) The requested URL returned error: 416\n' }
      if (from > 0 && line.range416 === 'forgive') return { code: 0 }
      const end = Math.min(body.length, from + (line.chunk ?? body.length))
      files.set(out, Buffer.concat([have ?? Buffer.alloc(0), body.subarray(from, end)]))
      return end < body.length ? { code: 18, stderr: 'curl: (18) transfer closed with outstanding read data remaining\n' } : { code: 0 }
    }
    if (file === '/bin/cp') {
      const d = files.get(args[0]!)
      if (state.cpFails || !d) return { code: 1, stderr: `cp: error writing '${args[1]}': No space left on device\n` }
      files.set(args[1]!, Buffer.from(d))
      return { code: 0 }
    }
    if (file === CURL && args.includes('https://claude.ai/install.sh')) {
      files.set(args[args.indexOf('-o') + 1]!, Buffer.from('#!/bin/bash\n'))
      return { code: 0 }
    }
    if (file === CURL) {
      const a = serve(args[args.length - 1]!)
      return a.code === 0 ? { code: 0, stdout: a.body!.toString() } : httpError(a)
    }
    // Like the real installer (2.1.312 and 2.1.317, --force too): a file already at
    // ~/.local/bin/claude is kept, and it still says installed.
    if ((file === '/bin/bash' || (file.startsWith(VERSIONS_DIR + '/') && args[0] === 'install' && !state.installCode)) && files.has(BIN)) {
      return { code: 0, stdout: 'Claude Code successfully installed!\n  Location: ~/.local/bin/claude\n' }
    }
    if (file === '/bin/bash') {
      state.installed = '2.1.317'
      bins.claude = BIN; claude[BIN] = { ...NATIVE, path: BIN }
      return { code: 0, stdout: 'Installation complete!\n' }
    }
    if (file.startsWith(VERSIONS_DIR + '/') && args[0] === 'install') {
      if (state.installCode) return { code: state.installCode, stdout: 'Checking installation status...\n', stderr: 'Installation failed\nEACCES: permission denied, symlink ~/.local/bin/claude\n' }
      state.installed = args[1]!
      bins.claude = BIN; claude[BIN] = { ...NATIVE, path: BIN }
      return { code: 0, stdout: `Claude Code successfully installed!\n  Version: ${args[1]}\n` }
    }
    if (file === BIN && args[0] === '--version' && files.has(BIN)) return { code: 127, stderr: "/usr/bin/env: 'node': No such file or directory\n" }
    if (file === BIN && args[0] === '--version' && state.installed) return { code: 0, stdout: `${state.installed} (Claude Code)\n` }
    return { code: 127, stderr: `${file}: not found\n` }
  }

  const execFile: HostFixDeps['execFile'] = (file, args, o, cb) => {
    calls.push({ file, args, env: o.env as Record<string, unknown>, cwd: o.cwd, detached: o.detached })
    if (opts.hangWhen?.(file, args)) return { pid: opts.hangPid ?? 4242, stdin: { end: () => {} } }
    if (state.hang && file === CURL && args.includes('-C')) {
      const have = files.get(args[args.indexOf('-o') + 1]!)
      downloads.push({ url: args[args.length - 1]!, from: have ? have.length : -1, present: dlFiles() })
      return { pid: opts.hangPid ?? 4242, stdin: { end: () => {} } }
    }
    const r = answerFor(file, args)
    queueMicrotask(() => {
      const err = r.killed ? Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' })
        : r.code === 0 ? null : Object.assign(new Error(`exit ${r.code}`), { code: r.code })
      cb(err, r.stdout ?? '', r.stderr ?? '')
    })
    return { stdin: { end: () => {} } }
  }
  const deps: HostFixDeps = {
    execFile,
    fs: fakeFs as unknown as HostFixDeps['fs'],
    env: { HOME, ...(opts.env ?? {}) },
    os: { platform: () => platform, tmpdir: () => TMP, uid: () => 1000 },
    runtime: {
      resolveOnPath: (cmd) => (cmd.includes('/') ? (claude[cmd]?.found ? cmd : null) : bins[cmd] ?? null),
      probeClaude: (command) => {
        probes.push(command)
        if (opts.probeHang) return new Promise<ClaudeProbe>(() => {})
        const p = command.includes('/') ? command : bins[command]
        return Promise.resolve((p && claude[p]) || { found: false })
      },
    },
    now: opts.realClock ? () => Date.now() : () => clock.t,
    ...(opts.realSleep ? {} : { sleep: async (ms: number) => { sleeps.push(ms) } }),
    ...(opts.kill ? { kill: opts.kill } : {}),
    log: (_level, msg, data) => { logged.push({ msg, data }) },
    claudeInstall: createClaudeInstall, claudeDownload: createClaudeDownload, dtachBuild: createDtachBuild,
  }
  return { deps, fix: createHostFix(deps), calls, files, modes, downloads, sleeps, logged, probes, clock, line, state, dlFiles }
}

/** The checked copy, named with the fake clock's start. */
const STAGED = `${VERSIONS_DIR}/2.1.317.walnut-1800000000000.tmp`
const partOf = (v: string, p = 'linux-x64') => `${DL}/claude-${v}-${p}.part`
const zstPartOf = (v: string, p = 'linux-x64') => `${DL}/claude-${v}-${p}.zst.part`
const binUrl = (v: string, p = 'linux-x64') => `${RELEASES}/${v}/${p}/claude`
const curlUrls = (calls: Call[]) => calls.filter((c) => c.file === CURL).map((c) => c.args[c.args.length - 1])

/** What a server that knows `waitMs` sends with a Claude Code fix: its whole 45 minutes. */
const ASKED = { waitMs: 45 * MIN }
const NPM_LAUNCHER = '#!/usr/bin/env node\nrequire("@anthropic-ai/claude-code/cli.js")\n'

describe('install-claude-native: the native installer\'s steps, resumable on a slow line', () => {
  const V = '2.1.317'

  it('an npm launcher already at ~/.local/bin/claude is moved aside, and the native one takes its place', async () => {
    // 2026-11-03, CI's fresh Linux dev box: the installer said installed and kept the npm
    // script, which then failed for want of node (verify-failed).
    const h = releaseHost({ releases: { [V]: { binary: binaryOf(V) } }, npmLauncher: true })
    const r = await h.fix.run('install-claude-native', ASKED)
    expect(r).toMatchObject({ ok: true, claude: { path: BIN, kind: 'native', version: V } })
    const aside = [...h.files.keys()].filter((k) => k.startsWith(`${BIN}.walnut-replaced-`))
    expect(aside).toHaveLength(1)
    expect(h.files.get(aside[0]!)!.toString()).toBe(NPM_LAUNCHER)
    expect(String(r.log)).toContain(`moved the launcher that was at ${BIN} (not the native one) to ${aside[0]}`)
  })

  it('an install that fails puts that launcher back', async () => {
    const h = releaseHost({ releases: { [V]: { binary: binaryOf(V) } }, npmLauncher: true, installCode: 1 })
    const r = await h.fix.run('install-claude-native', ASKED)
    expect(r).toMatchObject({ ok: false, error: 'installer-failed' })
    expect(h.files.get(BIN)!.toString()).toBe(NPM_LAUNCHER)
    expect([...h.files.keys()].filter((k) => k.includes('.walnut-replaced-'))).toEqual([])
  })

  it('a fresh install: latest, its manifest, the binary with curl -C -, its sha256, then `claude install <v>` from the versions directory', async () => {
    const binary = binaryOf(V)
    const h = releaseHost({ releases: { [V]: { binary } } })
    const r = await h.fix.run('install-claude-native', ASKED)
    expect(r).toMatchObject({ action: 'install-claude-native', ok: true, claude: { path: BIN, kind: 'native', version: V } })
    expect(h.calls.map(cmdLine)).toEqual([
      '/usr/bin/uname -m',
      '/usr/bin/ldd /bin/ls',
      `${SMALL} ${RELEASES}/latest`,
      `${SMALL} ${RELEASES}/${V}/manifest.json`,
      resume(partOf(V), binUrl(V)),
      // A checked copy into the versions directory, never the part itself.
      `/bin/cp ${partOf(V)} ${STAGED}`,
      `${SHA} ${STAGED}`,
      `${VERSIONS_DIR}/${V} install ${V}`,
      `${BIN} --version`,
    ])
    // install.sh runs `<binary> install` under HOME; here the binary already sits
    // where the installer keeps its versions, so it only links ~/.local/bin/claude.
    const inst = h.calls.find((c) => c.args[0] === 'install')!
    expect(inst.env.HOME).toBe(HOME)
    expect(inst.cwd).toBe(HOME)
    expect(h.files.get(`${VERSIONS_DIR}/${V}`)).toEqual(binary)
    expect(h.modes.get(`${VERSIONS_DIR}/${V}`)).toBe(0o755)
    // Nothing downloaded is left behind, and no staging file either.
    expect(h.dlFiles()).toEqual([])
    expect([...h.files.keys()].filter((k) => k.includes('.walnut-'))).toEqual([])
  })

  it('a line that keeps cutting off: every attempt goes on from the bytes already there until the size matches', async () => {
    const h = releaseHost({ releases: { [V]: { binary: binaryOf(V) } }, line: { chunk: 1000 } })
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: true, claude: { version: V } })
    expect(h.downloads.map((d) => d.from)).toEqual([-1, 1000, 2000])
    // A cut that brought bytes is followed at once (1s), never by a long backoff.
    expect(h.sleeps).toEqual([1000, 1000])
    expect(h.logged.filter((l) => l.msg === 'host.fix download').map((l) => [l.data!.from, l.data!.to, l.data!.code])).toEqual([[0, 1000, 18], [1000, 2000, 18], [2000, 3000, 0]])
  })

  it('a half part an earlier attempt kept is resumed, not started over', async () => {
    const binary = binaryOf(V)
    const h = releaseHost({ releases: { [V]: { binary } }, files: { [partOf(V)]: binary.subarray(0, 1500) } })
    expect(await h.fix.run('install-claude-native')).toMatchObject({ ok: true, claude: { version: V } })
    expect(h.downloads.map((d) => d.from)).toEqual([1500])
    expect(h.files.get(`${VERSIONS_DIR}/${V}`)).toEqual(binary)
  })

  it('a checksum mismatch removes the part, installs nothing and says download-failed', async () => {
    // A kept part whose bytes went bad (a proxy, a disk): it completes, then fails the check.
    const h = releaseHost({ releases: { [V]: { binary: binaryOf(V) } }, files: { [partOf(V)]: Buffer.alloc(1500, 'x') } })
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: false, error: 'download-failed', manualCommand: INSTALL })
    expect(r.log).toContain('checksum mismatch')
    expect(h.dlFiles()).toEqual([])
    expect(h.files.has(`${VERSIONS_DIR}/${V}`)).toBe(false)
    expect(h.calls.some((c) => c.args[0] === 'install')).toBe(false)
  })

  it('a part larger than the manifest says is removed, and the download starts from zero', async () => {
    const h = releaseHost({ releases: { [V]: { binary: binaryOf(V) } }, files: { [partOf(V)]: Buffer.alloc(4000, 'x') } })
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: true, claude: { version: V } })
    expect(h.downloads.map((d) => d.from)).toEqual([-1])
    expect(r.log).toContain('larger than the 3000 bytes')
  })

  it('a server that ignores Range (curl 33): the part is removed and the download tried once from zero', async () => {
    const binary = binaryOf(V)
    const h = releaseHost({ releases: { [V]: { binary } }, files: { [partOf(V)]: binary.subarray(0, 1500) }, line: { ignoreRange: true } })
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: true, claude: { version: V } })
    expect(h.downloads.map((d) => d.from)).toEqual([1500, -1])
    expect(r.log).toContain('did not resume')
  })

  it('a server that ignores Range on a line that also cuts off: one try from zero, then download-failed', async () => {
    const h = releaseHost({ releases: { [V]: { binary: binaryOf(V) } }, line: { ignoreRange: true, chunk: 1000 } })
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: false, error: 'download-failed', manualCommand: INSTALL })
    // cut at 1000, refused, from zero, cut at 1000, refused again: no third start.
    expect(h.downloads.map((d) => d.from)).toEqual([-1, 1000, -1, 1000])
  })

  it('latest moved on while an older release was half downloaded: that one is resumed while its manifest is still served', async () => {
    const old = binaryOf('2.1.300')
    const h = releaseHost({
      releases: { '2.1.300': { binary: old }, [V]: { binary: binaryOf(V) } },
      files: { [partOf('2.1.300')]: old.subarray(0, 1500) },
    })
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: true, claude: { version: '2.1.300' } })
    expect(curlUrls(h.calls)).toEqual([`${RELEASES}/latest`, `${RELEASES}/2.1.300/manifest.json`, binUrl('2.1.300')])
    expect(h.downloads.map((d) => d.from)).toEqual([1500])
    expect(r.log).toContain('resuming the kept download of 2.1.300 (latest is 2.1.317)')
    expect(h.files.get(`${VERSIONS_DIR}/2.1.300`)).toEqual(old)
  })

  it('latest moved on and the older release is gone: its part is removed and latest is fetched', async () => {
    const h = releaseHost({
      releases: { '2.1.300': { binary: binaryOf('2.1.300'), gone: true }, [V]: { binary: binaryOf(V) } },
      files: { [partOf('2.1.300')]: binaryOf('2.1.300').subarray(0, 1500) },
    })
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: true, claude: { version: V } })
    expect(curlUrls(h.calls)).toEqual([`${RELEASES}/latest`, `${RELEASES}/2.1.300/manifest.json`, `${RELEASES}/${V}/manifest.json`, binUrl(V)])
    expect(h.downloads).toEqual([{ url: binUrl(V), from: -1, present: [] }])
    expect(h.dlFiles()).toEqual([])
  })

  it('with zstd on the host: the compressed build is fetched, its sha256 checked, unpacked and checked against manifest.json', async () => {
    const binary = binaryOf(V)
    const h = releaseHost({ zstd: true, releases: { [V]: { binary, zst: zlib.gzipSync(binary) } } })
    const r = await h.fix.run('install-claude-native', ASKED)
    expect(r).toMatchObject({ ok: true, claude: { version: V } })
    const stem = `${DL}/claude-${V}-linux-x64`
    expect(h.calls.map(cmdLine).slice(2)).toEqual([
      `${SMALL} ${RELEASES}/latest`,
      `${SMALL} ${RELEASES}/${V}/manifest.json`,
      `${SMALL} ${RELEASES}/${V}/manifest.zst.json`,
      resume(zstPartOf(V), `${binUrl(V)}.zst`),
      `${SHA} ${zstPartOf(V)}`,
      `${ZSTD} -d -q -f -o ${stem} ${zstPartOf(V)}`,
      `${SHA} ${stem}`,
      `${VERSIONS_DIR}/${V} install ${V}`,
      `${BIN} --version`,
    ])
    expect(h.files.get(`${VERSIONS_DIR}/${V}`)).toEqual(binary)
    expect(h.dlFiles()).toEqual([])
  })

  it.each([
    ['the .zst fails its checksum', (b: Buffer) => ({ zst: zlib.gzipSync(b), zstChecksum: 'e'.repeat(64) })],
    ['the .zst does not unpack', () => ({ zst: Buffer.from('not compressed at all') })],
    ['the unpacked file fails manifest.json\'s checksum', (b: Buffer) => ({ zst: zlib.gzipSync(Buffer.alloc(b.length, 'y')) })],
  ])('%s: both files are removed before the plain binary is fetched', async (_label, zstOf) => {
    const binary = binaryOf(V)
    const h = releaseHost({ zstd: true, releases: { [V]: { binary, ...zstOf(binary) } } })
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: true, claude: { version: V } })
    expect(h.downloads.map((d) => d.url)).toEqual([`${binUrl(V)}.zst`, binUrl(V)])
    // When the plain download starts, nothing of the compressed attempt is left.
    expect(h.downloads[1]!.present).toEqual([])
    expect(r.log).toContain('the compressed download did not verify')
    expect(h.files.get(`${VERSIONS_DIR}/${V}`)).toEqual(binary)
    expect(h.dlFiles()).toEqual([])
  })

  it('the deadline keeps the part and says timeout; the next Install goes on from there', async () => {
    const binary = binaryOf(V, 4000)
    // Each run brings 1000 bytes in 22 minutes. A third would start at minute 44,
    // inside the last 2 that are kept for checking and installing: it does not.
    const h = releaseHost({ releases: { [V]: { binary } }, line: { chunk: 1000, stepMs: 22 * MIN } })
    const first = await h.fix.run('install-claude-native', ASKED)
    expect(first).toMatchObject({ ok: false, error: 'timeout', manualCommand: INSTALL, durationMs: 44 * MIN })
    expect(h.files.get(partOf(V))!.length).toBe(2000)
    expect(h.calls.some((c) => c.args[0] === 'install')).toBe(false)
    // The person clicks Install again.
    h.line.stepMs = 0
    const again = await h.fix.run('install-claude-native')
    expect(again).toMatchObject({ ok: true, claude: { version: V } })
    expect(h.downloads.map((d) => d.from)).toEqual([-1, 1000, 2000, 3000])
    expect(h.files.get(`${VERSIONS_DIR}/${V}`)).toEqual(binary)
  })

  it('a line that keeps failing: five tries that bring nothing, longer pauses between them, then download-failed with the part kept', async () => {
    const binary = binaryOf(V)
    const h = releaseHost({ releases: { [V]: { binary } }, files: { [partOf(V)]: binary.subarray(0, 1500) }, line: { down: 7 } })
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: false, error: 'download-failed', manualCommand: INSTALL })
    expect(h.downloads.map((d) => d.from)).toEqual([1500, 1500, 1500, 1500, 1500])
    expect(h.sleeps).toEqual([5000, 10000, 15000, 20000])
    expect(h.files.get(partOf(V))!.length).toBe(1500)
  })

  it('`claude install` failing is installer-failed with its last lines; the verified binary stays placed, so the next Install downloads nothing', async () => {
    const binary = binaryOf(V)
    const h = releaseHost({ releases: { [V]: { binary } }, installCode: 1 })
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: false, error: 'installer-failed', manualCommand: INSTALL })
    expect(r.log).toContain('EACCES: permission denied, symlink ~/.local/bin/claude')
    expect(r.log).toContain('[exit 1]')
    expect(h.dlFiles()).toEqual([])
    h.state.installCode = 0
    h.calls.length = 0
    expect(await h.fix.run('install-claude-native')).toMatchObject({ ok: true, claude: { version: V } })
    expect(h.calls.map(cmdLine).slice(4)).toEqual([`${SHA} ${VERSIONS_DIR}/${V}`, `${VERSIONS_DIR}/${V} install ${V}`, `${BIN} --version`])
  })

  it.each([
    ['no manifest for latest', { [V]: { binary: binaryOf(V), gone: true } }, V],
    ['no entry for this platform', { [V]: { binary: binaryOf(V), noEntry: true } }, V],
    ['latest is not a version (an error page)', {}, '<html>Service unavailable</html>'],
  ] as Array<[string, Record<string, Served>, string]>)('%s: install.sh runs as before', async (_label, releases, latest) => {
    const h = releaseHost({ releases, latest })
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: true })
    const sh = `${TMP}/walnut-claude-install-1/install.sh`
    expect(h.calls.map(cmdLine).slice(-3)).toEqual([`${CURL} -fsSL -o ${sh} https://claude.ai/install.sh`, `/bin/bash ${sh}`, `${BIN} --version`])
    expect(h.downloads).toEqual([])
  })

  it('no sha256 tool or no curl: install.sh runs as before, and nothing of the native path is asked', async () => {
    const h = releaseHost({ releases: { [V]: { binary: binaryOf(V) } }, bins: { sha256sum: '' } })
    expect(await h.fix.run('install-claude-native')).toMatchObject({ ok: true })
    expect(h.calls.map((c) => c.file)).toEqual([CURL, '/bin/bash', BIN])
  })

  it.each([
    ['linux', 'aarch64', {}, 'linux-arm64'],
    ['linux', 'x86_64', { musl: 'loader' }, 'linux-x64-musl'],
    ['linux', 'x86_64', { musl: 'ldd' }, 'linux-x64-musl'],
    ['darwin', 'x86_64', { rosetta: true }, 'darwin-arm64'],
    ['darwin', 'x86_64', {}, 'darwin-x64'],
    ['darwin', 'arm64', {}, 'darwin-arm64'],
  ] as Array<[string, string, { musl?: 'loader' | 'ldd'; rosetta?: boolean }, string]>)('%s %s %j installs the %s build', async (platform, machine, extra, want) => {
    // A Mac has shasum, not sha256sum.
    const bins: Record<string, string> = platform === 'darwin' ? { sha256sum: '', shasum: '/usr/bin/shasum' } : {}
    const h = releaseHost({ platform, machine, ...extra, bins, releases: { [V]: { binary: binaryOf(V) } } })
    expect(await h.fix.run('install-claude-native')).toMatchObject({ ok: true, claude: { version: V } })
    expect(h.downloads.map((d) => d.url)).toEqual([binUrl(V, want)])
    if (platform === 'darwin') expect(h.calls.map(cmdLine)).toContain(`/usr/bin/shasum -a 256 ${STAGED}`)
  })

  it('WALNUT_CLAUDE_DOWNLOADS points every request at another release server', async () => {
    const mirror = 'https://mirror.example.test/releases'
    const h = releaseHost({ base: mirror, env: { WALNUT_CLAUDE_DOWNLOADS: mirror + '/' }, releases: { [V]: { binary: binaryOf(V) } } })
    expect(await h.fix.run('install-claude-native')).toMatchObject({ ok: true, claude: { version: V } })
    expect(curlUrls(h.calls)).toEqual([`${mirror}/latest`, `${mirror}/${V}/manifest.json`, `${mirror}/${V}/linux-x64/claude`])
  })

  it('latest out of reach: asked once more after 2s, then download-failed; install.sh would cross the same line with no resume', async () => {
    const h = releaseHost({ before: (file) => (file === CURL ? { code: 6, stderr: 'curl: (6) Could not resolve host\n' } : undefined) })
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: false, error: 'download-failed', manualCommand: INSTALL })
    expect(curlUrls(h.calls)).toEqual([`${RELEASES}/latest`, `${RELEASES}/latest`])
    expect(h.sleeps).toEqual([2000])
  })

  it('the line fails on an older release\'s manifest: latest is installed, and that release\'s kept part stays', async () => {
    const old = binaryOf('2.1.300')
    const h = releaseHost({
      releases: { '2.1.300': { binary: old }, [V]: { binary: binaryOf(V) } },
      files: { [partOf('2.1.300')]: old.subarray(0, 2000) },
      before: (file, args) => (file === CURL && args[args.length - 1] === `${RELEASES}/2.1.300/manifest.json` ? { code: 28, stderr: 'curl: (28) Operation timed out\n' } : undefined),
    })
    expect(await h.fix.run('install-claude-native')).toMatchObject({ ok: true, claude: { version: V } })
    expect(h.files.get(partOf('2.1.300'))!.length).toBe(2000)
    expect(h.downloads.map((d) => [d.url, d.from])).toEqual([[binUrl(V), -1]])
  })

  it('the line fails on latest\'s own manifest: download-failed, nothing removed', async () => {
    const binary = binaryOf(V)
    const h = releaseHost({
      releases: { [V]: { binary } },
      files: { [partOf(V)]: binary.subarray(0, 1000) },
      before: (file, args) => (file === CURL && args[args.length - 1]!.endsWith('/manifest.json') ? { code: 7, stderr: 'curl: (7) Failed to connect\n' } : undefined),
    })
    expect(await h.fix.run('install-claude-native')).toMatchObject({ ok: false, error: 'download-failed', manualCommand: INSTALL })
    expect(h.files.get(partOf(V))!.length).toBe(1000)
    expect(h.calls.map((c) => c.file)).not.toContain('/bin/bash')
  })

  it('with the server\'s floor, a kept download of a release below it is removed, never resumed, and latest is installed', async () => {
    const h = releaseHost({
      releases: { '2.1.250': { binary: binaryOf('2.1.250') }, [V]: { binary: binaryOf(V) } },
      files: { [partOf('2.1.250')]: binaryOf('2.1.250').subarray(0, 2500) },
    })
    const r = await h.fix.run('install-claude-native', { ...ASKED, minClaudeVersion: '2.1.280' })
    expect(r).toMatchObject({ ok: true, claude: { version: V } })
    // 2.1.250 had the most bytes but is below the floor: never looked up, never resumed.
    expect(curlUrls(h.calls)).toEqual([`${RELEASES}/latest`, `${RELEASES}/${V}/manifest.json`, binUrl(V)])
    expect(h.files.get(`${VERSIONS_DIR}/${V}`)).toEqual(binaryOf(V))
    expect(h.dlFiles()).toEqual([])
  })

  it('a part below the floor is removed even when latest\'s manifest does not come; one above it stays', async () => {
    const h = releaseHost({
      releases: { [V]: { binary: binaryOf(V) } },
      files: { [partOf('2.1.250')]: binaryOf('2.1.250').subarray(0, 2500), [partOf(V)]: binaryOf(V).subarray(0, 1000) },
      before: (file, args) => (file === CURL && args[args.length - 1]!.endsWith('/manifest.json') ? { code: 7, stderr: 'curl: (7) Failed to connect\n' } : undefined),
    })
    expect(await h.fix.run('install-claude-native', { ...ASKED, minClaudeVersion: '2.1.280' })).toMatchObject({ ok: false, error: 'download-failed' })
    expect(h.dlFiles()).toEqual([partOf(V)])
  })

  it('without a floor (an older server), the kept release with the most bytes is still resumed', async () => {
    const h = releaseHost({
      releases: { '2.1.250': { binary: binaryOf('2.1.250') }, [V]: { binary: binaryOf(V) } },
      files: { [partOf('2.1.250')]: binaryOf('2.1.250').subarray(0, 2500) },
    })
    expect(await h.fix.run('install-claude-native', ASKED)).toMatchObject({ ok: true })
    expect(h.downloads.map((d) => [d.url, d.from])).toEqual([[binUrl('2.1.250'), 2500]])
  })

  it('a server that names no wait (older than `waitMs`, it gives up at 330s) gets at most 5 minutes, so it never meets a fix still running; the part stays', async () => {
    const binary = binaryOf(V, 4000)
    const h = releaseHost({ releases: { [V]: { binary } }, line: { chunk: 1000, stepMs: 2 * MIN } })
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: false, error: 'timeout', manualCommand: INSTALL })
    expect(r.durationMs).toBeLessThanOrEqual(5 * MIN)
    // Two runs of 2 minutes fit before the last 2 kept for checking and installing.
    expect(h.files.get(partOf(V))!.length).toBe(2000)
    // The new server's own wait is honoured too, and never past the daemon's 45 minutes.
    h.line.stepMs = 0
    expect(await h.fix.run('install-claude-native', { waitMs: 10 * 60 * MIN })).toMatchObject({ ok: true })
    const caps = h.calls.filter((c) => c.file === CURL && c.args.includes('-C')).map((c) => Number(c.args[c.args.indexOf('--max-time') + 1]))
    expect(Math.max(...caps)).toBeLessThanOrEqual(45 * 60)
  })

  it('the copy into the versions directory fails (a full disk): installer-failed, the finished part stays and the next Install only copies it', async () => {
    const binary = binaryOf(V)
    const h = releaseHost({ releases: { [V]: { binary } } })
    h.state.cpFails = true
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: false, error: 'installer-failed', manualCommand: INSTALL })
    expect(r.log).toContain('No space left on device')
    expect(h.files.get(partOf(V))).toEqual(binary)
    expect([...h.files.keys()].filter((k) => k.startsWith(VERSIONS_DIR))).toEqual([])
    h.state.cpFails = false
    expect(await h.fix.run('install-claude-native')).toMatchObject({ ok: true, claude: { version: V } })
    // The part already holds every byte: no curl run at all the second time.
    expect(h.downloads).toHaveLength(1)
    expect(h.dlFiles()).toEqual([])
  })

  it('the sha256 tool itself failing is not a mismatch: download-failed, and the download stays', async () => {
    const binary = binaryOf(V)
    const h = releaseHost({ releases: { [V]: { binary } }, before: (file) => (file === SHA ? { code: 1, stderr: 'sha256sum: read error: Input/output error\n' } : undefined) })
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: false, error: 'download-failed' })
    expect(r.log).not.toContain('checksum mismatch')
    expect(h.files.get(partOf(V))).toEqual(binary)
  })

  it.each(['error', 'forgive'] as const)('a resumed request answered 416 (curl %s): the part is removed and the download tried once from zero', async (range416) => {
    const binary = binaryOf(V)
    const h = releaseHost({ releases: { [V]: { binary } }, files: { [partOf(V)]: binary.subarray(0, 1500) }, line: { range416 } })
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: true, claude: { version: V } })
    expect(h.downloads.map((d) => d.from)).toEqual([1500, -1])
  })

  it('a download still running at the deadline: curl is stopped by its own --max-time or, failing that, its process group is signalled; the part stays', async () => {
    vi.useFakeTimers()
    try {
      const kills: Array<[number, string]> = []
      const binary = binaryOf(V)
      const h = releaseHost({ releases: { [V]: { binary } }, files: { [partOf(V)]: binary.subarray(0, 1000) }, hang: true, realClock: true, kill: (pid, sig) => { kills.push([pid, sig]) } })
      const done = h.fix.run('install-claude-native', ASKED)
      await vi.advanceTimersByTimeAsync(43 * MIN - 1000)
      expect(h.calls.map(cmdLine)).toContain(resume(partOf(V), binUrl(V)))
      expect(kills).toEqual([])
      await vi.advanceTimersByTimeAsync(1000)
      expect(kills).toEqual([[-4242, 'SIGTERM']])
      await vi.advanceTimersByTimeAsync(6000)
      expect(kills).toEqual([[-4242, 'SIGTERM'], [-4242, 'SIGKILL']])
      expect(await done).toMatchObject({ ok: false, error: 'timeout', manualCommand: INSTALL })
      expect(h.files.get(partOf(V))!.length).toBe(1000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('with zstd on the host, a plain download already under way is finished, not dropped for the compressed one', async () => {
    const binary = binaryOf(V)
    const h = releaseHost({ zstd: true, releases: { [V]: { binary, zst: zlib.gzipSync(binary) } }, files: { [partOf(V)]: binary.subarray(0, 2500) } })
    expect(await h.fix.run('install-claude-native')).toMatchObject({ ok: true, claude: { version: V } })
    expect(h.downloads.map((d) => [d.url, d.from])).toEqual([[binUrl(V), 2500]])
  })
})

describe('cancel(): a stopping daemon stops the fix in flight at once', () => {
  const V = '2.1.317'

  it('a download in flight: its process group gets SIGTERM, then SIGKILL; the fix answers cancelled and the part stays for the next Install', async () => {
    vi.useFakeTimers()
    try {
      const kills: Array<[number, string]> = []
      const binary = binaryOf(V)
      const h = releaseHost({ releases: { [V]: { binary } }, files: { [partOf(V)]: binary.subarray(0, 1000) }, hang: true, realClock: true, kill: (pid, sig) => { kills.push([pid, sig]) } })
      const done = h.fix.run('install-claude-native')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(h.fix.running).toBe('install-claude-native')
      expect(h.fix.cancel()).toBe(true)
      expect(kills).toEqual([[-4242, 'SIGTERM']])
      await vi.advanceTimersByTimeAsync(6000)
      expect(kills).toEqual([[-4242, 'SIGTERM'], [-4242, 'SIGKILL']])
      const r = await done
      expect(r).toMatchObject({ ok: false, error: 'cancelled', manualCommand: INSTALL })
      expect(r.log).toContain('the session daemon is shutting down')
      // Nothing started after the cancel: no checksum, no copy, no `claude install`.
      expect(h.calls.filter((c) => c.file !== CURL && c.file !== '/usr/bin/uname' && c.file !== '/usr/bin/ldd')).toEqual([])
      expect(h.files.get(partOf(V))!.length).toBe(1000)
      expect(h.fix.running).toBeNull()
      // The next Install (a new daemon) resumes the part: the cancel does not stick.
      h.state.hang = false
      vi.useRealTimers()
      expect(await h.fix.run('install-claude-native')).toMatchObject({ ok: true, claude: { version: V } })
      expect(h.downloads.map((d) => d.from)).toEqual([1000, 1000])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a pause between attempts ends at once, and no further attempt starts', async () => {
    vi.useFakeTimers()
    try {
      const binary = binaryOf(V)
      const h = releaseHost({ releases: { [V]: { binary } }, files: { [partOf(V)]: binary.subarray(0, 1500) }, line: { down: 7 }, realSleep: true, realClock: true })
      const done = h.fix.run('install-claude-native')
      // The first attempt failed at once; the fix now waits 5s before the next.
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.downloads).toHaveLength(1)
      expect(h.fix.cancel()).toBe(true)
      // No timer is advanced: the pause itself must let go.
      expect(await done).toMatchObject({ ok: false, error: 'cancelled' })
      expect(h.downloads).toHaveLength(1)
      expect(h.files.get(partOf(V))!.length).toBe(1500)
    } finally {
      vi.useRealTimers()
    }
  })

  it('during `claude install`: its group is stopped; the verified binary stays placed, so the next Install downloads nothing', async () => {
    vi.useFakeTimers()
    try {
      const kills: Array<[number, string]> = []
      const binary = binaryOf(V)
      let hang = true
      const h = releaseHost({ releases: { [V]: { binary } }, realClock: true, kill: (pid, sig) => { kills.push([pid, sig]) }, hangWhen: (file, args) => hang && file === `${VERSIONS_DIR}/${V}` && args[0] === 'install' })
      const done = h.fix.run('install-claude-native')
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.calls.map(cmdLine)).toContain(`${VERSIONS_DIR}/${V} install ${V}`)
      expect(h.fix.cancel()).toBe(true)
      await vi.advanceTimersByTimeAsync(6000)
      expect(kills).toEqual([[-4242, 'SIGTERM'], [-4242, 'SIGKILL']])
      expect(await done).toMatchObject({ ok: false, error: 'cancelled' })
      expect(h.files.get(`${VERSIONS_DIR}/${V}`)).toEqual(binary)
      hang = false
      vi.useRealTimers()
      expect(await h.fix.run('install-claude-native')).toMatchObject({ ok: true, claude: { version: V } })
      expect(h.downloads).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('during the claude probe (its own child, not ours): the fix answers at once and asks no second probe', async () => {
    const h = releaseHost({ releases: { [V]: { binary: binaryOf(V) } }, probeHang: true })
    const done = h.fix.run('install-claude-native')
    await new Promise((r) => setTimeout(r, 5))
    expect(h.probes).toEqual(['claude'])
    expect(h.fix.cancel()).toBe(true)
    expect(await done).toMatchObject({ ok: false, error: 'cancelled' })
    expect(h.probes).toEqual(['claude'])
    expect(h.calls).toEqual([])
  })

  it('never an install-compiler: a package manager killed mid-transaction breaks the host, so the drain waits for it as before', async () => {
    const kills: Array<[number, string]> = []
    let release: (r: Reply) => void = () => {}
    const h = fakeHost({ bins: { sudo: '/usr/bin/sudo', yum: '/usr/bin/yum' }, script: () => new Promise<Reply>((resolve) => { release = resolve }) })
    const fix = createHostFix({ ...h.deps, kill: (pid, sig) => { kills.push([pid, sig]) } })
    const done = fix.run('install-compiler')
    await new Promise((r) => setTimeout(r, 10))
    expect(fix.running).toBe('install-compiler')
    expect(fix.cancel()).toBe(false)
    h.bins.gcc = '/usr/bin/gcc'
    release({ code: 0 })
    expect(await done).toMatchObject({ ok: true, packageManager: 'yum' })
    expect(kills).toEqual([])
  })

  it('nothing in flight: cancel() is a no-op, and a child that reports pid 1 or below is never signalled', async () => {
    const kills: Array<[number, string]> = []
    const idle = releaseHost({ kill: (pid, sig) => { kills.push([pid, sig]) } })
    expect(idle.fix.cancel()).toBe(false)
    vi.useFakeTimers()
    try {
      const binary = binaryOf(V)
      for (const pid of [1, 0, -1]) {
        const h = releaseHost({ releases: { [V]: { binary } }, hang: true, hangPid: pid, realClock: true, kill: (p, sig) => { kills.push([p, sig]) } })
        const done = h.fix.run('install-claude-native')
        await vi.advanceTimersByTimeAsync(1000)
        expect(h.fix.cancel()).toBe(true)
        // The promise still answers, 6s on, without a signal to anything.
        await vi.advanceTimersByTimeAsync(6000)
        expect(await done).toMatchObject({ ok: false, error: 'cancelled' })
      }
      expect(kills).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('update-claude on a slow line', () => {
  it('an updater out of its 3 minutes hands over to the resumable installer, which does not resume a kept release below the floor', async () => {
    const V = '2.1.317'
    const h = releaseHost({
      installed: '2.1.258',
      releases: { '2.1.250': { binary: binaryOf('2.1.250') }, [V]: { binary: binaryOf(V) } },
      files: { [partOf('2.1.250')]: binaryOf('2.1.250').subarray(0, 2000) },
      // `claude update` downloads the whole binary itself; on this line its 3 minutes run out.
      before: (file, args) => (file === BIN && args[0] === 'update' ? { code: -1, killed: true } : undefined),
    })
    const r = await h.fix.run('update-claude', { minClaudeVersion: '2.1.280' })
    expect(r).toMatchObject({ action: 'update-claude', ok: true, claude: { path: BIN, version: V } })
    expect(curlUrls(h.calls)).toEqual([`${RELEASES}/latest`, `${RELEASES}/${V}/manifest.json`, binUrl(V)])
    expect(h.dlFiles()).toEqual([])
  })
})

// ── The same steps with the real curl, sha256 tool and fs, over file:// ──────

/** An executable on this worker's PATH (the exec guard's PATH), or null. */
function onPath(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue
    const p = path.join(dir, cmd)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      if (fs.statSync(p).isFile()) return p
    } catch { /* not here */ }
  }
  return null
}
const REAL_TOOLS = ['curl', 'uname', 'ldd', 'sha256sum', 'shasum', 'cp']
const hasRealTools = !!onPath('curl') && !!onPath('uname') && (!!onPath('sha256sum') || !!onPath('shasum'))

describe.skipIf(!hasRealTools)('install-claude-native with the real curl over file://', () => {
  const V = '2.1.317'
  let root = ''
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true })
    root = ''
  })

  /** A release server in a temp dir; every platform gets the same stand-in binary. */
  function realHost() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-hostfix-dl-'))
    const srv = path.join(root, 'srv')
    const home = path.join(root, 'home')
    const dl = path.join(home, '.claude', 'downloads')
    fs.mkdirSync(dl, { recursive: true })
    // Stands in for the Claude Code binary: `install` links it the way the real one
    // does; the padding after `exit` makes a half download worth resuming.
    const binary = Buffer.from([
      '#!/bin/sh',
      'if [ "$1" = install ]; then mkdir -p "$HOME/.local/bin" && ln -sf "$0" "$HOME/.local/bin/claude" && echo "installed $2"; exit $?; fi',
      `if [ "$1" = --version ]; then echo "${V} (Claude Code)"; exit 0; fi`,
      'exit 1',
      '# ' + 'x'.repeat(256 * 1024),
      '',
    ].join('\n'))
    const entry = { binary: 'claude', checksum: sha(binary), size: binary.length }
    for (const p of PLATFORMS) {
      fs.mkdirSync(path.join(srv, V, p), { recursive: true })
      fs.writeFileSync(path.join(srv, V, p, 'claude'), binary)
    }
    fs.writeFileSync(path.join(srv, V, 'manifest.json'), JSON.stringify({ version: V, platforms: Object.fromEntries(PLATFORMS.map((p) => [p, entry])) }, null, 2))
    fs.writeFileSync(path.join(srv, 'latest'), V + '\n')
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, WALNUT_CLAUDE_DOWNLOADS: 'file://' + srv }
    delete env.XDG_DATA_HOME
    const linked = path.join(home, '.local', 'bin', 'claude')
    const downloads: Array<Record<string, unknown>> = []
    const fix = createHostFix({
      execFile: execFile as unknown as HostFixDeps['execFile'],
      fs, env,
      os: { platform: () => process.platform, tmpdir: () => os.tmpdir(), uid: () => 1000 },
      runtime: {
        // No zstd (this server has no compressed build); `claude` is only ever the stand-in.
        resolveOnPath: (cmd) => (cmd === 'claude' ? (fs.existsSync(linked) ? linked : null) : REAL_TOOLS.includes(cmd) ? onPath(cmd) : null),
        probeClaude: async (command) => {
          const p = command === 'claude' ? linked : command
          return fs.existsSync(p) ? { found: true, kind: 'native', needsNode: false, path: p } : { found: false }
        },
      },
      sleep: async () => {},
      log: (_level, msg, data) => { if (msg === 'host.fix download') downloads.push(data!) },
      claudeInstall: createClaudeInstall, claudeDownload: createClaudeDownload, dtachBuild: createDtachBuild,
    })
    /** A kept part for every platform: only the host's own may be touched. */
    const seedParts = (bytes: Buffer) => {
      for (const p of PLATFORMS) fs.writeFileSync(path.join(dl, `claude-${V}-${p}.part`), bytes)
    }
    const othersLeft = (platform: string) => PLATFORMS.filter((p) => p !== platform).map((p) => `claude-${V}-${p}.part`).sort()
    return { home, dl, binary, linked, fix, downloads, seedParts, othersLeft, placed: path.join(home, '.local', 'share', 'claude', 'versions', V) }
  }

  it('resumes a half part with `curl -C -`, checks it, places it in the versions directory and links it', async () => {
    const h = realHost()
    const half = Math.floor(h.binary.length / 2)
    h.seedParts(h.binary.subarray(0, half))
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: true, claude: { path: h.linked, version: V } })
    expect(h.downloads).toHaveLength(1)
    expect(h.downloads[0]).toMatchObject({ from: half, to: h.binary.length, code: 0 })
    const platform = String(h.downloads[0]!.url).split('/').slice(-2)[0]!
    expect(PLATFORMS).toContain(platform)
    expect(fs.readFileSync(h.placed)).toEqual(h.binary)
    expect(fs.statSync(h.placed).mode & 0o777).toBe(0o755)
    expect(fs.realpathSync(h.linked)).toBe(fs.realpathSync(h.placed))
    expect(fs.readdirSync(h.dl).sort()).toEqual(h.othersLeft(platform))
    expect(fs.readdirSync(path.dirname(h.placed))).toEqual([V])
  })

  it('a kept part with bad bytes fails the real checksum: it is removed and nothing is placed', async () => {
    const h = realHost()
    h.seedParts(Buffer.alloc(1000, 'z'))
    const r = await h.fix.run('install-claude-native')
    expect(r).toMatchObject({ ok: false, error: 'download-failed' })
    expect(r.log).toContain('checksum mismatch')
    const platform = String(h.downloads[0]!.url).split('/').slice(-2)[0]!
    expect(fs.readdirSync(h.dl).sort()).toEqual(h.othersLeft(platform))
    expect(fs.existsSync(h.placed)).toBe(false)
    expect(fs.existsSync(h.linked)).toBe(false)
  })
})

// ── update-claude ────────────────────────────────────────────────────────────

describe('update-claude', () => {
  const VERSIONS = `${HOME}/.local/share/claude/versions`
  /** A native-installer host whose `claude update` moves ~/.local/bin/claude from `from` to `to`. */
  function nativeHost(opts: { from?: string; to?: string; updateCode?: number; updateOut?: string; env?: Record<string, string>; realpath?: string; platform?: string; keychain?: string } = {}) {
    let version = opts.from ?? '2.1.258'
    const h = fakeHost({
      platform: opts.platform,
      bins: { claude: BIN, curl: '/usr/bin/curl', bash: '/bin/bash' },
      claude: { [BIN]: { ...NATIVE, path: BIN } },
      script: (file, args) => {
        if (file === BIN && args[0] === '--version') return { code: 0, stdout: `${version} (Claude Code)\n` }
        if (file === BIN && args[0] === 'update') {
          if ((opts.updateCode ?? 0) === 0) version = opts.to ?? '2.1.280'
          return { code: opts.updateCode ?? 0, stdout: opts.updateOut ?? `Current version: 2.1.258\nSuccessfully updated from 2.1.258 to ${opts.to ?? '2.1.280'}\n` }
        }
        if (file === '/bin/bash') { version = opts.to ?? '2.1.280'; return { code: 0 } }
        if (file === '/usr/bin/osascript') return opts.keychain === 'fail' ? { code: 1, stderr: 'execution error' } : { code: 0, stdout: `status ${opts.keychain ?? '7'}\n` }
        return { code: 0 }
      },
    })
    const fixFs = { ...(h.deps.fs as object), realpathSync: (p: string) => (p === BIN ? opts.realpath ?? `${VERSIONS}/${version}` : p) }
    const fix = createHostFix({ ...h.deps, fs: fixFs as unknown as HostFixDeps['fs'], env: { ...h.deps.env, ...opts.env } })
    return { ...h, fix }
  }

  it('runs `claude update` on the native installer\'s claude, then verifies the new version against the floor', async () => {
    const h = nativeHost()
    const r = await h.fix.run('update-claude', { minClaudeVersion: '2.1.280' })
    expect(nonProbe(h.calls).map(cmdLine)).toEqual([`${BIN} --version`, `${BIN} update`, `${BIN} --version`])
    expect(r).toMatchObject({ action: 'update-claude', ok: true, claude: { path: BIN, kind: 'native', version: '2.1.280' } })
    expect(r.skipped).toBeUndefined()
  })

  // 2026-11-03: `claude update` starts the whole CLI, which reads its token from the
  // keychain; a locked login keychain then asks for its password on that Mac's screen.
  it('on a Mac whose login keychain is locked it never runs `claude update`, and says how to run it by hand', async () => {
    const h = nativeHost({ platform: 'darwin', keychain: '2' })
    const r = await h.fix.run('update-claude', { minClaudeVersion: '2.1.280' })
    expect(r).toMatchObject({ ok: false, error: 'keychain-locked', manualCommand: 'claude update' })
    expect(nonProbe(h.calls).map((c) => c.file)).toEqual([BIN, '/usr/bin/osascript'])
    // The status check asks SecKeychainGetStatus, which never unlocks.
    expect(nonProbe(h.calls)[1].args.slice(0, 2)).toEqual(['-l', 'JavaScript'])
    expect(nonProbe(h.calls)[1].args[3]).toContain('SecKeychainGetStatus')
  })

  it('an unlocked keychain (or no answer from it) updates as before, and Linux never asks', async () => {
    for (const keychain of ['7', '3', 'fail']) {
      const h = nativeHost({ platform: 'darwin', keychain })
      expect(await h.fix.run('update-claude', { minClaudeVersion: '2.1.280' })).toMatchObject({ ok: true, claude: { version: '2.1.280' } })
      expect(nonProbe(h.calls).map(cmdLine)).toContain(`${BIN} update`)
    }
    const linux = nativeHost()
    await linux.fix.run('update-claude', { minClaudeVersion: '2.1.280' })
    expect(linux.calls.some((c) => c.file === '/usr/bin/osascript')).toBe(false)
  })

  it('already new enough: nothing runs but the version check', async () => {
    const h = nativeHost({ from: '2.1.281' })
    expect(await h.fix.run('update-claude', { minClaudeVersion: '2.1.280' })).toMatchObject({ ok: true, skipped: true, claude: { version: '2.1.281' } })
    expect(nonProbe(h.calls).map(cmdLine)).toEqual([`${BIN} --version`])
  })

  it('an update that stops short of the floor (a release channel behind it) is still-outdated, with the command that reaches it', async () => {
    const h = nativeHost({ to: '2.1.270', updateOut: 'Claude Code is up to date (2.1.270)\n' })
    expect(await h.fix.run('update-claude', { minClaudeVersion: '2.1.280' }))
      .toMatchObject({ ok: false, error: 'still-outdated', manualCommand: 'claude install latest', claude: { version: '2.1.270' } })
  })

  it('a failing updater falls back to the official installer', async () => {
    const h = nativeHost({ updateCode: 1, updateOut: 'Error: Failed to install native update\n' })
    const r = await h.fix.run('update-claude', { minClaudeVersion: '2.1.280' })
    expect(nonProbe(h.calls).map((c) => c.file)).toEqual([BIN, BIN, '/usr/bin/curl', '/bin/bash', BIN])
    expect(r).toMatchObject({ ok: true, claude: { version: '2.1.280' } })
  })

  it('DISABLE_UPDATES is respected: no updater, no installer', async () => {
    const h = nativeHost({ env: { DISABLE_UPDATES: '1' } })
    expect(await h.fix.run('update-claude', { minClaudeVersion: '2.1.280' })).toMatchObject({ ok: false, error: 'updates-disabled', manualCommand: 'claude update' })
    expect(nonProbe(h.calls).map(cmdLine)).toEqual([`${BIN} --version`])
    // Turned off in settings instead: the updater says so, and the installer does not run behind its back.
    const said = nativeHost({ updateCode: 1, updateOut: 'Updates are disabled by DISABLE_UPDATES\n' })
    expect(await said.fix.run('update-claude', { minClaudeVersion: '2.1.280' })).toMatchObject({ ok: false, error: 'updates-disabled' })
    expect(nonProbe(said.calls).map((c) => c.file)).not.toContain('/bin/bash')
  })

  it('never touches a claude the native installer did not put there (a wrapper script, Homebrew) or an npm build', async () => {
    const wrapper = nativeHost({ realpath: `${HOME}/.wrappers/launcher/1.0/exec` })
    expect(await wrapper.fix.run('update-claude', { minClaudeVersion: '2.1.280' })).toMatchObject({ ok: false, error: 'unmanaged-install' })
    expect(nonProbe(wrapper.calls)).toEqual([])
    const npm = fakeHost({ bins: { claude: BIN }, claude: { [BIN]: { ...NPM, path: BIN } } })
    expect(await npm.fix.run('update-claude', { minClaudeVersion: '2.1.280' })).toMatchObject({ ok: false, error: 'unmanaged-install' })
    expect(nonProbe(npm.calls)).toEqual([])
  })
})

// ── build-dtach ──────────────────────────────────────────────────────────────

const b64 = (s: string) => Buffer.from(s).toString('base64')
const SOURCES = {
  'attach.c': b64('/* attach */'), 'main.c': b64('/* main */'), 'master.c': b64('/* master */'),
  'dtach.h': b64('/* h */'), 'config.h': b64('/* config */'),
}
const DTACH_BIN = `${HOME}/.local/bin/walnut-dtach`

describe('build-dtach', () => {
  it('writes the vendored source, compiles next to the final path, checks the banner, then renames into place', async () => {
    const h = fakeHost({
      bins: { cc: '/usr/bin/cc' },
      script: (file) => {
        // A missing binary is a spawn error that NAMES walnut-dtach: not a dtach.
        if (file === DTACH_BIN) return { code: -1, errCode: 'ENOENT' }
        if (file.endsWith('.partial')) return { code: 0, stdout: DTACH_HELP }
        return { code: 0 }
      },
    })
    const r = await h.fix.run('build-dtach', { sources: SOURCES })
    expect(r).toMatchObject({ ok: true, path: DTACH_BIN })
    const dir = `${TMP}/walnut-dtach-build-1`
    expect(Object.keys(h.written).sort()).toEqual(Object.keys(SOURCES).map((f) => `${dir}/${f}`).sort())
    expect(h.written[`${dir}/main.c`]!.toString()).toBe('/* main */')
    const compile = nonProbe(h.calls).find((c) => c.file === '/usr/bin/cc')!
    expect(compile.cwd).toBe(dir)
    expect(compile.args.slice(0, 3)).toEqual(['-O2', '-I.', '-o'])
    expect(compile.args[3]).toMatch(new RegExp(`^${DTACH_BIN}\\.\\d+\\.partial$`))
    expect(compile.args.slice(4)).toEqual(['attach.c', 'main.c', 'master.c', '-lutil'])
    expect(h.renamed).toEqual([[compile.args[3], DTACH_BIN]])
  })

  it('on a Mac without the Command Line Tools it never runs the /usr/bin/cc stub (that opens a dialog)', async () => {
    const h = fakeHost({
      platform: 'darwin', bins: { cc: '/usr/bin/cc' },
      script: (file) => file === '/usr/bin/xcode-select' ? { code: 2, stderr: 'xcode-select: error: unable to get active developer directory' } : { code: -1, errCode: 'ENOENT' },
    })
    const r = await h.fix.run('build-dtach', { sources: SOURCES })
    expect(r).toMatchObject({ ok: false, error: 'darwin-needs-command-line-tools', manualCommand: 'xcode-select --install' })
    expect(nonProbe(h.calls).map((c) => c.file)).toEqual([DTACH_BIN, '/usr/bin/xcode-select'])
  })

  it('is idempotent: a working walnut-dtach is skipped', async () => {
    const h = fakeHost({ bins: { cc: '/usr/bin/cc' }, script: () => ({ code: 0, stdout: DTACH_HELP }) })
    expect(await h.fix.run('build-dtach', { sources: SOURCES })).toMatchObject({ ok: true, skipped: true })
    expect(nonProbe(h.calls).map((c) => c.file)).toEqual([DTACH_BIN])
  })

  it('refuses sources that are not exactly the vendored files, and reports a compiler failure with its log', async () => {
    const missing = fakeHost({ bins: { cc: '/usr/bin/cc' }, script: () => ({ code: -1, errCode: 'ENOENT' }) })
    const { 'config.h': _dropped, ...partial } = SOURCES
    expect(await missing.fix.run('build-dtach', { sources: partial })).toMatchObject({ ok: false, error: 'bad-sources' })
    expect(await missing.fix.run('build-dtach', { sources: { ...SOURCES, 'evil.sh': b64('x') } })).toMatchObject({ error: 'bad-sources' })
    expect(await missing.fix.run('build-dtach', { sources: { ...SOURCES, 'main.c': '$(rm -rf ~)' } })).toMatchObject({ error: 'bad-sources' })
    expect(missing.calls.filter((c) => c.file === '/usr/bin/cc')).toEqual([])

    const broken = fakeHost({
      bins: { cc: '/usr/bin/cc' },
      script: (file) => file === '/usr/bin/cc' ? { code: 1, stderr: 'master.c:12: fatal error: pty.h: No such file' } : { code: -1, errCode: 'ENOENT' },
    })
    const r = await broken.fix.run('build-dtach', { sources: SOURCES })
    expect(r).toMatchObject({ ok: false, error: 'build-failed' })
    expect(r.log).toContain('pty.h: No such file')
    expect(broken.renamed).toEqual([])
  })
})

// ── Guards ───────────────────────────────────────────────────────────────────

describe('guards', () => {
  it('runs only named actions', async () => {
    const h = fakeHost({})
    expect(await h.fix.run('rm -rf /')).toMatchObject({ ok: false, error: 'unknown-action' })
    expect(await h.fix.run(undefined)).toMatchObject({ ok: false, error: 'unknown-action' })
    expect(h.calls).toEqual([])
  })

  it('one fix at a time: a second request while one runs is refused as busy, and the next one after it runs', async () => {
    let release: (r: Reply) => void = () => {}
    const h = fakeHost({
      bins: { sudo: '/usr/bin/sudo', yum: '/usr/bin/yum' },
      script: () => new Promise<Reply>((resolve) => { release = resolve }),
    })
    const first = h.fix.run('install-compiler')
    await new Promise((r) => setTimeout(r, 10))
    expect(h.fix.running).toBe('install-compiler')
    expect(await h.fix.run('install-claude-native')).toMatchObject({ ok: false, error: 'busy' })
    h.bins.gcc = '/usr/bin/gcc'
    release({ code: 0 })
    expect(await first).toMatchObject({ ok: true })
    expect(h.fix.running).toBeNull()
    // Idempotent re-run: the compiler is there now, so nothing runs.
    expect(await h.fix.run('install-compiler')).toMatchObject({ ok: true, skipped: true })
  })

  it('keeps only the last 4KB of output', async () => {
    const h = fakeHost({
      bins: { sudo: '/usr/bin/sudo', yum: '/usr/bin/yum' },
      script: () => ({ code: 1, stdout: 'x'.repeat(10_000) + 'THE-END', stderr: '' }),
    })
    const r = await h.fix.run('install-compiler')
    expect(r.log.length).toBeLessThanOrEqual(4096)
    expect(r.log).toContain('THE-END')
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })
})

// ── The text the source twin runs ────────────────────────────────────────────

describe('injection into the source daemon twin', () => {
  const FORBIDDEN = [/\b__name\b/, /\b__publicField\b/, /\b__defProp\b/, /\b__spreadValues\b/, /\brequire\s*\(/, /\bimport\s*\(/, /\bexports\./, /\bmodule\.exports\b/]
  const root = path.resolve(__dirname, '../..')
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8')

  /** The text the source twin runs, made into a function again. */
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const rebuilt = <T,>(f: T): T => new Function('"use strict"; return ' + String(f))() as T

  it('every host.fix factory\'s toString() carries no module-scope or bundler identifiers, and re-materialized copies answer the same', async () => {
    const factories = { createHostFix, createClaudeInstall, createClaudeDownload, createDtachBuild }
    for (const [name, f] of Object.entries(factories)) {
      for (const re of FORBIDDEN) expect(f.toString(), `forbidden ${re} in ${name}`).not.toMatch(re)
    }
    const copies = { createHostFix: rebuilt(createHostFix), dtachBuild: rebuilt(createDtachBuild) }
    const compiler = async (factory: typeof createHostFix) => {
      const h = fakeHost({ bins: { sudo: '/usr/bin/sudo', 'apt-get': '/usr/bin/apt-get' }, script: () => ({ code: 1, stderr: 'sudo: a password is required\n' }) })
      const r = await factory(h.deps).run('install-compiler')
      return { ...r, durationMs: 0, calls: h.calls.map(cmdLine) }
    }
    expect(await compiler(copies.createHostFix)).toEqual(await compiler(createHostFix))
    const dtach = async (factory: typeof createHostFix, build: typeof createDtachBuild) => {
      const h = fakeHost({
        bins: { cc: '/usr/bin/cc' },
        script: (file) => (file === DTACH_BIN ? { code: -1, errCode: 'ENOENT' } : file.endsWith('.partial') ? { code: 0, stdout: DTACH_HELP } : { code: 0 }),
      })
      const r = await factory({ ...h.deps, now: () => 1_800_000_000_000, dtachBuild: build }).run('build-dtach', { sources: SOURCES })
      return { ...r, durationMs: 0, calls: h.calls.map(cmdLine), written: Object.keys(h.written).sort(), renamed: h.renamed }
    }
    const theirs = await dtach(copies.createHostFix, copies.dtachBuild)
    expect(theirs).toMatchObject({ ok: true, path: DTACH_BIN })
    expect(theirs).toEqual(await dtach(createHostFix, createDtachBuild))
  })

  it('re-materialized copies of the three factories run the resumable install the same: a cut-off line, a bad .zst, then the plain binary', async () => {
    const scenario = async (factory: typeof createHostFix, installer: typeof createClaudeInstall, download: typeof createClaudeDownload) => {
      const binary = binaryOf('2.1.317')
      const h = releaseHost({ zstd: true, line: { chunk: 700 }, releases: { '2.1.317': { binary, zst: zlib.gzipSync(binary), zstChecksum: 'e'.repeat(64) } } })
      const r = await factory({ ...h.deps, claudeInstall: installer, claudeDownload: download }).run('install-claude-native', ASKED)
      return { ...r, calls: h.calls.map(cmdLine), files: [...h.files.keys()].sort(), sleeps: h.sleeps }
    }
    const theirs = await scenario(rebuilt(createHostFix), rebuilt(createClaudeInstall), rebuilt(createClaudeDownload))
    expect(theirs).toMatchObject({ ok: true, claude: { version: '2.1.317' } })
    expect(theirs).toEqual(await scenario(createHostFix, createClaudeInstall, createClaudeDownload))
  })

  it('both twins register host.fix like host.preflight, the template carries no residue, and the capability is advertised', () => {
    for (const name of ['HOST_FIX', 'CLAUDE_INSTALL', 'CLAUDE_DOWNLOAD', 'DTACH_BUILD']) expect(getDaemonSource()).not.toContain(`__CREATE_${name}__`)
    const standalone = read('src/providers/daemon-standalone.ts')
    const template = read('src/providers/daemon-source.ts')
    expect(standalone).toMatch(/const hostFix = createHostFix\(\{[^}]*claudeInstall: createClaudeInstall, claudeDownload: createClaudeDownload, dtachBuild: createDtachBuild,/)
    expect(template).toMatch(/const hostFix = \(__CREATE_HOST_FIX__\)\(\{[^}]*claudeInstall: \(__CREATE_CLAUDE_INSTALL__\),\s*claudeDownload: \(__CREATE_CLAUDE_DOWNLOAD__\), dtachBuild: \(__CREATE_DTACH_BUILD__\),/)
    for (const [label, src] of [['standalone', standalone], ['template', template]] as const) {
      // stopDaemon and the handover calling hostFix.cancel() is pinned by running each
      // twin's own code: tests/providers/daemon-command-drain.test.ts.
      // Tracked like start/send: a shutdown drains it, and the fix that runs is kept as
      // hostFixWork (a handover skips it only when cancellable: the drain test runs that).
      expect(src, label).toMatch(/case 'host\.fix': \{\s*(\/\/[^\n]*\n\s*)?const starts = !hostFix\.running;?\s*const work = daemonCommands\.run\((\(\) => |function \(\) \{\s*return )hostFix\.run\(cmd\.action, cmd\)[\s\S]{0,300}?if \(starts\) hostFixWork = work;?\s*return work;?\s*\}/)
      // The result rides under `result`, so its own `ok:false` never reads as an RPC error.
      expect(src, label).toMatch(/sendOk\(ws, id( as number)?, \{ result: r \}\)/)
      // The preflight must report the platform the fix planner reads.
      expect(src, label).toMatch(/platform: process\.platform/)
      const start = src.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
      expect(src.slice(start, src.indexOf('])', start)), label).not.toContain('host.fix')
    }
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('hostfix-v1')
    // Imported by the binary, inlined into the source twin: it must move the daemon version.
    for (const file of ['host-fix-core', 'claude-install-core', 'claude-download-core', 'dtach-build-core']) {
      expect(read('scripts/build-daemon.sh')).toMatch(new RegExp(`^\\s*src/providers/${file}\\.ts$`, 'm'))
      expect(read('src/providers/daemon-version-check.ts')).toContain(`'src/providers/${file}.ts'`)
    }
  })

  it('a fix in flight as the twins track it (admit + run) lets a handover pause and drain; admit alone refused it', async () => {
    // The twins dispatch every command through admit(); host.fix then wraps its
    // work in run() like start/send. This is the drain's side of that contract.
    const drain = createDaemonCommandDrain()
    let finish: () => void = () => {}
    const fix = new Promise<void>((resolve) => { finish = resolve })
    void drain.admit(() => drain.run(() => fix))
    const pause = drain.pause()
    let drained = false
    void pause.drained.then(() => { drained = true })
    await new Promise((r) => setTimeout(r, 5))
    expect(drained).toBe(false)
    finish()
    await pause.drained
    expect(drained).toBe(true)
    pause.resume()

    const legacy = createDaemonCommandDrain()
    void legacy.admit(() => new Promise<void>(() => {}))
    expect(() => legacy.pause()).toThrow(/active operations/)
  })

  it('the deploy-time smoke test refuses a corrupted host-fix text', () => {
    // validateFoldInjection always smoke-folds the trio, so every call carries it.
    const fold: Array<[string, string]> = [
      ['__FOLD_LINE__', foldLine.toString()],
      ['__INITIAL_FOLD_STATE__', initialFoldState.toString()],
      ['__ASSEMBLE_SNAPSHOT__', assembleSnapshot.toString()],
    ]
    const good: Array<[string, string]> = [
      ['__CREATE_HOST_RUNTIME__', createHostRuntime.toString()], ['__CREATE_HOST_FIX__', createHostFix.toString()],
      ['__CREATE_CLAUDE_INSTALL__', createClaudeInstall.toString()], ['__CREATE_CLAUDE_DOWNLOAD__', createClaudeDownload.toString()],
      ['__CREATE_DTACH_BUILD__', createDtachBuild.toString()],
    ]
    expect(() => validateFoldInjection(fold.concat(good))).not.toThrow()
    // The installer's manifest reader (its download half): a checksum rule changed in the text is refused.
    expect(createClaudeDownload.toString()).toContain('{64}')
    const badDownload: Array<[string, string]> = [['__CREATE_CLAUDE_DOWNLOAD__', createClaudeDownload.toString().replace('{64}', '{65}')]]
    expect(() => validateFoldInjection(fold.concat(badDownload))).toThrow(/misread a manifest/)
    // A text that no longer builds a function is refused before it ships.
    const notCode: Array<[string, string]> = [['__CREATE_DTACH_BUILD__', createDtachBuild.toString().replace('function', 'function (')]]
    expect(() => validateFoldInjection(fold.concat(notCode))).toThrow()
    // The transpiled text may quote either way.
    const MUSL = /(["'])musl-dev\1/
    expect(createHostFix.toString()).toMatch(MUSL)
    const broken: Array<[string, string]> = [['__CREATE_HOST_FIX__', createHostFix.toString().replace(MUSL, '"musl"')]]
    expect(() => validateFoldInjection(fold.concat(broken))).toThrow(/wrong apk argv/)
  })
})

// ── A test server's isolated daemon (WALNUT_INSTALL_HOME, src/providers/remote-isolation.ts) ──

describe('host fixes of a test server\'s isolated daemon install under its own HOME', () => {
  const OWN = '/tmp/open-walnut-test-0123456789abcdef/home'
  const OWN_BIN = `${OWN}/.local/bin/claude`
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const rebuilt = <T,>(f: T): T => new Function('"use strict"; return ' + String(f))() as T

  function isolatedHost() {
    const h = fakeHost({
      bins: { curl: '/usr/bin/curl', bash: '/bin/bash', sudo: '/usr/bin/sudo', 'apt-get': '/usr/bin/apt-get' },
      script: (file) => {
        if (file === '/bin/bash') h.claude[OWN_BIN] = { ...NATIVE, path: OWN_BIN }
        if (file === OWN_BIN) return { code: 0, stdout: '2.1.280 (Claude Code)\n' }
        return { code: 0 }
      },
    })
    Object.assign(h.deps.env, {
      WALNUT_INSTALL_HOME: OWN,
      CLAUDE_CONFIG_DIR: `${HOME}/.claude`, XDG_DATA_HOME: `${HOME}/.local/share`, XDG_CONFIG_HOME: `${HOME}/.config`, BUN_INSTALL: `${HOME}/.bun`,
    })
    return h
  }

  for (const [label, factory] of [['module', createHostFix], ['re-materialized (the source twin)', rebuilt(createHostFix)]] as const) {
    it(`${label}: the installer runs with HOME = the isolated home and none of the real home's install dirs`, async () => {
      const h = isolatedHost()
      const r = await factory(h.deps).run('install-claude-native')
      const inst = nonProbe(h.calls).find((c) => c.file === '/bin/bash')!
      expect(inst.env.HOME).toBe(OWN)
      expect(inst.cwd).toBe(OWN)
      for (const k of ['CLAUDE_CONFIG_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'BUN_INSTALL']) expect(inst.env[k], k).toBeUndefined()
      expect(String(inst.env.PATH ?? '')).not.toContain(`${HOME}/.local/bin`)
      for (const c of nonProbe(h.calls)) {
        for (const a of [c.file, ...c.args, String(c.cwd ?? '')]) expect(a.startsWith(`${HOME}/`), a).toBe(false)
      }
      expect(r).toMatchObject({ ok: true, claude: { path: OWN_BIN } })
      // The real home's env object is untouched.
      expect(h.deps.env.HOME).toBe(HOME)
    })

    it(`${label}: never installs a compiler system-wide`, async () => {
      const h = isolatedHost()
      const r = await factory(h.deps).run('install-compiler')
      expect(r).toMatchObject({ ok: false, error: 'isolated' })
      expect(nonProbe(h.calls)).toEqual([])
    })
  }
})
