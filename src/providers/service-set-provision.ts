/**
 * The first look at a host with the experiment host_service_sets on: which service set the host's
 * CLI picks for this Walnut, and, when that is a set of its own not yet installed, its install.
 * `status --walnut` only reads, and a set's first install has nothing running to hand over. The one
 * service this may restart is this Walnut's own set while the link still reaches the shared daemon and
 * no move flipped (`refresh`, service-set-move-link.ts): installed by an earlier build of this Walnut,
 * it has no copy of this build, so the move's set lines (setCliCommand) would answer no_build and the
 * move could never start after a leader update (a shared Mac, 11-24: installed at 17:16Z, the leader
 * updated at 22:05Z, the move gave up at 22:18Z). It takes this build by the regular update
 * (updateRemoteDaemonService: the detached runner and its tail), naming the Walnut, so only that set's
 * service is updated. The leader then moves its sessions there (service-set-move.ts). With this
 * build's executable on the host (withServiceExecutable).
 */
import { DAEMON_VERSION_ARGS, runServiceInstall, updateRemoteDaemonService, withServiceExecutable, type RemoteDaemonUpdateIo, type ServiceDaemonSource } from './daemon-service-update.js'
import { shq } from './daemon-net-update-io.js'
import { serviceSetWords, type SetAsk } from './service-set-leader.js'
import { isServiceSetId, parseServiceSetLine, serviceSetRuntimeDir } from './service-set.js'

export interface SetProvision {
  /** The set the host's CLI named ('' the default), or null: it named none (nothing is known, nothing changes). */
  set: string | null
  /** The set's service is installed there (now or before). */
  installed: boolean
  /** The set's runtime dir on the host (where its daemon.port is), for a set. */
  runtimeDir?: string
  ok: boolean
  message?: string
  /**
   * The own set is installed but holds no copy of this build (refresh only): provisionServiceSet
   * updates it, `scope` being the one its status named.
   */
  buildMissing?: { scope?: string }
  /** The look found nothing it can act on now (the set's builds did not read, or its update failed): looked at again soon. */
  retryLook?: boolean
  /** With retryLook: not before this long (the build itself failed on the host: a day, as the regular update holds it). */
  retryInMs?: number
  /** With retryLook: the link cut the upload, so nothing changed there and it is no failure to report ('DaemonUpdateStageError'). */
  cut?: true
  /** The set took this build now: the move it waited for may run at once. */
  refreshed?: true
}

/** A build that stopped the set's daemon and did not come to serve is not tried again for a day (daemon-update-readback.ts buildFailed). */
const BUILD_FAILED_RETRY_MS = 24 * 3600_000

/** `printf` of the host's home and uid: what a set's runtime dir is computed from (service-set.ts). */
const WHERE = `printf '%s\\n%s\\n' "$HOME" "$(id -u)"`

/** The set's runtime dir from WHERE's answer; undefined when it does not read. */
export function setRuntimeDirFrom(said: string, set: string): string | undefined {
  const [home, uid] = said.split('\n').map((l) => l.trim())
  if (!home?.startsWith('/') || !/^\d+$/.test(uid ?? '')) return undefined
  try { return serviceSetRuntimeDir(home, set, Number(uid)) } catch { return undefined }
}

/**
 * With `executable` (this build) on the host: the set, and its install when it is an own set not
 * installed yet. With `refresh` (the set is not moved to yet), an own set installed with no copy of
 * `refresh.expected` takes this build (takeThisBuild).
 */
export async function provisionWith(executable: string, io: Pick<RemoteDaemonUpdateIo, 'run'>, ask: SetAsk, refresh?: { expected: string }): Promise<SetProvision> {
  const words = serviceSetWords(ask)
  if (!words) return { set: null, installed: false, ok: false, message: 'this Walnut has no id the host can name a set by' }
  const said = (await io.run(`${executable} walnut daemon status${words} 2>/dev/null || true`, 60_000)).trim()
  const set = parseServiceSetLine(said)
  if (set === null) return { set: null, installed: false, ok: false, message: 'the host\'s walnut CLI named no service set' }
  if (set === '') return { set: '', installed: true, ok: true }
  const runtimeDir = setRuntimeDirFrom(await io.run(WHERE, 15_000).catch(() => ''), set)
  let installed = false
  try { installed = (JSON.parse(said.slice(said.indexOf('{'))) as { installed?: unknown }).installed === true } catch { /* not installed */ }
  if (installed) {
    const at = { set, installed, ...(runtimeDir ? { runtimeDir } : {}) }
    if (!refresh) return { ...at, ok: true }
    const has = await setHasBuild(io, set, refresh.expected)
    if (has === true) return { ...at, ok: true }
    if (has === null) return { ...at, ok: false, retryLook: true, message: 'the builds in this Walnut\'s own service there did not read' }
    let scope: string | undefined
    try { const s = (JSON.parse(said.slice(said.indexOf('{'))) as { scope?: unknown }).scope; if (typeof s === 'string') scope = s } catch { /* none */ }
    return { ...at, ok: false, buildMissing: scope ? { scope } : {} }
  }
  const done = await runServiceInstall(executable, io, ask)
  // The install named another set than the status did (a claim won meanwhile): go by the install's.
  const named = done.serviceSet ?? set
  return {
    set: named, installed: done.ok, ok: done.ok,
    ...(named && named === set && runtimeDir ? { runtimeDir } : {}),
    ...(done.ok ? {} : { message: done.message ?? 'the install of this Walnut\'s own service failed' }),
  }
}

/**
 * Whether the set's install root holds a copy of `expected` (the one setCliCommand runs), or null when
 * the answer does not read (a link cut mid-line: nothing is changed on a doubt).
 */
async function setHasBuild(io: Pick<RemoteDaemonUpdateIo, 'run'>, set: string, expected: string): Promise<boolean | null> {
  const said = await io.run(`${findSetBuild(set, expected)}\n[ -n "$x" ] && echo build:yes || echo build:no`, 60_000).catch(() => '')
  return /^build:yes$/m.test(said) ? true : /^build:no$/m.test(said) ? false : null
}

/**
 * The same, staging this build's executable on the host first (an upload when the one there is another
 * build). `refresh`: the link still reaches the shared daemon and no move flipped, so an own set without
 * this build takes it (the header). Its update is the regular one with the Walnut named, its answer
 * checked to name this set.
 */
export async function provisionServiceSet(source: ServiceDaemonSource, expectedVersion: string, io: RemoteDaemonUpdateIo, ask: SetAsk, opts: { refresh?: boolean } = {}): Promise<SetProvision> {
  const p = await withServiceExecutable(source, expectedVersion, io, (executable) => provisionWith(executable, io, ask, opts.refresh ? { expected: expectedVersion } : undefined))
  if (!p.buildMissing || !p.set) return p
  const { buildMissing, ...at } = p
  const scope = buildMissing.scope === 'cron' ? 'cron' : 'user'
  let named: string | null = null
  try {
    await updateRemoteDaemonService(source, expectedVersion, io, scope, { walnut: ask, set: p.set, onServiceSet: (s) => { named = s } })
  } catch (err) {
    const buildFailed = (err as { buildFailed?: unknown } | null)?.buildFailed === true
    // The new build never got onto the host (an upload the link cut): nothing changed there, looked at again quietly.
    const cut = (err as { name?: unknown } | null)?.name === 'DaemonUpdateStageError'
    return {
      ...at, ok: false, retryLook: true, ...(buildFailed ? { retryInMs: BUILD_FAILED_RETRY_MS } : {}), ...(cut ? { cut: true as const } : {}),
      message: `this Walnut's own service there could not take this build: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`,
    }
  }
  if (named !== p.set) return { ...at, ok: false, retryLook: true, message: `the update named ${named === null ? 'no set' : `set ${named || 'default'}`}, not this Walnut's own (${p.set})` }
  return { ...at, ok: true, refreshed: true }
}

/** The shell that sets `x` to this build's copy in the set's install root (versions/<sha>/, the first that names `expected`), or ''. */
function findSetBuild(set: string, expected: string): string {
  if (!isServiceSetId(set)) throw new Error('not a service set id')
  const versions = `"$HOME/.open-walnut-host/walnuts/${set}/daemon/versions"`
  return `x=; for f in ${versions}/*/*; do [ -x "$f" ] || continue; [ "$("$f" ${DAEMON_VERSION_ARGS} 2>/dev/null | tail -n 1)" = ${shq(expected)} ] && { x=$f; break; }; done`
}

/**
 * The shell that runs `walnut daemon <words>` with this build's copy in the set's install root (the
 * build its install put there: versions/<sha>/, the first that names `expected`), its JSON answer on
 * stdout; a set with no such copy answers `no_build`.
 */
export function setCliCommand(set: string, expected: string, words: string): string {
  return [
    findSetBuild(set, expected),
    `[ -n "$x" ] || { echo '{"ok":false,"code":"no_build","message":"this Walnut\\u0027s build is not in its set on the host"}'; exit 0; }`,
    `"$x" walnut daemon ${words} 2>/dev/null || true`,
  ].join('\n')
}

/** What leaving a host needs (leaveServiceSet); the link gives each. */
export interface LeaveDeps {
  /** This Walnut's set there (16 hex): only that one is removed, never the default or another's. */
  set: string
  ask: SetAsk
  /** This Walnut's live sessions there: the set is removed once none is in a turn. */
  sessions(): Promise<Array<{ inTurn: boolean }>>
  /**
   * Stop each of them on the set's daemon and prove its CLI gone (service-set-move-checks.ts stopProven):
   * an uninstall would leave their CLIs running on as orphans and the set's dir kept (drill round 3, R3-5).
   * Why each one not proven stays; none: [].
   */
  stopSessions(): Promise<string[]>
  send(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  /** The set the link's hello names now ('' the default's daemon, another Walnut's or the machine's). */
  helloSet(): string
  /** The set's own `walnut daemon` line (setCliCommand) run on the host. */
  runSetCli(words: string, timeoutMs: number): Promise<string>
  now(): number
  sleep(ms: number): Promise<void>
  waitMs?: number
}

/**
 * Leave a host (the leader drops it): wait, bounded, until none of this Walnut's sessions there is in
 * a turn; stop this Walnut's follower on the set's daemon (`server.configure {home, spec:null}`, best
 * effort as the move's stopFollower: an uninstall under a running follower would leave its process
 * to the service stop alone); stop this Walnut's sessions there, each proven gone (stopSessions); then, once
 * `status` names this set, `walnut daemon uninstall --yes --walnut <id>`, which removes only
 * this set: its boot item, then its own dir (root, runtime, and its own walnut-net state) once nothing
 * of the set runs there (service-set-remove.ts; a CLI of it still running keeps the dir, and the
 * answer says so). The answer must name the same set. Then the set's walnut-net is stopped if its
 * daemon still answers (`net.configure {enabled:false}`, the set's own identity only: over a host
 * network link that ends the link, so it comes after the uninstall). The machine's own walnut-net is
 * never touched. Its caller (service-set-move-link.ts leave, on a Remove of the host) bounds it and
 * then forgets the set's endpoint and record here and on the companion's relay list, whatever this answered.
 */
export async function leaveServiceSet(d: LeaveDeps): Promise<{ ok: boolean; why: string }> {
  if (!isServiceSetId(d.set)) return { ok: false, why: 'not a set of this Walnut\'s own: nothing is removed' }
  const words = serviceSetWords(d.ask)
  if (!words) return { ok: false, why: 'this Walnut has no id the host can name a set by' }
  const until = d.now() + (d.waitMs ?? 30 * 60_000)
  while ((await d.sessions()).some((s) => s.inTurn)) {
    if (d.now() >= until) return { ok: false, why: 'a turn of this Walnut\'s sessions there ran the whole wait; nothing was removed' }
    await d.sleep(15_000)
  }
  // The host's CLI must pick this set before anything is removed: a set that lost its install marks
  // would have the uninstall fall to the default, another Walnut's service (review round 3, L-N3).
  const before = parseServiceSetLine(await d.runSetCli(`status${words}`, 30_000).catch(() => ''))
  if (before !== d.set) return { ok: false, why: `before the uninstall the host named ${before === null ? 'no set' : `set ${before || 'default'}`}, not this Walnut's own (${d.set}); nothing was removed` }
  await d.send('server.configure', { home: d.ask.home, spec: null }, 15_000).catch(() => undefined)
  const left = await d.stopSessions().catch((err: Error) => [`its sessions there were not stopped (${err.message})`])
  const onSet = d.helloSet() === d.set
  const said = await d.runSetCli(`uninstall --yes${words}`, 120_000).catch((err: Error) => `uninstall: ${err.message}`)
  const named = parseServiceSetLine(said)
  // Over the host network the uninstall runs through the set's own daemon, which it stops: its reply
  // can be lost with the link. A lost reply, then a link that no longer reaches the set, is the set gone
  // (review round 3, L-H2).
  if (named === null && onSet) {
    if (d.helloSet() === d.set) await d.sleep(2_000)
    if (d.helloSet() !== d.set) return { ok: true, why: 'this Walnut\'s own service set was removed from the host (its reply was lost as its daemon stopped)' }
  }
  // Only on the set's own daemon: on the default's this would turn off the machine's walnut-net.
  if (d.helloSet() === d.set) await d.send('net.configure', { enabled: false }, 30_000).catch(() => undefined)
  if (named !== d.set) return { ok: false, why: `the host named ${named === null ? 'no set' : `set ${named || 'default'}`}, not this Walnut's own (${d.set})` }
  let answer: { ok?: unknown; setDir?: { removed?: unknown; why?: unknown } } = {}
  try { answer = JSON.parse(said.slice(said.indexOf('{'))) } catch { /* no answer */ }
  const ok = answer.ok === true
  const kept = answer.setDir && answer.setDir.removed === false ? `; its dir stays (${String(answer.setDir.why ?? 'no reason')})` : ''
  const running = left.length ? `; not stopped first: ${left.slice(0, 3).join('; ')}` : ''
  return { ok, why: ok ? `this Walnut's own service set was removed from the host${kept}${running}` : `the uninstall did not go through: ${said.trim().slice(-300)}` }
}
