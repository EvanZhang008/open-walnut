/**
 * Transcript rewind PROBE core — the rewind machinery's host-local half.
 *
 * Rewind asks three questions of a session's JSONL, and every one of them used
 * to be answered by shuttling the WHOLE file over the SSH tunnel through
 * DaemonFileReader (which refuses anything past its byte ceiling, so a long
 * transcript made rewind fail outright and made a rewound session's history
 * render UNFILTERED):
 *
 *   1. is this uuid on the chain the CLI would load?  (`--resume-session-at`
 *      exits 1 otherwise)              → computeCliLoadedChain
 *   2. what is the LAST tree line right now, and which enqueues trail it?
 *      (the cut a commit records)      → commitAnchorOf
 *   3. which lines are dead for display?
 *      (recorded cuts replayed)        → computeRewindDeadSet
 *
 * All three are pure functions of the parsed lines, so they belong next to the
 * file: this module runs INSIDE the daemon (`transcript.rewindProbe`) and only
 * the small answer crosses the tunnel. See AGENTS.md "Design Principle:
 * host-local work belongs to the DAEMON". Precedent + shape: session-changes-
 * core.ts (`changes.compute`).
 *
 * Dependency-lean on purpose (node builtins + transcript-chain.ts + the path
 * resolver from session-changes-core.ts, no logging) so bun can bundle it into
 * the binary twin AND ship it as the `transcript-rewind-core.cjs` sidecar the
 * source twin require()s. The server keeps the same functions for its fallback
 * path, so both sides answer identically.
 *
 * Never refuses on size: the entire point is that the daemon can read what the
 * tunnel cannot. The file is streamed LINE BY LINE and each line is reduced to
 * the handful of fields the walk reads, so a very large transcript does not
 * become an equally large heap of retained strings.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import {
  TRANSCRIPT_TREE_TYPES,
  computeCliLoadedChain,
  computeRewindDeadSet,
  queueEnqueueKey,
  type TranscriptChainLine,
  type SkippedRewindCut,
} from '../core/transcript-chain.js';
import { resolveJsonlPathHostLocal } from './session-changes-core.js';

/** A recorded in-place rewind cut, as it rides the wire (see InPlaceRewindCut). */
export interface RewindProbeCut {
  uuid: string;
  lastUuidAtCommit: string;
  trailingQueueKeys?: string[];
}

export interface RewindProbeInput {
  sessionId: string;
  /** Session cwd when known — resolves the canonical JSONL path directly. */
  cwd?: string;
  /** Claude home (the daemon passes `$HOME/.claude`; tests pass a temp dir). */
  claudeHome: string;
  /** Rewind point to validate against the chain the CLI would load. */
  uuid?: string;
  /** Recorded cuts to replay for display filtering. */
  cuts?: RewindProbeCut[];
  /** Test seam: lower the dead-set cap (default DEFAULT_MAX_DEAD_UUIDS). Not
   *  sent over the wire — the daemon always uses the default. */
  maxDeadUuids?: number;
}

export interface RewindProbeOutput {
  jsonlPath: string;
  mtimeMs: number;
  size: number;
  /** Non-empty lines read (corrupt ones included — they exist in the file). */
  lineCount: number;
  /** The leaf `--resume` would load from, or null when there is no tree line. */
  leafUuid: string | null;
  /** Only when `input.uuid` was given: is it on the CLI-loaded chain? */
  onChain?: boolean;
  /** Uuid of the LAST tree line in file order (null = no tree lines at all). */
  lastUuidAtCommit: string | null;
  /** Identity keys of the queue enqueues sitting PAST that last tree line. */
  trailingQueueKeys: string[];
  /** Only when `input.cuts` was given: the dead tree-line uuids ([] = none). */
  deadUuids?: string[];
  /** Only when `input.cuts` was given: the dead queue identity keys. */
  queueDeadKeys?: string[];
  /** Only when `input.cuts` was given: cuts the replay refused to apply. */
  skippedCuts?: SkippedRewindCut[];
  /** The dead set blew past the cap, so nothing is reported — the caller serves
   *  UNFILTERED and says so. Cheap insurance against a rewind-to-line-1 on a
   *  very large transcript producing a multi-MB reply frame. */
  truncated?: boolean;
}

/** Above this many dead uuids the probe reports `truncated` instead. */
export const DEFAULT_MAX_DEAD_UUIDS = 200_000;

/**
 * The cut anchor as a rewind COMMIT sees it: the last tree line in the file
 * right now, plus the identity keys of any queue enqueues that trail it (uuid-
 * less lines sit outside every uuid-anchored region, so they must be captured
 * on the cut record or a rewound-away queued message re-renders forever).
 *
 * ONE implementation, shared by the daemon probe and the server's fallback read
 * — the two must agree on what "end of file" means or a cut records an anchor
 * the reader can't reproduce.
 */
export function commitAnchorOf(
  lines: readonly TranscriptChainLine[],
): { lastUuidAtCommit: string | null; trailingQueueKeys: string[] } {
  let lastUuidAtCommit: string | null = null;
  let lastTreeIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l && typeof l.uuid === 'string' && typeof l.type === 'string'
      && TRANSCRIPT_TREE_TYPES.has(l.type)) {
      lastUuidAtCommit = l.uuid;
      lastTreeIdx = i;
      break;
    }
  }
  const trailingQueueKeys: string[] = [];
  if (lastTreeIdx >= 0) {
    for (let i = lastTreeIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l && l.type === 'queue-operation' && l.operation === 'enqueue') {
        trailingQueueKeys.push(queueEnqueueKey(l));
      }
    }
  }
  return { lastUuidAtCommit, trailingQueueKeys };
}

/**
 * Reduce one parsed JSONL line to the fields the chain machinery reads.
 *
 * A transcript line carries the full message payload; the walk needs topology.
 * Keeping only these fields is what lets the daemon hold a very large file's
 * structure in memory at all. `message.content` is kept as a list of block
 * TYPES for user lines only — computeCliLoadedChain's DAG recovery detects a
 * tool_result user line that way, and dropping it would make the probe disagree
 * with the server's fallback parse on parallel-tool transcripts.
 */
function slimTranscriptLine(raw: Record<string, unknown>): TranscriptChainLine {
  const line: TranscriptChainLine = {};
  if (typeof raw.type === 'string') line.type = raw.type;
  if (typeof raw.subtype === 'string') line.subtype = raw.subtype;
  if (typeof raw.uuid === 'string') line.uuid = raw.uuid;
  if (typeof raw.parentUuid === 'string') line.parentUuid = raw.parentUuid;
  else if (raw.parentUuid === null) line.parentUuid = null;
  if (raw.isSidechain === true) line.isSidechain = true;
  if (typeof raw.timestamp === 'string') line.timestamp = raw.timestamp;
  if (typeof raw.operation === 'string') line.operation = raw.operation;
  // Top-level `content` is only read for queue-operation lines (their identity key).
  if (line.type === 'queue-operation' && typeof raw.content === 'string') {
    line.content = raw.content;
  }
  const meta = raw.compactMetadata as { preservedSegment?: Record<string, unknown> } | undefined;
  const seg = meta && typeof meta === 'object' ? meta.preservedSegment : undefined;
  if (seg && typeof seg === 'object') {
    line.compactMetadata = {
      preservedSegment: {
        ...(typeof seg.headUuid === 'string' ? { headUuid: seg.headUuid } : {}),
        ...(typeof seg.anchorUuid === 'string' ? { anchorUuid: seg.anchorUuid } : {}),
        ...(typeof seg.tailUuid === 'string' ? { tailUuid: seg.tailUuid } : {}),
      },
    };
  }
  const message = raw.message as { id?: unknown; content?: unknown } | undefined;
  if (message && typeof message === 'object') {
    const id = typeof message.id === 'string' ? message.id : undefined;
    const blocks = line.type === 'user' && Array.isArray(message.content)
      ? (message.content as Array<Record<string, unknown>>)
        .map((b) => ({ type: typeof b?.type === 'string' ? b.type : '' }))
      : undefined;
    if (id !== undefined || blocks !== undefined) {
      line.message = {
        ...(id !== undefined ? { id } : {}),
        ...(blocks !== undefined ? { content: blocks } : {}),
      };
    }
  }
  return line;
}

/** Stream the JSONL and return its slimmed lines in file order. */
async function readSlimTranscript(
  jsonlPath: string,
): Promise<{ lines: TranscriptChainLine[]; lineCount: number }> {
  const lines: TranscriptChainLine[] = [];
  let lineCount = 0;
  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const text of rl) {
      if (!text) continue;
      lineCount++;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue; // partial/corrupt line — not a transcript line
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      lines.push(slimTranscriptLine(parsed as Record<string, unknown>));
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { lines, lineCount };
}

/**
 * Answer every rewind question about ONE session's transcript, host-local.
 * Returns null when the JSONL can't be found (the caller decides: fall back to
 * its own read, or report "not found").
 */
export async function probeTranscriptRewindHostLocal(
  input: RewindProbeInput,
): Promise<RewindProbeOutput | null> {
  const jsonlPath = await resolveJsonlPathHostLocal(input.sessionId, input.cwd, input.claudeHome);
  if (!jsonlPath) return null;
  let st: fs.Stats;
  try {
    st = await fsp.stat(jsonlPath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  const { lines, lineCount } = await readSlimTranscript(jsonlPath);
  const anchor = commitAnchorOf(lines);
  const loaded = computeCliLoadedChain(lines);

  const out: RewindProbeOutput = {
    jsonlPath,
    mtimeMs: st.mtimeMs,
    size: st.size,
    lineCount,
    leafUuid: loaded.leafUuid,
    lastUuidAtCommit: anchor.lastUuidAtCommit,
    trailingQueueKeys: anchor.trailingQueueKeys,
  };
  if (input.uuid) out.onChain = loaded.chainUuids.has(input.uuid);

  if (input.cuts) {
    const deadSet = computeRewindDeadSet(lines, input.cuts);
    const cap = input.maxDeadUuids ?? DEFAULT_MAX_DEAD_UUIDS;
    const dead = deadSet.deadUuids ? [...deadSet.deadUuids] : [];
    if (dead.length > cap) {
      out.truncated = true;
      out.deadUuids = [];
      out.queueDeadKeys = [];
    } else {
      out.deadUuids = dead;
      out.queueDeadKeys = [...deadSet.queueDeadKeys];
    }
    out.skippedCuts = deadSet.skippedCuts;
  }
  return out;
}
