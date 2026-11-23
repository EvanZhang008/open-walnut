/**
 * The first look at a host with the experiment host_service_sets on: which service set the host's
 * CLI picks for this Walnut, and, when that is a set of its own not yet installed, its install.
 * Nothing here updates or restarts a service that runs: `status --walnut` only reads, and a set's
 * first install has nothing running to hand over. The leader then moves its sessions there
 * (service-set-move.ts). With this build's executable on the host (withServiceExecutable).
 */
import { runServiceInstall, withServiceExecutable, type RemoteDaemonUpdateIo, type ServiceDaemonSource } from './daemon-service-update.js'
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
}

/** `printf` of the host's home and uid: what a set's runtime dir is computed from (service-set.ts). */
const WHERE = `printf '%s\\n%s\\n' "$HOME" "$(id -u)"`

/** The set's runtime dir from WHERE's answer; undefined when it does not read. */
export function setRuntimeDirFrom(said: string, set: string): string | undefined {
  const [home, uid] = said.split('\n').map((l) => l.trim())
  if (!home?.startsWith('/') || !/^\d+$/.test(uid ?? '')) return undefined
  try { return serviceSetRuntimeDir(home, set, Number(uid)) } catch { return undefined }
}

/** With `executable` (this build) on the host: the set, and its install when it is an own set not installed yet. */
export async function provisionWith(executable: string, io: Pick<RemoteDaemonUpdateIo, 'run'>, ask: SetAsk): Promise<SetProvision> {
  const words = serviceSetWords(ask)
  if (!words) return { set: null, installed: false, ok: false, message: 'this Walnut has no id the host can name a set by' }
  const said = (await io.run(`${executable} walnut daemon status${words} 2>/dev/null || true`, 60_000)).trim()
  const set = parseServiceSetLine(said)
  if (set === null) return { set: null, installed: false, ok: false, message: 'the host\'s walnut CLI named no service set' }
  if (set === '') return { set: '', installed: true, ok: true }
  const runtimeDir = setRuntimeDirFrom(await io.run(WHERE, 15_000).catch(() => ''), set)
  let installed = false
  try { installed = (JSON.parse(said.slice(said.indexOf('{'))) as { installed?: unknown }).installed === true } catch { /* not installed */ }
  if (installed) return { set, installed, ...(runtimeDir ? { runtimeDir } : {}), ok: true }
  const done = await runServiceInstall(executable, io, ask)
  // The install named another set than the status did (a claim won meanwhile): go by the install's.
  const named = done.serviceSet ?? set
  return {
    set: named, installed: done.ok, ok: done.ok,
    ...(named && named === set && runtimeDir ? { runtimeDir } : {}),
    ...(done.ok ? {} : { message: done.message ?? 'the install of this Walnut\'s own service failed' }),
  }
}

/** The same, staging this build's executable on the host first (an upload when the one there is another build). */
export function provisionServiceSet(source: ServiceDaemonSource, expectedVersion: string, io: RemoteDaemonUpdateIo, ask: SetAsk): Promise<SetProvision> {
  return withServiceExecutable(source, expectedVersion, io, (executable) => provisionWith(executable, io, ask))
}

/** What leaving a host needs (leaveServiceSet); the link gives each. */
export interface LeaveDeps {
  /** This Walnut's set there (16 hex): only that one is removed, never the default or another's. */
  set: string
  ask: SetAsk
  /** This Walnut's live sessions there: the set is removed once none is in a turn. */
  sessions(): Promise<Array<{ inTurn: boolean }>>
  send(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  /** The set the link's hello names now ('' the default's daemon, another Walnut's or the machine's). */
  helloSet(): string
  /** The set's own `walnut daemon` line (service-set-move-link.ts setCliCommand) run on the host. */
  runSetCli(words: string, timeoutMs: number): Promise<string>
  /** Host network: the set's endpoint is no member of this leader's, nor on the companion's relay list (service-set-net-pair.ts forgetSetNet). */
  forgetNet?(): Promise<void>
  now(): number
  sleep(ms: number): Promise<void>
  waitMs?: number
}

/**
 * Leave a host (the leader drops it): wait, bounded, until none of this Walnut's sessions there is in
 * a turn; stop this Walnut's follower on the set's daemon (`server.configure {home, spec:null}`, best
 * effort as the move's stopFollower: an uninstall under a running follower would leave its process
 * to the service stop alone); then `walnut daemon uninstall --yes --walnut <id>`, which removes only
 * this set: its boot item, then its own dir (root, runtime, and its own walnut-net state) once nothing
 * of the set runs there (service-set-remove.ts; a CLI of it still running keeps the dir, and the
 * answer says so). The answer must name the same set. Then the set's walnut-net is stopped if its
 * daemon still answers (`net.configure {enabled:false}`, the set's own identity only: over a host
 * network link that ends the link, so it comes after the uninstall), and its endpoint is forgotten
 * here and on the companion's relay list. The machine's own walnut-net is never touched.
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
  await d.send('server.configure', { home: d.ask.home, spec: null }, 15_000).catch(() => undefined)
  const said = await d.runSetCli(`uninstall --yes${words}`, 120_000).catch((err: Error) => `uninstall: ${err.message}`)
  // Only on the set's own daemon: on the default's this would turn off the machine's walnut-net.
  if (d.helloSet() === d.set) await d.send('net.configure', { enabled: false }, 30_000).catch(() => undefined)
  await d.forgetNet?.().catch(() => undefined)
  const named = parseServiceSetLine(said)
  if (named !== d.set) return { ok: false, why: `the host named ${named === null ? 'no set' : `set ${named || 'default'}`}, not this Walnut's own (${d.set})` }
  let answer: { ok?: unknown; setDir?: { removed?: unknown; why?: unknown } } = {}
  try { answer = JSON.parse(said.slice(said.indexOf('{'))) } catch { /* no answer */ }
  const ok = answer.ok === true
  const kept = answer.setDir && answer.setDir.removed === false ? `; its dir stays (${String(answer.setDir.why ?? 'no reason')})` : ''
  return { ok, why: ok ? `this Walnut's own service set was removed from the host${kept}` : `the uninstall did not go through: ${said.trim().slice(-300)}` }
}
