/**
 * How many lines of each session this server parsed itself: the output lines its daemon handed
 * over as text (remote-session-manager.ts parsedJsonlLine), and the transcript lines a read of a
 * session on another host parsed here (history, plan, search text, rows of a tool result: the
 * readers of core/sessions/host-history-reads.ts, counted through inTranscriptReadOf). A session
 * its host runs and judges is parsed on its host only: on the leader its count stays 0
 * (tests/providers/host-judged-runner.test.ts, tests/e2e/host-judged-history-cluster-e2e.test.ts).
 * Bounded: it forgets everything past MAX sessions.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** Per session: CLI output lines (`stream`) and transcript lines a read parsed (`transcript`). */
const counts = new Map<string, { stream: number; transcript: number }>()
const MAX = 5_000

function add(sid: string, kind: 'stream' | 'transcript', lines: number): void {
  if (lines <= 0) return
  if (counts.size >= MAX && !counts.has(sid)) counts.clear()
  const c = counts.get(sid) ?? { stream: 0, transcript: 0 }
  c[kind] += lines
  counts.set(sid, c)
}

/** One output line of `sid` its daemon handed over as text, parsed here. */
export function noteLineParsed(sid: string): void {
  add(sid, 'stream', 1)
}

/** Every line of `sid` parsed here, both kinds: 0 for a session its host runs and judges. */
export function lineParsesOf(sid: string): number {
  const c = counts.get(sid)
  return c ? c.stream + c.transcript : 0
}

/** The two kinds apart. */
export function lineParsesByKindOf(sid: string): { streamLines: number; transcriptLines: number } {
  const c = counts.get(sid)
  return { streamLines: c?.stream ?? 0, transcriptLines: c?.transcript ?? 0 }
}

/** Every session counted so far, most parsed first (GET /api/diagnostics/line-parses): `lines` is both kinds. */
export function lineParsesAll(): Array<{ sessionId: string; lines: number; streamLines: number; transcriptLines: number }> {
  return [...counts].map(([sessionId, c]) => ({ sessionId, lines: c.stream + c.transcript, streamLines: c.stream, transcriptLines: c.transcript }))
    .sort((a, b) => b.lines - a.lines)
}

/** The session whose transcript the read running now parses here (one read's async scope). */
const transcriptRead = new AsyncLocalStorage<string>()

/** Run a read of `sid`'s transcript here: every transcript line its parsers take counts for `sid`. */
export function inTranscriptReadOf<T>(sid: string, read: () => T): T {
  return transcriptRead.run(sid, read)
}

/** A transcript parser took `lines` lines (history-parse.ts, the plan and journal folds): counted for the read's session, if any. */
export function noteTranscriptLinesParsed(lines: number): void {
  const sid = transcriptRead.getStore()
  if (sid) add(sid, 'transcript', lines)
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
