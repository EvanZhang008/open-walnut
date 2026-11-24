/**
 * Every ClaudeCodeSession member a leader-side caller uses on a session lookup's result exists on
 * RemoteJudgedSession, the proxy those lookups return for a session its host runs and judges
 * (host-judged-runner.ts wraps findByClaudeId, findSessionByClaudeId and getOrAttachLiveSession).
 *
 * The type says ClaudeCodeSession, so a member the proxy lacks type-checks and fails only at run
 * time, and only for a host-run session: 2026-11-24, the "/" palette of a session clouddev ran
 * answered 500 on every open ("live?.seedCliSlashCommands is not a function"). This test reads
 * the callers in src/ (a variable assigned from a lookup, within its function, and a member read
 * straight off a lookup call) and fails on any public ClaudeCodeSession member the proxy has not.
 * A new one: add it to RemoteJudgedSession (mirrored from `live`, forwarded to the host, or a
 * no-op where the host does it itself), never a cast at the caller.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { RemoteJudgedSession } from '../../src/providers/remote-judged-session.js'

const ROOT = path.resolve(__dirname, '../..')
const OWN = /(?:claude-code-session|remote-judged-session|host-judged-runner)\.ts$/
const LOOKUP = '(?:findByClaudeId|findSessionByClaudeId|getOrAttachLiveSession)'

/** Public members of ClaudeCodeSession, read from its class body (methods, getters, fields). */
function publicSessionMembers(): Set<string> {
  const src = fs.readFileSync(path.join(ROOT, 'src/providers/claude-code-session.ts'), 'utf8')
  const start = src.indexOf('\nexport class ClaudeCodeSession {')
  const end = src.indexOf('\nexport class SessionRunner')
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const names = new Set<string>()
  const member = /^ {2}(?!private |protected |static )(?:async |get |set |readonly |public |declare )*([A-Za-z]\w*)[?!]?\s*[(<:=]/gm
  for (const m of src.slice(start, end).matchAll(member)) names.add(m[1])
  names.delete('constructor')
  names.delete('if')
  return names
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** `<file>: <member>` for each public session member a caller reads on a lookup's result. */
function membersCallersUse(members: Set<string>): Set<string> {
  const assigned = new RegExp(`\\b(?:const|let)\\s+(\\w+)\\s*=\\s*(?:await\\s+)?[\\w.?]*\\b${LOOKUP}\\s*\\(`, 'g')
  const inline = new RegExp(`\\b${LOOKUP}\\s*\\([^()]*\\)\\)?\\??\\.(\\w+)`, 'g')
  const used = new Set<string>()
  for (const abs of walk(path.join(ROOT, 'src'))) {
    if (OWN.test(abs)) continue
    const text = fs.readFileSync(abs, 'utf8')
    const rel = path.relative(ROOT, abs).split(path.sep).join('/')
    for (const a of text.matchAll(assigned)) {
      // The variable's own function: up to the next top-level closing brace.
      const close = text.indexOf('\n}', a.index!)
      const scope = text.slice(a.index!, close < 0 ? undefined : close)
      for (const m of scope.matchAll(new RegExp(`\\b${a[1]}\\??\\.(\\w+)`, 'g'))) if (members.has(m[1])) used.add(`${rel}: ${m[1]}`)
    }
    for (const m of text.matchAll(inline)) if (members.has(m[1])) used.add(`${rel}: ${m[1]}`)
  }
  return used
}

describe('RemoteJudgedSession stands where a ClaudeCodeSession stands', () => {
  it('has every session member a leader-side caller uses on a lookup result', () => {
    const members = publicSessionMembers()
    expect(members.size).toBeGreaterThan(50) // the class body was read, not an empty slice
    const proxy = new RemoteJudgedSession('sid-surface', 'devbox', 'native') as unknown as Record<string, unknown>
    const used = membersCallersUse(members)
    expect(used.size).toBeGreaterThan(10) // the callers were found
    const missing = [...used].filter((u) => !(u.split(': ')[1] in proxy)).sort()
    expect(missing).toEqual([])
  })

  it('the palette backfill is a no-op on the proxy: the CLI list stays what its host reported', () => {
    const proxy = new RemoteJudgedSession('sid-palette', 'devbox', 'native')
    proxy.noteLive({ cliSlashCommands: { names: ['review'], at: 1 } } as never)
    expect(() => proxy.seedCliSlashCommands()).not.toThrow()
    expect(proxy.cliSlashCommands).toEqual({ names: ['review'], at: 1 })
  })
})
