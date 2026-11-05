/**
 * Ratchet: an id reference is resolved through src/lib/id-ref.ts, never with a
 * bare prefix match.
 *
 * Ids vary in length (`muudy83e-d669`, a UUID), so one task's whole id can be
 * the start of another's. `tasks.filter((t) => t.id.startsWith(ref))` then
 * names two tasks for an id given in full and answers "Ambiguous ID prefix"
 * (a 500 in the API); `id.startsWith(t.parent_task_id)` counts a longer id as
 * the parent too. matchIdRef / refNamesId make the exact id win.
 *
 * This reads every source file of src/ and web/src/ and fails on a
 * `.startsWith(<expr>)` whose argument is an identifier (not a string literal
 * or a SCREAMING_CASE constant) and where either the receiver looks like an id
 * (ends in id / Id / _id / sid / ref / Ref: `t.id.startsWith(prefix)`) or the
 * argument does (the same, or an id prefix: `idPrefix`, `taskIdPrefix`). A bare
 * `prefix` argument on a non-id receiver (`name.startsWith(prefix)`: file
 * names, storage keys, paths) is not an id reference. A genuine non-id prefix
 * check that still matches goes in ALLOWED below with its reason.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const DIRS = ['src', 'web/src']
const EXT = /\.(ts|tsx|js|mjs)$/

/** A file and a piece of the flagged line, with why that prefix check is not an id reference. */
interface Allowed { file: string; match: string; reason: string }

const ALLOWED: Allowed[] = [
  { file: 'src/lib/id-ref.ts', match: 'id.startsWith(ref)', reason: 'the helper itself' },
  { file: 'src/providers/offline-host-core.ts', match: 'id.startsWith(ref)', reason: 'inlined copy of the helper (daemon-source.ts inlines the factory text)' },
  { file: 'src/providers/offline-host-core.ts', match: 't.id.startsWith(q)', reason: 'task_list search filter over titles and ids, lists every hit' },
  { file: 'src/lib/send-targets.ts', match: 'o.startsWith(ref) || ref.startsWith(o)', reason: 'dedupes refs printed by one send (often cut short); no id list here, readers resolve each ref with matchIdRef' },
  { file: 'src/core/sessions/thread-ai-stub.ts', match: 'sessionId.startsWith(prefix)', reason: 'test stub switch: an env var names a session id prefix to serve' },
  { file: 'src/integrations/mail/identity-revision.ts', match: 'accountId.startsWith(prefix)', reason: 'account ids are `<provider>:<account>`, the prefix is `<provider>:`' },
  { file: 'src/integrations/mail/body-revision.ts', match: 'accountId.startsWith(prefix)', reason: 'account ids are `<provider>:<account>`, the prefix is `<provider>:`' },
  { file: 'web/src/components/tasks/TodoPanel.tsx', match: 'id.startsWith(ownPrefix)', reason: 'tier label row ids built from a fixed prefix' },
  { file: 'web/src/components/tasks/TaskDetailEdits.tsx', match: 't.id.startsWith(needle)', reason: 'dependency picker search, lists every hit' },
  { file: 'web/src/stores/entity-label-store.ts', match: 'x.startsWith(ref)', reason: 'cache invalidation: any id a cached ref could name; wider is safe' },
  { file: 'web/src/components/tasks/team-menu-model.ts', match: 't.id.toLowerCase().startsWith(q)', reason: 'team menu search, lists every hit' },
  { file: 'web/src/components/tasks/adopt-candidates.ts', match: 't.id.toLowerCase().startsWith(q)', reason: 'adopt picker search, lists every hit' },
]

const ID_LIKE = /(?:id|Id|ID|ref|Ref)$/
/** An argument that names an id or an id's prefix. */
const ARG_ID_LIKE = /(?:id|Id|ID|ref|Ref|[iI]dPrefix|IDPrefix|[sS]idPrefix|[rR]efPrefix)$/
/** An identifier chain (`t.parent_task_id!`, `peer.shortId`, `s.sid.toLowerCase()`). */
const CHAIN = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|!|\[[^\]]*\])*(?:\.toLowerCase\(\))?!?$/
const CONSTANT = /(?:^|\.)[A-Z][A-Z0-9_]*$/

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(p))
    else if (EXT.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** The last name of a chain: `t.parent_task_id!` -> `parent_task_id`. */
function lastName(expr: string): string {
  const bare = expr.replace(/\.toLowerCase\(\)/g, '').replace(/[!?]/g, '').replace(/\[[^\]]*\]$/, '')
  return bare.split('.').pop() ?? ''
}

/** The `.startsWith(...)` calls on a line that prefix-match an id, as `receiver.startsWith(arg)`. */
export function idPrefixCalls(line: string): string[] {
  const out: string[] = []
  const re = /([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|!|\[[^\]]*\]|\(\))*)\??\.startsWith\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g
  for (const m of line.matchAll(re)) {
    const receiver = m[1]!.replace(/\.toLowerCase\(\)$/, '')
    const arg = m[2]!.trim()
    if (!arg || /^['"`]/.test(arg) || !CHAIN.test(arg) || CONSTANT.test(arg.replace(/[!?]/g, ''))) continue
    if (!ID_LIKE.test(lastName(receiver)) && !ARG_ID_LIKE.test(lastName(arg))) continue
    out.push(`${m[1]}.startsWith(${arg})`)
  }
  return out
}

/** Code lines only: block-comment bodies and `//` comments are prose about the rule. */
function codeLines(text: string): Array<{ n: number; line: string }> {
  const out: Array<{ n: number; line: string }> = []
  let inBlock = false
  text.split('\n').forEach((raw, i) => {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end < 0) return
      line = line.slice(end + 2)
      inBlock = false
    }
    line = line.replace(/\/\*.*?\*\//g, '')
    const open = line.indexOf('/*')
    if (open >= 0) { inBlock = true; line = line.slice(0, open) }
    const slash = line.search(/(^|[^:'"`\\])\/\//)
    if (slash >= 0) line = line.slice(0, slash + 1)
    if (line.trim()) out.push({ n: i + 1, line })
  })
  return out
}

export function violations(files: string[]): string[] {
  const out: string[] = []
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    for (const { n, line } of codeLines(fs.readFileSync(file, 'utf8'))) {
      for (const call of idPrefixCalls(line)) {
        if (ALLOWED.some((a) => a.file === rel && line.includes(a.match))) continue
        out.push(`${rel}:${n}: ${call}`)
      }
    }
  }
  return out
}

describe('id references resolve through src/lib/id-ref.ts', () => {
  it('no source file prefix-matches an id outside the helper', () => {
    const files = DIRS.flatMap((d) => sources(path.join(ROOT, d)))
    expect(files.length).toBeGreaterThan(100)
    const found = violations(files)
    expect(found, `A prefix match of an id that skips the exact id. Use matchIdRef / refNamesId from src/lib/id-ref.ts (the whole id wins over a prefix), or add a genuine non-id prefix check to ALLOWED in tests/lib/id-ref-ratchet.test.ts with its reason:\n${found.join('\n')}`).toEqual([])
  })

  it('every allowlist entry still names a line the check would flag', () => {
    const stale = ALLOWED.filter((a) => !codeLines(fs.readFileSync(path.join(ROOT, a.file), 'utf8'))
      .some(({ line }) => line.includes(a.match) && idPrefixCalls(line).length > 0))
    expect(stale.map((a) => `${a.file}: ${a.match}`)).toEqual([])
  })

  it('flags the shapes the bug took, and leaves literals, constants and paths alone', () => {
    expect(idPrefixCalls('const m = tasks.filter((t) => t.id.startsWith(ref))')).toEqual(['t.id.startsWith(ref)'])
    expect(idPrefixCalls('store.tasks.find((t) => t.id.startsWith(input.parent_task_id!))')).toHaveLength(1)
    expect(idPrefixCalls('if (taskId.startsWith(own.parent_task_id)) return')).toHaveLength(1)
    expect(idPrefixCalls('s.claudeSessionId.toLowerCase().startsWith(printed)')).toHaveLength(1)
    expect(idPrefixCalls('full.startsWith(idPrefix)')).toHaveLength(1)
    expect(idPrefixCalls('const m = tasks.filter((t) => t.id.startsWith(prefix))')).toHaveLength(1)
    expect(idPrefixCalls('for (const id of known) if (id.startsWith(parent)) stale(id)')).toHaveLength(1)
    expect(idPrefixCalls('if (!name.startsWith(prefix)) continue')).toEqual([])
    expect(idPrefixCalls("if (id.startsWith('rq-')) return")).toEqual([])
    expect(idPrefixCalls('if (id.startsWith(SEP_PREFIX)) return')).toEqual([])
    expect(idPrefixCalls('engine?.startsWith(chatHistory.CLOUD_ENGINE_PREFIX)')).toEqual([])
    expect(idPrefixCalls('if (p.startsWith(dir + path.sep)) return')).toEqual([])
    expect(idPrefixCalls('if (name.startsWith(base)) return')).toEqual([])
  })
})
