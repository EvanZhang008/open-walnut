/**
 * The unified day timeline: the shapes every SOURCE hands in and the merge reads.
 *
 * A source is anything that knows where the user's time went for part of a day:
 * Walnut's own attention lease, the Mac foreground sampler, Apple Health (sleep,
 * workouts), Places (iPhone visits), the calendar, or a plugin (a fitness app, a
 * car). Core registers its sources; a plugin adds one with
 * `walnut.registry.timelineSource(...)`. Core never imports plugin code: a source
 * is just this contract.
 */

/** `activity` segments compete for the same minutes (the merge picks one); `place` segments say WHERE. */
export type TimelineLane = 'activity' | 'place'

/**
 * How a segment is known: `measured` (a sensor or a lease saw it), `planned` (a
 * calendar said it would happen), `inferred` (worked out from gaps, e.g. travel
 * between two places). Every report must say which it is.
 */
export type TimelineConfidence = 'measured' | 'planned' | 'inferred'

export interface TimelineRange {
  /** First local date, YYYY-MM-DD. */
  from: string
  /** Last local date, inclusive. */
  to: string
  /** [startMs, endMs): local midnight of `from` to local midnight after `to`. */
  startMs: number
  endMs: number
  /** This machine's time zone (every day key in time tracking is local to it). */
  tz: string
}

export interface TimelineSegmentInput {
  /** ISO-8601 instant, or epoch ms. */
  start: string | number
  end: string | number
  /**
   * What the time was: core uses `walnut`, `app`, `meeting`, `plan`, `workout`,
   * `sleep`, `nap` (activity) and `place`, `travel` (place lane). A plugin may use
   * its own word (e.g. `drive`); it is shown as given.
   */
  kind: string
  /** A few words a person reads: the task title, the app, "Pickleball", "Home". */
  label: string
  confidence: TimelineConfidence
  /** Overrides the source's lane for this one segment. */
  lane?: TimelineLane
  /** Small structured facts (ids, a category). Never raw samples or coordinates. */
  detail?: Record<string, string | number | boolean | null>
  /** Short warnings a report must repeat ("the watch may have been left running"). */
  flags?: string[]
}

/** What a source could see in the range. `available: false` means its segments are absent, not zero. */
export interface TimelineCoverage {
  available: boolean
  /** Why not available, or what is partial ("recording began 2026-10-09"). */
  note?: string
}

export interface TimelineSourceResult {
  segments: TimelineSegmentInput[]
  coverage?: TimelineCoverage
}

export interface TimelineSourceSpec {
  /** Stable id, e.g. `health`. A plugin's id is prefixed with the plugin id by the host. */
  id: string
  label: string
  lane: TimelineLane
  /**
   * Higher wins when two activity segments cover the same minute. Core: walnut 100,
   * Mac apps 90, sleep 70, workouts 60, calendar 50. A plugin source defaults to 40
   * and is capped at 80, so a plugin can never outrank what the Mac measured.
   */
  priority?: number
  segments(range: TimelineRange): Promise<TimelineSourceResult>
}

/** A segment after the registry stamped its source (and the merge clipped it). */
export interface SourcedSegment {
  startMs: number
  endMs: number
  kind: string
  label: string
  confidence: TimelineConfidence
  lane: TimelineLane
  source: string
  priority: number
  detail?: Record<string, string | number | boolean | null>
  flags?: string[]
}
