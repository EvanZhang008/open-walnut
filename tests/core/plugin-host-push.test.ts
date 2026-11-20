/**
 * `walnut.hosts.push` (src/core/plugins/plugin-host-push.ts): a plugin puts one file onto a host
 * through Walnut's link to its daemon. The source is only ever the plugin's own data dir (a `..`,
 * an absolute path elsewhere, a link leading out: refused before anything is sent); the target
 * never credentials, Walnut's own data, a folder, or a place macOS guards (as text, and as the
 * host resolves it); the file lands whole, with its mode, checked by sha256, or not at all; a host
 * Walnut cannot reach fails at once.
 *
 * Real: the push, the part writer (writeFileInParts), each receiver's fs.writePart core
 * (tests/helpers/fake-copy-host.ts) and every script, run by sh on this machine with HOME set to
 * the fake host's home. Fake: only the link to each host.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { fakeCopyHost, type FakeCopyHost } from '../helpers/fake-copy-host.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-push'))
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({ hosts: Object.fromEntries(['linuxbox', 'macbox', 'newmac', 'slowbox', 'winbox', 'gone'].map((h) => [h, { hostname: `${h}.example.test` }])) })),
}))
const hosts = vi.hoisted(() => ({} as Record<string, { home: string; offline?: boolean; delayMs?: number; binDir?: string }>))
const scripts = vi.hoisted(() => [] as Array<{ host: string; args: string[] }>)
// A host's script runs here, by sh, in that host's home: what the daemon's exec.script does there.
vi.mock('../../src/core/hosts/host-script.js', async () => {
  const { runBoundedScript } = await import('../../src/providers/host-script-core.js')
  const { HostExecError } = await import('../../src/core/hosts/host-exec-target.js')
  return {
    runScriptOnHost: vi.fn(async (host: string, input: { script: string; args: string[]; timeoutMs: number; maxOutputBytes: number }) => {
      scripts.push({ host, args: input.args })
      const h = hosts[host]
      if (!h || h.offline) throw new HostExecError(`Walnut cannot reach ${host} right now (dial timeout).`, 503, 'host_offline')
      if (h.delayMs) await new Promise((r) => setTimeout(r, h.delayMs))
      // binDir: that host's own commands first (a uname that says Darwin, for a Mac).
      const PATH = `${h.binDir ? `${h.binDir}:` : ''}${process.env.PATH ?? '/usr/bin:/bin'}`
      return runBoundedScript({ spawn, command: 'sh', argv: ['-s', '--', ...input.args], env: { PATH, HOME: h.home } }, input)
    }),
  }
})

import { __setTransferConnectionResolverForTesting } from '../../src/core/transfer/daemon-transfer-client.js'
import { recordProbedFacts } from '../../src/core/hosts/host-profile.js'
import { pushToPluginHost, MAX_PUSH_BYTES } from '../../src/core/plugins/plugin-host-push.js'

let root: string
let dataDir: string
const fakes: Record<string, FakeCopyHost> = {}
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const writes = (host: string) => fakes[host].sent.filter((s) => s.cmd === 'fs.writePart')
const modeOf = (p: string) => fs.statSync(p).mode & 0o777
/** Hidden staging files left in a folder. */
const leftovers = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith('.walnut-push-')) : [])

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-push-')))
  dataDir = path.join(root, 'plugin-data', 'relay')
  fs.mkdirSync(dataDir, { recursive: true })
  for (const h of ['linuxbox', 'macbox', 'newmac', 'slowbox', 'winbox', 'gone']) {
    fakes[h] = fakeCopyHost(path.join(root, h))
    hosts[h] = { home: fakes[h].home }
  }
  hosts.gone.offline = true
  // A Mac Walnut never profiled: only its own uname says what it is.
  const macBin = path.join(root, 'newmac-bin')
  fs.mkdirSync(macBin)
  fs.writeFileSync(path.join(macBin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 })
  hosts.newmac.binDir = macBin
  await recordProbedFacts('winbox', { os: { platform: 'win32', release: '10' }, arch: 'x64', cpus: 8, memBytes: 1, home: 'C:/Users/me', proxyEnv: {}, cloud: null, internet: null, tools: {} } as never)
  __setTransferConnectionResolverForTesting(async (h) => (fakes[h] && !hosts[h]?.offline ? [fakes[h].conn] : []))
  await recordProbedFacts('macbox', { os: { platform: 'darwin', release: '24.0.0' }, arch: 'arm64', cpus: 8, memBytes: 1, home: fakes.macbox.home, proxyEnv: {}, cloud: null, internet: null, tools: {} } as never)
})

afterAll(() => {
  __setTransferConnectionResolverForTesting(null)
  if (root?.includes('walnut-host-push-')) fs.rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  for (const h of Object.values(fakes)) { h.sent.length = 0; h.knobs.corrupt = false }
  scripts.length = 0
})

describe('hosts.push lands the file whole, with its mode', () => {
  it('a program from the data dir: mode 0755, sha256 matches, then replaced in one step', async () => {
    const bin = crypto.randomBytes(300_000)
    fs.writeFileSync(path.join(dataDir, 'coderelay-linux-amd64'), bin)
    const r = await pushToPluginHost('relay', dataDir, 'linuxbox', { file: 'coderelay-linux-amd64', to: '~/.local/bin/coderelay', mode: 0o755 })
    const landed = path.join(fakes.linuxbox.home, '.local/bin/coderelay')
    expect(r).toEqual({ path: landed, bytes: bin.length, sha256: sha(bin), mode: 0o755, replaced: false })
    expect(fs.readFileSync(landed).equals(bin)).toBe(true)
    expect(modeOf(landed)).toBe(0o755)
    expect(leftovers(path.dirname(landed))).toEqual([])
    // Every part went to a hidden staging name, never to the target itself.
    expect(writes('linuxbox').length).toBeGreaterThan(0)
    expect(writes('linuxbox').every((w) => String(w.params.path).includes('/.walnut-push-'))).toBe(true)
    expect(writes('linuxbox').at(-1)?.params).toMatchObject({ final: true, sha256: sha(bin), size: bin.length })

    // A new version over it (an absolute path inside the data dir works too).
    const v2 = crypto.randomBytes(5_000)
    fs.writeFileSync(path.join(dataDir, 'v2'), v2)
    const r2 = await pushToPluginHost('relay', dataDir, 'linuxbox', { file: path.join(dataDir, 'v2'), to: landed, mode: 0o750 })
    expect(r2).toMatchObject({ replaced: true, bytes: v2.length, sha256: sha(v2), mode: 0o750 })
    expect(fs.readFileSync(landed).equals(v2)).toBe(true)
    expect(modeOf(landed)).toBe(0o750)
    expect(leftovers(path.dirname(landed))).toEqual([])
  })

  it('bytes instead of a file; mode 0644 by default; an empty file; this machine (__local__) too', async () => {
    const text = Buffer.from('{"hub":"127.0.0.1:18403"}\n')
    const r = await pushToPluginHost('relay', dataDir, 'linuxbox', { bytes: new Uint8Array(text), to: '~/cfg/coderelay.json' })
    expect(r).toMatchObject({ mode: 0o644, bytes: text.length, sha256: sha(text) })
    expect(modeOf(r.path)).toBe(0o644)
    const empty = await pushToPluginHost('relay', dataDir, 'linuxbox', { bytes: new Uint8Array(0), to: '~/cfg/empty' })
    expect(fs.statSync(empty.path).size).toBe(0)

    // This machine: its own daemon and its own sh; an absolute path (a temp dir here).
    fakes.__local__ = fakeCopyHost(path.join(root, 'local-daemon-home'))
    const target = path.join(root, 'local-target', 'nested', 'tool')
    const local = await pushToPluginHost('relay', dataDir, '__local__', { bytes: new Uint8Array(text), to: target, mode: 0o700 })
    expect(local).toMatchObject({ path: target, replaced: false, mode: 0o700 })
    expect(modeOf(target)).toBe(0o700)
    expect(fs.readFileSync(target, 'utf8')).toBe(text.toString())
    delete fakes.__local__
  })

  it('a corrupted part fails the sha256 check: the target stays as it was and the staging file goes', async () => {
    const landed = path.join(fakes.linuxbox.home, 'bin/stable')
    fs.mkdirSync(path.dirname(landed), { recursive: true })
    fs.writeFileSync(landed, 'old')
    fakes.linuxbox.knobs.corrupt = true
    await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { bytes: new Uint8Array(crypto.randomBytes(1000)), to: '~/bin/stable', mode: 0o755 }))
      .rejects.toMatchObject({ code: 'checksum_mismatch' })
    expect(fs.readFileSync(landed, 'utf8')).toBe('old')
    expect(leftovers(path.dirname(landed))).toEqual([])
    expect(fs.readdirSync(path.dirname(landed)).filter((n) => n.endsWith('.walnut-part'))).toEqual([])
  })
})

describe('hosts.push sends only the plugin\'s own data', () => {
  it('refuses .., an absolute path elsewhere, a link leading out, a folder, a missing file: before any byte goes', async () => {
    const secret = path.join(root, 'secret.txt')
    fs.writeFileSync(secret, 'not the plugin\'s')
    fs.symlinkSync(secret, path.join(dataDir, 'link-out'))
    fs.mkdirSync(path.join(dataDir, 'sub', 'deeper'), { recursive: true })
    fs.symlinkSync(root, path.join(dataDir, 'sub', 'dir-out'))
    const to = '~/x'
    await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { file: '../../secret.txt', to })).rejects.toMatchObject({ code: 'outside_data_dir' })
    await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { file: 'sub/../../../secret.txt', to })).rejects.toMatchObject({ code: 'outside_data_dir' })
    await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { file: secret, to })).rejects.toMatchObject({ code: 'outside_data_dir' })
    await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { file: 'link-out', to })).rejects.toMatchObject({ code: 'outside_data_dir' })
    await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { file: 'sub/dir-out/secret.txt', to })).rejects.toMatchObject({ code: 'outside_data_dir' })
    // A sibling whose name starts like the data dir is not inside it.
    fs.mkdirSync(`${dataDir}-evil`, { recursive: true })
    fs.writeFileSync(`${dataDir}-evil/x`, 'x')
    await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { file: `${dataDir}-evil/x`, to })).rejects.toMatchObject({ code: 'outside_data_dir' })
    await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { file: 'sub', to })).rejects.toMatchObject({ code: 'not_a_file' })
    await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { file: 'nope', to })).rejects.toMatchObject({ code: 'source_missing' })
    await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { to } as never)).rejects.toMatchObject({ code: 'bad_request' })
    await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { file: 'a', bytes: new Uint8Array(1), to })).rejects.toMatchObject({ code: 'bad_request' })
    expect(writes('linuxbox')).toEqual([])
    expect(fs.existsSync(path.join(fakes.linuxbox.home, 'x'))).toBe(false)
  })

  it('refuses a file over 256 MB before reading it, and a bad mode', async () => {
    const big = path.join(dataDir, 'big.bin')
    const fd = fs.openSync(big, 'w')
    fs.ftruncateSync(fd, MAX_PUSH_BYTES + 1) // sparse: no disk used
    fs.closeSync(fd)
    await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { file: 'big.bin', to: '~/big' })).rejects.toMatchObject({ code: 'too_large' })
    fs.rmSync(big)
    for (const mode of [0o4755, -1, 1.5, 0o1000]) {
      await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { bytes: new Uint8Array(1), to: '~/m', mode })).rejects.toMatchObject({ code: 'bad_request' })
    }
    expect(writes('linuxbox')).toEqual([])
  })
})

describe('hosts.push never writes where host_copy never does', () => {
  it('credentials, Walnut\'s own data and the host\'s hub forwards file, as text: no script runs, no byte goes', async () => {
    for (const to of ['~/.ssh/authorized_keys', '~/.SSH/authorized_keys', '~/.Open-Walnut/config.yaml', '~/.local/State/open-walnut/net/hub-forwards.json', '~/walnut-daemon/net/hub-forwards.json', '~/.aws/credentials', '~/.gnupg/x', '~/.open-walnut/config.yaml', '~/.local/state/open-walnut/net/hub-forwards.json', '~/a/auth.json', '/etc/../root/.ssh/x']) {
      const err = await pushToPluginHost('relay', dataDir, 'linuxbox', { bytes: new Uint8Array(1), to }).catch((e) => e)
      expect(err.code === 'protected_path' || err.code === 'bad_request', `${to}: ${err.code}`).toBe(true)
    }
    for (const to of ['relative/path', '~', '~/dir/', '/a\nb']) {
      await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { bytes: new Uint8Array(1), to })).rejects.toMatchObject({ code: 'bad_request' })
    }
    expect(scripts).toEqual([])
    expect(writes('linuxbox')).toEqual([])
  })

  it('a folder on the way that is a link into ~/.ssh is refused as the host resolves it', async () => {
    fs.mkdirSync(path.join(fakes.linuxbox.home, '.ssh'), { recursive: true })
    fs.symlinkSync(path.join(fakes.linuxbox.home, '.ssh'), path.join(fakes.linuxbox.home, 'innocent'))
    await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { bytes: new Uint8Array(1), to: '~/innocent/authorized_keys' })).rejects.toMatchObject({ code: 'protected_path' })
    expect(writes('linuxbox')).toEqual([])
    expect(fs.readdirSync(path.join(fakes.linuxbox.home, '.ssh'))).toEqual([])
  })

  it('a folder at the target, or a file on the way, is refused; the folder is left as it was', async () => {
    fs.mkdirSync(path.join(fakes.linuxbox.home, 'adir'), { recursive: true })
    fs.writeFileSync(path.join(fakes.linuxbox.home, 'adir', 'keep'), 'k')
    await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { bytes: new Uint8Array(1), to: '~/adir' })).rejects.toMatchObject({ code: 'is_directory' })
    expect(fs.readdirSync(path.join(fakes.linuxbox.home, 'adir'))).toEqual(['keep'])
    expect(leftovers(fakes.linuxbox.home)).toEqual([])
    fs.writeFileSync(path.join(fakes.linuxbox.home, 'afile'), 'x')
    fakes.linuxbox.sent.length = 0
    await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { bytes: new Uint8Array(1), to: '~/afile/below' })).rejects.toMatchObject({ code: 'target_unusable' })
    expect(writes('linuxbox')).toEqual([])
  })

  it('a link at the target is replaced by the file, never followed', async () => {
    const real = path.join(fakes.linuxbox.home, 'realfile')
    fs.writeFileSync(real, 'untouched')
    fs.symlinkSync(real, path.join(fakes.linuxbox.home, 'linkt'))
    const r = await pushToPluginHost('relay', dataDir, 'linuxbox', { bytes: new Uint8Array(Buffer.from('new')), to: '~/linkt', mode: 0o755 })
    expect(r.replaced).toBe(true)
    expect(fs.lstatSync(path.join(fakes.linuxbox.home, 'linkt')).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(fakes.linuxbox.home, 'linkt'), 'utf8')).toBe('new')
    expect(fs.readFileSync(real, 'utf8')).toBe('untouched')
  })

  it('a Mac Walnut never profiled says so itself: a guarded place is refused before any byte goes', async () => {
    await expect(pushToPluginHost('relay', dataDir, 'newmac', { bytes: new Uint8Array(1), to: '~/Documents/tool' })).rejects.toMatchObject({ code: 'may_prompt' })
    fs.mkdirSync(path.join(fakes.newmac.home, 'Downloads'), { recursive: true })
    fs.symlinkSync(path.join(fakes.newmac.home, 'Downloads'), path.join(fakes.newmac.home, 'innocent'))
    await expect(pushToPluginHost('relay', dataDir, 'newmac', { bytes: new Uint8Array(1), to: '~/innocent/tool' })).rejects.toMatchObject({ code: 'may_prompt' })
    expect(writes('newmac')).toEqual([])
    expect(fs.readdirSync(path.join(fakes.newmac.home, 'Downloads'))).toEqual([])
  })

  it('a Windows host is refused: the push runs sh scripts there', async () => {
    await expect(pushToPluginHost('relay', dataDir, 'winbox', { bytes: new Uint8Array(1), to: '~/x' })).rejects.toMatchObject({ code: 'unsupported_platform' })
    expect(writes('winbox')).toEqual([])
  })

  it('on a Mac, a place macOS guards (Documents, Downloads, ...) is refused; another folder is fine', async () => {
    for (const to of ['~/Documents/tool', '~/Downloads/x', '~/desktop/x', `${fakes.macbox.home}/Library/Mail/x`]) {
      await expect(pushToPluginHost('relay', dataDir, 'macbox', { bytes: new Uint8Array(1), to }), to).rejects.toMatchObject({ code: 'may_prompt' })
    }
    expect(writes('macbox')).toEqual([])
    const ok = await pushToPluginHost('relay', dataDir, 'macbox', { bytes: new Uint8Array([1, 2]), to: '~/.local/bin/coderelay', mode: 0o755 })
    expect(modeOf(ok.path)).toBe(0o755)
  })
})

describe('hosts.push and a host Walnut cannot reach', () => {
  it('a host not linked fails at once with host_offline, nothing written; an unknown host throws', async () => {
    const t0 = Date.now()
    await expect(pushToPluginHost('relay', dataDir, 'gone', { bytes: new Uint8Array(10), to: '~/x' })).rejects.toMatchObject({ code: 'host_offline' })
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(writes('gone')).toEqual([])
    await expect(pushToPluginHost('relay', dataDir, 'nobody', { bytes: new Uint8Array(1), to: '~/x' })).rejects.toMatchObject({ code: 'unknown_host' })
  })

  it('a link that drops between the check and the bytes fails fast and names nothing written', async () => {
    // The script reaches the host, the part writer finds no link (it went away).
    __setTransferConnectionResolverForTesting(async () => [])
    try {
      const t0 = Date.now()
      const err = await pushToPluginHost('relay', dataDir, 'linuxbox', { bytes: new Uint8Array(10), to: '~/dropped' }).catch((e) => e)
      expect(err.code).toBe('host_offline')
      expect(Date.now() - t0).toBeLessThan(5_000)
      expect(fs.existsSync(path.join(fakes.linuxbox.home, 'dropped'))).toBe(false)
      expect(leftovers(fakes.linuxbox.home)).toEqual([])
    } finally {
      __setTransferConnectionResolverForTesting(async (h) => (fakes[h] && !hosts[h]?.offline ? [fakes[h].conn] : []))
    }
  })

  it('a stopped plugin\'s push writes nothing more', async () => {
    const stop = new AbortController()
    stop.abort(new Error('plugin stopped'))
    await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { bytes: new Uint8Array(10), to: '~/stopped' }, stop.signal)).rejects.toMatchObject({ code: 'push_stopped' })
    expect(fs.existsSync(path.join(fakes.linuxbox.home, 'stopped'))).toBe(false)
    expect(leftovers(fakes.linuxbox.home)).toEqual([])
  })
})

describe('hosts.push bounds', () => {
  it('at most two pushes of a plugin at once; another plugin is not held up', async () => {
    hosts.slowbox.delayMs = 800
    try {
      const a = pushToPluginHost('relay', dataDir, 'slowbox', { bytes: new Uint8Array(1), to: '~/a' })
      const b = pushToPluginHost('relay', dataDir, 'slowbox', { bytes: new Uint8Array(1), to: '~/b' })
      for (let i = 0; i < 200 && scripts.filter((x) => x.host === 'slowbox').length < 2; i++) await new Promise((r) => setTimeout(r, 10))
      await expect(pushToPluginHost('relay', dataDir, 'slowbox', { bytes: new Uint8Array(1), to: '~/c' })).rejects.toMatchObject({ code: 'busy' })
      const other = pushToPluginHost('another', dataDir, 'slowbox', { bytes: new Uint8Array(1), to: '~/d' })
      await Promise.all([a, b, other])
      // Once they ended there is room again.
      await pushToPluginHost('relay', dataDir, 'slowbox', { bytes: new Uint8Array(1), to: '~/c' })
      expect(['a', 'b', 'c', 'd'].every((n) => fs.existsSync(path.join(fakes.slowbox.home, n)))).toBe(true)
    } finally {
      hosts.slowbox.delayMs = 0
    }
  }, 20_000)

  it('a push past its timeoutMs stops with push_deadline and writes nothing', async () => {
    hosts.slowbox.delayMs = 1_500
    try {
      await expect(pushToPluginHost('relay', dataDir, 'slowbox', { bytes: new Uint8Array(10), to: '~/late', timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'push_deadline' })
      expect(fs.existsSync(path.join(fakes.slowbox.home, 'late'))).toBe(false)
      expect(leftovers(fakes.slowbox.home)).toEqual([])
    } finally {
      hosts.slowbox.delayMs = 0
    }
  }, 20_000)

  it('a source that changes while it is sent fails the sha256 check: nothing lands', async () => {
    const src = path.join(dataDir, 'changing.bin')
    fs.writeFileSync(src, crypto.randomBytes(9 * 1024 * 1024))
    let changed = false
    fakes.linuxbox.knobs.hangs = (cmd) => {
      if (cmd === 'fs.writePart' && !changed) {
        changed = true
        // The same file (same inode), other bytes near its end: what is read later differs from what was hashed.
        const fd = fs.openSync(src, 'r+')
        fs.writeSync(fd, Buffer.alloc(1024, 7), 0, 1024, 9 * 1024 * 1024 - 2048)
        fs.closeSync(fd)
      }
      return false
    }
    try {
      await expect(pushToPluginHost('relay', dataDir, 'linuxbox', { file: 'changing.bin', to: '~/changing' })).rejects.toMatchObject({ code: 'checksum_mismatch' })
      expect(changed).toBe(true)
      expect(fs.existsSync(path.join(fakes.linuxbox.home, 'changing'))).toBe(false)
      expect(leftovers(fakes.linuxbox.home)).toEqual([])
    } finally {
      fakes.linuxbox.knobs.hangs = undefined
    }
  }, 20_000)
})
