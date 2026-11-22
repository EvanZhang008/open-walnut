/**
 * The plugin a mixed-version rehearsal installs (mixed-leader-host.mjs), and how its
 * results are judged. Pure: no process is started here.
 *
 * The plugin has one long-running job. Its run calls, through its daemon's
 * walnut.ops.call (the gateway relay to the leader, which a current daemon names with
 * the frame's `caller: {kind: 'plugin-job', ...}` and an older one does not):
 *   ready         task_list, until the leader answers (the run throws and is started again)
 *   plain-create  task_create record_only: answered by every leader
 *   bypass-create task_create in bypass with a message: a start in bypass
 *   bypass-start  task_start in bypass of the plain task
 * and writes each answer to one JSON line of its out file, then `done`. A run that
 * finds `done` there makes no call again (a restarted daemon starts the job again).
 *
 * Ratchet: tests/scripts/release-rehearsal-plugin-job.test.ts
 */
import fs from 'node:fs'
import path from 'node:path'

export const PROBE_PLUGIN = 'rehearsal-probe'
export const PROBE_JOB = 'probe'
export const PROBE_PROJECT = 'Rehearsal'
/** What every release since the start-mode ceiling answers a capped caller asking for bypass. */
export const BYPASS_REFUSAL = 'A default session cannot start a task in bypass mode'
export const STEPS = ['plain-create', 'bypass-create', 'bypass-start']

/** The job's server entry: `out` its results file, `cwd` the folder its tasks run in. */
export function probeServerSource({ out, cwd }) {
  return `import fs from 'node:fs'
const OUT = ${JSON.stringify(out)}
const CWD = ${JSON.stringify(cwd)}
const note = (o) => fs.appendFileSync(OUT, JSON.stringify({ at: Date.now(), ...o }) + '\\n')
async function call(walnut, name, args) {
  try { return { name, ok: true, result: await walnut.ops.call(name, args) } }
  catch (e) { return { name, ok: false, code: e && e.code ? String(e.code) : null, message: String(e && e.message ? e.message : e) } }
}
const idOf = (r) => { const m = /"id":"([^"]+)"/.exec(JSON.stringify(r ?? null)); return m ? m[1] : null }
const idle = (signal) => new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve) })
export function activate() {}
export const jobs = {
  async ${PROBE_JOB}(walnut, signal) {
    if (fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8').includes('"step":"done"')) return idle(signal)
    const ready = await call(walnut, 'task_list', { limit: 1 })
    if (!ready.ok) { note({ step: 'not-ready', code: ready.code, message: ready.message }); throw new Error('the leader does not answer yet: ' + ready.message) }
    const plain = await call(walnut, 'task_create', { title: 'Rehearsal plain task', project: ${JSON.stringify(PROBE_PROJECT)}, record_only: true })
    note({ step: 'plain-create', ...plain })
    const created = await call(walnut, 'task_create', { title: 'Rehearsal bypass create', project: ${JSON.stringify(PROBE_PROJECT)}, mode: 'bypass', cwd: CWD, message: 'snapshot-clean-turn:answered bypass create' })
    note({ step: 'bypass-create', ...created, taskId: idOf(created.ok ? created.result : created.message) })
    const id = idOf(plain.result)
    const started = id
      ? await call(walnut, 'task_start', { id, mode: 'bypass', cwd: CWD, message: 'snapshot-clean-turn:answered bypass start' })
      : { name: 'task_start', ok: false, code: null, message: 'the plain create named no task id' }
    note({ step: 'bypass-start', ...started, taskId: id })
    note({ step: 'done', plugin: walnut.plugin, job: walnut.job, host: walnut.host })
    await idle(signal)
  },
}
`
}

/** Install the probe plugin into a Walnut data home. */
export function installProbePlugin(walnutHome, { out, cwd }) {
  const dir = path.join(walnutHome, 'plugins', PROBE_PLUGIN)
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: PROBE_PLUGIN, name: 'Rehearsal probe', version: '1.0.0', apiVersion: 1, engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs', jobs: { [PROBE_JOB]: { kind: 'long-running' } },
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'dist', 'server.mjs'), probeServerSource({ out, cwd }))
  return dir
}

/** The job's out file as records (bad lines skipped). */
export function readProbeOut(text) {
  return String(text ?? '').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
}

/** Ids, hex runs, times and numbers out of a message, so two runs' answers compare. */
export function normalizeText(s) {
  return String(s ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<time>')
    .replace(/\d+(\.\d+)?/g, '<n>')
    .trim()
}

/** step -> { ok, code, message } of each call (the message only for a refusal: a success's result holds ids). */
export function outcomesOf(records) {
  const out = {}
  for (const r of records) {
    if (!STEPS.includes(r.step)) continue
    out[r.step] = { ok: r.ok === true, code: r.ok ? null : (r.code ?? null), message: r.ok ? null : normalizeText(r.message) }
  }
  return out
}

/** Every step whose outcome differs between `a` and `b`, as `step: a -> b`. */
export function outcomeDiffs(a, b) {
  const diffs = []
  for (const step of STEPS) {
    const x = JSON.stringify(a[step] ?? null)
    const y = JSON.stringify(b[step] ?? null)
    if (x !== y) diffs.push(`${step}: ${x} -> ${y}`)
  }
  return diffs
}

/**
 * The error lines of a server's console log (`HH:MM:SS ERR [sub] message {data}`, FTL too, and an
 * uncaught exception's own line), each cut to its level, subsystem and normalized message, once.
 */
export function errorHeads(logText) {
  const heads = new Set()
  for (const line of String(logText ?? '').split('\n')) {
    const m = /^\d\d:\d\d:\d\d (ERR|FTL) (\[[^\]]+\]) ([^{]*)/.exec(line)
    if (m) { heads.add(`${m[1]} ${m[2]} ${normalizeText(m[3])}`); continue }
    if (/^(Uncaught|Unhandled|\w*Error: |panic:|Segmentation fault)/.test(line.trim())) heads.add(`RAW ${normalizeText(line.trim().slice(0, 200))}`)
  }
  return [...heads].sort()
}

/** A daemon's JSON log lines of `levels`, each cut to its level and normalized message, once. */
export function daemonHeads(logText, levels = ['error', 'fatal']) {
  const heads = new Set()
  for (const line of String(logText ?? '').split('\n')) {
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o && levels.includes(o.level)) heads.add(`${o.level} ${normalizeText(o.msg ?? o.message)}`)
  }
  return [...heads].sort()
}

/** The HTTP status of every task start route the leader answered, in order (its console's request lines). */
export function startStatuses(logText) {
  return [...String(logText ?? '').matchAll(/POST \/api\/v1\/tasks\/[^/\s]+\/start \u2192 (\d{3})/g)].map((m) => Number(m[1]))
}

/** Heads in `of` that `baseline` does not have. */
export function newHeads(of, baseline) {
  const seen = new Set(baseline)
  return of.filter((h) => !seen.has(h))
}

/** Common checks of one pairing's run: the job finished, the leader still serves. Returns problems. */
export function basicProblems(run) {
  const problems = []
  if (!run.done) problems.push(`the job never finished its calls (last record: ${JSON.stringify(run.records.at(-1) ?? null)})`)
  if (!run.leaderAlive) problems.push('the leader process exited')
  if (run.healthAfter !== 200) problems.push(`the leader's health answered ${run.healthAfter} after the calls`)
  const plain = run.outcomes['plain-create']
  if (!plain?.ok) problems.push(`the plain task_create failed: ${JSON.stringify(plain ?? null)}`)
  return problems
}

const refused = (o) => !!o && !o.ok && String(o.message ?? '').includes(normalizeText(BYPASS_REFUSAL))

/**
 * A (old leader, new host daemon): the old leader answers the job exactly as with its own daemon
 * (`baseline`), with no error line its baseline did not log.
 */
export function judgeOldLeader(run, baseline) {
  const problems = basicProblems(run)
  for (const d of outcomeDiffs(baseline.outcomes, run.outcomes)) problems.push(`answer differs from the old release with its own daemon: ${d}`)
  for (const h of newHeads(run.errorHeads, baseline.errorHeads)) problems.push(`error line the old release with its own daemon did not log: ${h}`)
  if (JSON.stringify(run.startStatuses) !== JSON.stringify(baseline.startStatuses)) problems.push(`task start routes answered ${JSON.stringify(run.startStatuses)}, the old release with its own daemon ${JSON.stringify(baseline.startStatuses)}`)
  return problems
}

/**
 * B (new leader, old host daemon): the job is answered as the anonymous outside caller, capped:
 * both bypass starts refused with the ceiling's sentence, as the old release refused them
 * (`oldBaseline`); no error line the new leader with a new daemon (`newBaseline`) did not log.
 */
export function judgeNewLeaderOldHost(run, { oldBaseline, newBaseline }) {
  const problems = basicProblems(run)
  for (const step of ['bypass-create', 'bypass-start']) {
    if (!refused(run.outcomes[step])) problems.push(`${step} was not refused by the ceiling: ${JSON.stringify(run.outcomes[step] ?? null)}`)
  }
  if (oldBaseline) for (const step of ['bypass-create', 'bypass-start']) {
    if (refused(oldBaseline.outcomes[step]) !== refused(run.outcomes[step])) problems.push(`${step} refused differently than the old release did`)
  }
  if (newBaseline) for (const h of newHeads(run.errorHeads, newBaseline.errorHeads)) problems.push(`error line the new leader with a new daemon did not log: ${h}`)
  if (!run.startStatuses?.length || run.startStatuses.some((s) => s !== 403)) problems.push(`task start routes answered ${JSON.stringify(run.startStatuses)}, not 403 each`)
  return problems
}

/** The contrast: a new leader and a new standalone daemon vouch for the job, so its bypass starts go through. */
export function judgeNewPair(run) {
  const problems = basicProblems(run)
  for (const step of ['bypass-create', 'bypass-start']) {
    if (!run.outcomes[step]?.ok) problems.push(`${step} did not go through for the vouched job: ${JSON.stringify(run.outcomes[step] ?? null)}`)
  }
  for (const step of ['bypass-create', 'bypass-start']) {
    const mode = run.modes?.[step]
    if (mode !== 'bypass') problems.push(`${step}'s session runs in ${mode ?? 'no session'}, not bypass`)
  }
  if (!run.startStatuses?.length || run.startStatuses.some((s) => s !== 202)) problems.push(`task start routes answered ${JSON.stringify(run.startStatuses)}, not 202 each`)
  return problems
}
