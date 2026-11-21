/**
 * A task never shrinks the scope the user set on its own, and silence is not a yes (2026-11-21,
 * the org reflection, passed on by the Walnut VP). A task decided by itself to skip phases 2 to 4
 * of a four-phase move the user had set, wrote one line ("say so if you still want the whole
 * move"), and carried on. Three compactions then wrote "not doing it" into the summary as a fact,
 * and the next day it reported the work "done and live", admitting only in its third paragraph
 * that phases 2 to 4 were never done.
 *
 * Three halves, one per step of that failure:
 *   - SCOPE_KEPT_RULE (a charter bullet, team-charter.ts, so Main, every lead and every worker get
 *     it): a cut is the user's decision, asked in needs; no answer means the whole plan goes on; a
 *     compaction's summary keeps the User Request verbatim and marks the agent's own cuts as its own.
 *   - The charter's done line: what is left goes in not_done, each part by name, never only in text.
 *   - userRequestReadback: after every compaction Walnut reads the note's User Request back word for
 *     word (open-items.ts), so a summary that narrowed it never stands alone.
 *     A host's offline formatter (offline-host-core.ts), used while the Mac is away, leaves it out:
 *     the system prompt's rule still holds there, and the next compaction with the Mac reads it back.
 * tests/core/scope-kept-ratchet.test.ts keeps every reader.
 */
import { parseNoteSections } from './note-sections.js'

export const SCOPE_KEPT_RULE = 'Doing less than the user asked (a phase, part or platform of what they set) is their decision, '
  + 'never yours, however reasonable and even if it could be done later (the self-check below never decides it): ask it in needs '
  + '(user_kind user_own) with your pick, or as a subtask ask your lead, who puts it to them and never decides it; keep doing '
  + 'every part you can meanwhile; no answer is not a yes. A compaction\'s summary copies your note\'s User Request word for '
  + 'word and writes each cut you made yourself as your own call they have not agreed to, never as the goal or a fact.'

/** The sentence of the charter's done line that the ratchet holds. */
export const NOT_DONE_BY_NAME = 'anything not done goes in not_done, each phase or part left by name, never only in the text of your report.'

/** Phrases every reader must keep (the ratchet reads them). */
export const SCOPE_KEPT_MARKS = ['is their decision, never yours', 'no answer is not a yes', 'User Request word for word', 'your own call'] as const

/** Most the readback takes of the compaction hook; less when the hook's head leaves less room (open-items.ts). */
export const REQUEST_READBACK_MAX = 2_400
/** Room the hook keeps after the readback for the rest it restates (open items, hints, memory). */
export const REQUEST_READBACK_RESERVE = 1_500
/** Below this much room the readback is only a pointer to task_get. */
const REQUEST_READBACK_MIN = 400

export const REQUEST_READBACK_HEAD = 'What this task was set to do, read back after the compaction. Where the summary above says less '
  + '(a phase, part or platform dropped), that cut was your own call and the user has not agreed to it unless their own words '
  + 'did: keep doing every part you can, or ask them.'
const REQUEST_LABEL = 'Your note\'s User Request (your restatement of what they set):'
const FIRST_LABEL = 'The words the task was created with:'
const POINTER = '(Cut here: task_get reads the whole note and description.)'

type RequestSource = { note?: unknown; description?: unknown; phase?: string }
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * The after-compaction readback of what the task was set to do: its note's User Request verbatim,
 * and the words it was created with (its description's first paragraph) when they differ, so a
 * restatement the agent narrowed never stands alone. '' for a done task or one with neither.
 * Within `room` characters: past it, cut at a line end with a pointer. Pure.
 */
export function userRequestReadback(task: RequestSource, room = REQUEST_READBACK_MAX): string {
  if (task.phase === 'COMPLETE') return ''
  const request = (parseNoteSections(str(task.note)).sections['User Request'] ?? '').trim()
  const first = (str(task.description).split(/\n\s*\n/)[0] ?? '').trim()
  const parts = [request ? `${REQUEST_LABEL}\n${request}` : '', first && first !== request ? `${FIRST_LABEL}\n${first}` : ''].filter(Boolean)
  if (!parts.length) return ''
  const max = Math.min(room, REQUEST_READBACK_MAX)
  const text = `${REQUEST_READBACK_HEAD}\n${parts.join('\n')}`
  if (text.length <= max) return text
  if (max < REQUEST_READBACK_MIN) return `${REQUEST_READBACK_HEAD} ${POINTER}`
  const room2 = max - POINTER.length - 1
  const end = text.lastIndexOf('\n', room2)
  return `${text.slice(0, end > room2 / 2 ? end : room2).trimEnd()}\n${POINTER}`
}
