/**
 * Live anomaly detector (pure). The collector calls evaluateAlerts() after
 * every tail pass with the recent links; it answers which alerts to send and
 * the updated state. Two triggers:
 *   storm   more than `maxDropsPer10Min` drops in the trailing 10 minutes
 *   outage  the bridge stayed down longer than `outageSec` while the Mac was
 *           awake. "Awake" has to be shown, not assumed: the collector must
 *           have sampled through the whole outage (awakeThrough in
 *           classify.mjs, the same rule the classifier uses). An outage with
 *           a sleep, a starved gap of unknown state, or no samples in it is
 *           skipped unless `includeSleep`.
 * Rate limits: one alert per trigger per `cooldownMin`, one per outage, and
 * at most `maxPerDay` per local day.
 */

import { awakeThrough } from './classify.mjs'

export function freshAlertState() {
  return { sent: [], outageKeys: [], day: null, today: 0, suppressed: 0 }
}

function overlapsSleep(startMs, endMs, gaps) {
  return gaps.some((g) => {
    const end = Date.parse(g.t)
    const start = end - (g.sleptMs ?? 0)
    return (g.sleptMs ?? 0) > 2000 && start < endMs + 10_000 && end > startMs - 10_000
  })
}

/**
 * @param {object} state  from freshAlertState() (not mutated)
 * @param {object} input  { links, gaps, load, nowMs, day }  load: the collector's load samples [{t}]
 * @param {object} cfg    the `alert` config section
 * @returns {{alerts: object[], state: object}}
 */
export function evaluateAlerts(state, { links, gaps = [], load = [], nowMs, day }, cfg) {
  const next = { ...freshAlertState(), ...state, sent: [...(state?.sent ?? [])], outageKeys: [...(state?.outageKeys ?? [])] }
  if (next.day !== day) { next.day = day; next.today = 0 }
  const alerts = []
  if (!cfg?.enabled) return { alerts, state: next }
  const cooldownMs = (cfg.cooldownMin ?? 30) * 60_000
  const lastOf = (reason) => Math.max(0, ...next.sent.filter((s) => s.reason === reason).map((s) => s.ms))

  const candidates = []
  // Drops inside a sleep (dark wake redials) are expected, as for outages.
  const recent = links.filter((l) => l.downMs != null && l.downMs > nowMs - 600_000 && l.downMs <= nowMs
    && (cfg.includeSleep || !overlapsSleep(l.downMs, l.downMs, gaps)))
  if (recent.length > (cfg.maxDropsPer10Min ?? 3)) {
    // `drops`: exactly the drops counted, so the letter lists the same window its title names.
    candidates.push({ reason: 'storm', count: recent.length, key: `storm:${recent[0].downMs}`, fromMs: recent[0].downMs, drops: recent })
  }
  const thresholdMs = (cfg.outageSec ?? 60) * 1000
  links.forEach((l, i) => {
    if (l.downMs == null || l.downMs < nowMs - 30 * 60_000) return
    const ongoing = l.reconnectS == null && i === links.length - 1
    const durMs = ongoing ? nowMs - l.downMs : (l.reconnectS ?? 0) * 1000
    if (durMs <= thresholdMs) return
    const key = `outage:${l.downMs}`
    if (next.outageKeys.includes(key)) return
    if (!cfg.includeSleep && !awakeThrough({ load, gaps }, l.downMs, l.downMs + durMs)) return
    candidates.push({ reason: 'outage', durS: Math.round(durMs / 1000), ongoing, downMs: l.downMs, key, mech: l.mech ?? null, basis: l.basis ?? null, drops: [l] })
  })

  for (const c of candidates) {
    if (c.reason === 'outage') next.outageKeys.push(c.key)
    if (nowMs - lastOf(c.reason) < cooldownMs || next.today >= (cfg.maxPerDay ?? 6)) {
      next.suppressed++
      continue
    }
    next.sent.push({ reason: c.reason, ms: nowMs, key: c.key })
    next.today++
    alerts.push(c)
  }
  next.sent = next.sent.slice(-20)
  next.outageKeys = next.outageKeys.slice(-50)
  return { alerts, state: next }
}
