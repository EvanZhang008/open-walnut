/**
 * The leader's word on what a host's `--service` runs for this Walnut (src/binary/service-entry.ts):
 * the session daemon, as every host had, or the host's one Walnut service (this Walnut's follower
 * server holding the daemon runtime in one process). Pure: daemon-connection.ts gathers the facts.
 *
 * The switch rides the daemon update (daemon-service-update.ts adds `--serve <home>` or
 * `--no-serve <home>`): a wanted mode that differs from what the hello says is an update due,
 * with the same holds and probation as a new build.
 *
 * Offered only with the experiment service_launcher on and the offer on for the host (every host
 * unless the config keeps it on two programs, read live, per host: service-launcher-flag.ts
 * hostServiceOfferWanted), to a host whose system the one table lets take it (one-service-targets.ts
 * servePlatformWhy: Linux, and a Mac with the experiment macos_one_service on; any other is never
 * asked, so it never sees an update that fails for it) whose
 * daemon already runs under the launcher, that runs this Walnut's full follower (`web --replica`,
 * the spec the service starts from), and that can take this build's walnut file (the daemon-only
 * binary holds no server). Otherwise no offer, with the reason for Walnut Health. With the
 * experiments off nothing changes on a host that runs as the daemon; one this Walnut switched
 * before is switched back.
 */
import { servePlatformWhy } from './one-service-targets.js'

export type ServesAs = 'daemon' | 'walnut-serve'

/** What the host-server manager knows of this Walnut's follower on the host (manager.ts followerFact). */
export type FollowerFact =
  | { kind: 'replica' }
  /** `why` for Walnut Health; none for a server the person turned off there (their choice, nothing to report). */
  | { kind: 'none'; why?: string }
  /** Not settled yet (no reconcile this process, a setup or a restart under way): nothing changes. */
  | { kind: 'unknown' }

export interface ServiceModeFacts {
  /** The offer for this host (hostServiceOfferWanted) and service_launcher both on. */
  experiment: boolean
  /** The hello's `serves` (an older daemon says nothing: 'daemon'). */
  serves: ServesAs
  /** The hello's `serviceHome`: whose follower the service is (only with 'walnut-serve'). */
  serviceHome: string | null
  /** This Walnut's data dir (the follower spec's `home`, the mode file's `home`). */
  home: string
  /** The daemon already runs under the service launcher (hello `launcher`). */
  launcher: boolean
  /** The host's system as its daemon or the connect probe said it (`linux`, `darwin`, ...), null when not known yet. */
  platform: string | null
  /** The experiment macos_one_service: a Mac is offered too. */
  macos?: boolean
  follower: FollowerFact
  /** Why this build's walnut file cannot go to the host, when an earlier try found it could not. */
  walnutFileUnfit?: string | null
  /** This build already asked the host to switch (ServiceModeAsk), and it still runs as the other. */
  askedAndRefused?: Pick<ServiceModeAsk, 'want' | 'failed'> | null
}

/**
 * A switch this build asked of the host that ran: the update went through (`failed` absent; the
 * service chose the other mode itself, see service-entry.ts nextServiceMode) or failed after its
 * swap began. Never a try the host held, deferred or refused as busy before it changed anything:
 * that one is asked again. Kept on disk with the other update records (daemon-update-store.ts),
 * so a leader restart (a deploy) does not restart the host's service for it once more.
 */
export interface ServiceModeAsk {
  expected: string
  want: ServesAs
  /** The update's own error, when it failed. */
  failed?: string
}

export type ServiceModeWant =
  | { want: 'walnut-serve'; why?: undefined }
  /** `why`: the host gets no offer, in words for Walnut Health. */
  | { want: 'daemon'; why?: string }
  /** Leave the mode as it is (another Walnut's service, nothing settled yet, a switch that did not take). */
  | { want: null; why?: string }

export function wantedServiceMode(f: ServiceModeFacts): ServiceModeWant {
  const w = wantedNow(f)
  // A switch this build asked for and that did not take is not asked again with it (each try restarts the host's service).
  const asked = f.askedAndRefused
  if (w.want !== null && asked && w.want === asked.want && f.serves !== w.want) {
    const now = f.serves === 'walnut-serve' ? 'the Walnut service' : 'the session helper'
    return { want: null, why: asked.failed
      ? `the update that was to switch it with this build did not go through (${asked.failed.replace(/\.$/, '').slice(0, 200)}), so it still runs as ${now}; a newer build asks again`
      : `it took this build's update that was to switch it and still runs as ${now} (its service log says why); a newer build asks again` }
  }
  return w
}

function wantedNow(f: ServiceModeFacts): ServiceModeWant {
  // Another Walnut's service: only its own leader may change it (service-entry.ts nextServiceMode).
  if (f.serves === 'walnut-serve' && !servesThisWalnut(f, f.home)) return { want: null }
  if (!f.experiment) return f.serves === 'walnut-serve' ? { want: 'daemon' } : { want: null }
  // Decided before any update is asked: the walnut file goes only into a slot the one table names.
  if (f.platform === null) return { want: null }
  const systemWhy = servePlatformWhy(f.platform, { macos: f.macos === true })
  if (systemWhy) return { want: 'daemon', why: systemWhy }
  if (!f.launcher) return { want: 'daemon', why: 'its session helper does not run under the service launcher yet (it does after its next update)' }
  if (f.follower.kind === 'unknown') return { want: null }
  if (f.follower.kind === 'none') return { want: 'daemon', ...(f.follower.why ? { why: f.follower.why } : {}) }
  if (f.walnutFileUnfit) return { want: 'daemon', why: `this build's walnut file cannot go to the host: ${f.walnutFileUnfit}` }
  return { want: 'walnut-serve' }
}

/** A host system as a hello or a probe says it: lower case, a plain word, else not known (null). */
export function platformOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const p = value.trim().toLowerCase()
  return /^[a-z][a-z0-9_-]{0,31}$/.test(p) ? p : null
}

/** An update is due for the mode alone: the host runs as the other one. */
export function serviceModeDue(w: ServiceModeWant, serves: ServesAs): boolean {
  return w.want !== null && w.want !== serves
}

/**
 * The words the update carries for the mode: `--serve` while the service is wanted, `--no-serve`
 * only for a host that runs as this Walnut's service now, nothing otherwise (the host keeps its mode).
 * They name the Walnut as the host keeps it (`homeHere`, after a declared move: its first home
 * there), the home its mode file, its follower spec and its service go by, so the host matches
 * them with no alias of its own to read (service-entry.ts nextServiceMode, decideServiceEntry).
 */
export function serviceModeAsk(w: ServiceModeWant, f: Pick<ServiceModeFacts, 'serves' | 'serviceHome' | 'home'> & { homeHere?: string | null }): { home: string; on: boolean } | undefined {
  const home = f.homeHere || f.home
  if (w.want === 'walnut-serve') return { home, on: true }
  if (w.want === 'daemon' && servesThisWalnut(f, f.home)) return { home, on: false }
  return undefined
}

/**
 * The hello's word in this Walnut's own terms. A host where a declared move made this data dir an
 * alias keeps the Walnut under its first home there (leader.configure's `homeHere`), and its
 * service names that home: it is this Walnut (review A3b S34-L3: read as another Walnut's, so its
 * leader could neither keep nor switch back its own service after a move).
 */
export function servesAsHere(s: { serves: ServesAs; serviceHome: string | null }, home: string, homeHere: string | null): { serves: ServesAs; serviceHome: string | null } {
  return s.serves === 'walnut-serve' && homeHere && s.serviceHome === homeHere ? { serves: s.serves, serviceHome: home } : { ...s }
}

/**
 * The host runs as THIS Walnut's one service (its follower is the service), not another Walnut's on
 * the same host: the one test the decision, the host-server manager and the fleet card all use.
 * `s` in this Walnut's terms (servesAsHere; DaemonConnection.servesAs reads it so).
 */
export function servesThisWalnut(s: { serves: ServesAs; serviceHome: string | null } | null | undefined, home: string): boolean {
  return s?.serves === 'walnut-serve' && s.serviceHome === home
}

/** The hello's `serves` and `serviceHome`, as a leader reads them (absent, from an older host: the daemon). */
export function servesFromHello(hello: object): { serves: ServesAs; serviceHome: string | null } {
  const res = hello as { serves?: unknown; serviceHome?: unknown }
  const serves: ServesAs = res.serves === 'walnut-serve' ? 'walnut-serve' : 'daemon'
  const home = res.serviceHome
  const serviceHome = serves === 'walnut-serve' && typeof home === 'string' && home.startsWith('/') && home.length <= 1024 && !/[\u0000-\u001f]/.test(home) ? home : null
  return { serves, serviceHome }
}

/** What a connection holds for the decision, and how it reads the rest (daemon-connection.ts serviceModeWant). */
export interface ServiceModeInputs {
  serves: ServesAs
  serviceHome: string | null
  home: string
  launcher: boolean
  /** The host's system (platformOf), null when not known yet. */
  platform(): Promise<string | null>
  /** The experiment macos_one_service (one-service-targets.ts macosOneServiceWanted), read only for a Mac; absent: off. */
  macosWanted?(): Promise<boolean>
  expected: string | null
  serveUnfit: { expected: string; why: string } | null
  /** The switch this host was last asked (ServiceModeAsk): read only when the mode is decided. */
  modeAsked(): Promise<ServiceModeAsk | null>
  /**
   * The offer for this host (service-launcher-flag.ts hostServiceOfferWanted). null: a name with a
   * choice of its own may be this same machine and its id is not known yet, so the mode is left as it
   * is (never switched back on a guess).
   */
  offerWanted(): Promise<boolean | null>
  launcherWanted(): Promise<boolean>
  follower(): Promise<FollowerFact>
  /** Walnut Health: the host's offer as decided now, only while the experiments are on (one-service-health.ts). */
  note?(w: ServiceModeWant): void
  /** The experiments are off: an item this process raised recovers (no read of the store). */
  noteOff?(): void
}

/** Walnut Health's words for an offer left open (service-launcher-flag.ts serviceOfferFor answered null). */
export const OFFER_NOT_SURE = 'another name in Walnut\'s hosts may be this same machine and decides the one Walnut service otherwise; its mode stays as it is until that name connects once and the machine is known'

/**
 * The mode wanted for the host now. With the experiments off and a host that runs as the daemon,
 * nothing else is read: the answer is "leave it".
 */
export async function serviceModeWantNow(i: ServiceModeInputs): Promise<ServiceModeWant> {
  const offer = await i.offerWanted()
  // A Mac's offer waits on its own experiment; read only for a Mac.
  const macosFor = async (p: string | null) => p === 'darwin' && (await i.macosWanted?.().catch(() => false)) === true
  if (offer === null) {
    // Left as it is, and said once in Walnut Health while the service is wanted at all, only for a
    // host whose system is offered: one on another system is never offered, so "not sure" would only
    // be noise there (a kept list with a listed name offline made every macOS host say it).
    if (await i.launcherWanted()) {
      const p = await i.platform().catch(() => null)
      if (p !== null && servePlatformWhy(p, { macos: await macosFor(p) }) === null) i.note?.({ want: null, why: OFFER_NOT_SURE })
    }
    return { want: null }
  }
  const experiment = offer && (await i.launcherWanted())
  if (!experiment) {
    i.noteOff?.()
    if (i.serves !== 'walnut-serve') return { want: null }
  }
  const platform = experiment ? await i.platform().catch(() => null) : null
  const macos = await macosFor(platform)
  const follower: FollowerFact = experiment ? await i.follower().catch((): FollowerFact => ({ kind: 'unknown' })) : { kind: 'unknown' }
  const now = i.expected
  const asked = now ? await i.modeAsked().catch(() => null) : null
  const w = wantedServiceMode({
    experiment, serves: i.serves, serviceHome: i.serviceHome, home: i.home, launcher: i.launcher, platform, macos, follower,
    walnutFileUnfit: now && i.serveUnfit?.expected === now ? i.serveUnfit.why : null,
    askedAndRefused: asked && asked.expected === now ? asked : null,
  })
  if (experiment) i.note?.(w)
  return w
}
