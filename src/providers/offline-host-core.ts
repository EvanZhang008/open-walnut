/**
 * Offline host: the daemon answers a session's `walnut` calls while its Walnut
 * server is not connected (docs/plan/daemon-first-hosts.md).
 *
 * The server pushes a read copy per Walnut (`host.slice`: its sessions on this
 * host, their tasks, the pending reply requests between them). While that
 * Walnut is away, the gateway hands calls here instead of answering
 * hub_unreachable:
 *   - task_get / task_list / session_list read the copy;
 *   - task_send to a session of the same Walnut running on this host is written
 *     into the target's FIFO with the envelope the server would build (the
 *     shared envelope kit), and a reply request it opens is OWNED here: a reply
 *     settles it, the target's turn end without one sends the usual notice;
 *   - task_update / task_complete are journaled and replayed by the server;
 *   - a trigger fire no server claimed reaches the target task's live session
 *     here (deliverTrigger; the trigger's own fire queue reports it);
 *   - the checks run here, so trigger_list / trigger_test answer here, and a
 *     trigger_pause / _resume / _delete takes effect here at once (the daemon
 *     arms by triggerHolds() until the server has taken the record).
 * Everything the server must learn goes into a per-Walnut journal it drains on
 * reconnect (`offline.drain` / `offline.ack`); until the journal is empty the
 * gateway keeps answering here, so no id the server has not seen yet reaches it.
 *
 * How the daemon twins get it: daemon-standalone.ts imports createOfflineHostCore;
 * daemon-source.ts inlines `createOfflineHostCore.toString()` through
 * `__CREATE_OFFLINE_HOST__`. So the factory body references NOTHING at module
 * scope; the envelope kit, the journal store (offline-journal-core.ts) and every
 * side effect arrive through deps. `createOfflineHost` (tests, other callers)
 * builds the journal store itself when none is given.
 */

import { createHash } from 'node:crypto'
import type { EnvelopeKit, EnvelopeOutcome } from '../core/peers/envelope-kit.js'
import { createOfflineJournal } from './offline-journal-core.js'
import type { BoardOffline, OfflineSliceBoard } from './offline-board-core.js'
import type { HostReplica } from './host-replica-core.js'
import type { OfflineSearch } from './offline-search-core.js'
import type { OpenAsk, OpenItemsInput, OpenItemsText, OpenWait } from '../core/sessions/open-items-text.js'
import type { LetterCheck } from '../core/human-inbox/letter-check.js'

/**
 * `aside`: an environment or lane session, which the server never picks as a message's address by name.
 * `noResume`: a session the server would never wake for a trigger (an error of its own making, another
 * agent's engine), so this host does not resume it either.
 */
export interface OfflineSliceSession {
  sid: string; taskId?: string; title?: string; aside?: boolean; noResume?: boolean
  /** The instruction notice for a session spawned before its default instructions changed, sent only while it is due, and the key naming that (instruction-notice.ts). */
  taskRoutingPolicy?: string; taskRoutingDue?: string
  /**
   * The message hints owed to this session right now (core/hints/hint-send.ts hostReplyTail:
   * `<system-reminder>` blocks, e.g. the reply language after a reply drifted). A message this
   * host delivers itself (a peer note or reply between two sessions here) never passes the
   * server's queue, so the host appends them (2026-10-27: same-host peer notes reached the main
   * agent without the language line, and it answered the user in English).
   */
  replyTail?: string
}

export interface OfflineSliceTask {
  id: string
  title: string
  phase?: string
  project?: string
  group_id?: string
  parent_task_id?: string
  description?: string
  updated_at?: string
  session_id?: string
  /** A lead that handed its project over: the lead that took it (org/retired-lead.ts). */
  handed_over_to?: { id: string; title: string; phase?: string }
  /**
   * Journal v2 (docs/plan/walnut-replica-servers-impl.md section 7): the other queueable
   * fields when the server ships them, and the server's per-field write time. A field
   * the copy lacks is queued with `base: 'unknown'`.
   */
  status?: string
  priority?: string
  due_date?: string
  start_date?: string
  end_date?: string
  pinned?: boolean
  tags?: string[]
  summary?: string
  note?: string
  sprint?: string
  unread?: boolean
  focus_tier?: string
  pin_order?: number
  depends_on?: string[]
  wait_until?: string
  field_at?: Record<string, string>
}

/**
 * A pending request the SERVER owns, copied because one party (or both) runs on
 * this host. `fromHost` / `toHost` name the other party's host when it runs
 * elsewhere: an answer to it then travels through the leader.
 */
export interface OfflineSliceRequest {
  id: string
  fromSessionId: string
  toSessionId?: string
  toTaskId?: string
  preview: string
  status: 'pending'
  createdAt: string
  deadlineAt: number
  fromHost?: string
  toHost?: string
}

export interface HostSlice {
  v: 1
  /** The Walnut's data dir: the tenant key (the spawn journal records it per session). */
  home: string
  hash: string
  asOf: number
  /** How this Walnut names this host in envelopes (displayHost). */
  host: string
  sessions: OfflineSliceSession[]
  tasks: OfflineSliceTask[]
  requests: OfflineSliceRequest[]
  /** The Boards of the teams whose sessions run here (offline-board-core.ts). */
  boards?: OfflineSliceBoard[]
  /** A session task's team board: task id → the board's task id. */
  boardOf?: Record<string, string>
}

export type OfflineRequestStatus = 'pending' | 'replied' | 'notified' | 'expired' | 'withdrawn'

/** A request row (same fields as the server's SessionRequest) plus daemon bookkeeping. */
export interface OfflineRequestRow {
  id: string
  fromSessionId: string
  toSessionId: string
  toTaskId?: string
  preview: string
  status: OfflineRequestStatus
  createdAt: string
  deadlineAt: number
  settledAt?: string
  outcome?: EnvelopeOutcome
  /** Turn ends to ignore before "finished without replying" counts (target was mid-turn at delivery). */
  skipTurnEnds?: number
  /** Stream size just before the delivery: only result lines past it can end this message's turn. */
  afterV?: number
  /** Offset of the last result line counted, so a re-read of the stream never counts one twice. */
  lastResultV?: number
  /** The asker runs on another host (named as this Walnut names it): its answer goes through the leader. */
  fromHost?: string
  /**
   * Opened while the server answered (handleLocal): the server speaks for it
   * ("finished without replying", the deadline) while it still answers this
   * host, whether or not it has taken the row yet; this host only when it does not.
   */
  online?: true
}

/**
 * `online`: written while the server answered (a same-host message this host
 * delivered itself, handleLocal). The server takes it within moments, and a
 * relayed call never has to wait for it: the server drains before it answers.
 */
export type OfflineRecord =
  | { seq: number; at: number; online?: true; kind: 'row'; row: OfflineRequestRow }
  | { seq: number; at: number; online?: true; kind: 'settle'; requestId: string; status: 'replied' }
  | { seq: number; at: number; online?: true; kind: 'delivery'; fromSessionId: string; toSessionId: string; toTaskId?: string; messageId: string; requestId?: string; reply?: boolean; routingTold?: string }
  /**
   * `base`: the copy's updated_at for that task when the write was queued (the server's clock).
   * `trigger`: for a trigger pause, resume or delete made here, the trigger as this host ran it,
   * so a resume here can arm it again (the server's set no longer carries a paused trigger).
   */
  | { seq: number; at: number; online?: true; kind: 'op'; op: string; args: Record<string, unknown>; callerSid: string; base?: string; trigger?: OfflineTrigger }
  /**
   * A model, effort or permission mode the cloud companion applied to a live
   * session here while it led (leader.settings, leader.control): the server
   * keeps it on the session's record, so a cold resume starts with it.
   */
  | { seq: number; at: number; online?: true; kind: 'settings'; sid: string; cliModel?: string; effort?: string; mode?: string }
  /**
   * A user stop the cloud companion sent while it led (leader.control), noted
   * before it runs: the server takes it as its own stop request (same id) and
   * runs it through its own stop path when it takes the host back, so a phone
   * message is fenced by the same stop on both servers.
   */
  | { seq: number; at: number; online?: true; kind: 'stop'; sid: string; stopRequestId: string; requestedAt: string }
  /**
   * A stopped session this host resumed itself to hand it a trigger fire no
   * server claimed (deliverTrigger). The server's record still says stopped:
   * it looks at the session again and takes the running CLI back.
   */
  | { seq: number; at: number; online?: true; kind: 'resume'; sid: string; taskId?: string; messageId: string }

/**
 * Journal v2 kinds (offline-journal-core.ts). New names on purpose: an old Mac's drain
 * never receives them (it would apply nothing and ack them), so the daemon writes them
 * only for a Mac whose `leader.configure {drains}` lists them.
 */
export type OfflineFieldWrite = { base: unknown; value: unknown }
export type OfflineRecordV2 =
  | { kind: 'task-fields'; op: 'task_update' | 'task_complete'; taskId: string; fields: Record<string, OfflineFieldWrite> }
  | { kind: 'task-create'; taskId: string; fields: Record<string, unknown>; placement: { parentTaskId?: string; project?: string; groupId?: string; tier?: string }; order?: unknown }
  | { kind: 'task-move'; taskId: string; anchor: { after?: string; before?: string } | null; tier?: string; base?: unknown }
  | { kind: 'board'; op: string; args: Record<string, unknown>; postId?: string }
  | { kind: 'note'; path: string; noteId?: string; mode: 'put' | 'create' | 'delete'; baseHash: string | null; baseBlob: string | null; oursBlob: string | null }
  /** A paired device removed itself while the Mac was away (WP10): the Mac revokes it on drain. */
  | { kind: 'device-revoke'; deviceId: string; name?: string }
  /**
   * A new ask started on this host while the Mac was away (WP12, host-start-core.ts): the Mac adopts it on drain.
   * `routine`: a claude-code routine's run this host started (clock-host-start-v1), not an ask (no agent).
   */
  | { kind: 'session'; sid: string; taskId: string; host: string; cwd: string; agentId?: string; model?: string; effort?: string; mode: string; title: string; startedAt: number; firstMessage?: string
    routine?: { id: string; slotMs: number } }
  /**
   * A session's letter to the user (human_inbox_send) while the Mac was away: the op's
   * arguments but the body, which is the blob `bodyBlob`; the Mac sends it with this id.
   */
  | { kind: 'letter'; letterId: string; format: 'markdown' | 'html'; args: Record<string, unknown>; bodyBlob: string }

/** Every record a drain may hand out: the v1 shapes plus the v2 bookkeeping and kinds. */
export type OfflineJournalRecord = (OfflineRecord | (OfflineRecordV2 & { seq: number; at: number; online?: true })) & {
  v?: 2; opId?: string; rev?: number; actor?: import('./offline-journal-core.js').JournalActor; supersedes?: number
}

/** The v1 field names a gateway task_update overlays (unchanged), and the queueable set of journal v2. */
const QUEUEABLE_TASK_FIELDS = [
  'title', 'status', 'phase', 'priority', 'project', 'group_id', 'due_date', 'start_date', 'end_date', 'pinned', 'tags',
  'summary', 'description', 'note', 'sprint', 'unread', 'focus_tier', 'pin_order', 'depends_on', 'wait_until', 'parent_task_id',
]
export { QUEUEABLE_TASK_FIELDS }

type GatewayResult = { ok: true; result: Record<string, unknown> } | { ok: false; error: { code: string; message: string; retryAfterMs?: number; detail?: unknown } }

export type DeliverResult = { ok: true } | { ok: false; reason: string }

/** A trigger this host runs (the daemon's wire def, trigger-check-core.ts TriggerDef). */
export interface OfflineTrigger {
  id: string
  name: string
  everyMs: number
  check: { run: string; cwd?: string; timeoutSeconds?: number }
  deliver?: { home: string; taskId: string; prompt?: string }
  [key: string]: unknown
}

/** What the daemon knows of an armed trigger right now. */
export interface OfflineTriggerStatus {
  nextRunAtMs?: number
  running?: boolean
  consecutiveErrors?: number
  lastRunAtMs?: number
  lastFireAtMs?: number
  pendingFires?: number
}

/**
 * The daemon's trigger table, for the trigger ops this host answers while its
 * Walnut is away (the checks run here anyway: docs/plan/walnut-trigger.md).
 */
export interface OfflineTriggerTable {
  /** The triggers this daemon runs now. */
  armed(): Array<{ def: OfflineTrigger; status: OfflineTriggerStatus }>
  /** Run a check once and read or write no state (`triggers.test`); rejects with the daemon's refusal. */
  test(check: { run: string; cwd?: string; timeoutSeconds?: number }, triggerId?: string): Promise<Record<string, unknown>>
  /** A pause, resume or delete was made here: arm and disarm by `triggerHolds()` now. */
  changed(): void
  /** A session's working directory, for a test that names none. */
  cwdOf?(sid: string): string | undefined
}

/** The last trigger write made here per id that the server has not taken yet. */
export interface TriggerHold { home: string; on: boolean; deleted?: boolean; def?: OfflineTrigger }

export interface OfflineHostDeps {
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  /** Directory for slice-<key>.json / journal-<key>.json. */
  dir: string
  now: () => number
  randomHex: (bytes: number) => string
  /** Short stable file key for a home (a hash; homes are paths). */
  keyOf: (home: string) => string
  kit: EnvelopeKit
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
  /** The daemon runs a live CLI for this sid. */
  isLive: (sid: string) => boolean
  /** The sid is mid-turn right now (its fold says a turn is open). */
  turnActive: (sid: string) => boolean
  /**
   * The tool the session's CLI waits on the human for (a permission prompt), or
   * null. A message to it is the server's to park until the prompt is answered.
   * Absent: this host never delivers a message itself while the server answers.
   */
  pendingPrompt?: (sid: string) => string | null
  /** The session's stream size now (the byte offset result lines carry as `v`). */
  streamOffset: (sid: string) => number | undefined
  /** Write one user message into the session's FIFO, with a turn-opening marker (send-markers-v1). */
  deliver: (sid: string, text: string, messageId: string) => Promise<DeliverResult>
  /**
   * Start a stopped session of this Walnut again (`--resume`, its last spawn's
   * command) with `text` as its first message. Refuses what this host cannot
   * prove it ran for that Walnut. Absent: a trigger fire for a stopped session
   * waits for the server, as before.
   */
  resume?: (home: string, sid: string, text: string, messageId: string, taskId: string) => Promise<DeliverResult>
  /** A journal grew while a server of that home is connected: ask it to drain. */
  onJournal?: (home: string) => void
  /** A server of that home is connected and answering (not silent, not replaced by the companion). */
  serverAnswers?: (home: string) => boolean
  /**
   * Hand text for a session on ANOTHER host to the server leading this Walnut
   * while its primary is away (the cloud companion, docs/plan/walnut-control-plane.md).
   * Absent, or answering not ok, when nobody leads: the caller is told the
   * primary is needed, as before.
   */
  relay?: (home: string, req: { toHost: string; toSid: string; text: string; messageId: string; requestId?: string; reply?: boolean; fromSessionId?: string }) => Promise<DeliverResult>
  /** Board checks and the copy's overlay; absent: board ops need the server. */
  boards?: BoardOffline
  /** This host's copy of the notes, memory and skills (host-replica-core.ts); absent: those reads need the server. */
  replica?: HostReplica
  /** The post-compaction block's wording (open-items-text.ts); absent: open_items needs the server. */
  openItems?: OpenItemsText
  /** Keyword search of this host's copy (offline-search-core.ts); absent: search needs the server. */
  search?: OfflineSearch
  /** The triggers this daemon runs; absent: the trigger ops need the server. */
  triggers?: OfflineTriggerTable
  /** The letter store's rules (letter-check.ts); absent: a letter to the user needs the server. */
  letters?: LetterCheck
  /**
   * The journal store (offline-journal-core.ts, journal v2). The twins build it (it also
   * migrates v1 journals and answers offline.blob); createOfflineHost builds one in `dir`
   * when absent.
   */
  journal?: import('./offline-journal-core.js').OfflineJournal
  /**
   * The v2 kinds the leading Mac drains (`leader.configure {drains}`), or null for a Mac
   * that sent none: then only v1 kinds are written, and only the v1 prefix is drainable.
   */
  drainsOf?: (home: string) => string[] | null
}

/** A message the leader routes to a session of this host (`leader.deliver`). */
export type LeaderDelivery =
  | {
    kind: 'peer'
    /** The sender, on another host. */
    from: { sid: string; taskId?: string; title?: string; host: string }
    /** A task id (or unique prefix) or a session id on this host. */
    to: string
    text: string
    title?: string
    expect_reply?: boolean
    reply_timeout?: number
    /** A COMPLETE target takes the message only forced, with a reason. */
    force?: boolean
    reason?: string
    messageId?: string
  }
  | {
    kind: 'text'
    /** A session of this Walnut on this host. */
    toSid: string
    /** Already built (a reply envelope, a Walnut notice) by the host it came from. */
    text: string
    messageId?: string
    requestId?: string
    reply?: boolean
    fromSessionId?: string
  }

/**
 * A sender's words escaped as the server's queue escapes them (core/hints/hint-format.ts
 * escapeHintTags, inlined because this file runs in the daemon): only Walnut's own
 * `<system-reminder>` blocks then read as hints, and display gives the words back as typed.
 */
export function escapeSenderWords(text: string): string {
  if (!/system-reminder/i.test(text)) return text
  return text.replace(/(<|&(?:amp;)*lt;)(\/?)(system-reminder)/gi, (_m, open: string, slash: string, name: string) =>
    `${open === '<' ? '&lt;' : `&amp;${open.slice(1)}`}${slash}${name}`)
}

export function createOfflineHostCore(deps: OfflineHostDeps) {
  const { fs, path, kit } = deps
  // The same as the module's escapeSenderWords: the factory body reaches nothing at
  // module scope, because daemon-source.ts inlines only its source text.
  const escapeSenderWords = (text: string): string => {
    if (!/system-reminder/i.test(text)) return text
    return text.replace(/(<|&(?:amp;)*lt;)(\/?)(system-reminder)/gi, (_m, open: string, slash: string, name: string) =>
      `${open === '<' ? '&lt;' : `&amp;${open.slice(1)}`}${slash}${name}`)
  }
  const MAX_RECORDS = 1000
  const MAX_ARGS_BYTES = 256 * 1024
  const WRITE_BUDGET = 30
  const WRITE_WINDOW_MS = 60_000
  /** Waits before running a write again that another process's journal lock refused (whenUnlocked). */
  const LOCK_RETRY_MS = [100, 300, 900]
  const DEFAULT_REPLY_SECS = 3_600
  const IMPLICIT_REPLY_SECS = 6 * 3_600
  const DRAIN_BATCH = 200
  const QUEUED_OPS = ['task_update', 'task_complete']
  /**
   * Inputs task_update retired (its `retiredInput` in src/ops/tasks.ts): dropped, never a
   * reason to refuse, as the server's executor drops them (an older session still sends
   * wait_report with a park; 2026-10-05 such a replay was refused and lost).
   */
  const RETIRED_TASK_INPUTS = ['wait_report']
  /** The fields a task write may queue (task-outbox whitelist plus phase, parent, pinned, focus tier). */
  const QUEUEABLE = [
    'title', 'status', 'phase', 'priority', 'project', 'group_id', 'due_date', 'start_date', 'end_date', 'pinned', 'tags',
    'summary', 'description', 'note', 'sprint', 'unread', 'focus_tier', 'pin_order', 'depends_on', 'wait_until', 'parent_task_id',
  ]
  const OFFLINE_OPS: Array<{ name: string; title: string; description: string; readonly: boolean; signature: string }> = [
    { name: 'task_get', title: 'Get one task (offline copy)', description: 'A task of a session on this host, from the copy the Walnut server last pushed.', readonly: true, signature: 'id' },
    { name: 'task_list', title: 'List tasks on this host (offline copy)', description: 'Tasks of the sessions on this host, their parents and children.', readonly: true, signature: '[q] [limit]' },
    { name: 'session_list', title: 'List sessions on this host', description: 'This Walnut\'s sessions on this host and whether each is running.', readonly: true, signature: '' },
    { name: 'task_send', title: 'Message a task on this host', description: 'Delivered by this host directly; the target must be running here. Replies and notices work as usual.', readonly: false, signature: 'to text [expect_reply] [reply_timeout] [in_reply_to] [force reason] [messageId]' },
    { name: 'request_get', title: 'Read a reply-request status', description: 'Requests this host holds.', readonly: true, signature: 'id' },
    { name: 'task_update', title: 'Update a task (queued)', description: 'Saved here and applied when the Walnut server reconnects.', readonly: false, signature: 'id ...fields' },
    { name: 'task_complete', title: 'Complete a task (queued)', description: 'Saved here and applied when the Walnut server reconnects.', readonly: false, signature: 'id' },
  ]
  if (deps.boards) {
    OFFLINE_OPS.push(
      { name: 'board_get', title: 'Read your team\'s Board (copy on this host)', description: 'The Board this host keeps for its teams, with the writes made here since.', readonly: true, signature: '[task]' },
      { name: 'board_set', title: 'Write the whole Board (applied here, sent later)', description: 'Applied to this host\'s copy now and to Walnut when the server reconnects.', readonly: false, signature: '[task] html [version]' },
      { name: 'board_edit', title: 'Edit the Board in place (applied here, sent later)', description: 'Exact-string edits, as online; applied to this host\'s copy now and to Walnut when the server reconnects.', readonly: false, signature: '[task] edits [version]' },
      { name: 'board_post', title: 'Post in a Board thread (applied here, sent later)', description: 'Applied to this host\'s copy now and to Walnut when the server reconnects.', readonly: false, signature: '[task] thread text' },
      { name: 'board_project_set', title: 'Set a Board project (applied here, sent later)', description: 'Applied to this host\'s copy now and to Walnut when the server reconnects.', readonly: false, signature: '[task] id ...fields' },
    )
  }
  if (deps.search) {
    OFFLINE_OPS.push({ name: 'search', title: 'Search Walnut (copy on this host)', description: 'Keyword search of the tasks and sessions this host keeps, and its copy of the memory; the server\'s semantic ranking and its transcripts need the server.', readonly: true, signature: 'q [types] [limit]' })
  }
  if (deps.openItems) {
    OFFLINE_OPS.push({ name: 'open_items', title: 'What is still open for your task (copy on this host)', description: 'Unfinished subtasks and pending reply requests, as this host\'s copy has them; also what Walnut puts into your context after a compaction.', readonly: true, signature: '[hook]' })
  }
  // The checks run on this host, so it answers for them itself (pause, resume and
  // delete take effect here at once and reach Walnut when the server is back).
  const TRIGGER_WRITE_OPS = ['trigger_pause', 'trigger_resume', 'trigger_delete']
  if (deps.triggers) {
    OFFLINE_OPS.push(
      { name: 'trigger_list', title: 'List the triggers this host runs', description: 'The triggers this host checks for this Walnut, with their last check and next run, as this host has them now.', readonly: true, signature: '' },
      { name: 'trigger_test', title: 'Test a check script on this host', description: 'Run a check once here and report what it printed and whether it would fire; reads and writes no state.', readonly: false, signature: 'run [cwd] [timeoutSeconds] [id]' },
      { name: 'trigger_pause', title: 'Pause a trigger this host runs (applied here, sent later)', description: 'This host stops checking it now; Walnut records the pause when the server reconnects.', readonly: false, signature: 'id' },
      { name: 'trigger_resume', title: 'Resume a trigger paused on this host (applied here, sent later)', description: 'Only a trigger paused here while the server was away; this host checks it again now.', readonly: false, signature: 'id' },
      { name: 'trigger_delete', title: 'Delete a trigger this host runs (applied here, sent later)', description: 'This host stops checking it now; Walnut deletes it when the server reconnects.', readonly: false, signature: 'id' },
    )
  }
  OFFLINE_OPS.push({ name: 'walnut_status', title: 'Walnut status (this host, server away)', description: 'That the Walnut server is not answering this host, how old this host\'s copy is, and what this host answers meanwhile.', readonly: true, signature: '' })
  const OFFLINE_NAMES = OFFLINE_OPS.map((o) => o.name).join(', ')
  /** Reads this host answers from its slice: safe to answer here when the server does not (nothing to apply twice). */
  const READ_OPS = OFFLINE_OPS.filter((o) => o.readonly).map((o) => o.name)
  /** A letter to the user, saved here: only for a Mac that drains `letter` (an older one never would send it). */
  const LETTER_OP = {
    name: 'human_inbox_send', title: 'Send the human a letter (saved here, sent later)',
    description: 'Checked as online and saved on this host; it reaches the user\'s inbox, with its id, when the Walnut server is back. A payload over 1 MB (one that rides in a file) needs the server.',
    readonly: false, signature: 'subject type markdown|html [text] [actions] [task_refs] [pin]',
  }
  /** The ops this host answers for `home` (tools.list, walnut_status): a letter only when the leading Mac drains it. */
  function awayOps(home: string): typeof OFFLINE_OPS {
    return deps.letters && drainsKind(home, 'letter') ? OFFLINE_OPS.concat([LETTER_OP]) : OFFLINE_OPS
  }

  /** How long a drained-but-unacked row is left to the server before this host acts on it again. */
  const HANDOVER_GRACE_MS = 60_000

  const slices = new Map<string, HostSlice>()
  const journal = deps.journal!
  const writes = new Map<string, number[]>()
  /** Rows the server is taking right now (drained, not yet acked): no notice from here. */
  const handingOver = new Map<string, number>()

  function fail(code: string, message: string, extra?: { retryAfterMs?: number; detail?: unknown }): GatewayResult {
    return { ok: false, error: { code, message, ...(extra ?? {}) } }
  }

  function ok(result: Record<string, unknown>): GatewayResult {
    return { ok: true, result }
  }

  function file(kind: 'slice' | 'journal', home: string): string {
    return path.join(deps.dir, `${kind}-${deps.keyOf(home)}.json`)
  }

  function writeAtomic(target: string, value: unknown): void {
    try {
      fs.mkdirSync(deps.dir, { recursive: true, mode: 0o700 })
      const tmp = `${target}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
      fs.renameSync(tmp, target)
    } catch (err) {
      deps.log('warn', 'offline host: persist failed', { file: target, error: (err as Error).message })
    }
  }

  function readJson<T>(target: string): T | null {
    try { return JSON.parse(fs.readFileSync(target, 'utf8')) as T } catch { return null }
  }

  /** Load every persisted slice (the journal store loads its journals itself, slice or not). */
  function load(): void {
    let names: string[] = []
    try { names = fs.readdirSync(deps.dir) } catch { return }
    for (const name of names) {
      if (!name.startsWith('slice-') || !name.endsWith('.json')) continue
      const slice = readJson<HostSlice>(path.join(deps.dir, name))
      if (!slice || slice.v !== 1 || typeof slice.home !== 'string') continue
      // Read again after the boot migration copied slices here: a copy a Mac sent since wins.
      const mine = slices.get(slice.home)
      if (mine && Number(mine.asOf ?? 0) >= Number(slice.asOf ?? 0)) continue
      slices.set(slice.home, slice)
    }
  }

  /** The request rows and settled copies kept beside the records (a live object). */
  function journalOf(home: string): { rows: Record<string, OfflineRequestRow>; settledCopies: string[] } {
    return journal.state(home) as { rows: Record<string, OfflineRequestRow>; settledCopies: string[] }
  }

  function persistJournal(home: string): void {
    journal.persist(home)
  }

  /** The pending records of a home, in seq order (folded: one per op). */
  function recordsOf(home: string): OfflineJournalRecord[] {
    return journal.records(home) as unknown as OfflineJournalRecord[]
  }

  /** The kinds the leading Mac drains, or null for a Mac that sent none. */
  function drainsOf(home: string): string[] | null {
    try { return deps.drainsOf ? deps.drainsOf(home) : null } catch { return null }
  }

  function drainsKind(home: string, kind: string): boolean {
    const kinds = drainsOf(home)
    return !!kinds && kinds.indexOf(kind) !== -1
  }

  // Distributive over the union: an `Omit` of the whole union would collapse it.
  type NewRecord = OfflineRecord extends infer R ? R extends OfflineRecord ? Omit<R, 'seq' | 'at' | 'online'> : never : never

  /**
   * Save one record. A refusal (full disk, a lost lock, a daemon that no longer owns its
   * dir) is answered, never swallowed: a queued write tells its caller (journal_unwritable).
   */
  function append(
    home: string, record: NewRecord | (OfflineRecordV2 & Record<string, unknown>), online = false,
    opts: { actor?: import('./offline-journal-core.js').JournalActor; opId?: string; coalesce?: boolean; limit?: boolean; admit?: () => GatewayResult | null } = {},
  ): import('./offline-journal-core.js').AppendResult {
    const kind = (record as { kind: string }).kind
    if (kind === 'row' || kind === 'settle') journal.markDirty(home)
    // A delivery this host led with the routing notice tells the server it was said.
    if (kind === 'delivery') {
      const mid = (record as { messageId?: unknown }).messageId
      const due = typeof mid === 'string' ? routedMids.get(mid) : undefined
      if (due) { routedMids.delete(mid as string); (record as { routingTold?: string }).routingTold = due }
    }
    const callerSid = (record as { callerSid?: unknown }).callerSid
    const actor = opts.actor ?? (typeof callerSid === 'string' && callerSid ? { kind: 'session' as const, sid: callerSid } : undefined)
    const r = journal.append(home, record as unknown as Record<string, unknown>, {
      online, coalesce: opts.coalesce === true, ...(actor ? { actor } : {}), ...(opts.opId ? { opId: opts.opId } : {}),
      ...(opts.limit ? { limit: true } : {}),
      ...(opts.admit ? { admit: opts.admit as () => { ok: false; error: { code: string; message: string; retryAfterMs?: number } } | null } : {}),
    })
    if (!r.ok) {
      // A lock another process holds is logged per try by whenUnlocked and by the journal.
      if (r.code === 'journal_unwritable' && r.why !== 'locked') deps.log('error', 'offline host: journal write refused', { home, kind, code: r.code, why: r.why, error: r.message })
      return r
    }
    if (!r.duplicate) { try { deps.onJournal?.(home) } catch { /* a notify failure never loses the record */ } }
    return r
  }

  function refusal(r: import('./offline-journal-core.js').AppendResult): GatewayResult | null {
    if (r.ok) return null
    return fail(r.code, r.message, { ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}), ...(r.why ? { detail: { why: r.why } } : {}) })
  }

  const lockRefused = (r: GatewayResult): boolean =>
    !r.ok && r.error.code === 'journal_unwritable' && (r.error.detail as { why?: unknown } | undefined)?.why === 'locked'

  /**
   * One queued write, run again off the loop while another process holds the journal lock
   * (LOCK_RETRY_MS, about 1.3 s in all): the lock's sync spin keeps its 250 ms bound, since
   * it holds this daemon's loop, and the caller's answer waits instead. CI run 39591505260:
   * two daemons on one journal on a loaded runner, and one write was refused. A locked
   * refusal is thrown before anything is written (and before the write budget is charged),
   * so running the write again never makes a second record. Only `why: 'locked'`: a full
   * disk or a lost dir answers at once.
   */
  async function whenUnlocked(home: string, op: string, run: () => GatewayResult): Promise<GatewayResult> {
    const t0 = Date.now()
    let r = run()
    for (const ms of LOCK_RETRY_MS) {
      if (!lockRefused(r)) return r
      deps.log('warn', 'offline host: the journal is locked by another process; trying the write again', { home, op, waitedMs: Date.now() - t0, retryInMs: ms })
      await new Promise((resolve) => setTimeout(resolve, ms))
      r = run()
    }
    if (lockRefused(r)) deps.log('error', 'offline host: the journal stayed locked; write refused', { home, op, waitedMs: Date.now() - t0 })
    return r
  }

  function configure(slice: HostSlice): { changed: boolean } {
    if (!slice || slice.v !== 1 || typeof slice.home !== 'string' || !slice.home) throw new Error('host.slice: bad slice')
    const prev = slices.get(slice.home)
    const changed = !prev || prev.hash !== slice.hash
    slices.set(slice.home, slice)
    if (changed) writeAtomic(file('slice', slice.home), slice)
    // A settle made offline for a server-owned copy is spoken for once the server
    // stops listing that request as pending: drop the local marker with it.
    // A journal on disk for this Walnut (one migrated, or written by another process) is its own.
    journal.adopt(slice.home)
    const j = journalOf(slice.home)
    if (j.settledCopies.length) {
      const pending = new Set(slice.requests.map((r) => r.id))
      const kept = j.settledCopies.filter((id) => pending.has(id))
      if (kept.length !== j.settledCopies.length) { j.settledCopies = kept; persistJournal(slice.home) }
    }
    return { changed }
  }

  /**
   * This daemon holds exactly the copy `hash` for `home` (a probe, host-slice-probe-v1).
   * Holding it, the copy is as fresh as the Mac's probe: `asOf` moves to its time.
   */
  function holdsSlice(home: string, hash: string, asOf?: unknown): boolean {
    const held = home && hash ? slices.get(home) : undefined
    if (!held || held.hash !== hash) return false
    if (typeof asOf === 'number' && Number.isFinite(asOf) && asOf > Number(held.asOf ?? 0)) held.asOf = asOf
    return true
  }

  function hasHome(home: string | undefined): boolean {
    return !!home && slices.has(home)
  }

  /** The Walnut whose copy lists this session (at most one: session ids are UUIDs). */
  function ownerOf(sid: string): string | undefined {
    for (const [home, slice] of slices) if (slice.sessions.some((s) => s.sid === sid)) return home
    for (const [home, started] of hostStarted) if (started.has(sid)) return home
    return undefined
  }

  // ── Sessions started here while the Mac was away (WP12, replica-start-v1) ──
  // The slice overlay: a `session` record makes the session this Walnut's on this host
  // (ownerOf, the gateway, follower.send) before the Mac has adopted it, and after its
  // ack until the Mac's next slice lists it. Kept in memory; the pending records rebuild it.
  const hostStarted = new Map<string, Map<string, OfflineSliceSession>>()
  function noteStarted(home: string, s: { sid: string; taskId?: string; title?: string }): void {
    const m = hostStarted.get(home) ?? new Map<string, OfflineSliceSession>()
    m.set(s.sid, { sid: s.sid, ...(s.taskId ? { taskId: s.taskId } : {}), ...(s.title ? { title: s.title } : {}) })
    hostStarted.set(home, m)
  }
  function startedOf(home: string): OfflineSliceSession[] {
    for (const r of recordsOf(home)) if (r.kind === 'session' && !hostStarted.get(home)?.has(r.sid)) noteStarted(home, r)
    const listed = new Set((slices.get(home)?.sessions ?? []).map((s) => s.sid))
    const m = hostStarted.get(home)
    if (!m) return []
    // The Mac's slice lists it now: the slice row wins and this one goes.
    for (const sid of [...m.keys()]) if (listed.has(sid)) m.delete(sid)
    return [...m.values()]
  }
  /**
   * Whether this Walnut's copy names the session, or a `session` record journaled here
   * does (pending, or acked and not yet in the Mac's next copy). Reads the journal, so it
   * holds across a daemon restart, unlike the in-memory overlay alone.
   */
  function knowsSession(home: string, sid: string): boolean {
    if (!sid) return false
    if ((slices.get(home)?.sessions ?? []).some((s) => s.sid === sid)) return true
    return startedOf(home).some((s) => s.sid === sid)
  }

  /** Who asked for a host-started session, or why its record could not be kept. */
  function sessionActor(home: string, sid: string, by: unknown): { ok: true; actor: import('./offline-journal-core.js').JournalActor } | { ok: false; refused: GatewayResult } {
    if (!slices.get(home)) return { ok: false, refused: fail('not_found', 'this host holds no copy for that Walnut') }
    // Who asked: the paired device the replica names (the Mac drops a record of a device
    // no longer paired); absent, the session itself.
    const actor = by === undefined ? { kind: 'session' as const, sid } : actorOf(by)
    if (!actor) return { ok: false, refused: fail('bad_request', 'follower.start: bad actor') }
    if (actor.kind === 'device' && !drainsKind(home, 'device-actor')) return { ok: false, refused: fail('needs_leader', 'your Mac runs an older Walnut that cannot take a new ask later; it needs your Mac', { detail: { why: 'mac_too_old' } }) }
    if (!drainsKind(home, 'session')) return { ok: false, refused: fail('needs_leader', 'your Mac runs an older Walnut that cannot take a new ask later; it needs your Mac', { detail: { why: 'mac_too_old' } }) }
    const denied = roomFor(home)
    if (denied) return { ok: false, refused: denied }
    return { ok: true, actor }
  }

  /** Whether a host-started session's record would be kept (noteSession's checks), journaling nothing: the twin asks before it starts a CLI. */
  function checkSession(home: string, sid: string, by?: unknown): GatewayResult {
    const a = sessionActor(home, sid, by)
    return a.ok ? ok({ checked: true, sid }) : a.refused
  }

  /**
   * Whether a claude-code routine's run may be started here (clock-host-start-v1): its
   * `task-create` and `session` records would be kept, for a Mac that adopts a routine's
   * session (`routine-run` in its drains; an older Mac would take it for an ask). Journals nothing.
   */
  function checkRoutineRun(home: string, sid: string): GatewayResult {
    return routineRoom(home) ?? checkSession(home, sid)
  }

  function routineRoom(home: string): GatewayResult | null {
    if (!slices.get(home)) return fail('not_found', 'this host holds no copy for that Walnut')
    if (!drainsKind(home, 'task-create') || !drainsKind(home, 'session') || !drainsKind(home, 'routine-run')) {
      return fail('needs_leader', 'your Mac runs an older Walnut that cannot take a routine run started here; it waits for your Mac', { detail: { why: 'mac_too_old' } })
    }
    return roomFor(home)
  }

  /**
   * Journal the task a routine run starts on (clock-host-start-v1), under the routine as
   * its actor (`{kind:'trigger', id}`: the Mac files it with a person's defaults, which the
   * fields set: not pinned). `opId` is derived from the run, so a retry is the same record.
   */
  function noteRoutineTask(
    home: string, rec: { taskId: string; fields: Record<string, unknown>; placement: { project?: string } }, opId: string, jobId: string,
  ): GatewayResult {
    const room = routineRoom(home)
    if (room) return room
    if (!OP_ID_RE.test(opId) || !OP_ID_RE.test(rec.taskId) || typeof jobId !== 'string' || !jobId) return fail('bad_request', 'routine task: bad ids')
    const bad = Object.keys(rec.fields).filter((k) => QUEUEABLE.indexOf(k) === -1)
    if (bad.length) return fail('bad_request', `routine task: ${bad.join(', ')} cannot be queued`)
    const record = { kind: 'task-create' as const, taskId: rec.taskId, fields: rec.fields, placement: { ...(typeof rec.placement?.project === 'string' ? { project: rec.placement.project } : {}) } }
    const saved = append(home, record as OfflineRecordV2 & Record<string, unknown>, false, { actor: { kind: 'trigger', id: jobId }, opId, limit: true })
    if (!saved.ok) return refusal(saved) ?? fail('journal_unwritable', 'the routine task was not saved')
    deps.log('info', 'offline host: a routine run made its task here while the Mac is away', { home, taskId: rec.taskId, jobId, seq: saved.seq, ...(saved.duplicate ? { duplicate: true } : {}) })
    return ok({ queued: true, offline: true, kind: 'task-create', seq: saved.seq, taskId: rec.taskId, ...(saved.duplicate ? { duplicate: true } : {}) })
  }

  /**
   * Journal a host-started session (the twin calls this once its CLI runs).
   * Written only for a Mac that drains `session`; an older one: needs_leader mac_too_old.
   */
  function noteSession(home: string, rec: Extract<OfflineRecordV2, { kind: 'session' }>, opId?: string, by?: unknown): GatewayResult {
    const a = sessionActor(home, rec.sid, by)
    if (!a.ok) return a.refused
    const actor = a.actor
    const saved = append(home, rec as OfflineRecordV2 & Record<string, unknown>, false, { actor, ...(opId ? { opId } : {}), limit: true })
    if (!saved.ok) return refusal(saved) ?? fail('journal_unwritable', 'the session record was not saved')
    noteStarted(home, rec)
    deps.log('info', 'offline host: a session started here while the Mac is away', { home, sid: rec.sid, taskId: rec.taskId, seq: saved.seq })
    return ok({ queued: true, offline: true, kind: 'session', seq: saved.seq, sid: rec.sid, taskId: rec.taskId })
  }

  /**
   * Records made while the server was away that it has not taken yet: while any
   * exist the gateway answers here. A record made while it answered (`online`)
   * holds nothing back: the server drains it before it answers a relayed call.
   */
  function pendingHandover(home: string | undefined): boolean {
    // Only what the leading Mac can drain counts: a record parked for a newer Mac never
    // pins the gateway (or the follower) away.
    return !!home && journal.drainableRecords(home, drainsOf(home)).some((r) => !r.online)
  }

  /**
   * The server's next batch. `kinds` (journal-v2): the v2 kinds it applies; absent (an old
   * Mac), only the v1 prefix before the first record it cannot take is handed out.
   */
  function drain(home: string, kinds?: string[] | null): { records: OfflineJournalRecord[]; more: boolean; now: number; error?: string; why?: string } {
    const out = journal.drain(home, { kinds: Array.isArray(kinds) ? kinds.filter((k) => typeof k === 'string') : null, batch: DRAIN_BATCH })
    // The server may notice a row it just imported; this host stays quiet on it
    // meanwhile, or the asker could hear twice.
    for (const r of out.records) if (r.kind === 'row') handingOver.set((r as unknown as { row: OfflineRequestRow }).row.id, deps.now())
    return out as unknown as { records: OfflineJournalRecord[]; more: boolean; now: number; error?: string; why?: string }
  }

  function isHandingOver(id: string): boolean {
    const at = handingOver.get(id)
    if (at === undefined) return false
    if (deps.now() - at < HANDOVER_GRACE_MS) return true
    handingOver.delete(id)
    return false
  }

  /** The companion, leading, changed a session's model or effort here: the server takes it on its next drain. */
  function noteSettings(home: string, sid: string, settings: { cliModel?: string; effort?: string; mode?: string }): void {
    append(home, {
      kind: 'settings', sid,
      ...(settings.cliModel ? { cliModel: settings.cliModel } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
      ...(settings.mode ? { mode: settings.mode } : {}),
    })
  }

  function noteStop(home: string, sid: string, stop: { id: string; requestedAt: string }): void {
    append(home, { kind: 'stop', sid, stopRequestId: stop.id, requestedAt: stop.requestedAt })
  }

  /**
   * The server applied (or gave up on) records: `seqs` names them exactly (journal-v2); a
   * number is an old Mac's `upTo`, which drops only seqs a drain handed it. Then the rows
   * it now owns are dropped too.
   */
  /**
   * The leading server's clock minus this host's, per home, measured at its last ack
   * (`leaderNow`, its Date.now() as it sent the ack, after it applied the records). A
   * host replica puts its own time of an ack on the Mac's clock with it, to compare it
   * with a copy manifest's asOf (overlay.ts). The ack's travel makes it short by that
   * delay, which only moves the replica's estimate later than the Mac's ack: never early.
   */
  const leaderOffsets = new Map<string, number>()
  function ack(home: string, req: number | { seqs?: unknown; upTo?: unknown; leaderNow?: unknown }): { remaining: number; ignored?: number[]; error?: string } {
    const asked = typeof req === 'number' ? { upTo: req } : (req ?? {})
    if (typeof asked.upTo !== 'number' && !Array.isArray(asked.seqs)) return { remaining: recordsOf(home).length }
    const leaderNow = (asked as { leaderNow?: unknown }).leaderNow
    if (typeof leaderNow === 'number' && Number.isFinite(leaderNow)) leaderOffsets.set(home, Math.round(leaderNow - deps.now()))
    const r = journal.ack(home, { ...(Array.isArray(asked.seqs) ? { seqs: asked.seqs } : {}), ...(typeof asked.upTo === 'number' ? { upTo: asked.upTo } : {}) })
    // WP11: a note the Mac took stays held here until a copy round from after this ack.
    notesAcked(home, r.acked as unknown as Array<Record<string, unknown>>, typeof leaderNow === 'number' && Number.isFinite(leaderNow) ? leaderNow : deps.now() + (leaderOffsets.get(home) ?? 0))
    const handed = new Set<string>()
    for (const x of r.acked) if (x.kind === 'row') handed.add((x as unknown as { row: OfflineRequestRow }).row.id)
    // A row whose latest state the server took is the server's now; a later
    // record for it (written during the handover) keeps it here one more round.
    const stillOwed = new Set(recordsOf(home).filter((x) => x.kind === 'row').map((x) => (x as { row: OfflineRequestRow }).row.id))
    const j = journalOf(home)
    let changed = false
    for (const id of handed) {
      handingOver.delete(id)
      if (!stillOwed.has(id) && id in j.rows) { delete j.rows[id]; changed = true }
    }
    if (changed) persistJournal(home)
    return { remaining: r.remaining, ...(r.ignored.length ? { ignored: r.ignored } : {}), ...(r.error ? { error: r.error } : {}) }
  }

  // ── lookups over the copy ──

  function tasksWithOverlay(home: string): OfflineSliceTask[] {
    const slice = slices.get(home)
    if (!slice) return []
    const overlay = new Map<string, Record<string, unknown>>()
    const created: OfflineSliceTask[] = []
    for (const r of recordsOf(home)) {
      if (r.kind === 'task-create') {
        // A task made here (a host-started ask's own), so its session finds it.
        const p = r.placement ?? {}
        created.push({
          ...(r.fields as Record<string, unknown>), id: r.taskId, title: String((r.fields as { title?: unknown }).title ?? ''),
          ...(p.parentTaskId ? { parent_task_id: p.parentTaskId } : {}), ...(p.project !== undefined ? { project: p.project } : {}),
          ...(p.groupId ? { group_id: p.groupId } : {}), ...(p.tier ? { focus_tier: p.tier } : {}),
        } as OfflineSliceTask)
        continue
      }
      if (r.kind === 'task-fields') {
        const cur = overlay.get(r.taskId) ?? {}
        for (const [k, w] of Object.entries(r.fields ?? {})) cur[k] = (w as OfflineFieldWrite).value
        overlay.set(r.taskId, cur)
        continue
      }
      if (r.kind === 'task-move') {
        if (r.tier) { const cur = overlay.get(r.taskId) ?? {}; cur.focus_tier = r.tier; overlay.set(r.taskId, cur) }
        continue
      }
      if (r.kind !== 'op' || QUEUED_OPS.indexOf(r.op) === -1) continue
      const id = String(r.args.id ?? '')
      const cur = overlay.get(id) ?? {}
      if (r.op === 'task_complete') cur.phase = 'COMPLETE'
      else for (const k of ['title', 'description', 'phase', 'note', 'summary']) {
        if (typeof r.args[k] === 'string') cur[k] = r.args[k]
      }
      overlay.set(id, cur)
    }
    const base = slice.tasks.concat(created.filter((c) => !slice.tasks.some((t) => t.id === c.id)))
    return base.map((t) => (overlay.has(t.id) ? { ...t, ...overlay.get(t.id), queued_offline: true } as OfflineSliceTask : created.indexOf(t) !== -1 ? { ...t, queued_offline: true } as OfflineSliceTask : t))
  }

  function resolveTask(home: string, ref: string): { task?: OfflineSliceTask; error?: GatewayResult } {
    const id = ref.trim()
    const tasks = tasksWithOverlay(home)
    const exact = tasks.find((t) => t.id === id)
    if (exact) return { task: exact }
    const hits = id.length >= 4 ? tasks.filter((t) => t.id.startsWith(id)) : []
    if (hits.length === 1) return { task: hits[0] }
    if (hits.length > 1) {
      return { error: fail('ambiguous_peer', `"${id}" matches ${hits.length} tasks on this host`, { detail: { candidates: hits.map((t) => ({ id: t.id, shortId: t.id, title: t.title })) } }) }
    }
    return {}
  }

  function sessionOf(home: string, sid: string): OfflineSliceSession | undefined {
    return slices.get(home)?.sessions.find((s) => s.sid === sid) ?? startedOf(home).find((s) => s.sid === sid)
  }

  /** sid -> the due key this host already led a delivery with (instruction-notice.ts). */
  const routingTold = new Map<string, string>()
  /** messageId -> due key, until that delivery's record is journaled (append). */
  const routedMids = new Map<string, string>()

  /**
   * The text a session spawned before its instructions changed gets: led by the notice while the
   * server says it is due and this host has not delivered it under that key.
   * `restate` (the compaction hook) states it whatever was said before.
   */
  function withTaskRouting(home: string, sid: string, text: string, restate = false): { text: string; due?: string } {
    const row = sessionOf(home, sid)
    const policy = row?.taskRoutingPolicy
    const due = row?.taskRoutingDue
    // A slash command runs only when the raw input starts with "/".
    if (!policy || !due || text.trimStart().startsWith('/')) return { text }
    if (!restate && routingTold.get(sid) === due) return { text }
    let rest = text.trimStart()
    while (rest.startsWith('<walnut-message ')) {
      const end = rest.indexOf('</walnut-message>')
      if (end < 0) break
      const envelope = rest.slice(0, end + '</walnut-message>'.length)
      if (envelope === policy) return { text }
      rest = rest.slice(end + '</walnut-message>'.length).trimStart()
    }
    return restate ? { text: `${policy}\n\n${text}` } : { text: `${policy}\n\n${text}`, due }
  }

  function markRouted(sid: string, messageId: string, due: string): void {
    routingTold.set(sid, due)
    routedMids.set(messageId, due)
    if (routedMids.size > 200) routedMids.delete(routedMids.keys().next().value as string)
  }

  /**
   * The text with the session's reply tail after it, never on a slash command. A tail line is
   * left out when the text already holds a line of its kind (same opening 12 characters, so a
   * leader's text that carries the full rich instruction does not also get the reminder).
   */
  function withReplyTail(home: string, sid: string, text: string): string {
    const tail = sessionOf(home, sid)?.replyTail
    if (!tail || text.trimStart().startsWith('/')) return text
    // Message-hint blocks (core/hints/hint-format.ts) go whole, once.
    if (tail.includes('<system-reminder>')) return text.includes(tail) ? text : `${text}\n\n${tail}`
    const kinds = new Set(text.split('\n').map((l) => l.trim().slice(0, 12)))
    const missing = tail.split('\n').map((l) => l.trim()).filter((l) => l && !kinds.has(l.slice(0, 12)))
    return missing.length ? `${text}\n\n${missing.join('\n\n')}` : text
  }

  async function deliverWithTaskRouting(home: string, sid: string, text: string, messageId: string): Promise<DeliverResult> {
    const routed = withTaskRouting(home, sid, withReplyTail(home, sid, text))
    const delivered = await deps.deliver(sid, routed.text, messageId)
    if (delivered.ok && routed.due) markRouted(sid, messageId, routed.due)
    return delivered
  }

  async function resumeWithTaskRouting(home: string, sid: string, text: string, messageId: string, taskId: string): Promise<DeliverResult> {
    const routed = withTaskRouting(home, sid, withReplyTail(home, sid, text))
    const resumed = await deps.resume!(home, sid, routed.text, messageId, taskId)
    if (resumed.ok && routed.due) markRouted(sid, messageId, routed.due)
    return resumed
  }

  /**
   * The server's expect_reply default (core/sessions/reply-direction.ts): a note up the org reports and
   * asks for no reply. This copy carries the parent links, not org roles, so here "up" is the sender's
   * own leaders; a note to Main or a project's VP keeps the old default (both run beside the server).
   */
  function reportsUp(home: string, fromTaskId: string | undefined, toTaskId: string | undefined): boolean {
    if (!fromTaskId || !toTaskId || fromTaskId === toTaskId) return false
    const byId = new Map(tasksWithOverlay(home).map((t) => [t.id, t] as const))
    const seen = new Set<string>()
    for (let t = byId.get(fromTaskId); t?.parent_task_id && !seen.has(t.id); t = byId.get(t.parent_task_id)) {
      seen.add(t.id)
      if (t.parent_task_id === toTaskId) return true
    }
    return false
  }

  function callerIdentity(home: string, sid: string): { title: string; taskId?: string } {
    const row = sessionOf(home, sid)
    const taskId = row?.taskId
    const title = row?.title ?? (taskId ? slices.get(home)?.tasks.find((t) => t.id === taskId)?.title : undefined) ?? ''
    return { title, taskId }
  }

  function asOf(home: string): string {
    const at = slices.get(home)?.asOf
    return typeof at === 'number' ? new Date(at).toISOString() : 'unknown'
  }

  function offlineNote(home: string): string {
    return `The Walnut server is not reachable from this host right now; this host answered from its copy as of ${asOf(home)}.`
  }

  /** `home` names the ops this host answers for that Walnut (a letter, say); without it, the fixed list. */
  function needsServer(what: string, home?: string): GatewayResult {
    const names = home === undefined ? OFFLINE_NAMES : awayOps(home).map((o) => o.name).join(', ')
    return fail('hub_unreachable', `${what} needs the Walnut server, which is not answering this host right now. Meanwhile this host still answers: ${names}.`)
  }

  function admitWrite(callerSid: string): GatewayResult | null {
    const now = deps.now()
    const recent = (writes.get(callerSid) ?? []).filter((t) => now - t < WRITE_WINDOW_MS)
    if (recent.length >= WRITE_BUDGET) {
      return fail('throttled', 'too many offline writes, slow down', { retryAfterMs: WRITE_WINDOW_MS - (now - recent[0]) })
    }
    recent.push(now)
    writes.set(callerSid, recent)
    return null
  }

  function roomFor(home: string): GatewayResult | null {
    return recordsOf(home).length >= MAX_RECORDS
      ? fail('queue_full', `this host already holds ${MAX_RECORDS} records for the Walnut server; wait for it to reconnect`)
      : null
  }

  function messageId(given: unknown): string {
    return typeof given === 'string' && /^qm-[A-Za-z0-9-]{1,64}$/.test(given) ? given : `qm-offline-${deps.randomHex(8)}`
  }

  function clampSecs(secs: unknown, implicit: boolean): number {
    if (typeof secs !== 'number' || !Number.isFinite(secs)) return implicit ? IMPLICIT_REPLY_SECS : DEFAULT_REPLY_SECS
    return Math.min(86_400, Math.max(60, Math.floor(secs)))
  }

  // ── ops ──

  function opTaskGet(home: string, args: Record<string, unknown>): GatewayResult {
    const ref = typeof args.id === 'string' ? args.id : ''
    if (!ref) return fail('bad_request', 'task_get needs "id"')
    const { task, error } = resolveTask(home, ref)
    if (error) return error
    if (!task) return needsServer(`Task ${ref} is not in this host's offline copy; reading it`)
    const running = (slices.get(home)?.sessions ?? []).some((s) => s.taskId === task.id && deps.isLive(s.sid))
    return ok({
      task: { ...task, execution: { state: running ? 'running' : 'unknown' } },
      offline: true, as_of: asOf(home),
      outcome: `Task phase: ${task.phase ?? 'unknown'} (offline copy). ${offlineNote(home)}`,
      next: 'Nothing else is required.',
    })
  }

  function opTaskList(home: string, args: Record<string, unknown>): GatewayResult {
    const q = typeof args.q === 'string' ? args.q.trim().toLowerCase() : ''
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(500, Math.floor(args.limit)) : 50
    const all = tasksWithOverlay(home).filter((t) => !q || t.title.toLowerCase().includes(q) || t.id.startsWith(q))
    return ok({
      scope: 'this-host', offline: true, as_of: asOf(home),
      count: Math.min(limit, all.length), total: all.length, truncated: all.length > limit,
      tasks: all.slice(0, limit),
      hint: `${offlineNote(home)} Only tasks of this host's sessions (and their parents and children) are listed.`,
    })
  }

  /** `search` from this host's copy: its tasks (with the writes made here), its sessions, its memory copy. */
  function opSearch(home: string, args: Record<string, unknown>): GatewayResult {
    const slice = slices.get(home)
    const tasks = tasksWithOverlay(home) as Array<OfflineSliceTask & { note?: string; summary?: string }>
    const titleOf = new Map(tasks.map((t) => [t.id, t.title]))
    const sessions = (slice?.sessions ?? []).filter((x) => !x.aside).map((x) => ({
      id: x.sid, title: x.title, taskId: x.taskId, taskTitle: x.taskId ? titleOf.get(x.taskId) : undefined,
    }))
    const memory = deps.replica ? deps.replica.memoryDocs(home) : []
    const r = deps.search!.run({ q: args.q, types: args.types, limit: args.limit, tasks, sessions, memory })
    if (!r.ok) return fail('bad_request', r.error)
    const kept = 'the tasks and sessions of this host' + (memory.length > 0 && r.types.indexOf('memory') !== -1 ? ' and its copy of the memory' : '')
    return ok({
      results: r.results, queryTokens: r.tokens, offline: true, degraded: 'offline-keyword', as_of: asOf(home),
      outcome: `${r.results.length} result${r.results.length === 1 ? '' : 's'} from a keyword search of ${kept}. Tasks of other hosts and session transcripts need the server. ${offlineNote(home)}`,
      next: r.results.length > 0 ? 'Open a task with task_get; search notes with note_search.' : 'Try fewer or other words, or note_search for the notes.',
    })
  }

  function opSessionList(home: string): GatewayResult {
    const slice = slices.get(home)
    const sessions = (slice?.sessions ?? []).map((s) => ({
      id: s.sid, shortId: s.sid.slice(0, 8), title: s.title ?? null, taskId: s.taskId ?? null,
      host: slice?.host ?? null, status: deps.isLive(s.sid) ? 'running' : 'stopped',
    }))
    return ok({ sessions, offline: true, as_of: asOf(home), hint: offlineNote(home) })
  }

  /**
   * This Walnut's sessions on this host as the copy names them, for the server
   * this daemon started (follower.sessions, while nobody leads): each one's task
   * as the overlay has it. Lane and environment sessions are left out; how each
   * one runs right now is the daemon's to add.
   */
  function sessionsOf(home: string): { host: string; asOf: string; sessions: Array<{ sid: string; title?: string; taskId?: string; taskTitle?: string; taskPhase?: string }> } | null {
    const slice = slices.get(home)
    if (!slice) return null
    const tasks = new Map(tasksWithOverlay(home).map((t) => [t.id, t]))
    return {
      host: slice.host,
      asOf: asOf(home),
      sessions: slice.sessions.filter((s) => !s.aside).concat(startedOf(home)).map((s) => {
        const task = s.taskId ? tasks.get(s.taskId) : undefined
        return {
          sid: s.sid,
          ...(s.title ? { title: s.title } : {}),
          ...(s.taskId ? { taskId: s.taskId } : {}),
          ...(task ? { taskTitle: task.title, ...(task.phase ? { taskPhase: task.phase } : {}) } : {}),
        }
      }),
    }
  }

  function findRequest(home: string, id: string): { own?: OfflineRequestRow; copy?: OfflineSliceRequest } {
    const own = journalOf(home).rows[id]
    if (own) return { own }
    const copy = slices.get(home)?.requests.find((r) => r.id === id)
    return copy ? { copy } : {}
  }

  function opRequestGet(home: string, args: Record<string, unknown>): GatewayResult {
    const id = typeof args.id === 'string' ? args.id : ''
    if (!/^rq-[a-f0-9]{6,}$/.test(id)) return fail('bad_request', 'request_get needs an rq-… id')
    const { own, copy } = findRequest(home, id)
    if (!own && !copy) return needsServer(`Request ${id} is not held by this host; reading it`)
    const settled = !own && journalOf(home).settledCopies.includes(id)
    const request = own ?? { ...copy!, ...(settled ? { status: 'replied' } : {}) }
    const pending = request.status === 'pending'
    return ok({
      request, offline: true,
      outcome: pending ? 'Still pending: the other session has not answered yet.' : `This request is ${request.status}.`,
      next: pending ? 'Do not poll this; the answer arrives in your session on its own.' : 'Nothing else is required.',
    })
  }

  /**
   * What is still open for the caller's task (core/sessions/open-items.ts), from
   * the copy: its unfinished subtasks, the requests it waits on and the ones it
   * owes, its Board. The compact hook (`hook: 'compact'`) gets the SessionStart
   * hook's JSON, as from the server, so a compaction while the server is away
   * still puts the list back into the session's context.
   */
  function opOpenItems(home: string, callerSid: string, args: Record<string, unknown>): GatewayResult {
    const MAX_SUBTASKS = 20
    const MAX_REQUESTS = 10
    const now = deps.now()
    const ownId = callerIdentity(home, callerSid).taskId
    const tasks = tasksWithOverlay(home)
    const task = ownId ? tasks.find((t) => t.id === ownId) : undefined
    const items: OpenItemsInput = { subtasks: [], moreSubtasks: 0, waitingOn: [], askedOfYou: [] }
    if (task) {
      items.task = { id: task.id, title: task.title }
      // A stored parent id may be a legacy short prefix of the parent's id.
      const children = tasks
        .filter((t) => t.id !== task.id && !!t.parent_task_id && task.id.startsWith(t.parent_task_id) && t.phase !== 'COMPLETE')
        .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
      items.subtasks = children.slice(0, MAX_SUBTASKS).map((t) => ({ id: t.id, title: t.title, phase: t.phase ?? 'TODO' }))
      items.moreSubtasks = children.length - items.subtasks.length
      const j = journalOf(home)
      const pending: Array<{ id: string; fromSessionId: string; toSessionId?: string; toTaskId?: string; preview: string; createdAt: string }> = [
        ...Object.values(j.rows).filter((r) => r.status === 'pending'),
        ...(slices.get(home)?.requests ?? []).filter((r) => !j.rows[r.id] && j.settledCopies.indexOf(r.id) === -1),
      ]
      const newest = (a: { createdAt: string }, b: { createdAt: string }) => b.createdAt.localeCompare(a.createdAt)
      items.waitingOn = pending.filter((r) => r.fromSessionId === callerSid).sort(newest).slice(0, MAX_REQUESTS)
        .map((r): OpenWait => ({ id: r.id, to: r.toTaskId ?? (r.toSessionId ? `session ${r.toSessionId.slice(0, 8)}` : 'unknown'), preview: r.preview, createdAt: r.createdAt }))
      items.askedOfYou = pending.filter((r) => r.toSessionId === callerSid || (!!r.toTaskId && r.toTaskId === task.id)).sort(newest).slice(0, MAX_REQUESTS)
        .map((r): OpenAsk => ({ id: r.id, from: sessionOf(home, r.fromSessionId)?.taskId ?? `session ${r.fromSessionId.slice(0, 8)}`, preview: r.preview, createdAt: r.createdAt }))
      const board = deps.boards ? boardWithOverlay(home, task.id) : undefined
      if (board) {
        const msgs = Object.values(board.threads ?? {}).reduce<Array<{ author: string }>>((all, list) => all.concat(list), [])
        items.board = {
          version: board.version, updatedAt: board.updated_at ?? '', threads: Object.keys(board.threads ?? {}).length,
          userMessages: msgs.filter((m) => m.author === 'user').length, marks: Object.keys(board.marks ?? {}).length,
        }
      }
    }
    const text = deps.openItems!.format(items, now)
    if (args.hook === 'compact') {
      const context = withTaskRouting(home, callerSid, text, true).text
      return ok(context ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } } : {})
    }
    return ok({
      ...items, text, offline: true, as_of: asOf(home),
      outcome: `${text ? 'These are still open for your task' : 'Nothing is open for your task'} (this host's copy). ${offlineNote(home)}`,
      next: 'Read one with task_get; answer a request with task_send in_reply_to.',
    })
  }

  /**
   * The server's rule (session-send-core.ts), said here too: a subtask never
   * messages its COMPLETE parent, as this copy (with queued completions) sees it.
   */
  function parentCompleteRefusal(home: string, callerSid: string, targetTaskId: string | undefined): GatewayResult | undefined {
    return parentCompleteRefusalOf(home, callerIdentity(home, callerSid).taskId, targetTaskId)
  }

  function parentCompleteRefusalOf(home: string, ownId: string | undefined, targetTaskId: string | undefined): GatewayResult | undefined {
    if (!ownId || !targetTaskId) return undefined
    const tasks = tasksWithOverlay(home)
    const parentRef = tasks.find((t) => t.id === ownId)?.parent_task_id
    if (!parentRef || !targetTaskId.startsWith(parentRef)) return undefined
    const parent = tasks.find((t) => t.id === targetTaskId)
    if (parent?.phase !== 'COMPLETE') return undefined
    return fail('parent_complete', `"${parent.title}" (${parent.id}) is your task's parent and it is complete: it no longer takes messages `
      + 'from its subtasks. Keep your result in your own task, where the user reads it; if that task should hear from you again, the user reopens it.',
    { detail: { parentTaskId: parent.id } })
  }

  /**
   * The server's rule (session-send-core.ts admitRetiredLead): a session's new message to a lead
   * that handed its project over is refused with the lead that took it, unless the caller is that
   * lead or it forces with a reason (then the server's note follows when it is back).
   */
  function retiredLeadRefusal(home: string, callerSid: string, targetTaskId: string | undefined, args: Record<string, unknown>): GatewayResult | undefined {
    if (!targetTaskId) return undefined
    const lead = tasksWithOverlay(home).find((t) => t.id === targetTaskId)
    const now = lead?.handed_over_to
    if (!lead || !now || callerIdentity(home, callerSid).taskId === now.id) return undefined
    const project = (lead.project ?? '').trim()
    if (args.force === true) {
      const reason = typeof args.reason === 'string' ? args.reason.replace(/\s+/g, ' ').trim() : ''
      if (reason.length >= 10) return undefined
      return fail('bad_request', `force:true needs a reason (at least 10 characters) saying why "${lead.title}" (${lead.id}), `
        + `which no longer leads ${project}, must act rather than the lead that took over.`)
    }
    return fail('lead_handed_over', `${kit.handedOverPointer({ id: lead.id, title: lead.title, project }, now)} `
      + 'If the old lead itself must act, pass force:true with reason:"<why it, not the lead that took over>".',
    { detail: { taskId: lead.id, currentLeadTaskId: now.id, project } })
  }

  /** A forced message to an open lead that handed over: its reason leads the text, as on the server. */
  function retiredLeadText(home: string, callerSid: string, targetTaskId: string | undefined, args: Record<string, unknown>, text: string): string {
    const lead = targetTaskId ? tasksWithOverlay(home).find((t) => t.id === targetTaskId) : undefined
    if (!lead?.handed_over_to || lead.phase === 'COMPLETE' || args.force !== true) return text
    if (callerIdentity(home, callerSid).taskId === lead.handed_over_to.id) return text
    const reason = typeof args.reason === 'string' ? args.reason.replace(/\s+/g, ' ').trim() : ''
    return `This comes to you although you no longer lead ${(lead.project ?? '').trim()}. Why: ${reason.slice(0, 300)}\n\n${text}`
  }

  /** This copy's view of a task (queued completions included): is it COMPLETE? */
  function completeTask(home: string, taskId: string | undefined): OfflineSliceTask | undefined {
    if (!taskId) return undefined
    const task = tasksWithOverlay(home).find((t) => t.id === taskId)
    return task?.phase === 'COMPLETE' ? task : undefined
  }

  /**
   * The server's rule (session-send-core.ts admitCompleteTarget), with the same
   * kit function: a session's message to a COMPLETE task needs force + reason.
   * Returns the text to deliver, or the refusal.
   */
  function admitCompleteTarget(home: string, taskId: string | undefined, args: Record<string, unknown>, text: string, mode: 'send' | 'reply'): { text: string } | { error: GatewayResult } {
    const task = completeTask(home, taskId)
    if (!task) return { text }
    const check = kit.checkCompleteTarget({ id: task.id, title: task.title }, args, mode)
    if (!check.ok) return { error: fail(check.code, check.message, { detail: { taskId: task.id, phase: 'COMPLETE' } }) }
    deps.log('info', 'offline host: a complete task is reopened by a forced message', { home, taskId: task.id, mode, reason: check.reason })
    return { text: check.text(text) }
  }

  async function opReply(home: string, callerSid: string, args: Record<string, unknown>, text: string): Promise<GatewayResult> {
    const id = String(args.in_reply_to)
    const { own, copy } = findRequest(home, id)
    const row = own ?? copy
    if (!row) return needsServer(`Request ${id} is not held by this host; answering it`)
    const me = callerIdentity(home, callerSid)
    const isTarget = row.toSessionId === callerSid || (!!row.toTaskId && row.toTaskId === me.taskId)
    if (!isTarget) return fail('bad_request', `request ${id} was not addressed to this session`)
    const closed = parentCompleteRefusal(home, callerSid, sessionOf(home, row.fromSessionId)?.taskId)
    if (closed) return closed
    const admitted = admitCompleteTarget(home, sessionOf(home, row.fromSessionId)?.taskId, args, text, 'reply')
    if ('error' in admitted) return admitted.error
    // The asker runs elsewhere: only a leader can carry the answer there.
    const remoteHost = deps.isLive(row.fromSessionId) ? undefined : row.fromHost
    if (!deps.isLive(row.fromSessionId) && !(remoteHost && deps.relay)) {
      return needsServer(`The asking session (${row.fromSessionId.slice(0, 8)}) is not running on this host; routing the answer`)
    }
    const denied = admitWrite(callerSid) ?? roomFor(home)
    if (denied) return denied
    const slice = slices.get(home)!
    const wrapped = kit.buildReplyDeliveryText(row, {
      title: me.title, shortId: callerSid.slice(0, 8), host: slice.host, sessionId: callerSid, taskId: me.taskId,
    }, escapeSenderWords(admitted.text), { title: typeof args.title === 'string' ? args.title : undefined })
    const mid = messageId(args.messageId)
    const delivered = remoteHost
      ? await deps.relay!(home, { toHost: remoteHost, toSid: row.fromSessionId, text: wrapped, messageId: mid, requestId: id, reply: true, fromSessionId: callerSid })
      : await deliverWithTaskRouting(home, row.fromSessionId, wrapped, mid)
    if (!delivered.ok) {
      if (remoteHost) return needsServer(`The asking session runs on ${remoteHost} and the answer could not be routed there (${delivered.reason}); answering it`)
      return fail('internal', `delivery to the asking session failed: ${delivered.reason}`)
    }
    if (own) {
      if (own.status === 'pending') {
        own.status = 'replied'
        own.settledAt = new Date(deps.now()).toISOString()
        append(home, { kind: 'row', row: { ...own } })
      }
    } else if (!journalOf(home).settledCopies.includes(id)) {
      journalOf(home).settledCopies.push(id)
      append(home, { kind: 'settle', requestId: id, status: 'replied' })
    }
    // The host that wrote the text into the asker's session journals the delivery.
    if (!remoteHost) append(home, { kind: 'delivery', fromSessionId: callerSid, toSessionId: row.fromSessionId, messageId: mid, requestId: id, reply: true })
    deps.log('info', 'offline host: reply delivered', { home, requestId: id, from: callerSid, to: row.fromSessionId, viaLeader: !!remoteHost })
    return ok({
      delivery: 'queued', offline: true, targetSessionId: row.fromSessionId, repliedTo: id, messageId: mid,
      outcome: remoteHost
        ? `Reply delivered to the asking session on ${remoteHost} through the cloud companion, which leads while the Walnut server is away.`
        : `Reply delivered on this host to the asking session. ${offlineNote(home)}`,
      next: 'Nothing else is required.',
    })
  }

  function resolveSendTarget(home: string, to: string): { sid?: string; taskId?: string; title?: string; error?: GatewayResult } {
    const slice = slices.get(home)!
    const { task, error } = resolveTask(home, to)
    if (error) return { error }
    if (task) {
      const live = slice.sessions.filter((s) => s.taskId === task.id && deps.isLive(s.sid))
      if (live.length === 0) {
        return { error: needsServer(`Task ${task.id} has no session running on this host; starting one`) }
      }
      // The session the server picks (session-send-core.ts): the task's current
      // one, else the most recently active (the copy lists sessions newest first).
      const current = live.find((s) => s.sid === task.session_id) ?? live[0]
      return { sid: current.sid, taskId: task.id, title: current.title ?? task.title }
    }
    const ref = to.trim()
    const byId = slice.sessions.filter((s) => s.sid === ref || (ref.length >= 8 && s.sid.startsWith(ref)))
    if (byId.length === 1) {
      if (!deps.isLive(byId[0].sid)) return { error: needsServer(`Session ${ref} is not running on this host; resuming it`) }
      return { sid: byId[0].sid, taskId: byId[0].taskId, title: byId[0].title }
    }
    return { error: needsServer(`"${ref}" is not a session of this Walnut on this host; messages to other hosts`) }
  }

  async function opTaskSend(home: string, callerSid: string, args: Record<string, unknown>): Promise<GatewayResult> {
    // A structured reply answered offline keeps its fields as sections of the text
    // (the server's composeReplyText, peers/structured-reply.ts): nothing of it is lost.
    const list = (v: unknown): string[] => (typeof v === 'string' ? v.split('\n') : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
      .map((x) => x.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim()).filter(Boolean)
    const own = typeof args.text === 'string' ? args.text.trim() : ''
    const result = args.in_reply_to !== undefined && typeof args.result === 'string' ? args.result.trim() : ''
    const evidence = args.in_reply_to !== undefined ? list(args.evidence) : []
    const notDone = args.in_reply_to !== undefined ? list(args.not_done) : []
    const text = [own, result && result !== own ? `Result: ${result}` : '',
      evidence.length ? `Evidence:\n${evidence.map((e) => `- ${e}`).join('\n')}` : '',
      notDone.length ? `Not done (partial reply):\n${notDone.map((e) => `- ${e}`).join('\n')}` : ''].filter(Boolean).join('\n\n')
    if (!text) return fail('bad_request', 'text must be a non-empty string')
    if (args.in_reply_to !== undefined) {
      if (typeof args.in_reply_to !== 'string' || !/^rq-[a-f0-9]{6,}$/.test(args.in_reply_to)) return fail('bad_request', 'in_reply_to must be an rq-… id')
      return opReply(home, callerSid, args, text)
    }
    if (typeof args.to !== 'string' || !args.to.trim()) return fail('bad_request', '`to` is required (or pass in_reply_to)')
    // Before the session lookup: a completed parent usually has nothing running.
    const named = resolveTask(home, args.to).task?.id
    const closed = parentCompleteRefusal(home, callerSid, named) ?? retiredLeadRefusal(home, callerSid, named, args)
    if (closed) return closed
    const target = resolveSendTarget(home, args.to)
    if (target.error) return target.error
    const closedTarget = parentCompleteRefusal(home, callerSid, target.taskId)
    if (closedTarget) return closedTarget
    const handedOver = retiredLeadRefusal(home, callerSid, target.taskId, args)
    if (handedOver) return handedOver
    const targetSid = target.sid!
    if (targetSid === callerSid) return fail('self_send', 'target resolves to the calling session itself')
    const admitted = admitCompleteTarget(home, target.taskId, args, retiredLeadText(home, callerSid, target.taskId, args, text), 'send')
    if ('error' in admitted) return admitted.error
    const denied = admitWrite(callerSid) ?? roomFor(home)
    if (denied) return denied
    const slice = slices.get(home)!
    const me = callerIdentity(home, callerSid)
    // Same default as the server: a session asking another session wants the answer, except a
    // note up to its own leader, which reports.
    let row: OfflineRequestRow | undefined
    if (args.expect_reply !== false && !(args.expect_reply === undefined && !args.hands_on && reportsUp(home, me.taskId, target.taskId))) {
      const implicit = args.expect_reply === undefined
      row = {
        id: `rq-${deps.randomHex(6)}`,
        fromSessionId: callerSid,
        toSessionId: targetSid,
        ...(target.taskId ? { toTaskId: target.taskId } : {}),
        preview: kit.requestPreview(text),
        status: 'pending',
        createdAt: new Date(deps.now()).toISOString(),
        deadlineAt: deps.now() + clampSecs(args.reply_timeout, implicit) * 1000,
        // Written mid-turn, the CLI may take the message into the running turn or
        // queue it for the next: only the NEXT turn end proves it went unanswered.
        ...(deps.turnActive(targetSid) ? { skipTurnEnds: 1 } : {}),
      }
      // Taken BEFORE the write: the tailer may still be catching up on older
      // lines (a startup result, a finished turn) while the delivery is in
      // flight, and none of those answers this message.
      const offset = deps.streamOffset(targetSid)
      if (typeof offset === 'number') row.afterV = offset
    }
    let envelope = kit.buildPeerWrapper(escapeSenderWords(admitted.text), {
      title: me.title, shortId: callerSid.slice(0, 8), sessionId: callerSid, taskId: me.taskId,
      host: slice.host, ...(row ? { requestId: row.id } : {}),
    }, { title: typeof args.title === 'string' ? args.title : undefined })
    if (row) envelope = `${envelope}\n${kit.buildReplyTrailer(row)}`
    const mid = messageId(args.messageId)
    // The row exists before the envelope that names it can be read.
    if (row) journalOf(home).rows[row.id] = row
    const delivered = await deliverWithTaskRouting(home, targetSid, envelope, mid)
    if (!delivered.ok) {
      if (row) { delete journalOf(home).rows[row.id]; persistJournal(home) }
      return fail('internal', `delivery failed: ${delivered.reason}`)
    }
    if (row) append(home, { kind: 'row', row: { ...row } })
    append(home, { kind: 'delivery', fromSessionId: callerSid, toSessionId: targetSid, ...(target.taskId ? { toTaskId: target.taskId } : {}), messageId: mid, ...(row ? { requestId: row.id } : {}) })
    deps.log('info', 'offline host: message delivered', { home, from: callerSid, to: targetSid, requestId: row?.id, messageId: mid })
    return ok({
      delivery: 'queued', offline: true, targetSessionId: targetSid, targetTitle: target.title ?? null,
      ...(target.taskId ? { targetTaskId: target.taskId } : {}),
      ...(row ? { requestId: row.id } : {}), messageId: mid,
      outcome: `Message delivered on this host to ${target.taskId ?? targetSid}. ${offlineNote(home)} Do NOT resend.`,
      next: row
        ? `You asked for a reply (${row.id}). Its reply arrives in your session on its own; do not poll.`
        : 'Its reply arrives in your session on its own; do not poll.',
    })
  }

  // ── same-host messages while the server answers (handleLocal) ──
  //
  // A message between two sessions of this Walnut on this host is this host's
  // to deliver, whether or not the server answers: the server's send ends in
  // this daemon's FIFO write anyway, after a round trip to wherever the server
  // runs. Delivered here, journaled (`online`), and the server is nudged; it
  // drains within moments and owns the request row from then on, as it does
  // after any handover. Only the plain case is taken here, judged on facts this
  // host has: anything it cannot be sure of (a name it resolves differently from
  // the server, a target or asker that is not running here, a target waiting on
  // a permission prompt, a completed parent) is left to the server, unchanged.

  const LOCAL_SEND_OPS = ['task_send', 'session_send']
  const PEER_SEND_WINDOW_MS = 60_000
  const PEER_SEND_MAX = 10
  const PEER_DUP_WINDOW_MS = 300_000
  /** Per-sender send times, and (sender, target, text) → last send: the server's own peer throttle rules. */
  const peerSends = new Map<string, number[]>()
  const peerDups = new Map<string, number>()

  function admitPeerSend(sender: string, target: string, text: string): GatewayResult | null {
    const now = deps.now()
    const recent = (peerSends.get(sender) ?? []).filter((t) => now - t < PEER_SEND_WINDOW_MS)
    if (recent.length >= PEER_SEND_MAX) {
      peerSends.set(sender, recent)
      return fail('throttled', 'peer send throttled: do not retry in a loop', { retryAfterMs: Math.max(1, recent[0] + PEER_SEND_WINDOW_MS - now) })
    }
    const dupKey = `${sender}|${target}|${deps.keyOf(text)}`
    const last = peerDups.get(dupKey)
    if (last !== undefined && now - last < PEER_DUP_WINDOW_MS) {
      return fail('throttled', 'the same message was just sent to this session: do not resend', { retryAfterMs: Math.max(1, last + PEER_DUP_WINDOW_MS - now) })
    }
    recent.push(now)
    peerSends.set(sender, recent)
    peerDups.set(dupKey, now)
    for (const [k, at] of peerDups) if (now - at >= PEER_DUP_WINDOW_MS) peerDups.delete(k)
    return null
  }

  /**
   * `to` as this host can name it without doubt: an exact task id, an exact
   * session id, a session id prefix of 8 or more, or a printed `Title [8hex]`
   * handle. A task prefix or a title is the server's to resolve: it sees every
   * task, this copy only some, and a prefix unique here may not be unique there.
   */
  function localTarget(home: string, to: string): { sid: string; taskId?: string; title?: string } | null {
    const slice = slices.get(home)!
    const ref = to.trim()
    const task = tasksWithOverlay(home).find((t) => t.id === ref)
    if (task) {
      const live = slice.sessions.filter((s) => s.taskId === task.id && deps.isLive(s.sid))
      // The server picks the task's current session; with two live, leave it the choice.
      if (live.length !== 1 || live[0].aside) return null
      return { sid: live[0].sid, taskId: task.id, title: live[0].title ?? task.title }
    }
    const printed = /\[([0-9a-f][0-9a-f-]{7,})\]\s*$/i.exec(ref)?.[1]
    const key = (printed ?? ref).toLowerCase()
    if (key.length < 8 || !/^[0-9a-f-]+$/.test(key)) return null
    const hits = slice.sessions.filter((s) => s.sid.toLowerCase() === key || s.sid.toLowerCase().startsWith(key))
    if (hits.length !== 1 || hits[0].aside || !deps.isLive(hits[0].sid)) return null
    // An older session of a task that runs another one here too: the server
    // knows which one the task continues in.
    const taskId = hits[0].taskId
    if (taskId && slice.sessions.filter((s) => s.taskId === taskId && deps.isLive(s.sid)).length !== 1) return null
    return { sid: hits[0].sid, taskId, title: hits[0].title }
  }

  /** The server's answer shape (session-send-core.ts SessionSendResult), with the op's outcome lines. */
  function sentResult(
    home: string,
    to: { sid: string; taskId?: string; title?: string },
    extra: { requestId?: string; repliedTo?: string; messageId: string },
  ): GatewayResult {
    const replyHint = 'Its reply arrives in your session on its own; do not poll. '
      + 'Only if you cannot continue without it: walnut wait <task-id | rq-id>.'
    return ok({
      delivery: 'queued', via: 'host', host: slices.get(home)?.host ?? null,
      targetSessionId: to.sid, targetTitle: to.title ?? null,
      ...(to.taskId ? { targetTaskId: to.taskId } : {}),
      target: { handle: kit.sessionHandle(to.title, to.sid), sessionId: to.sid, ...(to.taskId ? { taskId: to.taskId } : {}) },
      ...(extra.requestId ? { requestId: extra.requestId } : {}),
      ...(extra.repliedTo ? { repliedTo: extra.repliedTo } : {}),
      messageId: extra.messageId,
      outcome: extra.repliedTo
        ? `Reply delivered on this host to the asking session (${to.taskId ?? to.sid}). Do NOT resend.`
        : `Message delivered on this host to ${to.taskId ?? to.sid}. Accepted for delivery, not a completed reply. Do NOT resend.`,
      next: extra.repliedTo ? 'Nothing else is required.'
        : extra.requestId ? `You asked for a reply (${extra.requestId}). ${replyHint}` : replyHint,
    })
  }

  async function localSend(home: string, callerSid: string, args: Record<string, unknown>, text: string, mid: string): Promise<GatewayResult | null> {
    if (typeof args.to !== 'string' || !args.to.trim()) return null
    const target = localTarget(home, args.to)
    if (!target || target.sid === callerSid) return null
    if (deps.pendingPrompt!(target.sid)) return null
    if (parentCompleteRefusal(home, callerSid, target.taskId)) return null
    // A complete target (and a forced reopen of one) is the server's to decide, as is a lead that handed over.
    if (completeTask(home, target.taskId)) return null
    if (target.taskId && tasksWithOverlay(home).some((t) => t.id === target.taskId && t.handed_over_to)) return null
    const denied = admitPeerSend(callerSid, target.sid, text) ?? roomFor(home)
    if (denied) return denied
    const slice = slices.get(home)!
    const me = callerIdentity(home, callerSid)
    let row: OfflineRequestRow | undefined
    if (args.expect_reply !== false && !(args.expect_reply === undefined && !args.hands_on && reportsUp(home, me.taskId, target.taskId))) {
      const implicit = args.expect_reply === undefined
      row = {
        id: `rq-${deps.randomHex(6)}`,
        fromSessionId: callerSid,
        toSessionId: target.sid,
        ...(target.taskId ? { toTaskId: target.taskId } : {}),
        preview: kit.requestPreview(text),
        status: 'pending',
        createdAt: new Date(deps.now()).toISOString(),
        deadlineAt: deps.now() + clampSecs(args.reply_timeout, implicit) * 1000,
        ...(deps.turnActive(target.sid) ? { skipTurnEnds: 1 } : {}),
        online: true,
      }
      const offset = deps.streamOffset(target.sid)
      if (typeof offset === 'number') row.afterV = offset
    }
    let envelope = kit.buildPeerWrapper(escapeSenderWords(text), {
      title: me.title, shortId: callerSid.slice(0, 8), sessionId: callerSid, taskId: me.taskId,
      host: slice.host, ...(row ? { requestId: row.id } : {}),
    }, { title: typeof args.title === 'string' ? args.title : undefined })
    if (row) envelope = `${envelope}\n${kit.buildReplyTrailer(row)}`
    if (row) journalOf(home).rows[row.id] = row
    const delivered = await deliverWithTaskRouting(home, target.sid, envelope, mid)
    if (!delivered.ok) {
      // Nothing was written: the server may still reach it (it resumes a stopped CLI).
      if (row) { delete journalOf(home).rows[row.id]; persistJournal(home) }
      return null
    }
    if (row) append(home, { kind: 'row', row: { ...row } }, true)
    append(home, { kind: 'delivery', fromSessionId: callerSid, toSessionId: target.sid, ...(target.taskId ? { toTaskId: target.taskId } : {}), messageId: mid, ...(row ? { requestId: row.id } : {}) }, true)
    deps.log('info', 'host: message delivered on this host', { home, from: callerSid, to: target.sid, requestId: row?.id, messageId: mid })
    return sentResult(home, target, { requestId: row?.id, messageId: mid })
  }

  async function localReply(home: string, callerSid: string, args: Record<string, unknown>, text: string, mid: string): Promise<GatewayResult | null> {
    const id = typeof args.in_reply_to === 'string' ? args.in_reply_to : ''
    if (!/^rq-[a-f0-9]{6,}$/.test(id)) return null
    const { own, copy } = findRequest(home, id)
    const row = own ?? copy
    // A copy this host already answered once: a second answer is the server's (it says "late").
    if (!row || (!own && journalOf(home).settledCopies.includes(id))) return null
    const me = callerIdentity(home, callerSid)
    const isTarget = row.toSessionId === callerSid || (!!row.toTaskId && row.toTaskId === me.taskId)
    if (!isTarget) return null
    const asker = row.fromSessionId
    // The server's first rung (reply-routing.ts): a live asker is its own address.
    if (asker === callerSid || !deps.isLive(asker) || deps.pendingPrompt!(asker)) return null
    const askerRow = sessionOf(home, asker)
    if (!askerRow || askerRow.aside) return null
    if (parentCompleteRefusal(home, callerSid, askerRow?.taskId)) return null
    if (completeTask(home, askerRow?.taskId)) return null
    const denied = roomFor(home)
    if (denied) return denied
    const slice = slices.get(home)!
    const wrapped = kit.buildReplyDeliveryText(row, {
      title: me.title, shortId: callerSid.slice(0, 8), host: slice.host, sessionId: callerSid, taskId: me.taskId,
    }, escapeSenderWords(text), { title: typeof args.title === 'string' ? args.title : undefined })
    const delivered = await deliverWithTaskRouting(home, asker, wrapped, mid)
    if (!delivered.ok) return null
    if (own) {
      if (own.status === 'pending') {
        own.status = 'replied'
        own.settledAt = new Date(deps.now()).toISOString()
        append(home, { kind: 'row', row: { ...own } }, true)
      }
    } else {
      journalOf(home).settledCopies.push(id)
      append(home, { kind: 'settle', requestId: id, status: 'replied' }, true)
    }
    append(home, { kind: 'delivery', fromSessionId: callerSid, toSessionId: asker, messageId: mid, requestId: id, reply: true }, true)
    deps.log('info', 'host: reply delivered on this host', { home, requestId: id, from: callerSid, to: asker, messageId: mid })
    return sentResult(home, { sid: asker, taskId: askerRow?.taskId, title: askerRow?.title }, { repliedTo: id, messageId: mid })
  }

  /**
   * A call the server would answer, that this host answers itself: a message
   * between two of this Walnut's sessions running here. Null = not this host's
   * to take; the caller relays the payload, which then carries the message id
   * this host picked, so a delivery the server makes again is written once.
   */
  async function handleLocal(home: string, callerSid: string, capability: string, payload: Record<string, unknown>): Promise<GatewayResult | null> {
    if (!deps.pendingPrompt || capability !== 'tools.call') return null
    const name = typeof payload.name === 'string' ? payload.name : ''
    if (LOCAL_SEND_OPS.indexOf(name) === -1 || typeof payload.argsFile === 'string') return null
    if (!slices.has(home) || !sessionOf(home, callerSid)) return null
    const args = (payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args) ? payload.args : {}) as Record<string, unknown>
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (!text) return null
    // A hand-off links requests in the server's ledger: the server delivers it.
    if (args.hands_on !== undefined) return null
    // So does a structured reply (result / evidence / not_done): the server keeps its fields
    // on the request and the replier's task, where the Board reads Partial.
    if (args.result !== undefined || args.evidence !== undefined || args.not_done !== undefined) return null
    if (typeof args.messageId !== 'string' || !/^qm-[A-Za-z0-9-]{1,64}$/.test(args.messageId)) {
      payload.args = { ...args, messageId: `qm-host-${deps.randomHex(8)}` }
    }
    const mid = String((payload.args as Record<string, unknown>).messageId)
    try {
      return args.in_reply_to !== undefined
        ? await localReply(home, callerSid, args, text, mid)
        : await localSend(home, callerSid, args, text, mid)
    } catch (err) {
      deps.log('warn', 'host: same-host delivery failed, leaving it to the server', { home, error: (err as Error).message })
      return null
    }
  }

  function opQueued(home: string, callerSid: string, name: string, args: Record<string, unknown>): GatewayResult {
    const ref = typeof args.id === 'string' ? args.id : ''
    if (!ref) return fail('bad_request', `${name} needs "id"`)
    const { task, error } = resolveTask(home, ref)
    if (error) return error
    if (!task) return needsServer(`Task ${ref} is not in this host's offline copy; changing it`)
    let size = 0
    try { size = JSON.stringify(args).length } catch { return fail('bad_request', 'arguments are not JSON') }
    if (size > MAX_ARGS_BYTES) return fail('bad_request', `arguments are too large to queue offline (${size} bytes, limit ${MAX_ARGS_BYTES})`)
    if (drainsKind(home, 'task-fields')) {
      // Journal v2: per-field bases from the copy plus what is queued here (section 7).
      const built = taskFieldsRecord(home, task, name, args, null)
      if ('error' in built) return built.error
      const saved = append(home, built.record, false, { actor: { kind: 'session', sid: callerSid }, coalesce: true, admit: () => admitWrite(callerSid) ?? roomFor(home) })
      const no = refusal(saved)
      if (no) return no
      deps.log('info', 'offline host: write queued', { home, op: name, taskId: task.id, callerSid, kind: 'task-fields', seq: saved.ok ? saved.seq : undefined })
    } else {
      // The budget is charged under the lock (as above), so a locked refusal costs none.
      const base = slices.get(home)?.tasks.find((t) => t.id === task.id)?.updated_at
      const no = refusal(append(home, { kind: 'op', op: name, args: { ...args, id: task.id }, callerSid, ...(base ? { base } : {}) }, false, { admit: () => admitWrite(callerSid) ?? roomFor(home) }))
      if (no) return no
      deps.log('info', 'offline host: write queued', { home, op: name, taskId: task.id, callerSid })
    }
    return ok({
      queued: true, offline: true, id: task.id,
      outcome: `Saved on this host; Walnut applies this ${name} when the server reconnects (a newer change made elsewhere wins).`,
      next: 'Nothing else is required. Do not repeat the call.',
    })
  }

  /**
   * A task write as a `task-fields` record: every field with the value this host shows
   * now as its base (copy plus what is queued here), `'unknown'` where the copy lacks the
   * field, or the writer's own base (a replica's) when it gives one. All or nothing: a
   * field outside the queueable set refuses the whole write (`needs_leader {fields}`).
   */
  function taskFieldsRecord(
    home: string, task: OfflineSliceTask | null, name: string, args: Record<string, unknown>, given: Record<string, unknown> | null,
  ): { record: OfflineRecordV2 & Record<string, unknown> } | { error: GatewayResult } {
    const taskId = task?.id ?? String(args.id ?? '')
    const op = name === 'task_complete' ? 'task_complete' : 'task_update'
    const values: Record<string, unknown> = {}
    if (op === 'task_complete') values.phase = 'COMPLETE'
    else for (const [k, v] of Object.entries(args)) if (k !== 'id' && k !== 'messageId' && RETIRED_TASK_INPUTS.indexOf(k) === -1) values[k] = v
    const bad = Object.keys(values).filter((k) => QUEUEABLE.indexOf(k) === -1)
    if (bad.length) {
      return { error: fail('needs_leader', `${bad.join(', ')} can only be changed while the Walnut server answers; nothing of this write was saved`, { detail: { why: 'fields', fields: bad } }) }
    }
    if (!Object.keys(values).length) return { error: fail('bad_request', `${name} names no field to change`) }
    const seen = task as Record<string, unknown> | null
    const fields: Record<string, OfflineFieldWrite> = {}
    for (const [k, value] of Object.entries(values)) {
      const base = given && k in given ? given[k] : seen && k in seen ? seen[k] : 'unknown'
      fields[k] = { base: base === undefined ? 'unknown' : base, value }
    }
    return { record: { kind: 'task-fields', op, taskId, fields } }
  }

  // ── follower.op: the replica's writes while the Mac is away (replica-ops-v1) ──

  const FOLLOWER_OP_KINDS: Record<string, string> = { task_update: 'task-fields', task_complete: 'task-fields', task_create: 'task-create', task_move: 'task-move', device_revoke: 'device-revoke' }
  const OP_ID_RE = /^[A-Za-z0-9_-]{1,80}$/

  function actorOf(given: unknown): import('./offline-journal-core.js').JournalActor | null {
    const a = given as { kind?: unknown; deviceId?: unknown; name?: unknown; sid?: unknown } | null
    if (!a || typeof a !== 'object') return null
    if (a.kind === 'device' && typeof a.deviceId === 'string' && OP_ID_RE.test(a.deviceId)) {
      return { kind: 'device', deviceId: a.deviceId, ...(typeof a.name === 'string' && a.name ? { name: a.name.slice(0, 80) } : {}) }
    }
    if (a.kind === 'session' && typeof a.sid === 'string' && a.sid) return { kind: 'session', sid: a.sid }
    return null
  }

  /**
   * One write from the replica of `home` (the twin checked the socket's home, the quiet
   * window and the daemon dir's owner). Written only as a kind the leading Mac drains;
   * a task outside the copy is taken with the replica's base. Never throws.
   */
  function handleFollower(home: string, req: { op?: unknown; args?: unknown; actor?: unknown; opId?: unknown; base?: unknown }): GatewayResult {
    try {
      const name = typeof req.op === 'string' ? req.op : ''
      const args = (req.args && typeof req.args === 'object' && !Array.isArray(req.args) ? req.args : {}) as Record<string, unknown>
      const actor = actorOf(req.actor)
      if (!actor) return fail('bad_request', 'follower.op needs an actor (the paired device, or a session)')
      if (req.opId !== undefined && (typeof req.opId !== 'string' || !OP_ID_RE.test(req.opId))) return fail('bad_request', 'follower.op: bad opId')
      // A retry of a saved write (its answer was lost) answers the saved record before any
      // gate or base: the overlay already holds the first attempt, so a Board edit's
      // version or old text would no longer match and a saved write would read as failed.
      if (typeof req.opId === 'string') {
        const first = journal.byOpId(home, req.opId)
        if (first) {
          deps.log('info', 'offline host: follower write retried', { home, op: name, opId: req.opId, seq: first.seq })
          // A create's retry names the task the first attempt made (the retry minted another id).
          const firstTask = (first as { taskId?: unknown }).taskId
          // A note save's retry hands the editor its lock again (WP11): the hash it saved.
          const n = first as unknown as { oursHash?: unknown; noteId?: unknown }
          const noteBits = first.kind === 'note' ? { ...(typeof n.oursHash === 'string' ? { contentHash: n.oursHash } : {}), ...(typeof n.noteId === 'string' ? { noteId: n.noteId } : {}) } : {}
          return ok({ queued: true, offline: true, kind: first.kind, seq: first.seq, opId: String(first.opId), rev: first.rev ?? 1, duplicate: true, ...(typeof firstTask === 'string' ? { taskId: firstTask } : {}), ...noteBits })
        }
      }
      const opId = typeof req.opId === 'string' ? req.opId : `op-${deps.randomHex(8)}`
      // WP11: a note save (cap note-journal-v1); its own checks and lock.
      if (name === 'note_put' || name === 'note_delete') return followerNote(home, name, args, actor, opId)
      const kind = FOLLOWER_OP_KINDS[name] ?? (deps.boards && deps.boards.WRITE_OPS.indexOf(name) !== -1 ? 'board' : '')
      if (!kind) return fail('needs_leader', `${name || 'that write'} needs your Mac`, { detail: { why: 'not_queueable' } })
      if (!drainsKind(home, kind) || (actor.kind === 'device' && !drainsKind(home, 'device-actor'))) {
        return fail('needs_leader', 'your Mac runs an older Walnut that cannot take this change later; it needs your Mac', { detail: { why: 'mac_too_old' } })
      }
      let size = 0
      try { size = JSON.stringify(args).length } catch { return fail('bad_request', 'arguments are not JSON') }
      if (size > MAX_ARGS_BYTES) return fail('bad_request', `arguments are too large to queue (${size} bytes, limit ${MAX_ARGS_BYTES})`)
      const budgetKey = actor.kind === 'device' ? `device:${actor.deviceId}` : actor.kind === 'session' ? actor.sid : `trigger:${actor.id}`
      const given = req.base && typeof req.base === 'object' && !Array.isArray(req.base) ? req.base as Record<string, unknown> : null
      let record: (OfflineRecordV2 & Record<string, unknown>) | null = null
      const taskId = typeof args.id === 'string' ? args.id.trim() : ''
      if (kind === 'task-fields') {
        if (!taskId) return fail('bad_request', `${name} needs "id"`)
        const built = taskFieldsRecord(home, resolveTask(home, taskId).task ?? null, name, { ...args, id: taskId }, given)
        if ('error' in built) return built.error
        record = built.record
      } else if (kind === 'task-create') {
        if (!OP_ID_RE.test(taskId)) return fail('bad_request', 'task_create needs the id the replica minted')
        const placementKeys = ['parent_task_id', 'project', 'group_id', 'focus_tier', 'order', 'id']
        const fields: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(args)) if (placementKeys.indexOf(k) === -1) fields[k] = v
        const bad = Object.keys(fields).filter((k) => QUEUEABLE.indexOf(k) === -1)
        if (bad.length) return fail('needs_leader', `${bad.join(', ')} can only be set while the Walnut server answers`, { detail: { why: 'fields', fields: bad } })
        const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
        const placement = {
          ...(str(args.parent_task_id) ? { parentTaskId: str(args.parent_task_id) } : {}), ...(typeof args.project === 'string' ? { project: args.project } : {}),
          ...(str(args.group_id) ? { groupId: str(args.group_id) } : {}), ...(str(args.focus_tier) ? { tier: str(args.focus_tier) } : {}),
        }
        record = { kind: 'task-create', taskId, fields, placement, ...(args.order !== undefined ? { order: args.order } : {}) }
      } else if (kind === 'task-move') {
        if (!taskId) return fail('bad_request', 'task_move needs "id"')
        const an = args.anchor as { after?: unknown; before?: unknown } | null | undefined
        const anchor = an && typeof an === 'object'
          ? (typeof an.after === 'string' ? { after: an.after } : typeof an.before === 'string' ? { before: an.before } : null)
          : null
        record = { kind: 'task-move', taskId, anchor, ...(typeof args.tier === 'string' ? { tier: args.tier } : {}), base: given ?? 'unknown' }
      } else if (kind === 'device-revoke') {
        // Only a device's own sign-out: removing another needs the owner's rights, which the Mac holds.
        const deviceId = typeof args.deviceId === 'string' ? args.deviceId : ''
        if (!OP_ID_RE.test(deviceId)) return fail('bad_request', 'device_revoke needs "deviceId"')
        if (actor.kind !== 'device' || actor.deviceId !== deviceId) {
          return fail('needs_leader', 'removing another device needs your Mac', { detail: { why: 'device_changes_need_mac' } })
        }
        record = { kind: 'device-revoke', deviceId, ...(typeof args.name === 'string' && args.name ? { name: args.name.slice(0, 80) } : {}) }
      } else {
        const kit = deps.boards!
        const boardId = typeof args.task === 'string' ? args.task : ''
        // A Board outside this host's copy (no session of its team runs here) is checked
        // against the one the replica showed (its copy plus overlay), as a task is.
        const board = boardId ? boardWithOverlay(home, boardId) ?? boardOfBase(given, boardId) : undefined
        if (!board && name !== 'board_set') return fail('needs_leader', 'that Board is not kept on this host', { detail: { why: 'board_not_here' } })
        const by = actor.kind === 'device' ? `device:${actor.name ?? actor.deviceId}` : 'task:'
        const prepared = kit.prepare(board, name, args, by)
        if (!prepared.ok) return fail(prepared.code, prepared.message, prepared.detail !== undefined ? { detail: prepared.detail } : undefined)
        const postId = typeof args.postId === 'string' && OP_ID_RE.test(args.postId) ? args.postId : `bm-host-${deps.randomHex(8)}`
        record = { kind: 'board', op: name, args: { ...prepared.args, task: boardId }, ...(name === 'board_post' ? { postId } : {}) }
      }
      const t0 = process.hrtime.bigint()
      const c0 = process.cpuUsage()
      const saved = append(home, record, false, { actor, opId, coalesce: kind === 'task-fields', limit: true, admit: () => admitWrite(budgetKey) })
      // What the append cost (lock, tail re-read, line, fdatasync): the twins test's budget,
      // in wall time and in this process's CPU (a saturated machine stretches only the first).
      const appendMs = Number(process.hrtime.bigint() - t0) / 1e6
      const cpu = process.cpuUsage(c0)
      const appendCpuMs = (cpu.user + cpu.system) / 1000
      const no = refusal(saved)
      if (no || !saved.ok) return no ?? fail('internal', 'not saved')
      deps.log('info', 'journal append', { home, op: name, kind, opId: saved.opId, seq: saved.seq, rev: saved.rev, actor: budgetKey, ...(saved.coalesced ? { coalesced: true } : {}), ...(saved.duplicate ? { duplicate: true } : {}) })
      return ok({
        queued: true, offline: true, kind, seq: saved.seq, opId: saved.opId, rev: saved.rev,
        appendMs: Math.round(appendMs * 1000) / 1000, appendCpuMs: Math.round(appendCpuMs * 1000) / 1000,
        ...(saved.coalesced ? { coalesced: true } : {}), ...(saved.duplicate ? { duplicate: true } : {}),
      })
    } catch (err) {
      deps.log('error', 'offline host: follower write failed', { home, error: (err as Error).message })
      return fail('internal', `offline host error: ${(err as Error).message}`)
    }
  }

  /** The Board a follower write names as its base (the replica's copy plus overlay), or undefined. */
  function boardOfBase(given: Record<string, unknown> | null, boardId: string): OfflineSliceBoard | undefined {
    if (!given || typeof given.html !== 'string' || typeof given.version !== 'number') return undefined
    const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, never> : {})
    return { taskId: boardId, html: given.html, version: given.version, threads: obj(given.threads), marks: obj(given.marks), projects: obj(given.projects), choices: obj(given.choices) }
  }

  // ── the Board copy (offline-board-core.ts) ──

  /** The board a call is about: the task it names, else the caller's team board. */
  function boardIdFor(home: string, callerSid: string, given: unknown): string | undefined {
    const slice = slices.get(home)
    if (!slice) return undefined
    const boards = slice.boards ?? []
    if (typeof given === 'string' && given.trim()) {
      const ref = given.trim()
      const exact = boards.find((b) => b.taskId === ref)
      if (exact) return exact.taskId
      const task = resolveTask(home, ref).task
      return task && (boards.some((b) => b.taskId === task.id) || slice.boardOf?.[task.id] === task.id) ? task.id : undefined
    }
    const own = callerIdentity(home, callerSid).taskId
    return own ? slice.boardOf?.[own] : undefined
  }

  /** The board as this host sees it: the copy, then every write made here since. */
  function boardWithOverlay(home: string, boardId: string): OfflineSliceBoard | undefined {
    const kit = deps.boards!
    let board = (slices.get(home)?.boards ?? []).find((b) => b.taskId === boardId)
    for (const r of recordsOf(home)) {
      if (r.kind === 'board') {
        // Journal v2: the writer is the record's actor; a post keeps its writer-minted id.
        if (kit.WRITE_OPS.indexOf(r.op) === -1 || r.args.task !== boardId) continue
        const a = r.actor
        const sessionTask = a?.kind === 'session' ? callerIdentity(home, a.sid).taskId : undefined
        const by = sessionTask ? `task:${sessionTask}` : a?.kind === 'device' ? `device:${a.name ?? a.deviceId}` : 'agent'
        const postId = r.postId
        board = kit.apply(board, r.op, r.args, by, new Date(r.at).toISOString(), boardId, () => postId ?? `bm-offline-${r.seq}`)
        continue
      }
      if (r.kind !== 'op' || kit.WRITE_OPS.indexOf(r.op) === -1 || r.args.task !== boardId) continue
      const opTask = callerIdentity(home, r.callerSid).taskId
      const by = opTask ? `task:${opTask}` : 'agent'
      board = kit.apply(board, r.op, r.args, by, new Date(r.at).toISOString(), boardId, () => `bm-offline-${r.seq}`)
    }
    return board
  }

  function opBoard(home: string, callerSid: string, name: string, args: Record<string, unknown>): GatewayResult {
    const kit = deps.boards!
    const boardId = boardIdFor(home, callerSid, args.task)
    if (!boardId) return needsServer(`The Board of that task is not kept on this host; ${name === 'board_get' ? 'reading' : 'writing'} it`)
    const board = boardWithOverlay(home, boardId)
    if (name === 'board_get') {
      if (!board) {
        return ok({
          task_id: boardId, board: null, offline: true, as_of: asOf(home),
          outcome: `Task ${boardId} has no board yet (this host's copy). ${offlineNote(home)}`,
          next: 'Make one with board_set; it is applied here now and reaches Walnut when the server reconnects.',
        })
      }
      return ok({
        task_id: boardId,
        board: { html: board.html, version: board.version, updated_at: board.updated_at, updated_by: board.updated_by },
        threads: board.threads ?? {}, marks: board.marks ?? {}, projects: board.projects ?? {}, choices: board.choices ?? {},
        offline: true, as_of: asOf(home),
        outcome: `Board of ${boardId} (this host's copy, with the writes made here): version ${board.version}, ${board.html.length} chars of html. ${offlineNote(home)}`,
        next: 'Keep it current with board_edit; a write is applied here now and reaches Walnut when the server reconnects.',
      })
    }
    // Any session writes any board it can see here, as online (board-team.ts); the writer is recorded.
    const me = callerIdentity(home, callerSid)
    const prepared = kit.prepare(board, name, args, me.taskId ? `task:${me.taskId}` : 'agent')
    if (!prepared.ok) return fail(prepared.code, prepared.message, prepared.detail !== undefined ? { detail: prepared.detail } : undefined)
    const denied = admitWrite(callerSid) ?? roomFor(home)
    if (denied) return denied
    const saved = drainsKind(home, 'board')
      // Journal v2: a post carries its writer-minted id, so a replay can never post twice.
      ? append(home, { kind: 'board', op: name, args: { ...prepared.args, task: boardId }, ...(name === 'board_post' ? { postId: `bm-host-${deps.randomHex(8)}` } : {}) }, false, { actor: { kind: 'session', sid: callerSid } })
      : append(home, { kind: 'op', op: name, args: { ...prepared.args, task: boardId }, callerSid })
    const no = refusal(saved)
    if (no) return no
    const after = boardWithOverlay(home, boardId)
    deps.log('info', 'offline host: board write queued', { home, op: name, boardId, callerSid })
    return ok({
      queued: true, offline: true, task_id: boardId, ...(after ? { version: after.version } : {}),
      outcome: `Applied to this host's copy of the Board of ${boardId}${after ? ` (now version ${after.version})` : ''}; Walnut applies it when the server reconnects, and its own checks decide again.`,
      next: 'Nothing else is required. Do not repeat the call.',
    })
  }

  // ── a letter to the user while the server is away (human_inbox_send) ──

  /**
   * Checked as the op and the store check it online (letter-check.ts), its body saved as a
   * blob, and journaled as a `letter` record; the Mac sends it through its own letter path
   * when it drains it (offline-merge/apply-letter.ts), with the id minted here, so the
   * session can name the letter now and reply in its thread once the server is back.
   */
  function opLetter(home: string, callerSid: string, args: Record<string, unknown>): GatewayResult {
    const letters = deps.letters!
    const badArgs = letters.opArgs(args)
    if (badArgs) return fail('bad_request', badArgs)
    const checked = letters.shape(args)
    if (!checked.ok) return fail('bad_request', checked.message)
    const format = checked.shape.format
    const body = String(args[format])
    const over = letters.oversize({ [format]: body, text: args.text })
    if (over) return fail('bad_request', `${over.name} is ${over.bytes} bytes, over the ${over.max}-byte letter cap: link a file instead of inlining a big artifact`)
    const rest: Record<string, unknown> = {}
    for (const k of Object.keys(args)) if (k !== 'markdown' && k !== 'html') rest[k] = args[k]
    if (JSON.stringify(rest).length > MAX_ARGS_BYTES) return fail('bad_request', `the letter's fields are too large to save on this host (limit ${MAX_ARGS_BYTES} bytes besides the body)`)
    const letterId = `lt-${deps.now().toString(36)}-${deps.randomHex(3)}`
    const saved = journal.appendBlobs(home, { kind: 'letter', letterId, format, args: rest }, { bodyBlob: Buffer.from(body, 'utf8') }, {
      actor: { kind: 'session', sid: callerSid }, limit: true,
      admit: (() => admitWrite(callerSid) ?? roomFor(home)) as unknown as () => { ok: false; error: { code: string; message: string; retryAfterMs?: number } } | null,
    })
    const no = refusal(saved)
    if (no || !saved.ok) return no ?? fail('internal', 'not saved')
    try { deps.onJournal?.(home) } catch { /* a notify failure never loses the record */ }
    deps.log('info', 'offline host: letter queued', { home, letterId, callerSid, type: args.type, format, bytes: Buffer.byteLength(body), seq: saved.seq, opId: saved.opId })
    return ok({
      letterId, queued: true, offline: true, kind: 'letter', seq: saved.seq,
      outcome: `Saved on this host, not in the user's inbox yet: Walnut sends letter ${letterId} when the server is back, at the time you sent it. ${offlineNote(home)}`,
      next: 'Do not send it again. If the user answers, the answer arrives as a message in this session; reply in the thread with human_inbox_reply and this letterId once the server is back.',
    })
  }

  // ── triggers: the checks this host runs (walnut-trigger) ──

  /** The last pause, resume or delete made here per trigger id, until the server takes it. */
  function triggerHolds(): Map<string, TriggerHold> {
    const out = new Map<string, TriggerHold>()
    for (const home of journal.homes()) {
      for (const r of recordsOf(home)) {
        if (r.kind !== 'op' || TRIGGER_WRITE_OPS.indexOf(r.op) === -1) continue
        const id = typeof r.args.id === 'string' ? r.args.id : ''
        if (!id) continue
        const prev = out.get(id)
        const def = r.trigger ?? prev?.def
        out.set(id, { home, on: r.op === 'trigger_resume', ...(r.op === 'trigger_delete' ? { deleted: true } : {}), ...(def ? { def } : {}) })
      }
    }
    return out
  }

  function everyLabel(ms: number): string {
    if (!(ms > 0)) return 'unknown'
    if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
    if (ms % 60_000 === 0) return `${ms / 60_000}m`
    return `${Math.round(ms / 1000)}s`
  }

  function iso(ms: number | undefined): string | undefined {
    return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined
  }

  /** A trigger of this Walnut on this host: armed now, or switched off here. */
  function triggerOf(home: string, id: string): { def: OfflineTrigger; status?: OfflineTriggerStatus; hold?: TriggerHold } | undefined {
    const hold = triggerHolds().get(id)
    if (hold && hold.home !== home) return undefined
    const armed = deps.triggers?.armed().find((t) => t.def.id === id && t.def.deliver?.home === home)
    if (armed) return { def: armed.def, status: armed.status, ...(hold ? { hold } : {}) }
    if (hold?.def) return { def: hold.def, hold }
    return undefined
  }

  function opTriggerList(home: string): GatewayResult {
    const table = deps.triggers!
    const host = slices.get(home)?.host ?? ''
    const holds = triggerHolds()
    const row = (def: OfflineTrigger, state: 'armed' | 'paused', status?: OfflineTriggerStatus) => ({
      id: def.id, name: def.name, every: everyLabel(def.everyMs), host, enabled: state === 'armed', state,
      run: def.check.run, ...(def.check.cwd ? { cwd: def.check.cwd } : {}),
      ...(def.deliver?.taskId ? { task: def.deliver.taskId } : {}),
      ...(status && iso(status.nextRunAtMs) ? { nextCheckAt: iso(status.nextRunAtMs) } : {}),
      ...(status && iso(status.lastRunAtMs) ? { lastCheckAt: iso(status.lastRunAtMs) } : {}),
      ...(status && iso(status.lastFireAtMs) ? { lastFireAt: iso(status.lastFireAtMs) } : {}),
      ...(status ? { consecutiveErrors: status.consecutiveErrors ?? 0, unackedFires: status.pendingFires ?? 0 } : {}),
      ...(holds.get(def.id) ? { changedHere: holds.get(def.id)!.on ? 'resumed' : 'paused' } : {}),
    })
    const triggers: Array<Record<string, unknown>> = table.armed()
      .filter((t) => t.def.deliver?.home === home)
      .map((t) => row(t.def, 'armed', t.status))
    for (const [id, hold] of holds) {
      if (hold.home !== home || hold.on || hold.deleted || !hold.def || triggers.some((t) => t.id === id)) continue
      triggers.push(row(hold.def, 'paused'))
    }
    return ok({
      count: triggers.length, triggers, offline: true, as_of: asOf(home),
      outcome: `${triggers.length} trigger(s) this host checks for this Walnut, as this host runs them now. Triggers on other hosts, and ones paused or stopped before the server went away, are listed by the Walnut server.`,
      next: triggers.length === 0 ? 'No trigger runs here. trigger_create needs the Walnut server.' : 'trigger_test runs a check once here; trigger_pause / trigger_delete stop one here at once.',
    })
  }

  async function opTriggerTest(home: string, callerSid: string, args: Record<string, unknown>): Promise<GatewayResult> {
    const run = typeof args.run === 'string' ? args.run.trim() : ''
    if (!run) return fail('bad_request', 'trigger_test needs "run": the shell command to run once')
    const here = slices.get(home)?.host ?? ''
    const host = typeof args.host === 'string' ? args.host : ''
    if (host && host !== here && !(host === '__local__' && here === 'local')) return needsServer(`A check on host "${host}"`)
    const denied = admitWrite(callerSid)
    if (denied) return denied
    const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : deps.triggers!.cwdOf?.(callerSid)
    const id = typeof args.id === 'string' && args.id && triggerOf(home, args.id) ? args.id : undefined
    let result: Record<string, unknown>
    try {
      result = await deps.triggers!.test({ run, ...(cwd ? { cwd } : {}), ...(typeof args.timeoutSeconds === 'number' ? { timeoutSeconds: args.timeoutSeconds } : {}) }, id)
    } catch (err) {
      const message = (err as Error).message.replace(/^triggers\.test: /, '')
      return fail(/too many/.test(message) ? 'busy' : 'bad_request', message)
    }
    const parsed = result.parsed as { warnings?: unknown } | null | undefined
    const warnings = Array.isArray(parsed?.warnings) ? parsed!.warnings.map(String) : []
    const repaired = warnings.length ? ` The daemon had to repair its output, so it still counts, but fix the script: ${warnings.join('; ')}.` : ''
    const outcome = parsed
      ? result.wouldFire
        ? `The script parsed and WOULD fire now (${Number(result.newItemCount ?? 0)} new item(s)).${repaired}`
        : `The script parsed and would NOT fire right now: that is a working check with nothing to report.${repaired}`
      : `The script did not produce a usable answer: ${String(result.error ?? 'no JSON on the last line of stdout')}`
    return ok({
      result, offline: true, outcome,
      next: !parsed
        ? 'Fix the script so its LAST stdout line is one JSON object with a boolean "fire", then test again.'
        : 'Arming it (trigger_create) needs the Walnut server: create it once the server answers again.',
    })
  }

  function opTriggerWrite(home: string, callerSid: string, name: string, args: Record<string, unknown>): GatewayResult {
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (!id) return fail('bad_request', `${name} needs "id"`)
    const t = triggerOf(home, id)
    const hold = t?.hold
    if (name === 'trigger_resume') {
      if (hold?.deleted) return fail('not_found', `Trigger ${id} was deleted on this host; nothing to resume`)
      if (t && !(hold && !hold.on)) {
        return ok({ id, name: t.def.name, state: 'armed', changed: false, offline: true, outcome: `"${t.def.name}" is running on this host; nothing changed.`, next: 'Nothing else is required.' })
      }
      if (!t) return needsServer(`Resuming trigger ${id}, which was not paused on this host`)
    } else {
      if (!t) return needsServer(`Trigger ${id} is not one this host runs for this Walnut; changing it`)
      if (hold && !hold.on && (name === 'trigger_pause' || hold.deleted)) {
        return ok({ id, name: t.def.name, state: 'paused', changed: false, offline: true, outcome: `"${t.def.name}" is already ${hold.deleted ? 'deleted' : 'paused'} on this host; nothing changed.`, next: 'Nothing else is required.' })
      }
    }
    const denied = admitWrite(callerSid) ?? roomFor(home)
    if (denied) return denied
    const saved = refusal(append(home, { kind: 'op', op: name, args: { id }, callerSid, trigger: t!.def }))
    if (saved) return saved
    try { deps.triggers!.changed() } catch (err) { deps.log('warn', 'offline host: triggers did not follow a change here', { id, error: (err as Error).message }) }
    deps.log('info', 'offline host: trigger change queued', { home, op: name, id, callerSid })
    const label = `"${t!.def.name}"`
    const outcome = name === 'trigger_pause'
      ? `Paused ${label} on this host: it is not checked from now on; Walnut records the pause when the server reconnects.`
      : name === 'trigger_resume'
        ? `Resumed ${label} on this host: the first check runs within seconds, every ${everyLabel(t!.def.everyMs)} after that; Walnut records it when the server reconnects.`
        : `Deleted ${label} on this host: nothing checks it any more; Walnut deletes the trigger when the server reconnects. Its check script file is untouched.`
    return ok({
      id, name: t!.def.name, state: name === 'trigger_resume' ? 'armed' : name === 'trigger_pause' ? 'paused' : 'deleted',
      changed: true, queued: true, offline: true, outcome, next: 'Nothing else is required. Do not repeat the call.',
    })
  }

  function opWalnutStatus(home: string): GatewayResult {
    const names = awayOps(home).map((o) => o.name)
    return ok({
      mode: 'HOST_OFFLINE', server: 'not answering this host', host: slices.get(home)?.host ?? '', copyAsOf: asOf(home),
      queuedForServer: recordsOf(home).length, answersHere: names,
      outcome: `${offlineNote(home)} This host answers ${names.join(', ')} meanwhile, and keeps every write for the server.`,
      next: 'Use those calls; the rest waits for the server.',
    })
  }

  /** One gateway request for a Walnut that is away. Never throws. */
  async function handle(home: string, callerSid: string, capability: string, payload: Record<string, unknown>): Promise<GatewayResult> {
    try {
      if (capability === 'tools.list') {
        const wanted = typeof payload.name === 'string' ? payload.name : ''
        const ops = awayOps(home).concat(deps.replica ? deps.replica.ops(home) : []).filter((o) => !wanted || o.name === wanted)
        return ok({ ops: ops.map((o) => ({ ...o, remote: 'allow' })), offline: true, hint: offlineNote(home) })
      }
      if (capability !== 'tools.call') return needsServer(`"${capability}"`, home)
      const name = typeof payload.name === 'string' ? payload.name : ''
      const args = (payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args) ? payload.args : {}) as Record<string, unknown>
      if (typeof payload.argsFile === 'string') {
        // The file lane is for payloads over 1 MB; this host does not read them back.
        const letterHere = name === 'human_inbox_send' && !!deps.letters && drainsKind(home, 'letter')
        return needsServer(letterHere ? 'A letter over 1 MB (its arguments ride in a file; a smaller letter is saved on this host)' : 'A call whose arguments ride in a file', home)
      }
      switch (name) {
        case 'task_get': return opTaskGet(home, args)
        case 'task_list': return opTaskList(home, args)
        case 'session_list': return opSessionList(home)
        case 'request_get': return opRequestGet(home, args)
        case 'task_send': case 'session_send': return await opTaskSend(home, callerSid, args)
        case 'open_items': if (deps.openItems) return opOpenItems(home, callerSid, args); return needsServer('"open_items"', home)
        case 'search': if (deps.search) return opSearch(home, args); return needsServer('"search"', home)
        case 'walnut_status': return opWalnutStatus(home)
        case 'trigger_list': if (deps.triggers) return opTriggerList(home); return needsServer('"trigger_list"', home)
        case 'trigger_test': if (deps.triggers) return await opTriggerTest(home, callerSid, args); return needsServer('"trigger_test"', home)
        case 'trigger_pause': case 'trigger_resume': case 'trigger_delete':
          if (deps.triggers) return opTriggerWrite(home, callerSid, name, args)
          return needsServer(`"${name}"`, home)
        // WP11: a note written while away, when the leading Mac drains notes and this host keeps them.
        case 'note_write': case 'note_edit':
          if (deps.replica && deps.replica.has(home, 'notes') && drainsKind(home, 'note')) {
            return name === 'note_write' ? opNoteWrite(home, callerSid, args) : opNoteEdit(home, callerSid, args)
          }
          // Notes turned off for this host: kept only on the Mac (4f).
          if (deps.replica && typeof deps.replica.isOff === 'function' && deps.replica.isOff(home, 'notes')) return notesNotKept()
          return needsServer(`"${name}"`, home)
        // A letter to the user, when the leading Mac drains letters; an older one: as before.
        case 'human_inbox_send':
          if (deps.letters && drainsKind(home, 'letter')) return whenUnlocked(home, name, () => opLetter(home, callerSid, args))
          return needsServer('"human_inbox_send"', home)
        default: {
          const fromCopy = deps.replica ? deps.replica.answer(home, name, args, offlineNote(home)) : null
          if (fromCopy) return fromCopy
          if (deps.boards && deps.boards.BOARD_OPS.indexOf(name) !== -1) return opBoard(home, callerSid, name, args)
          if (QUEUED_OPS.includes(name)) return whenUnlocked(home, name, () => opQueued(home, callerSid, name, args))
          return needsServer(name ? `"${name}"` : 'That call', home)
        }
      }
    } catch (err) {
      deps.log('error', 'offline host: request failed', { home, capability, error: (err as Error).message })
      return fail('internal', `offline host error: ${(err as Error).message}`)
    }
  }

  // ── turn ends and deadlines: the fallback notice for rows this host owns ──

  async function notify(home: string, row: OfflineRequestRow, outcome: EnvelopeOutcome, lastText?: string): Promise<void> {
    // As on the server: no Walnut notice into a COMPLETE asker's session. Withdrawn
    // (nobody was told), so the server restores it if that task is reopened.
    const askerTask = sessionOf(home, row.fromSessionId)?.taskId
    if (askerTask && tasksWithOverlay(home).find((t) => t.id === askerTask)?.phase === 'COMPLETE') {
      row.status = 'withdrawn'
      row.settledAt = new Date(deps.now()).toISOString()
      append(home, { kind: 'row', row: { ...row } })
      deps.log('info', 'offline host: asker task is complete, request withdrawn', { home, requestId: row.id })
      return
    }
    row.status = outcome === 'timeout' ? 'expired' : 'notified'
    row.outcome = outcome
    row.settledAt = new Date(deps.now()).toISOString()
    append(home, { kind: 'row', row: { ...row } })
    const remoteHost = deps.isLive(row.fromSessionId) ? undefined : row.fromHost
    if (!deps.isLive(row.fromSessionId) && !(remoteHost && deps.relay)) {
      deps.log('info', 'offline host: asker not running, notice skipped', { home, requestId: row.id })
      return
    }
    const target = sessionOf(home, row.toSessionId)
    const task = row.toTaskId ? tasksWithOverlay(home).find((t) => t.id === row.toTaskId) : undefined
    const text = kit.buildRequestNotification(row, outcome, {
      title: target?.title ?? task?.title,
      sessionId: row.toSessionId,
      taskId: row.toTaskId,
      phase: task?.phase,
      lastMessage: lastText ? kit.clipNoticeMessage(lastText) : undefined,
    })
    const mid = `qm-offline-${deps.randomHex(8)}`
    const delivered = remoteHost
      ? await deps.relay!(home, { toHost: remoteHost, toSid: row.fromSessionId, text, messageId: mid, requestId: row.id, fromSessionId: row.toSessionId })
      : await deliverWithTaskRouting(home, row.fromSessionId, text, mid)
    if (delivered.ok && !remoteHost) append(home, { kind: 'delivery', fromSessionId: row.toSessionId, toSessionId: row.fromSessionId, messageId: mid, requestId: row.id })
    deps.log(delivered.ok ? 'info' : 'warn', 'offline host: notice', { home, requestId: row.id, outcome, delivered: delivered.ok, viaLeader: !!remoteHost })
  }

  /**
   * A `result` line on `sid`'s stream at offset `v`: the rows it owed an answer
   * settle as "finished without replying". Lines at or before the delivery (a
   * stream re-read after a daemon restart replays old turns) never count.
   */
  async function onResult(sid: string, line: string, v?: number): Promise<void> {
    for (const home of journal.homes()) {
      const j = journalOf(home)
      for (const row of Object.values(j.rows)) {
        if (row.status !== 'pending' || row.toSessionId !== sid || isHandingOver(row.id)) continue
        if (typeof v === 'number') {
          if (typeof row.afterV === 'number' && v <= row.afterV) continue
          if (typeof row.lastResultV === 'number' && v <= row.lastResultV) continue
          row.lastResultV = v
        }
        if (row.skipTurnEnds && row.skipTurnEnds > 0) {
          row.skipTurnEnds -= 1
          persistJournal(home)
          continue
        }
        // One voice: the server that answers says it, from its own copy of the row.
        if (row.online && deps.serverAnswers?.(home)) continue
        let parsed: { result?: unknown; is_error?: unknown } = {}
        try { parsed = JSON.parse(line) } catch { /* the outcome still stands */ }
        await notify(home, row, parsed.is_error === true ? 'error' : 'completed', typeof parsed.result === 'string' ? parsed.result : undefined)
      }
    }
  }

  /**
   * A trigger fire no server claimed, written into the target task's session on
   * this host (the walnut-trigger daemon builds the envelope). The session pick
   * the server makes: the newest live session of the task, as this copy lists
   * them; else the stopped one, resumed with the fire as its first message (the
   * idle reaper stops a quiet CLI after two hours, so an overnight fire finds it
   * stopped). The stopped one is the task's own session when that runs here
   * (its slot), else the newest here; a slot on another host is the server's to
   * wake. A COMPLETE task is the server's call (it refuses and tells the user),
   * as is a task with no session here (the server starts one). The fire's own
   * queue tells the server what happened, on its replay; a resume is journaled
   * too, because the server's record of that session still says stopped.
   */
  async function deliverTrigger(
    home: string,
    taskId: string,
    text: string,
    messageId: string,
  ): Promise<{ ok: true; sid: string; resumed?: true } | { ok: false; reason: string }> {
    const slice = slices.get(home)
    if (!slice) return { ok: false, reason: 'no host copy for this Walnut' }
    const task = tasksWithOverlay(home).find((t) => t.id === taskId)
    if (task?.phase === 'COMPLETE') return { ok: false, reason: 'target task is complete' }
    const live = slice.sessions.filter((s) => s.taskId === taskId && deps.isLive(s.sid))
    if (live.length > 0) {
      const sid = live[0].sid
      try {
        const delivered = await deliverWithTaskRouting(home, sid, text, messageId)
        return delivered.ok ? { ok: true, sid } : { ok: false, reason: delivered.reason }
      } catch (err) {
        return { ok: false, reason: (err as Error).message }
      }
    }
    if (!deps.resume) return { ok: false, reason: 'no live session of the target task on this host' }
    const here = slice.sessions.filter((s) => s.taskId === taskId)
    const slot = task?.session_id
    if (slot && !here.some((s) => s.sid === slot)) return { ok: false, reason: 'the target task\'s session is not on this host' }
    const pick = (slot ? here.filter((s) => s.sid === slot) : here).find((s) => !s.aside && !s.noResume)
    if (!pick) return { ok: false, reason: 'no session of the target task on this host to resume' }
    if (roomFor(home)) return { ok: false, reason: 'this host\'s journal for the Walnut server is full' }
    let resumed: DeliverResult
    try {
      resumed = await resumeWithTaskRouting(home, pick.sid, text, messageId, taskId)
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
    if (!resumed.ok) return { ok: false, reason: resumed.reason }
    append(home, { kind: 'resume', sid: pick.sid, taskId, messageId })
    deps.log('info', 'offline host: resumed a stopped session for a trigger fire', { home, sid: pick.sid, taskId, messageId })
    return { ok: true, sid: pick.sid, resumed: true }
  }

  /**
   * A message the leader routes here while the primary is away
   * (`leader.deliver`, docs/plan/walnut-control-plane.md). A peer message from
   * a session on another host is delivered as task_send delivers it on one
   * host, and a reply request it opens is owned HERE, beside the session that
   * answers it: the answer and the "finished without replying" notice go back
   * through the leader. Text (a reply or a notice another host built) is
   * written as it is. Either way the delivery is journaled for the primary.
   */
  async function deliverFromLeader(home: string, d: LeaderDelivery): Promise<GatewayResult> {
    try {
      const slice = slices.get(home)
      if (!slice) return fail('not_found', 'this host holds no copy for that Walnut')
      if (d.kind === 'text') {
        if (typeof d.toSid !== 'string' || !sessionOf(home, d.toSid)) return fail('not_found', 'no session of that Walnut with that id on this host')
        if (typeof d.text !== 'string' || !d.text) return fail('bad_request', 'text must be a non-empty string')
        if (!deps.isLive(d.toSid)) return fail('not_running', `session ${d.toSid.slice(0, 8)} is not running on this host`)
        const denied = roomFor(home)
        if (denied) return denied
        const mid = messageId(d.messageId)
        const delivered = await deliverWithTaskRouting(home, d.toSid, d.text, mid)
        if (!delivered.ok) return fail('internal', `delivery failed: ${delivered.reason}`)
        append(home, {
          kind: 'delivery', fromSessionId: typeof d.fromSessionId === 'string' ? d.fromSessionId : '', toSessionId: d.toSid,
          messageId: mid, ...(typeof d.requestId === 'string' ? { requestId: d.requestId } : {}), ...(d.reply === true ? { reply: true } : {}),
        })
        deps.log('info', 'offline host: leader delivered text', { home, to: d.toSid, requestId: d.requestId, messageId: mid })
        return ok({ delivered: true, targetSessionId: d.toSid, messageId: mid })
      }
      if (d.kind !== 'peer') return fail('bad_request', 'unknown delivery kind')
      const from = d.from
      if (!from || typeof from.sid !== 'string' || !from.sid || typeof from.host !== 'string' || !from.host) return fail('bad_request', 'from.sid and from.host are required')
      const text = typeof d.text === 'string' ? d.text.trim() : ''
      if (!text) return fail('bad_request', 'text must be a non-empty string')
      if (typeof d.to !== 'string' || !d.to.trim()) return fail('bad_request', '`to` is required')
      const fromTaskId = typeof from.taskId === 'string' ? from.taskId : undefined
      const closed = parentCompleteRefusalOf(home, fromTaskId, resolveTask(home, d.to).task?.id)
      if (closed) return closed
      const target = resolveSendTarget(home, d.to)
      if (target.error) return target.error
      const targetSid = target.sid!
      if (targetSid === from.sid) return fail('self_send', 'target resolves to the calling session itself')
      const admitted = admitCompleteTarget(home, target.taskId, { force: d.force, reason: d.reason }, text, 'send')
      if ('error' in admitted) return admitted.error
      const denied = admitWrite(from.sid) ?? roomFor(home)
      if (denied) return denied
      let row: OfflineRequestRow | undefined
      if (d.expect_reply !== false && !(d.expect_reply === undefined && reportsUp(home, fromTaskId, target.taskId))) {
        const implicit = d.expect_reply === undefined
        row = {
          id: `rq-${deps.randomHex(6)}`,
          fromSessionId: from.sid,
          toSessionId: targetSid,
          ...(target.taskId ? { toTaskId: target.taskId } : {}),
          preview: kit.requestPreview(text),
          status: 'pending',
          createdAt: new Date(deps.now()).toISOString(),
          deadlineAt: deps.now() + clampSecs(d.reply_timeout, implicit) * 1000,
          fromHost: from.host,
          ...(deps.turnActive(targetSid) ? { skipTurnEnds: 1 } : {}),
        }
        const offset = deps.streamOffset(targetSid)
        if (typeof offset === 'number') row.afterV = offset
      }
      let envelope = kit.buildPeerWrapper(escapeSenderWords(admitted.text), {
        title: typeof from.title === 'string' ? from.title : '', shortId: from.sid.slice(0, 8), sessionId: from.sid,
        taskId: fromTaskId, host: from.host, ...(row ? { requestId: row.id } : {}),
      }, { title: typeof d.title === 'string' ? d.title : undefined })
      if (row) envelope = `${envelope}\n${kit.buildReplyTrailer(row)}`
      const mid = messageId(d.messageId)
      if (row) journalOf(home).rows[row.id] = row
      const delivered = await deliverWithTaskRouting(home, targetSid, envelope, mid)
      if (!delivered.ok) {
        if (row) { delete journalOf(home).rows[row.id]; persistJournal(home) }
        return fail('internal', `delivery failed: ${delivered.reason}`)
      }
      if (row) append(home, { kind: 'row', row: { ...row } })
      append(home, { kind: 'delivery', fromSessionId: from.sid, toSessionId: targetSid, ...(target.taskId ? { toTaskId: target.taskId } : {}), messageId: mid, ...(row ? { requestId: row.id } : {}) })
      deps.log('info', 'offline host: leader delivered a peer message', { home, from: from.sid, fromHost: from.host, to: targetSid, requestId: row?.id, messageId: mid })
      return ok({
        delivery: 'queued', targetSessionId: targetSid, targetTitle: target.title ?? null,
        ...(target.taskId ? { targetTaskId: target.taskId } : {}),
        ...(row ? { requestId: row.id } : {}), messageId: mid, targetHost: slice.host,
      })
    } catch (err) {
      deps.log('error', 'offline host: leader delivery failed', { home, error: (err as Error).message })
      return fail('internal', `offline host error: ${(err as Error).message}`)
    }
  }

  /**
   * A person's message to a session of this Walnut here, from the server this
   * daemon started while no server leads (follower.send). Written as the person
   * typed it, and journaled for the server that takes this host back: it reopens
   * a completed task as a person's message does.
   */
  /** A person's message being delivered now, by home, session and message id (a retry waits for it). */
  const humanInFlight = new Map<string, Promise<GatewayResult>>()
  async function deliverHuman(home: string, sid: string, text: unknown, given: unknown): Promise<GatewayResult> {
    try {
      if (!slices.get(home)) return fail('not_found', 'this host holds no copy for that Walnut')
      if (!sessionOf(home, sid)) return fail('not_found', 'no session of that Walnut with that id on this host')
      // Composed and escaped by its sender (the companion away, replica/away-writes.ts; the
      // host server alone, host-server/alone-api.ts): its Walnut blocks are Walnut's.
      const body = typeof text === 'string' ? text.trim() : ''
      if (!body) return fail('bad_request', 'text must be a non-empty string')
      if (!deps.isLive(sid)) {
        // A stopped session of this host (WP12): the person's message starts it again with
        // the command it last ran (resumeForTrigger's path and limits), journaled `resume`.
        if (!deps.resume) return fail('not_running', 'this session is not running; the Walnut server resumes it when it is back')
        const full = roomFor(home)
        if (full) return full
        const mid = messageId(given)
        const taskId = sessionOf(home, sid)?.taskId ?? ''
        const resumed = await resumeWithTaskRouting(home, sid, body, mid, taskId)
        if (!resumed.ok) return fail('not_running', `this session is stopped and could not be started again here: ${resumed.reason}`)
        append(home, { kind: 'resume', sid, ...(taskId ? { taskId } : {}), messageId: mid })
        deps.log('info', 'offline host: a person\'s message resumed a stopped session while no server leads', { home, sid, taskId, messageId: mid })
        return ok({ delivered: true, resumed: true, targetSessionId: sid, messageId: mid })
      }
      const denied = roomFor(home)
      if (denied) return denied
      const mid = messageId(given)
      // A replica asking again after a lost answer (the same message id, write-port.ts):
      // the first delivery answers, the session never gets the words twice. A retry can
      // arrive while the first is still delivering (the replica's 5 s timeout against a
      // session that is starting): it waits for that one instead of queueing its own.
      const key = typeof given === 'string' ? `${home}\n${sid}\n${mid}` : ''
      let seen: Promise<GatewayResult> | undefined
      for (let running = key ? humanInFlight.get(key) : undefined; running && running !== seen; running = humanInFlight.get(key)) {
        seen = running
        const first = await running
        if (first.ok) {
          deps.log('info', 'offline host: a person\'s message asked again while it was delivering, delivered once', { home, to: sid, messageId: mid })
          return ok({ ...first.result, duplicate: true })
        }
      }
      if (key && recordsOf(home).some((r) => r.kind === 'delivery' && r.messageId === mid && r.toSessionId === sid)) {
        deps.log('info', 'offline host: a person\'s message asked again, delivered once', { home, to: sid, messageId: mid })
        return ok({ delivered: true, targetSessionId: sid, messageId: mid, duplicate: true })
      }
      const run = (async (): Promise<GatewayResult> => {
        const delivered = await deliverWithTaskRouting(home, sid, body, mid)
        if (!delivered.ok) return fail('internal', `delivery failed: ${delivered.reason}`)
        append(home, { kind: 'delivery', fromSessionId: '', toSessionId: sid, messageId: mid })
        deps.log('info', 'offline host: a person wrote to a session while no server leads', { home, to: sid, messageId: mid })
        return ok({ delivered: true, targetSessionId: sid, messageId: mid })
      })()
      if (!key) return await run
      const tracked = run.catch((err: Error) => fail('internal', `offline host error: ${err.message}`))
      humanInFlight.set(key, tracked)
      try { return await run } finally { if (humanInFlight.get(key) === tracked) humanInFlight.delete(key) }
    } catch (err) {
      deps.log('error', 'offline host: a person\'s message failed', { home, sid, error: (err as Error).message })
      return fail('internal', `offline host error: ${(err as Error).message}`)
    }
  }

  async function sweep(): Promise<number> {
    let n = 0
    const now = deps.now()
    for (const home of journal.homes()) {
      const j = journalOf(home)
      for (const row of Object.values(j.rows)) {
        if (row.status !== 'pending' || row.deadlineAt > now || isHandingOver(row.id)) continue
        if (row.online && deps.serverAnswers?.(home)) continue
        await notify(home, row, 'timeout'); n++
      }
    }
    return n
  }

  load()

  /** Who a caller is, as the copy names it, for a call the leader answers. */
  function callerOf(home: string, sid: string): { taskId?: string; title: string; host: string } {
    const me = callerIdentity(home, sid)
    return { ...(me.taskId ? { taskId: me.taskId } : {}), title: me.title, host: slices.get(home)?.host ?? '' }
  }

  /**
   * A read this host can answer for `home` from what it keeps, so a server that
   * does not answer can be skipped for it: a slice read, or a copy read of a kind
   * kept here (a note read on a host that keeps no notes still needs the server).
   */
  function answersRead(name: unknown, home: string): boolean {
    if (typeof name !== 'string') return false
    if (READ_OPS.indexOf(name) !== -1) return true
    return !!deps.replica && deps.replica.keeps(home, name)
  }

  /**
   * Any record the leading Mac can take that it has not taken yet, made while it was away
   * or not (a record parked for a newer Mac is not one: an old Mac would drain forever).
   */
  function hasRecords(home: string | undefined): boolean {
    return !!home && journal.drainableCount(home, drainsOf(home)) > 0
  }

  /** The replica's overlay (`follower.pending`): pending records past `sinceSeq` and their blobs. */
  function pendingFor(home: string, sinceSeq: unknown) {
    const out = journal.pending(home, typeof sinceSeq === 'number' && sinceSeq > 0 ? sinceSeq : 0)
    const offset = leaderOffsets.get(home)
    return offset === undefined ? out : { ...out, leaderOffsetMs: offset }
  }

  /** The journal line of `follower.status` (the away line and observability). */
  function journalStats(home: string) {
    return journal.stats(home, drainsOf(home))
  }

  // ── notes written while away (WP11, docs/plan/walnut-replica-servers-impl.md section 6) ──
  // One writer per home on this host: a phone save (through the replica's follower.op)
  // and a session's note_write / note_edit (through the gateway) both land here, are
  // checked against what the overlay shows (the pending save, else the copy), and are
  // journaled as `note` records that coalesce by append. The copy keeps its base until
  // the Mac took the record and a later copy round stored the note (held keys).

  const NOTE_MAX_BYTES = 1024 * 1024
  const NOTE_AWAIT_MS = 10 * 60_000
  /** home -> note key -> the leader's clock at the ack that took its last record (awaiting a copy). */
  const noteAwait = new Map<string, Map<string, number>>()
  /** home -> the read overlay of its pending note records, keyed by the records it was built from. */
  const noteViews = new Map<string, { sig: string; view: Map<string, { body: string; h: string; n: number; m?: Record<string, unknown> } | null> }>()

  function noteKeyOf(raw: unknown): string | null {
    let s = typeof raw === 'string' ? raw.trim().split('\\').join('/').replace(/^\.\/+/, '').replace(/^\/+/, '') : ''
    if (!s || /[\u0000-\u001f\u007f]/.test(s)) return null
    if (!/\.md$/i.test(s)) s += '.md'
    if (s.split('/').some((seg) => seg === '..' || seg === '' || seg.startsWith('.'))) return null
    return s.length > 1024 ? null : s
  }

  /** The pending note records of a home, the latest per key (seq order). */
  function pendingNotes(home: string): Map<string, OfflineRecordV2 & Record<string, unknown>> {
    const out = new Map<string, OfflineRecordV2 & Record<string, unknown>>()
    for (const r of recordsOf(home)) {
      const rec = r as unknown as OfflineRecordV2 & Record<string, unknown>
      if (rec.kind === 'note' && typeof rec.path === 'string' && !rec.dropped) out.set(rec.path, rec)
    }
    return out
  }

  function frontmatterId(body: string): string | undefined {
    const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)
    const line = m ? /(?:^|\n)id:[ \t]*([^\r\n]*)/.exec(m[1]) : null
    const v = line ? line[1].trim().replace(/^["']|["']$/g, '') : ''
    return v || undefined
  }

  function noteTitle(key: string, body: string): string {
    const m = /^#\s+(.+)$/m.exec(body)
    return m ? m[1].trim() : path.posix.basename(key).replace(/\.md$/i, '')
  }

  /** What every copy read shows for this home's pending note writes (host-replica-core rowsOf). */
  function noteOverlay(home: string): Map<string, { body: string; h: string; n: number; m?: Record<string, unknown> } | null> | null {
    if (!deps.replica) return null
    const recs = pendingNotes(home)
    if (recs.size === 0) { noteViews.delete(home); return null }
    const sig = [...recs.values()].map((r) => `${r.seq}:${r.rev ?? 1}`).join(',')
    const memo = noteViews.get(home)
    if (memo && memo.sig === sig) return memo.view
    const view = new Map<string, { body: string; h: string; n: number; m?: Record<string, unknown> } | null>()
    for (const [key, r] of recs) {
      if (r.mode === 'delete') { view.set(key, null); continue }
      const buf = journal.blobBody(r.oursBlob)
      if (!buf) continue // a body a sweep took: the copy answers until the record is acked
      const body = buf.toString('utf8')
      const id = frontmatterId(body) ?? (typeof r.noteId === 'string' ? r.noteId : undefined)
      view.set(key, { body, h: deps.replica.hashOf(body), n: buf.length, m: { title: noteTitle(key, body), updatedAt: new Date(typeof r.at === 'number' ? r.at : deps.now()).toISOString(), ...(id ? { id } : {}) } })
    }
    noteViews.set(home, { sig, view })
    return view
  }

  /** Keys a copy manifest of `asOf` (the leader's clock) must not replace or remove. */
  function notesHeld(home: string, asOf: number): Set<string> {
    const out = new Set<string>(pendingNotes(home).keys())
    const waits = noteAwait.get(home)
    if (waits) {
      for (const [key, ackAt] of [...waits]) {
        // Let go once a manifest from after the ack stored it, or after 10 minutes.
        if (asOf > ackAt || deps.now() + (leaderOffsets.get(home) ?? 0) - ackAt > NOTE_AWAIT_MS) waits.delete(key)
        else out.add(key)
      }
      if (waits.size === 0) noteAwait.delete(home)
    }
    return out
  }

  /** Acked note records: their keys wait for a copy round from after the ack. */
  function notesAcked(home: string, acked: Array<Record<string, unknown>>, leaderAt: number): void {
    const keys = acked.filter((r) => r.kind === 'note' && typeof r.path === 'string').map((r) => String(r.path))
    if (!keys.length) return
    let waits = noteAwait.get(home)
    if (!waits) { waits = new Map(); noteAwait.set(home, waits) }
    for (const k of keys) waits.set(k, leaderAt)
    noteViews.delete(home)
    deps.log('info', 'offline host: note records acked, their copies wait for a later round', { home, notes: keys.length })
  }

  // A replica with no journal view (a partial one) keeps today's copy: nothing is held.
  if (deps.replica && typeof deps.replica.setJournalView === 'function') deps.replica.setJournalView({ overlay: noteOverlay, held: notesHeld })

  /**
   * One note save while away, checked against what the overlay shows (the pending save,
   * else the copy) and journaled as a `note` record. `expectedHash` (the notes
   * contentHash, 12 hex) is the lock: a mismatch answers 409 `conflict` with
   * `{serverHash, serverContent}`, as the v1 route does, so the editor merges.
   */
  function notesNotKept(): GatewayResult {
    return fail('needs_leader', 'your notes are kept only on your Mac, so this needs your Mac', { detail: { why: 'not_kept_here' } })
  }

  function notePut(home: string, req: {
    path: unknown; content?: unknown; expectedHash?: unknown; mode?: 'put' | 'delete'; createOnly?: boolean
    actor: import('./offline-journal-core.js').JournalActor; opId?: string; budgetKey: string
  }): GatewayResult {
    const replica = deps.replica
    if (replica && typeof replica.isOff === 'function' && replica.isOff(home, 'notes')) return notesNotKept()
    if (!replica || !replica.has(home, 'notes')) return fail('needs_leader', 'this host keeps no copy of the notes; that needs your Mac', { detail: { why: 'kind_not_copied' } })
    if (!drainsKind(home, 'note')) return fail('needs_leader', 'your Mac runs an older Walnut that cannot take a note change later; it needs your Mac', { detail: { why: 'mac_too_old' } })
    const key = noteKeyOf(req.path)
    if (!key) return fail('bad_request', 'a note save needs a vault-relative path')
    // The copy's own rule (a folder or one note left out, a note too large; any case, as the
    // Mac's APFS vault): host-replica-core.ts keepsNote, the twin of core/replication/keep-rule.ts.
    const lower = key.toLowerCase()
    const keep = replica.notesKeep(home)
    const notKept = typeof replica.keepsNote === 'function'
      ? !replica.keepsNote(home, key)
      : keep.keepExclude.some((f) => { const lf = f.toLowerCase(); return lower === lf || lower.startsWith(`${lf}/`) }) || keep.tooBig.some((t) => t.toLowerCase() === lower)
    if (notKept) {
      return fail('needs_leader', 'this note is kept only on your Mac, so it can only be changed there', { detail: { why: 'not_kept_here' } })
    }
    const view = noteOverlay(home)
    const shown = view && view.has(key) ? view.get(key) : undefined
    const current = shown === undefined ? replica.copyBody(home, key) : shown === null ? null : shown.body
    const currentHash = current === null ? null : replica.hashOf(current)
    const expected = typeof req.expectedHash === 'string' && req.expectedHash ? req.expectedHash : null
    const content = req.mode === 'delete' ? null : req.content
    if (req.mode === 'delete') {
      if (current === null) return fail('not_found', 'Note not found')
    } else {
      if (typeof content !== 'string') return fail('bad_request', 'content (string) is required')
      if (Buffer.byteLength(content) > NOTE_MAX_BYTES) return fail('needs_leader', 'notes over 1 MB can only be changed on your Mac', { detail: { why: 'note_too_large' } })
      if (req.createOnly && current !== null) return fail('conflict', 'Note already exists', { detail: { serverHash: currentHash, serverContent: current } })
    }
    if (expected && current !== null && currentHash !== expected) {
      return fail('conflict', 'Note was modified since it was read', { detail: { serverHash: currentHash, serverContent: current } })
    }
    const mode = req.mode === 'delete' ? 'delete' as const : current === null ? 'create' as const : 'put' as const
    // The id the Mac's copy shows, never one from a pending save (a body the writer chose):
    // an `id:` line typed into a save must not send it to another note on the drain.
    const copied = replica.copyBody(home, key)
    const noteId = (copied !== null ? frontmatterId(copied) : undefined) ?? (() => {
      const row = replica.noteRow(home, key)
      return row && row.m && typeof row.m.id === 'string' ? row.m.id : undefined
    })()
    const oursHash = typeof content === 'string' ? replica.hashOf(content) : null
    const saved = journal.appendNote(home, {
      path: key, ...(noteId ? { noteId } : {}), mode, baseHash: currentHash,
      base: current === null ? null : Buffer.from(current, 'utf8'), ours: typeof content === 'string' ? Buffer.from(content, 'utf8') : null, oursHash,
    }, {
      actor: req.actor, ...(req.opId ? { opId: req.opId } : {}),
      admit: (() => admitWrite(req.budgetKey)) as unknown as () => { ok: false; error: { code: string; message: string; retryAfterMs?: number } } | null,
    })
    const no = refusal(saved)
    if (no || !saved.ok) return no ?? fail('internal', 'not saved')
    noteViews.delete(home)
    if (!saved.duplicate) { try { deps.onJournal?.(home) } catch { /* a notify failure never loses the record */ } }
    deps.log('info', 'offline host: note write queued', {
      home, path: key, mode, opId: saved.opId, seq: saved.seq, rev: saved.rev, actor: req.budgetKey,
      ...(saved.coalesced ? { coalesced: true } : {}), ...(saved.duplicate ? { duplicate: true } : {}), ...(saved.dropped ? { dropped: true } : {}),
    })
    return ok({
      queued: true, offline: true, kind: 'note', path: key.replace(/\.md$/i, ''), mode, seq: saved.seq, opId: saved.opId, rev: saved.rev,
      // `noteId`, never `id`: the daemon's reply spreads this over its own `{ id }` (the request id).
      ...(oursHash ? { contentHash: oursHash } : {}), ...(noteId ? { noteId } : {}), updatedAt: new Date(deps.now()).toISOString(),
      ...(saved.coalesced ? { coalesced: true } : {}), ...(saved.duplicate ? { duplicate: true } : {}),
      outcome: `Saved on this host; the Walnut server applies it when it is back. ${offlineNote(home)}`,
    })
  }

  /** The gateway's note_write while away (a session on this host): as the op online, create-only without expectedHash. */
  function opNoteWrite(home: string, callerSid: string, args: Record<string, unknown>): GatewayResult {
    const r = notePut(home, { path: args.path, content: args.content, expectedHash: args.expectedHash, createOnly: args.expectedHash === undefined, actor: { kind: 'session', sid: callerSid }, budgetKey: callerSid })
    if (!r.ok && r.error.code === 'conflict' && args.expectedHash === undefined) {
      return fail('conflict', `note exists; pass expectedHash from note_read to update ${String(args.path)} (note_read, then note_write), or use note_edit for a partial change`, { detail: r.error.detail })
    }
    return r
  }

  /** The gateway's note_edit while away: the replacement made on what this host shows, locked by its hash. */
  function opNoteEdit(home: string, callerSid: string, args: Record<string, unknown>): GatewayResult {
    const read = deps.replica!.answer(home, 'note_read', { ...(args.path !== undefined ? { path: args.path } : {}), ...(args.id !== undefined ? { id: args.id } : {}) }, '')
    if (!read) return needsServer('"note_edit"')
    if (!read.ok) return read
    const note = read.result as { path: string; content: string; contentHash: string }
    const oldStr = typeof args.old_str === 'string' ? args.old_str : ''
    const newStr = typeof args.new_str === 'string' ? args.new_str : ''
    if (!oldStr) return fail('bad_request', 'old_str is required')
    if (typeof args.expectedHash === 'string' && args.expectedHash && args.expectedHash !== note.contentHash) {
      return fail('conflict', `conflict: ${note.path} changed since you read it (expectedHash ${args.expectedHash}, current ${note.contentHash}); note_read it again and redo the edit on the current text`)
    }
    const occurrences = note.content.split(oldStr).length - 1
    if (occurrences === 0) return fail('bad_request', `old_str not found in ${note.path}; it must match the note byte-for-byte (whitespace and line breaks included)`)
    if (occurrences > 1 && args.replace_all !== true) return fail('bad_request', `old_str appears ${occurrences} times in ${note.path}; include more surrounding text or pass replace_all: true`)
    const next = args.replace_all === true ? note.content.split(oldStr).join(newStr) : note.content.replace(oldStr, () => newStr)
    const r = notePut(home, { path: note.path, content: next, expectedHash: note.contentHash, actor: { kind: 'session', sid: callerSid }, budgetKey: callerSid })
    if (!r.ok) return r
    return ok({ ...r.result, replacements: args.replace_all === true ? occurrences : 1 })
  }

  /** follower.op note_put / note_delete: a phone save through the replica (WP11). */
  function followerNote(home: string, name: string, args: Record<string, unknown>, actor: import('./offline-journal-core.js').JournalActor, opId: string): GatewayResult {
    const budgetKey = actor.kind === 'device' ? `device:${actor.deviceId}` : actor.kind === 'session' ? actor.sid : `trigger:${actor.id}`
    if (actor.kind === 'device' && !drainsKind(home, 'device-actor')) {
      return fail('needs_leader', 'your Mac runs an older Walnut that cannot take this change later; it needs your Mac', { detail: { why: 'mac_too_old' } })
    }
    return notePut(home, {
      path: args.path, content: args.content, expectedHash: args.expectedHash, ...(name === 'note_delete' ? { mode: 'delete' as const } : {}),
      createOnly: args.createOnly === true, actor, opId, budgetKey,
    })
  }

  return {
    /** The slices on disk again (the boot migration copied some here). */
    reloadSlices: load,
    configure, holdsSlice, hasHome, ownerOf, pendingHandover, hasRecords, drain, ack, noteSettings, noteStop, handle, handleLocal, handleFollower,
    /** handleFollower, waiting out another process's journal lock (whenUnlocked): the twins' follower.op. */
    handleFollowerWaiting: (home: string, req: Parameters<typeof handleFollower>[1]) => whenUnlocked(home, String(req.op ?? ''), () => handleFollower(home, req)),
    /** noteSession, waiting out another process's journal lock (whenUnlocked): the twins' host ask. */
    noteSessionWaiting: (home: string, rec: Parameters<typeof noteSession>[1], opId?: string, by?: unknown) => whenUnlocked(home, 'session', () => noteSession(home, rec, opId, by)),
    /** noteRoutineTask, waiting out another process's journal lock: a routine run's task (clock-host-start-v1). */
    noteRoutineTaskWaiting: (home: string, rec: Parameters<typeof noteRoutineTask>[1], opId: string, jobId: string) => whenUnlocked(home, 'task-create', () => noteRoutineTask(home, rec, opId, jobId)),
    noteRoutineTask, checkRoutineRun, knowsSession,
    pendingFor, journalStats, onResult, sweep, deliverTrigger, deliverFromLeader, deliverHuman, callerOf, answersRead, sessionsOf, noteSession, checkSession,
    triggerHolds, homes: () => [...slices.keys()], journal, QUEUEABLE, RETIRED_TASK_INPUTS,
  }
}

/**
 * The offline host with its journal store. The twins pass the store they built (it also
 * migrates v1 journals and serves offline.blob); any other caller gets one in `deps.dir`.
 */
export function createOfflineHost(deps: OfflineHostDeps) {
  return createOfflineHostCore({
    ...deps,
    journal: deps.journal ?? createOfflineJournal({
      fs: deps.fs, path: deps.path, dir: deps.dir, now: deps.now, randomHex: deps.randomHex, keyOf: deps.keyOf, log: deps.log,
      sha256: (body) => createHash('sha256').update(body).digest('hex'),
    }),
  })
}

export type OfflineHost = ReturnType<typeof createOfflineHostCore>
