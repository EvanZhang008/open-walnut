/**
 * The class of the 2026-11-26 report (two of his questions, one reply, both marked answered with
 * no summary: neither had a card for 84 minutes): every write that lands an answer of the node on
 * his message, or turns a thread answered, leaves cards that say one reply as ONE thread
 * (src/core/org/thread-one-reply.ts), and a node whose threads such a write changed is read by the
 * thread check soon after, not at its next six hours (thread-audit.ts).
 *
 * Enumerated from the source, so a new way to write an answer or an answered state fails here
 * until it is listed with how it keeps one reply on one card.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const STORE = 'src/core/org/threads-store.ts'
const AUDIT = 'src/core/org/thread-audit.ts'

function srcFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name)
    return e.isDirectory() ? srcFiles(rel) : e.name.endsWith('.ts') ? [rel] : []
  })
}
const code = (src: string) => src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
const calls = (src: string, fn: string) => code(src).split('\n').filter((l) => !new RegExp(`function ${fn}\\(`).test(l) && new RegExp(`(^|[^.\\w])${fn}\\(`).test(l)).length

/** Each top-level function of a file, by name, with its body (up to the next top-level declaration). */
function functionsOf(src: string): Map<string, string> {
  const out = new Map<string, string>()
  const starts = [...src.matchAll(/^(?:export )?(?:async )?function (\w+)[(<]/gm)]
  starts.forEach((m, i) => {
    const end = src.slice(m.index! + 1).search(/^(?:export |async function |function |const |let |interface |type |\/\*\*)/m)
    const next = starts[i + 1]?.index ?? src.length
    out.set(m[1], src.slice(m.index!, Math.min(next, end < 0 ? src.length : m.index! + 1 + end + 4000)))
  })
  return out
}

/** Every file that puts an answer on a message of his (the model's setAnswers), and how one reply stays on one card there. */
const ANSWER_WRITERS: Record<string, { calls: number; how: string }> = {
  [STORE]: { calls: 1, how: 'setThreadAnswers: the answers read from the node\'s chat; mergeOneReply in the same locked write' },
  'src/core/org/thread-answered-check.ts': { calls: 1, how: 'answerOne, reached only through markAnsweredGroup: the questions the reply answers merge before the mark, and a reply another thread carries is not written' },
}

/** Every exported write of the store that goes through the model's updateThread (a state may turn answered there). */
const STATE_WRITERS: Record<string, 'merges' | 'check'> = {
  // The node's lines (a reply's card lines, the status question's): mergeOneReply in the same locked write.
  writeOwnThreads: 'merges',
  // One named thread, by a node's own op or by him, read back by its id: the thread check joins what it leaves (joinOneReplyCards).
  patchThread: 'check',
}

/** Every other write of Walnut's own on a node's threads (writeThreadsFor), and why it leaves no two cards saying one reply; whatever one did leave is joined at the thread check. */
const OWN_WRITERS: Record<string, { calls: number; why: string }> = {
  'src/core/org/thread-answered-check.ts': { calls: 1, why: 'markAnsweredGroup: merges the questions the reply answers before it marks' },
  'src/core/org/thread-join-check.ts': { calls: 1, why: 'moves a remark (it asks nothing) or splits a message out, and a split-out thread never joins (splitOut)' },
  'src/core/org/held-threads.ts': { calls: 1, why: 'a thread that holds a letter or a Board choice: such a thread never joins' },
  'src/core/org/thread-report-ask.ts': { calls: 1, why: 'stores a decision id on a thread that asks him: no answer and no state' },
  'src/core/org/thread-ended.ts': { calls: 1, why: 'closes threads whose work ended: a closed thread is no card' },
  'src/core/org/thread-ack.ts': { calls: 1, why: 'settles a thread after his Acknowledge or reaction: one he acknowledged never joins' },
  'src/core/org/thread-supersede.ts': { calls: 2, why: 'sets aside or closes a thread a newer ask replaced: pending or closed, never answered' },
}

describe('every write that lands an answer or turns a thread answered keeps one reply on one card', () => {
  it('every write of Walnut\'s own through writeThreadsFor( is listed with why it leaves no such pair', () => {
    const found: Record<string, number> = {}
    for (const f of srcFiles('src')) {
      if (f === STORE) continue
      // Called as a store method too (store.writeThreadsFor).
      const n = code(read(f)).split('\n').filter((l) => /\bwriteThreadsFor\(/.test(l)).length
      if (n) found[f] = n
    }
    expect(found, 'a new write of Walnut\'s own on a node\'s threads: say why it cannot leave two cards saying one reply (or merge there), and list it').toEqual(
      Object.fromEntries(Object.entries(OWN_WRITERS).map(([f, v]) => [f, v.calls])),
    )
    for (const [f, v] of Object.entries(OWN_WRITERS)) expect(v.why.length, f).toBeGreaterThan(20)
  })

  it('a thread a split took out of another is marked, and never joins', () => {
    const model = read('src/core/org/threads-model.ts')
    const split = model.slice(model.indexOf('export function splitThreadMessage('), model.indexOf('export function splitMessageInto('))
    expect(split).toContain('splitOut: at')
    // Every split makes its thread there: a second place that builds a split-out thread would need the mark too.
    expect(calls(model.replace(split, ''), 'newThreadId')).toBe(calls(model, 'newThreadId') - 1)
    const one = read('src/core/org/thread-one-reply.ts')
    expect(one.slice(one.indexOf('function saysReply('), one.indexOf('export interface OneReplyMerge'))).toContain('if (t.splitOut) return null')
  })

  it('every caller of the model\'s setAnswers( is listed', () => {
    const found: Record<string, number> = {}
    for (const f of srcFiles('src')) {
      if (f === 'src/core/org/threads-model.ts') continue
      const n = calls(read(f), 'setAnswers')
      if (n) found[f] = n
    }
    expect(found, 'a new place writes an answer onto his message: run mergeOneReply in that write (with the file before it), and list it here').toEqual(
      Object.fromEntries(Object.entries(ANSWER_WRITERS).map(([f, v]) => [f, v.calls])),
    )
  })

  it('every exported store write through updateThread( is listed, and the ones that merge do so against the file before the write', () => {
    const fns = functionsOf(read(STORE))
    const writers = [...fns].filter(([name, body]) => new RegExp(`^export (async )?function ${name}\\b`).test(body) && calls(body, 'updateThread') > 0).map(([name]) => name).sort()
    expect(writers, 'a new store write can turn a thread answered: merge there (mergeOneReply with the file before), or say why the thread check\'s join is enough, and list it').toEqual(Object.keys(STATE_WRITERS).sort())
    for (const name of ['setThreadAnswers', 'writeOwnThreads']) {
      const body = code(fns.get(name)!)
      // Three arguments: the file after, the time, the file before (only a card that came to say the reply in this write joins).
      expect(body, name).toMatch(/mergeOneReply\([^(),]+(?:\([^()]*\))?[^(),]*,[^,]+,\s*[\w.]+\)/)
      expect(body, name).toContain('saidOneReply(taskId, joined')
    }
    expect(code(fns.get('patchThread')!)).not.toContain('mergeOneReply(')
  })

  it('the answered check merges before it marks, and never puts one reply under two threads', () => {
    const src = read('src/core/org/thread-answered-check.ts')
    const group = src.slice(src.indexOf('export function markAnsweredGroup('), src.indexOf('export function markAnswered('))
    expect(group.indexOf('mergeThreads(')).toBeGreaterThan(0)
    expect(group.indexOf('answerOne(')).toBeGreaterThan(group.indexOf('mergeThreads('))
    expect(group.indexOf('if (carried) return')).toBeLessThan(group.indexOf('answerOne('))
    // Its write goes through that function, and nothing else in the file calls answerOne.
    expect(calls(src, 'answerOne')).toBe(1)
    expect(src).toMatch(/writeThreadsFor\(taskId, \(cur\) => \{\s*const r = markAnsweredGroup\(/)
    // One title for the kept thread, built in one place.
    expect(src).toContain("import { titledForAll } from './thread-one-reply.js'")
    expect(calls(src, 'function titledForAll')).toBe(0)
  })

  it('mergeOneReply is called only by the store: two writes and the thread check\'s join', () => {
    const found: Record<string, number> = {}
    for (const f of srcFiles('src')) {
      if (f === 'src/core/org/thread-one-reply.ts') continue
      const n = calls(read(f), 'mergeOneReply')
      if (n) found[f] = n
    }
    expect(found).toEqual({ [STORE]: 4 })
    const join = code(functionsOf(read(STORE)).get('joinOneReplyCards')!)
    // Read first: a node with nothing to join is not written.
    expect(join.indexOf('readThreads(taskId)')).toBeGreaterThan(0)
    expect(join.indexOf('readThreads(taskId)')).toBeLessThan(join.indexOf('mutateThreads('))
  })
})

describe('a node whose threads changed is read by the thread check soon after', () => {
  const audit = read(AUDIT)
  const fns = functionsOf(audit)

  it('both reads of a node (the clock\'s and the soon one) join its one-reply cards before the pass', () => {
    for (const name of ['runThreadAuditPass', 'runThreadAuditSoon']) {
      const body = code(fns.get(name)!)
      expect(body.indexOf('await joinOneReply('), name).toBeGreaterThan(0)
      expect(body.indexOf('await joinOneReply('), name).toBeLessThan(body.indexOf('auditNode('))
    }
    expect(code(fns.get('joinOneReply')!)).toContain('joinOneReplyCards(taskId)')
    // Every other caller of a pass is listed: the route that runs one node by hand reads what is there.
    const callers: Record<string, number> = {}
    for (const f of srcFiles('src')) {
      const n = calls(read(f), 'auditNode')
      if (n) callers[f] = n
    }
    expect(callers).toEqual({ [AUDIT]: 2, 'src/web/routes/thread-audit-v1.ts': 1 })
  })

  it('the changes the answer writes emit are the ones that arm the soon read, under the clock\'s own start and stop', () => {
    const kinds = /const SOON_KINDS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(audit)?.[1] ?? ''
    const store = functionsOf(read(STORE))
    const emitted: Array<[fn: string, kind: string]> = [['setThreadAnswers', 'answered'], ['writeOwnThreads', 'updated'], ['saidOneReply', 'merged']]
    for (const [fn, kind] of emitted) {
      expect(code(store.get(fn)!), fn).toMatch(new RegExp(`emit\\(\\{ taskId, kind: '${kind}'`))
      expect(kinds, kind).toContain(`'${kind}'`)
    }
    const start = code(fns.get('startThreadAudit')!)
    expect(start).toContain('EventNames.ORG_THREADS_CHANGED')
    expect(start).toContain('auditSoon(d.taskId)')
    // Not on an ephemeral server and not with the clock off: the subscription sits after that return.
    expect(start.indexOf("process.env.WALNUT_THREAD_AUDIT === '0'")).toBeLessThan(start.indexOf('bus.subscribe('))
    const stop = code(fns.get('stopClock')!)
    expect(stop).toContain('bus.unsubscribe(BUS_NAME)')
    expect(stop).toContain('soon.clear()')
  })

  it('the soon read runs under the clock\'s conditions', () => {
    const body = code(fns.get('runThreadAuditSoon')!)
    for (const cond of ['isFollower()', 'homeWritesStopped()', 'backgroundAiDisabled()', 'threadAuditOn()', 'isOrgEnabled()', 'keepsThreads(task)', "task.phase === 'COMPLETE'", 'task.plugin_only', 'team_stop', 'hasPairForHim(']) {
      expect(body, cond).toContain(cond)
    }
    // The pass (its note wakes the node) waits while he is in the node's chat, and the wait has an end.
    expect(body.indexOf('heIsInChat(taskId, now)')).toBeGreaterThan(0)
    expect(body.indexOf('heIsInChat(taskId, now)')).toBeLessThan(body.indexOf('auditNode('))
    expect(body).toContain('SOON_QUIET_MAX_MS')
    // The ask's named thread is read as it is after the merge of the same write.
    expect(code(functionsOf(read(STORE)).get('writeOwnThreads')!)).toContain('threadIdNow(r.file, ask.named)')
  })
})
