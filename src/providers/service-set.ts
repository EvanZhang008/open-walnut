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
 * Shared on purpose by every set: the machine id and cli-owners. walnut-net is not: a set runs its own
 * (net-config-core.ts netStateDir, `R/net`), and the machine's stays the default set's. Nor is the
 * compiled walnut file's runtime tree: a set's service unpacks it under `R/daemon/runtime`
 * (serviceSetEnv), never in the default Walnut's `~/.open-walnut/local/runtime`, which it would prune.
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

/**
 * Is `dir` a set's runtime dir (R/rt under `home`, or the /tmp fallback of `uid`)? Never the default's.
 * On macOS /tmp is a link to /private/tmp, so a realpath of the fallback reads /private/tmp/...: both
 * spellings are the same dir there (mac drill), compared as text, with no filesystem call.
 */
export function isServiceSetRuntimeDir(dir: string, home: string | null | undefined, uid: number | null | undefined, platform: NodeJS.Platform = process.platform): boolean {
  const resolved = path.resolve(dir)
  const tmp = (platform === 'darwin' ? /^(?:\/private)?\/tmp\/open-walnut-set-(\d+)-([0-9a-f]{16})$/ : /^\/tmp\/open-walnut-set-(\d+)-([0-9a-f]{16})$/).exec(resolved)
  if (tmp) return uid !== null && uid !== undefined && Number(tmp[1]) === uid
  if (!home || !path.isAbsolute(home) || path.basename(resolved) !== 'rt') return false
  const id = path.basename(path.dirname(resolved))
  return isServiceSetId(id) && path.dirname(path.dirname(resolved)) === path.resolve(home, SERVICE_SETS_SUBDIR)
}

/** The compiled walnut file's runtime place (runtime-tree.ts RUNTIME_PLACE_ENV), which decides alone when set. */
export const RUNTIME_DIR_ENV = 'WALNUT_RUNTIME_DIR'
/** Where a set's service keeps the walnut file's unpacked runtime trees, in its install root. */
export const SET_RUNTIME_TREES_SUBDIR = 'runtime'

/** The parent of a set's runtime trees (WALNUT_RUNTIME_DIR of its service): `<install root>/runtime`. */
export function serviceSetRuntimeTreesDir(installRoot: string): string {
  return path.join(installRoot, SET_RUNTIME_TREES_SUBDIR)
}

/**
 * Is `dir` a set's runtime-tree parent (`<home>/.open-walnut-host/walnuts/<id16>/daemon/runtime`)?
 * The file prunes old builds' trees there as it does in its own data home: the set owns that dir
 * alone (runtime-tree.ts ensureRuntime). Never the default set's or any other dir.
 */
export function isServiceSetRuntimeTreesDir(dir: string, home: string | null | undefined): boolean {
  if (!home || !path.isAbsolute(home) || !path.isAbsolute(dir)) return false
  const resolved = path.resolve(dir)
  const id = path.basename(path.dirname(path.dirname(resolved)))
  return isServiceSetId(id) && resolved === serviceSetRuntimeTreesDir(path.join(serviceSetBase(home, id), 'daemon'))
}

/**
 * The env only a set's service carries (its unit, plist, boot script and launcher), after the
 * default's: its id, and the walnut file's runtime place under its own install root, so a start of
 * the file never unpacks into, or prunes, the default Walnut's `~/.open-walnut/local/runtime`
 * (2026-11-24 real-systemd drill). [] for the default set, whose files stay byte for byte as they were.
 * Every path a set's service derives from its env is listed in
 * tests/providers/service-set-default-paths-guard.test.ts.
 */
export function serviceSetEnv(id: string | undefined, installRoot: string): Array<[string, string]> {
  if (!id) return []
  if (!isServiceSetId(id)) throw new Error(`not a service set id: ${JSON.stringify(id)}`)
  return [[SERVICE_SET_ENV, id], [RUNTIME_DIR_ENV, serviceSetRuntimeTreesDir(installRoot)]]
}

/** sh single quotes: everything literal, a quote closed, escaped and reopened. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** A set's lines in a shell script that runs its daemon (the boot script, the launcher); none for the default. */
export function serviceSetExportLines(id: string | undefined, installRoot: string): string[] {
  return serviceSetEnv(id, installRoot).map(([key, value]) => `export ${key}=${shq(value)}`)
}

/**
 * `script` with the set's exports after its WALNUT_DAEMON_STATE_DIR line: cron runs the script with
 * none of the unit's environment, so the script itself names the set. The default's script stays
 * byte for byte as it was.
 */
export function withServiceSetExport(script: string, id: string | undefined, installRoot: string): string {
  const exports = serviceSetExportLines(id, installRoot)
  if (exports.length === 0) return script
  const lines = script.split('\n')
  const at = lines.findIndex((l) => l.startsWith('export WALNUT_DAEMON_STATE_DIR='))
  if (at < 0) throw new Error('the script names no WALNUT_DAEMON_STATE_DIR to put the service set beside')
  lines.splice(at + 1, 0, ...exports)
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
