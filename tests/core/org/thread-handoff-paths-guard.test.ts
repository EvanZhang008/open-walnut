/**
 * Guard: every path that hands work to another task hands one of the user's Threads on with it
 * (src/core/org/thread-follow.ts; 2026-11-08, the user, after a thread stayed with a VP that had
 * passed its work to another: "why this is ehre ... should go to walnut vp").
 *
 * Fails when
 *   - a route that sends a message to a task, starts one or creates one for a caller does not call
 *     handOffThread (or is not listed below as a person's own surface, with why);
 *   - an op that reaches one of those routes takes no `thread` argument;
 *   - a route in HANDOFF_ROUTES stops calling it;
 *   - the follow rule stops listening to task and thread changes (a task moved by any path).
 * Counted from the source, so a new send, start or create path fails here until it hands the thread on.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { HANDOFF_ROUTES } from '../../../src/core/org/thread-follow.js'
import { getOp, listOps } from '../../../src/ops/index.js'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
/** Code lines only: comments name these calls too. */
const code = (src: string) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

/** Route files whose sender keeps no Threads (a person's own surface, a triage run), with why. */
const NO_THREAD_SURFACES: Record<string, string> = {
  'src/web/routes/notifications.ts': 'a notification action the user taps starts the task as his own',
  'src/web/routes/quick-input-v1.ts': 'the user\'s quick input box starts his own task',
  'src/web/routes/sessions.ts': 'the session panel\'s launch, a person\'s own start',
  'src/web/routes/triage-rules-v1.ts': 'an Inbox Triage run routing a mail item to a standing rule\'s task; a triage run keeps no Threads',
}

const SEND_RE = /\b(performSessionSend|startSessionForTask|quickStartSession)\(/

function routeFiles(dir = 'src/web/routes'): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...routeFiles(rel))
    else if (e.name.endsWith('.ts')) out.push(rel)
  }
  return out
}

describe('every route that hands work to a task hands the thread on', () => {
  it('each send, start or create route calls handOffThread, or its sender keeps no Threads', () => {
    const missing: string[] = []
    for (const rel of routeFiles()) {
      const src = code(read(rel))
      if (!SEND_RE.test(src)) continue
      if (src.includes('handOffThread(')) continue
      if (NO_THREAD_SURFACES[rel]) continue
      missing.push(rel)
    }
    expect(missing, 'route files that send, start or create work without handing the thread on (core/org/thread-follow.ts handOffThread)').toEqual([])
  })

  it('the routes the rule names still call it', () => {
    for (const r of HANDOFF_ROUTES) expect(code(read(r.file)), r.file).toContain('handOffThread(')
  })

  it('a surface listed here still exists and still sends (else drop it from the list)', () => {
    for (const rel of Object.keys(NO_THREAD_SURFACES)) expect(SEND_RE.test(code(read(rel))), rel).toBe(true)
  })
})

describe('every op that reaches one of those routes takes `thread`', () => {
  const HANDOFF_CALL = /call\(\s*'POST',\s*'\/messages'|startTask\(|call\(\s*'POST',\s*'\/tasks'\s*,/
  it('found from the source: an op whose handler sends, starts or creates', () => {
    const names: string[] = []
    for (const e of fs.readdirSync(path.join(ROOT, 'src/ops'))) {
      if (!e.endsWith('.ts')) continue
      const src = read(`src/ops/${e}`)
      for (const block of src.split('defineOp({').slice(1)) {
        const name = /\bname:\s*'([a-z_]+)'/.exec(block)?.[1]
        if (name && HANDOFF_CALL.test(code(block))) names.push(name)
      }
    }
    expect(names).toEqual(expect.arrayContaining(['task_start', 'task_create', 'org_send']))
    for (const name of names) expect(Object.keys(getOp(name)?.input ?? {}), name).toContain('thread')
  })

  it('found from the registry: an op bound to a hand-off route', () => {
    const paths = new Set(HANDOFF_ROUTES.map((r) => `${r.method} ${r.path}`))
    const bound = listOps().filter((op) => [op.bind, ...(op.routes ?? [])].some((b) => b && paths.has(`${b.method} ${b.path}`)))
    expect(bound.map((o) => o.name)).toEqual(expect.arrayContaining(['task_send', 'org_send']))
    for (const op of bound) expect(Object.keys(op.input ?? {}), op.name).toContain('thread')
  })
})

describe('a task moved by any path moves its thread', () => {
  it('the follow rule listens to every task change and to the threads, and runs on a clock too', () => {
    const src = code(read('src/core/org/thread-follow.ts'))
    for (const ev of ['TASK_CREATED', 'TASK_UPDATED', 'TASK_COMPLETED', 'ORG_THREADS_CHANGED']) expect(src).toContain(`EventNames.${ev}`)
    expect(src).toMatch(/setInterval\(/)
    expect(code(read('src/web/server.ts'))).toContain('startThreadFollow()')
  })
})
