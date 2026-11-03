/**
 * The outline sections fixtures (session-outline-sections.spec.ts): two long
 * conversations of ten main-conversation messages each, under the server's
 * thread AI stub prefix so the stub names their sections (each title is the
 * message's first three words, title-cased).
 *  - pw-threads-ai-sections-session: no question, one quote pin on a reply, so
 *    the outline shows the sections mixed with the pin.
 *  - pw-threads-ai-sections-map-session: one question about the second reply,
 *    so the question map is shown and the sections are its `10 sections` group.
 * All text is invented, neutral filler.
 */
import { filler, fxUuid, type FixtureRow, type ThreadsFixtureSession } from './threads-fixture'

export const SECTIONS_SESSION = 'pw-threads-ai-sections-session'
export const SECTIONS_TASK = 'pw-task-threads-sections'
export const SECTIONS_MAP_SESSION = 'pw-threads-ai-sections-map-session'
export const SECTIONS_MAP_TASK = 'pw-task-threads-sections-map'

export const SECTION_MESSAGES = [
  'Explain the eviction order of the page cache',
  'Sketch the retry budget for the flush worker',
  'Rename the loader module and its callers',
  'Profile the slow history route on startup',
  'Write unit tests for the version map',
  'Document the checksum format in the design note',
  'Split the session store into two files',
  'Review the guard in the deploy script',
  'Measure the cold start time after the split',
  'Remove the unused feature flag everywhere',
] as const

/** What the stub names a message (src/core/sessions/thread-ai-stub.ts). */
export function stubSectionTitle(text: string): string {
  return text.split(/\s+/).slice(0, 3).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
}

export const SECTIONS_PIN_PASSAGE = 'The flush worker keeps a budget of five retries per minute.'
export const SECTIONS_MAP_PASSAGE = 'Each retry waits twice as long as the one before it.'
export const SECTIONS_MAP_QUESTION_TITLE = 'Backoff doubling'

interface Built extends ThreadsFixtureSession { ids: { user: string[]; reply: string[]; question?: string } }

function build(prefix: string, sessionId: string, taskId: string, title: string, withQuestion: boolean, nowMs: number): Built {
  const rows: FixtureRow[] = []
  const user: string[] = []
  const reply: string[] = []
  let question: string | undefined
  SECTION_MESSAGES.forEach((text, i) => {
    const u = fxUuid(prefix, i + 1, 'u')
    const a = fxUuid(prefix, i + 1, 'a')
    user.push(u)
    reply.push(a)
    const passage = i === 1 ? (withQuestion ? SECTIONS_MAP_PASSAGE : SECTIONS_PIN_PASSAGE) : ''
    rows.push({ role: 'user', uuid: u, text }, { role: 'assistant', uuid: a, text: `${filler(700 + i, 120)}${passage ? `\n\n${passage} ${filler(720 + i, 40)}` : ''}` })
    if (withQuestion && i === 1) {
      question = fxUuid(prefix, 40, 'u')
      rows.push(
        { role: 'user', uuid: question, text: `> ${SECTIONS_MAP_PASSAGE}\n\nWhy does each retry wait twice as long?` },
        { role: 'assistant', uuid: fxUuid(prefix, 40, 'a'), text: `[Q1]\nDoubling spreads the retries out. ${filler(760, 40)}` },
      )
    }
  })
  const at = new Date(nowMs - 1_800_000).toISOString()
  return {
    sessionId, taskId, title, rows, parked: [],
    ids: { user, reply, ...(question ? { question } : {}) },
    pinnedMessages: withQuestion ? [] : [{
      msgId: reply[1], label: SECTIONS_PIN_PASSAGE, role: 'assistant', pinnedAt: at, id: 'pw-sections-pin-1',
      quote: { exact: SECTIONS_PIN_PASSAGE },
    }],
    threadAnchors: question ? [{ msgId: question, parent: reply[1], quote: { exact: SECTIONS_MAP_PASSAGE }, source: 'selection', at }] : [],
    threadMeta: question ? [{
      headId: question, status: 'open', title: SECTIONS_MAP_QUESTION_TITLE, titleSource: 'ai', titleState: 'done',
      question: 'Why does each retry wait twice as long?', seq: 1, updatedAt: at,
    }] : [],
  }
}

export function buildSectionsSession(nowMs: number): Built {
  return build('5ec7a1', SECTIONS_SESSION, SECTIONS_TASK, 'Threads sections fixture session', false, nowMs)
}

export function buildSectionsMapSession(nowMs: number): Built {
  return build('5ec7a2', SECTIONS_MAP_SESSION, SECTIONS_MAP_TASK, 'Threads sections map fixture session', true, nowMs)
}
