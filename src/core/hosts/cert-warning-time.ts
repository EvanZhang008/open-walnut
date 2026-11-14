import { createClockSchedule } from '../../providers/clock-schedule-core.js'
import { bus, eventData, EventNames } from '../event-bus.js'

const HOUR = 3_600_000
const schedule = createClockSchedule()
interface WarningTime { expiresAt: number; now: number; warnAheadMs: number; timeZone: string; online: boolean }

function nightSlots(expiresAt: number, timeZone: string): number[] {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', hourCycle: 'h23',
  }).format(expiresAt))
  if (hour >= 8 && hour < 22) return []
  // Real wall-clock slots, not a fixed UTC offset: DST can change during the night.
  let evening = schedule.nextRunAtMs({ kind: 'cron', expr: '0 18 * * *', tz: timeZone }, expiresAt - 26 * HOUR)
  if (evening == null || evening >= expiresAt) return []
  const next = schedule.nextRunAtMs({ kind: 'cron', expr: '0 18 * * *', tz: timeZone }, evening + 1)
  if (next != null && next < expiresAt) evening = next
  const deadline = schedule.nextRunAtMs({ kind: 'cron', expr: '0 21 * * *', tz: timeZone }, evening)
  return deadline == null ? [evening] : [evening, deadline]
}

/** Night expiries get an online evening opportunity, then a deadline before 22:00. */
export function certificateWarningDue(input: WarningTime): boolean {
  const { expiresAt, now, warnAheadMs, timeZone, online } = input
  if (expiresAt - now <= warnAheadMs) return true
  const [evening, deadline] = nightSlots(expiresAt, timeZone)
  return evening !== undefined && now >= evening && (online || (deadline !== undefined && now >= deadline))
}

/** Align the clock with warning boundaries; presence can wake it between polling checks. */
export function certificateWarningCheckMs(input: WarningTime, maxMs: number): number {
  const boundaries = [input.expiresAt - input.warnAheadMs, ...nightSlots(input.expiresAt, input.timeZone)]
  return Math.max(1, Math.min(maxMs, ...boundaries.filter(at => at > input.now).map(at => at - input.now)))
}

/** Existing human attention events only; no screen input, polling helper or credentials. */
export function watchCertificatePresence(
  now: () => number = Date.now, onOnline?: () => void,
): { online: () => boolean; stop: () => void } {
  let seen = 0
  let wakeAt = 0
  const subscriber = 'ssh-certificate-presence'
  const note = (at: number) => {
    if (!Number.isFinite(at)) return
    seen = Math.max(seen, Math.min(at, now()))
    if (now() - seen < 5 * 60_000 && (!wakeAt || now() - wakeAt >= 60_000)) {
      wakeAt = now()
      onOnline?.()
    }
  }
  bus.subscribe(subscriber, (event) => {
    if (event.name === EventNames.TIME_BANKED) {
      const data = eventData<typeof EventNames.TIME_BANKED>(event)
      for (const record of data?.records ?? []) {
        if (record.kind === 'agent' || !(record.durationMs > 0)) continue
        note(Date.parse(record.ts) + record.durationMs)
      }
    } else {
      const data = eventData<typeof EventNames.TIME_OUTSIDE>(event)
      if (data && data.durationMs > 0 && (data.idleSecs === undefined || data.idleSecs < 60)) {
        note(Date.parse(data.ts) + data.durationMs)
      }
    }
  }, { global: true, interest: [EventNames.TIME_BANKED, EventNames.TIME_OUTSIDE] })
  return { online: () => seen > 0 && now() - seen < 5 * 60_000, stop: () => bus.unsubscribe(subscriber) }
}
