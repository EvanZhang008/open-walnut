/**
 * Fixture builder for the transcript machinery tests (src/core/transcript-chain.ts).
 *
 * Both functions under test are keyed ENTIRELY on uuid/parentUuid topology and
 * file order, so a fixture that only carries uuids (what the pre-port offset
 * tests used) exercises nothing. This builder auto-threads every new tree line
 * onto the previous one and can hang a second branch off any named uuid via
 * `from()` — exactly the shape an in-place rewind writes: `--resume <sid>
 * --resume-session-at <uuid>` with no `--fork-session` appends the new branch to
 * the SAME file, parented at the rewind point (live-verified 2026-08-30).
 *
 * Timestamps advance one second per line in file order, so the official leaf
 * rule (latest `Date.parse(timestamp)`, sessionStorage.ts:2046) selects the
 * last-written branch unless a case passes an explicit `at`.
 *
 * Usage:
 *   const t = transcript();
 *   t.user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second');
 *   const cut = cutHere(t, 'u2');             // the record a rewind commit writes
 *   t.assistant('a2', 'ABANDONED');           // the branch that gets rewound away
 *   t.from('u2').user('u2b', 'second take');  // the new branch
 *   computeRewindDeadSet(t.lines, [cut]);     // unit
 *   await writeTranscript(sid, t.lines);      // integration (t.text())
 */
import { TRANSCRIPT_TREE_TYPES, queueEnqueueKey } from '../../src/core/transcript-chain.js';

/** Structurally assignable to TranscriptChainLine (src/core/transcript-chain.ts)
 *  so fixtures can be handed straight to either exported function. */
export interface TranscriptLine {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    id?: string;
    role?: string;
    content?: string | Array<{ type: string; [key: string]: unknown }>;
  };
  [key: string]: unknown;
}

/** Per-line overrides. `at` sets the timestamp, `parent` overrides threading. */
export interface LineOpts {
  at?: string;
  parent?: string | null;
  msgId?: string;
  isSidechain?: boolean;
  [key: string]: unknown;
}

const BASE_MS = Date.UTC(2026, 7, 30, 0, 0, 0);

export class TranscriptFixture {
  readonly lines: TranscriptLine[] = [];
  private seq = 0;
  private tip: string | null = null;

  /** One second per line, in file order. */
  stamp(): string {
    return new Date(BASE_MS + ++this.seq * 1000).toISOString();
  }

  /** The next tree line hangs off `uuid` (null = a fresh chain root). */
  from(uuid: string | null): this {
    this.tip = uuid;
    return this;
  }

  private push(line: TranscriptLine, opts: LineOpts): this {
    const { at, parent, msgId: _msgId, ...rest } = opts;
    const parentUuid = parent !== undefined ? parent : this.tip;
    this.lines.push({ ...line, parentUuid, timestamp: at ?? this.stamp(), ...rest } as TranscriptLine);
    if (typeof line.uuid === 'string') this.tip = line.uuid;
    return this;
  }

  user(uuid: string, text: string, opts: LineOpts = {}): this {
    return this.push({ type: 'user', uuid, message: { role: 'user', content: text } }, opts);
  }

  assistant(uuid: string, text: string, opts: LineOpts = {}): this {
    return this.push({
      type: 'assistant', uuid,
      message: { id: opts.msgId ?? `msg_${uuid}`, role: 'assistant', content: [{ type: 'text', text }] },
    }, opts);
  }

  /** Streaming writes ONE assistant line per content block, so N parallel
   *  tool_uses share ONE `message.id` under N uuids (the real DAG). */
  toolUse(uuid: string, toolId: string, opts: LineOpts & { msgId: string; name?: string }): this {
    const { name, ...rest } = opts;
    return this.push({
      type: 'assistant', uuid,
      message: {
        id: opts.msgId, role: 'assistant',
        content: [{ type: 'tool_use', id: toolId, name: name ?? 'Bash', input: { command: 'echo hi' } }],
      },
    }, rest);
  }

  /** A tool_result user line — its parentUuid is overridden by the CLI to the
   *  one-block assistant that emitted the tool_use (sessionStorage.ts:1031). */
  toolResult(uuid: string, toolId: string, text: string, opts: LineOpts = {}): this {
    return this.push({
      type: 'user', uuid,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: [{ type: 'text', text }] }] },
    }, opts);
  }

  /** `system` IS a tree node (isTranscriptMessage, sessionStorage.ts:139). */
  system(uuid: string, subtype: string, opts: LineOpts = {}): this {
    return this.push({ type: 'system', uuid, subtype }, opts);
  }

  /** Attachments carry uuid/parentUuid and no `message` — the chain runs
   *  THROUGH them (34% of uuid-bearing lines on real transcripts). */
  attachment(uuid: string, opts: LineOpts = {}): this {
    return this.push({ type: 'attachment', uuid, attachment: { type: 'deferred_tools_delta' } }, opts);
  }

  /** A compact boundary: `parentUuid: null` (a NEW chain root) with the real
   *  parent moved to logicalParentUuid — both the CLI (sessionStorage.ts:1039)
   *  and Walnut's compact-inject write this shape. */
  compactBoundary(uuid: string, opts: LineOpts & { logicalParentUuid?: string } = {}): this {
    return this.push({
      type: 'system', uuid, subtype: 'compact_boundary',
      compactMetadata: { trigger: 'manual', preTokens: 120_000 },
    }, { ...opts, parent: null });
  }

  /** A line with NO uuid — queue-operation / mode / last-prompt / summary etc.
   *  Never a tree node; must always pass through the filter. */
  meta(line: Record<string, unknown>): this {
    this.lines.push({ timestamp: this.stamp(), ...line } as TranscriptLine);
    return this;
  }

  /** Anything at all, verbatim (malformed shapes, legacy `progress` lines). */
  raw(line: Record<string, unknown>): this {
    this.lines.push(line as TranscriptLine);
    return this;
  }

  /** JSONL text, newline-terminated (what the CLI writes). */
  text(): string {
    return this.lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  }
}

export function transcript(): TranscriptFixture {
  return new TranscriptFixture();
}

/**
 * INNOCENT FORK #1 — an `api_error` line written at EOF that carries an EARLY
 * timestamp and re-parents onto pre-turn state, with the next real user message
 * chaining off IT. Measured on the real store by both round-1 reviews: this is
 * the single biggest source of the always-on chain filter's row loss (one session
 * served 40 rows filtered vs 227 unfiltered), and no session with this shape was
 * ever rewound.
 *
 * The trap is that it is topologically IDENTICAL to a rewind branch: the newest
 * leaf sits on a two-line stub, so the whole 15-minute turn in between is
 * unreachable from it. Any rule that infers deadness from the file alone deletes
 * the conversation here.
 */
export function apiErrorEofForkFixture(): TranscriptFixture {
  const T = (sec: number) => new Date(Date.UTC(2026, 7, 30, 0, 0, sec)).toISOString();
  return transcript()
    .user('u1', 'why is the deploy stuck', { at: T(1) })
    .attachment('at1', { at: T(2) })
    // The real turn: everything the human actually read.
    .from('at1').assistant('a1', 'Found bug #1 visually', { at: T(3) })
    .assistant('a2', 'Root cause found in the logs. Let me confirm the config.', { at: T(4) })
    .user('u2', 'confirm it then', { at: T(5) })
    .assistant('a3', 'Confirmed: the config was stale.', { at: T(6) })
    // …then, at EOF, the api_error re-parented onto the PRE-TURN attachment with
    // a timestamp from when the failure happened, not when it was written.
    .system('err', 'api_error', { parent: 'at1', at: T(2), error: { message: 'overloaded_error' } })
    .system('hook', 'stop_hook_summary', { parent: 'err', at: T(20) })
    .from('hook').user('u3', 'it still happened did you fix it', { at: T(21) });
}

/**
 * INNOCENT FORK #2 — a mid-turn slash command. The human typed `/model` 2.5s
 * after sending a message, so the CLI hung the command's caveat + invocation
 * lines off the PRE-TURN attachment rather than off the turn that was already
 * streaming. Those lines carry the newest timestamps in the file, so the official
 * leaf lands on the command stub and the entire real turn is off-chain (measured:
 * 210 rendered rows -> 72 on a never-rewound session).
 */
export function midTurnCommandForkFixture(): TranscriptFixture {
  const T = (sec: number) => new Date(Date.UTC(2026, 7, 30, 0, 0, sec)).toISOString();
  return transcript()
    .user('u1', 'profile the session open path', { at: T(1) })
    .attachment('at1', { at: T(2) })
    .from('at1').assistant('a1', 'Two distinct problems confirmed. Now profiling the server...', { at: T(3) })
    .assistant('a2', 'Root causes now clear.', { at: T(4) })
    .user('u2', 'fix the first one', { at: T(5) })
    .assistant('a3', 'Done, the first one is fixed.', { at: T(6) })
    // The slash command branch, written last and stamped last.
    .user('cav', '<local-command-caveat>the messages below were generated by the user</local-command-caveat>',
      { parent: 'at1', at: T(30) })
    .user('cmd', '<command-name>model</command-name><command-args>sonnet</command-args>', { at: T(31) });
}

/**
 * The cut record a real rewind commit writes RIGHT NOW, for the fixture as it
 * stands at this point in the build: `lastUuidAtCommit` is the uuid of the LAST
 * tree line currently in the file, and `trailingQueueKeys` are the identity keys
 * of enqueue lines sitting past it — exactly what rewindInPlace snapshots
 * (src/core/sessions/session-rewind.ts). Call it BEFORE appending the branch that
 * the rewind abandons is wrong — call it AFTER, at the moment the human presses
 * Rewind, i.e. once the abandoned branch is already on disk.
 *
 * Hand-writing the anchor is the one way these fixtures can lie (an anchor past
 * the real EOF would sweep in post-rewind lines that production can never sweep),
 * so cut cases should always build it from the file.
 */
export function cutHere(
  t: TranscriptFixture,
  uuid: string,
  at = '2026-08-30T00:00:00.000Z',
): { uuid: string; lastUuidAtCommit: string; at: string; trailingQueueKeys?: string[] } {
  const idx = lastTreeIndex(t.lines);
  const trailingQueueKeys: string[] = [];
  if (idx >= 0) {
    for (let i = idx + 1; i < t.lines.length; i++) {
      const l = t.lines[i];
      if (l && l.type === 'queue-operation' && l.operation === 'enqueue') {
        trailingQueueKeys.push(queueEnqueueKey(l as { timestamp?: string; content?: unknown }));
      }
    }
  }
  return {
    uuid,
    lastUuidAtCommit: idx >= 0 ? (t.lines[idx].uuid as string) : uuid,
    at,
    ...(trailingQueueKeys.length > 0 ? { trailingQueueKeys } : {}),
  };
}

/** Index of the last TREE line in file order. */
function lastTreeIndex(lines: readonly TranscriptLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l && typeof l.uuid === 'string' && typeof l.type === 'string'
      && TRANSCRIPT_TREE_TYPES.has(l.type)) return i;
  }
  return -1;
}

/** Uuid of the last TREE line in file order — rewindInPlace's `lastUuidAtCommit`
 *  scan, so a fixture and production agree on what "end of file" means. */
export function lastTreeUuid(lines: readonly TranscriptLine[]): string | undefined {
  const i = lastTreeIndex(lines);
  return i >= 0 ? (lines[i].uuid as string) : undefined;
}

/** Uuids still LIVE after filtering, in FILE order (lines with no uuid are
 *  reported as-is so a case can assert non-tree pass-through positions). */
export function survivingUuids(
  lines: readonly TranscriptLine[],
  dead: Set<string> | null,
): Array<string | undefined> {
  return lines
    .filter((l) => !(dead && typeof l.uuid === 'string' && dead.has(l.uuid)))
    .map((l) => l.uuid);
}
