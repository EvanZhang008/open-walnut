/**
 * One subject pattern costs microseconds on most subjects and about 16 ms at worst, near the
 * matcher's state cap (src/lib/linear-regex), so rules times rows add up: the labeler's 30 rows
 * against 20 rules, 5 of them near the cap, took 320 ms (2026-11-04), and a 500-row batch of a
 * rules file of slow ones is seconds. The scans that classify whole mailboxes (the background
 * re-sort, the rule preview), the labeler's batch and the engine's other many-row re-sorts give the
 * event loop back every SLICE_MS inside a batch, not only between batches (`mapSliced`). Here a row
 * costs 2 ms to classify and a batch holds 150 rows (300 ms of work); a ticker on the loop measures
 * the longest the loop was held. A ratchet lists every place that classifies, with how it gives the
 * loop back, so a new many-row loop has to say. One row is never split: it costs its rules times
 * their cost.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { MailSortEngine } from '../../src/integrations/mail/sort-engine.js'
import { previewMany } from '../../src/integrations/mail/sort-preview.js'
import { MailSortRecompute, SLICE_MS, mapSliced } from '../../src/integrations/mail/sort-recompute.js'
import { basisOf, type ScanRow } from '../../src/integrations/mail/sort-store.js'
import type { MailStore } from '../../src/integrations/mail/store.js'

const ROWS: ScanRow[] = Array.from({ length: 150 }, (_, k) => ({
  rowid: k + 1, account_id: 'imap:marina', mailbox_id: 'INBOX', message_id: `INBOX:${k}`, subject: `Subject ${k}`, sent_at: 1_700_000_000_000 + k,
}) as unknown as ScanRow)
const ROW_MS = 2
/** Well under the 300 ms one batch takes unsliced, and well over a slice plus a row on a busy box. */
const HOLD_LIMIT_MS = SLICE_MS + 60

function busy(ms: number): void {
  const end = performance.now() + ms
  while (performance.now() < end) { /* the cost of a slow rule set */ }
}

/** The longest the loop went without running a setImmediate callback while `work` ran. */
async function longestHold(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now()
  let longest = 0
  let running = true
  const tick = (): void => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
    if (running) setImmediate(tick)
  }
  setImmediate(tick)
  await work()
  running = false
  return longest
}

describe('mail sort scans yield inside a batch', () => {
  it('the background re-sort holds the loop at most a slice, and still sorts every row once', async () => {
    const sorted: number[] = []
    const runner = new MailSortRecompute({
      store: {
        countPending: async () => ROWS.length,
        pendingRows: async (_rev, after, limit) => ROWS.filter((row) => row.rowid > after).slice(0, limit),
        applyVerdicts: async (verdicts) => { sorted.push(...verdicts.map((one) => one.rowid)); return { changes: verdicts.length, stale: [] } },
      },
      verdictOf: (row) => { busy(ROW_MS); return { rowid: row.rowid, group: 'important', reason: 'test', rev: 'rev-s', senderKey: 'k', label: 'Important', basis: basisOf(row) } },
    })
    const held = await longestHold(() => runner.start('rev-s'))
    expect(sorted).toEqual(ROWS.map((row) => row.rowid))
    expect(held).toBeLessThan(HOLD_LIMIT_MS)
  })

  it('the rule preview holds the loop at most a slice, counts every row, and stops at its deadline mid-batch', async () => {
    const sort = {
      compiledRules: () => [],
      idForLabel: () => 'notifications',
      features: (row: ScanRow) => { busy(ROW_MS); return { subject: row.subject, fromAddr: '', fromName: 'Dana Pier', listId: '', addressedToMe: 'unknown' } },
      classifyWith: () => ({ group: 'important', reason: 'default' }),
    } as unknown as MailSortEngine
    const store = { sort: { scanScope: async (_pairs: unknown, after: number, limit: number) => ROWS.filter((row) => row.rowid > after).slice(0, limit) } } as unknown as MailStore
    const pairs = [{ accountId: 'imap:marina', mailboxId: 'INBOX' }]
    let answer: Awaited<ReturnType<typeof previewMany>> = []
    const held = await longestHold(async () => { answer = await previewMany({ sort, store }, pairs, [{ when: { subject: 'subject' }, then: 'Updates' }]) })
    expect(answer[0]).toMatchObject({ matches: ROWS.length })
    expect(answer[0]!.partial).toBeUndefined()
    expect(held).toBeLessThan(HOLD_LIMIT_MS)

    // A deadline already passed: the scan stops at its first slice, with `partial`.
    const [cut] = await previewMany({ sort, store }, pairs, [{ when: { subject: 'subject' }, then: 'Updates' }], { budgetMs: 0 })
    expect(cut!.partial).toBe(true)
    expect(cut!.matches).toBeGreaterThan(0)
    expect(cut!.matches).toBeLessThan(ROWS.length)
  })
})

describe('every place that classifies gives the loop back', () => {
  const MAIL = path.resolve(import.meta.dirname, '../../src/integrations/mail')
  const NAMES = new Set(['classify', 'classifyWith', 'verdictOf', 'decides'])
  // Site (file: trimmed line) -> [how many, why it cannot hold the loop for long].
  const KNOWN: Record<string, [number, string]> = {
    'sort-engine.ts: verdictOf: (row) => this.verdictOf(row),': [1, 'the background re-sort, sliced (sort-recompute.ts)'],
    'sort-engine.ts: return classify(features, rules)': [1, 'classifyWith: one row; its many-row caller (preview) is sliced'],
    'sort-engine.ts: base: classify(features, this.compiled),': [2, 'one row: verdictOf itself, and an ingest write, which awaits its database write before the next'],
    'sort-engine.ts: const base = classify(features, this.compiled)': [1, "the labeler's decides(), one row; its caller (sort-ai.ts) is sliced"],
    'sort-engine.ts: const verdicts = await mapSliced(pending, (row) => this.verdictOf(row))': [1, 'sortRows (resort and reclassify), sliced'],
    'sort-ai.ts: const decided = await mapSliced(rows, (row) => context.decides(row))': [1, "the labeler's batch of AI_BATCH (30) rows, sliced"],
    'sort-preview.ts: const before = sort.classifyWith(features, current)': [1, 'the preview scan, sliced'],
    'sort-preview.ts: const afterResult = sort.classifyWith(features, plan.rules)': [1, 'the preview scan, sliced'],
    'sort-recompute.ts: verdicts.push(this.deps.verdictOf(row))': [1, 'the background re-sort, sliced'],
  }

  it('lists each one with its reason', () => {
    const found = new Map<string, number>()
    for (const name of readdirSync(MAIL).filter((one) => one.endsWith('.ts') && !one.endsWith('.d.ts'))) {
      const text = readFileSync(path.join(MAIL, name), 'utf8')
      const lines = text.split('\n')
      const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression
          const called = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
          if (NAMES.has(called)) {
            const key = `${name}: ${lines[file.getLineAndCharacterOfPosition(node.getStart(file)).line]!.trim()}`
            found.set(key, (found.get(key) ?? 0) + 1)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(Object.entries(KNOWN).map(([key, [count]]) => [key, count])))
  })

  it('mapSliced keeps order and holds the loop at most a slice', async () => {
    let out: number[] = []
    const held = await longestHold(async () => { out = await mapSliced(ROWS, (row) => { busy(ROW_MS); return row.rowid }) })
    expect(out).toEqual(ROWS.map((row) => row.rowid))
    expect(held).toBeLessThan(HOLD_LIMIT_MS)
  })
})
