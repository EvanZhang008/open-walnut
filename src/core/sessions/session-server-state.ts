/**
 * Whether new Claude Code sessions start through the SDK session server right
 * now. The session runner registers the probe when it gets a client; the
 * answer is the client's live connection, not `session_server.enabled`: a
 * configured server that never connected leaves every start on the CLI path
 * (2026-10-25: a config-based check made every model change on such a setup
 * replay its conversation instead of forking it).
 *
 * A module of its own, so a reader (transfer.ts) needs no import of the runner.
 */
let probe: (() => boolean) | null = null;

export function registerSessionServerProbe(next: (() => boolean) | null): void {
  probe = next;
}

export function startsThroughSessionServer(): boolean {
  try { return probe?.() === true; } catch { return false; }
}
