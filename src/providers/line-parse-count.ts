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

export function _resetLineParseCountForTesting(): void {
  counts.clear()
}
