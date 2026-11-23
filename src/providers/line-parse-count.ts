/**
 * How many output lines of each session this server parsed itself (the JSON.parse of a line its
 * daemon handed over as text; remote-session-manager.ts parsedJsonlLine). A session its host runs
 * and judges is parsed on its host only: on the leader its count stays 0
 * (tests/providers/host-judged-runner.test.ts). Bounded: it forgets everything past MAX sessions.
 */
const counts = new Map<string, number>()
const MAX = 5_000

export function noteLineParsed(sid: string): void {
  if (counts.size >= MAX && !counts.has(sid)) counts.clear()
  counts.set(sid, (counts.get(sid) ?? 0) + 1)
}

export function lineParsesOf(sid: string): number {
  return counts.get(sid) ?? 0
}

/**
 * The other JSON parses on this server's side of a session's output, counted whole (not per
 * session): each frame its daemon links bring (daemon-connection.ts handleMessage: one per remote
 * line when this server runs the session, one per stream piece when a host's channel rides a
 * stream), and each session-channel frame (leader-side.ts: one per facts batch or merged flow, not
 * per line). A bench reads them to say how many parses a CLI line costs here
 * (scripts/bench-host-judged-sessions.mts).
 */
const frames = { daemon: 0, channel: 0 }

export function noteFrameParsed(kind: 'daemon' | 'channel'): void {
  frames[kind]++
}

export function frameParses(): { daemon: number; channel: number } {
  return { ...frames }
}

export function _resetLineParseCountForTesting(): void {
  counts.clear()
  frames.daemon = 0
  frames.channel = 0
}
