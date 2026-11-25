/**
 * The leader's own clocks and event writers of the home's leader data, stoppable as one (a leader switch's stop).
 *
 * A leader switch's final batch (core/leader/switch/final-stop.ts) repeats until one pass of the home finds nothing
 * changed, inside the commit window. A writer that keeps firing during it, on its own timer or on a link's events,
 * makes the next pass find a change again, and the switch rolls back at the window's end with nobody leading for
 * minutes. Found by review (2026-11-25): the delivery retry (session-message-queue.json, every 60 s), the session
 * requests sweep (session-requests.json, every 60 s), the PR watch (tasks/, every 30 s while CI runs) and the
 * offline journal's handover (a link event) all wrote on during the stop: started by `void import(...).then(start)`
 * with their handle thrown away, so stopServer never stopped them.
 *
 * Each such writer asks `homeWritesStopped()` at the top of its tick or event handler (a gate, so a clock whose
 * handle was thrown away is covered as well as one that was kept). web/server.ts stopWritersForSwitch calls
 * `stopLeaderClocks()` at the switch stop's start; a process that stops for a switch exits after it, so nothing
 * here is ever undone in production. The source ratchet (tests/core/leader/switch/switch-stop-writers-ratchet.test.ts)
 * finds every timer from the source, wherever it is started, and fails on one that writes leader data and neither
 * asks the gate nor is stopped by stopServer.
 *
 * A leaf module (no imports): any writer may ask without pulling the switch's code in.
 */

let stopped = false

/** The switch stop's start: every gated clock tick and event write of leader data finds the home stopped. */
export function stopLeaderClocks(): void {
  stopped = true
}

/** True once a switch stop began: a clock tick or an event of leader data writes nothing more. */
export function homeWritesStopped(): boolean {
  return stopped
}

/** A server's start (web/server.ts startServer, beside endGitQuiet): one in a process that ran a stop writes again. */
export function resumeLeaderClocks(): void {
  stopped = false
}
