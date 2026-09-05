/**
 * Compatibility forwarder: the calendar plugin's `plugin:calendar:updated` re-emitted under
 * the legacy `calendar:updated` name.
 *
 * The plugin announces through `walnut.events.emit`, which namespaces every plugin event.
 * Every existing subscriber (web/src/stores/calendar-events-store.ts and
 * web/src/hooks/useCalendarEvents.ts, plus the route tests) listens for `calendar:updated`.
 *
 * DELETE THIS once those two web files subscribe to `plugin:calendar:updated` directly, and
 * note the second half of that migration: the WS forwarder is gated on the DESTINATION, not
 * on an interest filter, so while this shim exists every calendar change ships BOTH names to
 * every open tab. Two frames per refresh is cheap but real, and removing the shim is what
 * ends it, so the two changes belong in the same commit.
 */
import { bus, EventNames } from './event-bus.js'

const SUBSCRIBER = 'calendar-events-shim'
const PLUGIN_EVENT = 'plugin:calendar:updated'

export function installCalendarEventForwarder(): void {
  // `subscribe` keys by name, so a second startServer in the same process replaces this
  // rather than stacking a duplicate forwarder.
  bus.subscribe(SUBSCRIBER, (event) => {
    if (event.name !== PLUGIN_EVENT) return
    // NOT marked as a re-emit: global subscribers skip re-emitted events, and every
    // consumer of `calendar:updated` (the web-ui relay included) is global.
    bus.emit(EventNames.CALENDAR_UPDATED, event.data as never, ['web-ui'], { source: 'calendar' })
  }, { global: true, interest: [PLUGIN_EVENT] })
}

export function removeCalendarEventForwarder(): void {
  bus.unsubscribe(SUBSCRIBER)
}
