/**
 * Corrections for live alerts (and, on request, daily letters). An alert is written with what the collector
 * knew at that moment; the daily pmset read and the kernel sweeps can show
 * later that the verdict was wrong (live 2026-09-28: two "down while the Mac
 * was awake" alerts went out while the Mac was in fact asleep). When a
 * re-classification changes an alert's verdict, the monitor replies ONCE in
 * that letter's thread with one plain sentence, and records
 * {kind:'alert-correction', letterId} so it never says it twice.
 */

import { MECH_LABELS, MECHS, sleptDuring } from './classify.mjs'

/** Daily letters from before version 2 did not bound their evidence at the day's end. */
export const DAILY_LETTER_VERSION = 2

export const ASLEEP_SENTENCE = 'Correction: the Mac was asleep then, so this was not a drop while awake.'

/**
 * The correction for one alert record against a fresh analysis, or null
 * when its verdict still holds (or the drop is not in the records read).
 */
export function verdictChange(rec, a, { maxDropsPer10Min = 3 } = {}) {
  const sentMs = Date.parse(rec.t)
  if (rec.reason === 'outage') {
    // Records from before downMs was stored: the alert went out durS after the drop.
    const downMs = rec.downMs ?? sentMs - (rec.durS ?? 0) * 1000
    const link = a.links.find((l) => l.downMs != null && Math.abs(l.downMs - downMs) <= 20_000)
    if (!link) return null
    const endMs = link.reconnectS != null ? link.downMs + link.reconnectS * 1000 : downMs + (rec.durS ?? 0) * 1000
    // The silence before a watchdog drop belongs to it: that is when the link died.
    const fromMs = link.downMs - (link.silentMs ?? 0)
    if (link.ctx?.slept || sleptDuring(a.ctx, fromMs, endMs)) return ASLEEP_SENTENCE
    if (rec.mech && link.mech && rec.mech !== link.mech) {
      return `Correction: this drop was ${link.mech} (${MECH_LABELS[link.mech]}), not ${rec.mech} (${MECH_LABELS[rec.mech]}).`
    }
    return null
  }
  if (rec.reason === 'storm') {
    const drops = a.drops.filter((d) => d.downMs > sentMs - 600_000 && d.downMs <= sentMs)
    const awake = drops.filter((d) => d.mech !== 'M3' && !d.ctx?.slept)
    if (drops.length && awake.length <= maxDropsPer10Min) {
      return awake.length === 0
        ? `Correction: the Mac was asleep through that window, so none of those ${drops.length} drops happened while it was awake and this was not a storm.`
        : `Correction: the Mac was asleep for part of that window, so only ${awake.length} of those ${drops.length} drops happened while it was awake and this was not a storm.`
    }
  }
  return null
}

/**
 * The correction for a sent daily letter (a `summary` record) against a
 * fresh analysis, or null when its day's counts still hold and its evidence
 * lines were already bounded to the day.
 */
export function dailyCorrection(rec, a) {
  const row = a.days?.find((d) => d.day === rec.reportDay)
  if (!row) return null
  const count = (byMech, m) => byMech?.[m] ?? 0
  const same = row.drops === rec.drops && MECHS.every((m) => count(row.byMech, m) === count(rec.byMech, m))
  const unbounded = (rec.letterVersion ?? 1) < DAILY_LETTER_VERSION
  if (same && !unbounded) return null
  const parts = MECHS.filter((m) => count(row.byMech, m)).map((m) => `${count(row.byMech, m)} ${m} (${MECH_LABELS[m]})`)
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts.join('')
  const counts = row.drops ? `${row.drops} drop${row.drops === 1 ? '' : 's'}: ${list}` : 'no drops'
  return `Correction: counted again with the current rules, ${rec.reportDay} had ${counts}${unbounded ? `; the evidence lines in this letter also counted events from after ${rec.reportDay}` : ''}.`
}

/**
 * Corrections still owed. Alerts: delivered ones without a delivered
 * correction, no older than `maxAgeHours` (a correction days later helps
 * nobody), or exactly the letters in `only`. Daily letters only when named
 * in `only`: their counts shift a little as late evidence lands, and a reply
 * every morning would be noise.
 */
export function findCorrections(records, a, { nowMs = Date.now(), maxAgeHours = 36, only = null, maxDropsPer10Min = 3 } = {}) {
  const done = new Set(records.filter((r) => (r.kind === 'alert-correction' || r.kind === 'daily-correction') && r.delivered).map((r) => r.letterId))
  const out = []
  for (const rec of records.filter((r) => r.kind === 'alert' && r.delivered && r.letterId)) {
    if (done.has(rec.letterId)) continue
    if (only ? !only.includes(rec.letterId) : nowMs - Date.parse(rec.t) > maxAgeHours * 3_600_000) continue
    const text = verdictChange(rec, a, { maxDropsPer10Min })
    if (text) out.push({ kind: 'alert-correction', letterId: rec.letterId, alertAt: rec.t, reason: rec.reason, text })
  }
  for (const rec of records.filter((r) => r.kind === 'summary' && r.delivered && r.letterId && only?.includes(r.letterId))) {
    if (done.has(rec.letterId)) continue
    const text = dailyCorrection(rec, a)
    if (text) out.push({ kind: 'daily-correction', letterId: rec.letterId, alertAt: rec.t, reason: 'daily', text })
  }
  return out
}
