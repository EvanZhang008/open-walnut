/**
 * The launcher's `leaving` mark (service-launcher-script.ts l_exited): the service `pid` says its next
 * exit is planned, so the launcher counts no crash, waits no backoff, and in a trial or a probation
 * rolls nothing back. Its one writer of the format, shared by the beat (service-launcher-beat.ts) and
 * a service start that ends before its server loads (service-lead-ready.ts). Only node:fs and node:path.
 */
import fs from 'node:fs'
import path from 'node:path'

export function leavingText(pid: number, reason: string, nowS = Math.floor(Date.now() / 1000)): string {
  return `pid=${pid}\nreason=${reason.replace(/[\r\n]+/g, ' ')}\nat=${nowS}\n`
}

/** Sync on purpose: the exit follows the call, so an async write might never land. Throws when it did not land. */
export function writeLeavingMarkSync(dir: string, pid: number, reason: string): void {
  const file = path.join(dir, 'leaving')
  fs.writeFileSync(`${file}.t`, leavingText(pid, reason), { mode: 0o600 })
  fs.renameSync(`${file}.t`, file)
}
