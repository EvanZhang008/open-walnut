// CalendarBridge — `Walnut --calendar-bridge <subcommand> …` answers one EventKit
// request and exits, so the Calendars permission belongs to Walnut itself.
//
// Why the app and not a separate helper: every helper generation is its own
// program to macOS, and each version bump asked for Calendars again (the cache
// holds walnut-calendar-v2 … v6). Walnut.app is one certificate-signed identity
// that survives rebuilds, and it is the name the user already knows. The helper
// stays only for installs with no Walnut.app (see
// src/core/calendar/sources/eventkit.ts).
//
// The protocol is src/data/walnut-calendar.swift, compiled into this module with
// -D WALNUT_APP so there is exactly one implementation. It re-execs with
// responsibility disclaimed, so the grant is Walnut's whether the server was
// started by this app or from a terminal.

let calendarBridgeFlag = "--calendar-bridge"

/// Dispatched FIRST in main.swift, before NSApplication exists, like the session
/// host: a calendar request must never become a window or a Dock icon. Returns
/// immediately on a normal launch.
func runCalendarBridgeIfRequested(_ commandLine: [String] = CommandLine.arguments) {
    guard commandLine.count >= 2, commandLine[1] == calendarBridgeFlag else { return }
    // argv-shaped for the shared entry point: program, then the subcommand.
    walnutCalendarMain([commandLine[0]] + commandLine.dropFirst(2))
}
