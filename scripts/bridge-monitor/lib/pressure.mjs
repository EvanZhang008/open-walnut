/**
 * "Is the machine too busy for a heavy sample right now?"
 *
 * The kernel log sweep (`log show`: about 8 CPU-s for its usual 20 minutes and
 * about 30 for a full catch-up, 500 to 600 MB for a moment) and
 * the daily `pmset -g log` read are the only heavy things the collector does.
 * They are skipped, and retried a few minutes later, when:
 *   - the kernel reports memory pressure at or above `maxPressureLevel`
 *     (kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical), or
 *   - only when configured: every slot of a machine-wide heavy-job semaphore
 *     is held (`busySlots: {base, count}` names slot directories
 *     `<base>.1..N`, each holding the holder's pid). Off by default: a busy
 *     machine is when the bridge flaps, and skipping then loses the evidence.
 * A skipped sweep loses nothing while the next one still falls inside the
 * unified log's retention: its window stretches back to the last success.
 */

import fsp from 'node:fs/promises'
import { run } from './run.mjs'

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch (err) { return err?.code === 'EPERM' }
}

/** Busy slots of `<base>.1..count`. A dead holder or an unstamped old dir is free. */
export async function busySlots({ base, count }, nowMs = Date.now()) {
  let busy = 0
  for (let i = 1; i <= count; i++) {
    const dir = `${base}.${i}`
    let st
    try { st = await fsp.stat(dir) } catch { continue }
    let pid = null
    try { pid = Number((await fsp.readFile(`${dir}/pid`, 'utf-8')).trim()) } catch { /* not stamped yet */ }
    if (pid ? alive(pid) : nowMs - st.mtimeMs < 60_000) busy++
  }
  return busy
}

export async function pressureLevel() {
  const res = await run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeoutMs: 3000 })
  const n = Number(res.stdout.trim())
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * @param {object} opts  { busySlots?: {base, count} | null, maxPressureLevel?: number }
 * @returns {Promise<{busy: boolean, reason: string|null, slotsBusy: number|null, pressure: number|null}>}
 */
export async function heavyGuard({ busySlots: slots = null, maxPressureLevel = 4 } = {}, deps = {}) {
  const countBusy = deps.busySlots ?? busySlots
  const readPressure = deps.pressureLevel ?? pressureLevel
  const slotsBusy = slots?.base && slots.count > 0 ? await countBusy(slots) : null
  const pressure = await readPressure()
  if (slotsBusy != null && slotsBusy >= slots.count) {
    return { busy: true, reason: `heavy-job slots busy (${slotsBusy}/${slots.count})`, slotsBusy, pressure }
  }
  if (pressure != null && maxPressureLevel && pressure >= maxPressureLevel) {
    return { busy: true, reason: `memory pressure level ${pressure}`, slotsBusy, pressure }
  }
  return { busy: false, reason: null, slotsBusy, pressure }
}
