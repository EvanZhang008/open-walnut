/**
 * Ratchet: a feature that refuses or degrades without a daemon capability asks for it through
 * needCapability (src/providers/daemon-capability-need.ts), so a daemon that lacks it is updated
 * past the 2 h update gap (daemon-update-gap.ts) instead of leaving the feature cut off. A plain
 * `hasCapability` stays a read: an optional probe whose fallback works.
 *
 * The class is found in the source two ways (review r1 medium 3, r2 medium A, 2026-11-25):
 *   - by code shape: a negated capability check (`!x.hasCapability(`, `!hasCap…(`) whose statement
 *     (its line and the two after it) throws, rejects, or returns an error, a reason or an answer
 *     of 4xx/5xx, or says it through linkDaemonNeedsUpdate;
 *   - by wording: a refusal that says the daemon needs an update (DaemonNeedsUpgradeError, the
 *     daemon_needs_upgrade / daemon_upgrade / daemon-upgrade / daemon_too_old answers, the PTY's
 *     sentence, "older than this Walnut", "too old for/to", "needs an update before"), whose
 *     capability check sits on its line or in the three above.
 * A site of either kind uses needCapability, or is listed in NOT_A_NEED with why an update from
 * here is not what it needs. A listed one that is gone fails too.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')
const REFUSAL_WORDS = /new DaemonNeedsUpgradeError\(|'daemon_needs_upgrade'|'daemon[-_]upgrade'|'daemon_too_old'|ptyStreamMissingSentence\(|older than this Walnut|too old (for|to)\b|needs an update before/
const NEGATED_CHECK = /!\s*\(?\s*[\w.?()[\]'"]*?\.hasCapability\??\.?\(|!\s*hasCap\w*\(/
const REFUSES = /\bthrow\b|reject\(|return\s+(new\s+\w*Error|\{\s*(ok:\s*false|error)|[\w.]*Error\(|fail\(|needsLeader|unavailable\(|['`"])|res\.status\(\s*[45]\d\d|status:\s*[45]\d\d|linkDaemonNeedsUpdate\(/
/** The daemon's own twins: they answer their own capabilities, never a server's check. */
const HOST_SIDE = new Set(['src/providers/daemon-standalone.ts', 'src/providers/acp-daemon.ts'])

/** Sites that are no need for a newer daemon from here, each with why (file, text on the line). */
const NOT_A_NEED: Array<{ file: string; near: string; why: string }> = [
  { file: 'src/providers/service-set-move-checks.ts', near: '!link.hasCapability(WALNUT_SCOPE_CAPABILITY)) return', why: 'a shared daemon another Walnut uses: this Walnut keeps it as it is (daemon-shared.ts), so the move is blocked, never the other Walnut\'s daemon replaced' },
  { file: 'src/providers/service-set-move-checks.ts', near: '!link.hasCapability(SNAPSHOT_CAPABILITY)) return', why: 'the same shared daemon: the move is blocked, the daemon kept' },
  { file: 'src/providers/service-set-move-checks.ts', near: '!link.hasCapability(WALNUT_SCOPE_CAPABILITY)) throw', why: 'the same shared daemon, checked again right before the drop (moveBlocker passed first)' },
  { file: 'src/providers/service-set-move-checks.ts', near: '!link.hasCapability(SEED_CAPABILITY)) throw', why: 'the set\'s own daemon, which the move installs from this build: one without it is an older Walnut\'s set, refused for good by design' },
  { file: 'src/web/routes/devices.ts', near: "!hasCapability('bridge-door')))", why: 'this server\'s own capability (core/capabilities.ts), not a daemon\'s' },
  { file: 'src/web/routes/devices.ts', near: "if (!hasCapability('bridge-door'))", why: 'this server\'s own capability (core/capabilities.ts), not a daemon\'s' },
  { file: 'src/web/routes/hosts.ts', near: "if (!hasCapability('bridge-door'))", why: 'this server\'s own capability (core/capabilities.ts), not a daemon\'s' },
  { file: 'src/core/sessions/auto-recover-env.ts', near: "!conn.hasCapability('cron-supervision-v1')) return 'server'", why: 'a fallback that works: the server supervises the session itself; cron-supervision-v1 is said by how the daemon starts, not by its build' },
  { file: 'src/core/sessions/session-supervision.ts', near: "!conn.hasCapability('cron-supervision-v1'))", why: 'cron-supervision-v1 is said by how the daemon starts (a managed service), never by its build (daemon-shared.ts HOST_DEPENDENT_CAPABILITIES)' },
  { file: 'src/core/diagnostics/host-probes.ts', near: "!conn?.hasCapability('preflight-v1')) return null", why: 'an optional probe: the caller runs the same preflight in-process (local-probes.ts)' },
  { file: 'src/core/hosts/host-script.ts', near: '!conn.hasCapability(HOST_SCRIPT_DETACH_CAPABILITY)', why: 'a rollback on the host: the build that brings it just failed there, and asking for it again would fight the rollback' },
  { file: 'src/replica/away-triggers.ts', near: 'if (!hasCap()) return', why: 'a host replica asking its own local daemon, which its leader updates; no DaemonConnection of this server' },
]

const isComment = (line: string) => /^\s*(\*|\/\/|\/\*)/.test(line)

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? sourceFiles(p) : e.name.endsWith('.ts') ? [p] : []
  })
}

/** Every site of the class that does not ask through needCapability, as `file:line` with its text. */
function bareSites(): Array<{ file: string; line: number; text: string }> {
  const out: Array<{ file: string; line: number; text: string }> = []
  for (const abs of sourceFiles(path.join(ROOT, 'src'))) {
    const file = path.relative(ROOT, abs)
    if (HOST_SIDE.has(file)) continue
    const lines = fs.readFileSync(abs, 'utf8').split('\n')
    const add = (i: number) => { if (!out.some((s) => s.file === file && s.line === i + 1)) out.push({ file, line: i + 1, text: lines[i]!.trim() }) }
    lines.forEach((line, i) => {
      if (isComment(line)) return
      // By shape: a negated check whose statement refuses.
      if (NEGATED_CHECK.test(line) && REFUSES.test(lines.slice(i, i + 3).join('\n'))) add(i)
      // By wording: the check above a "needs an update" refusal.
      if (REFUSAL_WORDS.test(line)) {
        for (let j = Math.max(0, i - 3); j <= i; j++) {
          if (!isComment(lines[j]!) && /\.hasCapability\??\.?\(/.test(lines[j]!) && !/\bneedCapability\(/.test(lines[j]!)) add(j)
        }
      }
    })
  }
  return out
}

describe('a refusal for a missing daemon capability asks for it through needCapability', () => {
  it('every site found by its shape or its words uses needCapability, or says why it is no need', () => {
    const sites = bareSites()
    const unlisted = sites.filter((s) => !NOT_A_NEED.some((n) => n.file === s.file && s.text.includes(n.near)))
    expect(unlisted.map((s) => `${s.file}:${s.line}: ${s.text.slice(0, 140)}`),
      'a refusal whose capability check is a bare hasCapability: use needCapability(conn, cap), or list it in NOT_A_NEED with why').toEqual([])
    const stale = NOT_A_NEED.filter((n) => !sites.some((s) => s.file === n.file && s.text.includes(n.near)))
    expect(stale.map((n) => `${n.file}: ${n.near}`), 'a NOT_A_NEED entry matches nothing any more: drop or reword it').toEqual([])
    for (const n of NOT_A_NEED) expect(n.why.length, n.near).toBeGreaterThan(30)
  })

  it('the class is not empty: the sites it was written for ask through needCapability', () => {
    const asks = sourceFiles(path.join(ROOT, 'src')).reduce((n, f) => n + (fs.readFileSync(f, 'utf8').match(/\bneedCapability\(/g)?.length ?? 0), 0)
    expect(asks).toBeGreaterThan(40)
    for (const [file, text] of [
      ['src/providers/daemon-connection.ts', "if (!needCapability(this, 'host-exec-v1')) return Promise.reject(new Error(this.linkDaemonNeedsUpdate('Running a script')))"],
      ['src/core/usage/session-budget.ts', "if (!needCapability(conn, 'budget-v2')) throw fail('budget_needs_upgrade'"],
      ['src/core/sessions/cancel-pending-start.ts', 'if (!needCapability(conn, CANCEL_PENDING_START_CAPABILITY)) throw'],
    ] as const) expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), file).toContain(text)
  })

  it('hasCapability stays a read, and the PTY refusal asks', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-connection.ts'), 'utf8')
    expect(src).toMatch(/hasCapability\(cap: string\): boolean \{ return this\._capabilities\?\.includes\(cap\) \?\? false \}/)
    expect(src).toMatch(/if \(!needCapability\(this, PTY_STREAM_CAPABILITY\)\) return Promise\.reject\(/)
  })
})
