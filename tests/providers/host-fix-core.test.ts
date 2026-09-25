/**
 * Host fixes (src/providers/host-fix-core.ts): the daemon half of `host.fix`.
 *
 * Only the host is faked: execFile answers from a script (nothing is installed,
 * no network), the fs records writes, and the runtime resolves commands from a
 * map. The real argv construction, sudo classification, idempotency and the
 * one-fix-at-a-time guard all run. The factory is also re-materialized from its
 * toString(), because that text is what the source-deployed daemon twin runs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { createHostFix, type HostFixDeps } from '../../src/providers/host-fix-core.js'
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

// ── update-claude ────────────────────────────────────────────────────────────

describe('update-claude', () => {
  const VERSIONS = `${HOME}/.local/share/claude/versions`
  /** A native-installer host whose `claude update` moves ~/.local/bin/claude from `from` to `to`. */
  function nativeHost(opts: { from?: string; to?: string; updateCode?: number; updateOut?: string; env?: Record<string, string>; realpath?: string } = {}) {
    let version = opts.from ?? '2.1.258'
    const h = fakeHost({
      bins: { claude: BIN, curl: '/usr/bin/curl', bash: '/bin/bash' },
      claude: { [BIN]: { ...NATIVE, path: BIN } },
      script: (file, args) => {
        if (file === BIN && args[0] === '--version') return { code: 0, stdout: `${version} (Claude Code)\n` }
        if (file === BIN && args[0] === 'update') {
          if ((opts.updateCode ?? 0) === 0) version = opts.to ?? '2.1.280'
          return { code: opts.updateCode ?? 0, stdout: opts.updateOut ?? `Current version: 2.1.258\nSuccessfully updated from 2.1.258 to ${opts.to ?? '2.1.280'}\n` }
        }
        if (file === '/bin/bash') { version = opts.to ?? '2.1.280'; return { code: 0 } }
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

  it('createHostFix.toString() carries no module-scope or bundler identifiers, and a re-materialized copy answers the same', async () => {
    const src = createHostFix.toString()
    for (const re of FORBIDDEN) expect(src, `forbidden ${re}`).not.toMatch(re)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const copy = new Function('"use strict"; return ' + src)() as typeof createHostFix
    const scenario = async (factory: typeof createHostFix) => {
      const h = fakeHost({ bins: { sudo: '/usr/bin/sudo', 'apt-get': '/usr/bin/apt-get' }, script: () => ({ code: 1, stderr: 'sudo: a password is required\n' }) })
      const r = await factory(h.deps).run('install-compiler')
      return { ...r, durationMs: 0, calls: h.calls.map(cmdLine) }
    }
    expect(await scenario(copy)).toEqual(await scenario(createHostFix))
  })

  it('both twins register host.fix like host.preflight, the template carries no residue, and the capability is advertised', () => {
    expect(getDaemonSource()).not.toContain('__CREATE_HOST_FIX__')
    const standalone = read('src/providers/daemon-standalone.ts')
    const template = read('src/providers/daemon-source.ts')
    expect(standalone).toMatch(/const hostFix = createHostFix\(\{/)
    expect(template).toMatch(/const hostFix = \(__CREATE_HOST_FIX__\)\(\{/)
    for (const [label, src] of [['standalone', standalone], ['template', template]] as const) {
      // Tracked like start/send: a handover pause waits for it, a shutdown drains it.
      expect(src, label).toMatch(/case 'host\.fix':\s*return daemonCommands\.run\((\(\) => |function \(\) \{\s*return )hostFix\.run\(cmd\.action, cmd\)/)
      // The result rides under `result`, so its own `ok:false` never reads as an RPC error.
      expect(src, label).toMatch(/sendOk\(ws, id( as number)?, \{ result: r \}\)/)
      // The preflight must report the platform the fix planner reads.
      expect(src, label).toMatch(/platform: process\.platform/)
      const start = src.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
      expect(src.slice(start, src.indexOf('])', start)), label).not.toContain('host.fix')
    }
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('hostfix-v1')
    // Imported by the binary, inlined into the source twin: it must move the daemon version.
    expect(read('scripts/build-daemon.sh')).toMatch(/^\s*src\/providers\/host-fix-core\.ts$/m)
    expect(read('src/providers/daemon-version-check.ts')).toContain("'src/providers/host-fix-core.ts'")
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
    const good: Array<[string, string]> = [['__CREATE_HOST_RUNTIME__', createHostRuntime.toString()], ['__CREATE_HOST_FIX__', createHostFix.toString()]]
    expect(() => validateFoldInjection(fold.concat(good))).not.toThrow()
    // The transpiled text may quote either way.
    const MUSL = /(["'])musl-dev\1/
    expect(createHostFix.toString()).toMatch(MUSL)
    const broken: Array<[string, string]> = [['__CREATE_HOST_FIX__', createHostFix.toString().replace(MUSL, '"musl"')]]
    expect(() => validateFoldInjection(fold.concat(broken))).toThrow(/wrong apk argv/)
  })
})
