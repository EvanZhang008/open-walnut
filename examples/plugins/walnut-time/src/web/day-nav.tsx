import type { ReactNode } from 'react'
import { dayLabel, shiftDate } from './time-timeline'

/**
 * `‹ Sat, Aug 23 ›` plus a Today reset — the ONE day switcher, shared by the Overview
 * and the Timeline.
 *
 * It was the Timeline's, and the Overview asked for the same gesture. Copying it would
 * have given the app two nav bars that drift apart (one disabled arrow behaving
 * differently from the other is exactly the kind of thing nobody notices for months),
 * so it moved here instead and both tabs mount it.
 *
 * BOUNDS: the arrows stop at the days the shell actually fetched. A day outside that
 * window has no summary to agree with, so stepping onto it would show an empty day
 * with no explanation for why it is empty.
 *
 * Test ids are passed in, not derived: the two tabs are separately addressable, and a
 * spec should not have to know how a prefix is glued to a suffix.
 */

export interface DayNavTestIds {
  prev: string
  next: string
  date: string
  today: string
}

export function DayNav({ date, today, oldest, newest, label, testIds, onDate, children }: {
  date: string
  today: string
  /** First and last fetched day, inclusive. */
  oldest: string
  newest: string
  /** Overrides the day label (the week scope shows a range). */
  label?: string
  testIds: DayNavTestIds
  onDate: (date: string) => void
  /** Controls that belong beside the nav (the Timeline's view switcher). */
  children?: ReactNode
}) {
  const isToday = date === today
  return (
    <div className="wt-tt-nav">
      <button
        type="button"
        className="wt-tt-nav-btn"
        data-testid={testIds.prev}
        aria-label="Previous day"
        disabled={date <= oldest}
        onClick={() => onDate(shiftDate(date, -1))}
      >
        ‹
      </button>
      <span className="wt-tt-nav-date" data-testid={testIds.date}>
        {label ?? dayLabel(date)}
        {isToday && <em className="wt-tt-nav-today">today</em>}
      </span>
      <button
        type="button"
        className="wt-tt-nav-btn"
        data-testid={testIds.next}
        aria-label="Next day"
        disabled={date >= newest}
        onClick={() => onDate(shiftDate(date, 1))}
      >
        ›
      </button>
      <button
        type="button"
        className="wt-tt-nav-reset"
        data-testid={testIds.today}
        disabled={isToday}
        onClick={() => onDate(today)}
      >
        Today
      </button>
      {children}
    </div>
  )
}
