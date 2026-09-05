/**
 * The calendar helper's error type, on its own so importing it costs nothing.
 *
 * It lives apart from `sources/eventkit.ts` because the calendar plugin THROWS this class
 * (a disabled source, a service that is not adopted) while never needing the helper client.
 * Importing it from eventkit.ts as a value pulled that whole module, and `helper-build.js`
 * behind it (Swift compile + codesign), into the plugin's bundle as a second copy.
 *
 * Classification across that seam is still name-based (`calendarErrorCode` in
 * src/integrations/calendar/api.ts): a builtin plugin is its own bundle, so the class object
 * it holds is not the one the host holds and `instanceof` cannot be trusted between them.
 */

/** Thrown for helper-reported failures so routes can map codes → HTTP. */
export class CalendarHelperError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'CalendarHelperError';
  }
}
