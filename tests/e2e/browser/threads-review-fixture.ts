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
    const rounds = i === 0 ? REVIEW_ROUNDS : [`What does point ${i + 1} protect?`]
    rounds.forEach((q, r) => {
      const answer = i === 0 && r === 1
        ? `Two cases:\n\n- **Before the seal**: the page is dropped.\n- **After the seal**: the index keeps the old copy.\n\n${filler(400 + r, 30)}`
        : i === 0 && r === 2
          ? `The guard is one line:\n\n\`\`\`ts\n${REVIEW_ROUND_CODE}\n\`\`\`\n\nAn older copy never wins.`
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
