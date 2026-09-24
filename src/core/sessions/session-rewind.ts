/**
 * Session rewind — "take this conversation back to that message".
 *
 * ## Why this is possible at all (print-mode CLI, no fork patches)
 *
 * Walnut drives `claude -p --input-format stream-json`, where the interactive
 * `/rewind` command is unavailable (`supportsNonInteractive: false`). Both halves
 * of rewind are nevertheless reachable from print mode, through two DIFFERENT
 * channels — that split is the whole design:
 *
 *  1. **Files** — the `rewind_files` control_request over the session's existing
 *     stdin FIFO (same channel as side_question / apply_flag_settings). It restores
 *     every file the session touched since a given USER message, and with
 *     `dry_run:true` it answers with a preview (files changed, insertions,
 *     deletions) without writing anything. Requires the CLI to have been spawned
 *     with `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1` (the non-interactive gate
 *     in the CLI's `fileHistoryEnabled()`) — the daemon sets it for every session,
 *     but a session spawned by an OLD daemon has no checkpoints, which surfaces
 *     here as `canRewind:false` + "No file checkpoint found for this message."
 *
 *  2. **Conversation** — the hidden `--resume-session-at <message uuid>` flag,
 *     which loads a resumed transcript only up to and including that message.
 *
 *     ⚠️ The flag is INCLUSIVE, and a rewind is EXCLUSIVE. The CLI's own
 *     interactive /rewind restores "the point BEFORE you sent this message":
 *     `messages.slice(0, index)` plus that message's text back in the input box
 *     (REPL.tsx restoreMessageSync → textForResubmit). So the flag is handed the
 *     message just BEFORE the target on the CLI-loaded chain (the RESUME ANCHOR,
 *     resumeAnchorBefore in transcript-rewind-core.ts) and the target's text
 *     rides back to the composer as `restoredPrompt`. Handing it the target
 *     itself is the bug this replaced: the message the human was taking back
 *     stayed in the model's context and their edit landed after it.
 *
 *     Two modes, both CLI-native:
 *
 *     **in-place** (the default): `--resume <sid> --resume-session-at <anchor>`
 *     WITHOUT `--fork-session`. The CLI keeps the SAME session id and appends
 *     the new branch to the SAME transcript, hanging it off the anchor via
 *     parentUuid. The file alone cannot say which branch was rewound away
 *     (innocent forks — api_error re-parents, mid-turn slash-command branches
 *     — are topologically identical), so the commit records the cut on the
 *     session record (`inPlaceRewinds: {uuid = the ANCHOR, lastUuidAtCommit,
 *     at}`) and the history parser replays it against the file at every read
 *     (computeRewindDeadSet, src/core/transcript-chain.ts), hiding exactly the
 *     region after the anchor up to the commit-time last tree line — which is
 *     the rewound message itself plus everything that followed it.
 *     `pendingResumeSessionAt` is also set — pure cold-resume spawn plumbing,
 *     no display role. The conversation visibly rewinds inside its own panel.
 *
 *     **fork**: pair the flag with `--fork-session` — the truncated
 *     conversation lands in a fresh session, the source is archived (never
 *     deleted) and stays readable as the abandoned branch.
 *
 * ## What an IN-PLACE rewind does, in order
 *
 *   verify              → resolveRewindTarget: the rewind uuid must be ON the
 *                         chain the CLI would load (computeCliLoadedChain — the
 *                         CLI exits 1 at respawn on a uuid it can't resume to,
 *                         e.g. one behind the last compact boundary or on an
 *                         abandoned branch), AND it must have a resume anchor
 *                         before it that survives the CLI's own resume-time
 *                         message filters. Runs BEFORE anything mutates, and
 *                         previewSessionRewind shares it, so the dialog's dry
 *                         run already refuses with the reason.
 *   preview (optional)  → dry-run `rewind_files`, so the human sees the blast radius
 *   restore files       → `rewind_files` on the LIVE CLI (skipped, with a reason,
 *                         when the session has no live CLI to ask)
 *   stop the CLI        → the transcript must be quiet before committing
 *   commit              → get the cut's end anchor (the last tree line) + any
 *                         trailing enqueue keys — from the host's daemon
 *                         (transcript.rewindProbe) or, on an old daemon, one raw
 *                         read of the JSONL here — then append
 *                         the cut to record.inPlaceRewinds + set
 *                         pendingResumeSessionAt, drop every history cache (the
 *                         FILE didn't change, its MEANING did — mtime caches
 *                         would serve the abandoned turns forever). Any failure
 *                         after the stop respawns the session best-effort
 *                         before rethrowing — a refusal never leaves it dead.
 *   respawn in place    → same session id, `--resume <sid> --resume-session-at
 *                         <anchor>`, empty first message (warm draft semantics —
 *                         waits for the human's next instruction), then a second
 *                         cache invalidation (barrier against a pre-commit
 *                         in-flight read re-caching the unfiltered parse)
 *
 * ## What a FORK rewind does, in order
 *
 *   restore files → terminate source → spawn `--resume <source>
 *   --resume-session-at <anchor> --fork-session` under a new id → archive source
 *   (best-effort, AFTER the spawn so a failed archive can never leave the task
 *   with no session at all; `keepSource` skips it).
 */

import { randomUUID } from 'node:crypto';
import { SessionControlError } from './session-controls.js';
import { readProviderSessionHistory } from './session-lifecycle.js';
import { bus, EventNames } from '../event-bus.js';
import { log } from '../../logging/index.js';
import type { SessionHistoryMessage } from '../session-history.js';
import { engineCaps } from '../agents/engine-registry.js';

/** File-rewind outcome as the CLI reports it (SDKControlRewindFilesResponse). */
export interface RewindFilesReport {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

export interface RewindPreview extends RewindFilesReport {
  /** The message the rewind would cut at (echoed for client-side asserts). */
  messageUuid: string;
  /** Label of that message, so a confirm dialog can name it. */
  messageLabel?: string;
  /** How many transcript messages leave the conversation — the target message
   *  INCLUDED, because a rewind goes back to just before it was sent. */
  droppedMessages: number;
  /** The target message's text, which the composer restores for editing (the
   *  CLI's own /rewind does the same: textForResubmit → setInputValue). */
  restoredPrompt?: string;
  /** Why files can't be restored, when that's a Walnut-side fact rather than a
   *  CLI answer: 'session_not_live' (nothing to ask) / 'engine_unsupported'. */
  filesUnavailableReason?: 'session_not_live' | 'engine_unsupported';
}

export interface RewindResult {
  status: 'rewound';
  /** 'in-place' rewinds THIS session; 'fork' continues under a new id. */
  mode: 'in-place' | 'fork';
  sourceSessionId: string;
  /** The session that continues from the rewind point — SAME id as
   *  sourceSessionId for an in-place rewind, a fresh id for a fork. */
  sessionId: string;
  taskId?: string;
  title: string;
  host?: string;
  /** What actually happened to the files (absent when the caller didn't ask). */
  files?: RewindFilesReport & { skippedReason?: 'session_not_live' | 'engine_unsupported' };
  /** The rewound message's text, for the composer to restore so the human can
   *  edit and resend it. Absent when the message had no text (e.g. images only). */
  restoredPrompt?: string;
  /** True when the source session was archived (fork mode only). */
  sourceArchived: boolean;
}

/**
 * Cut a rewound session's inherited ANCESTOR transcript at its rewind point.
 *
 * A rewound session is a fork, so the history route prepends the parent's full
 * transcript — including the turns the human rewound away (the parent's JSONL is
 * deliberately never edited). The CLI's own copy is already truncated by
 * `--resume-session-at`, so this is where the two views are reconciled.
 *
 * Cuts at the LAST occurrence of the uuid: the immediate parent's slice is the
 * tail of the concatenated array, and a re-forked chain can carry the same uuid
 * once per ancestor. `found: false` means the anchor is gone (the parent compacted
 * its transcript, or the ancestor read was windowed past it) — callers report that
 * rather than silently serving the un-trimmed parent, because the visible symptom
 * ("the messages I rewound away are back") looks like the rewind never ran.
 */
export function cutAncestorHistoryAtRewindPoint<T extends { msgId?: string }>(
  ancestorMessages: T[],
  rewoundAtMessageUuid: string | undefined,
): { messages: T[]; found: boolean; dropped: number } {
  if (!rewoundAtMessageUuid) {
    return { messages: ancestorMessages, found: false, dropped: 0 };
  }
  let cutAt = -1;
  for (let i = 0; i < ancestorMessages.length; i++) {
    if (ancestorMessages[i].msgId === rewoundAtMessageUuid) cutAt = i;
  }
  if (cutAt < 0) return { messages: ancestorMessages, found: false, dropped: 0 };
  return {
    messages: ancestorMessages.slice(0, cutAt + 1),
    found: true,
    dropped: ancestorMessages.length - (cutAt + 1),
  };
}

/** The CLI's own message uuids are v4 UUIDs. Walnut's parser also mints SYNTHETIC
 *  ids for lines that carry none (`queue-<ts>`, `<timestamp>-<index>`) and uses the
 *  API `msg_…` id for assistant rows — none of those exist in the CLI's transcript,
 *  so neither `--resume-session-at` nor `rewind_files` can resolve them. Reject
 *  early with a real explanation instead of letting the CLI exit 1 at spawn. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRewindableMessageId(msgId: string | undefined): boolean {
  return !!msgId && UUID_RE.test(msgId);
}

/**
 * The text a rewind hands back to the composer, so the human can edit the
 * message and resend it (the CLI's own /rewind does exactly this —
 * textForResubmit → setInputValue). The parser has already turned the CLI's
 * wrapper tags into their readable form (`<command-name>` → `/model sonnet`,
 * `<bash-input>` → `! cmd`), which is the same normalization textForResubmit
 * applies, so the displayed text IS the resubmit text.
 */
function promptOf(message: SessionHistoryMessage | undefined): string | undefined {
  const text = message?.text?.trim();
  return text ? text : undefined;
}

/** First line of a message, trimmed to a label length. */
function labelOf(message: SessionHistoryMessage | undefined): string | undefined {
  const line = (message?.text ?? '').split('\n').find((l) => l.trim());
  if (!line) return undefined;
  const trimmed = line.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
}

interface ResolvedTarget {
  record: import('../types.js').SessionRecord;
  messages: SessionHistoryMessage[];
  index: number;
  target: SessionHistoryMessage;
  /** The uuid handed to `--resume-session-at`: the chain message just BEFORE the
   *  target, so the conversation resumes without the message being taken back
   *  (the flag is inclusive; see resumeAnchorBefore). */
  resumeAnchorUuid: string;
}

// ── Host-local probe (capability 'rewind-probe-v1') ──
// Design-principle path (AGENTS.md): the daemon streams the session's OWN
// transcript and answers rewind's questions from it; only the small answer
// crosses the tunnel. The whole-file read below stays as the fallback for hosts
// whose daemon predates the capability — same functions, same answers — but it
// cannot serve a transcript past DaemonFileReader's byte ceiling at all, which
// is exactly why the probe exists.

// Generous by default because the callers that omit `timeoutMs` are the rewind
// GATE and the rewind COMMIT: a user-initiated action that must be correct, and
// whose whole cost is this one RPC. A caller on a latency-sensitive path (the
// history display read) passes its own, much shorter budget instead.
const REWIND_PROBE_TIMEOUT_MS = 60_000;

/** What the probe needs to reach the right host's transcript. Not a
 *  SessionRecord: the record keys the id as `claudeSessionId`, and the history
 *  read path (session-history.ts) has only the loose (sessionId, cwd, host). */
export interface RewindProbeTarget {
  sessionId: string;
  cwd?: string;
  host?: string | null;
}

/**
 * Ask the session host's daemon. Returns null when it can't answer (no
 * capability, not connected, transcript not found, RPC failure) — every caller
 * then falls back to its own read. Never dials: a disconnected host should fall
 * back, not block.
 */
export async function probeRewindViaDaemon(
  target: RewindProbeTarget,
  args: {
    uuid?: string;
    cuts?: readonly Pick<import('../types.js').InPlaceRewindCut,
      'uuid' | 'lastUuidAtCommit' | 'trailingQueueKeys'>[];
    /** Per-call RPC budget. Defaults to REWIND_PROBE_TIMEOUT_MS (gate/commit). */
    timeoutMs?: number;
  },
): Promise<import('../../providers/transcript-rewind-core.js').RewindProbeOutput | null> {
  let conn: import('../../providers/daemon-connection.js').DaemonConnection | null = null;
  try {
    const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js');
    const found = getConnectedDaemonConnection(target.host ?? '__local__');
    if (found && found.hasCapability('rewind-probe-v1')) conn = found;
  } catch { /* provider layer unavailable (tests) */ }
  if (!conn) return null;
  try {
    const res = await conn.send('transcript.rewindProbe', {
      sid: target.sessionId,
      ...(target.cwd ? { cwd: target.cwd } : {}),
      ...(args.uuid ? { uuid: args.uuid } : {}),
      ...(args.cuts && args.cuts.length > 0
        ? {
          cuts: args.cuts.map((c) => ({
            uuid: c.uuid,
            lastUuidAtCommit: c.lastUuidAtCommit,
            ...(c.trailingQueueKeys ? { trailingQueueKeys: c.trailingQueueKeys } : {}),
          })),
        }
        : {}),
    }, args.timeoutMs ?? REWIND_PROBE_TIMEOUT_MS);
    if (!res.ok || res.found !== true) return null;
    return res as unknown as import('../../providers/transcript-rewind-core.js').RewindProbeOutput;
  } catch (err) {
    log.session.debug('rewind probe via daemon failed — falling back to the transcript read', {
      sessionId: target.sessionId, host: target.host ?? '__local__',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** A read the tunnel refused on size is not an errno the human should ever see:
 *  it means this host's daemon is too old to answer host-locally, and it fixes
 *  itself on the next auto-deploy. Returns null for any other error. */
function tooLargeForTheTunnel(err: unknown): SessionControlError | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.includes('byte ceiling')) return null;
  return new SessionControlError(
    'This transcript is too large to validate over the tunnel; the session host needs the current daemon (auto-upgrades on the next message you send it)',
    503,
  );
}

/** Parse a raw JSONL string into the line objects the chain machinery reads,
 *  each carrying the resume-filter facts a resume anchor needs (the daemon probe
 *  attaches the same facts while streaming — ONE implementation of both).
 *  Partial/corrupt lines are skipped — they are not transcript lines. */
async function parseTranscriptLines(
  content: string,
  forResume = false,
): Promise<import('../../providers/transcript-rewind-core.js').RewindTranscriptLine[]> {
  const { resumeFactsOf } = await import('../../providers/transcript-rewind-core.js');
  const { createCliTranscriptPrefilter } = await import('../transcript-chain-prefilter.js');
  const prefilter = forResume ? createCliTranscriptPrefilter(Buffer.byteLength(content)) : null;
  const parsedLines: import('../../providers/transcript-rewind-core.js').RewindTranscriptLine[] = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const parsed = raw as import('../../providers/transcript-rewind-core.js').RewindTranscriptLine;
      const resume = resumeFactsOf(raw);
      if (resume) parsed.resume = resume;
      prefilter?.push(Buffer.from(line), raw, parsedLines.length);
      parsedLines.push(parsed);
    } catch { /* partial/corrupt line — not a transcript line */ }
  }
  return prefilter ? prefilter.apply(parsedLines) : parsedLines;
}

/**
 * Shared validation for both entry points: the session exists, runs an engine
 * whose CLI understands rewind, and the requested uuid really is one of ITS user
 * messages. Rewinding to an assistant message is refused on purpose — file
 * checkpoints are only taken at user messages, so it would silently restore
 * nothing.
 *
 * Also the CHAIN gate: the uuid must be ON the chain the CLI itself would load
 * (computeCliLoadedChain — the getLastSessionLog port), computed by the session
 * HOST's daemon when it speaks `rewind-probe-v1` (a long transcript cannot cross
 * the tunnel at all). `--resume-session-at`
 * resolves against exactly that chain, so a uuid that merely EXISTS on disk but
 * sits off it (behind the last compact boundary, or on an abandoned branch)
 * makes the CLI exit 1 at respawn. Running the gate HERE — shared by
 * previewSessionRewind and the commit — means the dialog's dry run already
 * refuses with the reason (the affordance grays out and explains), and the
 * commit re-checks BEFORE gracefulStop and BEFORE rewind_files, so a refusal
 * can never leave a stopped CLI or a rolled-back working tree behind a 409.
 */
async function resolveRewindTarget(sessionId: string, messageUuid: string): Promise<ResolvedTarget> {
  if (!messageUuid || typeof messageUuid !== 'string') {
    throw new SessionControlError('message_uuid is required', 400);
  }
  if (!isRewindableMessageId(messageUuid)) {
    throw new SessionControlError(
      'This message has no CLI transcript id, so it cannot be used as a rewind point. Rewind to one of your own messages instead.',
      400,
    );
  }

  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record) throw new SessionControlError('Session not found', 404);
  if (engineCaps(record.engine).rewind === 'unsupported') {
    throw new SessionControlError('Rewind is unavailable for this Codex session', 409, {
      code: 'REWIND_ENGINE_UNSUPPORTED',
    });
  }
  if (!record.cwd) {
    throw new SessionControlError('Session has no working directory — cannot rewind', 400);
  }

  const { messages } = await readProviderSessionHistory(sessionId, record, record.host);
  const index = messages.findIndex((m) => m.msgId === messageUuid);
  if (index < 0) {
    throw new SessionControlError('That message is not part of this session\'s transcript', 404);
  }
  const target = messages[index];
  if (target.role !== 'user') {
    throw new SessionControlError(
      'Rewind points are your own messages — the CLI only checkpoints files there.',
      400,
    );
  }

  // ── Chain gate + resume anchor (see the doc above) ── the session HOST answers
  // both if it can (one small RPC, no bytes over the tunnel); otherwise one raw
  // read here.
  const OFF_CHAIN = 'That message is not on the conversation the CLI can resume (behind the last context compaction, or on an abandoned branch)';
  const NO_ANCHOR = 'This is the first message of the conversation, so there is nothing before it to go back to. Start a new session instead.';
  // `undefined` = nobody has answered yet. A daemon that speaks the capability
  // but predates the ANCHOR half returns onChain without the field, and treating
  // that as "no anchor" would refuse every rewind on that host until it
  // auto-upgrades — so undefined falls through to the read, null does not.
  let resumeAnchorUuid: string | null | undefined;
  const probe = await probeRewindViaDaemon(
    { sessionId, cwd: record.cwd, host: record.host }, { uuid: messageUuid },
  );
  if (probe && typeof probe.onChain === 'boolean') {
    if (!probe.onChain) throw new SessionControlError(OFF_CHAIN, 409);
    resumeAnchorUuid = probe.resumeAnchorUuid;
  }
  if (resumeAnchorUuid === undefined) {
    const { readSessionJsonlContent } = await import('../session-file-reader.js');
    let raw: Awaited<ReturnType<typeof readSessionJsonlContent>>;
    try {
      raw = await readSessionJsonlContent(sessionId, record.cwd, record.host ?? undefined);
    } catch (err) {
      throw tooLargeForTheTunnel(err) ?? err;
    }
    if (!raw?.content) {
      throw new SessionControlError('Could not read the session transcript to validate the rewind point', 500);
    }
    const { computeCliLoadedChain } = await import('../transcript-chain.js');
    const { resumeAnchorBefore } = await import('../../providers/transcript-rewind-core.js');
    const lines = await parseTranscriptLines(raw.content, true);
    const loaded = computeCliLoadedChain(lines);
    if (!loaded.chainUuids.has(messageUuid)) {
      throw new SessionControlError(OFF_CHAIN, 409);
    }
    resumeAnchorUuid = resumeAnchorBefore(lines, loaded.chain, messageUuid).uuid;
  }
  if (!resumeAnchorUuid) throw new SessionControlError(NO_ANCHOR, 409);

  return { record, messages, index, target, resumeAnchorUuid };
}

/** Live CLI handle, or null when nothing is attached/attachable. */
async function liveSession(sessionId: string) {
  const { sessionRunner } = await import('../../providers/claude-code-session.js');
  try {
    return (await sessionRunner.getOrAttachLiveSession(sessionId)) ?? null;
  } catch (err) {
    log.session.info('rewind: no live session to ask for file state', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Dry run: what WOULD this rewind do? Never mutates anything — the file half is
 * asked with `dry_run:true`, and the conversation half is a count.
 */
export async function previewSessionRewind(sessionId: string, messageUuid: string): Promise<RewindPreview> {
  const { messages, index, target } = await resolveRewindTarget(sessionId, messageUuid);
  // The target leaves the conversation too — it goes back to the input box.
  const droppedMessages = Math.max(0, messages.length - index);
  const base: RewindPreview = {
    canRewind: false,
    messageUuid,
    ...(labelOf(target) ? { messageLabel: labelOf(target) } : {}),
    droppedMessages,
    ...(promptOf(target) ? { restoredPrompt: promptOf(target) } : {}),
  };

  const session = await liveSession(sessionId);
  if (!session) {
    return { ...base, filesUnavailableReason: 'session_not_live' };
  }
  try {
    const report = await session.rewindFiles(messageUuid, true);
    return { ...base, ...report };
  } catch (err) {
    // A CLI that predates the subtype, a dead FIFO, or "no checkpoint for this
    // message" all land here. The conversation half is still available, so this
    // is a partial answer, not a failure.
    return { ...base, canRewind: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface RewindInput {
  messageUuid: string;
  /** 'in-place' (default) rewinds THIS conversation; 'fork' continues under a
   *  new session id and archives the source (the original behavior). */
  mode?: 'in-place' | 'fork';
  /** Also restore the files to their state at that message. */
  restoreFiles?: boolean;
  /** Fork mode only: keep the abandoned branch on the board (skip archiving). */
  keepSource?: boolean;
  /** Fork mode only: optional first message for the rewound session. Empty =
   *  warm up and wait. (In-place always respawns warm — the human is already
   *  looking at the panel they rewound.) */
  message?: string;
}

/**
 * Rewind a session: restore files (optional), stop the abandoned branch, and
 * continue from `messageUuid` with the later turns gone — inside the same
 * session (in-place, default) or as a fresh fork.
 */
export async function rewindSessionToMessage(
  sessionId: string,
  input: RewindInput,
  source = 'web-api',
): Promise<RewindResult> {
  const { record, messages, index, target, resumeAnchorUuid } = await resolveRewindTarget(
    sessionId, input.messageUuid,
  );
  const droppedMessages = Math.max(0, messages.length - index);

  // ── 1. Files first, while the source CLI is still alive ──
  // It holds the in-memory fileHistory state that `rewind_files` operates on, and
  // terminating it would force a cold resume to rebuild that chain.
  let files: RewindResult['files'];
  if (input.restoreFiles) {
    const session = await liveSession(sessionId);
    if (!session) {
      files = { canRewind: false, skippedReason: 'session_not_live' };
      log.session.warn('rewind: file restore skipped — no live CLI', { sessionId });
    } else {
      try {
        files = await session.rewindFiles(input.messageUuid, false);
      } catch (err) {
        // A file-restore failure must NOT abort the conversation rewind: the human
        // asked to go back, and reporting "nothing happened" while leaving the
        // transcript untouched is the worst of both. Surfaced in the result.
        files = { canRewind: false, error: err instanceof Error ? err.message : String(err) };
        log.session.warn('rewind: file restore failed, continuing with the conversation rewind', {
          sessionId, error: files.error,
        });
      }
    }
  }

  if ((input.mode ?? 'in-place') === 'in-place') {
    return rewindInPlace(sessionId, input, record, target, resumeAnchorUuid, droppedMessages, files);
  }

  // ── FORK MODE ──
  // ── 2. Stop the branch being abandoned ──
  try {
    const { terminateSession } = await import('./session-lifecycle.js');
    await terminateSession(sessionId, { force: true });
  } catch (err) {
    // Already dead / never spawned / cron-owner refusal with force — none of
    // these should block the rewind.
    log.session.info('rewind: source terminate was a no-op', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── 3. Spawn the rewound continuation ──
  const rewoundId = randomUUID();
  const baseTitle = (record.title ?? sessionId.slice(0, 16)).replace(/\s*\(rewound\)$/i, '');
  const title = `${baseTitle} (rewound)`.slice(0, 200);
  const { createSessionRecord } = await import('../session-tracker.js');
  try {
    await createSessionRecord(rewoundId, record.taskId ?? '', record.project ?? '', record.cwd, {
      title,
      ...(record.mode && record.mode !== 'default' ? { mode: record.mode } : {}),
      ...(record.host ? { host: record.host } : {}),
      forkedFromSessionId: sessionId,
      // The ANCHOR, not the target: the history route cuts the inherited
      // ancestor transcript at this uuid inclusive, which is exactly "everything
      // up to just before the rewound message".
      rewoundAtMessageUuid: resumeAnchorUuid,
      ...(record.cliModel ? { cliModel: record.cliModel } : {}),
      ...(record.effort ? { effort: record.effort } : {}),
      ...(record.profile ? { profile: record.profile } : {}),
      ...(record.lane ? { lane: record.lane } : {}),
      initialProcessStatus: 'idle',
      initialStatusReason: 'awaiting_spawn',
    });
  } catch (err) {
    // The client opens the rewound panel on this response; a missing record would
    // 404 its first read. Seeding is best-effort in the fork path for the same
    // reason it is here — the SESSION_START below re-persists on spawn.
    log.session.warn('rewind: pre-spawn record seed failed', {
      sessionId: rewoundId, error: err instanceof Error ? err.message : String(err),
    });
  }

  bus.emit(EventNames.SESSION_START, {
    preassignedSessionId: rewoundId,
    taskId: record.taskId ?? '',
    message: input.message?.trim() ?? '',
    cwd: record.cwd,
    project: record.project ?? '',
    ...(record.mode && record.mode !== 'default' ? { mode: record.mode } : {}),
    // Same rule as fork: the CLI does NOT inherit a model across --resume, and
    // cliModel is the only value that still carries the [1m] marker.
    ...(record.cliModel ? { model: record.cliModel } : {}),
    ...(record.effort ? { effort: record.effort } : {}),
    title,
    ...(record.host ? { host: record.host } : {}),
    ...(record.lane ? { lane: record.lane } : {}),
    forkedFromSessionId: sessionId,
    resumeSessionAtMessageUuid: resumeAnchorUuid,
  }, ['session-runner'], { source });

  // ── 4. Archive the abandoned branch (best-effort, after the spawn) ──
  let sourceArchived = false;
  if (!input.keepSource) {
    try {
      const { patchSession } = await import('./session-lifecycle.js');
      await patchSession(sessionId, {
        archived: true,
        archive_reason: `rewound to an earlier message (continues as ${rewoundId})`,
      });
      sourceArchived = true;
    } catch (err) {
      log.session.warn('rewind: archiving the source session failed (it stays on the board)', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.session.info('session rewound', {
    sessionId, rewoundId, taskId: record.taskId, messageUuid: input.messageUuid,
    resumeAnchorUuid,
    droppedMessages, restoredFiles: files?.canRewind ?? null, sourceArchived,
    targetLabel: labelOf(target)?.slice(0, 60),
  });

  return {
    status: 'rewound',
    mode: 'fork',
    sourceSessionId: sessionId,
    sessionId: rewoundId,
    ...(record.taskId ? { taskId: record.taskId } : {}),
    title,
    ...(record.host ? { host: record.host } : {}),
    ...(files ? { files } : {}),
    ...(promptOf(target) ? { restoredPrompt: promptOf(target) } : {}),
    sourceArchived,
  };
}

/**
 * In-place rewind: same session id, same transcript. The CLI is stopped, the
 * rewind point is verified to be ON the chain the CLI would load
 * (computeCliLoadedChain), the record gets the cut appended to
 * `inPlaceRewinds` (the history parser's filter input, replayed against the
 * file at every read) plus `pendingResumeSessionAt` (re-sent as
 * `--resume-session-at` on every cold resume until the first completed turn —
 * spawn plumbing only), every history cache is dropped (the file's mtime
 * didn't change but its meaning did), and the CLI is respawned warm with
 * `--resume <sid> --resume-session-at <uuid>` — no fork, so it keeps the id
 * and appends the new branch to the same file, hung off the rewind point via
 * parentUuid.
 */
async function rewindInPlace(
  sessionId: string,
  input: RewindInput,
  record: import('../types.js').SessionRecord,
  target: SessionHistoryMessage,
  resumeAnchorUuid: string,
  droppedMessages: number,
  files: RewindResult['files'],
): Promise<RewindResult> {
  // ── 2. Quiet the transcript ── The CLI appends while a turn runs; the
  // commit below should happen on a quiet file. gracefulStop flushes + SIGINTs
  // first (same stop reinitialize() itself uses), and a session with no live
  // CLI is already quiet.
  const session = await liveSession(sessionId);
  if (session) {
    try {
      await session.gracefulStop(true);
    } catch (err) {
      log.session.info('rewind: gracefulStop was a no-op', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 3. Commit ── The cut's end anchor, read off the quiet transcript — from
  // the host's daemon when it can answer, else one raw read here. The chain gate
  // already ran in resolveRewindTarget, BEFORE the stop
  // and before any file restore — so a refusal never reaches this point with a
  // stopped CLI behind it. Everything after the stop is wrapped: on ANY throw,
  // best-effort respawn the session and rethrow, because "rewind refused, and
  // your session is now dead" must never be an outcome.
  const { invalidateSessionHistoryCaches } = await import('../session-history.js');
  let lastUuidAtCommit = resumeAnchorUuid; // fallback = empty cut (no-op)
  try {
    // The anchor is the LAST tree line in the file right now — everything
    // between the rewind point and it is the branch being abandoned; everything
    // the CLI appends later sits past it and can never be swept into the cut.
    // Queue enqueue lines are uuid-less, so no uuid-anchored region reaches
    // them, and their identity keys have to ride the cut record or a rewound-away
    // message re-renders as a phantom Pattern-B row forever. TWO groups qualify,
    // on opposite sides of the region: enqueues PAST the anchor (a message the
    // human queued mid-turn and then rewound before the CLI drained it), and the
    // echo of the rewound message ITSELF, which the CLI logged when the message
    // arrived — i.e. just BEFORE its user line (see targetQueueKeys).
    let trailingQueueKeys: string[] = [];
    const probe = await probeRewindViaDaemon(
      { sessionId, cwd: record.cwd, host: record.host }, { uuid: input.messageUuid },
    );
    if (probe) {
      if (probe.lastUuidAtCommit) lastUuidAtCommit = probe.lastUuidAtCommit;
      trailingQueueKeys = [...(probe.trailingQueueKeys ?? []), ...(probe.targetQueueKeys ?? [])];
    } else {
      const { readSessionJsonlContent } = await import('../session-file-reader.js');
      let raw: Awaited<ReturnType<typeof readSessionJsonlContent>>;
      try {
        raw = await readSessionJsonlContent(sessionId, record.cwd, record.host ?? undefined);
      } catch (err) {
        throw tooLargeForTheTunnel(err) ?? err;
      }
      if (!raw?.content) {
        throw new SessionControlError('Could not read the session transcript to record the rewind', 500);
      }
      const { commitAnchorOf, targetQueueKeys } = await import('../../providers/transcript-rewind-core.js');
      const lines = await parseTranscriptLines(raw.content);
      const anchor = commitAnchorOf(lines);
      if (anchor.lastUuidAtCommit) lastUuidAtCommit = anchor.lastUuidAtCommit;
      trailingQueueKeys = [...anchor.trailingQueueKeys, ...targetQueueKeys(lines, input.messageUuid)];
    }
    const cutAt = new Date().toISOString();
    const { updateSessionRecord } = await import('../session-tracker.js');
    await updateSessionRecord(sessionId, {
      // The display filter's input: replayed against the file at every read
      // (computeRewindDeadSet). Appended, never replaced — a rewind of a rewind
      // unions its region with the earlier ones.
      inPlaceRewinds: [
        ...(record.inPlaceRewinds ?? []),
        {
          // The RESUME ANCHOR, not the message the human clicked: the dead
          // region is everything after it, which is exactly the rewound message
          // plus the branch that followed. Keeps the display and the CLI's own
          // context agreeing line for line.
          uuid: resumeAnchorUuid, lastUuidAtCommit, at: cutAt,
          ...(trailingQueueKeys.length > 0 ? { trailingQueueKeys } : {}),
        },
      ],
      // Spawn plumbing: every cold --resume until the first completed turn must
      // re-send --resume-session-at, or a CLI death in that window would resume
      // the ABANDONED branch tip (see the field's doc in types.ts).
      pendingResumeSessionAt: resumeAnchorUuid,
    });
    await invalidateSessionHistoryCaches(sessionId, record.host ?? undefined);
  } catch (err) {
    // Never leave a stopped session behind an error: respawn best-effort, then
    // let the caller see the original failure.
    try {
      const { sessionRunner } = await import('../../providers/claude-code-session.js');
      await sessionRunner.reinitialize(sessionId);
    } catch (respawnErr) {
      log.session.warn('rewind: recovery respawn after a failed commit also failed', {
        sessionId, error: respawnErr instanceof Error ? respawnErr.message : String(respawnErr),
      });
    }
    throw err;
  }

  // ── 4. Respawn in place (warm, no turn) ── reinitialize() resolves resume
  // args from the record, so the spawn picks up pendingResumeSessionAt and the
  // CLI comes back holding the truncated conversation. A failed respawn does
  // NOT undo the rewind: the cut + pending flag are committed, so the history
  // already reads truncated and the next send()'s cold resume carries the flag.
  try {
    const { sessionRunner } = await import('../../providers/claude-code-session.js');
    await sessionRunner.reinitialize(sessionId);
  } catch (err) {
    log.session.warn('rewind: in-place respawn failed — next send will cold-resume at the rewind point', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
  // Second invalidation, AFTER the respawn settles: a readSessionHistory that
  // entered before the commit resolved `rewindCuts = undefined` and, when it
  // finishes, re-caches the UNFILTERED parse right over the first invalidation
  // (the file's mtime never changed, so the poisoned entry would then serve
  // every same-mtime read). The respawn is a natural barrier that outlasts any
  // such in-flight read — invalidating again here evicts whatever it cached.
  await invalidateSessionHistoryCaches(sessionId, record.host ?? undefined);

  log.session.info('session rewound in place', {
    sessionId, taskId: record.taskId, messageUuid: input.messageUuid,
    resumeAnchorUuid, lastUuidAtCommit, droppedMessages,
    restoredFiles: files?.canRewind ?? null,
    targetLabel: labelOf(target)?.slice(0, 60),
  });

  return {
    status: 'rewound',
    mode: 'in-place',
    sourceSessionId: sessionId,
    sessionId,
    ...(record.taskId ? { taskId: record.taskId } : {}),
    title: record.title ?? sessionId.slice(0, 16),
    ...(record.host ? { host: record.host } : {}),
    ...(files ? { files } : {}),
    ...(promptOf(target) ? { restoredPrompt: promptOf(target) } : {}),
    sourceArchived: false,
  };
}
