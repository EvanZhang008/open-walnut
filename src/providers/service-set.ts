/**
 * A host service SET: the files, names and dirs one Walnut's service on a host uses. One service
 * belongs to one Walnut. The Walnut that holds the default places keeps them (`id` ''); a later
 * Walnut on the same account (the experiment host_service_sets) gets its own set under
 * `~/.open-walnut-host/walnuts/<id16>/`, beside its follower's data, logs and run dirs:
 *
 *   installRoot  R/daemon             (the default: daemonInstallRoot)
 *   runtimeDir   R/rt, or /tmp/open-walnut-set-<uid>-<id16> when R/rt's sockets would not fit
 *   unit         open-walnut-daemon-<id16>.service
 *   label        dev.openwalnut.session-daemon.<id16>, plist <label>.plist
 *   cronTag      # open-walnut-daemon <id16>
 *
 * R/run (the follower's run dir) and R/rt are siblings, never nested (replica/boot-guard.ts).
 * Shared on purpose by every set: the machine id, cli-owners and walnut-net.
 *
 * The one place the service names and the default install root are spelled; daemon-service-config.ts
 * and daemon-service-boot-script.ts re-export them for their older importers. Imports only node:path:
 * the daemon runtime, the host CLI and the server all read it.
 */
import path from 'node:path'

export const DAEMON_SERVICE_LABEL = 'dev.openwalnut.session-daemon'
export const DAEMON_SERVICE_UNIT_NAME = 'open-walnut-daemon.service'
export const DAEMON_SERVICE_PLIST_NAME = `${DAEMON_SERVICE_LABEL}.plist`
/** Ends the crontab line Walnut writes, so it can find its own line and nobody else's. */
export const DAEMON_CRON_TAG = '# open-walnut-daemon'

/** The env a set's unit, plist, boot script and launcher carry: its id (only for a set, never the default). */
export const SERVICE_SET_ENV = 'WALNUT_SERVICE_SET'
/** Where the sets live, under the account's home (the host server's root, core/host-server/install.ts HOST_ROOT). */
export const SERVICE_SETS_SUBDIR = path.join('.open-walnut-host', 'walnuts')
/** The default set's runtime dir (lib/daemon-dir.ts SHARED_DAEMON_DIR): the caller passes the one it chose. */
const DEFAULT_RUNTIME_DIR = '/tmp/open-walnut'
/** macOS's sun_path holds 104 bytes; a set's runtime dir leaves room for its longest socket under this. */
export const SET_SOCKET_MAX_BYTES = 100
/** The longest socket a runtime dir holds without a fallback of its own (host-call-token-core.ts). */
const LONGEST_SOCKET = path.join('host-call', '0123456789abcdef.sock')

export type ServicePlatform = 'linux' | 'darwin'

export interface ServiceSet {
  /** '' = the default set; else the Walnut's id16. */
  id: string
  installRoot: string
  runtimeDir: string
  unit: string
  label: string
  plist: string
  cronTag: string
}

const SET_ID = /^[0-9a-f]{16}$/

export function isServiceSetId(id: unknown): id is string {
  return typeof id === 'string' && SET_ID.test(id)
}

/**
 * A Walnut's set id: the head of its walnut id, as `walnutDirKey` (core/host-server/install.ts) names
 * its host dir. Walnut ids are 32 hex (device-store.ts); anything else names no set.
 */
export function serviceSetIdOf(walnutId: string): string {
  const id = walnutId.slice(0, 16)
  if (!isServiceSetId(id)) throw new Error(`a walnut id names a service set only as 16 hex digits: ${JSON.stringify(walnutId)}`)
  return id
}

/** The default install root under `home`, unchecked (a remote probe passes a literal '$HOME'). */
export function defaultInstallRootUnder(platform: ServicePlatform, home: string): string {
  return platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Open Walnut', 'Daemon')
    : path.join(home, '.local', 'share', 'open-walnut', 'daemon')
}

/** R: the set's own dir under `home`, which also holds its follower's data, logs and run dirs. */
export function serviceSetBase(home: string, id: string): string {
  if (!isServiceSetId(id)) throw new Error(`not a service set id: ${JSON.stringify(id)}`)
  return path.join(home, SERVICE_SETS_SUBDIR, id)
}

/** A set's runtime dir: R/rt, or a /tmp one of this account when R/rt's sockets would not fit sun_path. */
export function serviceSetRuntimeDir(home: string, id: string, uid: number): string {
  const rt = path.join(serviceSetBase(home, id), 'rt')
  return Buffer.byteLength(path.join(rt, LONGEST_SOCKET)) <= SET_SOCKET_MAX_BYTES ? rt : `/tmp/open-walnut-set-${uid}-${id}`
}

/** The names of a set's boot item; '' gives today's. */
export function serviceSetNames(id: string): Pick<ServiceSet, 'unit' | 'label' | 'plist' | 'cronTag'> {
  if (id === '') return { unit: DAEMON_SERVICE_UNIT_NAME, label: DAEMON_SERVICE_LABEL, plist: DAEMON_SERVICE_PLIST_NAME, cronTag: DAEMON_CRON_TAG }
  if (!isServiceSetId(id)) throw new Error(`not a service set id: ${JSON.stringify(id)}`)
  const label = `${DAEMON_SERVICE_LABEL}.${id}`
  return { unit: `open-walnut-daemon-${id}.service`, label, plist: `${label}.plist`, cronTag: `${DAEMON_CRON_TAG} ${id}` }
}

/**
 * The set `id` of this account on this platform. id '' gives exactly today's values: the default
 * install root and names, and `runtimeDir` the caller already chose (localProductionDaemonDir).
 */
export function serviceSet(
  platform: ServicePlatform, home: string, id = '',
  o: { runtimeDir?: string; uid?: number } = {},
): ServiceSet {
  if (!path.isAbsolute(home)) throw new Error(`a service set needs an absolute home, got ${JSON.stringify(home)}`)
  if (platform !== 'linux' && platform !== 'darwin') throw new Error(`unsupported platform ${JSON.stringify(platform)}`)
  const names = serviceSetNames(id)
  if (id === '') return { id, installRoot: defaultInstallRootUnder(platform, home), runtimeDir: o.runtimeDir ?? DEFAULT_RUNTIME_DIR, ...names }
  const uid = o.uid ?? process.getuid?.() ?? 0
  return { id, installRoot: path.join(serviceSetBase(home, id), 'daemon'), runtimeDir: serviceSetRuntimeDir(home, id, uid), ...names }
}

/** Is `dir` the install root of the default set or of some set under `home`? */
export function isServiceInstallRoot(platform: ServicePlatform, home: string, dir: string): boolean {
  const resolved = path.resolve(dir)
  if (resolved === path.resolve(defaultInstallRootUnder(platform, home))) return true
  const base = path.resolve(home, SERVICE_SETS_SUBDIR)
  return path.dirname(path.dirname(resolved)) === base && path.basename(resolved) === 'daemon'
    && isServiceSetId(path.basename(path.dirname(resolved)))
}

/** Is `dir` a set's runtime dir (R/rt under `home`, or the /tmp fallback of `uid`)? Never the default's. */
export function isServiceSetRuntimeDir(dir: string, home: string | null | undefined, uid: number | null | undefined): boolean {
  const resolved = path.resolve(dir)
  const tmp = /^\/tmp\/open-walnut-set-(\d+)-([0-9a-f]{16})$/.exec(resolved)
  if (tmp) return uid !== null && uid !== undefined && Number(tmp[1]) === uid
  if (!home || !path.isAbsolute(home) || path.basename(resolved) !== 'rt') return false
  const id = path.basename(path.dirname(resolved))
  return isServiceSetId(id) && path.dirname(path.dirname(resolved)) === path.resolve(home, SERVICE_SETS_SUBDIR)
}

/** A set's line in a shell script that runs its daemon (the boot script, the launcher); '' for the default. */
export function serviceSetExportLine(id: string | undefined): string {
  if (!id) return ''
  if (!isServiceSetId(id)) throw new Error(`not a service set id: ${JSON.stringify(id)}`)
  return `export ${SERVICE_SET_ENV}='${id}'`
}

/**
 * `script` with the set's export after its WALNUT_DAEMON_STATE_DIR line: cron runs the script with
 * none of the unit's environment, so the script itself names the set. The default's script stays
 * byte for byte as it was.
 */
export function withServiceSetExport(script: string, id: string | undefined): string {
  const line = serviceSetExportLine(id)
  if (!line) return script
  const lines = script.split('\n')
  const at = lines.findIndex((l) => l.startsWith('export WALNUT_DAEMON_STATE_DIR='))
  if (at < 0) throw new Error('the script names no WALNUT_DAEMON_STATE_DIR to put the service set beside')
  lines.splice(at + 1, 0, line)
  return lines.join('\n')
}

/** The `service set: …` line `walnut daemon … --walnut <id>` prints before its answer. */
export function serviceSetLine(id: string): string {
  return `service set: ${id || 'default'}`
}

/** The set a `walnut daemon` output names ('' the default), or null when it names none (an older host). */
export function parseServiceSetLine(output: string): string | null {
  const m = /^service set: (default|[0-9a-f]{16})$/m.exec(output)
  return m ? (m[1] === 'default' ? '' : m[1]!) : null
}
