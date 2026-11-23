/**
 * One daemon update at a time per daemon, whichever of its host names starts it
 * (src/providers/daemon-update-claim.ts). 2026-11-22: clouddev (host network) and newdev (SSH),
 * one daemon, each updated it on its own; 4.66 GB went up in a day for updates that failed on
 * the other's lock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UPDATE_CLAIM_MAX_MS, UPDATE_CLAIM_SETTLE_MS, claimDaemonUpdate, daemonUpdateHeldBy, peerUpdatingWhy, resetDaemonUpdateClaims,
} from '../../src/providers/daemon-update-claim.js'

afterEach(() => resetDaemonUpdateClaims())

const names = (...n: string[]) => async () => n

describe('claimDaemonUpdate', () => {
  it('a claim holds the daemon for its other names, never for itself or another daemon', async () => {
    const c = await claimDaemonUpdate('clouddev', names('clouddev', 'newdev'), 1_000)
    expect('heldBy' in c).toBe(false)
    expect(await claimDaemonUpdate('newdev', names('clouddev', 'newdev'), 1_001)).toEqual({ heldBy: 'clouddev' })
    expect(await daemonUpdateHeldBy('newdev', names('newdev', 'clouddev'), 1_001)).toBe('clouddev')
    expect(await daemonUpdateHeldBy('clouddev', names('clouddev', 'newdev'), 1_001)).toBeNull()
    expect(await daemonUpdateHeldBy('olddev', names('olddev'), 1_001)).toBeNull()
  })

  it('reads no names while nothing else is claimed (the common case costs no I/O)', async () => {
    const read = vi.fn(async () => ['a', 'b'])
    const mine = await claimDaemonUpdate('a', read)
    expect('heldBy' in mine).toBe(false)
    expect(await daemonUpdateHeldBy('a', read)).toBeNull()
    expect(read).not.toHaveBeenCalled()
    expect(await daemonUpdateHeldBy('b', read)).toBe('a')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('names that cannot be read are just this one: the update is not held by them', async () => {
    await claimDaemonUpdate('clouddev', names('clouddev'))
    expect(await claimDaemonUpdate('newdev', async () => { throw new Error('profile unreadable') })).not.toHaveProperty('heldBy')
  })

  it('an update that went through holds the others for the settle window only; one that failed frees them at once', async () => {
    const ok = await claimDaemonUpdate('clouddev', names('newdev'))
    if ('heldBy' in ok) throw new Error('unexpected')
    ok.release(true)
    expect(await daemonUpdateHeldBy('newdev', names('clouddev'), Date.now() + UPDATE_CLAIM_SETTLE_MS - 5_000)).toBe('clouddev')
    expect(await daemonUpdateHeldBy('newdev', names('clouddev'), Date.now() + UPDATE_CLAIM_SETTLE_MS + 5_000)).toBeNull()
    const bad = await claimDaemonUpdate('newdev', names('clouddev'))
    if ('heldBy' in bad) throw new Error('unexpected')
    bad.release(false)
    bad.release(true) // a second release changes nothing
    expect(await daemonUpdateHeldBy('clouddev', names('newdev'))).toBeNull()
  })

  it('a claim nobody released (a server stopped mid-update) lets go after its bound', async () => {
    await claimDaemonUpdate('clouddev', names('newdev'), 0)
    expect(await daemonUpdateHeldBy('newdev', names('clouddev'), UPDATE_CLAIM_MAX_MS - 1)).toBe('clouddev')
    expect(await daemonUpdateHeldBy('newdev', names('clouddev'), UPDATE_CLAIM_MAX_MS + 1)).toBeNull()
  })

  it('two names asking at once: the one whose names came back second sees the first claim', async () => {
    await claimDaemonUpdate('olddev', names('olddev'))   // some other claim: both read their names
    let open!: () => void
    const slow = () => new Promise<string[]>((r) => { open = () => r(['newdev', 'clouddev']) })
    const second = claimDaemonUpdate('newdev', slow)
    const first = await claimDaemonUpdate('clouddev', names('clouddev', 'newdev'))
    expect('heldBy' in first).toBe(false)
    open()
    expect(await second).toEqual({ heldBy: 'clouddev' })
  })

  it('a host name with spaces or Unicode is a name like any other', async () => {
    const name = 'Studio’s Mac \u{1F680}'
    await claimDaemonUpdate(name, names('studio'))
    expect(await daemonUpdateHeldBy('studio', names(name))).toBe(name)
    expect(peerUpdatingWhy(name)).toBe(`${name} reaches the same daemon and is updating it, or just did`)
  })
})
