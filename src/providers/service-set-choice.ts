/**
 * Which service set `walnut daemon … --walnut <walnutId>` acts on (service-set.ts). The host's CLI
 * decides; the leader never sends a path. In this order:
 *
 *   1. The Walnut's own set is installed (its install root holds a launcher, a boot script, a mode
 *      or an ownership record): its own set. Sticky, whatever the default does later.
 *   2. The default install root holds `set-owner.json {v:1, walnutId}`: this Walnut's, the default;
 *      another's (or one that does not read), its own set. A readable mode owner that names another
 *      Walnut than the claim wins over it (review round 1, should-fix 2): the Walnut that runs the
 *      default service now owns it, whoever claimed the place while it was away.
 *   3. No claim: the default's owner by today's rule (service-mode.ts serviceModeOwner: the mode's
 *      walnutId, else the replica's follower spec). This Walnut: the default, claimed. Another: its own set.
 *   4. No mode (or one whose owner cannot be told): the default runtime's daemon.serves.json names
 *      another Walnut's key, used within SHARED_WINDOW_MS (daemon-shared.ts): its own set (two
 *      Walnuts already share the daemon there). Else the default, claimed.
 *
 * A claim is written whole beside the claim file and linked into place (a link fails when one is
 * there: then step 2 decides), under the default root's service-mode.lock. Only install and update
 * claim; status and restart only read; a successful uninstall of the default removes the claim (releaseSetOwner).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { serviceSet, serviceSetIdOf, type ServicePlatform, type ServiceSet } from './service-set.js'
import { DAEMON_BOOT_SCRIPT_NAME } from './daemon-service-config.js'
import { DAEMON_OWNERSHIP_NAME } from './daemon-service-files.js'
import { LAUNCHER_SCRIPT_NAME } from './service-launcher-script.js'
import { parseServes, SERVES_FILE, SHARED_WINDOW_MS, walnutKeyOf } from './daemon-shared.js'
import { SERVICE_MODE_FILE, serviceModeOwner } from '../binary/service-mode.js'
import { withServiceModeLockWait } from '../binary/service-mode-lock.js'

/** In the default install root: which Walnut holds the default set. */
export const SET_OWNER_FILE = 'set-owner.json'

/** A set is installed when its root holds one of these (every install writes the ownership record). */
const INSTALLED_MARKS = [LAUNCHER_SCRIPT_NAME, DAEMON_BOOT_SCRIPT_NAME, SERVICE_MODE_FILE, DAEMON_OWNERSHIP_NAME]

export interface ServiceSetChoiceInput {
  platform: ServicePlatform
  home: string
  walnutId: string
  /** The data dir its leader names (`--serve`/`--no-serve <home>`): its key in the serves file (step 4). */
  serveHome?: string
  /** The default set's runtime dir (lib/daemon-dir.ts localProductionDaemonDir). */
  defaultRuntimeDir: string
  uid: number
  /** install and update take the default when they choose it; the other actions only read. */
  claim: boolean
  now?: () => number
}

export interface ServiceSetChoice {
  set: ServiceSet
  /** The step that decided, in words (the CLI prints it with --walnut). */
  why: string
  /** This call wrote the claim file. */
  claimed?: boolean
}

const present = (file: string): Promise<boolean> =>
  fs.lstat(file).then(() => true, (error: NodeJS.ErrnoException) => error.code !== 'ENOENT')

/** The claim file's Walnut; '' when it is there and does not read (someone else's, to be safe); null with none. */
export async function readSetOwner(defaultRoot: string): Promise<string | null> {
  let text: string
  try { text = await fs.readFile(path.join(defaultRoot, SET_OWNER_FILE), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; return '' }
  try {
    const v = JSON.parse(text) as { v?: unknown; walnutId?: unknown }
    return v?.v === 1 && typeof v.walnutId === 'string' && v.walnutId ? v.walnutId : ''
  } catch { return '' }
}

/** Write the claim whole, then link it into place: false when a claim was there first. */
async function writeSetOwner(defaultRoot: string, walnutId: string): Promise<boolean> {
  const file = path.join(defaultRoot, SET_OWNER_FILE)
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify({ v: 1, walnutId })}\n`, { mode: 0o600, flag: 'wx' })
  try {
    await fs.link(tmp, file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally { await fs.rm(tmp, { force: true }) }
}

/** A claim's temp file a crashed CLI left (its pid gone) is removed, under the lock (review round 1, low 3). */
async function sweepClaimTemps(root: string): Promise<void> {
  const names = await fs.readdir(root).catch(() => [] as string[])
  for (const name of names) {
    const m = /^set-owner\.json\.(\d+)\.[0-9a-f]{8}\.tmp$/.exec(name)
    if (!m) continue
    const pid = Number(m[1])
    let alive = pid === process.pid
    if (!alive) { try { process.kill(pid, 0); alive = true } catch (e) { alive = (e as NodeJS.ErrnoException).code === 'EPERM' } }
    if (!alive) await fs.rm(path.join(root, name), { force: true }).catch(() => {})
  }
}

/**
 * The default service is gone (`walnut daemon uninstall` of the default set): so is any claim on its
 * place, under the lock a claim is written under. Whoever claimed it, no service means no owner; a
 * claim left behind would give the place back to its claimer over an older Walnut that installs a
 * plain default meanwhile (no claim, no mode) and runs on it (review round 2, H-L2).
 */
export async function releaseSetOwner(defaultRoot: string): Promise<void> {
  if (!(await present(path.join(defaultRoot, SET_OWNER_FILE)))) return
  await withServiceModeLockWait(defaultRoot, async () => {
    await fs.rm(path.join(defaultRoot, SET_OWNER_FILE), { force: true })
    await sweepClaimTemps(defaultRoot)
  })
}

/** Another Walnut than `ourKey` used the default runtime's daemon lately (its serves file). */
async function sharedWithAnother(runtimeDir: string, ourKey: string | null, now: number): Promise<string | null> {
  if (!ourKey) return null
  const serves = parseServes(await fs.readFile(path.join(runtimeDir, SERVES_FILE), 'utf8').catch(() => ''))
  if (!serves) return null
  return Object.entries(serves.walnuts).find(([key, at]) => key !== '-' && key !== ourKey && now - at < SHARED_WINDOW_MS)?.[0] ?? null
}

export async function chooseServiceSet(input: ServiceSetChoiceInput): Promise<ServiceSetChoice> {
  const own = serviceSet(input.platform, input.home, serviceSetIdOf(input.walnutId), { uid: input.uid })
  const def = serviceSet(input.platform, input.home, '', { runtimeDir: input.defaultRuntimeDir })
  const root = def.installRoot
  // 1. Sticky: an own set once installed stays this Walnut's.
  for (const name of INSTALLED_MARKS) {
    if (await present(path.join(own.installRoot, name))) return { set: own, why: `its own set is installed (${name})` }
  }
  const byMode = (): ServiceSetChoice | null => {
    const owner = serviceModeOwner(root)
    if (owner === 'none' || !owner.owner) return null
    return owner.owner === input.walnutId
      ? { set: def, why: 'the default service is this Walnut\'s' }
      : { set: own, why: 'the default service is another Walnut\'s' }
  }
  const byClaim = (owner: string): ServiceSetChoice => {
    // A mode another Walnut than the claimer wrote later is the default's owner now.
    const mode = owner ? byMode() : null
    if (mode && (mode.set === def) !== (owner === input.walnutId)) return { ...mode, why: `${mode.why} (its mode outranks the claim)` }
    return owner === input.walnutId
      ? { set: def, why: 'the default set is claimed by this Walnut' }
      : { set: own, why: owner ? 'the default set is claimed by another Walnut' : 'the default set has a claim that does not read' }
  }
  // 2.
  const claimed = await readSetOwner(root)
  if (claimed !== null) return byClaim(claimed)
  // 3 and 4, read again under the lock before a claim.
  const decide = async (): Promise<ServiceSetChoice> => {
    const mode = byMode()
    if (mode) return mode
    const other = await sharedWithAnother(input.defaultRuntimeDir, input.serveHome ? walnutKeyOf(input.serveHome) : null, (input.now ?? Date.now)())
    if (other) return { set: own, why: `the default daemon serves another Walnut (${other})` }
    return { set: def, why: 'the default set is free' }
  }
  const first = await decide()
  if (first.set === own || !input.claim) return first
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  return withServiceModeLockWait(root, async () => {
    await sweepClaimTemps(root)
    const again = await readSetOwner(root)
    if (again !== null) return byClaim(again)
    const now = await decide()
    if (now.set === own) return now
    if (await writeSetOwner(root, input.walnutId)) return { ...now, claimed: true }
    return byClaim((await readSetOwner(root)) ?? '')
  })
}

/** The Walnut a service is for: its own set when another Walnut holds the default (the experiment host_service_sets). */
export const WALNUT_FLAG = '--walnut'
/** The data dir of that Walnut, for the set choice only (no mode word): the leader sends it with --walnut. */
export const WALNUT_HOME_FLAG = '--walnut-home'

/** `walnut daemon` words at `args[i]` (daemon-service-cli.ts): `--walnut <id>` or `--walnut-home <dir>`, null for any other word. */
export function serviceSetFlagAt(args: string[], i: number): { walnut: string } | { walnutHome: string } | null {
  const value = args[i + 1]
  if (args[i] === WALNUT_FLAG) {
    if (!value) throw new Error(`${WALNUT_FLAG} requires the walnut id of the Walnut the service is for`)
    serviceSetIdOf(value)
    return { walnut: value }
  }
  if (args[i] === WALNUT_HOME_FLAG) {
    if (!value || !path.isAbsolute(value)) throw new Error(`${WALNUT_HOME_FLAG} requires the absolute data dir of the Walnut it is for`)
    return { walnutHome: value }
  }
  return null
}

/** The set a `walnut daemon <action>` acts on: with no Walnut named, the default (today's); install and update claim. */
export async function serviceSetOfAction(
  action: string, o: Omit<ServiceSetChoiceInput, 'walnutId' | 'claim'> & { walnutId?: string },
): Promise<ServiceSet> {
  if (!o.walnutId) return serviceSet(o.platform, o.home, '', { runtimeDir: o.defaultRuntimeDir })
  return (await chooseServiceSet({ ...o, walnutId: o.walnutId, claim: action === 'install' || action === 'update' })).set
}
