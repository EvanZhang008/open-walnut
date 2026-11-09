/**
 * The review fixture session: one long reply with many asked passages (the
 * fullscreen review sidebar), and one question asked over three rounds whose
 * answers carry markdown and code (the card's chat display).
 */
import { filler, fxUuid, type FixtureAnchor, type FixtureMeta, type FixtureRow, type ThreadsFixtureSession } from './threads-fixture'

export const REVIEW_SESSION = 'pw-threads-review-session'
export const REVIEW_TASK = 'pw-task-threads-review'
export const REVIEW_READY = 'Anything else to watch for?'
export const REVIEW_COUNT = 22

const SUBJECTS = ['flush worker', 'index writer', 'compactor', 'reader', 'checksum pass', 'slot table', 'retry loop', 'snapshot',
  'page cache', 'version map', 'log rotator', 'buffer pool', 'merge step', 'lock table', 'warm start', 'scrubber',
  'tail reader', 'quota check', 'gap finder', 'trim pass', 'seal step', 'audit hook']
/** One distinct sentence per asked passage of the long reply. */
export function reviewPassage(i: number): string {
  return `Point ${i + 1}: the ${SUBJECTS[i % SUBJECTS.length]} settles before the next stage reads it.`
}
export const REVIEW_TITLES = Array.from({ length: REVIEW_COUNT }, (_, i) => `Point ${i + 1} order`)
/** The question answered over three rounds (the first passage). */
export const REVIEW_ROUNDS = [
  'Why does the flush worker settle first?',
  'And what if it crashes halfway?',
  'Show me the guard in code.',
] as const
export const REVIEW_ROUND_CODE = 'if (page.version <= index.versionOf(page.slot)) return'

export function buildReviewSession(nowMs: number): ThreadsFixtureSession & { ids: { reply: string; heads: string[] } } {
  const P = '0199fa'
  const at = (k: number) => new Date(nowMs - 1_700_000 + k * 1000).toISOString()
  const rows: FixtureRow[] = []
  let n = 0
  const turn = (q: string, a: string) => {
    n += 1
    const u = fxUuid(P, n, 'u')
    const aId = fxUuid(P, n, 'a')
    rows.push({ role: 'user', uuid: u, text: q }, { role: 'assistant', uuid: aId, text: a })
    return { u, a: aId }
  }
  const paras = Array.from({ length: REVIEW_COUNT }, (_, i) => `${reviewPassage(i)} ${filler(300 + i, 84).replace(/\n\n/g, ' ')}`)
  const root = turn('Give me the full design review of the storage path.', paras.join('\n\n'))
  const anchors: FixtureAnchor[] = []
  const heads: string[] = []
  const meta: FixtureMeta[] = []
  for (let i = 0; i < REVIEW_COUNT; i++) {
    const passage = reviewPassage(i)
    // Point 2's question runs past one line, so its review bubble is clamped.
    const rounds = i === 0 ? REVIEW_ROUNDS
      : i === 1 ? [`What does point 2 protect when the reader and the writer both hold the same slot at once?`]
      : [`What does point ${i + 1} protect?`]
    rounds.forEach((q, r) => {
      const answer = i === 0 && r === 1
        ? `Two cases:\n\n- **Before the seal**: the page is dropped.\n- **After the seal**: the index keeps the old copy.\n\n${filler(400 + r, 30)}`
        : i === 0 && r === 2
          ? `The guard is one line:\n\n\`\`\`ts\n${REVIEW_ROUND_CODE}\n\`\`\`\n\nAn older copy never wins.`
          // A table: the card grows wide when it opens (review sidebar spec).
          : i === 6
            ? `[Q${i + 1}]\nThe order:\n\n| Step | Holds |\n|---|---|\n| Seal | the slot |\n| Flush | the page |\n\n${filler(500 + i * 3 + r, 50)}`
            // Live replies start with their question's tag line (question-tag.ts).
            : `[Q${i + 1}]\n${filler(500 + i * 3 + r, 50)}`
      const t = turn(r === 0 ? `> ${passage}\n\n${q}` : q, answer)
      if (r === 0) heads.push(t.u)
      anchors.push({ msgId: t.u, parent: root.a, quote: { exact: passage }, source: r === 0 ? 'selection' : 'sticky', at: at(n) })
    })
    meta.push({ headId: heads[i], status: 'open', title: REVIEW_TITLES[i], titleSource: 'ai', titleState: 'done', seq: i + 1, updatedAt: at(200) })
  }
  turn(REVIEW_READY, filler(600, 120))
  return {
    sessionId: REVIEW_SESSION, taskId: REVIEW_TASK, title: 'Threads review fixture session',
    rows, threadAnchors: anchors, threadMeta: meta, pinnedMessages: [], parked: [], ids: { reply: root.a, heads },
  }
}

/**
 * Asks only on the first turn, then twelve more turns, so that turn opens behind
 * "Load earlier turns" (2026-10-31, the user: the folded bar showed "1" for an ask
 * above the loaded turns).
 */
export const REVIEW_OLD_SESSION = 'pw-threads-askold-session'
export const REVIEW_OLD_TASK = 'pw-task-threads-askold'
export const REVIEW_OLD_READY = 'Last check before we close this out?'
export const REVIEW_OLD_PASSAGES = ['The old seal step runs before the flush.', 'The old trim pass never reads a sealed page.'] as const

export function buildReviewOldSession(nowMs: number): ThreadsFixtureSession {
  const P = '0199fb'
  const at = (k: number) => new Date(nowMs - 1_600_000 + k * 1000).toISOString()
  const rows: FixtureRow[] = []
  let n = 0
  const turn = (q: string, a: string) => {
    n += 1
    const u = fxUuid(P, n, 'u')
    const aId = fxUuid(P, n, 'a')
    rows.push({ role: 'user', uuid: u, text: q }, { role: 'assistant', uuid: aId, text: a })
    return { u, a: aId }
  }
  const root = turn('Walk me through the old storage path.', REVIEW_OLD_PASSAGES.map((p, i) => `${p} ${filler(700 + i, 60).replace(/\n\n/g, ' ')}`).join('\n\n'))
  const anchors: FixtureAnchor[] = []
  const meta: FixtureMeta[] = []
  REVIEW_OLD_PASSAGES.forEach((passage, i) => {
    const t = turn(`> ${passage}\n\nWhy does that hold?`, `[Q${i + 1}]\n${filler(720 + i, 40)}`)
    anchors.push({ msgId: t.u, parent: root.a, quote: { exact: passage }, source: 'selection', at: at(n) })
    meta.push({ headId: t.u, status: 'open', title: `Old point ${i + 1}`, titleSource: 'ai', titleState: 'done', seq: i + 1, updatedAt: at(100) })
  })
  for (let k = 0; k < 12; k++) turn(`Next step ${k + 1}?`, filler(740 + k, 30))
  turn(REVIEW_OLD_READY, filler(790, 40))
  return {
    sessionId: REVIEW_OLD_SESSION, taskId: REVIEW_OLD_TASK, title: 'Threads review old-asks fixture session',
    rows, threadAnchors: anchors, threadMeta: meta, pinnedMessages: [], parked: [],
  }
}

export const REVIEW_MIXED_SESSION = 'pw-threads-askmixed-session'
export const REVIEW_MIXED_TASK = 'pw-task-threads-askmixed'
export const REVIEW_MIXED_READY = 'Anything else before the release?'
export const REVIEW_MIXED_PASSAGES = ['The mixed seal step runs before the flush.', 'The mixed trim pass never reads a sealed page.', 'The fresh index keeps one row per slot.'] as const

/**
 * Two asks on an early answer, a dozen turns, then one ask on a recent answer:
 * on open only the recent one is in the rendered window (2026-11-09: full
 * screen showed 1 of 4 cards after a reload, the rest only after "Load earlier
 * turns").
 */
export function buildReviewMixedSession(nowMs: number): ThreadsFixtureSession {
  const P = '0199fc'
  const at = (k: number) => new Date(nowMs - 1_500_000 + k * 1000).toISOString()
  const rows: FixtureRow[] = []
  let n = 0
  const turn = (q: string, a: string) => {
    n += 1
    const u = fxUuid(P, n, 'u')
    const aId = fxUuid(P, n, 'a')
    rows.push({ role: 'user', uuid: u, text: q }, { role: 'assistant', uuid: aId, text: a })
    return { u, a: aId }
  }
  const anchors: FixtureAnchor[] = []
  const meta: FixtureMeta[] = []
  const ask = (parent: string, passage: string, seq: number) => {
    const t = turn(`> ${passage}\n\nWhy does that hold?`, `[Q${seq}]\n${filler(820 + seq, 40)}`)
    anchors.push({ msgId: t.u, parent, quote: { exact: passage }, source: 'selection', at: at(n) })
    meta.push({ headId: t.u, status: 'open', title: `Mixed point ${seq}`, titleSource: 'ai', titleState: 'done', seq, updatedAt: at(100) })
  }
  const early = turn('Walk me through the mixed storage path.', REVIEW_MIXED_PASSAGES.slice(0, 2).map((p, i) => `${p} ${filler(800 + i, 60).replace(/\n\n/g, ' ')}`).join('\n\n'))
  ask(early.a, REVIEW_MIXED_PASSAGES[0], 1)
  ask(early.a, REVIEW_MIXED_PASSAGES[1], 2)
  for (let k = 0; k < 12; k++) turn(`Mixed step ${k + 1}?`, filler(840 + k, 30))
  const recent = turn('And the index?', `${REVIEW_MIXED_PASSAGES[2]} ${filler(870, 60).replace(/\n\n/g, ' ')}`)
  ask(recent.a, REVIEW_MIXED_PASSAGES[2], 3)
  turn(REVIEW_MIXED_READY, filler(890, 40))
  return {
    sessionId: REVIEW_MIXED_SESSION, taskId: REVIEW_MIXED_TASK, title: 'Threads review mixed-asks fixture session',
    rows, threadAnchors: anchors, threadMeta: meta, pinnedMessages: [], parked: [],
  }
}
