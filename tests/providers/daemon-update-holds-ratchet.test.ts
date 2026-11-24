/**
 * Every hold on a daemon update has an upper bound (src/providers/daemon-update-behind.ts).
 * 2026-11-05: clouddev's daemon stayed on an old build for about 17.6 hours: host_exec runs, the
 * server's own writes in flight, a connect in progress and the daemon's own busy refusal took
 * turns, each with its own clock or none, so no clock ever ran out. This ratchet:
 *  - finds every place an update is put off (daemon-connection.ts `postponeUpgrade(`, local-daemon.ts
 *    `scheduleUpgradeRecheck(`, daemon-net-update.ts `this.postpone(`) and fails on one that
 *    DAEMON_UPDATE_HOLDS does not list, and on a listed one that is gone;
 *  - fails on a `hold` whose method never reads the overdue verdict (it would hold for good) or that
 *    names no behaviour test (`proof`) showing it give way, and on a `bounded` one whose limit is not
 *    defined where it says;
 *  - fails when the daemon refuses an update as busy without a way past it (`force`), or the
 *    command drain refuses a forced pause.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DAEMON_UPDATE_HOLDS, DAEMON_UPDATE_BEHIND_MAX_MS, DAEMON_UPDATE_STOPS } from '../../src/providers/daemon-update-behind.js'
import { LIFECYCLE_WAITS } from '../../src/core/sessions/lifecycle-waits.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')

/** The calls that put an update off, per file (the definition itself excluded). */
const SITES: Record<string, RegExp> = {
  'src/providers/daemon-connection.ts': /this\.postponeUpgrade\(/,
  'src/providers/local-daemon.ts': /this\.scheduleUpgradeRecheck\(/,
  'src/providers/daemon-net-update.ts': /this\.postpone\(/,
}

/** Code only: an overdue check written in a comment bounds nothing. */
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const METHOD = /^ {2}(?:(?:private|public|protected|static|async|override)\s+)*(\w+)\s*(?:<[^>]*>)?\(/

interface Site { file: string; line: number; method: string; own: string; window: string; above: string }

function methodsOf(lines: string[]): Array<{ name: string; start: number; end: number }> {
  const starts: Array<{ name: string; start: number }> = []
  lines.forEach((l, i) => {
    const m = METHOD.exec(l)
    if (m && !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(m[1])) starts.push({ name: m[1], start: i })
  })
  return starts.map((s, i) => ({ ...s, end: i + 1 < starts.length ? starts[i + 1].start : lines.length }))
}

function sites(): Site[] {
  const out: Site[] = []
  for (const [file, re] of Object.entries(SITES)) {
    const lines = read(file).split('\n')
    const methods = methodsOf(lines)
    lines.forEach((l, i) => {
      if (!re.test(l)) return
      const method = methods.find((m) => m.start <= i && i < m.end)?.name ?? '(none)'
      const start = methods.find((m) => m.start <= i && i < m.end)?.start ?? 0
      out.push({
        file, line: i + 1, method,
        // The call itself (its statement may run over three lines), then the lines leading to it.
        own: lines.slice(i, i + 3).join('\n'),
        window: lines.slice(Math.max(0, i - 14), i + 3).join('\n'),
        // The method's own lines above the call (at most 25) and the call: where a hold's overdue check must sit.
        above: lines.slice(Math.max(start, i - 25), i + 3).join('\n'),
      })
    })
  }
  return out
}

describe('daemon update holds', () => {
  const found = sites()

  it('finds the calls it looks for', () => {
    for (const file of Object.keys(SITES)) expect(found.some((s) => s.file === file), `no update deferral found in ${file}`).toBe(true)
  })

  type Hold = (typeof DAEMON_UPDATE_HOLDS)[number]
  // An entry names its call by words in the call itself; only a call none names that way is
  // matched by words in the lines leading to it (two calls a few lines apart stay apart).
  const named = (s: Site): Hold[] => {
    const mine = DAEMON_UPDATE_HOLDS.filter((h) => h.file === s.file && h.method === s.method)
    const own = mine.filter((h) => s.own.includes(h.near))
    return own.length ? own : mine.filter((h) => s.window.includes(h.near))
  }
  const matches = (h: Hold, s: Site) => named(s).includes(h)

  it('every place an update is put off is listed once, and every listed one is exactly one call', () => {
    for (const s of found) {
      const hits = DAEMON_UPDATE_HOLDS.filter((h) => matches(h, s))
      expect(hits.length, `${s.file}:${s.line} (${s.method}) puts a daemon update off but DAEMON_UPDATE_HOLDS does not list it (or lists it twice): say what bounds it`).toBe(1)
    }
    for (const h of DAEMON_UPDATE_HOLDS) {
      expect(found.filter((s) => matches(h, s)).length, `listed hold ${h.file} ${h.method} "${h.near}" must match exactly one call`).toBe(1)
    }
  })

  it('a hold reads the overdue verdict right above its call, so it gives way once the update is overdue', () => {
    for (const h of DAEMON_UPDATE_HOLDS.filter((x) => x.kind === 'hold')) {
      const site = found.find((s) => matches(h, s))!
      expect(/_overdueMs|forceable\(\)|_forceable|behind\.overdue|goesOver/.test(stripComments(site.above)), `${h.file}:${site.line} ${h.method} holds a daemon update ("${h.near}") with no upper bound: read the overdue verdict (daemon-update-behind.ts) where it decides to wait`).toBe(true)
    }
  })

  it('each hold names a behaviour test showing it give way once the update is overdue, and that test is there', () => {
    for (const h of DAEMON_UPDATE_HOLDS.filter((x) => x.kind === 'hold')) {
      expect(h.proof, `${h.file} ${h.method} "${h.near}" holds a daemon update and names no test showing it give way when overdue`).toBeTruthy()
      const text = read(h.proof!.test)
      expect(new RegExp(`\\bit(?:\\.each\\([^\\n]*\\))?\\(\\s*['"\`]${h.proof!.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text), `${h.proof!.test} has no test named "${h.proof!.name}"`).toBe(true)
    }
  })

  // An update not done can also be a plain `return false` with a log line and no clock (2026-11-06
  // round 3 review: the cooldown and the "refusing to loop" exits). Every log of an update deferred,
  // refused or held must sit next to a listed hold, or be a listed stop that says why no clock is needed.
  const STOP_WORDS = /\b(deferred|DEFERRED|refusing|not updated|not available)\b|\bheld by\b/
  const logsOfUpdatesNotDone = () => {
    const out: Array<{ file: string; line: number; text: string; nearHold: boolean }> = []
    for (const [file, re] of Object.entries(SITES)) {
      const lines = read(file).split('\n')
      lines.forEach((l, i) => {
        if (!/log\.session\.(warn|error|info)\(|\bholdLog\(/.test(l)) return
        const text = /\(\s*$/.test(l) ? `${l} ${lines[i + 1] ?? ''}` : l
        if (!STOP_WORDS.test(text) || !/update|upgrade/i.test(text)) return
        const nearHold = lines.slice(Math.max(0, i - 12), i + 13).some((x) => re.test(x))
        out.push({ file, line: i + 1, text, nearHold })
      })
    }
    return out
  }

  it('an update not done with no clock to ask again is a listed stop, and every listed stop is one log line', () => {
    const found = logsOfUpdatesNotDone()
    expect(found.length).toBeGreaterThan(0)
    for (const f of found.filter((x) => !x.nearHold)) {
      const hits = DAEMON_UPDATE_STOPS.filter((st) => st.file === f.file && f.text.includes(st.near))
      expect(hits.length, `${f.file}:${f.line} logs a daemon update not done, with no listed hold next to it and no DAEMON_UPDATE_STOPS entry: ask again on a clock, or list it and say why none is needed`).toBe(1)
    }
    for (const st of DAEMON_UPDATE_STOPS) {
      expect(found.filter((f) => f.file === st.file && f.text.includes(st.near)).length, `listed stop ${st.file} "${st.near}" must be exactly one log line`).toBe(1)
      expect(st.why.length).toBeGreaterThan(10)
    }
  })

  it('an internal update deferral never becomes an error notification or advice to run a CLI command', () => {
    for (const f of logsOfUpdatesNotDone()) {
      // A refused replacement after a real failed attempt is a failure, not an internal wait.
      if (/refusing to loop/.test(f.text)) continue
      expect(f.text, `${f.file}:${f.line} turns an internal update deferral into an error notification`).not.toMatch(/log\.session\.error\(/)
      expect(f.text, `${f.file}:${f.line} asks the user to perform an internal update`).not.toMatch(/walnut daemon (?:install|update|restart)/)
    }
    for (const file of Object.keys(SITES)) {
      const text = read(file)
      const logs = text.split('\n').filter((line) => /log\.session\.(?:error|warn|info)\(/.test(line))
      for (const line of logs.filter((s) => /update|upgrade/i.test(s) && /postponed|skipped|deferred|held/i.test(s))) {
        expect(line, `${file} publishes an internal update wait as an error`).not.toMatch(/log\.session\.error\(/)
      }
    }
    const local = read('src/providers/local-daemon.ts')
    const instruction = local.slice(local.indexOf('export function serviceTakeoverInstruction()'), local.indexOf('export function serviceTakeoverEvidence('))
    expect(instruction).not.toMatch(/walnut daemon (?:install|update|restart)/)
    const remote = read('src/providers/daemon-connection.ts')
    const errorClass = remote.slice(remote.indexOf('export class DaemonServiceNotReadyError'), remote.indexOf('export class DaemonServiceProbeError'))
    expect(errorClass).not.toMatch(/Run on that host|serviceTakeoverInstruction/)
  })

  // A hold is asked again on its clock (every minute while work runs), and each ask logs why it
  // still waits. 2026-11-12 (a remote host) and 2026-11-15 (this Mac, 30 an hour while one long
  // host_exec ran): a warning on every ask raised the log-spike alarm for a wait that works as
  // designed. A hold's line goes through holdLog (daemon-hold-news.ts): warn once, then info.
  it('a hold asked again on its clock is said at warn only when it is news (holdLog)', () => {
    const HOLD_WORDS = /\b(deferred|DEFERRED|postponed|held by)\b|trying again later|checking again/
    const bare: string[] = []
    const viaHoldLog: string[] = []
    // Every warn in the files that put an update off, wherever it sits: a hold's line can be far
    // from its clock (startManagedUpdate answers 'busy' and its caller sets the recheck).
    for (const file of Object.keys(SITES)) {
      const lines = read(file).split('\n')
      lines.forEach((l, i) => {
        const call = /log\.session\.warn\(|\bholdLog\(/.exec(l)
        if (!call) return
        const text = lines.slice(i, i + 3).join(' ')
        if (!HOLD_WORDS.test(text) || !/update|upgrade/i.test(text) || /\bfailed\b/.test(text)) return
        if (call[0].startsWith('holdLog')) viaHoldLog.push(`${file}:${i + 1}`)
        else bare.push(`${file}:${i + 1} ${l.trim().slice(0, 160)}`)
      })
    }
    expect(bare, 'a daemon-update hold logged with a bare log.session.warn repeats on every recheck: log it with holdLog (src/providers/daemon-hold-news.ts)').toEqual([])
    // The scan still sees the holds it guards (it would pass on nothing if the pattern drifted):
    // the postpone hub, ACP turns and host_exec runs, probation, the managed update,
    // a host network machine held by its host setting.
    expect(viaHoldLog.length, viaHoldLog.join('\n')).toBeGreaterThanOrEqual(8)
  })

  it('a bounded wait names a limit defined where it says', () => {
    for (const h of DAEMON_UPDATE_HOLDS.filter((x) => x.kind === 'bounded')) {
      expect(h.bound && h.boundFile, `${h.method} "${h.near}" is bounded but names no limit`).toBeTruthy()
      expect(new RegExp(`\\b${h.bound}\\b\\s*[:=]`).test(read(h.boundFile!)), `${h.bound} is not defined in ${h.boundFile}`).toBe(true)
    }
  })

  it('each entry says why it waits', () => {
    for (const h of DAEMON_UPDATE_HOLDS) expect(h.why.length, `${h.method} "${h.near}"`).toBeGreaterThan(10)
  })

  it('the bound is a few hours and is a listed lifecycle wait', () => {
    expect(DAEMON_UPDATE_BEHIND_MAX_MS).toBeGreaterThanOrEqual(60 * 60_000)
    expect(DAEMON_UPDATE_BEHIND_MAX_MS).toBeLessThanOrEqual(6 * 60 * 60_000)
    expect(LIFECYCLE_WAITS.some((w) => w.file === 'src/providers/daemon-update-behind.ts')).toBe(true)
  })

  it('the daemon lets a forced update past every busy refusal', () => {
    const file = 'src/providers/daemon-standalone.ts'
    const text = read(file)
    const at = text.indexOf('function cmdServiceHandover(')
    expect(at, `${file}: cmdServiceHandover not found`).toBeGreaterThan(0)
    const body = text.slice(at, text.indexOf('\n}\n', at))
    expect(body).toMatch(/const force = updating && cmd\.force === true/)
    const refusals = body.split('\n').filter((l) => /must finish first/.test(l))
    expect(refusals.length, `${file}: no busy refusal found`).toBeGreaterThanOrEqual(2)
    // Each refusal is its own guarded line, or the line right after a guard that reads `!force`.
    const lines = body.split('\n')
    lines.forEach((l, i) => {
      if (!/must finish first/.test(l)) return
      const guard = /!force/.test(l) || /!force/.test(lines[i - 1] ?? '')
      expect(guard, `${file}: "${l.trim()}" refuses an update with no way past it`).toBe(true)
    })
    expect(body, `${file}: the command drain's pause must get the force`).toMatch(/daemonCommands\.pause\([^\n]*force/)
    const drain = read('src/providers/daemon-command-drain.ts')
    expect(drain).toMatch(/if \(!opts\.force && \[\.\.\.admitted\]/)
  })
})
