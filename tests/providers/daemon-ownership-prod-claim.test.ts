/**
 * Who may claim the PRODUCTION daemon dir (/tmp/open-walnut).
 *
 * Regression ratchet for the 2026-08-28 outage: a leftover demo server (plain
 * `node dist/cli.js web --port <n>`, so no VITEST/NODE_ENV=test anywhere) ran
 * with a throwaway HOME and a stripped PATH but WALNUT_DAEMON_DIR pointed at the
 * production daemon dir. It restarted the prod daemon under that fake HOME, so
 * the spawn preamble resolved `$HOME/.local/bin` inside the throwaway tree and
 * every NEW session died with `exit 127 … exec: claude: not found` while older
 * sessions kept running.
 *
 * The old guard only refused test processes, which is why this walked straight
 * through it. These tests pin the posture rules (real user's HOME + real data
 * dir) and the owner-stamp verdicts that make a hijacked daemon self-describing.
 */
import { describe, it, expect, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {
  prodDaemonClaimRefusal,
  currentProdClaimPosture,
  classifyAdoptedDaemonOwner,
  ownerAuditKey,
  type ProdClaimPosture,
  type DaemonOwnerStamp,
  type DaemonOwnerIdentity,
} from '../../src/providers/daemon-ownership.js'
import { LocalDaemon } from '../../src/providers/local-daemon.js'

const REAL_HOME = (() => {
  try { return os.userInfo().homedir } catch { return os.homedir() }
})()

/** A posture that IS allowed to own the production daemon. */
function prodPosture(over: Partial<ProdClaimPosture> = {}): ProdClaimPosture {
  return {
    walnutHome: path.join(REAL_HOME, '.open-walnut'),
    envHome: REAL_HOME,
    realHome: REAL_HOME,
    isTestEnv: false,
    ...over,
  }
}

function stamp(over: Partial<DaemonOwnerStamp> = {}): DaemonOwnerStamp {
  return {
    walnutHome: path.join(REAL_HOME, '.open-walnut'),
    envHome: REAL_HOME,
    realHome: REAL_HOME,
    instanceId: 'd-100-aaaa',
    daemonPid: 100,
    serverPid: 99,
    claudeCli: path.join(REAL_HOME, '.local/bin/claude'),
    at: '2026-08-28T16:00:00.000Z',
    ...over,
  }
}

function identity(over: Partial<DaemonOwnerIdentity> = {}): DaemonOwnerIdentity {
  return {
    walnutHome: path.join(REAL_HOME, '.open-walnut'),
    envHome: REAL_HOME,
    realHome: REAL_HOME,
    ...over,
  }
}

describe('prodDaemonClaimRefusal', () => {
  it('lets the real user, on the real data dir, own the production daemon', () => {
    expect(prodDaemonClaimRefusal(prodPosture())).toBeNull()
  })

  it('REFUSES a faked HOME even when nothing marks the process as a test (2026-08-28)', () => {
    const refusal = prodDaemonClaimRefusal(prodPosture({
      envHome: '/tmp/walnut-board/server-home/fake-home',
    }))
    expect(refusal).toBeTruthy()
    // The message must name both homes: that is the whole diagnosis.
    expect(refusal).toContain('/tmp/walnut-board/server-home/fake-home')
    expect(refusal).toContain(REAL_HOME)
    expect(refusal).toContain('/tmp/open-walnut')
    expect(refusal).toContain('WALNUT_DAEMON_DIR')
  })

  it('still refuses test processes (the pre-existing guard)', () => {
    expect(prodDaemonClaimRefusal(prodPosture({ isTestEnv: true }))).toContain('test process')
  })

  it('ALLOWS a throwaway data dir under the real home: ephemeral local-daemon sharing is by design', () => {
    // An ephemeral server snapshots prod data into a temp dir and is documented
    // to share this machine's local daemon (DaemonConnection.isReadOnlyRemote:
    // "__local__ is exempt"). A different registry is not a broken toolchain, so
    // refusing here would break a shipped feature to fix a different bug.
    expect(prodDaemonClaimRefusal(prodPosture({
      walnutHome: path.join(os.tmpdir(), 'open-walnut-12345-abc'),
    }))).toBeNull()
  })

  it('does not fire on cosmetic HOME differences (trailing slash)', () => {
    expect(prodDaemonClaimRefusal(prodPosture({ envHome: REAL_HOME + '/' }))).toBeNull()
  })

  it('does not guess when there is no passwd entry to compare against', () => {
    // Some containers/CI images have no passwd row: realHome is unknown, so the
    // fake-HOME rule must stay silent rather than refuse every claim.
    expect(prodDaemonClaimRefusal(prodPosture({ realHome: '', envHome: '/somewhere/else' }))).toBeNull()
  })
})

describe('currentProdClaimPosture', () => {
  const originalHome = process.env.HOME

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  it('reads realHome from the passwd entry, so a faked $HOME cannot hide (os.homedir() can)', () => {
    process.env.HOME = '/tmp/fake-home-for-test'
    const posture = currentProdClaimPosture()
    expect(posture.envHome).toBe('/tmp/fake-home-for-test')
    expect(os.homedir()).toBe('/tmp/fake-home-for-test') // env-derived: useless as a signal
    expect(posture.realHome).toBe(REAL_HOME)

    // With the test flag out of the way, the fake HOME alone refuses.
    const refusal = prodDaemonClaimRefusal({
      ...posture, isTestEnv: false,
      walnutHome: path.join(REAL_HOME, '.open-walnut'),
    })
    expect(refusal).toContain('/tmp/fake-home-for-test')
  })

  it('reports this vitest process as a test env with a throwaway data dir', () => {
    const posture = currentProdClaimPosture()
    expect(posture.isTestEnv).toBe(true)
    expect(prodDaemonClaimRefusal(posture)).toBeTruthy()
  })
})

describe('classifyAdoptedDaemonOwner', () => {
  it('recognises the daemon we stamped', () => {
    expect(classifyAdoptedDaemonOwner(stamp(), identity(), 'd-100-aaaa')).toBe('ours')
  })

  it('treats a missing or pre-feature stamp as unknown, not as ours', () => {
    expect(classifyAdoptedDaemonOwner(null, identity(), 'd-100-aaaa')).toBe('unstamped')
    expect(classifyAdoptedDaemonOwner(stamp({ instanceId: null }), identity(), 'd-1')).toBe('unstamped')
  })

  it('flags a stamp from another instance (different data dir or HOME)', () => {
    expect(classifyAdoptedDaemonOwner(
      stamp({ instanceId: 'd-1', walnutHome: '/tmp/walnut-board/server-home/fake-home/.open-walnut' }),
      identity(), 'd-2',
    )).toBe('foreign-identity')
    expect(classifyAdoptedDaemonOwner(
      stamp({ instanceId: 'd-1', envHome: '/tmp/walnut-board/server-home/fake-home' }),
      identity(), 'd-2',
    )).toBe('foreign-identity')
  })

  it('flags a same-identity daemon that was spawned with no resolvable claude CLI', () => {
    expect(classifyAdoptedDaemonOwner(
      stamp({ instanceId: 'd-1', claudeCli: null }), identity(), 'd-2',
    )).toBe('no-claude')
  })

  it('calls an older incarnation of our own daemon a stale stamp, not a hijack', () => {
    expect(classifyAdoptedDaemonOwner(stamp({ instanceId: 'd-1' }), identity(), 'd-2')).toBe('stale-stamp')
  })
})

describe('ownerAuditKey', () => {
  it('suppresses the same news but not a daemon that changed under us', () => {
    const a = ownerAuditKey('unstamped', 'd-1', null)
    expect(ownerAuditKey('unstamped', 'd-1', null)).toBe(a)
    // A new incarnation, or a stamp appearing, must produce a NEW key: otherwise
    // the latch would hide a real takeover behind an earlier benign warning.
    expect(ownerAuditKey('unstamped', 'd-2', null)).not.toBe(a)
    expect(ownerAuditKey('foreign-identity', 'd-1', 'd-0')).not.toBe(a)
  })
})

describe('LocalDaemon.ensureRunning', () => {
  it('refuses the production daemon dir from this test process without touching it', async () => {
    const daemon = new LocalDaemon({ daemonDir: '/tmp/open-walnut' })
    await expect(daemon.ensureRunning()).rejects.toThrow(/Refusing to touch the production daemon dir/)
    expect(daemon.port).toBeNull()
  })

  it('refuses before it looks for a binary, pings, or restarts anything', async () => {
    // Order matters: the whole point is that a foreign-posture process performs
    // NO action on the shared dir, so the guard has to precede the version check
    // (which restarts the daemon) as well as the spawn.
    const daemon = new LocalDaemon({ daemonDir: '/tmp/open-walnut', binaryPath: '/nonexistent/daemon-binary' })
    await expect(daemon.ensureRunning()).rejects.toThrow(/Refusing to touch the production daemon dir/)
  })
})
