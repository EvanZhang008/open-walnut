/**
 * The async half of meeting attendance (meetings.ts is the pure half): the call
 * history and coverage around a range, the series that were never on a call, the
 * user's own answers, and the meetings they asked to leave out.
 *
 * Answers live on this Mac only: WALNUT_HOME/time-tracking/outside/meeting-answers.json
 * (outside/ is not synced), keyed by the calendar occurrence id, with no title.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../../constants.js'
import { mergeSpans } from '../calls.js'
import { readCalls } from '../calls-store.js'
import { localDateKey } from '../rollup.js'
import { seriesIdOf, seriesNeverOnCall, type MeetingContext, type SeriesOccurrence } from './meetings.js'
import type { TimelineRange, TimelineSourceResult } from './types.js'

/** How far back a series is looked at for "never on a call". */
export const SERIES_LOOKBACK_DAYS = 28
const MAX_ANSWERS = 2_000
const MAX_IGNORE = 50

function answersFile(): string {
  return path.join(WALNUT_HOME, 'time-tracking', 'outside', 'meeting-answers.json')
}

interface AnswerFile { answers: Record<string, { attended: boolean; at: string }> }

async function readAnswerFile(): Promise<AnswerFile> {
  try {
    const raw = JSON.parse(await fsp.readFile(answersFile(), 'utf8')) as Partial<AnswerFile>
    return { answers: raw.answers && typeof raw.answers === 'object' ? raw.answers : {} }
  } catch {
    return { answers: {} }
  }
}

export async function readMeetingAnswers(): Promise<Map<string, boolean>> {
  const file = await readAnswerFile()
  const out = new Map<string, boolean>()
  for (const [id, a] of Object.entries(file.answers)) if (typeof a?.attended === 'boolean') out.set(id, a.attended)
  return out
}

let writing: Promise<unknown> = Promise.resolve()

/** Record (true/false) or clear (null) the user's answer for one occurrence. */
export function setMeetingAnswer(eventId: string, attended: boolean | null, now = new Date()): Promise<{ eventId: string; attended: boolean | null; answers: number }> {
  const run = writing.then(async () => {
    const file = await readAnswerFile()
    if (attended === null) delete file.answers[eventId]
    else file.answers[eventId] = { attended, at: now.toISOString() }
    // Oldest first out, so the file stays small forever.
    const entries = Object.entries(file.answers).sort((a, b) => a[1].at.localeCompare(b[1].at)).slice(-MAX_ANSWERS)
    const next: AnswerFile = { answers: Object.fromEntries(entries) }
    await fsp.mkdir(path.dirname(answersFile()), { recursive: true })
    const tmp = `${answersFile()}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(next), 'utf8')
    await fsp.rename(tmp, answersFile())
    return { eventId, attended, answers: entries.length }
  })
  writing = run.catch(() => undefined)
  return run
}

/** The ignore list from the config, lower-cased. */
export function ignoreList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((p): p is string => typeof p === 'string' && !!p.trim()).slice(0, MAX_IGNORE).map((p) => p.trim().toLowerCase().slice(0, 120))
}

/**
 * Build the context for a range. `calendar` reads planned segments for a range
 * (the timeline's calendar bridge); its recurring meetings are the series.
 */
export async function loadMeetingContext(
  range: TimelineRange,
  calendar: (r: TimelineRange) => Promise<TimelineSourceResult>,
  ignore: readonly string[],
): Promise<MeetingContext> {
  const lookFromMs = range.startMs - SERIES_LOOKBACK_DAYS * 86_400_000
  const [{ calls, sessions, coverage }, answers] = await Promise.all([readCalls(lookFromMs, range.endMs), readMeetingAnswers()])
  const callSpans = mergeSpans(calls.map((c) => [c.startMs, c.endMs] as [number, number]))
  let occurrences: SeriesOccurrence[] = []
  if (coverage.length) {
    const fromMs = Math.max(lookFromMs, coverage[0]![0])
    const history = await calendar({ ...range, from: localDateKey(new Date(fromMs)), startMs: fromMs }).catch(() => ({ segments: [] }))
    occurrences = history.segments.flatMap((s) => {
      const d = s.detail ?? {}
      const a = typeof s.start === 'number' ? s.start : Date.parse(s.start)
      const b = typeof s.end === 'number' ? s.end : Date.parse(s.end)
      return s.kind === 'meeting' && d.recurring === true && typeof d.seriesId === 'string' && Number.isFinite(a) && Number.isFinite(b)
        ? [{ seriesId: d.seriesId, startMs: a, endMs: b }] : []
    })
  }
  const attendedSeries = new Set([...answers].filter(([, yes]) => yes).map(([id]) => seriesIdOf(id)))
  return {
    calls: callSpans,
    sessions: sessions.map((c) => [c.startMs, c.endMs] as [number, number]),
    coverage,
    neverOnCall: seriesNeverOnCall(occurrences, callSpans, coverage, attendedSeries),
    answers,
    ignore,
  }
}
