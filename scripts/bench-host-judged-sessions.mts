#!/usr/bin/env bun
/**
 * What the leader pays for a host's busy sessions, with the host_runs_sessions experiment off
 * against on (docs/plan/one-service-every-host.md, phase 2): the cluster of
 * tests/helpers/host-judge-cluster.ts (a Mac server and a host under its one Walnut service, every
 * piece a real process on this machine, the scripted CLI of tests/helpers/replica-mock-cli.cjs),
 * started from a clean temp home for each run.
 *
 * Each run starts `--sessions` sessions on the host, each streaming a busy turn ("please stream":
 * text deltas, tool calls and results, a 16 KB result every tenth step) at `--rate` lines a second.
 * Once every session's output reaches the Mac it waits `--warmup` seconds, then measures for
 * `--seconds` on the Mac server's process: its event-loop delay (max and p99, a histogram in the
 * process: the Mac probe's /loop), its CPU (user + system from /proc) and RSS (sampled each second),
 * and the host service's CPU for reference. Then every turn ends, and it checks delivery: the
 * session events the Mac's bus got against what each CLI wrote (its result line names it), and the
 * Mac's per-line parse count (src/providers/line-parse-count.ts): about 1 per line off, 0 on. And
 * every JSON parse on the Mac in the window per CLI line written in it: daemon frames, session-channel
 * frames, and line bodies (off: a frame and a body per line; on: frames of merged batches).
 *
 *   walnut-dev run bun scripts/bench-host-judged-sessions.mts [--runs 2] [--modes off,on]
 *     [--sessions 10] [--rate 50] [--warmup 10] [--seconds 60] [--out <dir>] [--profile <dir>]
 *
 * Linux only (/proc). Runs alternate off, on, off, on ... Prints one JSON line of results and a
 * markdown table of the medians; with --out, writes each run's JSON and summary.json there.
 * --profile writes a CPU profile of the Mac server over each run's window there (run-<n>-<mode>.cpuprofile;
 * the profiler's own cost is in that run's numbers, so compare profiled runs only with each other).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { HOST_KEY, waitFor, sleep } from '../tests/helpers/replica-cluster.js'
import { startHostJudgeCluster, type HostJudgeCluster } from '../tests/helpers/host-judge-cluster.js'

type Mode = 'off' | 'on'

const args = process.argv.slice(2)
const opt = (name: string, def: string): string => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1]! : def }
const RUNS = Number(opt('runs', '2'))
const MODES = opt('modes', 'off,on').split(',') as Mode[]
const SESSIONS = Number(opt('sessions', '10'))
const RATE = Number(opt('rate', '50'))
const WARMUP_S = Number(opt('warmup', '10'))
const MEASURE_S = Number(opt('seconds', '60'))
const OUT = opt('out', '')
/** A CPU profile of the Mac server over each run's window (the Mac probe's /profile), written there. */
const PROFILE = opt('profile', '')
/** Each turn streams long enough to cover the starts, the warm-up and the window, with margin. */
const START_SLACK_S = 60
const LINES = RATE * (START_SLACK_S + WARMUP_S + MEASURE_S + 15)
const CLK_TCK = Number(execFileSync('getconf', ['CLK_TCK']).toString().trim()) || 100

/** user + system seconds of a process so far (/proc/<pid>/stat fields 14 and 15). */
function cpuSeconds(pid: number): number {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return (Number(f[11]) + Number(f[12])) / CLK_TCK
}
function rssMb(pid: number): number {
  const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))
  return m ? Math.round(Number(m[1]) / 102.4) / 10 : NaN
}
const loadavg = () => fs.readFileSync('/proc/loadavg', 'utf8').trim()

/** What a streaming turn's CLI wrote, from its result line in the host's stream file. */
function emitted(h: HostJudgeCluster, sid: string): Record<string, number> | null {
  let text = ''
  try { text = fs.readFileSync(path.join(h.c.base, 'hd', 'streams', `${sid}.jsonl`), 'utf8') } catch { return null }
  for (const line of text.split('\n').reverse()) {
    if (!line.includes('"type":"result"')) continue
    const m = /echo: streamed (\{[^}]*\})/.exec(JSON.parse(line).result ?? '')
    if (m) return JSON.parse(m[1]!)
  }
  return null
}

/** The lines of every Walnut log in the cluster that name the session channel or one of `sids`, by file. */
function channelLogLines(base: string, sids: string[]): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const f = path.join(dir, e.name)
      if (e.isDirectory()) walk(f)
      else if (/^open-walnut-.*\.log$/.test(e.name)) {
        const hits = fs.readFileSync(f, 'utf8').split('\n').filter((l) => /session channel|host channel|host start/.test(l) || sids.some((s) => l.includes(s)))
        out.push(`== ${path.relative(base, f)} (${hits.length} lines)`, ...hits.slice(0, 400))
      }
    }
  }
  walk(base)
  return out
}

/** The final answer's text of a streaming turn (replica-mock-cli.cjs streamLines' reply). */
const answerOf = (wrote: Record<string, number>): string => `echo: streamed ${JSON.stringify(wrote)}`

/** The Mac's session events of `sid` by name, whatever their source. */
async function eventCounts(h: HostJudgeCluster, sid: string): Promise<Record<string, number>> {
  const raw = (await h.mac(`/counts?sid=${sid}`)) as Record<string, number>
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw)) {
    const [name, part] = k.split('|') as [string, string]
    const key = part === 'chars' ? `${name}:chars` : name
    out[key] = (out[key] ?? 0) + v
  }
  return out
}

async function runOnce(mode: Mode, index: number) {
  const loadBefore = loadavg()
  process.stderr.write(`[bench] run ${index} ${mode}: load ${loadBefore}\n`)
  // Profiled: the Mac's own stall recorder samples each millisecond (its default, 20 ms, gives a few hundred samples a minute).
  const h = await startHostJudgeCluster({ macSwitch: mode === 'on', macRecord: 'count', ...(PROFILE ? { macEnv: { WALNUT_STALL_PROFILE_INTERVAL_US: '1000' } } : {}) })
  try {
    await waitFor(async () => (await h.mac(`/link?host=${HOST_KEY}`)).connected, 120_000, 'the Mac\'s link to the host')
    if (mode === 'on') await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 120_000, 'the Mac to hand starts to the host')
    const hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
    const hostPid = (await h.waitHostProbe()).pid
    const message = `please stream ${LINES} lines at ${RATE} per second`
    const sids: string[] = []
    for (let i = 0; i < SESSIONS; i++) {
      const t = await h.c.mac('POST', '/api/tasks', { title: `Busy build ${i + 1}`, project: 'Acme' })
      if (t.status !== 201) throw new Error(`task: ${t.status} ${JSON.stringify(t.json)}`)
      const st = await h.c.mac('POST', `/api/v1/tasks/${t.json.task.id}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message })
      if (st.status !== 202 || !st.json.sessionId) throw new Error(`start: ${st.status} ${JSON.stringify(st.json)}`)
      sids.push(st.json.sessionId as string)
    }
    // Every session's deltas reach the Mac before the warm-up starts.
    await waitFor(async () => {
      for (const sid of sids) if (!((await eventCounts(h, sid))['session:text-delta'] > 0)) return false
      return true
    }, START_SLACK_S * 1000, 'every session to stream to the Mac', 500)
    await sleep(WARMUP_S * 1000)

    const pid = h.c.macPid
    const link = (await h.mac(`/side?host=${HOST_KEY}`)).kind as string | null
    const parsesNow = async () => {
      const f = (await h.mac('/frames')) as { daemon: number; channel: number }
      let line = 0
      for (const sid of sids) line += (await h.mac(`/parses?sid=${sid}`)).parses as number
      return { ...f, line }
    }
    const parses0 = await parsesNow()
    if (PROFILE) await h.mac('/profile?start=1')
    await h.mac('/loop?reset=1')
    const cpu0 = cpuSeconds(pid)
    const hostCpu0 = cpuSeconds(hostPid)
    const t0 = performance.now()
    const windowFrom = Date.now()
    const rss: number[] = []
    while (performance.now() - t0 < MEASURE_S * 1000) { rss.push(rssMb(pid)); await sleep(1000) }
    const wallS = (performance.now() - t0) / 1000
    const windowTo = Date.now()
    const loop = await h.mac('/loop?reset=1')
    if (PROFILE) { fs.mkdirSync(PROFILE, { recursive: true }); await h.mac(`/profile?to=${encodeURIComponent(path.join(PROFILE, `run-${index}-${mode}.cpuprofile`))}`) }
    const cpu = cpuSeconds(pid) - cpu0
    const hostCpu = cpuSeconds(hostPid) - hostCpu0
    const parses1 = await parsesNow()
    // Every turn was still streaming at the window's end (else the window measured less output).
    const endedEarly: string[] = []
    for (const sid of sids) if ((await eventCounts(h, sid))['session:result']) endedEarly.push(sid)

    // Delivery: every turn ends, then the Mac's events against what each CLI wrote.
    await waitFor(async () => {
      for (const sid of sids) if (!(await eventCounts(h, sid))['session:result'] || !emitted(h, sid)) return false
      return true
    }, (START_SLACK_S + 60) * 1000, 'every streaming turn to end on the Mac', 1000)
    await sleep(2000)
    const sessions = []
    for (const sid of sids) {
      const wrote = emitted(h, sid)!
      const got = await eventCounts(h, sid)
      const parses = (await h.mac(`/parses?sid=${sid}`)).parses as number
      sessions.push({
        sid, wrote, parses,
        got: { deltas: got['session:text-delta'] ?? 0, deltaChars: got['session:text-delta:chars'] ?? 0, toolUses: got['session:tool-use'] ?? 0, toolResults: got['session:tool-result'] ?? 0, results: got['session:result'] ?? 0 },
      })
    }
    const sum = (f: (s: typeof sessions[number]) => number) => sessions.reduce((a, s) => a + f(s), 0)
    const lines = sum((s) => s.wrote.lines)
    const loss = {
      // Text, not events (a host merges deltas): every streamed piece, and the turn's final answer
      // (an assistant message the CLI did not stream: one delta more, its text the result's).
      deltaChars: sum((s) => s.wrote.deltaChars + answerOf(s.wrote).length) - sum((s) => s.got.deltaChars),
      toolUses: sum((s) => s.wrote.toolUses) - sum((s) => s.got.toolUses),
      toolResults: sum((s) => s.wrote.toolResults) - sum((s) => s.got.toolResults),
      results: SESSIONS - sum((s) => Math.min(1, s.got.results)),
    }
    const outputLinesInWindow = SESSIONS * RATE * wallS
    // Every JSON parse of the window on the Mac, per CLI line written in it: its daemon frames, the
    // session-channel frames, and the line bodies the per-line counter counts.
    const per = (n: number) => Math.round((n / outputLinesInWindow) * 1000) / 1000
    const window = { daemonFrames: parses1.daemon - parses0.daemon, channelFrames: parses1.channel - parses0.channel, lineBodies: parses1.line - parses0.line }
    const parses = { daemonFramesPerLine: per(window.daemonFrames), channelFramesPerLine: per(window.channelFrames), lineBodiesPerLine: per(window.lineBodies), allPerLine: per(window.daemonFrames + window.channelFrames + window.lineBodies), window }
    // A loss keeps what the cluster's logs say of the channel and of the sessions that lost events.
    const lossy = sessions.filter((s) => s.got.deltaChars !== s.wrote.deltaChars + answerOf(s.wrote).length || s.got.toolUses !== s.wrote.toolUses || s.got.toolResults !== s.wrote.toolResults || s.got.results < 1).map((s) => s.sid)
    if (lossy.length && OUT) fs.writeFileSync(path.join(OUT, `run-${index}-${mode}.loss.log`), channelLogLines(h.c.base, lossy).join('\n') + '\n')
    return {
      mode, run: index, loadBefore, loadAfter: loadavg(), sessions: SESSIONS, ratePerSession: RATE, windowS: Math.round(wallS * 10) / 10, windowFrom, windowTo, link,
      loopMaxMs: loop.maxMs, loopP99Ms: loop.p99Ms, loopP50Ms: loop.p50Ms, loopMeanMs: loop.meanMs, loopSamples: loop.samples,
      cpuSecPerMin: Math.round((cpu / wallS) * 60 * 100) / 100,
      cpuMsPer1kLines: Math.round((cpu * 1000 / outputLinesInWindow) * 1000 * 10) / 10,
      rssMaxMb: Math.max(...rss), rssEndMb: rss[rss.length - 1],
      hostCpuSecPerMin: Math.round((hostCpu / wallS) * 60 * 100) / 100,
      linesWritten: lines, parsesPerLine: Math.round((sum((s) => s.parses) / lines) * 1000) / 1000, parses,
      loss, endedEarly, perSession: sessions,
    }
  } catch (err) {
    process.stderr.write(`[bench] run ${index} ${mode} failed: ${String(err)}\n--- mac ---\n${h.c.logs().mac.slice(-4000)}\n--- replica ---\n${h.c.logs().replica.slice(-4000)}\n`)
    throw err
  } finally {
    await h.stop().catch((e) => process.stderr.write(`[bench] stop: ${String(e)}\n`))
  }
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return Math.round((s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) * 1000) / 1000 }
const COLUMNS = [
  ['loopMaxMs', 'loop delay max (ms)'], ['loopP99Ms', 'loop delay p99 (ms)'], ['cpuSecPerMin', 'CPU s per min'],
  ['cpuMsPer1kLines', 'CPU ms per 1k lines'], ['rssMaxMb', 'RSS max (MB)'], ['parsesPerLine', 'line-body parses per line'],
  ['hostCpuSecPerMin', 'host CPU s per min'], ['allParsesPerLine', 'JSON parses per line (all)'],
  ['daemonFramesPerLine', 'daemon frames per line'], ['channelFramesPerLine', 'channel frames per line'],
] as const

async function main() {
  if (process.platform !== 'linux') throw new Error('bench-host-judged-sessions reads /proc: Linux only')
  if (OUT) fs.mkdirSync(OUT, { recursive: true })
  const runs: any[] = []
  for (let r = 0; r < RUNS; r++) {
    for (const mode of MODES) {
      const res = await runOnce(mode, runs.length + 1)
      runs.push(res)
      const { perSession: _drop, ...brief } = res
      process.stderr.write(`[bench] ${JSON.stringify(brief)}\n`)
      if (OUT) fs.writeFileSync(path.join(OUT, `run-${res.run}-${mode}.json`), JSON.stringify(res, null, 2) + '\n')
    }
  }
  const medians: Record<string, Record<string, number>> = {}
  for (const mode of MODES) {
    const of = runs.filter((r) => r.mode === mode)
    const val = (r: any, k: string) => (k === 'allParsesPerLine' ? r.parses.allPerLine : k in r ? r[k] : r.parses[k])
    // A window whose delay histogram took no sample (seen once on bun: all zeros) says nothing of the loop.
    const loopOk = of.filter((r) => r.loopSamples > 0)
    medians[mode] = Object.fromEntries(COLUMNS.map(([k]) => [k, median((k.startsWith('loop') ? loopOk : of).map((r) => val(r, k)))]))
  }
  const summary = {
    at: new Date().toISOString(), host: os.hostname(), cpus: os.cpus().length, commit: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
    params: { runs: RUNS, sessions: SESSIONS, rate: RATE, warmupS: WARMUP_S, seconds: MEASURE_S, linesPerTurn: LINES },
    medians, runs: runs.map(({ perSession: _drop, ...r }) => r),
  }
  if (OUT) fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  process.stdout.write(JSON.stringify(summary) + '\n\n')
  process.stdout.write(`| metric (median of ${RUNS}) | ${MODES.join(' | ')} |\n|---|${MODES.map(() => '---').join('|')}|\n`)
  for (const [k, label] of COLUMNS) process.stdout.write(`| ${label} | ${MODES.map((m) => medians[m]![k]).join(' | ')} |\n`)
  const lost = runs.filter((r) => Object.values(r.loss).some((v) => v !== 0) || r.endedEarly.length)
  process.stdout.write(lost.length ? `\nloss or short window in runs: ${lost.map((r) => `${r.run}(${r.mode}) ${JSON.stringify(r.loss)} ended early ${r.endedEarly.length}`).join('; ')}\n` : '\nno loss: the text of every delta, every tool call, tool result and result reached the Mac in every run\n')
}

main().then(() => process.exit(0), (err) => { process.stderr.write(`${err?.stack ?? err}\n`); process.exit(1) })
