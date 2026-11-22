/**
 * The calendar plugin's one CalendarService instance (re-exported by service.ts).
 */
import { CalendarHelperError } from '../../core/calendar/helper-error.js';
import { CalendarService } from './service.js';
import type { CalendarSource } from './types.js';

// ── the plugin's one instance ────────────────────────────────────────────────
//
// A module-level slot, not a field on the activation closure, for two reasons: the routes
// and tools resolve it PER CALL (a test may swap the instance between requests while the
// server stays up), and the fixture seam below has to be able to put an instance in place
// before the plugin activates so activate never builds one over the real EventKit helper.

let service: CalendarService | null = null;

/**
 * activate's entry: adopt whatever is already in the slot, else build one over the host's
 * source. `createSource` is a factory, not a value, so the EventKit helper is never
 * constructed when a fixture already supplied a mock.
 */
export function adoptCalendarService(createSource: () => CalendarSource): CalendarService {
  if (!service) service = new CalendarService(createSource());
  return service;
}

/**
 * The live instance, resolved per request and per tool call.
 *
 * A helper error rather than a plain throw: a request already in flight when the plugin is
 * torn down (the Disposable runs before the route registrations are withdrawn) then answers
 * 503 "not configured" like any other unavailable source, instead of a bare 500.
 */
export function getCalendarService(): CalendarService {
  if (!service) throw new CalendarHelperError('the calendar plugin is not active', 'not-configured');
  return service;
}

/**
 * deactivate's exit: stop the loop and clear the slot, so a reload builds a fresh service
 * and re-runs init() instead of adopting one whose timer is already stopped.
 *
 * Consequence worth knowing before you test a reload: the fresh service is built over the
 * HOST's real EventKit source, so a fixture that injected a mock before boot has to inject
 * again after a reload or the next read compiles the Swift helper and reads real calendars.
 */
export function releaseCalendarService(instance: CalendarService): void {
  instance.stop();
  if (service === instance) service = null;
}

/** Test hook: swap in a service over a mock source, before or after activate. */
export function _setCalendarServiceForTest(s: CalendarService | null): void {
  if (service !== s) service?.stop();
  service = s;
}
