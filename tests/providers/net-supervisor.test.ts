/**
 * The walnut-net supervisor (src/providers/net-core.ts) against the real walnut-net, with
 * no daemon around it: how it applies a config, and what it does when one is bad.
 *
 *  1. A host with a config and no walnut-net (a new version it has not downloaded yet)
 *     downloads it and starts on its own: a machine that joined has no one else to ask.
 *  2. A running walnut-net that refuses a new config keeps the one it runs, on disk too,
 *     and configure says so.
 *  3. A walnut-net that never comes up on a new config goes back to the last config it
 *     came up on, and configure says so.
 *  4. A config that needs a new endpoint (a relay change) restarts it, and configure
 *     answers once the new one is up.
 *  5. A bad member id from one join leaves that member out, never the others.
 *  6. A daemon that moved to a new walnut-net version runs the older download until the
 *     new one is in, then moves to it and keeps one older version.
 *  7. A config that comes while walnut-net starts is reloaded once, and a relay change
 *     in it is kept (two reloads at once used to undo it).
 *  8. A reload it took is the one a rollback goes back to; a start that fails for any
 *     other reason than the config (an unreadable key) keeps the new config.
 *  9. A relay mode waits for a walnut-net that is starting to say what it runs, and is
 *     refused when it never does (an older one would run it with no relay at all); one
 *     that exits meanwhile is started on it.
 *
 * Needs walnut-net (WALNUT_NET_TEST_BIN, else dist/daemon-binaries/walnut-net-<platform>-<arch>);
 * skipped without it. Every file is under one temp dir; the children it starts are its own.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createNetSupervisor, type NetSupervisor } from '../../src/providers/net-core.js'
import { netKey } from '../helpers/net-keys.js'
import { netInstallName } from '../../src/providers/net-binary.js'

const REPO = path.resolve(__dirname, '../..')
const NET_BIN = (() => {
  const env = process.env.WALNUT_NET_TEST_BIN
  if (env && fs.existsSync(env)) return env
  const built = path.join(REPO, `dist/daemon-binaries/walnut-net-${process.platform}-${process.arch}`)
  return fs.existsSync(built) ? built : null
})()

// A released walnut-net without relay modes (0.1.0, control protocol 1), for the version gate.
const OLD_BIN = process.env.WALNUT_NET_TEST_OLD_BIN && fs.existsSync(process.env.WALNUT_NET_TEST_OLD_BIN) ? process.env.WALNUT_NET_TEST_OLD_BIN : null

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wn-net-sup-')))
afterAll(() => { if (root.includes('wn-net-sup-')) fs.rmSync(root, { recursive: true, force: true }) })

let open: NetSupervisor[] = []
afterEach(async () => {
  for (const s of open) await s.stop()
  open = []
})

const BAD_ROOT = '-----BEGIN CERTIFICATE-----\nnot base64 !!\n-----END CERTIFICATE-----\n'

function supervisor(name: string, opts: { bin?: () => string | null; fetchBin?: () => Promise<string>; previousBin?: () => string | null; spawn?: typeof spawn } = {}) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  const portFile = path.join(dir, 'daemon.port')
  fs.writeFileSync(portFile, '1\n')
  const s = createNetSupervisor({
    spawn: opts.spawn ?? ((cmd, args, o) => spawn(cmd, args, o)),
    stateDir: path.join(dir, 'net'),
    portFile,
    bin: opts.bin ?? (() => NET_BIN),
    ...(opts.fetchBin ? { fetchBin: opts.fetchBin } : {}),
    ...(opts.previousBin ? { previousBin: opts.previousBin } : {}),
  })
  open.push(s)
  return { s, configFile: path.join(dir, 'net', 'config.json'), stateDir: path.join(dir, 'net') }
}

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v as T
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** The members walnut-net runs with, by name (its status calls them peers). */
const peerNames = (st: { node: Record<string, unknown> | null }) =>
  ((st.node?.peers ?? []) as Array<{ name: string }>).map((p) => p.name).sort()

const mac = { id: netKey('sup-mac'), name: 'mac', accept: true }
const other = { id: netKey('sup-other'), name: 'other', accept: false }

describe.skipIf(!NET_BIN)('the walnut-net supervisor', () => {
  it('a host with a config and no walnut-net downloads it and starts on its own', async () => {
    // First a supervisor that has it writes the config, as a join would have.
    const first = supervisor('fetch')
    await first.s.configure({ members: [mac] })
    await first.s.stop()
    open = []
    let installed: string | null = null
    let fetched = 0
    const again = supervisor('fetch', {
      bin: () => installed,
      fetchBin: async () => { fetched++; installed = NET_BIN; return NET_BIN! },
    })
    again.s.start()
    const st = await until(async () => { const x = await again.s.status(); return x.running ? x : null }, 30_000, 'walnut-net to start')
    expect(fetched).toBe(1)
    expect(st.enabled).toBe(true)
  }, 60_000)

  it('a config the running walnut-net refuses leaves the one it runs, on disk too', async () => {
    const { s, configFile } = supervisor('refuse')
    expect((await s.configure({ members: [mac] })).running).toBe(true)
    const good = fs.readFileSync(configFile, 'utf8')
    await expect(s.configure({ members: [mac], relayRoots: [BAD_ROOT] })).rejects.toThrow(/refused the config/)
    expect(fs.readFileSync(configFile, 'utf8')).toBe(good)
    expect((await s.status()).running).toBe(true)
    // And the next good one is taken.
    expect((await s.configure({ members: [mac, other] })).running).toBe(true)
    expect(peerNames(await s.status())).toEqual(['mac', 'other'])
  }, 60_000)

  it('a walnut-net that never comes up on a new config goes back to the last one it came up on', async () => {
    const { s, configFile } = supervisor('rollback')
    expect((await s.configure({ members: [mac] })).running).toBe(true)
    const good = fs.readFileSync(configFile, 'utf8')
    // Stopped, so the bad config is read at start, not in a reload.
    await s.stopChild()
    await expect(s.configure({ members: [mac], relayRoots: [BAD_ROOT] })).rejects.toThrow(/previous one/)
    expect(fs.readFileSync(configFile, 'utf8')).toBe(good)
    await until(async () => (await s.status()).running, 30_000, 'walnut-net back on the last good config')
  }, 60_000)

  it('a relay change restarts walnut-net, and configure answers once the new one is up', async () => {
    const { s, configFile } = supervisor('restart')
    expect((await s.configure({ members: [mac] })).running).toBe(true)
    const before = (await s.status()).pid
    const r = await s.configure({ members: [mac], relays: ['https://relay.example.invalid'] })
    expect(r.running).toBe(true)
    const after = await s.status()
    expect(after.running).toBe(true)
    expect(after.pid).not.toBe(before)
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).relays).toEqual(['https://relay.example.invalid'])
  }, 60_000)

  it('a member whose id is not a key is left out, the others stay', async () => {
    const { s } = supervisor('bad-member')
    const r = await s.configure({ members: [mac, { id: '02'.repeat(32), name: 'bad', accept: true }, other] })
    expect(r.running).toBe(true)
    expect(peerNames(await s.status())).toEqual(['mac', 'other'])
  }, 60_000)

  it('a daemon on a new version runs the older download until the new one is in, then moves to it', async () => {
    const first = supervisor('upgrade')
    await first.s.configure({ members: [mac] })
    await first.s.stop()
    open = []
    const bin = path.join(first.stateDir, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    for (const v of ['0.0.7', '0.0.8', '0.0.9']) fs.copyFileSync(NET_BIN!, path.join(bin, `walnut-net-${v}`))
    let installed: string | null = null
    let release!: () => void
    const downloaded = new Promise<void>((r) => { release = r })
    const again = supervisor('upgrade', {
      bin: () => installed,
      fetchBin: async () => {
        await downloaded
        installed = path.join(bin, netInstallName())
        fs.copyFileSync(NET_BIN!, installed)
        fs.chmodSync(installed, 0o755)
        return installed
      },
    })
    again.s.start()
    // On the network meanwhile, on the newest older download.
    const old = await until(async () => { const x = await again.s.status(); return x.running ? x : null }, 30_000, 'the older walnut-net')
    expect(peerNames(old)).toEqual(['mac'])
    release()
    const now = await until(async () => { const x = await again.s.status(); return x.running && x.pid !== old.pid ? x : null }, 30_000, 'the move to this version')
    expect(peerNames(now)).toEqual(['mac'])
    expect(fs.readdirSync(bin).sort()).toEqual(['walnut-net-0.0.9', netInstallName()].sort())
  }, 60_000)

  it('a config that comes while walnut-net starts is reloaded once, and its relay change is kept', async () => {
    const { s, configFile } = supervisor('starting')
    await s.configure({ members: [mac] })
    await s.stopChild()
    s.start()
    // The same tick, the key already known: the child is there, not ready yet.
    const r = await s.configure({ members: [mac, other], relays: ['https://relay.example.invalid'] })
    expect(r.running).toBe(true)
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')) as { relays: string[] }
    expect(cfg.relays).toEqual(['https://relay.example.invalid'])
    const st = await until(async () => { const x = await s.status(); return x.running ? x : null }, 30_000, 'walnut-net on the new config')
    expect(peerNames(st)).toEqual(['mac', 'other'])
  }, 60_000)

  it('a reload it took is what a rollback goes back to; a start that fails for another reason keeps the config', async () => {
    const { s, configFile, stateDir } = supervisor('good')
    await s.configure({ members: [mac] })
    await s.configure({ members: [mac, other] })
    const taken = fs.readFileSync(configFile, 'utf8')
    expect(fs.readFileSync(path.join(stateDir, 'config.last-good.json'), 'utf8')).toBe(taken)
    // An unreadable key: walnut-net exits before ready, and that is not the config's fault.
    await s.stopChild()
    const key = path.join(stateDir, 'net.key')
    fs.chmodSync(key, 0o000)
    try {
      const third = await s.configure({ members: [other] })
      expect(third.running).toBe(false)
      expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).members.map((m: { name: string }) => m.name)).toEqual(['other'])
    } finally {
      fs.chmodSync(key, 0o600)
    }
    // The next start comes up on it.
    const st = await until(async () => { const x = await s.status(); return x.running ? x : null }, 30_000, 'walnut-net once the key reads again')
    expect(peerNames(st)).toEqual(['other'])
  }, 60_000)

  it('a relay mode is not taken on trust by one that has not said what it is yet', async () => {
    // A walnut-net that never comes up (no ready line, so no protocol): `run` sleeps.
    const hang = ((cmd: string, args: readonly string[], o: object) => args[0] === 'run'
      ? spawn('sleep', ['600'], o)
      : spawn(cmd, args, o)) as unknown as typeof spawn
    const { s, configFile } = supervisor('never-ready', { spawn: hang })
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    fs.writeFileSync(configFile, '{}\n')
    s.start()
    await expect(s.configure({ relayMode: 'public', members: [mac] })).rejects.toThrow(/still starting/)
    expect(fs.readFileSync(configFile, 'utf8')).toBe('{}\n')
  }, 60_000)

  it('one that exits while the relay mode waits is started on it, and checked', async () => {
    // The first `run` exits after 2 s without a ready line (a crash); the next is walnut-net.
    let runs = 0
    const crashOnce = ((cmd: string, args: readonly string[], o: object) => args[0] === 'run' && runs++ === 0
      ? spawn('sleep', ['2'], o)
      : spawn(cmd, args, o)) as unknown as typeof spawn
    const { s, configFile } = supervisor('exits-waiting', { spawn: crashOnce })
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    fs.writeFileSync(configFile, '{}\n')
    s.start()
    expect((await s.configure({ relayMode: 'none', members: [mac] })).running).toBe(true)
    expect((await s.status()).node?.relayMode).toBe('none')
    expect(runs).toBe(2)
  }, 60_000)
})

describe.skipIf(!NET_BIN || !OLD_BIN)('relay modes and a walnut-net without them', () => {
  it('a first start on one is undone, and nothing runs on it', async () => {
    const { s, configFile } = supervisor('old-first', { bin: () => OLD_BIN })
    await expect(s.configure({ relayMode: 'public', members: [mac] })).rejects.toThrow(/older than this Walnut/)
    expect(fs.existsSync(configFile)).toBe(false)
    expect((await s.status()).running).toBe(false)
  }, 60_000)

  it('one that runs keeps the config it runs when a relay mode comes', async () => {
    const { s, configFile } = supervisor('old-running', { bin: () => OLD_BIN })
    await s.configure({ members: [mac] })
    const text = fs.readFileSync(configFile, 'utf8')
    await expect(s.configure({ relayMode: 'none', members: [mac] })).rejects.toThrow(/older than this Walnut/)
    expect(fs.readFileSync(configFile, 'utf8')).toBe(text)
    expect((await s.status()).running).toBe(true)
  }, 60_000)

  it('an older download that has relay modes runs them while this version downloads', async () => {
    const { s } = supervisor('prev-modes', { bin: () => null, previousBin: () => NET_BIN, fetchBin: () => new Promise<string>(() => {}) })
    expect((await s.configure({ relayMode: 'none', members: [mac] })).running).toBe(true)
    expect((await s.status()).node?.relayMode).toBe('none')
  }, 60_000)

  it('an older download without them is undone, and this version is fetched meanwhile', async () => {
    let fetched = 0
    const { s, configFile } = supervisor('prev-old', { bin: () => null, previousBin: () => OLD_BIN, fetchBin: () => { fetched++; return new Promise<string>(() => {}) } })
    await expect(s.configure({ relayMode: 'none', members: [mac] })).rejects.toThrow(/downloading, so try again in a minute/)
    expect(fs.existsSync(configFile)).toBe(false)
    expect(fetched).toBe(1)
  }, 60_000)
})
