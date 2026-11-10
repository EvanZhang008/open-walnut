/**
 * Every replication round of a kind of many rows tries the delta first
 * (core/replication/kind-delta.ts). A manifest names every row, so a kind that
 * ran manifest rounds on every change sent the whole kind up a host's link each
 * time: the tasks' 450 KB manifest every few seconds was most of what the link
 * to one host carried, and that path dropped the SSH connection every few MB
 * (2026-11-10, host.link.lost 15 an hour). This test reads the source: a new
 * caller of the manifest round must run runDeltaRound just before it, or round
 * a single-document kind (one row: its manifest is one entry).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../../../src')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** Kinds whose definition says `single: true` (the registry: one document). */
function singleKinds(files: string[]): Set<string> {
  const names = new Set<string>()
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    for (const m of text.matchAll(/(?:const|let)\s+(\w+)\s*:\s*LeaderKind<[^>]*>\s*=\s*\{([\s\S]*?)\n\}/g)) {
      if (/\bsingle:\s*true\b/.test(m[2])) names.add(m[1])
    }
  }
  return names
}

describe('every manifest round of a kind of many rows tries the delta first', () => {
  const files = sourceFiles(SRC)
  const single = singleKinds(files)

  it('finds the single-document kinds it exempts', () => {
    expect([...single]).toEqual(['REGISTRY_KIND'])
  })

  it('each caller of runKindRound runs runDeltaRound just before it, or rounds a single-document kind', () => {
    const calls: string[] = []
    const bad: string[] = []
    for (const f of files) {
      const rel = path.relative(SRC, f)
      if (rel === path.join('core', 'replication', 'kind-leader.ts')) continue // the definition
      const lines = fs.readFileSync(f, 'utf8').split('\n')
      lines.forEach((line, i) => {
        const m = line.match(/\brunKindRound\(\s*(\w+)/)
        if (!m || /^\s*(\*|\/\/)/.test(line)) return
        calls.push(`${rel}:${m[1]}`)
        if (single.has(m[1])) return
        const before = lines.slice(Math.max(0, i - 6), i).join('\n')
        if (!/\brunDeltaRound\(/.test(before)) bad.push(`${rel}:${i + 1} runKindRound(${m[1]}) with no runDeltaRound before it`)
      })
    }
    // The callers known today; a new one must also pass the check above.
    expect(calls.sort()).toEqual([
      'core/replication/kinds/copy-kind.ts:kind',
      'core/replication/task-replica.ts:REGISTRY_KIND',
      'core/replication/task-replica.ts:TASKS_KIND',
    ])
    expect(bad).toEqual([])
  })

  it('the copy kinds that take no digest are the small ones, listed here', () => {
    // A kind with no digest sends its whole manifest on every change: fine for a few
    // hundred rows, not for thousands. A new one decides here (sessions, the inbox
    // index and tasks take digests; their manifests are the large ones; 'inbox'
    // below is its bodies kind, inbox-bodies, in the same file).
    const noDigest: string[] = []
    for (const f of files) {
      const rel = path.relative(SRC, f)
      if (!rel.startsWith(path.join('core', 'replication', 'kinds'))) continue
      const n = (fs.readFileSync(f, 'utf8').match(/\bdigest:\s*false\b/g) ?? []).length
      for (let i = 0; i < n; i++) noDigest.push(path.basename(rel, '.ts'))
    }
    expect(noDigest.sort()).toEqual([
      'boards', 'config', 'conversation-bodies', 'conversations', 'inbox', 'model-catalogs',
      'notifications', 'personas', 'prefs', 'requests', 'routines', 'stt-vocab',
    ])
  })

  it('the tasks kind and its follower both take digests', () => {
    const leader = fs.readFileSync(path.join(SRC, 'core/replication/task-replica.ts'), 'utf8')
    const follower = fs.readFileSync(path.join(SRC, 'core/replication/task-replica-store.ts'), 'utf8')
    expect(leader).toMatch(/TASKS_KIND: DeltaKind<Task> = \{[\s\S]*?digest: true/)
    expect(follower).toMatch(/function makeTasksFollower[\s\S]*?digest: true/)
  })
})
