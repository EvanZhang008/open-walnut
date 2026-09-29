/**
 * A login done outside Walnut (a renewed SSH certificate, a reloaded agent, an
 * SSH proxy's own sign-in) redials the hosts waiting on it at the next poll,
 * instead of at the credential clock's next tick (then hourly after the first
 * 18 minutes). Reported 2026-09-29: the certificate was renewed at 08:00 and the
 * host stayed dark until 08:32.
 *
 * The rules pinned here: a credential file modified AFTER a host's last failed
 * dial redials it once; a redial that fails again (newer failure time) does not
 * loop; an agent listing that changes counts, an unreadable one does not; a
 * host redials at most once a minute; nobody waiting = no file or agent reads.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { newestLoginFileMtime, newestSshFileMtime, startHostCredentialSignal, type CredentialWaiter } from '../../../src/core/hosts/host-credential-signal.js'
import { HOST_REDIAL_MIN_INTERVAL_MS } from '../../../src/core/hosts/host-wake-signal.js'

function harness(initial: CredentialWaiter[]) {
  let t = 1_000_000
  let waiters = initial
  let newest: number | null = 500_000
  let agent: string | null = '0\nssh-ed25519 AAAA key'
  const reads = { files: 0, agent: 0 }
  const redials: string[] = []
  const sig = startHostCredentialSignal({
    waiting: () => waiters,
    redial: (h) => redials.push(h),
    newestFileMtime: async () => { reads.files++; return newest },
    agentListing: async () => { reads.agent++; return agent },
    now: () => t,
    setInterval: () => ({ unref: () => {} }),
    clearInterval: () => {},
  })
  return {
    sig, redials, reads,
    advance: (ms: number) => { t += ms },
    now: () => t,
    setWaiters: (w: CredentialWaiter[]) => { waiters = w },
    setNewest: (ms: number | null) => { newest = ms },
    setAgent: (a: string | null) => { agent = a },
  }
}

describe('host credential signal', () => {
  it('a credential file written after the last failed dial redials the host once', async () => {
    const h = harness([{ host: 'devbox', failedAt: 900_000 }])
    expect(await h.sig.poll()).toEqual([])            // the certificate predates the failure
    h.setNewest(950_000)                               // the user ran the login command
    expect(await h.sig.poll()).toEqual(['devbox'])
    expect(h.redials).toEqual(['devbox'])
  })

  it('a login made before the first poll still counts (compared with the failure, not a first look)', async () => {
    const h = harness([{ host: 'devbox', failedAt: 900_000 }])
    h.setNewest(990_000)
    expect(await h.sig.poll()).toEqual(['devbox'])
  })

  it('a redial that fails again moves the failure past the file: no loop', async () => {
    const h = harness([{ host: 'devbox', failedAt: 900_000 }])
    h.setNewest(950_000)
    await h.sig.poll()
    // The redial failed on something else; the loop records the newer failure.
    h.advance(HOST_REDIAL_MIN_INTERVAL_MS * 5)
    h.setWaiters([{ host: 'devbox', failedAt: h.now() - 1_000 }])
    expect(await h.sig.poll()).toEqual([])
    expect(h.redials).toEqual(['devbox'])
  })

  it('a host redials at most once a minute even if its failure time never moves', async () => {
    const h = harness([{ host: 'devbox', failedAt: 900_000 }])
    h.setNewest(950_000)
    await h.sig.poll()
    h.advance(15_000)
    expect(await h.sig.poll()).toEqual([])
    h.advance(HOST_REDIAL_MIN_INTERVAL_MS)
    expect(await h.sig.poll()).toEqual(['devbox'])
  })

  it('nobody waiting: no file stat, no agent call', async () => {
    const h = harness([])
    for (let i = 0; i < 5; i++) await h.sig.poll()
    expect(h.reads).toEqual({ files: 0, agent: 0 })
  })

  it('an agent listing that changes redials every waiting host; the first look is only a baseline', async () => {
    const h = harness([{ host: 'a', failedAt: 900_000 }, { host: 'b', failedAt: 900_000 }])
    expect(await h.sig.poll()).toEqual([])
    h.setAgent('0\nssh-ed25519 AAAA key\nssh-ed25519-cert-v01@openssh.com BBBB renewed')
    expect(await h.sig.poll()).toEqual(['a', 'b'])
    h.advance(HOST_REDIAL_MIN_INTERVAL_MS)
    expect(await h.sig.poll()).toEqual([])            // unchanged since the last look
  })

  it('an unreadable agent listing (timeout) neither counts nor resets the comparison', async () => {
    const h = harness([{ host: 'a', failedAt: 900_000 }])
    await h.sig.poll()
    h.setAgent(null)
    expect(await h.sig.poll()).toEqual([])
    h.setAgent('0\nssh-ed25519 AAAA key')           // the same listing as before the blip
    expect(await h.sig.poll()).toEqual([])
    expect(h.redials).toEqual([])
  })

  it('the agent baseline starts over once nobody waits', async () => {
    const h = harness([{ host: 'a', failedAt: 900_000 }])
    await h.sig.poll()
    h.setWaiters([])
    await h.sig.poll()
    h.setAgent('2\n')                                  // a different agent, seen by a NEW wait
    h.setWaiters([{ host: 'a', failedAt: 900_000 }])
    expect(await h.sig.poll()).toEqual([])            // baseline, not a change
  })

  it('the same host listed twice redials once, judged by its latest failure', async () => {
    const h = harness([{ host: 'a', failedAt: 900_000 }, { host: 'a', failedAt: 960_000 }])
    h.setNewest(950_000)                               // after the old failure, before the new one
    expect(await h.sig.poll()).toEqual([])
    h.setNewest(970_000)
    expect(await h.sig.poll()).toEqual(['a'])
  })

  it('a redial that throws does not stop the others', async () => {
    const redials: string[] = []
    const sig = startHostCredentialSignal({
      waiting: () => [{ host: 'bad', failedAt: 1 }, { host: 'good', failedAt: 1 }],
      redial: (h) => { if (h === 'bad') throw new Error('boom'); redials.push(h) },
      newestFileMtime: async () => 10, agentListing: async () => null,
      setInterval: () => ({}), clearInterval: () => {},
    })
    expect(await sig.poll()).toEqual(['bad', 'good'])
    expect(redials).toEqual(['good'])
  })
})

describe('newestSshFileMtime', () => {
  let dir = ''
  let server: net.Server | null = null
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    server = null
    if (dir) await fs.rm(dir, { recursive: true, force: true })
    dir = ''
  })

  it('reads regular files only: known_hosts, a ControlMaster socket and a future date do not count', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wn-ssh-'))
    const at = (s: number) => new Date(s * 1000)
    const write = async (name: string, secs: number) => {
      await fs.writeFile(path.join(dir, name), 'x')
      await fs.utimes(path.join(dir, name), at(secs), at(secs))
    }
    await write('id_ecdsa', 1_000)
    await write('id_ecdsa-cert.pub', 2_000)
    await write('config', 1_500)
    await write('known_hosts', 9_000)
    await write('known_hosts.old', 9_000)
    await write('authorized_keys', 9_000)
    const nowMs = 3_000_000
    await write('clock-skewed', nowMs / 1000 + 3_600)
    await fs.mkdir(path.join(dir, 'sockets'))
    // A real unix socket, like `ControlPath ~/.ssh/cm-%C`: rewritten by every ssh the user runs.
    server = net.createServer()
    await new Promise<void>((r) => server!.listen(path.join(dir, 'cm-abc'), () => r()))

    expect(await newestSshFileMtime(dir, nowMs)).toBe(2_000_000)
  })

  it('a missing ~/.ssh reads as nothing, not an error', async () => {
    expect(await newestSshFileMtime(path.join(os.tmpdir(), 'wn-no-such-ssh-dir-xyz'))).toBeNull()
  })
})

describe('newestLoginFileMtime: ~/.ssh plus the configured login files', () => {
  let home = ''
  afterEach(async () => {
    if (home) await fs.rm(home, { recursive: true, force: true })
    home = ''
  })
  const at = (s: number) => new Date(s * 1000)
  const touch = async (p: string, secs: number) => {
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, 'x')
    await fs.utimes(p, at(secs), at(secs))
  }

  it("a proxy's login file newer than every ssh file is the newest login", async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'wn-home-'))
    await touch(path.join(home, '.ssh', 'id_ecdsa-cert.pub'), 1_000)
    await touch(path.join(home, '.acme', 'cookie'), 2_000)
    const nowMs = 3_000_000
    expect(await newestLoginFileMtime([], nowMs, home)).toBe(1_000_000)
    // `~/` expands against home; a directory counts by its newest file.
    expect(await newestLoginFileMtime(['~/.acme'], nowMs, home)).toBe(2_000_000)
    expect(await newestLoginFileMtime(['~/.acme/cookie'], nowMs, home)).toBe(2_000_000)
    expect(await newestLoginFileMtime([path.join(home, '.acme', 'cookie')], nowMs, home)).toBe(2_000_000)
  })

  it('a missing path counts as nothing; a future date is a skewed clock', async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'wn-home-'))
    await touch(path.join(home, '.ssh', 'id_ed25519'), 1_000)
    const nowMs = 3_000_000
    await touch(path.join(home, 'token'), nowMs / 1000 + 3_600)
    expect(await newestLoginFileMtime(['~/no-such-login', '~/token'], nowMs, home)).toBe(1_000_000)
    // No ~/.ssh and nothing configured: null, never a throw.
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'wn-home-empty-'))
    try { expect(await newestLoginFileMtime(['~/also-missing'], nowMs, empty)).toBeNull() } finally { await fs.rm(empty, { recursive: true, force: true }) }
  })
})
