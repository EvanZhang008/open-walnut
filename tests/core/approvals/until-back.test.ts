/**
 * An agent's ask that waits for the person stays open until they answer, while they are away too
 * (src/core/approvals/store.ts `untilBack`, at most held-asks.ts HOLD_MS), never its short clock
 * (2026-11-26: a $30 payment's ask in the browser expired in 10 minutes twice while the person was
 * away, and its task went back to waiting on them). Real store on a temp data dir; nothing reaches
 * a device.
 *
 * The class: every place that asks the person through createApproval for an agent that waits
 * (a browser step that buys, sends or deletes; a new site; a new sign-in; an upload; a password; a
 * locked note; approval_request), and every map those places keep their asks in. The guards below
 * enumerate both from the source, so a new creator or a new fixed-clock map fails here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-until-back'))

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  APPROVAL_PENDING_MAX, UNTIL_BACK_ALL_MAX, UNTIL_BACK_MAX, answerApproval, createApproval, getApproval, _resetApprovalTimersForTesting,
} from '../../../src/core/approvals/store.js'
import { HOLD_MS } from '../../../src/core/approvals/held-asks.js'
import { askExpiredWords, askOpenWords } from '../../../src/core/approvals/types.js'
import { askerNoticeFor } from '../../../src/core/approvals/tell-asker.js'
import { TOKEN_MAX_AGE_MS } from '../../../src/core/approvals/cli-token.js'
import { APPROVE_EXIT, runApprove } from '../../../src/core/approvals/cli-core.js'
import type { OpCallResult } from '../../../src/core/approvals/cli-core.js'
import { TAKE_MS, _resetOutwardAsksForTesting, answerOutward, askOutward, type Hold } from '../../../src/core/browser-control/outward-asks.js'
import { _resetFreshSignInForTesting, askFreshSignIn } from '../../../src/core/browser-control/fresh-sign-in.js'
import { _resetUploadGrantsForTesting, askUpload } from '../../../src/core/browser-control/upload-grants.js'

const ROOT = path.resolve(__dirname, '../../..')
const MIN = 60_000
const requester = { host: 'build-box', taskId: 't-bill', taskTitle: 'Pay the power bill', sessionId: 's-bill' }
const PAY: Hold = { kind: 'buy', why: '"Pay $30.00" buys or pays', what: 'click button "Pay $30.00"', url: 'https://pay.example.test/bill', sig: 'buy|click button "Pay $30.00"|https://pay.example.test/bill||$30.00', total: '$30.00' }
const tap = (id: string, digest: string, decision: 'approve' | 'deny' = 'approve') =>
  answerApproval(id, { decision, digest, device: { name: 'Phone', kind: 'iphone' } })

let t = Date.parse('2026-11-26T16:14:00Z')
const at = (ms: number) => { t += ms; vi.setSystemTime(t) }

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  t = Date.parse('2026-11-26T16:14:00Z')
  vi.setSystemTime(t)
  _resetApprovalTimersForTesting()
  _resetOutwardAsksForTesting()
  _resetFreshSignInForTesting()
  _resetUploadGrantsForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})
afterEach(() => vi.useRealTimers())

describe('the store: an ask that waits for the person stays open until they answer', () => {
  it('a task\'s ask with untilBack is open HOLD_MS and says so; without it, its own clock', async () => {
    const long = await createApproval({ what: 'Pay the bill', timeoutMs: 10 * MIN, untilBack: true, requester })
    expect(long.approval.untilBack).toBe(true)
    expect(Date.parse(long.approval.expiresAt) - t).toBe(HOLD_MS)
    const short = await createApproval({ what: 'Run the deploy', timeoutMs: 10 * MIN, requester })
    expect(short.approval.untilBack).toBeUndefined()
    expect(Date.parse(short.approval.expiresAt) - t).toBe(10 * MIN)
  })

  it('never for a step that went ahead unasked, nor for an asker that is no task or session', async () => {
    const unasked = await createApproval({ what: 'Went ahead', timeoutMs: 10 * MIN, untilBack: true, unasked: 'browserOutward', requester })
    expect(unasked.approval.untilBack).toBeUndefined()
    const script = await createApproval({ what: 'A bare script', timeoutMs: 10 * MIN, untilBack: true, requester: { host: 'build-box' } })
    expect(script.approval.untilBack).toBeUndefined()
    expect(Date.parse(script.approval.expiresAt) - t).toBe(10 * MIN)
  })

  it(`at most ${UNTIL_BACK_MAX} open at a time per task: the next keeps its own clock, another task is not held back`, async () => {
    for (let i = 0; i < UNTIL_BACK_MAX; i++) {
      expect((await createApproval({ what: `Step ${i}`, timeoutMs: 10 * MIN, untilBack: true, requester })).approval.untilBack).toBe(true)
    }
    const over = await createApproval({ what: 'One more', timeoutMs: 10 * MIN, untilBack: true, requester })
    expect(over.approval.untilBack).toBeUndefined()
    expect(Date.parse(over.approval.expiresAt) - t).toBe(10 * MIN)
    const other = await createApproval({ what: 'Step 0', timeoutMs: 10 * MIN, untilBack: true, requester: { ...requester, taskId: 't-other', sessionId: 's-other' } })
    expect(other.approval.untilBack).toBe(true)
  })

  it(`at most ${UNTIL_BACK_ALL_MAX} open in all, so they never fill the ${APPROVAL_PENDING_MAX}-ask cap a script needs`, async () => {
    expect(UNTIL_BACK_ALL_MAX).toBeLessThan(APPROVAL_PENDING_MAX)
    for (let i = 0; i < UNTIL_BACK_ALL_MAX; i++) {
      const r = { ...requester, taskId: `t-${i}`, sessionId: `s-${i}` }
      expect((await createApproval({ what: 'Pay', timeoutMs: 10 * MIN, untilBack: true, requester: r })).approval.untilBack).toBe(true)
    }
    const over = await createApproval({ what: 'Pay', timeoutMs: 10 * MIN, untilBack: true, requester: { ...requester, taskId: 't-late', sessionId: 's-late' } })
    expect(over.approval.untilBack).toBeUndefined()
  })

  it('answered after hours away, it is the same ask, and one tap approves it', async () => {
    const { approval } = await createApproval({ what: 'Pay the bill', timeoutMs: 10 * MIN, untilBack: true, requester })
    at(5 * 60 * MIN)
    expect((await getApproval(approval.id))?.status).toBe('pending')
    await tap(approval.id, approval.digest)
    expect((await getApproval(approval.id))?.status).toBe('approved')
  })

  it('it runs out only at its end, and the asker is told not to ask again by itself', async () => {
    const { approval } = await createApproval({ what: 'Pay the bill', timeoutMs: 10 * MIN, untilBack: true, requester })
    at(HOLD_MS - MIN)
    expect((await getApproval(approval.id))?.status).toBe('pending')
    at(2 * MIN)
    const rec = await getApproval(approval.id)
    expect(rec?.status).toBe('expired')
    const notice = askerNoticeFor(rec!)
    expect(notice?.body).toMatch(/do not ask again by yourself/)
    expect(notice?.body).not.toMatch(/Ask again \(approval_request\)/)
  })

  it('approved: Walnut\'s own ask tells the session to make the same call again; a script\'s ask does not get those words', async () => {
    const own = await createApproval({ what: 'Pay', detail: 'The task wants to pay.', detailRole: 'summary', timeoutMs: 10 * MIN, untilBack: true, requester })
    await tap(own.approval.id, own.approval.digest)
    expect(askerNoticeFor((await getApproval(own.approval.id))!)?.body).toMatch(new RegExp(`request "${own.approval.id}"[^]*password_wait[^]*locked_note_wait`))
    const script = await createApproval({ what: 'Deploy', detail: 'diff', timeoutMs: 10 * MIN, untilBack: true, requester })
    await tap(script.approval.id, script.approval.digest)
    expect(askerNoticeFor((await getApproval(script.approval.id))!)?.body).not.toMatch(/password_wait/)
  })
})

describe('walnut approve --approval on an ask still open: it gives up after its own --timeout, the ask stays', () => {
  it('exit 4 (asked, not answered yet), its saved request kept for the next rerun', async () => {
    const dir = fs.mkdtempSync(path.join(WALNUT_HOME, '..', 'until-back-cli-'))
    const pending = { id: 'apr-long1', status: 'pending', what: 'Publish', mode: 'tap', createdAt: new Date(t).toISOString(), expiresAt: new Date(t + HOLD_MS).toISOString(), untilBack: true }
    const call = async (name: string): Promise<OpCallResult> => name === 'approval_request'
      ? { ok: true, result: { approval: pending, waitToken: 'tok' } }
      : { ok: true, result: { approval: pending, used: false } }
    let clock = t
    const says: string[] = []
    const io = { call, say: (l: string) => { says.push(l) }, out: () => undefined, sleep: async () => undefined, tokenDir: dir, now: () => (clock += 20_000) }
    const args = { what: 'Publish', timeoutMs: 60_000, json: false }
    expect(await runApprove({ ...args, requestOnly: true }, io)).toBe(APPROVE_EXIT.pending)
    expect(await runApprove({ ...args, approvalId: 'apr-long1' }, io)).toBe(APPROVE_EXIT.pending)
    expect(says.at(-1)).toMatch(/stays open until[^]*end your turn[^]*never the agent-ack line/)
    expect(fs.existsSync(path.join(dir, 'apr-long1.json'))).toBe(true)
    // Stopped (Ctrl-C, or a tool's timeout) mid-wait: the person's ask stays open, nothing is withdrawn.
    let interrupt: () => void = () => undefined
    const names: string[] = []
    const held = async (name: string): Promise<OpCallResult> => {
      names.push(name)
      if (name === 'approval_wait') { setTimeout(() => interrupt(), 5); return new Promise(() => undefined) }
      return call(name)
    }
    expect(await runApprove({ ...args, approvalId: 'apr-long1' }, { ...io, call: held, onInterrupt: (fn: () => void) => { interrupt = fn; return () => undefined } })).toBe(APPROVE_EXIT.pending)
    expect(names).not.toContain('approval_cancel')
    expect(fs.existsSync(path.join(dir, 'apr-long1.json'))).toBe(true)
    // Its saved request outlives the longest ask.
    expect(TOKEN_MAX_AGE_MS).toBeGreaterThan(HOLD_MS)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('the words the asking agent reads', () => {
  it('a long ask: end the turn, Walnut tells the answer, never ask again; a short one: its minutes', () => {
    const words = askOpenWords({ until: t + HOLD_MS, untilBack: true }, t)
    expect(words).toMatch(/until they answer/)
    expect(words).toMatch(/end your turn/)
    expect(words).toMatch(/Do not ask again/)
    expect(askOpenWords({ until: t + 10 * MIN }, t)).toBe('The ask stays open 10 minutes.')
    expect(askExpiredWords({ until: t, untilBack: true })).toMatch(/Do not ask again by yourself/)
  })
})

describe('the browser\'s asks keep a long ask, one per step, past their old 10 minutes', () => {
  const owner = 'task:t-bill'
  const args = (ref: string) => ({ ref })

  it('Pay: open until answered; the same button after 11 minutes (a new ref, another tab) is the same ask; one tap lets it through', async () => {
    const first = await askOutward({ owner, tab: 7, action: 'click', args: args('e12'), hold: PAY, requester })
    expect(first).toMatchObject({ status: 'needs_ok', untilBack: true })
    expect(Date.parse(String(first.expiresAt)) - t).toBe(HOLD_MS)
    expect(String(first.error)).toMatch(/until they answer/)
    const id = String(first.request)
    at(11 * MIN)
    const again = await askOutward({ owner, tab: 9, action: 'click', args: args('e31'), hold: PAY, requester })
    expect(again.request).toBe(id)
    // The ask follows the newest call: its tab and ref answer.
    expect(await answerOutward({ id, owner, tab: 9, action: 'click', args: args('e31'), holdMs: 0 })).toMatchObject({ ok: false, status: 202 })
    const rec = await getApproval(id)
    await tap(id, rec!.digest)
    expect(await answerOutward({ id, owner, tab: 9, action: 'click', args: args('e31'), holdMs: 0 })).toEqual({ ok: true, sig: PAY.sig })
  })

  it('one yes, one step: a waiter on the tab the ask moved from gets nothing, and two waiters never both get it', async () => {
    const first = await askOutward({ owner, tab: 7, action: 'click', args: args('e12'), hold: PAY, requester })
    const id = String(first.request)
    const oldTab = answerOutward({ id, owner, tab: 7, action: 'click', args: args('e12'), holdMs: 2_000 })
    await askOutward({ owner, tab: 9, action: 'click', args: args('e31'), hold: PAY, requester })
    const newTab = answerOutward({ id, owner, tab: 9, action: 'click', args: args('e31'), holdMs: 2_000 })
    const twin = answerOutward({ id, owner, tab: 9, action: 'click', args: args('e31'), holdMs: 2_000 })
    await tap(id, (await getApproval(id))!.digest)
    const settled = await Promise.allSettled([oldTab, newTab, twin])
    const through = settled.filter((s) => s.status === 'fulfilled' && (s.value as { ok: boolean }).ok)
    expect(through).toHaveLength(1)
    expect(settled.filter((s) => s.status === 'rejected').map((s) => ((s as PromiseRejectedResult).reason as { code?: string }).code)).toEqual(['no_such_request', 'no_such_request'])
  })

  it('another page (another invoice) is another ask; a yes nobody took within TAKE_MS is not spent later', async () => {
    const first = await askOutward({ owner, tab: 7, action: 'click', args: args('e12'), hold: PAY, requester })
    const other = await askOutward({ owner, tab: 8, action: 'click', args: args('e12'), hold: { ...PAY, url: 'https://pay.example.test/bill?invoice=2' }, requester })
    expect(other.request).not.toBe(first.request)
    const id = String(first.request)
    await tap(id, (await getApproval(id))!.digest)
    at(TAKE_MS + MIN)
    expect(await answerOutward({ id, owner, tab: 7, action: 'click', args: args('e12'), holdMs: 0 })).toMatchObject({ ok: false, status: 409 })
  })

  it('a no stays a no: the same step asked again finds the denied ask, never a new one', async () => {
    const first = await askOutward({ owner, tab: 7, action: 'click', args: args('e12'), hold: PAY, requester })
    const id = String(first.request)
    await tap(id, (await getApproval(id))!.digest, 'deny')
    const again = await askOutward({ owner, tab: 7, action: 'click', args: args('e12'), hold: PAY, requester })
    expect(again.request).toBe(id)
    expect(await answerOutward({ id, owner, tab: 7, action: 'click', args: args('e12'), holdMs: 0 })).toMatchObject({ ok: false, status: 403 })
  })

  it('a new sign-in and an upload: the same ask after 11 minutes', async () => {
    const scope = { owner, device: 'mac', tab: 7, site: 'pay.example.test' }
    const s1 = await askFreshSignIn({ ...scope, theirs: [{ id: 3 }], requester })
    expect(s1).toMatchObject({ untilBack: true })
    at(11 * MIN)
    expect((await askFreshSignIn({ ...scope, theirs: [{ id: 3 }], requester })).request).toBe(s1.request)
    const u1 = await askUpload({ taskId: 't-bill', paths: ['/Users/someone/bill.pdf'], site: 'pay.example.test', requester })
    expect(u1.end.untilBack).toBe(true)
    at(11 * MIN)
    expect(await askUpload({ taskId: 't-bill', paths: ['/Users/someone/bill.pdf'], site: 'pay.example.test', requester })).toMatchObject({ id: u1.id, reused: true })
  })
})

// ── guards: the class, enumerated from the source ──

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) srcFiles(p, out)
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/')
/** Comments out (a comment may name createApproval or untilBack without being code): whole comment lines, and a trailing ` // ...`. */
const code = (text: string) => text.split('\n').map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l.replace(/\s\/\/\s.*$/, ''))).join('\n')
/** The argument text of the call whose "(" is at `open`. */
function argsAt(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i)
  }
  return text.slice(open + 1)
}

/** Creators that never make an ask an agent waits on, and why. */
const EXEMPT: Record<string, string> = {
  'src/core/approvals/ask-me.ts': 'records a step that went ahead unasked (approvals off): nobody is asked, nothing waits',
  'src/web/routes/test-host-fixture.ts': 'the fixture server\'s own dialogs for browser tests, never an agent\'s ask',
}

describe('approval-until-back-guard: every creator of an ask says whether it waits until the person answers', () => {
  const calls: Array<{ file: string; line: number; args: string }> = []
  for (const f of srcFiles(path.join(ROOT, 'src'))) {
    const text = code(fs.readFileSync(f, 'utf8'))
    if (!/createApproval/.test(text)) continue
    // Its own name, and any name it is imported as (`{ createApproval: create } = await import(...)`, `import { createApproval as make }`).
    const names = new Set(['createApproval'])
    for (const m of text.matchAll(/\{[^}]*\bcreateApproval:\s*([A-Za-z_$][\w$]*)\s*[,}][^}]*\}?\s*=\s*await\s+import\(/g)) names.add(m[1])
    for (const m of text.matchAll(/\bcreateApproval\s+as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
    for (const name of names) {
      // `store.createApproval(` is a call; an alias is called bare (never `Object.create(`).
      const re = name === 'createApproval'
        ? /(?<![\w$])(?<!function\s)createApproval\s*\(/g
        : new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\(`, 'g')
      for (const m of text.matchAll(re)) {
        const open = m.index! + m[0].length - 1
        calls.push({ file: rel(f), line: text.slice(0, m.index).split('\n').length, args: argsAt(text, open) })
      }
    }
  }

  it('finds the creators (a guard that finds none guards nothing)', () => {
    const files = new Set(calls.map((c) => c.file))
    for (const f of ['src/core/browser-control/outward-asks.ts', 'src/core/vault/agent.ts', 'src/web/routes/approvals-v1.ts', 'src/web/routes/vault-agent-v1.ts']) expect(files, f).toContain(f)
  })

  it('each call names untilBack, or its file is exempt with a reason', () => {
    const missing = calls.filter((c) => !EXEMPT[c.file] && !/\buntilBack\b/.test(c.args)).map((c) => `${c.file}:${c.line}`)
    expect(missing, 'An ask an agent waits on must say untilBack (store.ts CreateInput); one that never waits goes in EXEMPT with why').toEqual([])
    for (const f of Object.keys(EXEMPT)) expect(calls.some((c) => c.file === f), `${f} no longer creates approvals: drop it from EXEMPT`).toBe(true)
  })

  it('the locked-note ask passes it through its own creator', () => {
    const text = fs.readFileSync(path.join(ROOT, 'src/core/notes/locked-note-ask.ts'), 'utf8')
    expect(argsAt(text, text.indexOf('deps.askPerson(') + 'deps.askPerson'.length)).toMatch(/\buntilBack:\s*true\b/)
  })
})

/** Files that keep asks with no approval behind them, and why their own clock stands. */
const OWN_CLOCK: Record<string, string> = {
  'src/core/browser-control/sign-in-ask.ts': 'not an approval: the person signs in with their own hands on the task\'s Browser view card, and the agent\'s call holds for it',
}

describe('approval-until-back-guard: no map of asks forgets one on a fixed clock while its approval is open', () => {
  // A map kept by an asker that prunes "asked longer ago than its ask's old clock" drops an ask its
  // approval still holds open: the agent's next call finds nothing and asks the person a second time.
  const CLOCK = String.raw`[A-Z_]*(?:ASK|PENDING|TIMEOUT|WAIT)[A-Z_]*\b|\d[\d_]*\s*\*\s*60_?000\b`
  const FIXED = [
    // now - a.at > ASK_MS
    new RegExp(String.raw`(?:\bnow\b|Date\.now\(\))\s*-\s*[\w.]+\.(?:at|askedAt|createdAt)\s*[<>]=?\s*\(?\s*(?:\d+\s*\*\s*)?(?:${CLOCK})`),
    // now > a.at + ASK_MS
    new RegExp(String.raw`(?:\bnow\b|Date\.now\(\))\s*[<>]=?\s*[\w.]+\.(?:at|askedAt|createdAt)\s*\+\s*(?:\d+\s*\*\s*)?(?:${CLOCK})`),
  ]
  it('every file that asks the person, or keeps asks across a restart, reads its asks\' ends from the approval', () => {
    const offenders: string[] = []
    let scanned = 0
    for (const f of srcFiles(path.join(ROOT, 'src'))) {
      const text = code(fs.readFileSync(f, 'utf8'))
      if (!/createApproval|agentUse\(|deps\.askPerson\(|\bkeptMap\s*[<(]/.test(text) || OWN_CLOCK[rel(f)]) continue
      scanned++
      text.split('\n').forEach((l, i) => { if (FIXED.some((re) => re.test(l))) offenders.push(`${rel(f)}:${i + 1}: ${l.trim()}`) })
    }
    expect(scanned).toBeGreaterThanOrEqual(8)
    expect(offenders, 'prune an ask by its approval\'s end (types.ts askEndOf), or put the file in OWN_CLOCK with why').toEqual([])
  })

  it('the fixed-clock patterns still catch the old forms', () => {
    for (const l of ['for (const [id, a] of asks) if (now - a.at > ASK_MS) asks.delete(id)', 'if (Date.now() - a.at < ASK_MS) return', 'if (now > p.at + PENDING_MS) x()', 'if (now - a.at > 10 * 60_000) y()']) {
      expect(FIXED.some((re) => re.test(l)), l).toBe(true)
    }
  })
})
