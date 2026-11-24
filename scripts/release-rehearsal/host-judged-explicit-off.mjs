/**
 * Scenario 5 of host-judged-rollback.mjs: a person who turned the switch off before the default
 * turned it on stays off, through this tree's leader, a downgrade to the older release and the
 * upgrade back. Two variants, one cluster each:
 *
 *   experiment  `experimental.host_runs_sessions: false` in the Mac's config.yaml
 *   host        `hosts.<host>.runs_sessions: false` (the experiment unset, so on by default)
 *
 * Each round (this tree, the older release, this tree again): the leader hands the host no start
 * (this tree's probe: /side judges false; the older release has no channel at all), a new start
 * there is answered and judged legacy, and the stored false is still in config.yaml. Under the older
 * release Settings writes the experiment map as the page does (the map it read, one flag changed)
 * and the host row as it read it, so a release that drops a key it does not know fails here.
 */
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { HOST_KEY, waitFor } from '../../tests/helpers/replica-cluster.ts'
import { startHostJudgeCluster } from '../../tests/helpers/host-judge-cluster.ts'
import { NET_HOST_LINES, clusterDirs, startNewLeaderAgain, startOldLeader, stopClusterMac, stopMacDaemon } from './host-judged-leaders.mjs'
import { keepLogs, leaderReads, startOn, stopLeftovers, streamCounts } from './host-judged-reads.mjs'
import { writeClusterLogs } from '../../tests/helpers/replica-cluster-reads.ts'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** How long a leader gets to link a channel it would link (the old-host scenario waits as long). */
const SETTLE_MS = 35_000

/** The stored false of a variant in the Mac's config.yaml: true, false, or null when the key is gone. */
function storedOff(d, variant) {
  const c = yaml.load(fs.readFileSync(path.join(d.macData, 'config.yaml'), 'utf8')) ?? {}
  const v = variant === 'experiment' ? c.experimental?.host_runs_sessions : c.hosts?.[HOST_KEY]?.runs_sessions
  return typeof v === 'boolean' ? v : null
}

/** A start on the host and its answer; `probe`: this tree's leader, whose probe names the judge. */
async function legacyStart(h, L, title, words, probe) {
  const { sid } = await startOn(h, title, words)
  const answered = await waitFor(() => streamCounts(h, sid, [`echo: ${words}`])[`echo: ${words}`] > 0, 120_000, 'the answer').then(() => true, () => false)
  await sleep(3_000)
  return { sid, answered, judge: probe ? (await h.mac(`/judge?sid=${sid}`)).judge ?? null : null, history: await L.answers(sid, `echo: ${words}`) }
}

async function rehearseVariant({ older, out, variant }) {
  const r = { scenario: `explicit-off-${variant}`, older: older.version, checks: {}, problems: [] }
  const fail = (why) => { r.problems.push(why); process.stdout.write(`  ✗ ${r.scenario}: ${why}\n`) }
  let h = null
  let old = null
  let again = null
  try {
    h = await startHostJudgeCluster({
      macSwitch: variant === 'experiment' ? false : 'unset',
      macHostExtra: [...NET_HOST_LINES, ...(variant === 'host' ? ['    runs_sessions: false'] : [])],
      hostEnv: { WALNUT_HOST_RUNS_SESSIONS: '' },
    })
    const L = leaderReads(h)
    const d = clusterDirs(h)
    const port = h.c.macPort
    r.base = d.base
    // A round of this tree's leader: its own word on the host, then a start.
    const newRound = async (label) => {
      await waitFor(async () => (await h.mac(`/link?host=${HOST_KEY}`)).connected, 180_000, 'the Mac\'s link to the host')
      await sleep(SETTLE_MS)
      const side = await h.mac(`/side?host=${HOST_KEY}`)
      const start = await legacyStart(h, L, `Explicit off, ${label}`, `ROUND ${label}`, true)
      const c = { side, start, stored: storedOff(d, variant) }
      if (side.judges) fail(`${label}: the leader hands the host starts (${JSON.stringify(side)})`)
      if (!start.answered) fail(`${label}: the start was not answered`)
      if (start.judge !== 'legacy') fail(`${label}: the start is judged ${JSON.stringify(start.judge)}, not legacy`)
      if (c.stored !== false) fail(`${label}: config.yaml holds ${JSON.stringify(c.stored)} for the switch, not false`)
      return c
    }
    r.checks.before = await newRound('this tree')

    // The downgrade, with a Settings write of the older release on the stored config.
    r.checks.newLeaderStop = await stopClusterMac(h)
    old = await startOldLeader(h, older, { port, logFile: path.join(out, `${r.scenario}-old-leader.log`) })
    if (!old.health) throw new Error(`the ${older.version} leader did not answer (exit ${old.exit})`)
    const got = (await L.api('GET', '/api/config')).json ?? {}
    const cfg = got.config ?? got
    const writes = {
      experimental: await L.api('PUT', '/api/config', { experimental: { ...(cfg.experimental ?? {}), chat_reading_split: true } }),
      ...(variant === 'host' && cfg.hosts?.[HOST_KEY] ? { host: await L.api('PUT', '/api/config', { hosts: { [HOST_KEY]: cfg.hosts[HOST_KEY] } }) } : {}),
    }
    r.checks.oldLeader = {
      version: (await L.api('GET', '/api/v1/status')).json?.version ?? null,
      readsSwitch: variant === 'experiment' ? cfg.experimental?.host_runs_sessions ?? null : cfg.hosts?.[HOST_KEY]?.runs_sessions ?? null,
      writes: Object.fromEntries(Object.entries(writes).map(([k, w]) => [k, w.status])),
      stored: storedOff(d, variant),
      start: await legacyStart(h, L, 'Explicit off, the older release', 'ROUND older release', false),
    }
    for (const [k, s] of Object.entries(r.checks.oldLeader.writes)) if (s !== 200) fail(`the older release's ${k} write answered ${s}`)
    if (r.checks.oldLeader.stored !== false) fail(`after the older release's Settings write config.yaml holds ${JSON.stringify(r.checks.oldLeader.stored)}`)
    if (!r.checks.oldLeader.start.answered) fail('a start under the older release was not answered')
    await old.stop()

    // The upgrade back.
    again = await startNewLeaderAgain(h, { port, label: 'explicit-off' })
    r.checks.after = await newRound('this tree again')
  } catch (err) {
    fail(`run failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    const note = (what, err) => { (r.cleanup ??= []).push(`${what}: ${String(err?.message ?? err).slice(0, 300)}`) }
    for (const [what, fn] of [['old leader', () => old?.stop()], ['new leader again', () => again?.stop()], ['Mac daemon', () => h && stopMacDaemon(h)]]) {
      try { await fn() } catch (err) { note(what, err) }
    }
    if (h) {
      try { r.logs = writeClusterLogs(h.c, `host-judged-${r.scenario}`) } catch (err) { note('logs', err) }
      try { r.files = keepLogs(h.c.base, path.join(out, `${r.scenario}-files`)) } catch (err) { note('files', err) }
      const base = h.c.base
      try { await h.stop() } catch (err) { note('cluster stop', err) }
      try { const left = await stopLeftovers(base); if (left.length) r.leftovers = left } catch (err) { note('leftovers', err) }
    }
  }
  return r
}

export async function rehearseExplicitOff({ older, out }) {
  return [await rehearseVariant({ older, out, variant: 'experiment' }), await rehearseVariant({ older, out, variant: 'host' })]
}

/** The README's key numbers of one variant. */
export function explicitOffKey(c) {
  const round = (x) => x ? `judges ${x.side?.judges}, start ${x.start?.judge ?? 'unset'} answered ${x.start?.answered}, stored ${x.stored}` : '?'
  return `this tree: ${round(c.before)}; older ${c.oldLeader?.version ?? '?'}: reads ${c.oldLeader?.readsSwitch}, writes ${JSON.stringify(c.oldLeader?.writes ?? {})}, stored ${c.oldLeader?.stored}, start answered ${c.oldLeader?.start?.answered}; this tree again: ${round(c.after)}`
}
