import { useMemo, useState } from 'react'
import type { TimeBlock } from './api'
import { clockLabel, formatDuration, hourLabel, taskColor, type AxisRange } from './time-timeline'
import { buildChapters, composition, type Chapter, type CompSegment } from './time-chapters'
import { CHAPTER_ZOOM_PX_PER_MIN, chapterHeightPx } from './time-views'
import { Ribbon } from './tape'

/**
 * View B — work chapters.
 *
 * The narrative view: the day is cut at idle gaps over ten minutes, and each
 * stretch becomes one card. Sixty slices become six cards, which is the difference
 * between data and a story you can actually retell.
 *
 * A FLOW, not an absolute axis, and that is deliberate. A card holds four lines of
 * text and cannot shrink to its true 4-minute height, and clicking one expands it
 * inline; both of those force everything below to move. Absolute positioning would
 * either clip the text or silently detach the cards from the hour ruler. The printed
 * clock range on every card is what carries the "when", and card HEIGHT still tracks
 * span so a long stretch looks long.
 *
 * The title is the honest part: a chapter whose top task held less than 40% is NOT
 * named after it (see time-chapters.ts).
 */

/**
 * Copy follows the approved mockup, which the user wrote in their own language; the
 * numbers carry the meaning either way and the strings are trivially swappable.
 */
const IDLE_MARKER = (ms: number) => `— 空闲 ${formatDuration(ms)} —`
const FRAGMENTED_TITLE = '碎片工作(切换频繁)'

export function TimeChapters({ slices, axis, minuteOf, nowMin, labelFor }: {
  /** The serial ribbon, ascending. Chapters are meaningless on merged blocks. */
  slices: TimeBlock[]
  axis: AxisRange
  minuteOf: (iso: string) => number
  nowMin: number | null
  labelFor: (taskId: string) => string
}) {
  const [openKey, setOpenKey] = useState<string | null>(null)
  const chapters = useMemo(() => buildChapters(slices), [slices])

  if (chapters.length === 0) {
    return <p className="wt-empty" data-testid="time-app-chapters-empty">Nothing to chapter on this day.</p>
  }

  return (
    <div className="wt-tc" data-testid="time-app-chapters">
      {chapters.map((ch, i) => {
        // Only when it changes: the same "3 PM" printed twice reads as a mistake.
        const hour = Math.floor(minuteOf(ch.startTs) / 60)
        const prevHour = i > 0 ? Math.floor(minuteOf(chapters[i - 1]!.startTs) / 60) : -1
        return (
          <div key={ch.key}>
            {ch.idleBeforeMs > 0 && (
              <p className="wt-tc-idle" data-testid="time-app-chapters-idle">{IDLE_MARKER(ch.idleBeforeMs)}</p>
            )}
            <div className="wt-tc-row">
              <span className="wt-tc-hour">{hour === prevHour ? '' : hourLabel(hour)}</span>
              <ChapterCard
                chapter={ch}
                open={openKey === ch.key}
                minuteOf={minuteOf}
                nowMin={nowMin}
                labelFor={labelFor}
                axis={axis}
                onToggle={() => setOpenKey((prev) => (prev === ch.key ? null : ch.key))}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ChapterCard({ chapter, open, minuteOf, nowMin, labelFor, axis, onToggle }: {
  chapter: Chapter
  open: boolean
  minuteOf: (iso: string) => number
  nowMin: number | null
  labelFor: (taskId: string) => string
  axis: AxisRange
  onToggle: () => void
}) {
  const segments = useMemo(() => composition(chapter), [chapter])
  const from = clockLabel(minuteOf(chapter.startTs))
  const to = clockLabel(minuteOf(chapter.endTs))
  const dominant = chapter.dominant
  const title = chapter.fragmented || !dominant ? FRAGMENTED_TITLE : labelFor(dominant.taskId)
  // Collapsed height tracks the span; an open card is as tall as its content needs.
  const style = open ? undefined : { minHeight: chapterHeightPx(chapter.spanMs) }

  return (
    <section className={`wt-tc-card${open ? ' is-open' : ''}`} data-testid="time-app-chapters-card" style={style}>
      <button className="wt-tc-head" onClick={onToggle} aria-expanded={open}>
        <span className="wt-tc-when">{from} – {to} · {formatDuration(chapter.spanMs)}</span>
        <span className="wt-tc-what">
          {chapter.fragmented || !dominant
            ? <i className="wt-tc-glyph" aria-hidden>⇄</i>
            : <i className="wt-tc-dot" style={{ background: taskColor(dominant.taskId) }} />}
          <span className="wt-tc-title" title={title}>{title}</span>
          {chapter.focused && <em className="wt-tc-tag">focused</em>}
        </span>
        <span className="wt-tc-comp" data-testid="time-app-chapters-comp">
          {segments.map((seg, i) => (
            <i
              key={seg.taskId ?? `rest-${i}`}
              style={{
                width: `${seg.pct}%`,
                background: seg.taskId === null ? 'var(--wt-rest)' : taskColor(seg.taskId),
              }}
              title={compTitle(seg, labelFor)}
            />
          ))}
        </span>
        <span className="wt-tc-parts">{summaryLine(segments, labelFor)}</span>
      </button>

      {open && (
        // The same ribbon as view A, zoomed, over just this chapter's own axis.
        <div className="wt-tc-detail" data-testid="time-app-chapters-detail">
          <Ribbon
            slices={chapter.slices as TimeBlock[]}
            axis={chapterAxis(chapter, minuteOf, axis)}
            minuteOf={minuteOf}
            nowMin={nowMin}
            labelFor={labelFor}
            hoverTaskId={null}
            onHover={() => { /* the chapter card owns hover; the ribbon is read-only here */ }}
            pxPerMin={CHAPTER_ZOOM_PX_PER_MIN}
            testId="time-app-chapters-ribbon"
          />
        </div>
      )}
    </section>
  )
}

/**
 * A chapter's own window, in minutes-of-day. Not the day axis: at the expanded zoom
 * the day would be thousands of pixels tall and the chapter a sliver of it.
 */
function chapterAxis(chapter: Chapter, minuteOf: (iso: string) => number, day: AxisRange): AxisRange {
  const startMin = minuteOf(chapter.startTs)
  const endMin = Math.max(minuteOf(chapter.endTs), startMin + 1)
  // Hour rules only where they actually fall inside the chapter.
  const hours = day.hours.filter((h) => h * 60 > startMin && h * 60 < endMin)
  return { startMin, endMin, hours }
}

function compTitle(seg: CompSegment, labelFor: (taskId: string) => string): string {
  const name = seg.taskId === null ? restLabel(seg) : labelFor(seg.taskId)
  return `${name} · ${formatDuration(seg.ms)}`
}

/** 快碰 (quick touches) only when they really were all quick; otherwise 其他. */
function restLabel(seg: CompSegment): string {
  const n = seg.count ?? 0
  return seg.allQuick ? `快碰 ${n} 项` : `其他 ${n} 项`
}

/** "Manager Letter 40m · Focus System 5m · 快碰 7 项 7m" */
function summaryLine(segments: CompSegment[], labelFor: (taskId: string) => string): string {
  return segments
    .map((seg) => (seg.taskId === null
      ? `${restLabel(seg)} ${formatDuration(seg.ms)}`
      : `${labelFor(seg.taskId)} ${formatDuration(seg.ms)}`))
    .join(' · ')
}
