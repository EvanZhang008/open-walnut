/**
 * Guard for the class "a node's claim that he reacted, let through on the time of his message
 * alone" (2026-11-26, a trial with a real session: he thanked the node for one answer and another
 * thread's answer was marked seen too, 5 runs of 5). With threads_seen_check on, his words since
 * are read (src/core/org/thread-seen-check.ts) and the claims they do not vouch for reach the one
 * place every known mark and close is checked (threads-model.ts updateThread, `unseen`).
 *
 * The members are read from the source, so a new one fails here until it is classified:
 *   1. every use of the time rule (reactedSince) says what it decides;
 *   2. every write through updateThread says whether a node's known mark or close can ride it,
 *      and the ones it can ride pass `unseen`;
 *   3. both ways a node makes the claim ask the judge before their write.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const SRC = path.join(ROOT, 'src')

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []))
}
/** The lines of each file under src/ holding `call`, comment lines and its own declaration left out. */
function uses(call: RegExp, declared: RegExp): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const f of walk(SRC)) {
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => call.test(l) && !declared.test(l) && !/^\s*(\*|\/\/|\/\*)/.test(l))
    if (lines.length) out[path.relative(SRC, f)] = lines
  }
  return out
}

/** Each file that asks "did he write after this word", how often, and what the answer decides there. */
const TIME_RULE: Record<string, { calls: number; decides: string }> = {
  'core/org/threads-model.ts': { calls: 3, decides: 'checkClose (the node\'s own post with no message of his: its to drop anyway; the last answer: only when not unseen) and knownThrough (throws first when unseen)' },
  'core/org/thread-seen-check.ts': { calls: 1, decides: 'timingOnlyWords: which answers the judge is asked about' },
  'core/sessions/status-threads.ts': { calls: 1, decides: 'answersHeWroteAfter: which threads a seen mark may name; the mark itself goes through unseenClaims in applyThreadLines' },
  'core/org/thread-capture.ts': { calls: 1, decides: 'the tidy note names threads he may have reacted to: a note to the node, never a write' },
}

/** Each file that writes a thread through updateThread: its calls, how many pass `unseen`, and why the others need not. */
const WRITES: Record<string, { calls: number; unseen: number; why: string }> = {
  'core/org/threads-store.ts': { calls: 4, unseen: 2, why: 'patchThread and writeOwnThreads pass it; the dry run before a hand to the user and a new thread\'s first state carry no known mark or close' },
  'core/org/thread-ack.ts': { calls: 1, unseen: 0, why: 'his own Acknowledge, by the human' },
  'core/org/thread-answered-check.ts': { calls: 1, unseen: 0, why: 'sets state answered only' },
}

describe('a node\'s claim that he reacted is read against his words, wherever it is written', () => {
  it('every use of the time rule is classified', () => {
    const found = uses(/\breactedSince\(/, /export function reactedSince\(/)
    expect(Object.fromEntries(Object.entries(found).map(([f, l]) => [f, l.length]))).toEqual(Object.fromEntries(Object.entries(TIME_RULE).map(([f, r]) => [f, r.calls])))
  })

  it('every write through updateThread is classified, and the ones a claim can ride pass unseen', () => {
    const found = uses(/\bupdateThread\(/, /export function updateThread\(/)
    expect(Object.fromEntries(Object.entries(found).map(([f, l]) => [f, { calls: l.length, unseen: l.filter((x) => /\bunseen\b/.test(x)).length }])))
      .toEqual(Object.fromEntries(Object.entries(WRITES).map(([f, r]) => [f, { calls: r.calls, unseen: r.unseen }])))
  })

  it('the model refuses on unseen in both checks, and nowhere lets time alone through beside it', () => {
    const model = fs.readFileSync(path.join(SRC, 'core/org/threads-model.ts'), 'utf8')
    const body = (name: string) => { const i = model.indexOf(`function ${name}(`); return model.slice(i, model.indexOf('\n}\n', i)) }
    expect(body('knownThrough')).toMatch(/unseen\?\.has\(t\.id\)\) throw notReacted\(/)
    expect(body('checkClose')).toMatch(/const read = !!unseen\?\.has\(t\.id\)/)
    // His quoted words rescue a close from a refused claim only when they were read as asking for it.
    expect(body('checkClose')).toMatch(/if \(closeAskOf\(t, words\) && \(!unseen\?\.has\(t\.id\) \|\| closeAsked === true\)\) return;/)
    // The last answer's time counts only when his words were not read as about something else.
    expect(body('checkClose')).toMatch(/reactedSince\(file, last\.answer\) && !read\b/)
    expect(body('checkClose')).toMatch(/isAcknowledgement\(last\.text\) && \(!read \|\| readsAsReaction\(last\)\)/)
    expect(model).toMatch(/knownThrough\(file, cur, upTo, by, opts\.unseen\)/)
    expect(model).toMatch(/checkClose\(file, cur, by, patch\.user_words, opts\.unseen, opts\.closeAsked\)/)
  })

  it('both ways a node claims it ask the judge before their write', () => {
    const asks = uses(/\bunseenClaims\(/, /export async function unseenClaims\(/)
    expect(Object.keys(asks).sort()).toEqual(['core/org/threads-store.ts', 'core/sessions/status-threads.ts'])
    const store = fs.readFileSync(path.join(SRC, 'core/org/threads-store.ts'), 'utf8')
    const patch = store.slice(store.indexOf('export async function patchThread('), store.indexOf('export async function', store.indexOf('export async function patchThread(') + 10))
    // Asked before the lock, for a known mark or a close that quotes no words of his.
    expect(patch.indexOf('unseenClaims(')).toBeGreaterThan(0)
    expect(patch.indexOf('unseenClaims(')).toBeLessThan(patch.indexOf('mutateThreads('))
    // Every known mark and every close of a node, one that quotes his words too.
    expect(patch).toMatch(/by !== 'human' && !placing && \(rest\.known !== undefined \|\| rest\.close\) \? await import\('\.\/thread-seen-check\.js'\)/)
    expect(patch).not.toMatch(/!rest\.user_words/)
    // On a refused claim his quoted words move under the thread, and close it, only when they ask for a close.
    expect(patch).toMatch(/unseen\?\.has\(id\) && rest\.close && rest\.user_words \? \(await seenCheck\.closeAsked\(taskId, rest\.user_words\)\) === true/)
    expect(patch).toMatch(/if \(carryLang && closeAsked !== false\) cur = carryHisWords\(/)
    const lines = fs.readFileSync(path.join(SRC, 'core/sessions/status-threads.ts'), 'utf8')
    const apply = lines.slice(lines.indexOf('export async function applyThreadLines('))
    expect(apply.indexOf('unseenClaims(')).toBeLessThan(apply.indexOf('writeOwnThreads(taskId'))
    // A seen mark and a done line are both claims.
    expect(apply).toMatch(/marks\.seen \?\? \[\]\)\.map\(\(m\) => m\.id\), \.\.\.lines\.filter\(\(l\) => l\.state === 'done'\)/)
  })
})
