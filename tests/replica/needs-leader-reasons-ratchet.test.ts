/**
 * Every `why` a host replica (or the daemon behind it) answers `needs_leader`
 * with has plain words in the console (web/src/api/leader-presence.ts
 * NEEDS_LEADER_REASONS), so a refused write never reads as the generic "Your Mac
 * is not answering right now" when the server said exactly why.
 *
 * Reads src/ as text, the way the codes are written:
 *   - on a line that names needs_leader / needs-leader: every `why: '<code>'`
 *     and `why ?? '<code>'` (route-table.ts and ws-rpc-table.ts rows, the
 *     replica's error bodies, the daemon's `fail('needs_leader', ..., {detail:{why}})`)
 *   - the last argument of every `needsLeader(...)` call: a literal, or a
 *     `const NAME = '<code>'` it names (away-session-reads.ts)
 *   - the first argument of every `new NeedsLeaderError(...)` (a host replica's
 *     own refusals of a copied store, core/replication/needs-leader.ts, answered
 *     503 needs_leader by the error handler), the same two ways
 *   - the literals `answerAway(...)` passes on as the why (dispatch.ts: a row
 *     with no why of its own answers with the route's), and the whys of every
 *     `kind: 'alone'` route (presence.ts), comparisons left out
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { NEEDS_LEADER_REASONS } from '../../web/src/api/leader-presence'

const ROOT = path.resolve(import.meta.dirname, '../..')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p)
  }
  return out
}

/** The argument list of each `name(` call in `text`, split at its own top-level commas. */
function callArgs(text: string, name: string): string[][] {
  const calls: string[][] = []
  const re = new RegExp(`\\b${name}\\(`, 'g')
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 1
    let i = m.index + m[0].length
    let start = i
    let quote: string | null = null
    const args: string[] = []
    for (; i < text.length && depth > 0; i++) {
      const c = text[i]!
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue }
      if (c === '\'' || c === '"' || c === '`') quote = c
      else if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        depth--
        if (depth === 0) args.push(text.slice(start, i))
      } else if (c === ',' && depth === 1) { args.push(text.slice(start, i)); start = i + 1 }
    }
    calls.push(args.map((a) => a.trim()).filter(Boolean))
  }
  return calls
}

/** Quoted codes in an expression, minus the right side of a comparison (`x === 'alone' ? ...`). */
function codesIn(expr: string): string[] {
  const bare = expr.replace(/[!=]==?\s*['"][\w-]+['"]/g, '')
  return [...bare.matchAll(/['"]([\w-]+)['"]/g)].map((m) => m[1]!)
}

function collect(): Map<string, string[]> {
  const files = sourceFiles(path.join(ROOT, 'src'))
  const texts = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))
  const consts = new Map<string, string>()
  for (const text of texts.values()) {
    for (const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*['"]([\w-]+)['"]/g)) consts.set(m[1]!, m[2]!)
  }
  const found = new Map<string, string[]>()
  const add = (code: string, where: string) => { found.set(code, [...(found.get(code) ?? []), where]) }
  for (const [file, text] of texts) {
    const rel = path.relative(ROOT, file)
    text.split('\n').forEach((line, i) => {
      if (!/needs_leader|needs-leader/.test(line)) return
      for (const m of line.matchAll(/\bwhy\s*:\s*['"]([\w-]+)['"]/g)) add(m[1]!, `${rel}:${i + 1}`)
      for (const m of line.matchAll(/\bwhy\s*\?\?\s*['"]([\w-]+)['"]/g)) add(m[1]!, `${rel}:${i + 1}`)
    })
    const addArg = (arg: string, call: string) => {
      const literal = /^['"]([\w-]+)['"]$/.exec(arg)
      if (literal) add(literal[1]!, `${rel} ${call}()`)
      else if (/^[A-Z][A-Z0-9_]*$/.test(arg)) {
        const code = consts.get(arg)
        // A constant the scan cannot resolve is a code with no words: fail on it by name.
        add(code ?? `<unresolved ${arg}>`, `${rel} ${call}(${arg})`)
      }
    }
    for (const args of callArgs(text, 'needsLeader')) addArg(args[args.length - 1] ?? '', 'needsLeader')
    for (const args of callArgs(text, 'NeedsLeaderError')) addArg(args[0] ?? '', 'NeedsLeaderError')
    for (const args of callArgs(text, 'answerAway')) {
      for (const code of codesIn(args[args.length - 1] ?? '')) add(code, `${rel} answerAway()`)
    }
    for (const m of text.matchAll(/kind:\s*'alone',\s*why:\s*([^}\n]*)/g)) {
      for (const code of codesIn(m[1]!)) add(code, `${rel} alone route`)
    }
  }
  return found
}

describe('needs_leader reasons ratchet', () => {
  const found = collect()

  it('the scan finds the codes it is known to (a scan that went blind would pass anything)', () => {
    for (const code of ['task_writes_need_mac', 'session_writes_need_mac', 'files_need_mac', 'terminal_needs_mac', 'needs_mac',
      'session_on_mac', 'session_files_need_mac', 'history_pages_need_mac', 'daemon_unreachable', 'daemon_needs_upgrade',
      'not_queueable', 'mac_too_old', 'board_not_here', 'copy_unreadable', 'kind_not_copied', 'unreachable', 'mac-away',
      'nobody-answers', 'no-daemon', 'draining',
      // WP5: a host replica's own refusals of its copies (NeedsLeaderError) and the conversation bodies' rows.
      'config_writes_need_mac', 'routine_writes_need_mac', 'prefs_writes_need_mac', 'conversation_writes_need_mac',
      'other_hosts_need_mac', 'conversation_bodies_need_mac']) {
      expect(found.has(code), `${code} not found by the scan`).toBe(true)
    }
    expect(found.size).toBeGreaterThanOrEqual(20)
  })

  it('every code has its words in NEEDS_LEADER_REASONS', () => {
    const missing = [...found].filter(([code]) => !Object.prototype.hasOwnProperty.call(NEEDS_LEADER_REASONS, code))
      .map(([code, where]) => `${code} (${where.slice(0, 3).join(', ')})`)
    expect(missing, `add these to NEEDS_LEADER_REASONS in web/src/api/leader-presence.ts:\n${missing.join('\n')}`).toEqual([])
  })

  it('every reason is a plain sentence (no dashes, ends with a period)', () => {
    for (const [why, words] of Object.entries(NEEDS_LEADER_REASONS)) {
      expect(words, why).toMatch(/^[A-Z].*\.$/)
      expect(words, why).not.toMatch(/[\u2013\u2014]/)
    }
  })
})
