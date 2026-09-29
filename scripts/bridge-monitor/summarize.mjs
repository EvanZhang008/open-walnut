#!/usr/bin/env node
/**
 * Daily bridge summary: reads the monitor's NDJSON store (collector + probe,
 * plus replica log exports when configured), classifies every drop M1-M6,
 * finds storms and long outages, and posts ONE short letter to the Walnut
 * inbox through POST /api/v1/human-inbox. Run by a LaunchAgent at 08:00.
 *
 * Flags:
 *   --api <url>        inbox API base (default: config inbox.api, the local server)
 *   --day YYYY-MM-DD   the day the subject line reports (default: yesterday)
 *   --days N           table rows, ending today (default: config summary.days)
 *   --dry-run          print the letter, do not post it
 *   --json             print the analysis as JSON (implies --dry-run)
 *   --corrections-only only reply to letters whose verdict changed; no daily letter
 *   --only <id,id>     corrections for exactly these letters (any age; daily
 *                      letters are corrected only when named here)
 *
 * Every run also sends the corrections still owed (lib/corrections.mjs):
 * one reply in the thread of an alert whose verdict the full analysis changed.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { ensureDir, loadConfig } from './lib/config.mjs'
import { Store, dayRange, dayStartMs, localDay, localTz, nextDay, prevDay, readDays } from './lib/store.mjs'
import { analyze, isAligned, MECHS } from './lib/classify.mjs'
import { buildDailyLetter, evidenceBullets, postReply } from './lib/letter.mjs'
import { DAILY_LETTER_VERSION, findCorrections } from './lib/corrections.mjs'
import { deliverLetter } from './lib/outbox.mjs'
import { parseReplicaLine } from './lib/parse-bridge.mjs'

const args = process.argv.slice(2)
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const flag = (name) => args.includes(name)

/** Replica log exports: server JSON logs or the TSV cut, primary alias only. */
async function readReplica(dir, fromMs) {
  if (!dir || !fs.existsSync(dir)) return []
  const out = []
  for (const name of (await fsp.readdir(dir)).filter((n) => /\.(log|tsv|jsonl|ndjson)$/.test(n))) {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, name), 'utf-8'), crlfDelay: Infinity })
    for await (const line of rl) {
      const r = parseReplicaLine(line)
      if (r && (r.alias === '__local__' || r.alias == null) && Date.parse(r.t) >= fromMs) out.push(r)
    }
  }
  return out
}

/** One line on what the monitor itself cost over the report day. */
function healthLine(records, startMs, endMs) {
  const inDay = records.filter((r) => { const t = Date.parse(r.t); return t >= startMs && t < endMs })
  const selfMs = inDay.filter((r) => r.kind === 'load').reduce((s, r) => s + (r.selfCpuMs ?? 0), 0)
  const sweeps = inDay.filter((r) => r.kind === 'tcp-sweep')
  const sweepMs = sweeps.reduce((s, r) => s + (r.cpuMs ?? 0), 0)
  const peakRss = Math.max(0, ...sweeps.map((r) => r.maxRssMB ?? 0))
  const failed = sweeps.filter((r) => r.error || r.timedOut).length
  if (!selfMs && !sweeps.length) return null
  return `collector ${Math.round(selfMs / 1000)} CPU-s, ${sweeps.length} kernel log sweeps ${Math.round(sweepMs / 1000)} CPU-s (peak ${peakRss} MB${failed ? `, ${failed} failed` : ''})`
}

async function main() {
  const { cfg, file: configFile } = loadConfig()
  const api = arg('--api') ?? cfg.inbox.api
  const tz = localTz()
  const nowMs = Date.now()
  const today = localDay(nowMs, tz)
  const reportDay = arg('--day') ?? prevDay(today)
  const nDays = Number(arg('--days')) || cfg.summary.days
  const lastDay = reportDay > today ? reportDay : today
  const days = dayRange(lastDay, nDays)
  const readList = [prevDay(days[0]), ...days]
  const records = [
    ...(await readDays(cfg.logDir, readList)),
    ...(await readDays(cfg.logDir, readList, { prefix: 'probe' })),
  ]
  const dayBounds = days.map((d) => ({ day: d, startMs: dayStartMs(d, tz), endMs: dayStartMs(nextDay(d), tz) }))
  const replica = await readReplica(cfg.replicaLogDir, dayStartMs(readList[0], tz))
  const a = analyze(records, {
    dayBounds, reportDay, nowMs, replica, maxDropsPer10Min: cfg.alert.maxDropsPer10Min, outageSec: cfg.alert.outageSec,
  })
  const rb = dayBounds.find((d) => d.day === reportDay) ?? dayBounds.at(-1)
  const sntp = records.filter((r) => r.kind === 'sntp')
  const bullets = evidenceBullets(a, {
    windowStartMs: rb.startMs, windowEndMs: rb.endMs, nowMs,
    netRecords: a.ctx.net, pubip: records.filter((r) => r.kind === 'pubip'), sntp,
    health: healthLine(records, rb.startMs, rb.endMs),
  })
  if (replica.length === 0) bullets.push('No replica close log yet, so M1 vs M2 rests on Mac-side evidence only.')
  const letter = buildDailyLetter(a, { days: a.days, bullets, storeDir: cfg.logDir, tz, reportDay, outageSec: cfg.alert.outageSec })

  if (flag('--json')) {
    const drops = a.drops.map((d) => ({ downAt: d.downAt, upS: d.upS, reconnectS: d.reconnectS, cause: d.cause, mech: d.mech, basis: d.basis }))
    process.stdout.write(`${JSON.stringify({ days: a.days, phase: a.phase, hypothesis: a.hypothesis, storms: a.storms, drops }, null, 2)}\n`)
    return
  }
  const only = arg('--only') ? arg('--only').split(',').map((x) => x.trim()).filter(Boolean) : null
  const owed = findCorrections(records, a, { nowMs, only, maxDropsPer10Min: cfg.alert.maxDropsPer10Min })
  const store = new Store(cfg.logDir, { tz })
  if (flag('--dry-run')) {
    if (!flag('--corrections-only')) process.stdout.write(`${letter.subject}\n\n${letter.markdown}\n`)
    for (const c of owed) process.stdout.write(`\ncorrection (not sent) ${c.letterId} (${c.reason} letter at ${c.alertAt}): ${c.text}\n`)
    if (flag('--corrections-only') && !owed.length) process.stdout.write('no corrections owed\n')
    return
  }
  for (const c of cfg.inbox.enabled ? owed : []) {
    const res = await postReply(api, c.letterId, c.text)
    await store.append({ kind: c.kind, letterId: c.letterId, text: c.text, delivered: res.ok, status: res.status, error: res.error ?? null })
    process.stdout.write(`correction ${c.letterId}: ${res.ok ? 'sent' : `not sent (${res.error})`}: ${c.text}\n`)
  }
  if (flag('--corrections-only')) return
  ensureDir(cfg.stateDir)
  const res = await deliverLetter({ ...cfg, inbox: { ...cfg.inbox, api } }, letter)
  const report = a.days.find((d) => d.day === reportDay)
  await store.append({
    kind: 'summary', letterVersion: DAILY_LETTER_VERSION, reportDay, drops: report?.drops ?? null, byMech: report?.byMech ?? null,
    top: a.hypothesis.mech, delivered: res.ok, letterId: res.id ?? null, parked: !!res.parked, error: res.error ?? null,
  })
  await fsp.writeFile(path.join(cfg.stateDir, 'last-summary.json'), JSON.stringify({
    // The probe's 'auto' burst phase keys off this; only a real alignment counts.
    t: new Date(nowMs).toISOString(), reportDay, phase: isAligned(a.phase) ? a.phase : null, top: a.hypothesis.mech,
    counts: Object.fromEntries(MECHS.map((m) => [m, a.drops.filter((d) => d.mech === m).length])),
  }), { mode: 0o600 })
  process.stdout.write(`summary ${reportDay}: ${report?.drops ?? 0} drops, top ${a.hypothesis.mech ?? 'none'}, `
    + `${res.ok ? `letter ${res.id}` : `not delivered (${res.error}); ${res.parked ? 'parked for retry' : 'dropped'}`}, config ${configFile}\n`)
}

await main()
