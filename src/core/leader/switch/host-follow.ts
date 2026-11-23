/**
 * Hosts follow the new leader (docs/reference/leader-switch.md, "Hosts follow the new leader"): the
 * steps the old leader's server takes for its hosts and for its own machine around a switch, each a
 * named hook the switch flow calls. Nothing here runs by itself; the flow decides when.
 *
 * Before the handover record (while this server still leads, its outward doors open), in this order:
 *   prepareOldMachineAsHost   this machine's door credential for the new leader: the record in
 *                             auth.json (leader data, so the final batch carries it to the new
 *                             leader) and the host side on this machine's own disk
 *   pushNewLeaderDoors        every host is told the new leader's doors (leader-boot.ts pushHostDoors)
 *   configureOldMachineHostService
 *                             this machine's own daemon runs this Walnut's host service (an ordinary
 *                             host replica spec, replica-run.ts) for when the new leader cannot dial
 *                             this machine's daemon: it dials the new leader's door with the
 *                             credential above. Kept beside the home (hostServiceRecordFile) so this
 *                             home's own boot as the leader takes it back (removeSwitchHostService).
 *   announceSwitchStop        last, right before the handover record (the outward door refuses every
 *                             heartbeat after it): the restart heartbeat says `restartingMs` = the
 *                             commit window (capped at 5 minutes), so the companion's backup lead
 *                             waits; withdrawSwitchStop when the handover does not happen after all
 * After the handover record, before the stop:
 *   retellNetMembers          the host network's member lists again (net-mac.ts retellNet): under a
 *                             running permit they follow its record, which now names the new holder
 *                             handed from this machine, so every host and this machine's own
 *                             walnut-net let the new leader in; each host's answer comes back
 *                             (told, missed) with whether the new leader is let in, so the flow can
 *                             wait or refuse before the stop
 *   dropOwnDaemonDuties       this machine's daemon drops its trigger set and its bridge, so nothing of
 *                             the old leader keeps firing and only the new leader's daemon holds the
 *                             companion's one `__local__` bridge; a rollback's restart pushes both
 *                             again (every boot's link pushes them); a rollback with no restart
 *                             (the handover cancelled before the stop) calls restoreOwnDaemonDuties
 * A handover that did not happen while this server runs on (refused, or cancelled before the stop):
 *   undoHandoverHostSteps     every step above taken back, as the first lead after a restart does
 * The first time this home's server leads (boot.ts onFirstLead: at boot, or later from waiting for
 * the witnesses, so a crash anywhere above converges at the next lead):
 *   takeBackSwitchLeftovers   this machine's console from a handover (console-credential.ts), the
 *                             host service a handover left on this machine's daemon (a rollback) or
 *                             one an earlier leader left there for this Walnut (a switch back:
 *                             removeSwitchHostService), and this machine's own door credential (its
 *                             record in auth.json, the host side): a leader dials no door
 *
 * Every daemon command goes to this machine's own daemon over this server's own link (OwnDaemon,
 * default `link('__local__')`); none is new (`server.configure`, `triggers.configure`,
 * `bridge.configure`).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertOutwardDoor, leaderPermitActive } from './doors.js'
import { cleanDoorUrls, doorKeyId, doorUrlRefusal } from '../../session-channel/door-wire.js'
import type { PermitPair } from '../../session-channel/channel.js'
import { checkHostRoot, HOST_ROOT, walnutDirs, walnutDirsOf, type WalnutHostDirs } from '../../host-server/install.js'

/** What a hook sends to this machine's own daemon (a DaemonConnection does). */
export interface OwnDaemon {
  send(cmd: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
}

export type HookResult<T extends object = object> = ({ ok: true } & T) | { ok: false; why: string }

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function ownDaemon(d?: OwnDaemon): Promise<OwnDaemon> {
  if (d) return d
  const { link } = await import('../../hosts/link.js')
  return link('__local__')
}

// ---- before the handover --------------------------------------------------------------------

export interface OldMachineHostInput {
  walnutId: string
  /** This machine's stable id (machine-id.ts): the credential is for it alone. */
  machineId: string
  /** The new leader's name for this machine in its `hosts` (the record is bound to it). */
  hostKey: string
  /** The new leader's door URLs (wss://, or ws:// to loopback), in the order this machine dials them. */
  doors: readonly string[]
  /** The floor a welcome must not be below (default: this leader's own number, epoch 0). */
  standing?: PermitPair
  /** Tests: this machine's id as the credential file checks it (default readMachineId). */
  thisMachine?: () => Promise<string>
}

/**
 * This machine's door credential for the new leader. Behind the outward door 'host-credential' (a
 * configure of a host: only the holder of the write permission mints one). The record goes into
 * auth.json (leader data: the final batch carries it, so the new leader's door knows this machine),
 * the host side into this machine's state dir (host-credential-file.ts, machine data). A second call
 * mints again (the old key is the record's `previous` for its grace).
 */
export async function prepareOldMachineAsHost(o: OldMachineHostInput): Promise<HookResult<{ keyId: string }>> {
  const doors = cleanDoorUrls(o.doors)
  if (doors.length === 0 || doors.length !== o.doors.length) {
    return { ok: false, why: `the new leader's doors are not doors a host may dial (${o.doors.map((u) => doorUrlRefusal(u) ?? 'a repeat').join('; ') || 'none'})` }
  }
  const [{ readMachineId }, { leaderPermitNumberForHosts }] = await Promise.all([import('../../machine-id.js'), import('../../session-channel/leader-permit.js')])
  const mine = await (o.thisMachine ?? readMachineId)().catch(() => '')
  if (mine !== o.machineId) return { ok: false, why: `the credential is for machine ${o.machineId}, and this is ${mine || 'a machine with no id'}` }
  try {
    if (leaderPermitActive()) assertOutwardDoor('host-credential', `host-credential:${o.machineId}`)
  } catch (err) { return { ok: false, why: why(err) } }
  const [{ mintHostCredential, dropHostCredential }, { writeHostCredentialFile }] = await Promise.all([
    import('../../session-channel/host-credentials.js'), import('../../session-channel/host-credential-file.js'),
  ])
  let minted: { verifyKey: string }
  try {
    minted = await mintHostCredential({ machineId: o.machineId, walnutId: o.walnutId, hostKey: o.hostKey })
  } catch (err) { return { ok: false, why: `the credential was not minted: ${why(err)}` } }
  const standing = o.standing ?? { permitNumber: leaderPermitNumberForHosts(), epoch: 0 }
  const kept = await writeHostCredentialFile(
    { walnutId: o.walnutId, machineId: o.machineId, verifyKey: minted.verifyKey, doors, permitNumber: standing.permitNumber, epoch: standing.epoch },
    o.thisMachine ? { thisMachine: o.thisMachine } : {},
  ).catch((err: unknown) => ({ ok: false as const, error: why(err) }))
  if (!kept.ok) {
    // A record this machine does not hold is no credential: taken back, nothing half made travels.
    await dropHostCredential(o.machineId).catch(() => false)
    return { ok: false, why: `this machine did not keep its credential: ${kept.error}${'why' in kept && kept.why ? ` (${kept.why})` : ''}` }
  }
  return { ok: true, keyId: doorKeyId(minted.verifyKey) }
}

/** Every host hears the new leader's doors now, under this leader's standing (each keeps them only from one not below what it holds). */
export async function pushNewLeaderDoors(doors: readonly string[]): Promise<HookResult<{ dialed: string[]; routed: string[]; failed: string[] }>> {
  const clean = cleanDoorUrls(doors)
  if (clean.length === 0) return { ok: false, why: 'no door a host may dial' }
  const { pushHostDoors } = await import('../../session-channel/leader-boot.js')
  const r = await pushHostDoors(clean)
  return { ok: true, dialed: r.dialed, routed: r.routed, failed: r.failed }
}

/**
 * The host network's member lists, told again now and every host's answer waited for (net-mac.ts
 * retellNet), so the flow can wait or refuse before the stop: a net host that missed this push
 * still lets in only this leader, and once this leader stops nobody tells it again.
 *   told             the net hosts that took the list
 *   missed           those that did not (not connected, refused, too old), each with why
 *   newLeaderLetIn   the record's new holder is on the lists: false when its network id is not known
 *                    here (pass it in `endpoints`: machine id to network id); null with the network
 *                    off or no record naming another holder
 * `ok: false` only when the sync itself failed (this machine's walnut-net, the companion's list).
 */
export async function retellNetMembers(o: { endpoints?: Record<string, string> } = {}): Promise<HookResult<{ told: string[]; missed: Array<{ host: string; why: string }>; newLeaderLetIn: boolean | null }>> {
  const { getConfig } = await import('../../config-manager.js')
  if ((await getConfig() as { net?: { enabled?: boolean } }).net?.enabled !== true) return { ok: true, told: [], missed: [], newLeaderLetIn: null }
  const { retellNet } = await import('../../net/net-mac.js')
  const r = await retellNet(o.endpoints ? { endpoints: o.endpoints } : {})
  if (r.state.error) return { ok: false, why: r.state.error }
  return { ok: true, told: r.told, missed: r.missed, newLeaderLetIn: r.newLeaderLetIn }
}

/** Beside the home (machine data, `local/leader-switch/`): the host service a handover set up on this machine's daemon. */
export function hostServiceRecordFile(home: string): string {
  return path.join(home, 'local', 'leader-switch', 'host-service.json')
}

export interface OldMachineHostServiceInput {
  daemon?: OwnDaemon
  /** This home (the leader home the daemon keeps the spec under; a declared move makes it the new leader's). */
  home: string
  walnutId: string
  /** The new leader's name for this machine (the replica's WALNUT_HOST_KEY). */
  hostKey: string
  /** The loopback port the service listens on (never this server's own port). */
  port: number
  label?: string
  /** The service's dirs (default: the ones the host-server manager would pick on this machine, oldMachineHostDirs). */
  dirs?: WalnutHostDirs
  /** The program and its leading args (default: this CLI, as the switch starts its servers). */
  program?: { command: string; prefix: string[] }
  /** The daemon hands the service this host's own `walnut` calls (follower-gateway-v1). */
  gateway?: boolean
  switchId?: string
}

/**
 * The dirs this Walnut's host service uses on this machine, as the host-server manager picks them on
 * any host (install.ts walnutDirsOf): under its root (WALNUT_HOST_SERVER_ROOT, else HOST_ROOT), the
 * shared dirs from before the split when this Walnut marked them its own, else its own dirs.
 * The manager also asks its record of that host; this machine was never this leader's host, so the
 * mark alone says it (read only: nothing is marked here).
 */
export async function oldMachineHostDirs(walnutId: string): Promise<WalnutHostDirs> {
  const { hostServerRootSpec } = await import('../../host-server/index.js')
  const spec = checkHostRoot(hostServerRootSpec() ?? HOST_ROOT)
  const root = spec.replace('$HOME', () => os.homedir())
  let mark = ''
  try { mark = fs.readFileSync(path.join(walnutDirs(root, null).dataDir, '.walnut-id'), 'utf8') } catch { /* none */ }
  return walnutDirsOf(root, walnutId, mark === walnutId)
}

/** The spec `server.configure` takes: the ordinary host replica (replica-run.ts), as the host-server manager sends it. */
export async function oldMachineHostServiceSpec(o: OldMachineHostServiceInput): Promise<Record<string, unknown> & { cwd: string; log: string }> {
  const [{ hostProgramRun, hostServerEnvOf }, { serverCommand }, { pluginsKeepingTasks }] = await Promise.all([
    import('../../host-server/replica-run.js'), import('../../trial-start/process.js'),
    import('../../plugins/plugin-task-visibility.js'),
  ])
  const dirs = o.dirs ?? await oldMachineHostDirs(o.walnutId)
  const [command, ...prefix] = o.program ? [o.program.command, ...o.program.prefix] : serverCommand([])
  const env = hostServerEnvOf({ dataDir: dirs.dataDir, runDir: dirs.runDir, port: o.port, leaderHome: path.resolve(o.home), walnutId: o.walnutId, label: o.label ?? (os.hostname().split('.')[0] || 'host') })
  const run = hostProgramRun({ prefix, env, replica: true, hostKey: o.hostKey, gateway: o.gateway === true })
  return { v: 1, home: path.resolve(o.home), walnutId: o.walnutId, command: command!, args: run.args, cwd: dirs.dataDir, env: run.env, ...(run.fallback ? { fallback: run.fallback } : {}), log: dirs.logFile, port: o.port,
    // The manager's settings for a host with no tunnel placed there (manager.ts specOf).
    settings: { expose: null, exposeRetry: 0, pluginsKeepTasks: pluginsKeepingTasks() } }
}

/**
 * This machine's daemon runs this Walnut's host service (B3's console replica is this service plus its
 * console door). The record beside the home is written first, so a crash after the configure still
 * leaves this home's next lead boot what to take back.
 */
export async function configureOldMachineHostService(o: OldMachineHostServiceInput): Promise<HookResult<{ status: unknown }>> {
  if (!Number.isInteger(o.port) || o.port <= 0 || o.port > 65_535) return { ok: false, why: `not a port: ${o.port}` }
  const spec = await oldMachineHostServiceSpec(o)
  try {
    for (const d of [spec.cwd, path.dirname(spec.log), String((spec.env as Record<string, string>).WALNUT_DAEMON_DIR)]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
    const file = hostServiceRecordFile(o.home)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ v: 1, home: path.resolve(o.home), walnutId: o.walnutId, hostKey: o.hostKey, port: o.port, ...(o.switchId ? { switchId: o.switchId } : {}), at: new Date().toISOString() }))
    const reply = await (await ownDaemon(o.daemon)).send('server.configure', { home: path.resolve(o.home), spec }, 15_000)
    if (reply.ok !== true) return { ok: false, why: `this machine's daemon refused the host service: ${String(reply.error ?? 'refused')}` }
    return { ok: true, status: reply.status }
  } catch (err) { return { ok: false, why: why(err) } }
}

// ---- before the stop ------------------------------------------------------------------------

/**
 * This machine's daemon drops this Walnut's trigger set and its bridge (and this server pushes
 * neither again until it exits: own-bridge-hold.ts; a trigger push past the handover is refused by
 * the outward door 'trigger-arm'). Both answers are returned; one that failed says so.
 */
export async function dropOwnDaemonDuties(o: { daemon?: OwnDaemon; home: string }): Promise<HookResult<{ triggers: boolean; bridge: boolean }>> {
  const { holdOwnBridge } = await import('../own-bridge-hold.js')
  holdOwnBridge(true)
  const d = await ownDaemon(o.daemon)
  const home = path.resolve(o.home)
  const [t, b] = await Promise.all([
    d.send('triggers.configure', { home, config: { version: 1, triggers: [] } }, 20_000).catch((err: unknown) => ({ ok: false, error: why(err) })),
    d.send('bridge.configure', { home, enabled: false }, 20_000).catch((err: unknown) => ({ ok: false, error: why(err) })),
  ])
  if (t.ok === true && b.ok === true) return { ok: true, triggers: true, bridge: true }
  return { ok: false, why: [t.ok === true ? '' : `the trigger set: ${String(t.error ?? 'refused')}`, b.ok === true ? '' : `the bridge: ${String(b.error ?? 'refused')}`].filter(Boolean).join('; ') }
}

/**
 * The switch rolled back while this server runs on (its handover cancelled before the stop): the
 * bridge hold ends and its own daemon gets this Walnut's trigger set and bridge again, as a boot's
 * link pushes them (the trigger push asks the daemon first, so the set crosses again only when the
 * drop took it). A rollback through a restart needs none of this.
 */
export async function restoreOwnDaemonDuties(o: { daemon?: { recheckTriggers(): void; pushBridgeConfig(): void } } = {}): Promise<HookResult> {
  const { holdOwnBridge } = await import('../own-bridge-hold.js')
  holdOwnBridge(false)
  try {
    const d = o.daemon ?? await (await import('../../hosts/link.js')).link('__local__')
    d.recheckTriggers()
    d.pushBridgeConfig()
    return { ok: true }
  } catch (err) { return { ok: false, why: why(err) } }
}

/**
 * The companion hears now that this leader goes down for the commit window (capped at 5 minutes):
 * the restart heartbeat with `restartingMs`, sent at once, and the regular heartbeats stop, so no
 * later beat clears it. Call it BEFORE the handover record: from that record on this machine may not
 * act, and the outward door `companion-upload` refuses every heartbeat (events-v1.ts), so a notice
 * sent at the stop never leaves (measured, tests/e2e/leader-switch-companion-follow-live-e2e.test.ts).
 * Returns what the notice said (null: nothing sent). A handover refused or cancelled after it:
 * withdrawSwitchStop.
 */
export async function announceSwitchStop(commitWindowMs: number, o: { maxWaitMs?: number } = {}): Promise<number | null> {
  const { setRestartNotice, announceLeaderRestart, leaderHeartbeatRunning } = await import('../primary-leader.js')
  const ms = setRestartNotice(commitWindowMs)
  if (ms === null) return null
  // The notice stops the regular heartbeats: withdrawSwitchStop starts them again only if they ran.
  if (leaderHeartbeatRunning()) heartbeatStoppedBySwitch = true
  await announceLeaderRestart(o.maxWaitMs ?? 1_500)
  return ms
}

/** announceSwitchStop stopped this process's regular heartbeats (they ran when it was called). */
let heartbeatStoppedBySwitch = false

/**
 * The switch did not stop this leader after all (a refused or cancelled handover): the notice is
 * withdrawn, and the heartbeats beat again if announceSwitchStop stopped them (never where they did
 * not run: no notice sent, or a boot policy with no heartbeat).
 */
export async function withdrawSwitchStop(): Promise<{ restarted: boolean; stop: () => void }> {
  const { setRestartNotice, startLeaderHeartbeat } = await import('../primary-leader.js')
  setRestartNotice(null)
  if (!heartbeatStoppedBySwitch) return { restarted: false, stop: () => {} }
  heartbeatStoppedBySwitch = false
  return { restarted: true, stop: startLeaderHeartbeat().stop }
}

// ---- the first time this home's server leads -----------------------------------------------

/**
 * This machine's own door credential goes: its record in auth.json (a leader verifies no door of
 * its own machine) and the host side this machine dials with (a leader dials no door). Each part
 * tried; `failed` says which did not go.
 */
async function dropOwnCredential(machineId: string, walnutId: string): Promise<{ record: boolean; file: boolean; failed: string[] }> {
  const [{ dropHostCredential }, { hostCredentialFile }] = await Promise.all([
    import('../../session-channel/host-credentials.js'), import('../../session-channel/host-credential-file.js'),
  ])
  const failed: string[] = []
  const record = await dropHostCredential(machineId).catch((err: unknown) => { failed.push(`the credential: ${why(err)}`); return false })
  let file = false
  try {
    const f = hostCredentialFile(walnutId)
    file = fs.existsSync(f)
    fs.rmSync(f, { force: true })
  } catch (err) { failed.push(`the host side of the credential: ${why(err)}`); file = false }
  return { record, file, failed }
}

export interface SwitchLeftovers { console: boolean; hostService: boolean; credential: boolean; credentialFile: boolean }

/**
 * What a switch left on this machine, taken back the first time this home's server leads (boot.ts
 * onFirstLead), whichever way it came to lead: at boot, or later from waiting for the witnesses (a
 * restart after a cut that lost them too, in the B2b design). A crash after any step before the
 * handover record, or a rollback after it, so converges at the next lead. In a home that took part
 * in a switch (its `local/leader-switch/` folder; no other home has one):
 *   - this machine's console from a handover (console-credential.ts withdrawConsole; any home, as before);
 *   - the host service on this machine's daemon (removeSwitchHostService);
 *   - this machine's own door credential: the record in auth.json and the host side.
 * Each part tried; the answer says what went and what failed.
 */
export async function takeBackSwitchLeftovers(o: {
  home: string
  /** This machine's id in the permit (the console's device is named for it). */
  machine: string
  daemon?: OwnDaemon
  /** Tests: this machine's id as its credential names it (default machine-id.ts readMachineId) and this Walnut's id (default getInstanceId). */
  machineId?: () => Promise<string>
  walnutId?: () => Promise<string>
}): Promise<HookResult<SwitchLeftovers>> {
  const home = path.resolve(o.home)
  const failed: string[] = []
  const out: SwitchLeftovers = { console: false, hostService: false, credential: false, credentialFile: false }
  try {
    const { withdrawConsole } = await import('./console-credential.js')
    const w = await withdrawConsole({ home, machine: o.machine })
    out.console = w.device || w.files.length > 0
  } catch (err) { failed.push(`the console: ${why(err)}`) }
  if (fs.existsSync(path.join(home, 'local', 'leader-switch'))) {
    const hs = await removeSwitchHostService({ home, ...(o.daemon ? { daemon: o.daemon } : {}) })
    if (hs.ok) out.hostService = hs.removed
    else failed.push(`the host service: ${hs.why}`)
    try {
      const [machineId, walnutId] = await Promise.all([
        (o.machineId ?? (async () => (await import('../../machine-id.js')).readMachineId()))(),
        (o.walnutId ?? (async () => (await import('../../device-store.js')).getInstanceId()))(),
      ])
      const own = await dropOwnCredential(machineId, walnutId)
      out.credential = own.record
      out.credentialFile = own.file
      failed.push(...own.failed)
    } catch (err) { failed.push(`this machine's credential: ${why(err)}`) }
  }
  return failed.length ? { ok: false, why: failed.join('; ') } : { ok: true, ...out }
}


/**
 * Take back a host service of this Walnut on this machine's own daemon that a switch left: the one a
 * handover set up (its record beside the home: a rollback), or, in a home a switch promoted, one an
 * earlier leader set up here when this machine was its host (a switch back; the declared move made
 * that leader's home this one on the daemon). Nothing in a home that took no part in a switch.
 */
export async function removeSwitchHostService(o: { daemon?: OwnDaemon; home: string }): Promise<HookResult<{ removed: boolean }>> {
  const home = path.resolve(o.home)
  const { promotedFile } = await import('./records.js')
  const ours = fs.existsSync(hostServiceRecordFile(home))
  if (!ours && !fs.existsSync(promotedFile(home))) return { ok: true, removed: false }
  return takeBackHostService(o.daemon, home)
}

/** The host service of `home` on this machine's daemon goes, and the record beside the home with it. */
async function takeBackHostService(daemon: OwnDaemon | undefined, home: string): Promise<HookResult<{ removed: boolean }>> {
  try {
    const d = await ownDaemon(daemon)
    const st = await d.send('server.status', { home }, 10_000)
    if (st.ok !== true) return { ok: false, why: `this machine's daemon did not say what runs for this home: ${String(st.error ?? 'no answer')}` }
    // Sent whatever the state says: a spec adopted and not started yet reads 'off' (host-server-core.ts statusOf).
    const r = await d.send('server.configure', { home, spec: null }, 15_000)
    if (r.ok !== true) return { ok: false, why: `this machine's daemon kept the host service: ${String(r.error ?? 'refused')}` }
    fs.rmSync(hostServiceRecordFile(home), { force: true })
    return { ok: true, removed: ((st.status as { state?: string } | undefined)?.state ?? 'off') !== 'off' }
  } catch (err) { return { ok: false, why: why(err) } }
}

// ---- a handover that did not happen, while this server runs on ------------------------------

/**
 * The switch rolled back and this server leads on with no restart (its handover refused, or cancelled
 * before the stop): every step above is taken back here, as the first lead after a restart does
 * (takeBackSwitchLeftovers), and what only a running server holds with them. The host service
 * a handover set up (its record), this machine's credential for the new leader (the record in
 * auth.json, and the host side), the bridge hold with the trigger set and bridge pushed again, and the
 * restart notice withdrawn. Each step is tried; the answer lists what failed.
 */
export async function undoHandoverHostSteps(o: {
  home: string
  walnutId: string
  machineId: string
  daemon?: OwnDaemon & { recheckTriggers(): void; pushBridgeConfig(): void }
}): Promise<HookResult<{ hostService: boolean; credential: boolean }>> {
  const home = path.resolve(o.home)
  const failed: string[] = []
  let hostService = false
  if (fs.existsSync(hostServiceRecordFile(home))) {
    const r = await takeBackHostService(o.daemon, home)
    if (r.ok) hostService = r.removed
    else failed.push(`the host service: ${r.why}`)
  }
  const own = await dropOwnCredential(o.machineId, o.walnutId)
  failed.push(...own.failed)
  const credential = own.record
  const duties = await restoreOwnDaemonDuties(o.daemon ? { daemon: o.daemon } : {})
  if (!duties.ok) failed.push(`the trigger set and bridge: ${duties.why}`)
  try { await withdrawSwitchStop() } catch (err) { failed.push(`the heartbeat: ${why(err)}`) }
  return failed.length ? { ok: false, why: failed.join('; ') } : { ok: true, hostService, credential }
}
