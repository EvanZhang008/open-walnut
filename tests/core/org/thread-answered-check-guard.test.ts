/**
 * The class of the 2026-11-25 report ("the answer arrived in the chat, the thread still read as
 * working"; experiment threads_each_question): every path that stores a node's status answer at a
 * turn's end. Each goes through status-question.ts applyStatusAnswer, whose save hands the turn's
 * reply to the answered check (org/thread-answered-check.ts checkTurnAnswers) after the node's own
 * thread lines. Enumerated from the source, so a new way to store a turn's status answer fails here
 * until it is listed, and the check cannot drop out of the save or sit behind the ask's own condition.
 * And its unit of work stays the reply: one model call per reply, whatever the number of threads.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')

/** Every file that stores a turn's status answer, and how many calls it makes. */
const STORERS: Record<string, { calls: number; why: string }> = {
  'src/core/sessions/status-question.ts': { calls: 1, why: 'the status question asked at the turn end (askStatus)' },
  'src/core/session-hooks/builtins.ts': { calls: 1, why: 'the summary self-report, for an engine the question does not ask' },
}

function srcFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name)
    return e.isDirectory() ? srcFiles(rel) : e.name.endsWith('.ts') ? [rel] : []
  })
}

const calls = (src: string, fn: string) => src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l) && !l.includes(`function ${fn}(`) && new RegExp(`\\b${fn}\\(`).test(l)).length

describe('every stored turn-end status answer reaches the answered check', () => {
  it('every call of applyStatusAnswer( is listed', () => {
    const found: Record<string, number> = {}
    for (const f of srcFiles('src')) {
      const n = calls(read(f), 'applyStatusAnswer')
      if (n) found[f] = n
    }
    expect(found, 'a new place stores a turn\'s status answer: route it through applyStatusAnswer, or call checkTurnAnswers there, and list it here').toEqual(
      Object.fromEntries(Object.entries(STORERS).map(([f, v]) => [f, v.calls])),
    )
  })

  it('the save hands every turn end to the check, after the thread lines, for Main, the leads and tasks alike', () => {
    const src = read('src/core/sessions/status-question.ts')
    const save = src.slice(src.indexOf('async function saveStatusAnswer('), src.indexOf('export function statusQuestionPending('))
    const lines = save.indexOf('await applyThreadLines(')
    const check = save.indexOf('checkTurnAnswers(taskId, sessionId, turnEndedMs, storedAt)')
    // `since` is when the answer was stored, taken right before the check is sent (never when a queued check starts).
    expect(save.lastIndexOf('const storedAt = Date.now()', check)).toBeGreaterThan(lines)
    expect(lines).toBeGreaterThan(0)
    expect(check).toBeGreaterThan(lines)
    const line = save.slice(save.lastIndexOf('\n', check), check)
    // Only a mid-turn answer (no turn ended) skips it; never the org-node condition of the ask's place.
    expect(line).toMatch(/if \(!opts\.midTurn\)/)
    expect(line).not.toMatch(/taskLike/)
  })

  it('one model call per reply, never one per thread (2026-11-25 review: a busy node used a per-thread cap up on other replies)', () => {
    const src = read('src/core/org/thread-answered-check.ts')
    const body = src.slice(src.indexOf('async function checkOnce('), src.indexOf('export function checkTurnAnswers('))
    // The one call, on the whole list, after the reply's dedupe, then one locked write for all it named.
    expect(body.match(/\bjudge\(/g)).toHaveLength(1)
    expect(body).toMatch(/judgedBefore\(taskId, replyKey\(row\)\)[\s\S]*await judge\(listed, prose, taskId\)[\s\S]*markAnsweredGroup\(cur, ids,/)
    expect(body.match(/writeThreadsFor\(/g)).toHaveLength(1)
    expect(body.slice(0, body.indexOf('await judge('))).not.toMatch(/\bfor \(/)
    expect(src).not.toMatch(/PER_THREAD_MAX|PER_TURN_MAX/)
  })

  it('what the list call names is written only after the second read confirmed it', () => {
    const src = read('src/core/org/thread-answered-check.ts')
    const body = src.slice(src.indexOf('async function checkOnce('), src.indexOf('export function checkTurnAnswers('))
    expect(body).toMatch(/await judge\(listed, prose, taskId\)[\s\S]*confirmNamed\(asked, prose, taskId\), left, null\)[\s\S]*const ids = \(sure\?\.yes \?\? \[\]\)\.map\(\(c\) => c\.thread\.id\)[\s\S]*markAnsweredGroup\(cur, ids,/)
    expect(body.match(/\bconst ids\b/g)).toHaveLength(1)
    const confirm = src.slice(src.indexOf('async function confirmNamed('), src.indexOf('function within<T>('))
    expect(confirm).toMatch(/readConfirm\(text, prose\) === true/)
  })
})

/**
 * The class of the 2026-11-26 wrong mark: a small model's word alone changing what a card of his
 * shows. Every module that calls the fast model is listed with what its word can do. One whose YES
 * writes a card's state reads the model's quote against the text it judged (judge-line.ts
 * quotedEvidence); the others only refuse a claim or an ask, tell the node, or file his own words.
 * Enumerated from the source, the whole of src: a new judge fails here until it is listed with its bound.
 */
const JUDGES: Record<string, { does: 'writes a card' | 'refuses a claim' | 'tells the node' | 'files his words'; why: string }> = {
  'src/core/org/thread-answered-check.ts': { does: 'writes a card', why: 'marks his question answered with the reply: two reads, the second quoting the reply' },
  'src/core/org/thread-seen-check.ts': { does: 'refuses a claim', why: 'a node says he saw an answer; the judge can only refuse it, on the words of his it quotes' },
  'src/core/org/thread-audit.ts': { does: 'tells the node', why: 'two cards on one subject: the node is told and decides, the check changes nothing' },
  'src/core/org/thread-join-check.ts': { does: 'files his words', why: 'which thread his own new message goes under; no answer and no state is written on its word' },
  'src/core/same-ask-meaning.ts': { does: 'refuses a claim', why: 'a node asks him what another card already asks; the judge can only refuse the new ask' },
  'src/core/sessions/unclear-ask.ts': { does: 'tells the node', why: 'an ask that does not read alone goes back to the session to rewrite; nothing is written on its word' },
}

describe('a small model\'s word alone never changes what his card shows', () => {
  it('every module that calls the fast model is listed with its bound', () => {
    const found = srcFiles('src').filter((f) => f !== 'src/core/fast-model-call.ts' && /\bcallFastModel\(/.test(read(f))).sort()
    expect(found, 'a new judge: list it here with what its word can do; one that writes a card must check the model\'s quote').toEqual(Object.keys(JUDGES).sort())
  })

  it('a judge whose word writes a card reads the model\'s quote against the text', () => {
    for (const [f, j] of Object.entries(JUDGES)) {
      if (j.does !== 'writes a card') continue
      const src = read(f)
      expect(src, f).toMatch(/import \{[^}]*\bquotedEvidence\b[^}]*\} from '\.\/judge-line\.js'/)
      expect(src, f).toMatch(/quotedEvidence\(answer, true\)\.some\(/)
    }
  })
})
