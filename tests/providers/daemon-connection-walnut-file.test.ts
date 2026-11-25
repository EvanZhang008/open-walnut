/**
 * A compiled Mac's daemon deploy (DaemonConnection.deployWalnutFile): the
 * compiled file carries no separate daemon binaries, so the host gets its own
 * walnut file in the binary's slot and runs it as `--start` (src/binary/main.ts).
 * A host that cannot take it (an unreleased build, a macOS host, no room, a file that
 * does not run there) gets a clear error: no JS source daemon is deployed any more.
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
  /** What the release lookup answers (HostFileSource.published): none unless a test publishes the file. */
  published: { none: 'this server runs a build of its own checkout, which no release publishes' } as Record<string, unknown>,
  publishedAsks: [] as string[],
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
    published: async (target: string) => { files.publishedAsks.push(target); return files.published },
  }),
}))

import { DaemonConnection, remoteServiceProbePaths } from '../../src/providers/daemon-connection.js'
import { setSingleFile } from '../../src/lib/single-file.js'

type Priv = Record<string, (...args: unknown[]) => unknown>
const priv = (conn: DaemonConnection) => conn as unknown as Priv

const STARTED = '32100\n{"running":true}'
const NO_SERVICE = [...new Set([...remoteServiceProbePaths('/tmp/open-walnut'), ...remoteServiceProbePaths('/home/me/.cache/open-walnut')])]
  .map((p) => `absent ${p}`).concat('walnut-service-probe-done').join('\n')
const LINUX_ARM = 'os=Linux\narch=aarch64\nlibc=glibc\ntranslated=0\nglibc=2.36\nbits=64\nloader= /lib/ld-linux-aarch64.so.1\n'

interface Routes {
  /** What the slot check finds on the host (the whole answer for `low` and `unrunnable`). */
  slot?: 'have' | 'copied' | 'none' | string
  /** What the install answers (default `slot=installed`). */
  install?: string
  /** daemon.version on the host. */
  remoteVersion?: string
  /** The version this Mac expects (null: none, no update decided). */
  expected?: string | null
  /** The upload fails with this. */
  uploadFails?: string
  /** What the host's own download of the file answers (daemon-file-fetch.ts); an Error: the ssh command failed. */
  fetch?: string | Error
  system?: string
  /** What the start command answers (the port, then the status). */
  start?: string
  /** The daemon's start log, read when the start did not answer. */
  startLog?: string
}

function setup(routes: Routes) {
  const conn = new DaemonConnection('devbox', { hostname: 'devbox.example.test', user: 'me' })
  const seen: string[] = []
  const starts: string[] = []
  const deploys: string[] = []
  const uploads: Array<{ path: string; sha256?: string }> = []
  /** What the upload step's bar read when the slot's install ran. */
  const transfers: unknown[] = []
  vi.spyOn(priv(conn), 'sshExec').mockImplementation(async (...args: unknown[]) => {
    const cmd = String(args[0])
    seen.push(cmd)
    // The staged daemon's trial run and the kept previous daemon (daemon-trial-cmd.ts): it serves, and the files were kept.
    if (cmd.includes('walnut-trial-ok')) return 'walnut-trial-ok'
    if (cmd.includes('walnut-previous-kept')) return 'walnut-previous-kept'
    if (cmd.includes('walnut-dir-probe v1')) return ''
    if (cmd.includes('walnut-daemon-stop-confirmed')) return 'walnut-daemon-stop-confirmed'
    if (cmd.includes('daemon.version')) return routes.remoteVersion ?? ''
    if (cmd.includes('acp-busy.json')) return ''
    if (cmd.includes('walnut-live none')) return 'walnut-live none'
    if (cmd.includes('walnut-service-probe-done')) return NO_SERVICE
    if (cmd.includes('s=$(uname -s')) return routes.system ?? LINUX_ARM
    if (cmd === 'printf %s "$HOME"') return '/home/me'
    if (cmd.includes('echo slot=none')) return (routes.slot ?? 'none').startsWith('slot=') ? routes.slot! : `slot=${routes.slot ?? 'none'}`
    if (cmd.includes('echo fetch=ok')) {
      if (routes.fetch instanceof Error) throw routes.fetch
      return routes.fetch ?? ''
    }
    if (cmd.includes('fetched_bytes=')) return ''
    // The delta's look at the slot: what the bar read by then.
    if (cmd.includes('delta=nobase')) { transfers.push(['before the delta', conn.connectTransfer]); return '' }
    if (cmd.includes('echo slot=installed')) {
      transfers.push(conn.connectTransfer)
      return routes.install ?? 'slot=installed'
    }
    if (cmd.includes('nohup ')) {
      starts.push(cmd)
      return routes.start ?? ''
    }
    if (cmd.includes('daemon-start.log')) return routes.startLog ?? ''
    if (cmd.includes('uname -m')) return 'aarch64'
    return ''
  })
  vi.spyOn(priv(conn), 'deployBinary').mockImplementation(async () => { deploys.push('prebuilt binary') })
  vi.spyOn(priv(conn), 'getLocalBinaryPath').mockImplementation(async () => null)
  vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(routes.expected ?? null)
  vi.spyOn(conn, 'uploadFile').mockImplementation(async (p: string, d: Buffer, o?: { sha256?: string; onProgress?: (sent: number, total: number) => void }) => {
    seen.push(`UPLOAD ${p}`)
    if (routes.uploadFails) throw new Error(routes.uploadFails)
    o?.onProgress?.(0, d.length)
    o?.onProgress?.(d.length, d.length)
    uploads.push({ path: p, sha256: o?.sha256 })
    return { skipped: false }
  })
  return { conn, seen, starts, deploys, uploads, transfers }
}

const GLOBAL_KEY = '__WALNUT_SINGLE_FILE__'
beforeEach(() => {
  files.asks = []
  files.fail = null
  files.published = { none: 'this server runs a build of its own checkout, which no release publishes' }
  files.publishedAsks = []
})
afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY]
})
const compiledMac = () => setSingleFile({ root: '/tmp/walnut-runtime/0.6.99-x', daemonVersion: 'walnut-daemon-test', modules: {} })

const failedMemo = (conn: DaemonConnection) => (conn as unknown as { _fileFailed: { reason: string; at: number } | null })._fileFailed

describe('a compiled Mac deploys the host\'s walnut file as its daemon', () => {
  it('the file goes to the daemon slot and starts as the binary', async () => {
    compiledMac()
    const { conn, starts, deploys, uploads, seen } = setup({ start: STARTED })
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(files.asks).toEqual(['linux-arm64'])
    // One upload: the gz beside the slot, named by its sha (a cut one resumes, one already there is skipped).
    expect(uploads).toEqual([{ path: '/tmp/open-walnut/daemon-linux-arm64.gz', sha256: 'b'.repeat(64) }])
    expect(seen.some((c) => c.includes('echo slot=installed') && c.includes('a'.repeat(64)))).toBe(true)
    expect(deploys).toEqual([])
    expect(starts).toHaveLength(1)
    expect(starts[0]).toContain("'/tmp/open-walnut/daemon-linux-arm64' --start")
    // The start confirms with the same file's `--status`.
    expect(starts[0]).toContain("'/tmp/open-walnut/daemon-linux-arm64' --status")
  })

  it('sends nothing when the slot holds the file already, or copies it from the host server install', async () => {
    for (const slot of ['have', 'copied'] as const) {
      compiledMac()
      const { conn, uploads, starts, seen } = setup({ slot, start: STARTED })
      expect(await priv(conn).deployAndStart()).toBe(32100)
      expect(uploads).toEqual([])
      expect(starts).toHaveLength(1)
      // The check names the host server's install of this build as the place to copy from.
      expect(seen.find((c) => c.includes('echo slot=none'))).toContain('/home/me/.open-walnut-host/app/0.6.99-abc1234/walnut')
      vi.restoreAllMocks()
    }
  })

  it('a prebuilt daemon binary of a dist build goes first, and the walnut file is never asked for', async () => {
    const { conn, deploys, starts } = setup({ start: STARTED })
    vi.spyOn(priv(conn), 'getLocalBinaryPath').mockImplementation(async () => '/dist/daemon-binaries/daemon-linux-arm64')
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(deploys).toEqual(['prebuilt binary'])
    expect(files.asks).toEqual([])
    expect(starts).toHaveLength(1)
  })

  it('a prebuilt binary that does not get there: the walnut file goes in its place, in the same connect', async () => {
    compiledMac()
    const { conn, uploads, starts } = setup({ start: STARTED })
    vi.spyOn(priv(conn), 'getLocalBinaryPath').mockImplementation(async () => '/dist/daemon-binaries/daemon-linux-arm64')
    vi.spyOn(priv(conn), 'deployBinary').mockRejectedValue(new Error('the proxy killed the transfer'))
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(uploads.map((u) => u.path)).toEqual(['/tmp/open-walnut/daemon-linux-arm64.gz'])
    expect(starts).toHaveLength(1)
  })

  it('the file dies at start (SIGILL): a clear error, the reason is remembered, and it is not sent again for a while', async () => {
    compiledMac()
    const { conn, uploads } = setup({ start: '', startLog: 'walnut-daemon-exit=132' })
    await expect(priv(conn).deployAndStart()).rejects.toThrow(/cannot run on devbox/)
    expect(failedMemo(conn)?.reason).toContain('walnut-daemon-exit=132')
    uploads.length = 0
    await expect(priv(conn).deployAndStart()).rejects.toThrow(/not sent again/)
    expect(uploads).toEqual([])
  })

  it('a file this Mac cannot get (an unreleased build, no checkout): a clear error, nothing sent, nothing started', async () => {
    compiledMac()
    files.fail = new Error('This Walnut\'s version (0.6.99-dev) is not a release version')
    const { conn, uploads, starts } = setup({ start: STARTED })
    await expect(priv(conn).deployAndStart()).rejects.toThrow(/has no daemon file for devbox.*not a release version/)
    expect(uploads).toEqual([])
    expect(starts).toEqual([])
  })

  it('a macOS host with the experiment macos_one_service off: its slot takes no darwin file, so a clear error', async () => {
    compiledMac()
    vi.stubEnv('WALNUT_MACOS_ONE_SERVICE', '0')
    const { conn, uploads, starts } = setup({ system: 'os=Darwin\narch=arm64\nlibc=\ntranslated=0\nglibc=\nbits=\nloader=\n', start: STARTED })
    await expect(priv(conn).deployAndStart()).rejects.toThrow(/has no daemon file for devbox.*does not take this walnut file.*Macs run the one Walnut service only with the experiment/)
    expect(uploads).toEqual([])
    expect(starts).toEqual([])
  })

  it('a macOS host with the experiment on: the darwin walnut file is checked for room and goes in like a Linux one', async () => {
    compiledMac()
    vi.stubEnv('WALNUT_MACOS_ONE_SERVICE', '1')
    const { conn, uploads, seen } = setup({ system: 'os=Darwin\narch=arm64\nlibc=\ntranslated=0\nglibc=\nbits=\nloader=\n', start: STARTED })
    await priv(conn).deployAndStart().catch(() => {})
    // The same room check as a Linux slot, then the upload, for the darwin target.
    expect(seen.find((c) => c.includes('echo slot=none'))).toContain('then echo "slot=low')
    expect(seen.some((c) => c.includes('xattr -d com.apple.quarantine'))).toBe(true)
    expect(uploads.length).toBeGreaterThan(0)
  })

  it('a slot dir without room for the walnut file: nothing is sent, and the error says how much room is missing', async () => {
    compiledMac()
    const { conn, uploads, starts, seen } = setup({ slot: 'slot=low free_kb=51200 need_kb=256000', start: STARTED })
    await expect(priv(conn).deployAndStart()).rejects.toThrow(/50 MB free.*250 MB/)
    expect(uploads).toEqual([])
    expect(starts).toEqual([])
    // The check asked for 2.5 times the file (here its 1 KB gz) in KB.
    expect(seen.find((c) => c.includes('echo slot=none'))).toContain('-lt 3 ]; then echo "slot=low')
  })

  it('a walnut file that does not run here as this build\'s daemon: a clear error, and the file is not offered again on this connection', async () => {
    compiledMac()
    const { conn, uploads, seen } = setup({
      expected: 'walnut-daemon-new', install: 'slot=unrunnable\ndetail=/lib/ld-linux-aarch64.so.1: version GLIBC_2.38 not found',
      start: STARTED,
    })
    await expect(priv(conn).deployAndStart()).rejects.toThrow(/does not run here as this build's daemon/)
    expect(uploads.map((u) => u.path)).toEqual(['/tmp/open-walnut/daemon-linux-arm64.gz'])
    // The run asks for the version this Mac expects.
    expect(seen.find((c) => c.includes('echo slot=installed'))).toContain("__daemon --version")
    expect(seen.find((c) => c.includes('echo slot=installed'))).toContain("'walnut-daemon-new'")
    expect(failedMemo(conn)?.reason).toContain('GLIBC_2.38')
    expect(await priv(conn).hasDaemonBinary()).toBe(true)
    uploads.length = 0
    await expect(priv(conn).deployDaemon()).rejects.toThrow(/does not run on devbox, so it is not sent again/)
    expect(uploads).toEqual([])
  })

  it('a checkout (no compiled file, no daemon binary) asks the shared host file source for the walnut file too', async () => {
    const { conn, uploads, starts } = setup({ start: STARTED })
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(files.asks).toEqual(['linux-arm64'])
    expect(uploads).toHaveLength(1)
    expect(starts).toHaveLength(1)
  })
})

// A first connect through an SSH relay spent about three minutes sending the ~67 MB gz in
// 256 KB chunks; a host that reaches the release downloads the same bytes in seconds.
describe('a released build: the host downloads the file itself, the upload only when that fails', () => {
  const URL = 'https://github.example.test/o/r/releases/download/v0.6.99/walnut-0.6.99-linux-arm64.gz'
  const publish = (over: Record<string, unknown> = {}) => { files.published = { url: URL, gzSha256: 'b'.repeat(64), sha256: 'a'.repeat(64), ...over } }

  it('the release holds this very file: the host fetches it into the gz beside the slot, nothing is sent, the same install runs', async () => {
    compiledMac()
    publish()
    const { conn, seen, uploads, starts, transfers } = setup({ fetch: 'fetch=ok', start: STARTED })
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(files.publishedAsks).toEqual(['linux-arm64'])
    expect(uploads).toEqual([])
    const fetch = seen.find((c) => c.includes('echo fetch=ok'))!
    expect(fetch).toContain(`'${URL}'`)
    expect(fetch).toContain(`'${'b'.repeat(64)}'`)
    // The part has a name of its own beside the slot's gz; the install takes it from there.
    const part = /W_P='([^']+)'/.exec(fetch)![1]!
    expect(part).toMatch(/^\/tmp\/open-walnut\/daemon-linux-arm64\.gz\.fetch-[0-9a-f]{16}$/)
    // Checked against the plain file's sha256 and moved in by the upload path's own install, after the fetch.
    const install = seen.findIndex((c) => c.includes('echo slot=installed'))
    expect(install).toBeGreaterThan(seen.indexOf(fetch))
    expect(seen[install]).toContain('a'.repeat(64))
    expect(seen[install]).toContain(`gzip -dc '${part}'`)
    expect(transfers).toEqual([{ via: 'download', done: 1024, total: 1024 }])
    expect(starts).toHaveLength(1)
  })

  it('a host that cannot download it (no curl or wget, a checksum that does not match, no answer, a failed command): the upload goes, as before', async () => {
    const answers: Array<string | Error> = ['fetch=no reason=no-downloader', 'fetch=no reason=sha\ndetail=got 0000', '', new Error('Remote command timed out after 180000ms')]
    for (const fetch of answers) {
      compiledMac()
      publish()
      const { conn, uploads, starts, transfers } = setup({ fetch, start: STARTED })
      expect(await priv(conn).deployAndStart()).toBe(32100)
      expect(uploads).toEqual([{ path: '/tmp/open-walnut/daemon-linux-arm64.gz', sha256: 'b'.repeat(64) }])
      // The download's numbers left the bar when it gave way; then the bar is the upload's.
      expect(transfers).toEqual([['before the delta', null], { via: 'upload', done: 1024, total: 1024 }])
      expect(starts).toHaveLength(1)
      vi.restoreAllMocks()
    }
  })

  it('a host whose download failed is not asked again on the next deploy, for a while', async () => {
    compiledMac()
    publish()
    const { conn, seen, uploads } = setup({ fetch: 'fetch=no reason=download\ndetail=exit 7: Failed to connect', start: STARTED })
    await priv(conn).deployWalnutFile()
    await priv(conn).deployWalnutFile()
    expect(seen.filter((c) => c.includes('echo fetch=ok'))).toHaveLength(1)
    expect(uploads).toHaveLength(2)
    expect((conn as unknown as { _hostFetchOff: { until: number; why: string } })._hostFetchOff).toMatchObject({ why: 'download: exit 7: Failed to connect' })
  })

  it('a download the SSH link cut off (no answer) is tried again on the next deploy: the link dropped, not the host', async () => {
    for (const fetch of ['', new Error('Remote command timed out after 180000ms')] as Array<string | Error>) {
      compiledMac()
      publish()
      const { conn, seen } = setup({ fetch, start: STARTED })
      await priv(conn).deployWalnutFile()
      await priv(conn).deployWalnutFile()
      expect(seen.filter((c) => c.includes('echo fetch=ok'))).toHaveLength(2)
      expect((conn as unknown as { _hostFetchOff: unknown })._hostFetchOff).toBeNull()
      vi.restoreAllMocks()
    }
  })

  it('the install after a download fails: the deploy answers as after an upload (a clear error), and nothing is sent', async () => {
    compiledMac()
    publish()
    const { conn, uploads, starts } = setup({ fetch: 'fetch=ok', install: 'no marker', start: STARTED })
    await expect(priv(conn).deployAndStart()).rejects.toThrow(/did not go into the daemon slot/)
    expect(uploads).toEqual([])
    expect(starts).toEqual([])
  })

  it('a release whose file is other bytes than this build (a dev build of the same version): no download is tried', async () => {
    compiledMac()
    publish({ sha256: 'c'.repeat(64) })
    const { conn, seen, uploads } = setup({ fetch: 'fetch=ok', start: STARTED })
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(seen.some((c) => c.includes('echo fetch=ok'))).toBe(false)
    expect(uploads.map((u) => u.path)).toEqual(['/tmp/open-walnut/daemon-linux-arm64.gz'])
  })

  it('a build no release publishes: the lookup says so and the upload goes, the host is asked nothing new', async () => {
    compiledMac()
    const { conn, seen, uploads } = setup({ fetch: 'fetch=ok', start: STARTED })
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(files.publishedAsks).toEqual(['linux-arm64'])
    expect(seen.some((c) => c.includes('echo fetch=ok'))).toBe(false)
    expect(uploads).toHaveLength(1)
  })

  it('the slot already holds the file: no lookup, no download, nothing sent', async () => {
    compiledMac()
    publish()
    const { conn, seen, uploads } = setup({ slot: 'have', fetch: 'fetch=ok', start: STARTED })
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(files.publishedAsks).toEqual([])
    expect(seen.some((c) => c.includes('echo fetch=ok'))).toBe(false)
    expect(uploads).toEqual([])
  })

  it('WALNUT_HOST_FETCH=0 keeps the upload', async () => {
    compiledMac()
    publish()
    vi.stubEnv('WALNUT_HOST_FETCH', '0')
    try {
      const { conn, seen, uploads } = setup({ fetch: 'fetch=ok', start: STARTED })
      expect(await priv(conn).deployAndStart()).toBe(32100)
      expect(seen.some((c) => c.includes('echo fetch=ok'))).toBe(false)
      expect(uploads).toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('the downloaded file does not run here as this build\'s daemon: no upload of the same bytes, a clear error', async () => {
    compiledMac()
    publish()
    const { conn, uploads } = setup({
      fetch: 'fetch=ok', expected: 'walnut-daemon-new', install: 'slot=unrunnable\ndetail=GLIBC_2.38 not found', start: STARTED,
    })
    await expect(priv(conn).deployAndStart()).rejects.toThrow(/does not run here as this build's daemon/)
    expect(uploads).toEqual([])
    expect(failedMemo(conn)?.reason).toContain('GLIBC_2.38')
  })
})

// An update used to stop the old daemon first and only then fetch and upload
// the file: the host had no daemon for the whole upload (minutes for the walnut
// file on a slow link) and none at all when the upload failed.
describe('an update puts the new daemon on the host before it stops the old one', () => {
  const SLOT = '/tmp/open-walnut/daemon-linux-arm64'
  const upgrade = { expected: 'walnut-daemon-new', remoteVersion: 'walnut-daemon-old' }

  it('the file goes in while the old daemon runs, then the stop, then the start of what was staged', async () => {
    compiledMac()
    const { conn, seen, uploads, starts } = setup({ ...upgrade, start: STARTED })
    expect(await priv(conn).shouldUpgradeDaemon(SLOT, undefined, undefined, 'binary')).toBe(true)
    const at = (pred: (c: string) => boolean) => seen.findIndex(pred)
    const upload = at((c) => c.startsWith('UPLOAD '))
    const install = at((c) => c.includes('echo slot=installed'))
    const stop = at((c) => c.includes('walnut-daemon-stop-confirmed'))
    expect(upload).toBeGreaterThan(-1)
    expect(install).toBeGreaterThan(upload)
    expect(stop).toBeGreaterThan(install)
    // The start that follows the stop takes the staged runtime: nothing is checked or sent again.
    const before = seen.length
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(seen.slice(before).some((c) => c.includes('echo slot=none') || c.startsWith('UPLOAD '))).toBe(false)
    expect(uploads).toHaveLength(1)
    expect(starts).toHaveLength(1)
  })

  it('the upload fails: no stop, the old daemon keeps serving, and the update is asked again', async () => {
    compiledMac()
    const { conn, seen, deploys } = setup({ ...upgrade, uploadFails: 'chunk 12 of 400 failed after 5 tries', start: STARTED })
    expect(await priv(conn).shouldUpgradeDaemon(SLOT, undefined, undefined, 'binary')).toBe(false)
    expect(seen.some((c) => c.includes('walnut-daemon-stop-confirmed'))).toBe(false)
    // A daemon running as the binary keeps running when one transfer failed.
    expect(deploys).toEqual([])
    expect((conn as unknown as { upgradeRecheckTimer: unknown }).upgradeRecheckTimer).not.toBeNull()
    expect((conn as unknown as { _staged: unknown })._staged).toBeNull()
    priv(conn).clearUpgradeRecheck()
  })

  it('failed uploads toward one version are asked again less and less often', async () => {
    compiledMac()
    const { conn } = setup({ ...upgrade, uploadFails: 'chunk 12 of 400 failed after 5 tries', start: STARTED })
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const delays: number[] = []
    for (let i = 0; i < 3; i++) {
      timer.mockClear()
      expect(await priv(conn).shouldUpgradeDaemon(SLOT, undefined, undefined, 'binary')).toBe(false)
      delays.push(...timer.mock.calls.map((c) => Number(c[1])).filter((ms) => ms >= 60_000))
    }
    expect(delays).toEqual([60_000, 120_000, 300_000])
    priv(conn).clearUpgradeRecheck()
  })

  it('an old source daemon on node or bun: the walnut file goes in ahead of the stop, and no JS source is ever the fallback', async () => {
    for (const was of ['node', 'bun'] as const) {
      compiledMac()
      const { conn, seen, deploys } = setup({ ...upgrade, start: STARTED })
      expect(await priv(conn).shouldUpgradeDaemon('/tmp/open-walnut/daemon.cjs', undefined, undefined, was)).toBe(true)
      expect(deploys).toEqual([])
      expect(seen.findIndex((c) => c.includes('walnut-daemon-stop-confirmed'))).toBeGreaterThan(seen.findIndex((c) => c.startsWith('UPLOAD ')))
      priv(conn).clearUpgradeRecheck()
      vi.restoreAllMocks()
    }
  })
})
