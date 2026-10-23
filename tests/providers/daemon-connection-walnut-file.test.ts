/**
 * A compiled Mac's daemon deploy (DaemonConnection.deployWalnutFile): the
 * compiled file carries no separate daemon binaries, so a host where no bun runs
 * gets the host's own walnut file in the binary's slot and runs it as
 * `--start` (src/binary/main.ts); before this, such a host fell to node and,
 * without Node, got no daemon at all.
 *
 * SSH is stubbed at sshExec (each route answers the way the real script does:
 * the scripts themselves run for real in daemon-file-slot.test.ts), uploadFile
 * is stubbed, and the shared host file source is a fake: no process, socket or
 * upload is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const files = vi.hoisted(() => ({
  asks: [] as string[],
  fail: null as Error | null,
}))
vi.mock('../../src/core/host-server/index.js', () => ({
  hostServerRootSpec: () => undefined,
  sharedHostFileSource: () => ({
    buildId: async () => ({ id: '0.6.99-abc1234', version: '0.6.99', commit: 'abc1234' }),
    file: async (target: string) => {
      files.asks.push(target)
      if (files.fail) throw files.fail
      return { id: '0.6.99-abc1234', version: '0.6.99', commit: 'abc1234', target, gz: Buffer.alloc(1024), sha256: 'a'.repeat(64), gzSha256: 'b'.repeat(64) }
    },
  }),
}))

import { DaemonConnection, remoteServiceProbePaths } from '../../src/providers/daemon-connection.js'
import { setSingleFile } from '../../src/lib/single-file.js'

type Priv = Record<string, (...args: unknown[]) => unknown>
const priv = (conn: DaemonConnection) => conn as unknown as Priv

const BUN_MISSING = 'bun_path=MISSING'
const BUN_OK = 'bun_path=/home/me/.bun/bin/bun\nbun_rc=0\nbun_out=1.1.30'
const STARTED = '32100\n{"running":true}'
const NO_SERVICE = [...new Set([...remoteServiceProbePaths('/tmp/open-walnut'), ...remoteServiceProbePaths('/home/me/.cache/open-walnut')])]
  .map((p) => `absent ${p}`).concat('walnut-service-probe-done').join('\n')
const LINUX_ARM = 'os=Linux\narch=aarch64\nlibc=glibc\ntranslated=0\nglibc=2.36\nbits=64\nloader= /lib/ld-linux-aarch64.so.1\n'

interface Routes {
  bun?: string[]
  /** What the slot check finds on the host. */
  slot?: 'have' | 'copied' | 'none'
  system?: string
  start: Partial<Record<'bun' | 'binary' | 'node', string>>
  startLog?: Partial<Record<'bun' | 'binary' | 'node', string>>
}

function runtimeOf(cmd: string): 'bun' | 'binary' | 'node' {
  if (/daemon-linux-\w+'? --start/.test(cmd)) return 'binary'
  if (/\/bun'? \S*daemon\.cjs'? --start/.test(cmd)) return 'bun'
  return 'node'
}

function setup(routes: Routes) {
  const conn = new DaemonConnection('devbox', { hostname: 'devbox.example.test', user: 'me' })
  const seen: string[] = []
  const starts: string[] = []
  const deploys: string[] = []
  const uploads: Array<{ path: string; sha256?: string }> = []
  const bunReplies = [...(routes.bun ?? [BUN_MISSING])]
  let lastStarted: 'bun' | 'binary' | 'node' = 'bun'
  vi.spyOn(priv(conn), 'sshExec').mockImplementation(async (...args: unknown[]) => {
    const cmd = String(args[0])
    seen.push(cmd)
    if (cmd.includes('walnut-dir-probe v1')) return ''
    if (cmd.includes('walnut-live none')) return 'walnut-live none'
    if (cmd.includes('walnut-service-probe-done')) return NO_SERVICE
    if (cmd.includes('bun_path=')) return bunReplies.length > 1 ? bunReplies.shift()! : bunReplies[0]
    // No curl on the host: the bun install fails.
    if (cmd.includes('install_rc=')) return 'install_rc=127\ninstall_log=/tmp/open-walnut/bun-install.log\ninstall_tail_begin\nno curl or wget\ninstall_tail_end'
    if (cmd.includes('s=$(uname -s')) return routes.system ?? LINUX_ARM
    if (cmd === 'printf %s "$HOME"') return '/home/me'
    if (cmd.includes('echo slot=none')) return `slot=${routes.slot ?? 'none'}`
    if (cmd.includes('echo slot=installed')) return 'slot=installed'
    if (cmd.includes('nohup ')) {
      lastStarted = runtimeOf(cmd)
      starts.push(`${lastStarted}: ${cmd}`)
      return routes.start[lastStarted] ?? ''
    }
    if (cmd.includes('daemon-start.log')) return routes.startLog?.[lastStarted] ?? ''
    if (cmd.includes('uname -m')) return 'aarch64'
    return ''
  })
  vi.spyOn(priv(conn), 'deploySource').mockImplementation(async () => { deploys.push(`source:${(conn as unknown as { _bunPath: string | null })._bunPath ? 'bun' : 'node'}`) })
  vi.spyOn(priv(conn), 'deployBinary').mockImplementation(async () => { deploys.push('prebuilt binary') })
  vi.spyOn(priv(conn), 'getLocalBinaryPath').mockImplementation(async () => null)
  vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(null)
  vi.spyOn(conn, 'uploadFile').mockImplementation(async (p: string, _d: Buffer, o?: { sha256?: string }) => { uploads.push({ path: p, sha256: o?.sha256 }); return { skipped: false } })
  return { conn, seen, starts, deploys, uploads }
}

const GLOBAL_KEY = '__WALNUT_SINGLE_FILE__'
beforeEach(() => { files.asks = []; files.fail = null })
afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY]
})
const compiledMac = () => setSingleFile({ root: '/tmp/walnut-runtime/0.6.99-x', daemonVersion: 'walnut-daemon-test', modules: {} })

describe('a compiled Mac deploys the host\'s walnut file as its daemon', () => {
  it('no bun runs and none installs: the file goes to the daemon slot and starts as the binary', async () => {
    compiledMac()
    const { conn, starts, deploys, uploads, seen } = setup({ start: { binary: STARTED } })
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(files.asks).toEqual(['linux-arm64'])
    // One upload: the gz beside the slot, named by its sha (a cut one resumes, one already there is skipped).
    expect(uploads).toEqual([{ path: '/tmp/open-walnut/daemon-linux-arm64.gz', sha256: 'b'.repeat(64) }])
    expect(seen.some((c) => c.includes('echo slot=installed') && c.includes('a'.repeat(64)))).toBe(true)
    expect(deploys).toEqual([])
    expect(starts.map((s) => s.split(':')[0])).toEqual(['binary'])
    expect(starts[0]).toContain("'/tmp/open-walnut/daemon-linux-arm64' --start")
    // The binary start confirms with the same file's `--status`.
    expect(starts[0]).toContain("'/tmp/open-walnut/daemon-linux-arm64' --status")
    expect(conn.remoteRuntime).toBe('binary')
  })

  it('sends nothing when the slot holds the file already, or copies it from the host server install', async () => {
    for (const slot of ['have', 'copied'] as const) {
      compiledMac()
      const { conn, uploads, starts, seen } = setup({ slot, start: { binary: STARTED } })
      expect(await priv(conn).deployAndStart()).toBe(32100)
      expect(uploads).toEqual([])
      expect(starts.map((s) => s.split(':')[0])).toEqual(['binary'])
      // The check names the host server's install of this build as the place to copy from.
      expect(seen.find((c) => c.includes('echo slot=none'))).toContain('/home/me/.open-walnut-host/app/0.6.99-abc1234/walnut')
      vi.restoreAllMocks()
    }
  })

  it('a host where bun runs keeps bun and the daemon source (a small upload), as before', async () => {
    compiledMac()
    const { conn, uploads, deploys, starts } = setup({ bun: [BUN_OK], start: { bun: STARTED } })
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(deploys).toEqual(['source:bun'])
    expect(uploads).toEqual([])
    expect(files.asks).toEqual([])
    expect(starts.map((s) => s.split(':')[0])).toEqual(['bun'])
  })

  it('bun dies at start (SIGILL): the walnut file takes over in the same connect', async () => {
    compiledMac()
    const { conn, uploads, deploys, starts } = setup({ bun: [BUN_OK], start: { bun: '', binary: STARTED }, startLog: { bun: 'walnut-daemon-exit=132' } })
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(deploys).toEqual(['source:bun'])
    expect(uploads.map((u) => u.path)).toEqual(['/tmp/open-walnut/daemon-linux-arm64.gz'])
    expect(starts.map((s) => s.split(':')[0])).toEqual(['bun', 'binary'])
  })

  it('a file this Mac cannot get (an unreleased build, no checkout): node and the daemon source, as before', async () => {
    compiledMac()
    files.fail = new Error('This Walnut\'s version (0.6.99-dev) is not a release version')
    const { conn, uploads, deploys, starts } = setup({ start: { node: STARTED } })
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(uploads).toEqual([])
    expect(deploys).toEqual(['source:node'])
    expect(starts.map((s) => s.split(':')[0])).toEqual(['node'])
  })

  it('a macOS host: the slot takes Linux files only, so node and the source', async () => {
    compiledMac()
    const { conn, uploads, deploys } = setup({ system: 'os=Darwin\narch=arm64\nlibc=\ntranslated=0\nglibc=\nbits=\nloader=\n', start: { node: STARTED } })
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(uploads).toEqual([])
    expect(deploys).toEqual(['source:node'])
  })

  it('a Mac on Node (no compiled file) never asks for a walnut file', async () => {
    const { conn, deploys } = setup({ start: { node: STARTED } })
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(files.asks).toEqual([])
    expect(deploys).toEqual(['source:node'])
  })
})
