/**
 * This machine's console after it hands the leader over (core/handed-over-console.ts): minted by
 * the old leader's server at the handover, before its handover record (before-handover.ts).
 *
 *   - A device record `console-<machine>` in auth.json. auth.json is leader data, so the record
 *     reaches the new leader in the switch's final batch: the new leader knows the device, and
 *     sends it to its replicas in their device copy.
 *   - The console file, outside the home (beside the machine id): the home, the address this
 *     server listens on, the switch, and the device's token. The replica this machine's daemon
 *     runs for the new leader reads it and serves the console there (replica/console-door.ts).
 *
 * A handover asked again (a resumed switch) mints again: the old record goes (its hash
 * tombstoned) and the new token replaces it in the file, before the final batch reads auth.json.
 * The device is the console of this machine on the new leader, revocable as any device.
 *
 * A console that will never stand is withdrawn (withdrawConsole): a handover refused after the
 * mint and a cancel take the record and the file back. A handover to a machine drops that machine's
 * own console device (a switch back: its console was a replica's, and it leads now); its file goes
 * once it leads (side.ts).
 */
import path from 'node:path'
import { freshRecord, getInstanceId, tombstone, updateAuth } from '../../device-store.js'
import { removeConsolesOfHome, writeConsoleFile } from '../../handed-over-console.js'
import { readMarker } from './records.js'

export interface ConsoleMint { ok: true; device: string; switchId: string }

/** The console device's name for machine `machine`: `console-<id>`, cut to a valid device name. */
export function consoleDeviceName(machine: string): string {
  const safe = machine.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[^A-Za-z0-9]+/, '')
  return `console-${safe || 'machine'}`.slice(0, 64)
}

export async function prepareConsoleForHandover(o: {
  to: string
  machine: string
  home: string
  /** Where this server listens: the console's address. */
  address: { port: number; host: string }
  dir?: string
}): Promise<ConsoleMint | { ok: false; why: string }> {
  const marker = readMarker(o.home)
  if (!marker || marker.torn || marker.state !== 'switching' || marker.to !== o.to) {
    return { ok: false, why: `no switch to ${o.to} is under way in ${o.home} (its handed-over marker): the console of this machine is minted only for one` }
  }
  const device = consoleDeviceName(o.machine)
  const walnutId = await getInstanceId()
  // The machine the lead goes to has no console of its own once it leads (a switch back).
  const theirs = consoleDeviceName(o.to)
  const token = await updateAuth((auth) => {
    const fresh = freshRecord(device)
    const old = auth.devices.filter((d) => d.name === device || d.name === theirs)
    tombstone(auth, old.map((d) => d.tokenHash))
    auth.devices = [...auth.devices.filter((d) => d.name !== device && d.name !== theirs), fresh.record]
    return { persist: true, result: fresh.token }
  })
  writeConsoleFile({
    v: 1, walnutId, home: path.resolve(o.home), port: o.address.port, host: o.address.host,
    switchId: marker.switchId, to: o.to, device, token, at: new Date().toISOString(),
  }, o.dir)
  return { ok: true, device, switchId: marker.switchId }
}

/**
 * This machine's console of `home` will never stand (the handover was refused after the mint, or
 * cancelled): its device record leaves this server's auth.json (its hash tombstoned, so a copy of
 * the token never works again) and its console file goes. Nothing to do is no error.
 */
export async function withdrawConsole(o: { home: string; machine: string; dir?: string }): Promise<{ device: boolean; files: string[] }> {
  const device = consoleDeviceName(o.machine)
  const removed = await updateAuth((auth) => {
    const old = auth.devices.filter((d) => d.name === device)
    if (old.length === 0) return { persist: false, result: false }
    tombstone(auth, old.map((d) => d.tokenHash))
    auth.devices = auth.devices.filter((d) => d.name !== device)
    return { persist: true, result: true }
  })
  return { device: removed, files: removeConsolesOfHome(path.resolve(o.home), o.dir) }
}
