/**
 * Who keeps Threads is decided in one place (src/core/org/keeps-threads.ts): Main, every lead, and
 * any other task once the user turned them on (Task.threads_on; 2026-11-18, the user: "we should be
 * able to enable the thread for a leader, default off"). A thread path that asks org_role itself
 * would leave such a task half working (filed but never reminded, say), so every file that files,
 * reads, reminds or answers threads (it imports the threads store) is enumerated from the source and
 * must not test Main-or-lead by hand, unless it is listed below with why that is the Org's alone.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { keepsThreads } from '../../../src/core/org/keeps-threads.js'

const SRC = path.resolve(__dirname, '../../../src')

/** A hand-written "is it Main or a lead" test, either way round, or a local helper named for it. */
const RAW_NODE_CHECK = /org_role\s*[!=]==\s*'main'\s*(?:&&|\|\|)\s*[\w?.!]*org_role\s*[!=]==\s*'lead'|\bisNode\(|\bisOrgNode\(/

/** Files that may: what they decide belongs to Org nodes themselves, not to keeping threads. */
const ALLOWED: Record<string, string> = {
  // A thread moves with its work between Org nodes; a task with Threads on keeps its own.
  'core/org/thread-follow.ts': 'moves between Org nodes',
  // A task with Threads on keeps his words as its asks too (hint-send.ts): read back from there.
  'core/sessions/own-readback.ts': 'Org nodes read their work back from threads; a task from its asks',
  'core/sessions/user-spoke.ts': 'a task with Threads on keeps his words as its asks too',
}

/** Every file that reads or writes a node's threads (it imports the store), and the routes and ops. */
function threadFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (p.endsWith('.ts') && /threads-store\.js'/.test(fs.readFileSync(p, 'utf8'))) out.push(path.relative(SRC, p))
    }
  }
  walk(SRC)
  // The away state decides the away hint, the away inbox thread and the phone buzz of a needs thread.
  return [...new Set([...out, 'web/routes/org-threads-v1.ts', 'ops/org-threads.ts', 'core/org/user-away.ts'])].sort()
}

describe('keepsThreads', () => {
  it('Main and the leads always; another task only with threads_on; a router never', () => {
    expect(keepsThreads({ org_role: 'main' })).toBe(true)
    expect(keepsThreads({ org_role: 'lead' })).toBe(true)
    expect(keepsThreads({})).toBe(false)
    expect(keepsThreads({ threads_on: false })).toBe(false)
    expect(keepsThreads({ threads_on: true })).toBe(true)
    expect(keepsThreads({ org_role: 'router', threads_on: true })).toBe(false)
    expect(keepsThreads(null)).toBe(false)
  })
})

describe('every thread path asks keepsThreads', () => {
  it('finds the thread files (the scan reads them)', () => {
    const files = threadFiles()
    expect(files).toContain('core/org/thread-capture.ts')
    expect(files).toContain('core/org/thread-recheck.ts')
    expect(files).toContain('core/sessions/owed-waits.ts')
    expect(files).toContain('core/human-inbox/away-thread.ts')
    expect(files).toContain('core/user-status-sync.ts')
    expect(files).toContain('core/push/thread-push.ts')
    expect(files.length).toBeGreaterThan(10)
    // An allowance for a file that no longer touches threads is stale.
    for (const f of Object.keys(ALLOWED)) expect(files, f).toContain(f)
  })

  for (const rel of threadFiles()) {
    it(rel, () => {
      const src = fs.readFileSync(path.join(SRC, rel), 'utf8')
      if (ALLOWED[rel]) return
      const hit = RAW_NODE_CHECK.exec(src)
      expect(hit?.[0], `${rel} tests Main-or-lead by hand: use keepsThreads (core/org/keeps-threads.ts)`).toBeUndefined()
    })
  }
})
