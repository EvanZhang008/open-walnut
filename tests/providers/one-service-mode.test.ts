/**
 * The leader's word on a host's mode (src/providers/one-service-mode.ts): when the one Walnut
 * service is offered, when a host goes back to the daemon, and when nothing changes. The switch
 * rides the daemon update, so "due" here is "an update is due" in daemon-connection.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  serviceModeAsk, serviceModeDue, serviceModeWantNow, servesAsHere, servesFromHello, servesThisWalnut, wantedServiceMode, type ServiceModeFacts,
} from '../../src/providers/one-service-mode.js'

const HOME = '/home/someone/.open-walnut'
const base: ServiceModeFacts = { experiment: true, serves: 'daemon', serviceHome: null, home: HOME, launcher: true, follower: { kind: 'replica' } }
const f = (patch: Partial<ServiceModeFacts>): ServiceModeFacts => ({ ...base, ...patch })

describe('wantedServiceMode', () => {
  it('offers the service to a launcher host that runs this Walnut\'s full follower', () => {
    const w = wantedServiceMode(base)
    expect(w).toEqual({ want: 'walnut-serve' })
    expect(serviceModeDue(w, 'daemon')).toBe(true)
    expect(serviceModeAsk(w, base)).toEqual({ home: HOME, on: true })
  })

  it('a host that already serves this Walnut is not due again (its next build carries --serve)', () => {
    const facts = f({ serves: 'walnut-serve', serviceHome: HOME })
    const w = wantedServiceMode(facts)
    expect(serviceModeDue(w, 'walnut-serve')).toBe(false)
    expect(serviceModeAsk(w, facts)).toEqual({ home: HOME, on: true })
  })

  it.each([
    ['no launcher', f({ launcher: false }), /service launcher/],
    ['no follower', f({ follower: { kind: 'none', why: 'no Walnut server of this Walnut runs there' } }), /no Walnut server/],
    ['no walnut file', f({ walnutFileUnfit: 'no release publishes it' }), /walnut file cannot go to the host: no release publishes it/],
  ])('%s: no offer, and the reason for Walnut Health', (_name, facts, why) => {
    const w = wantedServiceMode(facts)
    expect(w.want).toBe('daemon')
    expect(w.why).toMatch(why)
    expect(serviceModeDue(w, 'daemon')).toBe(false)
    expect(serviceModeAsk(w, facts)).toBeUndefined()
  })

  it('a follower not settled yet changes nothing, whichever way the host runs', () => {
    for (const serves of ['daemon', 'walnut-serve'] as const) {
      const w = wantedServiceMode(f({ follower: { kind: 'unknown' }, serves, serviceHome: serves === 'walnut-serve' ? HOME : null }))
      expect(w.want).toBeNull()
      expect(serviceModeDue(w, serves)).toBe(false)
    }
  })

  it('this Walnut\'s service whose follower went away goes back to the daemon with --no-serve', () => {
    const facts = f({ serves: 'walnut-serve', serviceHome: HOME, follower: { kind: 'none', why: 'no Walnut server of this Walnut runs there' } })
    const w = wantedServiceMode(facts)
    expect(serviceModeDue(w, 'walnut-serve')).toBe(true)
    expect(serviceModeAsk(w, facts)).toEqual({ home: HOME, on: false })
  })

  it('experiments off: a daemon host is left as it is, this Walnut\'s service goes back', () => {
    expect(wantedServiceMode(f({ experiment: false }))).toEqual({ want: null })
    const facts = f({ experiment: false, serves: 'walnut-serve', serviceHome: HOME })
    const w = wantedServiceMode(facts)
    expect(w).toEqual({ want: 'daemon' })
    expect(serviceModeAsk(w, facts)).toEqual({ home: HOME, on: false })
  })

  it('another Walnut\'s service is never switched from here, on or off', () => {
    for (const experiment of [true, false]) {
      const facts = f({ experiment, serves: 'walnut-serve', serviceHome: '/home/other/.open-walnut' })
      const w = wantedServiceMode(facts)
      expect(w.want).toBeNull()
      expect(serviceModeAsk(w, facts)).toBeUndefined()
    }
  })

  it('a switch this build asked for that did not take is not asked again with it, either way', () => {
    const w = wantedServiceMode(f({ askedAndRefused: { want: 'walnut-serve' } }))
    expect(w.want).toBeNull()
    expect(w.why).toMatch(/took this build's update .* still runs as the session helper \(its service log says why\)/)
    const back = wantedServiceMode(f({ experiment: false, serves: 'walnut-serve', serviceHome: HOME, askedAndRefused: { want: 'daemon' } }))
    expect(back.want).toBeNull()
    expect(back.why).toMatch(/still runs as the Walnut service/)
    // One that took is asked as usual (the next build carries the word again).
    expect(wantedServiceMode(f({ serves: 'walnut-serve', serviceHome: HOME, askedAndRefused: { want: 'walnut-serve' } }))).toEqual({ want: 'walnut-serve' })
  })

  // M1 (a3b land 2 review): an update that failed says so, not "its service log says why".
  it('a switch whose update failed names the failure, not the service log', () => {
    const w = wantedServiceMode(f({ askedAndRefused: { want: 'walnut-serve', failed: 'the new service did not answer in 120 s.' } }))
    expect(w.want).toBeNull()
    expect(w.why).toMatch(/did not go through \(the new service did not answer in 120 s\), so it still runs as the session helper/)
    expect(w.why).not.toMatch(/service log/)
  })
})

// Review A3b S34-L3: a host where a declared move made this data dir an alias names this Walnut by its first home there.
describe('after a declared home move: servesAsHere and serviceModeAsk', () => {
  const HOME = '/u/new-home', FIRST = '/u/first-home'
  it('the service of the host\'s home for this Walnut is this Walnut\'s; without that word, another Walnut\'s', () => {
    expect(servesAsHere({ serves: 'walnut-serve', serviceHome: FIRST }, HOME, FIRST)).toEqual({ serves: 'walnut-serve', serviceHome: HOME })
    expect(servesThisWalnut(servesAsHere({ serves: 'walnut-serve', serviceHome: FIRST }, HOME, FIRST), HOME)).toBe(true)
    expect(servesAsHere({ serves: 'walnut-serve', serviceHome: FIRST }, HOME, null)).toEqual({ serves: 'walnut-serve', serviceHome: FIRST })
    expect(servesAsHere({ serves: 'walnut-serve', serviceHome: '/u/other' }, HOME, FIRST)).toEqual({ serves: 'walnut-serve', serviceHome: '/u/other' })
    expect(servesAsHere({ serves: 'daemon', serviceHome: null }, HOME, FIRST)).toEqual({ serves: 'daemon', serviceHome: null })
  })
  it('the words name the Walnut as the host keeps it', () => {
    expect(serviceModeAsk({ want: 'walnut-serve' }, { serves: 'daemon', serviceHome: null, home: HOME, homeHere: FIRST })).toEqual({ home: FIRST, on: true })
    expect(serviceModeAsk({ want: 'daemon' }, { serves: 'walnut-serve', serviceHome: HOME, home: HOME, homeHere: FIRST })).toEqual({ home: FIRST, on: false })
    expect(serviceModeAsk({ want: 'walnut-serve' }, { serves: 'daemon', serviceHome: null, home: HOME, homeHere: null })).toEqual({ home: HOME, on: true })
  })
})

describe('servesFromHello', () => {
  it('an older host says nothing: the daemon', () => {
    expect(servesFromHello({})).toEqual({ serves: 'daemon', serviceHome: null })
    expect(servesFromHello({ serves: 'daemon', serviceHome: HOME })).toEqual({ serves: 'daemon', serviceHome: null })
  })
  it('the service names whose follower it is; a malformed home reads as none', () => {
    expect(servesFromHello({ serves: 'walnut-serve', serviceHome: HOME })).toEqual({ serves: 'walnut-serve', serviceHome: HOME })
    expect(servesFromHello({ serves: 'walnut-serve', serviceHome: 'relative' })).toEqual({ serves: 'walnut-serve', serviceHome: null })
    expect(servesFromHello({ serves: 'walnut-serve' })).toEqual({ serves: 'walnut-serve', serviceHome: null })
  })
})

describe('serviceModeWantNow', () => {
  const inputs = (patch: Partial<Parameters<typeof serviceModeWantNow>[0]> = {}) => ({
    serves: 'daemon' as const, serviceHome: null, home: HOME, launcher: true, expected: 'walnut-daemon-new',
    serveUnfit: null, modeAsked: vi.fn(async () => null),
    inProcessWanted: vi.fn(async () => true), launcherWanted: vi.fn(async () => true),
    follower: vi.fn(async () => ({ kind: 'replica' as const })), note: vi.fn(), noteOff: vi.fn(),
    ...patch,
  })

  it('experiments off and a daemon host: nothing else is read, nothing is noted', async () => {
    const i = inputs({ inProcessWanted: vi.fn(async () => false) })
    await expect(serviceModeWantNow(i)).resolves.toEqual({ want: null })
    expect(i.launcherWanted).not.toHaveBeenCalled()
    expect(i.follower).not.toHaveBeenCalled()
    expect(i.modeAsked).not.toHaveBeenCalled()
    expect(i.note).not.toHaveBeenCalled()
    expect(i.noteOff).toHaveBeenCalledTimes(1)
  })

  it('on: the follower is asked and the decision noted for Walnut Health', async () => {
    const i = inputs()
    await expect(serviceModeWantNow(i)).resolves.toEqual({ want: 'walnut-serve' })
    expect(i.note).toHaveBeenCalledWith({ want: 'walnut-serve' })
  })

  it('a walnut file found unfit, or a switch refused, counts for that build only', async () => {
    const unfit = { expected: 'walnut-daemon-new', why: 'no file' }
    await expect(serviceModeWantNow(inputs({ serveUnfit: unfit }))).resolves.toMatchObject({ want: 'daemon' })
    await expect(serviceModeWantNow(inputs({ serveUnfit: { ...unfit, expected: 'walnut-daemon-old' } }))).resolves.toEqual({ want: 'walnut-serve' })
    await expect(serviceModeWantNow(inputs({ modeAsked: async () => ({ expected: 'walnut-daemon-new', want: 'walnut-serve' as const }) }))).resolves.toMatchObject({ want: null })
    await expect(serviceModeWantNow(inputs({ modeAsked: async () => ({ expected: 'walnut-daemon-old', want: 'walnut-serve' as const }) }))).resolves.toEqual({ want: 'walnut-serve' })
    // A record that cannot be read leaves the decision as with none.
    await expect(serviceModeWantNow(inputs({ modeAsked: async () => { throw new Error('unreadable') } }))).resolves.toEqual({ want: 'walnut-serve' })
  })

  it('a follower read that fails is not settled', async () => {
    const i = inputs({ follower: vi.fn(async () => { throw new Error('no manager') }) })
    await expect(serviceModeWantNow(i)).resolves.toEqual({ want: null })
  })
})

// a3b land 2 review M4: the host offer is the in_process_daemon experiment, read live, and not the
// per-process switch of this computer's own runtime (WALNUT_IN_PROCESS_DAEMON).
describe('hostServiceOfferWanted', () => {
  const KEYS = ['WALNUT_HOST_SERVICE_OFFER', 'WALNUT_IN_PROCESS_DAEMON'] as const
  let saved: Record<string, string | undefined> = {}
  beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) })
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    vi.doUnmock('../../src/core/config-manager.js')
    vi.resetModules()
  })
  const withExperiment = async (on: boolean) => {
    vi.resetModules()
    vi.doMock('../../src/core/config-manager.js', () => ({ getConfig: async () => ({ experimental: { in_process_daemon: on } }) }))
    return (await import('../../src/providers/service-launcher-flag.js')).hostServiceOfferWanted
  }

  it('this process running its own runtime in process (WALNUT_IN_PROCESS_DAEMON=1) offers no host anything', async () => {
    delete process.env.WALNUT_HOST_SERVICE_OFFER
    process.env.WALNUT_IN_PROCESS_DAEMON = '1'
    await expect((await withExperiment(false))()).resolves.toBe(false)
  })

  it('follows the experiment as it is now; its own switch decides for one process', async () => {
    delete process.env.WALNUT_HOST_SERVICE_OFFER
    process.env.WALNUT_IN_PROCESS_DAEMON = '0'
    await expect((await withExperiment(true))()).resolves.toBe(true)
    process.env.WALNUT_HOST_SERVICE_OFFER = '0'
    await expect((await withExperiment(true))()).resolves.toBe(false)
  })
})
