/**
 * The leader's word on a host's mode (src/providers/one-service-mode.ts): when the one Walnut
 * service is offered, when a host goes back to the daemon, and when nothing changes. The switch
 * rides the daemon update, so "due" here is "an update is due" in daemon-connection.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OFFER_NOT_SURE, platformOf, serviceModeAsk, serviceModeDue, serviceModeWantNow, servesAsHere, servesFromHello, servesThisWalnut, wantedServiceMode, type ServiceModeFacts,
} from '../../src/providers/one-service-mode.js'

const HOME = '/home/someone/.open-walnut'
const base: ServiceModeFacts = { experiment: true, serves: 'daemon', serviceHome: null, home: HOME, launcher: true, platform: 'linux', follower: { kind: 'replica' } }
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

  // Review of the default flip (M1): the walnut file goes into a Linux daemon slot only, so a macOS
  // host (a laptop such as a person's own MacBook joined as a host) is decided up front: never --serve,
  // so it never takes an update that fails for it; one whose system is not known yet is left as it is.
  it('a host that is not Linux is never offered, with the reason; one whose system is not known is left as it is', () => {
    for (const platform of ['darwin', 'win32', 'freebsd']) {
      const facts = f({ platform })
      const w = wantedServiceMode(facts)
      expect(w.want, platform).toBe('daemon')
      expect(w.why, platform).toMatch(/runs (macOS|Windows|freebsd), and the one Walnut service runs on Linux hosts only for now/)
      expect(serviceModeDue(w, 'daemon')).toBe(false)
      expect(serviceModeAsk(w, facts)).toBeUndefined()
    }
    // A service of this Walnut on such a host (never made, but read so) goes back.
    const serving = f({ platform: 'darwin', serves: 'walnut-serve', serviceHome: HOME })
    expect(serviceModeAsk(wantedServiceMode(serving), serving)).toEqual({ home: HOME, on: false })
    for (const serves of ['daemon', 'walnut-serve'] as const) {
      const w = wantedServiceMode(f({ platform: null, serves, serviceHome: serves === 'walnut-serve' ? HOME : null }))
      expect(w).toEqual({ want: null })
    }
    expect(platformOf('Linux\n')).toBe('linux')
    expect(platformOf('darwin')).toBe('darwin')
    for (const bad of [undefined, null, 42, '', 'a b', '../x']) expect(platformOf(bad)).toBeNull()
  })

  // Review of the default flip (L3): a server the person turned off there is their choice, no Health item.
  it('a host whose Walnut server the person turned off is not offered, and has nothing to report', () => {
    const w = wantedServiceMode(f({ follower: { kind: 'none' } }))
    expect(w).toEqual({ want: 'daemon' })
    expect(serviceModeDue(w, 'daemon')).toBe(false)
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
    serveUnfit: null, modeAsked: vi.fn(async () => null), platform: vi.fn(async (): Promise<string | null> => 'linux'),
    offerWanted: vi.fn(async () => true), launcherWanted: vi.fn(async () => true),
    follower: vi.fn(async () => ({ kind: 'replica' as const })), note: vi.fn(), noteOff: vi.fn(),
    ...patch,
  })

  it('experiments off and a daemon host: nothing else is read, nothing is noted', async () => {
    const i = inputs({ offerWanted: vi.fn(async () => false) })
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

  it('the system is read only with the experiments on; macOS is decided before any update, a failed read leaves the mode', async () => {
    const off = inputs({ offerWanted: vi.fn(async () => false) })
    await serviceModeWantNow(off)
    expect(off.platform).not.toHaveBeenCalled()
    const mac = inputs({ platform: vi.fn(async () => 'darwin') })
    await expect(serviceModeWantNow(mac)).resolves.toMatchObject({ want: 'daemon', why: expect.stringMatching(/macOS/) })
    expect(mac.note).toHaveBeenCalledWith(expect.objectContaining({ want: 'daemon' }))
    await expect(serviceModeWantNow(inputs({ platform: vi.fn(async () => { throw new Error('no profile') }) }))).resolves.toEqual({ want: null })
  })

  it('a follower read that fails is not settled', async () => {
    const i = inputs({ follower: vi.fn(async () => { throw new Error('no manager') }) })
    await expect(serviceModeWantNow(i)).resolves.toEqual({ want: null })
  })
})

// The host offer is read live, per host, from the leader's config: every host by default, a host the
// config keeps off it (hosts.<name>.service_offer: false, or a list host_service_offer that leaves it out)
// not; neither in_process_daemon nor the per-process switch of this computer's own runtime
// (WALNUT_IN_PROCESS_DAEMON) changes it.
describe('hostServiceOfferWanted', () => {
  const KEYS = ['WALNUT_HOST_SERVICE_OFFER', 'WALNUT_IN_PROCESS_DAEMON', 'WALNUT_SERVICE_LAUNCHER'] as const
  let saved: Record<string, string | undefined> = {}
  beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) })
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    vi.doUnmock('../../src/core/config-manager.js')
    vi.resetModules()
  })
  const withConfig = async (config: Record<string, unknown>) => {
    vi.resetModules()
    vi.doMock('../../src/core/config-manager.js', () => ({ getConfig: async () => config }))
    return (await import('../../src/providers/service-launcher-flag.js')).hostServiceOfferWanted
  }
  const withExperiment = (on: boolean) => withConfig({ experimental: { in_process_daemon: on } })

  it('this process running its own runtime in process (WALNUT_IN_PROCESS_DAEMON) does not change the offer', async () => {
    delete process.env.WALNUT_HOST_SERVICE_OFFER
    for (const env of ['1', '0']) {
      process.env.WALNUT_IN_PROCESS_DAEMON = env
      await expect((await withConfig({ experimental: { in_process_daemon: false }, host_service_offer: [] }))('devbox'), env).resolves.toBe(false)
      await expect((await withExperiment(false))('devbox'), env).resolves.toBe(true)
    }
  })

  // 2026-11-23: in_process_daemon on offered every host under the launcher (a macOS host that had never
  // run the service among them) and taking a host out of the list changed nothing. The list alone decides.
  it('in_process_daemon offers no host anything: only the list does, one host by one', async () => {
    delete process.env.WALNUT_HOST_SERVICE_OFFER
    process.env.WALNUT_IN_PROCESS_DAEMON = '0'
    for (const on of [true, false]) {
      const offer = await withConfig({ experimental: { in_process_daemon: on, service_launcher: true }, host_service_offer: ['devbox'] })
      await expect(offer('devbox'), `experiment ${on}`).resolves.toBe(true)
      await expect(offer('gpu-box'), `experiment ${on}`).resolves.toBe(false)
    }
    // A host taken out of the list is not offered, with this computer's runtime still in process.
    await expect((await withConfig({ experimental: { in_process_daemon: true }, host_service_offer: [] }))('devbox')).resolves.toBe(false)
    // The process's own switch still decides alone.
    process.env.WALNUT_HOST_SERVICE_OFFER = '1'
    await expect((await withExperiment(false))('devbox')).resolves.toBe(true)
    process.env.WALNUT_HOST_SERVICE_OFFER = '0'
    await expect((await withConfig({ experimental: { in_process_daemon: true }, host_service_offer: ['devbox'] }))('devbox')).resolves.toBe(false)
  })

  // The default flip (2026-11-24): with no list every host is offered; a list kept from when the offer
  // went to chosen hosts only keeps that choice ([] offers none). A hand-edited non-list is no list.
  it('no list (or a hand-edited non-list) offers every host; an empty list offers none, whatever the experiment says', async () => {
    delete process.env.WALNUT_HOST_SERVICE_OFFER
    for (const list of [undefined, 'devbox', { devbox: true }, null]) {
      for (const on of [false, true]) {
        const cfg = { experimental: { in_process_daemon: on }, ...(list === undefined ? {} : { host_service_offer: list }) }
        await expect((await withConfig(cfg))('devbox'), `${JSON.stringify(list)} ${on}`).resolves.toBe(true)
      }
    }
    await expect((await withConfig({ host_service_offer: [] }))('devbox')).resolves.toBe(false)
  })

  // What a public install reads with nothing stored (no experiment, no list, no env): both inputs of the
  // offer the host-server manager's one-service gate reads (daemon-connection.ts oneServiceWanted) are on,
  // so its "never demote a host meant to be the one service" guards cover every host under the launcher.
  it('with nothing stored, a host under the launcher is offered its one service, and the mode decision wants it', async () => {
    for (const k of KEYS) delete process.env[k]
    const offer = await withConfig({})
    const { serviceLauncherWanted } = await import('../../src/providers/service-launcher-flag.js')
    await expect(offer('devbox')).resolves.toBe(true)
    await expect(serviceLauncherWanted()).resolves.toBe(true)
    await expect(serviceModeWantNow({
      serves: 'daemon', serviceHome: null, home: HOME, launcher: true, expected: 'walnut-daemon-new', serveUnfit: null,
      modeAsked: async () => null, offerWanted: () => offer('devbox'), launcherWanted: serviceLauncherWanted, platform: async () => 'linux',
      follower: async () => ({ kind: 'replica' as const }),
    })).resolves.toEqual({ want: 'walnut-serve' })
    // A stored false of the experiment still turns the whole offer off.
    const off = await withConfig({ experimental: { service_launcher: false } })
    await expect(off('devbox')).resolves.toBe(true)
    await expect((await import('../../src/providers/service-launcher-flag.js')).serviceLauncherWanted()).resolves.toBe(false)
  })

  it('hosts.<name>.service_offer keeps one host on two programs, or offers it past a list', async () => {
    delete process.env.WALNUT_HOST_SERVICE_OFFER
    const offer = await withConfig({ hosts: { devbox: { service_offer: false }, 'gpu-box': {}, lab: { service_offer: 'no' } } })
    await expect(offer('devbox')).resolves.toBe(false)
    await expect(offer('gpu-box')).resolves.toBe(true)
    // Only a boolean counts.
    await expect(offer('lab')).resolves.toBe(true)
    const listed = await withConfig({ host_service_offer: ['devbox'], hosts: { devbox: { service_offer: false }, 'gpu-box': { service_offer: true }, lab: {} } })
    await expect(listed('devbox')).resolves.toBe(false)
    await expect(listed('gpu-box')).resolves.toBe(true)
    await expect(listed('lab')).resolves.toBe(false)
  })

  it('this computer\'s own daemon is never offered it, and a follower offers nothing', async () => {
    delete process.env.WALNUT_HOST_SERVICE_OFFER
    await expect((await withConfig({}))('__local__')).resolves.toBe(false)
    await expect((await withConfig({ host_service_offer: ['__local__'] }))('__local__')).resolves.toBe(false)
    vi.doMock('../../src/core/server-role.js', async (orig) => ({ ...(await orig<object>()), isFollower: () => true }))
    try {
      await expect((await import('../../src/providers/service-launcher-flag.js')).hostServiceOfferWanted('devbox')).resolves.toBe(false)
    } finally {
      vi.doUnmock('../../src/core/server-role.js')
    }
  })

  // Two names of one machine get one answer: a false of either wins; only an offer of a name that may be
  // this machine (its id not known yet) and would change the answer makes it not sure (null).
  it('an opt-out of another name of the same machine keeps this name off too', async () => {
    delete process.env.WALNUT_HOST_SERVICE_OFFER
    const offer = await withConfig({ hosts: { devbox: { service_offer: false }, 'devbox-alias': {}, 'gpu-box': {}, newbox: {} } })
    const ids: Record<string, string | null> = { devbox: 'm-1', 'devbox-alias': 'm-1', 'gpu-box': 'm-2', newbox: null }
    const idOf = (k: string) => ids[k] ?? null
    await expect(offer('devbox-alias', idOf)).resolves.toBe(false)
    await expect(offer('gpu-box', idOf)).resolves.toBe(true)
    // An opt-out spreads only to a name proven to be its machine (review of the default flip, M2):
    // this name's machine not known yet, or the opt-out's, is another machine.
    await expect(offer('newbox', idOf)).resolves.toBe(true)
    ids.devbox = null
    await expect(offer('gpu-box', idOf)).resolves.toBe(true)
    // No opt-out anywhere: every name is offered, known machine or not.
    const all = await withConfig({ hosts: { devbox: {}, newbox: {} } })
    await expect(all('newbox', idOf)).resolves.toBe(true)
  })

  it('the list switches on nothing else: this computer\'s own runtime stays a program', async () => {
    delete process.env.WALNUT_HOST_SERVICE_OFFER
    delete process.env.WALNUT_IN_PROCESS_DAEMON
    await withConfig({ experimental: { in_process_daemon: false }, host_service_offer: ['devbox', '__local__'] })
    const { inProcessDaemonWanted } = await import('../../src/providers/in-process-daemon.js')
    await expect(inProcessDaemonWanted()).resolves.toBe(false)
  })

  // Offer-list review M1: two config names for one machine (the same hello machine id) are one box,
  // so listing one of them never switches the box back and forth between the two names.
  it('a name of the same machine counts as listed; an unknown machine id is "not sure" (null)', async () => {
    delete process.env.WALNUT_HOST_SERVICE_OFFER
    const offer = await withConfig({ experimental: { in_process_daemon: false }, host_service_offer: ['devbox'] })
    const ids: Record<string, string | null> = { devbox: 'm-1', 'devbox-alias': 'm-1', 'gpu-box': 'm-2', newbox: null }
    const idOf = (k: string) => ids[k] ?? null
    await expect(offer('devbox-alias', idOf)).resolves.toBe(true)
    await expect(offer('gpu-box', idOf)).resolves.toBe(false)
    // This connection's machine is not known yet: no answer either way.
    await expect(offer('newbox', idOf)).resolves.toBeNull()
    // A listed name whose machine is not known yet: not sure, unless another listed name is this machine.
    ids.devbox = null
    await expect(offer('gpu-box', idOf)).resolves.toBeNull()
    // No lookup given: by name only.
    await expect(offer('devbox-alias')).resolves.toBe(false)
  })

  // Review of the default flip (M2): an offer left open is no longer silent: one Walnut Health item
  // says why (only while service_launcher is on), and nothing else is read.
  it('serviceModeWantNow leaves the mode as it is while the offer is not sure, and says so once', async () => {
    const i = {
      serves: 'walnut-serve' as const, serviceHome: HOME, home: HOME, launcher: true, expected: 'walnut-daemon-new',
      serveUnfit: null, modeAsked: vi.fn(async () => null), offerWanted: vi.fn(async () => null), platform: vi.fn(async () => 'linux'),
      launcherWanted: vi.fn(async () => true), follower: vi.fn(async () => ({ kind: 'replica' as const })), note: vi.fn(), noteOff: vi.fn(),
    }
    await expect(serviceModeWantNow(i)).resolves.toEqual({ want: null })
    expect(i.note).toHaveBeenCalledWith({ want: null, why: OFFER_NOT_SURE })
    expect(i.follower).not.toHaveBeenCalled()
    expect(i.platform).not.toHaveBeenCalled()
    const quiet = { ...i, note: vi.fn(), launcherWanted: vi.fn(async () => false) }
    await expect(serviceModeWantNow(quiet)).resolves.toEqual({ want: null })
    expect(quiet.note).not.toHaveBeenCalled()
  })

  // Review of the default flip (M2): one host kept on two programs whose machine is not known (offline,
  // asleep, never connected) held every other host at "not sure", silently. It is another machine now.
  it('an opt-out whose machine is not known is another machine: the other hosts are offered', async () => {
    delete process.env.WALNUT_HOST_SERVICE_OFFER
    const offer = await withConfig({ hosts: { box: {}, laptop: { service_offer: false }, other: {} } })
    const ids: Record<string, string | null> = { box: 'M1', laptop: null, other: 'M2' }
    const idOf = (k: string) => ids[k] ?? null
    await expect(offer('box', idOf)).resolves.toBe(true)
    await expect(offer('other', idOf)).resolves.toBe(true)
    await expect(offer('laptop', idOf)).resolves.toBe(false)
    // Once its machine is known: still its own choice only, unless it is the same machine.
    ids.laptop = 'M3'
    await expect(offer('box', idOf)).resolves.toBe(true)
    ids.laptop = 'M1'
    await expect(offer('box', idOf)).resolves.toBe(false)
    await expect(offer('other', idOf)).resolves.toBe(true)
  })

  it('a host row turned off (enabled: false) decides nothing for another name', async () => {
    delete process.env.WALNUT_HOST_SERVICE_OFFER
    const offer = await withConfig({ hosts: { box: {}, old: { enabled: false, service_offer: false }, listed: { enabled: false, service_offer: true } }, host_service_offer: ['box'] })
    const ids: Record<string, string | null> = { box: 'M1', old: 'M1', listed: null, plain: 'M9' }
    const idOf = (k: string) => ids[k] ?? null
    await expect(offer('box', idOf)).resolves.toBe(true)
    // Not listed, and the disabled row that offered and may be this machine is not asked.
    await expect(offer('plain', idOf)).resolves.toBe(false)
  })

  // The leader's own config before the flip (task brief, 2026-11-25): a list that chose four hosts keeps its
  // meaning after it: those four are offered, every other host is not, with and without machine ids.
  it('an existing list [old-box, cloud-box, home-box, pod-box-0] reads the same after the flip', async () => {
    delete process.env.WALNUT_HOST_SERVICE_OFFER
    const LIST = ['old-box', 'cloud-box', 'home-box', 'pod-box-0']
    const offer = await withConfig({
      experimental: { service_launcher: true, in_process_daemon: true },
      host_service_offer: LIST,
      hosts: { 'old-box': {}, 'cloud-box': {}, 'home-box': {}, 'pod-box-0': {}, 'marina-macbook': {}, 'gpu-box': {}, newdev: {} },
    })
    const ids: Record<string, string> = { 'old-box': 'm-old', 'cloud-box': 'm-cloud', 'home-box': 'm-pc', 'pod-box-0': 'm-eks', 'marina-macbook': 'm-mac', 'gpu-box': 'm-gpu', newdev: 'm-new', 'never-configured': 'm-x' }
    for (const idOf of [undefined, (k: string) => ids[k] ?? null]) {
      for (const k of LIST) await expect(offer(k, idOf), k).resolves.toBe(true)
      for (const k of ['marina-macbook', 'gpu-box', 'newdev', 'never-configured']) await expect(offer(k, idOf), k).resolves.toBe(false)
    }
    // A connection whose machine is not known yet may be one of the four: left as it is (null), as before the flip.
    await expect(offer('unknown-box', (k) => ids[k] ?? null)).resolves.toBeNull()
  })

})
