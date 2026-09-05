/**
 * The Calendar plugin's public surface: what another plugin imports to build on it.
 *
 * Everything a consumer needs lives here and nowhere else, because a capability's type
 * travels as an `import type` from the publisher's own file, never through the kernel
 * package. The kernel does not know what a calendar is, and it must not learn.
 *
 * `CalendarServiceApi` is the method bag shape for a `calendar:service` publish. It is
 * declared now, ahead of a consumer, so a later plugin that wants calendar reads has a
 * frozen contract to compile against rather than a shape invented on the day.
 */
export type * from './types.js'

import type {
  CalendarEvent,
  CalendarEventCreate,
  CalendarEventPatch,
  CalendarInfo,
  CalendarSourceStatus,
} from './types.js'

/** The reads and writes the calendar offers other plugins. Same semantics as the routes. */
export interface CalendarServiceApi {
  status(): CalendarSourceStatus
  listCalendars(): Promise<CalendarInfo[]>
  getEvents(from: string, to: string, opts?: { force?: boolean }): Promise<CalendarEvent[]>
  createEvent(input: CalendarEventCreate): Promise<CalendarEvent>
  updateEvent(id: string, patch: CalendarEventPatch): Promise<CalendarEvent>
  deleteEvent(id: string): Promise<void>
  refreshAll(): Promise<void>
}

/**
 * The helper-error code behind an unknown throw, or undefined when it is not one.
 *
 * Matched by `name`, NOT by `instanceof`, and that is load-bearing: tsup emits every
 * builtin plugin as its own bundle with no code splitting, so the plugin's copy of
 * `CalendarHelperError` is a different class object from the one the host's EventKit
 * source throws. An `instanceof` check across that boundary is false in a built install
 * and true under vitest, which is the worst possible failure shape: every 404/409/403
 * would silently become a 500 in production only.
 */
export function calendarErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== 'CalendarHelperError') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
