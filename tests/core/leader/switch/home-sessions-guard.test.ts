/**
 * The sessions in the data home across a leader switch are found by FOLDER at one place, so a new kind of session
 * that starts there (evidence home-cwd/sites.md lists 25 start sites today) is covered without being named:
 *   - the class reads only a row's host, judge and cwd, never its type, kind or engine (engine decides only whether
 *     it can move, not whether it is stopped);
 *   - every session start writes its row through createSessionRecord (org-own-folder-guard.test.ts pins that list),
 *     and every row is in the stop's list (stopHomeSessions reads the whole store);
 *   - the stop goes only through the owning runtime's `stop` with reason leader_switch, from one module;
 *   - a new leader places the records and a rolled-back one settles its sessions before its reconcile resumes any.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { homeSessionRows } from '../../../../src/core/leader/switch/home-sessions.js'
import type { SessionRecord } from '../../../../src/core/types.js'

const ROOT = path.resolve(import.meta.dirname, '../../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const code = (text: string) => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(p)
    else if (/\.(ts|tsx)$/.test(entry.name)) yield p
  }
}

function fnBody(text: string, name: string): string {
  const at = text.search(new RegExp(`export function ${name}\\b`))
  if (at < 0) throw new Error(`not found: ${name}`)
  const rest = text.slice(at)
  const end = rest.slice(1).search(/\n(?:export |function |const |\/\*\*)/)
  return end < 0 ? rest : rest.slice(0, end + 1)
}

describe('the sessions in the data home: found by folder at one place', () => {
  it('the class reads only host, judge and cwd', () => {
    const src = read('src/core/leader/switch/home-sessions.ts')
    for (const name of ['homeSessionRows', 'ownDaemonRow']) {
      const fields = [...code(fnBody(src, name)).matchAll(/\b(?:rec|r)\.([A-Za-z_]+)/g)].map((m) => m[1])
      expect(new Set(fields), name).toEqual(new Set(fields.filter((f) => ['host', 'judge', 'cwd'].includes(f))))
    }
  })

  it('every type and engine of session in the home is in the class', () => {
    const home = '/h/home'
    const kinds: Array<Partial<SessionRecord>> = [
      { type: 'interactive' }, { type: 'triage' as never }, { type: 'hook' as never }, { type: 'cron' as never }, { type: 'subagent' as never },
      { engine: 'codex' } as never, { engine: 'gemini' } as never, { provider: 'acp' } as never, { archived: true },
    ]
    const rows = kinds.map((k, i) => ({ claudeSessionId: `s${i}`, cwd: i % 2 ? home : `${home}/tasks/x`, ...k }) as SessionRecord)
    expect(homeSessionRows(rows, home)).toHaveLength(kinds.length)
  })

  it('the stop with reason leader_switch is sent from one module, through the owning runtime', () => {
    const senders: string[] = []
    for (const file of sourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file)
      if (rel.startsWith('src/providers/')) continue // the daemon side, which takes it
      if (/reason: 'leader_switch'/.test(code(fs.readFileSync(file, 'utf8')))) senders.push(rel)
    }
    expect(senders).toEqual(['src/core/leader/switch/home-session-runtime.ts'])
    // The server never signals a pid itself in that module.
    expect(code(read('src/core/leader/switch/home-session-runtime.ts'))).not.toMatch(/process\.kill|killProcessGroup/)
    expect(code(read('src/core/leader/switch/home-sessions.ts'))).not.toMatch(/process\.kill|killProcessGroup/)
  })

  it('the switch stop stops them first, before the stop takes the server down', () => {
    const route = code(read('src/web/routes/leader-switch.ts'))
    const at = route.indexOf("leaderSwitchRouter.post('/switch/final-stop'")
    const body = route.slice(at, route.indexOf('leaderSwitchRouter.', at + 10))
    expect(body.indexOf('stopSessionsInHome(')).toBeGreaterThan(0)
    expect(body.indexOf('stopSessionsInHome(')).toBeLessThan(body.indexOf('requestSwitchStop('))
    expect(body).toMatch(/carry: homeStop\.carry/)
  })

  it('a lead places the records and settles a rollback before its reconcile resumes any session', () => {
    const server = code(read('src/web/server.ts'))
    const settle = server.indexOf('settleHomeSessionsAtLead(WALNUT_HOME)')
    expect(settle).toBeGreaterThan(0)
    // Only where the permit is wired: with the experiment off nothing of the switch loads.
    expect(server.slice(Math.max(0, settle - 600), settle)).toMatch(/bootPolicy\('session-reconcile'\) && leaderPermitHandle\)/)
    expect(settle).toBeLessThan(server.indexOf('await reconcileSessions()'))
  })

  it('restart recovery and the message queue leave a session the switch holds', () => {
    expect(code(read('src/core/session-auto-recover.ts'))).toMatch(/heldBySwitch\(record\)\) return \{ ok: false, reason: 'leader-switch' \}/)
    expect(code(read('src/core/session-auto-recover.ts'))).toMatch(/rec\.archived \|\| heldBySwitch\(rec\)\) continue/)
    expect(code(read('src/core/session-message-queue.ts'))).toMatch(/heldBySwitch\(areaRecord\) \? MOVE_HELD_REASON/)
    // Every delivery of a session's rows (a send, the startup drain, a daemon that reconnects) goes through processNextNow.
    const runner = code(read('src/providers/claude-code-session.ts'))
    const at = runner.indexOf('private async processNextNow(')
    expect(at).toBeGreaterThan(0)
    expect(runner.slice(at, at + 2_500)).toMatch(/if \(heldBySwitch\(stopRecord\)\)/)
    // And from the marker on, before the stop marked the row (a cold start would meet the daemon's refusal).
    expect(runner.slice(at, at + 3_000)).toMatch(/if \(heldByHomeMarker\(stopRecord, WALNUT_HOME\)\)/)
  })
})
