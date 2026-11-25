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
 *     trigger_create / _pause / _resume / _delete takes effect here at once (the
 *     daemon arms by triggerHolds() until the server has taken the record; a
 *     trigger created here keeps the id this host gave it).
 * Everything the server must learn goes into a per-Walnut journal it drains on
 * reconnect (`offline.drain` / `offline.ack`); until the journal is empty the
 * gateway keeps answering here, so no id the server has not seen yet reaches it.
 *
 * Imported by daemon-standalone.ts (createOfflineHostCore). The factory body references NOTHING at module scope; the envelope kit, the journal store (offline-journal-core.ts) and every
 * side effect arrive through deps. `createOfflineHost` (tests, other callers)
 * builds the journal store itself when none is given.
 */

import { noteProtection } from '../core/notes/locked-note.js'
import { createHash } from 'node:crypto'
import type { EnvelopeKit, EnvelopeOutcome } from '../core/peers/envelope-kit.js'
import type { SendRules } from '../core/sessions/send-rules.js'
import { createOfflineJournal } from './offline-journal-core.js'
import type { BoardOffline, OfflineSliceBoard } from './offline-board-core.js'
import type { HostReplica } from './host-replica-core.js'
import type { OfflineSearch } from './offline-search-core.js'
import type { OpenAsk, OpenItemsInput, OpenItemsText, OpenWait } from '../core/sessions/open-items-text.js'
import type { LetterCheck } from '../core/human-inbox/letter-check.js'
import { createTriggerLabel, type TriggerLabels } from '../core/routines/trigger-label.js'
import { createTriggerWatches, type TriggerWatches } from '../core/routines/trigger-watches.js'
import { pickHostTriggerTarget, type HostTriggerSession, type HostTriggerTarget } from '../core/routines/host-trigger-target.js'

/**
 * Pending records per Walnut a host keeps for its Mac before it refuses a write: a busy day of
 * writes while the Mac is off (sessions and plugin jobs: about 200 creates with their sessions,
 * 2,000 updates and messages; a task's updates fold into one record while it waits) with room
 * to spare. The twins pass it to the journal store too.
 */
export const OFFLINE_MAX_RECORDS = 10_000

/**
 * `aside`: an environment or lane session, which the server never picks as a message's address by name.
 * `noResume`: a session the server would never wake for a trigger (an error of its own making, another
 * agent's engine), so this host does not resume it either.
 */
export interface OfflineSliceSession {
  sid: string; taskId?: string; title?: string; aside?: boolean; noResume?: boolean
  /** Runs on an ACP engine (the server's ACP worker): never a same-host delivery target, whatever this host's registry holds. */
  acp?: boolean
  /**
   * An ACP session's worker runtime id (`acp-...`) when it differs from `sid`: that session's
   * `walnut` names itself by it (core/sessions/acp-caller-sid.ts), and `callerSidOf` maps it back.
   */
  runtimeId?: string
  /** The instruction notice for a session spawned before its default instructions changed, sent only while it is due, and the key naming that (instruction-notice.ts). */
  taskRoutingPolicy?: string; taskRoutingDue?: string
  /**
   * The message hints owed to this session right now (core/hints/hint-send.ts hostReplyTail:
   * `<system-reminder>` blocks, e.g. an every-turn hint or a change not yet told). A message this
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
  /** The task's org role when it has one (a lead, Main): a request to it gets a lead's deadline (send-rules.ts replyKindOf). */
  org_role?: string
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
  /** It carries another request (hands_on): its answer may go past its asker, so the server delivers it. */
  carries?: true
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
  /** The id the asked message went out as (the server's SessionRequest.messageId). */
  messageId?: string
  /** When this host wrote the asked message into the target's live CLI (SessionRequest.reachedAt). */
  reachedAt?: string
}

/** A reply's review score as journalled: normalized here (each 0..10), stamped when it was given. */
export interface OfflineReplyScore { function?: number; ux?: number; ui?: number; at: string; taskId: string }

/**
 * `online`: written while the server answered (a same-host message this host
 * delivered itself, handleLocal). The server takes it within moments, and a
 * relayed call never has to wait for it: the server drains before it answers.
 */
export type OfflineRecord =
  /**
   * `score` (on a row that turned replied, or a settle): a review's function / UX / UI score the
   * reply carried, with the replier's task, so the server keeps it on that task as an online reply
   * does (`noteReviewScore`). An older server reads the record without it: the score stays a line
   * of the delivered text, as before.
   */
  | { seq: number; at: number; online?: true; kind: 'row'; row: OfflineRequestRow; score?: OfflineReplyScore }
  | { seq: number; at: number; online?: true; kind: 'settle'; requestId: string; status: 'replied'; score?: OfflineReplyScore }
  | { seq: number; at: number; online?: true; kind: 'delivery'; fromSessionId: string; toSessionId: string; toTaskId?: string; messageId: string; requestId?: string; reply?: boolean; routingTold?: string }
  /**
   * `base`: the copy's updated_at for that task when the write was queued (the server's clock).
   * `trigger`: for a trigger created, paused, resumed or deleted here, the trigger as this host
   * runs it, so a resume here can arm it again (the server's set no longer carries a paused
   * trigger) and a trigger created here runs before the server has it. `armed`: for a
   * `trigger_update` (its args only the fields it changed), whether the trigger ran when it was changed.
   */
  | { seq: number; at: number; online?: true; kind: 'op'; op: string; args: Record<string, unknown>; callerSid: string; base?: string; trigger?: OfflineTrigger; callId?: string; armed?: boolean }
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
  | { kind: 'task-create'; taskId: string; fields: Record<string, unknown>; placement: { parentTaskId?: string; project?: string; inheritedProject?: string; groupId?: string; tier?: string }; order?: unknown }
  | { kind: 'task-move'; taskId: string; anchor: { after?: string; before?: string } | null; tier?: string; base?: unknown }
  | { kind: 'board'; op: string; args: Record<string, unknown>; postId?: string }
  | { kind: 'note'; path: string; noteId?: string; mode: 'put' | 'create' | 'delete'; baseHash: string | null; baseBlob: string | null; oursBlob: string | null }
  /**
   * A task's MEMORY.md append while away (offline-merge/apply-agent-memory.ts), for a Mac that drains
   * `agent-memory`: an older Mac's drain never asks for the kind, so its records wait here, never lost.
   */
  | { kind: 'agent-memory'; taskId: string; mode: 'append'; content: string }
  /** A paired device removed itself while the Mac was away (WP10): the Mac revokes it on drain. */
  | { kind: 'device-revoke'; deviceId: string; name?: string }
  /**
   * A new ask started on this host while the Mac was away (WP12, host-start-core.ts): the Mac adopts it on drain.
   * `routine`: a claude-code routine's run this host started (clock-host-start-v1), not an ask (no agent).
   * `run: 'task'`: a plain session of a task made on this host while the Mac was away (host-start-core.ts
   * planTask), not an ask; written only for a Mac whose drains list `task-start`.
   */
  | { kind: 'session'; sid: string; taskId: string; host: string; cwd: string; agentId?: string; model?: string; effort?: string; mode: string; title: string; startedAt: number; firstMessage?: string
    routine?: { id: string; slotMs: number }; run?: 'task' }
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
  'summary', 'description', 'note', 'sprint', 'unread', 'focus_tier', 'pin_order', 'depends_on', 'wait_until', 'parent_task_id', 'watched_at', 'background_at',
]
export { QUEUEABLE_TASK_FIELDS }

type GatewayResult = { ok: true; result: Record<string, unknown> } | { ok: false; error: { code: string; message: string; retryAfterMs?: number; detail?: unknown } }

// noticeLeftOut: the line went without its instruction notice, which the server's path just gave (daemon-core.ts createNoticeOnce).
export type DeliverResult = { ok: true; noticeLeftOut?: true } | { ok: false; reason: string }

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
  /**
   * The triggers this daemon runs now. `home`: the Walnut whose set holds it; absent
   * for a set that named none (an older server), whose `deliver.home` says whose it is.
   */
  armed(): Array<{ home?: string; def: OfflineTrigger; status: OfflineTriggerStatus }>
  /** Run a check once and read or write no state (`triggers.test`); rejects with the daemon's refusal. */
  test(check: { run: string; cwd?: string; timeoutSeconds?: number }, triggerId?: string, home?: string): Promise<Record<string, unknown>>
  /** A create, pause, resume or delete was made here: arm and disarm by `triggerHolds()` now. */
  changed(): void
  /** A session's working directory, for a test or a create that names none. */
  cwdOf?(sid: string): string | undefined
  /**
   * The daemon's own check of a wire def (trigger-check-core.ts validateTriggerDef), so a
   * trigger created here is refused at once rather than journaled and never armed.
   * Absent: trigger_create needs the server.
   */
  validate?(def: OfflineTrigger): { ok: true } | { ok: false; error: string }
}

/**
 * The last trigger write made here per id that the server has not taken yet.
 * `created`: the trigger itself was created here (the server has no routine of that id yet).
 * `updated`: it was changed here (trigger_update), so `def` runs in place of the server's.
 * `keepsState`: only changed here, never switched on or off here, so the server's set still
 * says whether it runs (`on` is what it was when changed, for the lists here).
 */
export interface TriggerHold { home: string; on: boolean; deleted?: boolean; created?: true; def?: OfflineTrigger; updated?: true; keepsState?: true }

export interface OfflineHostDeps {
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  /** Directory for slice-<key>.json / journal-<key>.json. */
  dir: string
  now: () => number
  randomHex: (bytes: number) => string
  /** Short stable file key for a home (a hash; homes are paths). */
  keyOf: (home: string) => string
  /**
   * The home a Walnut is kept under here (walnut-scope-core.ts canonical): a slice of a home
   * that became another's alias is not that Walnut's copy. Absent: every home is its own.
   */
  canonical?: (home: string) => string
  kit: EnvelopeKit
  /** The send rules the server runs (core/sessions/send-rules.ts createSendRules): reply default, wake, deadlines, refusals. */
  rules: SendRules
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
  /** `resend`: the same message may have gone before (a trigger fire): the daemon writes nothing when its line record says it did. */
  deliver: (sid: string, text: string, messageId: string, o?: { resend?: boolean }) => Promise<DeliverResult>
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
  /** A trigger's short label (trigger-label.ts); absent: a trigger created here is named by its description's start. */
  labels?: TriggerLabels
  /** How a trigger's `watches` reads (trigger-watches.ts): the source twin passes its inlined copy. */
  watches?: TriggerWatches
  /** Which session here takes a trigger fire (host-trigger-target.ts): the source twin passes its inlined copy. */
  triggerTarget?: typeof pickHostTriggerTarget
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
  /** Pending records per Walnut before a write is refused (default OFFLINE_MAX_RECORDS). */
  maxRecords?: number
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
  /** The score dimensions a reply's `score` carries (peers/structured-reply.ts SCORE_DIMENSIONS). */
  const OFFLINE_SCORE_DIMS = ['function', 'ux', 'ui'] as const

  /**
   * `score` of a reply as the server reads it (structured-reply.ts readScore / scoreProblem): an
   * object of function / ux / ui (any key case) or the text "n/n/n", each 0..10, one decimal.
   * undefined when none was given; null when it is unusable (the server answers 400 for it).
   */
  function offlineScoreOf(v: unknown): Partial<Record<(typeof OFFLINE_SCORE_DIMS)[number], number>> | null | undefined {
    if (v === undefined || v === null) return undefined
    const num = (x: unknown): number | undefined => {
      const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() ? Number(x.trim().replace(/\s*\/\s*10$/, '')) : NaN
      return Number.isFinite(n) && n >= 0 && n <= 10 ? Math.round(n * 10) / 10 : undefined
    }
    let raw: Record<string, unknown>
    if (typeof v === 'string') {
      const parts = v.trim().split(/\s*[/,|]\s*/)
      if (parts.length !== 3) return null
      raw = { function: parts[0], ux: parts[1], ui: parts[2] }
    } else if (typeof v === 'object' && !Array.isArray(v)) {
      raw = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k.toLowerCase(), x]))
      if (Object.keys(raw).some((k) => !(OFFLINE_SCORE_DIMS as readonly string[]).includes(k))) return null
    } else return null
    const out: Partial<Record<(typeof OFFLINE_SCORE_DIMS)[number], number>> = {}
    for (const d of OFFLINE_SCORE_DIMS) {
      if (raw[d] === undefined) continue
      const n = num(raw[d])
      if (n === undefined) return null
      out[d] = n
    }
    return Object.keys(out).length ? out : null
  }

  const { fs, path, kit, rules } = deps
  // The same as the module's escapeSenderWords: the factory body reaches nothing at
  // module scope.
  const escapeSenderWords = (text: string): string => {
    if (!/system-reminder/i.test(text)) return text
    return text.replace(/(<|&(?:amp;)*lt;)(\/?)(system-reminder)/gi, (_m, open: string, slash: string, name: string) =>
      `${open === '<' ? '&lt;' : `&amp;${open.slice(1)}`}${slash}${name}`)
  }
  // matchIdRef / refNamesId of src/lib/id-ref.ts, inlined for the same reason: the
  // item whose id IS the reference wins, and only when none does is it a prefix.
  const matchIdRef = <T,>(items: readonly T[], ref: string, idOf: (item: T) => string): T[] => {
    const byPrefix: T[] = []
    for (const item of items) {
      const id = idOf(item)
      if (id === ref) return [item]
      if (ref && id.startsWith(ref)) byPrefix.push(item)
    }
    return byPrefix
  }
  const refNamesId = (ref: string | null | undefined, id: string, exactExists: boolean): boolean =>
    !!ref && (id === ref || (!exactExists && id.startsWith(ref)))
  // OFFLINE_MAX_RECORDS (module scope, so the twins and the journal store share it): not
  // referenced here, the factory body is inlined as text.
  const MAX_RECORDS = deps.maxRecords ?? 10_000
  const MAX_ARGS_BYTES = 256 * 1024
  const WRITE_BUDGET = 30
  const WRITE_WINDOW_MS = 60_000
  /** Waits before running a write again that another process's journal lock refused (whenUnlocked). */
  const LOCK_RETRY_MS = [100, 300, 900]
  const DRAIN_BATCH = 200
  const QUEUED_OPS = ['task_update', 'task_complete']
  /** Held while nothing can take them (holdWrite); the Mac's twin list: offline-handover.ts HELD_OPS. */
  const HELD_OPS = ['task_send', 'session_send', 'agent_memory_write']
  /**
   * Inputs task_update retired (its `retiredInput` in src/ops/tasks.ts): dropped, never a
   * reason to refuse, as the server's executor drops them (an older session still sends
   * wait_report with a park; 2026-10-05 such a replay was refused and lost).
   */
  // waiting_on is no task field: the server's park gate reads it online (sessions/outside-wait.ts)
  // and a queued park is checked again at replay, so it is dropped here, never a refusal.
  const RETIRED_TASK_INPUTS = ['wait_report', 'waiting_on']
  /**
   * What a close says beyond its phase and its score (task_complete's result, evidence and
   * not_done, and the force, reason and user_words of the close gate) rides no away record: a
   * close that says any of them needs the server, never queued with them dropped. The host
   * replica answers the same (replica/write-port.ts taskComplete); away-op-fields.test.ts holds
   * this list to task_complete's own input, so a new input is decided here before it ships.
   */
  const CLOSE_NEEDS_SERVER = ['result', 'evidence', 'not_done', 'force', 'reason', 'user_words']
  /** A value that says something: an empty text or list and a false flag say nothing. */
  const saysSomething = (v: unknown): boolean => v !== undefined && v !== null && v !== '' && v !== false && !(Array.isArray(v) && v.length === 0)
  /** The fields a task write may queue (task-outbox whitelist plus phase, parent, pinned, focus tier). */
  const QUEUEABLE = [
    'title', 'status', 'phase', 'priority', 'project', 'group_id', 'due_date', 'start_date', 'end_date', 'pinned', 'tags',
    'summary', 'description', 'note', 'sprint', 'unread', 'focus_tier', 'pin_order', 'depends_on', 'wait_until', 'parent_task_id', 'watched_at', 'background_at',
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
  // The checks run on this host, so it answers for them itself (create, pause, resume
  // and delete take effect here at once and reach Walnut when the server is back).
  const TRIGGER_WRITE_OPS = ['trigger_create', 'trigger_pause', 'trigger_resume', 'trigger_delete', 'trigger_update']
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
  /** A trigger armed here: only for a Mac that replays it under the id this host gave it. */
  const TRIGGER_CREATE_OP = {
    name: 'trigger_create', title: 'Create a trigger on this host (runs here now, sent later)',
    description: 'This host starts checking it at once and delivers its fires into sessions here; Walnut records it, with the same id, when the server reconnects. A template trigger, or one for a task or host this host does not hold, needs the server.',
    readonly: false, signature: 'run every prompt description [name] [session] [cwd] [timeoutSeconds] [maxFiresPerDay] [wait] [wait_until] [watches]',
  }
  function createsTriggers(home: string): boolean {
    return !!deps.triggers && typeof deps.triggers.validate === 'function' && drainsKind(home, 'trigger-create')
  }
  /** The ops this host answers for `home` (tools.list, walnut_status): a letter or a new trigger only when the leading Mac drains it. */
  /** A task's MEMORY.md append while away: for a Mac that drains `agent-memory` (offline-merge/apply-agent-memory.ts). */
  const AGENT_MEMORY_OP = {
    name: 'agent_memory_write', title: 'Append to a task\'s MEMORY.md (saved here, applied later)',
    description: 'mode append only: the entry is saved on this host and added to the task\'s MEMORY.md, after what it holds then, when the Walnut server is back. replace and memory folder files need the server.',
    readonly: false, signature: 'content [task] [mode=append]',
  }

  function awayOps(home: string): typeof OFFLINE_OPS {
    const extra = [
      ...(deps.letters && drainsKind(home, 'letter') ? [LETTER_OP] : []),
      ...(createsTriggers(home) ? [TRIGGER_CREATE_OP] : []),
      ...(drainsKind(home, 'agent-memory') ? [AGENT_MEMORY_OP] : []),
    ]
    return extra.length ? OFFLINE_OPS.concat(extra) : OFFLINE_OPS
  }

  /** How long a drained-but-unacked row is left to the server before this host acts on it again. */
  const HANDOVER_GRACE_MS = 60_000

  const slices = new Map<string, HostSlice>()
  /** The asOf last written per home: an unchanged copy's newer asOf is written at most once a day. */
  const writtenAsOf = new Map<string, number>()
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
      // A copy its home sent before this host knew the home as another's alias: that Walnut's own is kept.
      if (deps.canonical && deps.canonical(slice.home) !== slice.home) continue
      // Read again after the boot migration copied slices here: a copy a Mac sent since wins.
      const mine = slices.get(slice.home)
      if (mine && Number(mine.asOf ?? 0) >= Number(slice.asOf ?? 0)) continue
      slices.set(slice.home, slice)
      writtenAsOf.set(slice.home, Number(slice.asOf ?? 0))
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
      if (r.code === 'queue_full') noteFull(home, kind)
      return r
    }
    notePeak(home)
    if (!r.duplicate) { try { deps.onJournal?.(home) } catch { /* a notify failure never loses the record */ } }
    return r
  }

  // ── how full the journal came (Walnut Health hears it with the next drain: offline.drain `fill`) ──
  /** Per Walnut, since the drain that last reported it: the most records waiting at once, and writes refused as full. */
  const fill = new Map<string, { peak: number; refused: number }>()
  const fillOf = (home: string) => { const f = fill.get(home) ?? { peak: 0, refused: 0 }; fill.set(home, f); return f }
  function notePeak(home: string): void {
    const f = fillOf(home)
    const n = journal.size(home)
    if (n > f.peak) {
      // Logged once as it crosses 80%: the Mac is told at its next drain, nobody can be before.
      if (f.peak < MAX_RECORDS * 0.8 && n >= MAX_RECORDS * 0.8) deps.log('warn', 'offline host: the journal for the Walnut server is nearly full', { home, records: n, max: MAX_RECORDS })
      f.peak = n
    }
  }
  function noteFull(home: string, kind: string): void {
    const f = fillOf(home)
    f.refused++
    // Never a silent refusal: the caller hears queue_full, and the log says so once per 100.
    if (f.refused % 100 === 1) deps.log('error', 'offline host: the journal for the Walnut server is full; writes are refused until it drains', { home, kind, refused: f.refused, max: MAX_RECORDS })
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
    if (changed) { writeAtomic(file('slice', slice.home), slice); writtenAsOf.set(slice.home, Number(slice.asOf ?? 0)) } else persistAsOf(slice)
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
    if (typeof asOf === 'number' && Number.isFinite(asOf) && asOf > Number(held.asOf ?? 0)) { held.asOf = asOf; persistAsOf(held) }
    return true
  }

  /**
   * The Walnuts this host keeps a copy of that are still in use: a server of it was bound
   * here lately (`served`, the week served-walnuts keeps), or its copy was sent or
   * confirmed within `maxAgeMs` (30 days). Older is a Walnut nothing keeps here (a test
   * run's), which says nothing about who calls. Of two or more, those that hold something (a
   * session, task or request) win over an empty one (2026-11-13: an empty copy a test left made two
   * fresh copies, and 90% of the host's outside calls answered "no server"); a Walnut whose own
   * copy is empty (no session here this week) is kept when it is the only fresh one.
   */
  function freshHomes(served?: (home: string) => boolean, now: number = deps.now(), maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): string[] {
    const out: string[] = []
    const holding: string[] = []
    for (const [home, slice] of slices) {
      if (!((served && served(home)) || now - Number(slice.asOf ?? 0) <= maxAgeMs)) continue
      out.push(home)
      if ((slice.sessions?.length ?? 0) + (slice.tasks?.length ?? 0) + (slice.requests?.length ?? 0) > 0) holding.push(home)
    }
    return out.length > 1 && holding.length > 0 ? holding : out
  }

  function persistAsOf(slice: HostSlice): void {
    const at = Number(slice.asOf ?? 0)
    const last = writtenAsOf.get(slice.home)
    if (last !== undefined && at - last < 24 * 60 * 60 * 1000) return
    writtenAsOf.set(slice.home, at)
    writeAtomic(file('slice', slice.home), slice)
  }

  /**
   * `from` became an alias of `to` (walnut-scope-core.ts adopt): the copy it sent first is
   * `to`'s when it is newer, under `to`'s own name; `from` holds none from now on. Its file
   * stays where it is (the boot load leaves it out), so nothing an older daemon reads moves.
   */
  function foldHome(from: string, to: string): void {
    const slice = slices.get(from)
    if (!slice || from === to) return
    slices.delete(from)
    writtenAsOf.delete(from)
    const mine = slices.get(to)
    if (!mine || Number(slice.asOf ?? 0) >= Number(mine.asOf ?? 0)) configure({ ...slice, home: to })
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

  /** The Walnut whose copy names an ACP session by its worker's runtime id (its journal's name). */
  function runtimeOwnerOf(runtimeId: string): string | undefined {
    if (!runtimeId) return undefined
    for (const [home, slice] of slices) if (slice.sessions.some((s) => s.runtimeId === runtimeId)) return home
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
    const actor = by === undefined ? { kind: 'session' as const, sid } : actorOf(by, home)
    if (actor === 'older') return { ok: false, refused: fail('needs_leader', 'your Mac runs an older Walnut that cannot take a session a plugin job started later; it needs your Mac', { detail: { why: 'mac_too_old' } }) }
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
   * Whether a plain session of a task made here may start (`run: 'task'`): its `session`
   * record would be kept, for a Mac that adopts it as the task's own (`task-start` in its
   * drains; an older Mac would take it for an ask). Journals nothing.
   */
  function checkTaskStart(home: string, sid: string, by?: unknown): GatewayResult {
    if (slices.get(home) && !drainsKind(home, 'task-start')) {
      return fail('needs_leader', 'your Mac runs an older Walnut that cannot take a session started here later; it needs your Mac', { detail: { why: 'mac_too_old' } })
    }
    return checkSession(home, sid, by)
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
  function drain(home: string, kinds?: string[] | null): { records: OfflineJournalRecord[]; more: boolean; now: number; error?: string; why?: string; fill: { records: number; max: number; peak: number; refused: number } } {
    const out = journal.drain(home, { kinds: Array.isArray(kinds) ? kinds.filter((k) => typeof k === 'string') : null, batch: DRAIN_BATCH })
    // The server may notice a row it just imported; this host stays quiet on it
    // meanwhile, or the asker could hear twice.
    for (const r of out.records) if (r.kind === 'row') handingOver.set((r as unknown as { row: OfflineRequestRow }).row.id, deps.now())
    // How full the journal came while the Mac was away: the Mac tells Walnut Health (offline-handover.ts).
    // Each reply counts since the last one (the Mac adds its rounds up: journal-fill.ts mergeJournalFill).
    const f = fillOf(home)
    const records = journal.size(home)
    const report = { records, max: MAX_RECORDS, peak: Math.max(f.peak, records), refused: f.refused }
    fill.set(home, { peak: records, refused: 0 })
    return { ...(out as unknown as { records: OfflineJournalRecord[]; more: boolean; now: number; error?: string; why?: string }), fill: report }
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
          ...(p.parentTaskId ? { parent_task_id: p.parentTaskId } : {}),
          ...(p.project !== undefined ? { project: p.project } : p.inheritedProject !== undefined ? { project: p.inheritedProject } : {}),
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
    const hits = id.length >= 4 ? matchIdRef(tasks, id, (t) => t.id) : []
    if (hits.length === 1) return { task: hits[0] }
    if (hits.length > 1) {
      return { error: fail('ambiguous_peer', `"${id}" matches ${hits.length} tasks on this host`, { detail: { candidates: hits.map((t) => ({ id: t.id, shortId: t.id, title: t.title })) } }) }
    }
    return {}
  }

  function sessionOf(home: string, sid: string): OfflineSliceSession | undefined {
    return slices.get(home)?.sessions.find((s) => s.sid === sid) ?? startedOf(home).find((s) => s.sid === sid)
  }

  /**
   * A session this host delivers into itself: a CLI live in its registry, and never one the copy
   * marks ACP (its runner is the server's ACP worker; a CLI under its id is a stray, 2026-11-10).
   * Every same-host delivery decision reads this, never deps.isLive alone (tests/providers/acp-never-native-ratchet.test.ts).
   */
  function liveHere(home: string, sid: string): boolean {
    return deps.isLive(sid) && !sessionOf(home, sid)?.acp
  }

  /** This Walnut's sessions whose CLI this host delivers into now (liveHere): a trigger fire's candidates for the host's own server. */
  function liveSessionsOf(home: string): string[] {
    const all = (slices.get(home)?.sessions ?? []).concat(startedOf(home))
    return [...new Set(all.map((s) => s.sid))].filter((sid) => liveHere(home, sid))
  }

  /** The session a gateway caller sid names: an ACP session's runtime id becomes its record id. */
  function callerSidOf(home: string, sid: string): string {
    try {
      if (!sid.startsWith('acp-') || sessionOf(home, sid)) return sid
      return slices.get(home)?.sessions.find((s) => s.runtimeId === sid)?.sid ?? sid
    } catch { return sid }
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

  async function deliverWithTaskRouting(home: string, sid: string, text: string, messageId: string, o?: { resend?: boolean }): Promise<DeliverResult> {
    const routed = withTaskRouting(home, sid, withReplyTail(home, sid, text))
    const delivered = o?.resend ? await deps.deliver(sid, routed.text, messageId, o) : await deps.deliver(sid, routed.text, messageId)
    // A notice the daemon left out (the server's path gave it) is the server's to record.
    if (delivered.ok && routed.due && !delivered.noticeLeftOut) markRouted(sid, messageId, routed.due)
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

  /** A caller is named by its TASK's title, the session's own only without one (as the server: peers/sender-name.ts). */
  function callerIdentity(home: string, sid: string): { title: string; taskId?: string } {
    const row = sessionOf(home, sid)
    const taskId = row?.taskId
    const title = (taskId ? slices.get(home)?.tasks.find((t) => t.id === taskId)?.title?.trim() : undefined) || row?.title || ''
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

  /** Room for `need` more records, or the refusal a full journal gives. */
  function roomFor(home: string, need = 1): GatewayResult | null {
    if (journal.size(home) + need <= MAX_RECORDS) return null
    noteFull(home, 'room')
    return fail('queue_full', `this host already holds ${MAX_RECORDS} records for the Walnut server; wait for it to reconnect`, { retryAfterMs: 60_000, detail: { why: 'journal_full' } })
  }

  function messageId(given: unknown): string {
    return typeof given === 'string' && /^qm-[A-Za-z0-9-]{1,64}$/.test(given) ? given : `qm-offline-${deps.randomHex(8)}`
  }

  /** A request's deadline as the server sets it (send-rules.ts): by its target's kind (a lead or Main answers for its teams). */
  function replySecs(home: string, secs: unknown, implicit: boolean, toTaskId: string | undefined): number {
    const target = toTaskId ? tasksWithOverlay(home).find((t) => t.id === toTaskId) : undefined
    return rules.clampReplyTimeoutSecs(typeof secs === 'number' ? secs : undefined, implicit, rules.replyKindOf(target?.org_role))
  }

  /** Whether a delivered send opens a request, by the server's rule (send-rules.ts opensRequest; up the org it reports). */
  function opensRequest(home: string, args: Record<string, unknown>, fromTaskId: string | undefined, toTaskId: string | undefined): boolean {
    const input = rules.ruleInputOf(args)
    return rules.opensRequest(input, rules.directionDecides(input) && reportsUp(home, fromTaskId, toTaskId))
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

  /**
   * The reply line under a new request, naming the same asker's other open requests to the same
   * target (the server's sameAskerOpen): one answer settles all, read once. From what this host
   * holds: its own rows, and the copy's still unsettled ones.
   */
  function replyTrailer(home: string, row: OfflineRequestRow): string {
    const j = journalOf(home)
    const same = (r: { id: string; fromSessionId: string; toSessionId?: string; toTaskId?: string; status: string }) =>
      r.id !== row.id && r.status === 'pending' && r.fromSessionId === row.fromSessionId
      && ((!!r.toSessionId && r.toSessionId === row.toSessionId) || (!!row.toTaskId && r.toTaskId === row.toTaskId))
    const open = new Map<string, string>()
    for (const r of Object.values(j.rows)) if (same(r)) open.set(r.id, r.createdAt)
    for (const r of slices.get(home)?.requests ?? []) if (same(r) && !j.settledCopies.includes(r.id) && !open.has(r.id)) open.set(r.id, r.createdAt)
    const alsoOpen = [...open.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id]) => id)
    return kit.buildReplyTrailer(row, alsoOpen.length ? { alsoOpen } : undefined)
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
      const ids = new Set(tasks.map((t) => t.id))
      const children = tasks
        .filter((t) => t.id !== task.id && refNamesId(t.parent_task_id, task.id, ids.has(t.parent_task_id ?? '')) && t.phase !== 'COMPLETE')
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
    // The Stop hook (unanswered-at-stop.ts) is the server's call; this host's copy never holds a turn.
    if (args.hook === 'stop') return ok({})
    // A hook of the instructions' own (the server's instruction-hook-parts.ts): this copy has no parts to give.
    if (args.hook === 'compact' && args.part !== undefined) return ok({})
    if (args.hook === 'compact') {
      let context = withTaskRouting(home, callerSid, text, true).text
      // Claude Code shows the model only a preview of a hook's text past 10,000 characters (the
      // server's open-items.ts HOOK_CONTEXT_MAX): changes that do not fit come with the next message.
      if (context.length > 9_500) {
        context = ['Walnut changed some of your default instructions since this session started. They are too long to '
          + 'restate here and come in full in front of your next message: where your system prompt differs from them, they win.', text]
          .filter(Boolean).join('\n\n').slice(0, 9_500)
      }
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
    if (!refNamesId(parentRef, targetTaskId, tasks.some((t) => t.id === parentRef))) return undefined
    const parent = tasks.find((t) => t.id === targetTaskId)
    if (parent?.phase !== 'COMPLETE') return undefined
    const no = rules.parentCompleteRefusal(parent)
    return fail(no.code, no.message, { detail: no.detail })
  }

  /**
   * The server's rule (send-rules.ts admitRetiredLeadRule): a session's new message to a lead that
   * handed its project over is refused with the lead that took it, unless the caller is that lead or
   * it forces with a reason (which then leads the text). The text to deliver, or the refusal.
   */
  function admitRetiredLead(home: string, callerSid: string, targetTaskId: string | undefined, args: Record<string, unknown>, text: string): { text: string } | { error: GatewayResult } {
    const lead = targetTaskId ? tasksWithOverlay(home).find((t) => t.id === targetTaskId) : undefined
    const now = lead?.handed_over_to
    if (!lead || !now || callerIdentity(home, callerSid).taskId === now.id) return { text }
    const project = (lead.project ?? '').trim()
    const r = rules.admitRetiredLeadRule({
      message: kit.handedOverPointer({ id: lead.id, title: lead.title, project }, now),
      detail: { taskId: lead.id, currentLeadTaskId: now.id, project },
      retired: { lead: { id: lead.id, title: lead.title, ...(lead.phase ? { phase: lead.phase } : {}) } },
    }, rules.ruleInputOf(args), text)
    return 'error' in r ? { error: fail(r.error.code, r.error.message, r.error.detail ? { detail: r.error.detail } : undefined) } : r
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

  /**
   * A request this host answered: settled in its copy and journaled, with the reply's score (the
   * server keeps it on the replier's task). `online`: answered while the server answers (handleLocal).
   */
  function settleHere(home: string, id: string, own: OfflineRequestRow | undefined, replierTaskId: string | undefined, rawScore: unknown, online = false): void {
    const given = offlineScoreOf(rawScore)
    const score: OfflineReplyScore | undefined = given && replierTaskId ? { ...given, at: new Date(deps.now()).toISOString(), taskId: replierTaskId } : undefined
    if (own) {
      // Open, or settled here without an answer (the turn end's notice, overdue, withdrawn: the
      // server's answersLate): the answer settles it, so the Mac's drain reads it replied too.
      // Inlined, not imported: this factory body references nothing at module scope.
      if (own.status === 'pending' || own.status === 'notified' || own.status === 'expired' || own.status === 'withdrawn') {
        own.status = 'replied'
        own.settledAt = new Date(deps.now()).toISOString()
        append(home, { kind: 'row', row: { ...own }, ...(score ? { score } : {}) }, online)
      }
    } else if (!journalOf(home).settledCopies.includes(id)) {
      journalOf(home).settledCopies.push(id)
      append(home, { kind: 'settle', requestId: id, status: 'replied', ...(score ? { score } : {}) }, online)
    }
  }

  // ── the mechanics of a peer message this host writes (opTaskSend, localSend, follower.peer) ──

  /**
   * The request row of a message this host delivers, with what only this host knows at the moment
   * it is made: a turn under way (the CLI may take the message into it or queue it for the next, so
   * only the NEXT turn end proves it went unanswered), and the stream offset before the write (the
   * tailer may still be catching up on older lines, a startup result or a finished turn, while the
   * delivery is in flight, and none of those answers this message).
   */
  function requestRow(o: { id: string; fromSessionId: string; toSessionId: string; toTaskId?: string; preview: string; secs: number; online: boolean }): OfflineRequestRow {
    const row: OfflineRequestRow = {
      id: o.id,
      fromSessionId: o.fromSessionId,
      toSessionId: o.toSessionId,
      ...(o.toTaskId ? { toTaskId: o.toTaskId } : {}),
      preview: o.preview,
      status: 'pending',
      createdAt: new Date(deps.now()).toISOString(),
      deadlineAt: deps.now() + o.secs * 1000,
      ...(deps.turnActive(o.toSessionId) ? { skipTurnEnds: 1 } : {}),
      ...(o.online ? { online: true as const } : {}),
    }
    const offset = deps.streamOffset(o.toSessionId)
    if (typeof offset === 'number') row.afterV = offset
    return row
  }

  /**
   * The tail of every peer message this host writes: the reply line under an ask (naming the same
   * asker's other open requests to this target), the row registered BEFORE the write (the envelope
   * that names it can be read at once), the write, the row dropped again when nothing was written,
   * then `row` and `delivery` journaled. `opId`: the delivery record's (a follower's retry key).
   */
  async function deliverPeer(home: string, p: { fromSessionId: string; toSessionId: string; toTaskId?: string; envelope: string; messageId: string; row?: OfflineRequestRow; online: boolean; opId?: string }): Promise<DeliverResult> {
    const row = p.row
    const text = row ? `${p.envelope}\n${replyTrailer(home, row)}` : p.envelope
    if (row) journalOf(home).rows[row.id] = row
    const delivered = await deliverWithTaskRouting(home, p.toSessionId, text, p.messageId)
    if (!delivered.ok) {
      if (row) { delete journalOf(home).rows[row.id]; persistJournal(home) }
      return delivered
    }
    // Written into its live CLI: the target has the ask (a silent target's notice reads it).
    if (row) { row.messageId = p.messageId; row.reachedAt = new Date(deps.now()).toISOString() }
    if (row) append(home, { kind: 'row', row: { ...row } }, p.online)
    append(home, { kind: 'delivery', fromSessionId: p.fromSessionId, toSessionId: p.toSessionId, ...(p.toTaskId ? { toTaskId: p.toTaskId } : {}), messageId: p.messageId, ...(row ? { requestId: row.id } : {}) }, p.online, p.opId ? { opId: p.opId } : {})
    return delivered
  }

  /**
   * The tail of every answer this host writes into its asker's session: the write, then the request
   * settled here (this host's own row, or the copy's) with the reply's score, and the delivery
   * journaled. Nothing written: nothing settled.
   */
  async function deliverReply(home: string, p: { fromSessionId: string; toSessionId: string; requestId: string; text: string; messageId: string; replierTaskId?: string; score?: unknown; online: boolean; opId?: string }): Promise<DeliverResult> {
    const own = journalOf(home).rows[p.requestId]
    const delivered = await deliverWithTaskRouting(home, p.toSessionId, p.text, p.messageId)
    if (!delivered.ok) return delivered
    settleHere(home, p.requestId, own, p.replierTaskId, p.score, p.online)
    append(home, { kind: 'delivery', fromSessionId: p.fromSessionId, toSessionId: p.toSessionId, messageId: p.messageId, requestId: p.requestId, reply: true }, p.online, p.opId ? { opId: p.opId } : {})
    return delivered
  }

  /**
   * in_reply_to as a list (the server's performReplies): every id is checked before anything is
   * sent; per asker, its first request carries the answer, naming the others, which settle here
   * with it, so each asker reads it once.
   */
  async function opReplies(home: string, callerSid: string, args: Record<string, unknown>, text: string, ids: readonly string[]): Promise<GatewayResult> {
    const me = callerIdentity(home, callerSid)
    const byAsker = new Map<string, string[]>()
    for (const id of ids) {
      const { own, copy } = findRequest(home, id)
      const row = own ?? copy
      if (!row) return needsServer(`Request ${id} is not held by this host; answering it`)
      if (!(row.toSessionId === callerSid || (!!row.toTaskId && row.toTaskId === me.taskId))) return fail('bad_request', `request ${id} was not addressed to this session`)
      byAsker.set(row.fromSessionId, [...(byAsker.get(row.fromSessionId) ?? []), id])
    }
    let first: GatewayResult | undefined
    let firstFailure: GatewayResult | undefined
    const answered: string[] = []
    const notAnswered: string[] = []
    // One message id per asker's delivery: a queue that dedups by message id must not take the
    // second asker's answer for a retry of the first's.
    const mid = messageId(args.messageId)
    let n = 0
    for (const group of byAsker.values()) {
      const [lead, ...rest] = group
      const named = rest.length ? `${text}\n\n(This one answer also settles ${rest.join(', ')}: nothing more comes for ${rest.length === 1 ? 'it' : 'them'}.)` : text
      const sent = await opReply(home, callerSid, { ...args, in_reply_to: lead, messageId: n++ ? `qm-${mid.slice(3, 63)}-${n}` : mid }, named)
      // Nothing sent yet: the whole call goes on as it is (to the companion or the server, or held).
      if (!sent.ok && !first) return sent
      if (!sent.ok) {
        // Not hidden behind an earlier group's success: told below, by id.
        firstFailure ??= sent
        notAnswered.push(...group)
        continue
      }
      first ??= sent
      answered.push(...group)
      for (const id of rest) settleHere(home, id, findRequest(home, id).own, me.taskId, args.score)
    }
    if (!first || !first.ok) return fail('internal', 'nothing answered')
    if (!notAnswered.length) return ok({ ...first.result, answered, next: 'Nothing else is required. Do not answer them again one by one.' })
    const why = !firstFailure || firstFailure.ok ? '' : firstFailure.error.message
    return ok({
      ...first.result, answered, notAnswered, notAnsweredWhy: why.slice(0, 300),
      next: `It did NOT settle ${notAnswered.join(', ')}${why ? ` (${why.slice(0, 160)})` : ''}: send the answer again with in_reply_to ${JSON.stringify(notAnswered)} only. The others are settled: do not answer them again.`,
    })
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
    const remoteHost = liveHere(home, row.fromSessionId) ? undefined : row.fromHost
    if (!liveHere(home, row.fromSessionId) && !(remoteHost && deps.relay)) {
      return needsServer(`The asking session (${row.fromSessionId.slice(0, 8)}) is not running on this host; routing the answer`)
    }
    const denied = admitWrite(callerSid) ?? roomFor(home)
    if (denied) return denied
    const slice = slices.get(home)!
    const wrapped = kit.buildReplyDeliveryText(row, {
      title: me.title, shortId: callerSid.slice(0, 8), host: slice.host, sessionId: callerSid, taskId: me.taskId,
    }, escapeSenderWords(admitted.text), { title: typeof args.title === 'string' ? args.title : undefined })
    const mid = messageId(args.messageId)
    if (remoteHost) {
      const relayed = await deps.relay!(home, { toHost: remoteHost, toSid: row.fromSessionId, text: wrapped, messageId: mid, requestId: id, reply: true, fromSessionId: callerSid })
      if (!relayed.ok) return needsServer(`The asking session runs on ${remoteHost} and the answer could not be routed there (${relayed.reason}); answering it`)
      // The host that writes the text into the asker's session journals the delivery: not this one.
      settleHere(home, id, own, me.taskId, args.score)
    } else {
      const delivered = await deliverReply(home, { fromSessionId: callerSid, toSessionId: row.fromSessionId, requestId: id, text: wrapped, messageId: mid, replierTaskId: me.taskId, score: args.score, online: false })
      if (!delivered.ok) return fail('internal', `delivery to the asking session failed: ${delivered.reason}`)
    }
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
      if (slice.sessions.some((s) => s.acp && s.sid === task.session_id)) {
        return { error: needsServer(`Task ${task.id} runs on an ACP engine; delivering to it`) }
      }
      const live = slice.sessions.filter((s) => s.taskId === task.id && liveHere(home, s.sid))
      if (live.length === 0) {
        return { error: needsServer(`Task ${task.id} has no session running on this host; starting one`) }
      }
      // The session the server picks (session-send-core.ts): the task's current
      // one, else the most recently active (the copy lists sessions newest first).
      const current = live.find((s) => s.sid === task.session_id) ?? live[0]
      return { sid: current.sid, taskId: task.id, title: current.title ?? task.title }
    }
    const ref = to.trim()
    const byId = matchIdRef(slice.sessions, ref, (s) => s.sid).filter((s) => s.sid === ref || ref.length >= 8)
    if (byId.length === 1) {
      if (!liveHere(home, byId[0].sid)) return { error: needsServer(`Session ${ref} is not running on this host; resuming it`) }
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
    // A review's score (function / UX / UI out of 10) rides as a line of the text too.
    const sc = args.in_reply_to !== undefined ? offlineScoreOf(args.score) : undefined
    if (sc === null) return fail('bad_request', 'score must be {"function": n, "ux": n, "ui": n} (any of them, each 0..10) or "n/n/n"')
    const score = sc ? OFFLINE_SCORE_DIMS.filter((d) => sc[d] !== undefined)
      .map((d) => `${d === 'function' ? 'function' : d.toUpperCase()} ${sc[d]}/10`).join(', ') : ''
    const text = [own, result && result !== own ? `Result: ${result}` : '',
      evidence.length ? `Evidence:\n${evidence.map((e) => `- ${e}`).join('\n')}` : '',
      notDone.length ? `Not done (partial reply):\n${notDone.map((e) => `- ${e}`).join('\n')}` : '',
      score ? `Score: ${score}` : ''].filter(Boolean).join('\n\n')
    if (!text) return fail('bad_request', 'text must be a non-empty string')
    // An answer for the user is recorded on the asking task by the server, which also keeps it from
    // waking a task that is not running (ask-answer.ts answerReach): never delivered here as a plain message.
    if (args.withdraw_ask === true && args.answers_ask !== true) return fail('bad_request', 'withdraw_ask requires answers_ask: true')
    if (args.answers_ask === true) return needsServer('Answering a task\'s ask of the user in their place (answers_ask)')
    if (args.in_reply_to !== undefined) {
      const ids = Array.isArray(args.in_reply_to) ? [...new Set(args.in_reply_to)] : [args.in_reply_to]
      if (!ids.length || ids.length > 20 || ids.some((id) => typeof id !== 'string' || !/^rq-[a-f0-9]{6,}$/.test(id))) {
        return fail('bad_request', 'in_reply_to must be an rq-… id, or a list of up to 20 of them')
      }
      return ids.length === 1 ? opReply(home, callerSid, { ...args, in_reply_to: ids[0] }, text) : opReplies(home, callerSid, args, text, ids as string[])
    }
    if (typeof args.to !== 'string' || !args.to.trim()) return fail('bad_request', '`to` is required (or pass in_reply_to)')
    // Before the session lookup: a completed parent usually has nothing running.
    // wake=false is a note that asks nothing: it cannot also ask (send-rules.ts).
    const conflict = rules.wakeFalseConflict(rules.ruleInputOf(args))
    if (conflict) return fail(conflict.code, conflict.message)
    const named = resolveTask(home, args.to).task?.id
    const closed = parentCompleteRefusal(home, callerSid, named)
    if (closed) return closed
    const early = admitRetiredLead(home, callerSid, named, args, text)
    if ('error' in early) return early.error
    const target = resolveSendTarget(home, args.to)
    if (target.error) return target.error
    const closedTarget = parentCompleteRefusal(home, callerSid, target.taskId)
    if (closedTarget) return closedTarget
    const lead = admitRetiredLead(home, callerSid, target.taskId, args, text)
    if ('error' in lead) return lead.error
    const targetSid = target.sid!
    if (targetSid === callerSid) return fail('self_send', 'target resolves to the calling session itself')
    const admitted = admitCompleteTarget(home, target.taskId, args, lead.text, 'send')
    if ('error' in admitted) return admitted.error
    const denied = admitWrite(callerSid) ?? roomFor(home)
    if (denied) return denied
    const slice = slices.get(home)!
    const me = callerIdentity(home, callerSid)
    // The server's rule: a session asking another session wants the answer, except a note up to its
    // own leader (a report) and a note that asks nothing (wake false: delivered now, it cannot wait here).
    const row = opensRequest(home, args, me.taskId, target.taskId)
      ? requestRow({ id: `rq-${deps.randomHex(6)}`, fromSessionId: callerSid, toSessionId: targetSid, toTaskId: target.taskId, preview: kit.requestPreview(text), secs: replySecs(home, args.reply_timeout, args.expect_reply === undefined, target.taskId), online: false })
      : undefined
    const envelope = kit.buildPeerWrapper(escapeSenderWords(admitted.text), {
      title: me.title, shortId: callerSid.slice(0, 8), sessionId: callerSid, taskId: me.taskId,
      host: slice.host, ...(row ? { requestId: row.id } : {}),
    }, { title: typeof args.title === 'string' ? args.title : undefined })
    const mid = messageId(args.messageId)
    const delivered = await deliverPeer(home, { fromSessionId: callerSid, toSessionId: targetSid, toTaskId: target.taskId, envelope, messageId: mid, row, online: false })
    if (!delivered.ok) return fail('internal', `delivery failed: ${delivered.reason}`)
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
      // A task whose current session runs on an ACP engine is the server's to deliver to.
      if (slice.sessions.some((s) => s.acp && s.sid === task.session_id)) return null
      const live = slice.sessions.filter((s) => s.taskId === task.id && liveHere(home, s.sid))
      // The server picks the task's current session; with two live, leave it the choice.
      if (live.length !== 1 || live[0].aside) return null
      return { sid: live[0].sid, taskId: task.id, title: live[0].title ?? task.title }
    }
    const printed = /\[([0-9a-f][0-9a-f-]{7,})\]\s*$/i.exec(ref)?.[1]
    const key = (printed ?? ref).toLowerCase()
    if (key.length < 8 || !/^[0-9a-f-]+$/.test(key)) return null
    const hits = matchIdRef(slice.sessions, key, (s) => s.sid.toLowerCase())
    if (hits.length !== 1 || hits[0].aside || !liveHere(home, hits[0].sid)) return null
    // An older session of a task that runs another one here too: the server
    // knows which one the task continues in.
    const taskId = hits[0].taskId
    if (taskId && slice.sessions.filter((s) => s.taskId === taskId && liveHere(home, s.sid)).length !== 1) return null
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
    const row = opensRequest(home, args, me.taskId, target.taskId)
      ? requestRow({ id: `rq-${deps.randomHex(6)}`, fromSessionId: callerSid, toSessionId: target.sid, toTaskId: target.taskId, preview: kit.requestPreview(text), secs: replySecs(home, args.reply_timeout, args.expect_reply === undefined, target.taskId), online: true })
      : undefined
    const envelope = kit.buildPeerWrapper(escapeSenderWords(text), {
      title: me.title, shortId: callerSid.slice(0, 8), sessionId: callerSid, taskId: me.taskId,
      host: slice.host, ...(row ? { requestId: row.id } : {}),
    }, { title: typeof args.title === 'string' ? args.title : undefined })
    // Nothing written: the server may still reach it (it resumes a stopped CLI).
    const delivered = await deliverPeer(home, { fromSessionId: callerSid, toSessionId: target.sid, toTaskId: target.taskId, envelope, messageId: mid, row, online: true })
    if (!delivered.ok) return null
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
    // Its answer may go to the asker of the request it carries (sessions/reply-handoff.ts): the server's to route.
    if (copy?.carries) return null
    const asker = row.fromSessionId
    // The server's first rung (reply-routing.ts): a live asker is its own address.
    if (asker === callerSid || !liveHere(home, asker) || deps.pendingPrompt!(asker)) return null
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
    const delivered = await deliverReply(home, { fromSessionId: callerSid, toSessionId: asker, requestId: id, text: wrapped, messageId: mid, replierTaskId: me.taskId, online: true })
    if (!delivered.ok) return null
    deps.log('info', 'host: reply delivered on this host', { home, requestId: id, from: callerSid, to: asker, messageId: mid })
    return sentResult(home, { sid: asker, taskId: askerRow?.taskId, title: askerRow?.title }, { repliedTo: id, messageId: mid })
  }

  /**
   * A call the server would answer, that this host answers itself: a message
   * between two of this Walnut's sessions running here. Null = not this host's
   * to take; the caller relays the payload, which then carries the message id
   * this host picked, so a delivery the server makes again is written once.
   */
  async function handleLocal(home: string, rawCallerSid: string, capability: string, payload: Record<string, unknown>): Promise<GatewayResult | null> {
    const call = localCall(home, rawCallerSid, capability, payload)
    if (!call) return null
    try {
      return call.args.in_reply_to !== undefined
        ? await localReply(home, call.callerSid, call.args, call.text, call.mid)
        : await localSend(home, call.callerSid, call.args, call.text, call.mid)
    } catch (err) {
      deps.log('warn', 'host: same-host delivery failed, leaving it to the server', { home, error: (err as Error).message })
      return null
    }
  }

  /**
   * The plain same-host send handleLocal may take, judged on its arguments (the shape the server
   * alone answers is left out), with the message id it goes as set on the payload; null: the
   * server's. The gateway asks it first for a host's own Walnut server too, which then decides the
   * rest (replica/away-sends.ts): the payload carries the same message id either way.
   */
  function localCall(home: string, rawCallerSid: string, capability: string, payload: Record<string, unknown>): { callerSid: string; args: Record<string, unknown>; text: string; mid: string } | null {
    if (!deps.pendingPrompt || capability !== 'tools.call') return null
    const callerSid = callerSidOf(home, rawCallerSid)
    const name = typeof payload.name === 'string' ? payload.name : ''
    if (LOCAL_SEND_OPS.indexOf(name) === -1 || typeof payload.argsFile === 'string') return null
    if (!slices.has(home) || !sessionOf(home, callerSid)) return null
    const args = (payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args) ? payload.args : {}) as Record<string, unknown>
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (!text) return null
    // A hand-off links requests in the server's ledger: the server delivers it.
    if (args.hands_on !== undefined) return null
    // A note that asks nothing waits on the server for its target's next message (quiet-notes.ts),
    // and one that also asks is the server's to refuse (send-rules.ts).
    const input = rules.ruleInputOf(args)
    if (rules.holdsQuietly(input) || rules.wakeFalseConflict(input)) return null
    // An answer for the user (answers_ask) is recorded on the asking task, and delivered only to one
    // that runs (session-send-core.ts, ask-answer.ts answerReach): the server's alone to decide.
    if (args.answers_ask !== undefined) return null
    if (args.withdraw_ask !== undefined) return null
    // So does a structured reply (result / evidence / not_done): the server keeps its fields
    // on the request and the replier's task, where the Board reads Partial.
    if (args.result !== undefined || args.evidence !== undefined || args.not_done !== undefined || args.score !== undefined) return null
    if (typeof args.messageId !== 'string' || !/^qm-[A-Za-z0-9-]{1,64}$/.test(args.messageId)) {
      // From the caller's call id when it sent one (src/lib/op-call-id.ts): a retry of the same
      // call then carries the same message id, here and at the server, and is written once.
      const callId = typeof payload.callId === 'string' && /^oc-[A-Za-z0-9_-]{8,48}$/.test(payload.callId) ? payload.callId : ''
      const stable = callId ? callId.slice(3).split('_').join('-') : ''
      payload.args = { ...args, messageId: stable ? `qm-host-${stable}` : `qm-host-${deps.randomHex(8)}` }
    }
    return { callerSid, args, text, mid: String((payload.args as Record<string, unknown>).messageId) }
  }

  // ── a peer message the host's own Walnut server decided (`follower.peer`, follower-peer-v1) ──
  // The follower (replica/away-sends.ts) resolved the target from its copies, ran the server's
  // refusals and the reply rule, and wrote the words and their envelope. This host does what only
  // it can, with the same tails as its own answers: the row's turn and stream facts, the reply
  // line, the write into the live CLI, the journal. `online`: the server answers (handleLocal's
  // case): whatever this host cannot be sure of (a prompt pending, a copy it answered once, a
  // failed write) is left to the server, `needs_leader {why: 'server_delivers'}`.

  const peerInFlight = new Map<string, Promise<GatewayResult>>()

  // ── a same-host send handed over while the server answers, written once ──
  // The gateway hands it to this host's Walnut server (openOnline) and relays it to the server when
  // that one leaves it or does not answer in time (endOnline); both carry the one qm- message id the
  // gateway set, and only one side writes it: a `follower.peer` claims the id before its write and is
  // refused once the hand-off ended, and a hand-off that ends while the claim writes waits for that
  // write and answers from it, never relaying it. Kept 10 minutes, so a late `follower.peer` finds it ended.
  type OnlineClaim = { state: 'open' | 'writing' | 'written' | 'relayed'; at: number; wrote?: Promise<void>; answer?: GatewayResult }
  const onlineClaims = new Map<string, OnlineClaim>()
  const ONLINE_CLAIM_MS = 10 * 60_000
  const ONLINE_CLAIMS_MAX = 5_000

  function onlineKeyOf(home: string, payload: Record<string, unknown>): string | null {
    const args = payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args) ? payload.args as Record<string, unknown> : null
    const mid = args && typeof args.messageId === 'string' ? args.messageId : ''
    return /^qm-[A-Za-z0-9-]{1,64}$/.test(mid) ? `${home}\n${mid}` : null
  }

  /** Before a same-host send goes to this host's Walnut server: false when it went to the server once already (relay it again). */
  function openOnline(home: string, payload: Record<string, unknown>): boolean {
    const key = onlineKeyOf(home, payload)
    if (!key) return false
    const now = deps.now()
    for (const [k, c] of onlineClaims) if (c.state !== 'writing' && now - c.at > ONLINE_CLAIM_MS) onlineClaims.delete(k)
    while (onlineClaims.size >= ONLINE_CLAIMS_MAX) onlineClaims.delete(onlineClaims.keys().next().value as string)
    const c = onlineClaims.get(key)
    if (c?.state === 'relayed') return false
    if (!c) onlineClaims.set(key, { state: 'open', at: now })
    return true
  }

  /**
   * The hand-off ended with no delivery answer (left to the server, no answer in time, the socket
   * gone): null = the gateway relays it (nothing was written here, and nothing will be now); else
   * the answer of the write a `follower.peer` made of it.
   */
  async function endOnline(home: string, payload: Record<string, unknown>): Promise<GatewayResult | null> {
    const key = onlineKeyOf(home, payload)
    if (!key) return null
    let c = onlineClaims.get(key)
    if (c?.state === 'writing' && c.wrote) { await c.wrote; c = onlineClaims.get(key) }
    if (c?.state === 'written' && c.answer) return c.answer
    onlineClaims.set(key, { state: 'relayed', at: deps.now() })
    return null
  }

  /** A follower.peer's claim of an open hand-off's message (null: none open, it ended), released after its write. */
  function claimOnline(home: string, mid: string): { written(answer: GatewayResult): void; release(): void } | null {
    const c = onlineClaims.get(`${home}\n${mid}`)
    if (!c || c.state !== 'open') return null
    let done: () => void = () => {}
    c.state = 'writing'
    c.at = deps.now()
    c.wrote = new Promise<void>((r) => { done = r })
    return {
      written(answer) { c.state = 'written'; c.answer = answer },
      release() { if (c.state === 'writing') c.state = 'open'; c.wrote = undefined; done() },
    }
  }

  /** What a saved peer message answers its retry (its delivery record, keyed by the follower's op id). */
  function peerAnswerOf(first: Record<string, unknown>): Record<string, unknown> {
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
    const requestId = str(first.requestId)
    return {
      delivered: true, targetSessionId: str(first.toSessionId) ?? null, messageId: str(first.messageId) ?? null,
      ...(str(first.toTaskId) ? { targetTaskId: first.toTaskId } : {}),
      ...(requestId ? (first.reply === true ? { repliedTo: requestId } : { requestId }) : {}),
      seq: first.seq, opId: first.opId,
    }
  }

  async function handleFollowerPeer(home: string, req: Record<string, unknown>): Promise<GatewayResult> {
    try {
      const base = typeof req.opId === 'string' && OP_ID_RE.test(req.opId) ? req.opId : ''
      if (!base) return fail('bad_request', 'follower.peer needs the op id of the call')
      // One call answering several askers writes one message per asker: each its own key.
      const part = typeof req.part === 'number' && Number.isInteger(req.part) && req.part > 0 && req.part < 100 ? req.part : 0
      const opId = part ? `${base.slice(0, 72)}-p${part}` : base
      const key = `${home}\n${opId}`
      // A retry while the first still writes (its answer late) waits for that one: written once.
      const running = peerInFlight.get(key)
      if (running) {
        const first = await running
        return first.ok ? ok({ ...first.result, duplicate: true }) : first
      }
      const saved = journal.byOpId(home, opId)
      if (saved) {
        deps.log('info', 'offline host: a follower\'s peer message asked again, written once', { home, opId, seq: saved.seq })
        // A held message (its `op` record) answers as it did the first time: queued, its id, "Do NOT resend".
        if (saved.kind === 'op') return ok(heldAnswerOf(home, String(saved.op), saved, true))
        return ok({ ...peerAnswerOf(saved as unknown as Record<string, unknown>), duplicate: true })
      }
      const run = followerPeer(home, req, opId).catch((err: Error) => fail('internal', `offline host error: ${err.message}`))
      peerInFlight.set(key, run)
      try { return await run } finally { if (peerInFlight.get(key) === run) peerInFlight.delete(key) }
    } catch (err) {
      deps.log('error', 'offline host: a follower\'s peer message failed', { home, error: (err as Error).message })
      return fail('internal', `offline host error: ${(err as Error).message}`)
    }
  }

  async function followerPeer(home: string, req: Record<string, unknown>, opId: string): Promise<GatewayResult> {
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    const online = req.online === true
    const from = str(req.fromSessionId)
    if (req.kind === 'hold') {
      // Its target runs nowhere here: held for the server as this host's own answer holds it (holdWrite).
      if (online) return fail('bad_request', 'follower.peer: a message is held only while the server is away')
      const args = req.args && typeof req.args === 'object' && !Array.isArray(req.args) ? req.args as Record<string, unknown> : null
      if (!args) return fail('bad_request', 'follower.peer: a held message needs its arguments')
      const held = holdWrite(home, from, 'tools.call', { name: 'task_send', args, ...(typeof req.callId === 'string' ? { callId: req.callId } : {}) }, opId)
      return held ?? fail('needs_leader', 'this host cannot hold that message for the server', { detail: { why: 'not_held' } })
    }
    const to = str(req.toSessionId)
    const text = str(req.text)
    const mid = /^qm-[A-Za-z0-9-]{1,64}$/.test(str(req.messageId)) ? str(req.messageId) : ''
    if (!from || !to || !text.trim() || !mid) return fail('bad_request', 'follower.peer needs fromSessionId, toSessionId, text and a qm-… messageId')
    const leave = (why: string) => fail('needs_leader', `${why}; the Walnut server delivers it`, { detail: { why: 'server_delivers' } })
    if (!slices.has(home)) return fail('needs_leader', 'this host holds no copy for that Walnut', { detail: { why: 'no_copy' } })
    if (!sessionOf(home, from)) return fail('bad_request', 'the sender is not a session of that Walnut on this host')
    if (!sessionOf(home, to) || !liveHere(home, to)) return fail('needs_leader', 'that session of this Walnut is not running on this host', { detail: { why: 'not_running_here' } })
    if (online && deps.pendingPrompt?.(to)) return leave('the session waits on a permission prompt')
    if (req.kind !== 'send' && req.kind !== 'reply') return fail('bad_request', 'follower.peer: kind is send or reply')
    // A message handed over while the server answered is written by one side only: whichever way
    // the follower now sends it (online, or away once the server left mid hand-off), it writes only
    // under the open hand-off's claim. With no hand-off of this id, an away write needs none.
    const handedOver = onlineClaims.has(`${home}\n${mid}`)
    const claim = online || handedOver ? claimOnline(home, mid) : null
    if ((online || handedOver) && !claim) return leave('the hand-off of this message ended')
    try { return await followerWrite(home, req, opId, { online, from, to, text, mid, leave, claim }) } finally { claim?.release() }
  }

  async function followerWrite(
    home: string, req: Record<string, unknown>, opId: string,
    p: { online: boolean; from: string; to: string; text: string; mid: string; leave(why: string): GatewayResult; claim: { written(answer: GatewayResult): void } | null },
  ): Promise<GatewayResult> {
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    const { online, from, to, text, mid, leave } = p
    if (req.kind === 'send') {
      const ask = req.ask && typeof req.ask === 'object' && !Array.isArray(req.ask) ? req.ask as Record<string, unknown> : null
      const rqId = ask ? str(ask.id) : ''
      if (ask && (!/^rq-[a-f0-9]{6,}$/.test(rqId) || journalOf(home).rows[rqId])) return fail('bad_request', 'follower.peer: the request needs a new rq-… id')
      // The brakes the same message meets on this host's own path: the server's peer throttle while
      // it answers (handleLocal), the away write budget otherwise (opTaskSend); a full journal either way.
      const denied = (online ? admitPeerSend(from, to, str(req.dupText) || text) : admitWrite(from)) ?? roomFor(home)
      if (denied) return denied
      const toTaskId = str(req.toTaskId) || undefined
      const secs = rules.clampReplyTimeoutSecs(typeof ask?.secs === 'number' ? ask.secs : undefined)
      const row = ask ? requestRow({ id: rqId, fromSessionId: from, toSessionId: to, toTaskId, preview: str(ask.preview), secs, online }) : undefined
      const delivered = await deliverPeer(home, { fromSessionId: from, toSessionId: to, toTaskId, envelope: text, messageId: mid, row, online, opId })
      if (!delivered.ok) return online ? leave(`this host could not write it (${delivered.reason})`) : fail('internal', `delivery failed: ${delivered.reason}`)
      deps.log('info', 'offline host: a follower\'s message delivered', { home, from, to, requestId: row?.id, messageId: mid, online })
      p.claim?.written(sentResult(home, { sid: to, taskId: toTaskId, title: sessionOf(home, to)?.title }, { requestId: row?.id, messageId: mid }))
      return ok({ delivered: true, targetSessionId: to, ...(toTaskId ? { targetTaskId: toTaskId } : {}), messageId: mid, ...(row ? { requestId: row.id } : {}) })
    }
    if (req.kind === 'reply') {
      const requestId = str(req.requestId)
      if (!/^rq-[a-f0-9]{6,}$/.test(requestId)) return fail('bad_request', 'follower.peer: a reply needs its rq-… id')
      // A copy this host already answered once: a second answer is the server's (it says "late").
      if (online && !journalOf(home).rows[requestId] && journalOf(home).settledCopies.includes(requestId)) return leave('this host answered that request once already')
      const denied = (online ? null : admitWrite(from)) ?? roomFor(home)
      if (denied) return denied
      const delivered = await deliverReply(home, {
        fromSessionId: from, toSessionId: to, requestId, text, messageId: mid,
        replierTaskId: str(req.replierTaskId) || undefined, score: req.score, online, opId,
      })
      if (!delivered.ok) return online ? leave(`this host could not write it (${delivered.reason})`) : fail('internal', `delivery to the asking session failed: ${delivered.reason}`)
      // The asker's other requests this one answer settles (in_reply_to as a list): it reads it once.
      const also = Array.isArray(req.alsoSettle) ? req.alsoSettle.filter((x): x is string => typeof x === 'string' && /^rq-[a-f0-9]{6,}$/.test(x)) : []
      for (const id of also) settleHere(home, id, journalOf(home).rows[id], str(req.replierTaskId) || undefined, req.score, online)
      deps.log('info', 'offline host: a follower\'s reply delivered', { home, requestId, from, to, messageId: mid, online })
      const asker = sessionOf(home, to)
      p.claim?.written(sentResult(home, { sid: to, taskId: asker?.taskId, title: asker?.title }, { repliedTo: requestId, messageId: mid }))
      return ok({ delivered: true, targetSessionId: to, messageId: mid, repliedTo: requestId, ...(also.length ? { alsoSettled: also } : {}) })
    }
    return fail('bad_request', 'follower.peer: kind is send or reply')
  }

  function opQueued(home: string, callerSid: string, name: string, rawArgs: Record<string, unknown>): GatewayResult {
    const ref = typeof rawArgs.id === 'string' ? rawArgs.id : ''
    if (!ref) return fail('bad_request', `${name} needs "id"`)
    // A clock named as a duration ("6h") counts from now, not from when the server replays it:
    // journal v2 stores the value as written (apply-fields.ts). A v1 record is replayed through
    // task_update, which reads a duration from the replay and refuses a time already past.
    let args = rawArgs
    if (name === 'task_update' && rawArgs.wait_until !== undefined && rawArgs.wait_until !== null && drainsKind(home, 'task-fields')) {
      try { args = { ...rawArgs, wait_until: waitClock(rawArgs.wait_until) } } catch (err) { return fail('bad_request', (err as Error).message) }
    }
    // A review's score on a close is checked as the server checks it, before anything is queued.
    const closeScore = name === 'task_complete' ? offlineScoreOf(args.score) : undefined
    if (closeScore === null) return fail('bad_request', 'score must be {"function": n, "ux": n, "ui": n} (any of them, each 0..10) or "n/n/n"')
    const said = name === 'task_complete' ? CLOSE_NEEDS_SERVER.filter((k) => saysSomething(args[k])) : []
    if (said.length) {
      return fail('needs_leader', `A close with its ${said.join(', ')} can only be made while the Walnut server answers; the task was not completed`, { detail: { why: 'fields', fields: said } })
    }
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
      // The close's score rides the record (no task field: the server keeps it as review_score).
      if (closeScore) built.record.score = { ...closeScore, at: new Date(deps.now()).toISOString(), taskId: task.id }
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

  /** The longest MEMORY.md (sessions/agent-memory.ts AGENT_MEMORY_MAX_CHARS): an entry past it can never land. */
  const AGENT_MEMORY_MAX = 20_000
  /** A task id as Walnut mints them (a task this host's copy does not hold is checked by the Mac at replay). */
  const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/

  /**
   * The op id the Mac's own route gets for this call's MEMORY.md write (src/lib/op-call-id.ts
   * writeOpId of `PUT /tasks/<task as named>/agent-memory`, the call's first write there), so the
   * Mac's applied-ops ledger sees one write whichever lands first: this record drained, or the
   * same call retried straight at the Mac. Inlined (the factory references nothing at module
   * scope); tests/providers/offline-agent-memory.test.ts holds it equal to writeOpId.
   */
  function memoryWriteOpId(callId: string, taskRef: string): string {
    const route = 'PUT /tasks/' + encodeURIComponent(taskRef) + '/agent-memory'
    let h = 0x811c9dc5
    for (let i = 0; i < route.length; i++) { h ^= route.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
    return callId + '-' + h.toString(16).padStart(8, '0') + '-0'
  }

  /**
   * agent_memory_write while away: an append only, as an `agent-memory` record that carries the
   * entry (offline-merge/apply-agent-memory.ts). The Mac adds it to the file as it stands at
   * replay, so whatever was written there meanwhile is kept. A replace needs the file this host
   * does not hold to be safe, so it is refused here, nothing saved; so is a memory folder file.
   * Each append is its own record.
   */
  function opAgentMemoryWrite(home: string, callerSid: string, args: Record<string, unknown>, callId?: unknown): GatewayResult {
    if (args.file !== undefined) return needsServer('A memory folder file (agent_memory_write file)', home)
    const mode = args.mode === undefined ? 'append' : args.mode
    if (mode !== 'append' && mode !== 'replace') return fail('bad_request', 'mode must be append or replace')
    if (mode === 'replace') {
      return fail('needs_leader', 'A replace of MEMORY.md can only be made while the Walnut server answers (this host does not hold the file it would replace); nothing was saved. An append is saved here.', { detail: { why: 'agent-memory-replace' } })
    }
    const bad = memoryContentError(args.content)
    if (bad) return bad
    const named = typeof args.task === 'string' && args.task.trim() ? args.task.trim() : ''
    const ref = named || (sessionOf(home, callerSid)?.taskId ?? '')
    if (!ref) return fail('bad_request', 'task is required (this session has no task here)')
    const { task, error } = resolveTask(home, ref)
    if (error) return error
    const taskId = task ? task.id : TASK_ID_RE.test(ref) ? ref : ''
    if (!taskId) return needsServer(`Task ${ref} is not in this host's offline copy; writing its MEMORY.md`, home)
    if (task && task.phase === 'COMPLETE') return fail('task_complete', `"${task.title}" is complete: its MEMORY.md is kept as it was.`)
    // Under the op id the Mac's route gives the same call (memoryWriteOpId): a retry of it is this
    // record here, and one entry at the Mac whether the record drains first or the retry reaches
    // the Mac first. Two calls with the same words are two entries.
    const opId = typeof callId === 'string' && /^oc-[A-Za-z0-9_-]{8,48}$/.test(callId) ? memoryWriteOpId(callId, ref) : undefined
    return appendAgentMemory(home, { kind: 'session', sid: callerSid }, callerSid, taskId, args.content, opId)
  }

  function memoryContentError(content: unknown): GatewayResult | null {
    if (typeof content !== 'string' || !content.trim()) return fail('bad_request', 'content must be a non-empty string')
    if (content.length > AGENT_MEMORY_MAX) return fail('agent_memory_too_long', `the entry is ${content.length} characters, over the ${AGENT_MEMORY_MAX}-character limit of MEMORY.md; nothing was saved`)
    return null
  }

  /**
   * The `agent-memory` append record, the one way in for a session's call answered here
   * (opAgentMemoryWrite) and the follower's (followerCall): the task already decided.
   */
  function appendAgentMemory(home: string, actor: import('./offline-journal-core.js').JournalActor, budgetKey: string, taskId: string, content: unknown, opId?: string): GatewayResult {
    const bad = memoryContentError(content)
    if (bad) return bad
    const record: OfflineRecordV2 & Record<string, unknown> = { kind: 'agent-memory', taskId, mode: 'append', content: content as string }
    const saved = append(home, record, false, { actor, ...(opId ? { opId } : {}), coalesce: false, admit: () => admitWrite(budgetKey) ?? roomFor(home) })
    const no = refusal(saved)
    if (no) return no
    deps.log('info', 'offline host: write queued', { home, op: 'agent_memory_write', taskId, actor: budgetKey, kind: 'agent-memory', seq: saved.ok ? saved.seq : undefined })
    return memoryAnswer(taskId, saved.ok && saved.duplicate === true, saved.ok ? saved.seq : undefined)
  }

  function memoryAnswer(taskId: string, duplicate: boolean, seq?: number): GatewayResult {
    return ok({
      queued: true, offline: true, task_id: taskId, mode: 'append', ...(duplicate ? { duplicate: true } : {}), ...(seq !== undefined ? { seq } : {}),
      outcome: 'Saved on this host; Walnut adds this entry to the task\'s MEMORY.md, after what it holds then, when the server reconnects.',
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

  /** The write budget of a journal actor: one per session, device, trigger or plugin job. */
  function budgetOfActor(actor: import('./offline-journal-core.js').JournalActor): string {
    if (actor.kind === 'device') return `device:${actor.deviceId}`
    if (actor.kind === 'session') return actor.sid
    if (actor.kind === 'plugin-job') return `plugin-job:${actor.plugin}/${actor.job}`
    return `trigger:${actor.id}`
  }

  const FOLLOWER_OP_KINDS: Record<string, string> = { task_update: 'task-fields', task_complete: 'task-fields', task_create: 'task-create', task_move: 'task-move', device_revoke: 'device-revoke' }
  const OP_ID_RE = /^[A-Za-z0-9_-]{1,80}$/

  /**
   * Who a follower's write or start acts for. A plugin job (a host replica's own gateway
   * call) only for a Mac that drains it (`plugin-job-actor`); else `older`: an older Mac.
   */
  function actorOf(given: unknown, home: string): import('./offline-journal-core.js').JournalActor | 'older' | null {
    const a = given as { kind?: unknown; deviceId?: unknown; name?: unknown; sid?: unknown; plugin?: unknown; job?: unknown } | null
    if (!a || typeof a !== 'object') return null
    if (a.kind === 'plugin-job' && typeof a.plugin === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(a.plugin) && typeof a.job === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(a.job)) {
      return drainsKind(home, 'plugin-job-actor') ? { kind: 'plugin-job', plugin: a.plugin, job: a.job } : 'older'
    }
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
      const actor = actorOf(req.actor, home)
      if (actor === 'older') return fail('needs_leader', 'your Mac runs an older Walnut that cannot take a plugin job\'s change later; it needs your Mac', { detail: { why: 'mac_too_old' } })
      if (!actor) return fail('bad_request', 'follower.op needs an actor (the paired device, a session or a plugin job)')
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
          // A call the follower answers (followerCall) is answered again as its first attempt was.
          const again = followerCallAgain(home, first as unknown as Record<string, unknown>)
          if (again) return again
          return ok({ queued: true, offline: true, kind: first.kind, seq: first.seq, opId: String(first.opId), rev: first.rev ?? 1, duplicate: true, ...(typeof firstTask === 'string' ? { taskId: firstTask } : {}), ...noteBits })
        }
      }
      const opId = typeof req.opId === 'string' ? req.opId : `op-${deps.randomHex(8)}`
      // WP11: a note save (cap note-journal-v1); its own checks and lock.
      if (name === 'note_put' || name === 'note_delete') return followerNote(home, name, args, actor, opId)
      // Task B: a session's or plugin job's call the follower decided (follower-calls).
      const call = followerCall(home, name, args, actor, opId, req.base && typeof req.base === 'object' && !Array.isArray(req.base) ? req.base as Record<string, unknown> : null)
      if (call) return call
      const kind = FOLLOWER_OP_KINDS[name] ?? (deps.boards && deps.boards.WRITE_OPS.indexOf(name) !== -1 ? 'board' : '')
      if (!kind) return fail('needs_leader', `${name || 'that write'} needs your Mac`, { detail: { why: 'not_queueable' } })
      if (!drainsKind(home, kind) || (actor.kind === 'device' && !drainsKind(home, 'device-actor'))) {
        return fail('needs_leader', 'your Mac runs an older Walnut that cannot take this change later; it needs your Mac', { detail: { why: 'mac_too_old' } })
      }
      let size = 0
      try { size = JSON.stringify(args).length } catch { return fail('bad_request', 'arguments are not JSON') }
      if (size > MAX_ARGS_BYTES) return fail('bad_request', `arguments are too large to queue (${size} bytes, limit ${MAX_ARGS_BYTES})`)
      const budgetKey = budgetOfActor(actor)
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
        // inherited_project (follower-create-inherited-v1): the project a session's create took from its
        // caller, for this host's readers only; every drain ignores it (replica/away-create-placement.ts).
        const placementKeys = ['parent_task_id', 'project', 'inherited_project', 'group_id', 'focus_tier', 'order', 'id']
        const fields: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(args)) if (placementKeys.indexOf(k) === -1) fields[k] = v
        const bad = Object.keys(fields).filter((k) => QUEUEABLE.indexOf(k) === -1)
        if (bad.length) return fail('needs_leader', `${bad.join(', ')} can only be set while the Walnut server answers`, { detail: { why: 'fields', fields: bad } })
        const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
        const placement = {
          ...(str(args.parent_task_id) ? { parentTaskId: str(args.parent_task_id) } : {}), ...(typeof args.project === 'string' ? { project: args.project } : {}),
          ...(typeof args.project !== 'string' && typeof args.inherited_project === 'string' ? { inheritedProject: args.inherited_project } : {}),
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

  // ── follower-calls: a session's or plugin job's call its follower decided (task B) ──
  // The follower resolved the task, the target and the rules with its copies (replica/away-calls.ts,
  // away-triggers.ts); here only the mechanics, through the very record builders this host's own
  // answers use, so the Mac drains the same records. Plain follower.op kinds: an older daemon
  // answers them `not_queueable`, and its follower hands the call back as before.

  function followerCall(
    home: string, name: string, args: Record<string, unknown>, actor: import('./offline-journal-core.js').JournalActor, opId: string, given: Record<string, unknown> | null,
  ): GatewayResult | null {
    const budgetKey = budgetOfActor(actor)
    const sid = actor.kind === 'session' ? actor.sid : ''
    const tooOld = () => fail('needs_leader', 'your Mac runs an older Walnut that cannot take this change later; it needs your Mac', { detail: { why: 'mac_too_old' } })
    const needsMac = (what: string) => fail('needs_leader', `${what} needs your Mac`, { detail: { why: 'routine_writes_need_mac' } })
    switch (name) {
      case 'agent_memory_write': {
        const task = typeof args.task === 'string' ? args.task.trim() : ''
        if (!task) return fail('bad_request', 'agent_memory_write needs "task"')
        // MEMORY.md as its own kind when the Mac drains it; a memory folder note, a task the follower
        // could not name (`held`), or an older Mac: the held op the Mac replays under the call's own
        // id (holdWrite's record), as this host's own answer holds it.
        if (args.file === undefined && args.held !== true && drainsKind(home, 'agent-memory')) return appendAgentMemory(home, actor, budgetKey, task, args.content, opId)
        if (!sid || !drainsKind(home, 'held-op')) return tooOld()
        const held: Record<string, unknown> = { content: args.content, task, ...(typeof args.file === 'string' ? { file: args.file } : {}) }
        return appendHeld(home, sid, 'agent_memory_write', held, args.callId, opId)
      }
      case 'human_inbox_send':
        if (!deps.letters || !drainsKind(home, 'letter')) return tooOld()
        return appendLetter(home, actor, budgetKey, args, opId)
      case 'trigger_create': {
        if (!createsTriggers(home)) return tooOld()
        if (!sid) return needsMac('A trigger a plugin job makes')
        const p = triggerPlanOf(args)
        if (!p) return fail('bad_request', 'trigger_create: the follower sent an incomplete trigger')
        const armed = armTrigger(home, sid, p, opId)
        if ('error' in armed) return armed.error
        const w = args.park as { wait_until?: unknown } | undefined
        const waitUntil = w && typeof w.wait_until === 'string' ? w.wait_until : undefined
        const park = w && typeof w === 'object' ? followerPark(home, actor, budgetKey, p.taskId, waitUntil, opId, given) : null
        return triggerArmedAnswer(home, armed.id, p, parkWords(p, park, waitUntil))
      }
      case 'trigger_pause': case 'trigger_resume': case 'trigger_delete':
        if (!deps.triggers || !sid) return needsMac(`${name} here`)
        return opTriggerWrite(home, sid, name, args, needsMac, opId)
      case 'trigger_update':
        if (!deps.triggers || !sid) return needsMac(`${name} here`)
        if (!drainsKind(home, 'trigger-update')) return tooOld()
        return followerTriggerUpdate(home, sid, args, opId)
    }
    return null
  }

  /**
   * A trigger_update the follower decided (replica/away-trigger-update.ts): `args` the fields it
   * changed (what the Mac replays through the op), `def` the trigger as it runs now, `on` whether it
   * ran when changed. Checked by this daemon, journaled, and armed at once (applyTriggerHolds).
   */
  function followerTriggerUpdate(home: string, sid: string, a: Record<string, unknown>, opId: string): GatewayResult {
    const id = typeof a.id === 'string' ? a.id : ''
    const replay = a.args && typeof a.args === 'object' && !Array.isArray(a.args) ? a.args as Record<string, unknown> : null
    const given = a.def && typeof a.def === 'object' && !Array.isArray(a.def) ? a.def as OfflineTrigger : null
    if (!id || !replay || replay.id !== id || Object.keys(replay).length < 2 || !given || given.id !== id || typeof a.on !== 'boolean') {
      return fail('bad_request', 'trigger_update: the follower sent an incomplete change')
    }
    if (triggerOf(home, id)?.hold?.deleted) return fail('not_found', `Trigger ${id} was deleted on this host; nothing to change`)
    // Its fires are delivered into this Walnut's sessions, whichever data dir the follower named.
    const def: OfflineTrigger = { ...given, ...(given.deliver ? { deliver: { ...given.deliver, home } } : {}) }
    const checked = deps.triggers!.validate ? deps.triggers!.validate(def) : { ok: false as const, error: 'this daemon cannot check a trigger' }
    if (!checked.ok) return fail('bad_request', checked.error)
    const saved = refusal(append(home, { kind: 'op', op: 'trigger_update', args: replay, callerSid: sid, trigger: def, armed: a.on }, false, { opId, admit: () => admitWrite(sid) ?? roomFor(home) }))
    if (saved) return saved
    try { deps.triggers!.changed() } catch (err) { deps.log('warn', 'offline host: triggers did not follow a change here', { id, error: (err as Error).message }) }
    deps.log('info', 'offline host: trigger changed here', { home, id, fields: Object.keys(replay).filter((k) => k !== 'id'), callerSid: sid })
    return triggerChangedAnswer('trigger_update', def, false, a.on)
  }

  /** A trigger the follower decided, as armTrigger takes it (null: not whole). */
  function triggerPlanOf(a: Record<string, unknown>): TriggerPlan | null {
    const str = (v: unknown) => (typeof v === 'string' ? v : null)
    const run = str(a.run); const prompt = str(a.prompt); const description = str(a.description); const name = str(a.name); const taskId = str(a.taskId)
    const everyMs = a.everyMs; const timeoutSeconds = a.timeoutSeconds
    if (!run || !prompt || !description || !name || !taskId || typeof everyMs !== 'number' || !(everyMs >= 10_000)) return null
    if (typeof timeoutSeconds !== 'number' || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) return null
    if (a.max !== undefined && (typeof a.max !== 'number' || !Number.isInteger(a.max) || a.max < 0)) return null
    return {
      run, prompt, description, name, everyMs: Math.floor(everyMs), taskId, cwd: str(a.cwd) ?? '', timeoutSeconds,
      ...(typeof a.max === 'number' ? { max: a.max } : {}), watches: str(a.watches), own: a.own === true,
    }
  }

  /** The park a follower's trigger_create asked for (wait:true): a task-fields record on the base the follower showed. */
  function followerPark(
    home: string, actor: import('./offline-journal-core.js').JournalActor, budgetKey: string, taskId: string, waitUntil: string | undefined, opId: string, given: Record<string, unknown> | null,
  ): GatewayResult {
    if (!drainsKind(home, 'task-fields')) return fail('needs_leader', 'your Mac runs an older Walnut that cannot take a park later')
    const wait_until = waitUntil ?? new Date(deps.now() + 4 * 3_600_000).toISOString()
    const built = taskFieldsRecord(home, null, 'task_update', { id: taskId, phase: 'WAITING', wait_until }, given)
    if ('error' in built) return built.error
    const saved = refusal(append(home, built.record, false, { actor, opId: `${opId.slice(0, 74)}-park`, coalesce: true, limit: true, admit: () => admitWrite(budgetKey) ?? roomFor(home) }))
    return saved ?? ok({ queued: true })
  }

  /** The answer a retried follower call gets: the one its first attempt got (null: not such a record). */
  function followerCallAgain(home: string, r: Record<string, unknown>): GatewayResult | null {
    const seq = typeof r.seq === 'number' ? r.seq : 0
    if (r.kind === 'agent-memory' && typeof r.taskId === 'string') return memoryAnswer(r.taskId, true, seq)
    if (r.kind === 'letter' && typeof r.letterId === 'string') return letterAnswer(home, r.letterId, seq, true)
    if (r.kind !== 'op' || typeof r.op !== 'string') return null
    const a = (r.args ?? {}) as Record<string, unknown>
    if (r.op === 'trigger_create' && typeof a.id === 'string') {
      const plan = { name: String(a.name ?? ''), description: String(a.description ?? ''), everyMs: Number(a.every) || 0, run: String(a.run ?? ''), cwd: typeof a.cwd === 'string' ? a.cwd : '', taskId: String(a.session ?? '') }
      return triggerArmedAnswer(home, a.id, plan, '', true)
    }
    if (TRIGGER_WRITE_OPS.indexOf(r.op) !== -1 && r.trigger && typeof r.trigger === 'object') return triggerChangedAnswer(r.op, r.trigger as OfflineTrigger, true, r.armed === true)
    return null
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
    return appendLetter(home, { kind: 'session', sid: callerSid }, callerSid, args)
  }

  /**
   * A letter's checks, blob and `letter` record: a session's call answered here (opLetter) and
   * the follower's (followerCall) alike. `opId`: the follower's (a retry of its write is the first
   * record); this host's own call mints one.
   */
  function appendLetter(home: string, actor: import('./offline-journal-core.js').JournalActor, budgetKey: string, args: Record<string, unknown>, opId?: string): GatewayResult {
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
    const minted = `lt-${deps.now().toString(36)}-${deps.randomHex(3)}`
    const saved = journal.appendBlobs(home, { kind: 'letter', letterId: minted, format, args: rest }, { bodyBlob: Buffer.from(body, 'utf8') }, {
      actor, limit: true, ...(opId ? { opId } : {}),
      admit: (() => admitWrite(budgetKey) ?? roomFor(home)) as unknown as () => { ok: false; error: { code: string; message: string; retryAfterMs?: number } } | null,
    })
    const no = refusal(saved)
    if (no || !saved.ok) return no ?? fail('internal', 'not saved')
    if (!saved.duplicate) { try { deps.onJournal?.(home) } catch { /* a notify failure never loses the record */ } }
    // A retry of a saved letter names the letter its first attempt saved.
    const first = saved.duplicate ? (journal.byOpId(home, saved.opId) as { letterId?: unknown } | undefined)?.letterId : undefined
    const letterId = typeof first === 'string' ? first : minted
    deps.log('info', 'offline host: letter queued', { home, letterId, actor: budgetKey, type: args.type, format, bytes: Buffer.byteLength(body), seq: saved.seq, opId: saved.opId, ...(saved.duplicate ? { duplicate: true } : {}) })
    return letterAnswer(home, letterId, saved.seq, saved.duplicate === true)
  }

  function letterAnswer(home: string, letterId: string, seq: number, duplicate = false): GatewayResult {
    return ok({
      letterId, queued: true, offline: true, kind: 'letter', seq, ...(duplicate ? { duplicate: true } : {}),
      outcome: `Saved on this host, not in the user's inbox yet: Walnut sends letter ${letterId} when the server is back, at the time you sent it. ${offlineNote(home)}`,
      next: 'Do not send it again. If the user answers, the answer arrives as a message in this session; reply in the thread with human_inbox_reply and this letterId once the server is back.',
    })
  }

  // ── writes held for the server: nothing else could take them (holdWrite) ──

  /**
   * A message (task_send, session_send) or a memory write (agent_memory_write) that neither this
   * host nor the cloud companion can carry out while the Walnut server is away is held here, and
   * the caller hears "queued", not an error (2026-11-13, the org reflection: a VP's sends to another
   * host's task and to its own lead, and its memory writes, failed with hub_unreachable at 04:01,
   * 04:08 and 05:30 UTC and were resent by hand). The gateway asks only after this host's own answer
   * and the companion both said hub_unreachable (daemon-standalone.ts sendGatewayRequest, its twin).
   * Journaled as an `op` record under the call's own id: a retry of the same call is answered, never
   * written twice, and the Mac replays it once through the op (offline-handover.ts, the call-id
   * ledger), as the session that made it. Only for a Mac that drains `held-op` (MAC_DRAINS); never a
   * call outside a known session, nor one whose arguments ride in a file. Null: not held.
   */
  /** `opIdWithoutCall`: the record's op id when the call has no call id (a follower's own op id: its retry is held once). */
  function holdWrite(home: string, rawCallerSid: string, capability: string, payload: Record<string, unknown>, opIdWithoutCall?: string): GatewayResult | null {
    try {
      const name = typeof payload.name === 'string' ? payload.name : ''
      if (capability !== 'tools.call' || HELD_OPS.indexOf(name) === -1 || typeof payload.argsFile === 'string') return null
      if (!hasHome(home) || !drainsKind(home, 'held-op')) return null
      const callerSid = callerSidOf(home, rawCallerSid)
      if (!callerSid || !sessionOf(home, callerSid)) return null
      const raw = (payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args) ? payload.args : {}) as Record<string, unknown>
      const args: Record<string, unknown> = { ...raw }
      const me = callerIdentity(home, callerSid)
      if (name === 'agent_memory_write') {
        // Its own task by default (GET /me online): pinned now, so the replay writes the same one.
        if (typeof args.task !== 'string' || !args.task.trim()) {
          if (!me.taskId) return null
          args.task = me.taskId
        }
      }
      return appendHeld(home, callerSid, name, args, payload.callId, opIdWithoutCall)
    } catch (err) {
      deps.log('warn', 'offline host: a write could not be held', { home, error: (err as Error).message })
      return null
    }
  }

  /**
   * The held `op` record of a call whose target is already decided (holdWrite, and the
   * follower's memory folder note: followerCall). Needs a Mac that drains `held-op`.
   */
  function appendHeld(home: string, callerSid: string, name: string, args: Record<string, unknown>, rawCallId: unknown, opIdWithoutCall?: string): GatewayResult {
    // The caller's call id (src/lib/op-call-id.ts) keys the record: a retry of the same call is
    // answered from the first one, never written twice. Without one, each call is its own.
    const callId = typeof rawCallId === 'string' && /^oc-[A-Za-z0-9_-]{8,48}$/.test(rawCallId) ? rawCallId : ''
    const stable = callId ? callId.slice(3).split('_').join('-') : ''
    const message = name !== 'agent_memory_write'
    if (message && (typeof args.messageId !== 'string' || !/^qm-[A-Za-z0-9-]{1,64}$/.test(args.messageId))) {
      // The server's own retry fence for a message (send-queue.ts), from the call id when given.
      args.messageId = stable ? `qm-host-${stable}` : messageId(undefined)
    }
    let size = 0
    try { size = JSON.stringify(args).length } catch { return fail('bad_request', 'arguments are not JSON') }
    if (size > MAX_ARGS_BYTES) return fail('bad_request', `arguments are too large to hold on this host (${size} bytes, limit ${MAX_ARGS_BYTES})`)
    // The caller's own call id rides along, verbatim: the Mac replays under it, so the caller's
    // retry of the same call after the server is back meets the replay instead of running again.
    const saved = append(home, { kind: 'op', op: name, args, callerSid, ...(callId ? { callId } : {}) }, false, {
      ...(stable ? { opId: `held-${stable}` } : opIdWithoutCall ? { opId: opIdWithoutCall } : {}), limit: true, admit: () => admitWrite(callerSid) ?? roomFor(home),
    })
    const no = refusal(saved)
    if (no || !saved.ok) return no ?? fail('internal', 'not saved')
    deps.log('info', 'offline host: write held for the server', { home, op: name, callerSid, seq: saved.seq, opId: saved.opId, duplicate: saved.duplicate === true })
    // A duplicate answers the saved record's own message id (a regenerated one would name nothing).
    const rec = (saved.duplicate ? journal.byOpId(home, saved.opId) : undefined) ?? { seq: saved.seq, args }
    return ok(heldAnswerOf(home, name, rec, saved.duplicate === true))
  }

  /** The answer of a held `op` record: its first call's, and its retry's (with `duplicate`), alike. */
  function heldAnswerOf(home: string, name: string, rec: { seq?: unknown; args?: unknown }, duplicate: boolean): Record<string, unknown> {
    const args = (rec.args && typeof rec.args === 'object' ? rec.args : {}) as Record<string, unknown>
    const message = name !== 'agent_memory_write'
    // A note that asks nothing (wake=false) is not delivered when the server is back: it waits for
    // its target's next message there, as online (quiet-notes.ts), and no reply comes.
    const quiet = message && args.in_reply_to === undefined && rules.holdsQuietly(rules.ruleInputOf(args))
    const head = { queued: true, offline: true, held: true, op: name, seq: rec.seq, ...(message ? { messageId: args.messageId } : {}), ...(duplicate ? { duplicate: true } : {}) }
    if (quiet) {
      return {
        ...head,
        outcome: `Queued on this host: the Walnut server is away. When it is back, this note waits to ride its target's next message: it asks for no reply, so it starts no turn. ${offlineNote(home)} Do NOT resend.`,
        next: 'Nothing to wait for: no reply comes back.',
      }
    }
    return {
      ...head,
      outcome: `Queued on this host: the Walnut server is away, and when it is back it ${message ? 'delivers this message' : 'makes this write'}, once. ${offlineNote(home)} Do NOT resend.`,
      next: message
        ? (args.in_reply_to !== undefined ? 'Nothing else is required.' : 'A reply you asked for arrives in your session once it is delivered; do not poll.')
        : 'Nothing else is required.',
    }
  }

  // ── triggers: the checks this host runs (walnut-trigger) ──

  /**
   * The last create, pause, resume or delete made here per Walnut and trigger id, until
   * the server takes it. Per Walnut: two Walnuts on one host each hold their own. A
   * trigger created here stays `created` through the changes made to it after.
   */
  function triggerHoldsByHome(): Map<string, Map<string, TriggerHold>> {
    const out = new Map<string, Map<string, TriggerHold>>()
    for (const home of journal.homes()) {
      const holds = new Map<string, TriggerHold>()
      for (const r of recordsOf(home)) {
        if (r.kind !== 'op' || TRIGGER_WRITE_OPS.indexOf(r.op) === -1) continue
        const id = typeof r.args.id === 'string' ? r.args.id : ''
        if (!id) continue
        const prev = holds.get(id)
        const def = r.trigger ?? prev?.def
        const created = r.op === 'trigger_create' || prev?.created === true
        const update = r.op === 'trigger_update'
        // A change alone leaves on and off where it was: to a switch made here, else to the server's set.
        const keepsState = update && (!prev || prev.keepsState === true)
        holds.set(id, {
          home, on: update ? (prev && !prev.keepsState ? prev.on : r.armed === true) : r.op === 'trigger_resume' || r.op === 'trigger_create',
          ...(r.op === 'trigger_delete' || (update && prev?.deleted) ? { deleted: true } : {}), ...(created ? { created: true as const } : {}), ...(def ? { def } : {}),
          ...(update || prev?.updated ? { updated: true as const } : {}), ...(keepsState ? { keepsState: true as const } : {}),
        })
      }
      if (holds.size) out.set(home, holds)
    }
    return out
  }

  /**
   * The server's set with the holds of one Walnut over it (both daemon twins arm this): a trigger
   * paused or deleted here stays off even when a set that still carries it arrives first (the
   * reconnect pushes the set while the journal drains), one paused and resumed or created here runs
   * from its def, and one changed here runs its changed def in place of the server's while the
   * server's set still decides whether it runs. `parse`: the daemon's validateTriggerDef.
   */
  function applyTriggerHolds<D extends { id: string }>(holds: Map<string, TriggerHold>, defs: D[], parse: (raw: unknown) => { ok: true; def: D } | { ok: false }): D[] {
    if (holds.size === 0) return defs
    const out: D[] = []
    for (const def of defs) {
      const h = holds.get(def.id)
      if (h && !h.keepsState && h.on === false) continue
      const parsed = h && h.updated && h.def ? parse(h.def) : null
      out.push(parsed && parsed.ok ? parsed.def : def)
    }
    for (const [tid, hold] of holds) {
      if (!hold.on || !hold.def || hold.keepsState || out.some((def) => def.id === tid)) continue
      const parsed = parse(hold.def)
      if (parsed.ok) out.push(parsed.def)
    }
    return out
  }

  /** Every Walnut's holds by trigger id, for a count. */
  function triggerHolds(): Map<string, TriggerHold> {
    const out = new Map<string, TriggerHold>()
    for (const holds of triggerHoldsByHome().values()) for (const [id, hold] of holds) out.set(id, hold)
    return out
  }

  function holdsOf(home: string): Map<string, TriggerHold> {
    return triggerHoldsByHome().get(home) ?? new Map<string, TriggerHold>()
  }

  /** Whose an armed trigger is: the set it came in, else (an older server's set) the Walnut it delivers to. */
  function armedHome(t: { home?: string; def: OfflineTrigger }): string | undefined {
    return t.home || t.def.deliver?.home
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
    const hold = holdsOf(home).get(id)
    const armed = deps.triggers?.armed().find((t) => t.def.id === id && armedHome(t) === home)
    if (armed) return { def: armed.def, status: armed.status, ...(hold ? { hold } : {}) }
    if (hold?.def) return { def: hold.def, hold }
    return undefined
  }

  /**
   * This Walnut's triggers on this host: armed now, or paused or deleted here (with the def a
   * change here kept). trigger_list here and the follower's (follower.triggers) read it.
   */
  function hereTriggers(home: string): Array<{ def: OfflineTrigger; state: 'armed' | 'paused' | 'deleted'; status?: OfflineTriggerStatus; hold?: TriggerHold }> {
    const holds = holdsOf(home)
    const out: Array<{ def: OfflineTrigger; state: 'armed' | 'paused' | 'deleted'; status?: OfflineTriggerStatus; hold?: TriggerHold }> = (deps.triggers?.armed() ?? [])
      .filter((t) => armedHome(t) === home)
      .map((t) => ({ def: t.def, state: 'armed' as const, ...(t.status ? { status: t.status } : {}), ...(holds.get(t.def.id) ? { hold: holds.get(t.def.id) } : {}) }))
    for (const [id, hold] of holds) {
      if (hold.home !== home || hold.on || !hold.def || out.some((t) => t.def.id === id)) continue
      out.push({ def: hold.def, state: hold.deleted ? 'deleted' : 'paused', hold })
    }
    return out
  }

  /**
   * This Walnut's triggers here as the follower merges them into its routines copy: each one's
   * def, state and status, for one created here the description its record keeps, and for one
   * changed here what changed (`changes`: trigger_update's arguments, the later over the earlier).
   */
  function followerTriggers(home: string, id?: unknown): Record<string, unknown> {
    const described = new Map<string, string>()
    const changed = new Map<string, Record<string, unknown>>()
    for (const r of recordsOf(home)) {
      if (r.kind === 'op' && r.op === 'trigger_create' && typeof r.args.id === 'string' && typeof r.args.description === 'string') described.set(r.args.id, r.args.description)
      if (r.kind === 'op' && r.op === 'trigger_update' && typeof r.args.id === 'string') {
        const { id: tid, ...fields } = r.args
        changed.set(tid as string, { ...(changed.get(tid as string) ?? {}), ...fields })
      }
    }
    const triggers = hereTriggers(home)
      .filter((t) => typeof id !== 'string' || t.def.id === id)
      .map((t) => ({
        id: t.def.id, state: t.state, def: t.def, ...(t.status ? { status: t.status } : {}),
        ...(t.hold?.created ? { created: true } : {}), ...(described.has(t.def.id) ? { description: described.get(t.def.id) } : {}),
        ...(changed.has(t.def.id) ? { changes: changed.get(t.def.id) } : {}),
      }))
    return { host: slices.get(home)?.host ?? '', runsTriggers: !!deps.triggers, triggers }
  }

  function opTriggerList(home: string, args: Record<string, unknown> = {}): GatewayResult {
    const host = slices.get(home)?.host ?? ''
    const holds = holdsOf(home)
    const row = (def: OfflineTrigger, state: 'armed' | 'paused', status?: OfflineTriggerStatus) => ({
      id: def.id, name: def.name, every: everyLabel(def.everyMs), host, enabled: state === 'armed', state,
      run: def.check.run, ...(def.check.cwd ? { cwd: def.check.cwd } : {}),
      ...(def.deliver?.taskId ? { task: def.deliver.taskId } : {}),
      ...(status && iso(status.nextRunAtMs) ? { nextCheckAt: iso(status.nextRunAtMs) } : {}),
      ...(status && iso(status.lastRunAtMs) ? { lastCheckAt: iso(status.lastRunAtMs) } : {}),
      ...(status && iso(status.lastFireAtMs) ? { lastFireAt: iso(status.lastFireAtMs) } : {}),
      ...(status ? { consecutiveErrors: status.consecutiveErrors ?? 0, unackedFires: status.pendingFires ?? 0 } : {}),
      ...(holds.get(def.id) ? { changedHere: holds.get(def.id)!.created && holds.get(def.id)!.on ? 'created' : holds.get(def.id)!.on ? 'resumed' : 'paused' } : {}),
      // Created here: the server has no routine of this id until it reconnects.
      ...(holds.get(def.id)?.created ? { queued: true } : {}),
    })
    const triggers: Array<Record<string, unknown>> = hereTriggers(home)
      .filter((t) => t.state !== 'deleted')
      .map((t) => row(t.def, t.state === 'armed' ? 'armed' : 'paused', t.status))
    // The server's filters (src/ops/triggers.ts), honored here rather than ignored: a caller that
    // asked for one trigger must not read every one as its answer. This host's rows stay whole.
    const needle = typeof args.name === 'string' ? args.name.trim().toLowerCase() : ''
    const wanted = typeof args.state === 'string' ? args.state : ''
    const forTask = typeof args.task === 'string' ? args.task.trim() : ''
    const matched = triggers.filter((t) => (!wanted || t.state === wanted)
      && (!forTask || (typeof t.task === 'string' && t.task.startsWith(forTask)))
      && (!needle || [t.id, t.name].some((v) => typeof v === 'string' && v.toLowerCase().includes(needle))))
    const limit = typeof args.limit === 'number' && args.limit >= 1 ? Math.min(Math.floor(args.limit), 500) : 25
    const shown = matched.slice(0, limit)
    return ok({
      count: matched.length, ...(shown.length < matched.length ? { shown: shown.length, more: matched.length - shown.length } : {}),
      triggers: shown, offline: true, as_of: asOf(home),
      outcome: `${matched.length} trigger(s)${needle || wanted || forTask ? ' matching' : ''} this host checks for this Walnut, as this host runs them now. Triggers on other hosts, and ones paused or stopped before the server went away, are listed by the Walnut server.`,
      next: triggers.length > 0 && matched.length === 0
        ? 'None of this host\'s triggers matches; trigger_list with no name, state or task lists them all.'
        : triggers.length === 0
        ? (createsTriggers(home) ? 'No trigger runs here. trigger_create arms one here now.' : 'No trigger runs here. trigger_create needs the Walnut server.')
        : 'trigger_test runs a check once here; trigger_pause / trigger_delete stop one here at once.',
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
      result = await deps.triggers!.test({ run, ...(cwd ? { cwd } : {}), ...(typeof args.timeoutSeconds === 'number' ? { timeoutSeconds: args.timeoutSeconds } : {}) }, id, home)
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
        : createsTriggers(home)
          ? 'Arm it with trigger_create (same run and cwd): this host starts checking it now, and Walnut records it when the server is back.'
          : 'Arming it (trigger_create) needs the Walnut server: create it once the server answers again.',
    })
  }

  /**
   * A pause, resume or delete of a trigger this host runs: a session's call answered here, and
   * the follower's (followerCall), which names its own answer for a trigger not run here (`notHere`).
   */
  function opTriggerWrite(home: string, callerSid: string, name: string, args: Record<string, unknown>, notHere: (what: string) => GatewayResult = needsServer, opId?: string): GatewayResult {
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (!id) return fail('bad_request', `${name} needs "id"`)
    const t = triggerOf(home, id)
    const hold = t?.hold
    if (name === 'trigger_resume') {
      if (hold?.deleted) return fail('not_found', `Trigger ${id} was deleted on this host; nothing to resume`)
      if (t && !(hold && !hold.on)) {
        return ok({ id, triggerId: id, name: t.def.name, state: 'armed', changed: false, offline: true, outcome: `"${t.def.name}" is running on this host; nothing changed.`, next: 'Nothing else is required.' })
      }
      if (!t) return notHere(`Resuming trigger ${id}, which was not paused on this host`)
    } else {
      if (!t) return notHere(`Trigger ${id} is not one this host runs for this Walnut; changing it`)
      if (hold && !hold.on && (name === 'trigger_pause' || hold.deleted)) {
        return ok({ id, triggerId: id, name: t.def.name, state: hold.deleted ? 'deleted' : 'paused', changed: false, offline: true, outcome: `"${t.def.name}" is already ${hold.deleted ? 'deleted' : 'paused'} on this host; nothing changed.`, next: 'Nothing else is required.' })
      }
    }
    const denied = admitWrite(callerSid) ?? roomFor(home)
    if (denied) return denied
    const saved = refusal(append(home, { kind: 'op', op: name, args: { id }, callerSid, trigger: t!.def }, false, opId ? { opId } : {}))
    if (saved) return saved
    try { deps.triggers!.changed() } catch (err) { deps.log('warn', 'offline host: triggers did not follow a change here', { id, error: (err as Error).message }) }
    deps.log('info', 'offline host: trigger change queued', { home, op: name, id, callerSid })
    return triggerChangedAnswer(name, t!.def)
  }

  function triggerChangedAnswer(name: string, def: OfflineTrigger, duplicate = false, on = true): GatewayResult {
    const label = `"${def.name}"`
    const outcome = name === 'trigger_pause'
      ? `Paused ${label} on this host: it is not checked from now on; Walnut records the pause when the server reconnects.`
      : name === 'trigger_update'
        ? `Updated ${label} in place on this host: same id, it keeps the items it has seen and the script's cursor${on ? `, and the daemon here runs the new settings from its next check (every ${everyLabel(def.everyMs)})` : '; it is still paused: trigger_resume starts it again'}. Walnut makes the same change when the server reconnects.`
      : name === 'trigger_resume'
        ? `Resumed ${label} on this host: the first check runs within seconds, every ${everyLabel(def.everyMs)} after that; Walnut records it when the server reconnects.`
        : `Deleted ${label} on this host: nothing checks it any more; Walnut deletes the trigger when the server reconnects. Its check script file is untouched.`
    // triggerId: the same id under a name a link frame never takes (its own `id` addresses the answer).
    return ok({
      id: def.id, triggerId: def.id, name: def.name, state: name === 'trigger_update' ? (on ? 'armed' : 'paused') : name === 'trigger_resume' ? 'armed' : name === 'trigger_pause' ? 'paused' : 'deleted',
      changed: true, queued: true, offline: true, ...(duplicate ? { duplicate: true } : {}), outcome, next: 'Nothing else is required. Do not repeat the call.',
    })
  }

  /**
   * A wait clock as the server reads one (core/task-wait-clock.ts parseWaitUntil): an ISO
   * time or a duration from now ("90m", "6h", "3d"), turned into a time HERE, so a queued
   * park keeps the clock its caller meant and not one counted from when the server is back.
   * `''` = no clock, undefined = none named; a string that is neither throws.
   */
  function waitClock(raw: unknown): string | undefined {
    if (raw === undefined || raw === null) return undefined
    if (typeof raw !== 'string' && typeof raw !== 'number') throw new Error('wait_until must be an ISO datetime or a duration like "6h" / "3d"')
    const text = typeof raw === 'string' ? raw.trim() : String(raw)
    if (text === '') return ''
    const units: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }
    const duration = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(text)
    const now = deps.now()
    const atMs = duration ? now + Math.floor(Number(duration[1]) * units[(duration[2] ?? 'ms').toLowerCase()]) : Date.parse(text)
    if (!Number.isFinite(atMs)) throw new Error(`wait_until "${text}" is neither an ISO datetime nor a duration like "6h" / "3d"`)
    if (atMs <= now) throw new Error(`wait_until "${text}" is not in the future`)
    return new Date(atMs).toISOString()
  }

  /**
   * trigger_create while the Walnut server is away: the same checks as the server's
   * (core/routines/trigger-api.ts createTriggerRoutine), the routine's id given here, the
   * check armed here at once (a `trigger_create` record is a hold that is on, with its def),
   * and its fires delivered by this host as a fire no server claimed is. The server replays
   * the record under the same id (offline-handover.ts) and pushes its set before the ack, so
   * the trigger is never armed twice and keeps its seen ids, cursor and fires. A park the
   * caller asked for (wait:true) is its own queued task_update, after it.
   */
  function opTriggerCreate(home: string, callerSid: string, args: Record<string, unknown>): GatewayResult {
    const table = deps.triggers!
    const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
    const here = slices.get(home)?.host ?? ''
    if (text(args.template)) return needsServer('A template trigger (its check asks the Walnut server)', home)
    if (args.id !== undefined) return fail('bad_request', 'trigger_create takes no "id": Walnut names the trigger')
    const host = text(args.host)
    if (host && host !== here && !(here === 'local' && host === '__local__')) return needsServer(`A trigger on host "${host}"`, home)
    const run = text(args.run)
    if (!run) return fail('bad_request', 'run is required: the shell command that decides whether to fire')
    const prompt = text(args.prompt)
    if (!prompt) return fail('bad_request', 'prompt is required: what the session should do when it fires')
    // The host delivers the fires itself, so the prompt rides in the def (DELIVER_PROMPT_MAX).
    if (prompt.length > 32 * 1024) return needsServer('A trigger prompt over 32 KB', home)
    const description = text(args.description).replace(/\s+/g, ' ')
    if (!description) {
      return fail('bad_request', 'description is required: one or two plain sentences saying what this watches, when it fires, and what the session does then')
    }
    // TRIGGER_DESCRIPTION_MAX (trigger-api.ts).
    if (description.length > 600) return fail('bad_request', `description is ${description.length} characters; the limit is 600 (one or two sentences)`)
    // The server's own reading (core/routines/trigger-watches.ts): "ask", a letter, or "own".
    const watchKit = deps.watches ?? createTriggerWatches()
    const watch = watchKit.parse(args.watches)
    if (watch === 'invalid') return fail('bad_request', watchKit.invalid)
    const watches = watch === null ? null : watch.kind === 'own' ? watchKit.own : watch.what
    const rawEvery = args.every
    let everyMs: number | null = null
    if (typeof rawEvery === 'number' && Number.isFinite(rawEvery)) everyMs = Math.floor(rawEvery)
    else {
      const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(text(rawEvery).toLowerCase())
      const factor: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }
      if (m) everyMs = Math.floor(Number(m[1]) * factor[m[2] ?? 'ms'])
    }
    if (everyMs === null || !Number.isFinite(everyMs)) return fail('bad_request', 'every is required: milliseconds, or a duration like "30s" / "5m" / "1h"')
    // MIN_EVERY_MS (trigger-check-core.ts).
    if (everyMs < 10_000) return fail('bad_request', 'every must be at least 10s')
    if (args.wait !== undefined && typeof args.wait !== 'boolean') return fail('bad_request', 'wait must be true or false')
    let waitUntil: string | undefined
    try { waitUntil = waitClock(args.wait_until) } catch (err) { return fail('bad_request', (err as Error).message) }
    const max = args.maxFiresPerDay
    if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 0)) {
      return fail('bad_request', 'maxFiresPerDay must be a whole number, 0 or more (0 = no limit)')
    }
    const rawTimeout = args.timeoutSeconds
    if (rawTimeout !== undefined && (typeof rawTimeout !== 'number' || !Number.isInteger(rawTimeout) || rawTimeout <= 0)) {
      return fail('bad_request', 'timeoutSeconds must be a whole number of seconds')
    }
    // clampTimeoutSeconds (trigger-check-core.ts): default 30, at most 300.
    const timeoutSeconds = Math.min(300, Math.max(1, typeof rawTimeout === 'number' ? Math.floor(rawTimeout) : 30))

    // The task its fires go to: the caller's own, or one this host holds.
    const session = text(args.session) || 'this'
    const caller = sessionOf(home, callerSid)
    let target: OfflineSliceTask | undefined
    if (session === 'this') {
      if (!caller?.taskId) return fail('bad_request', 'no calling session; pass session: <taskId>')
      target = tasksWithOverlay(home).find((t) => t.id === caller.taskId)
      if (!target) return needsServer('A trigger for a task this host does not hold', home)
    } else {
      const found = resolveTask(home, session)
      if (found.error) return found.error
      if (!found.task) return needsServer(`Task ${session} is not in this host's offline copy; a trigger for it`, home)
      target = found.task
    }
    if (target.phase === 'COMPLETE') return fail('bad_request', `task ${target.id} is complete, so a fire could not land there; point the trigger at an open task`)
    const own = caller?.taskId === target.id
    const cwd = text(args.cwd) || table.cwdOf?.(callerSid) || ''
    // The server's label (trigger-label.ts): the author's name, else one from the description, never the prompt.
    const name = deps.labels
      ? deps.labels.label({ name: args.name, description, prompt, run })
      : text(args.name) || description.slice(0, 48)
    const plan: TriggerPlan = { run, prompt, description, name, everyMs, taskId: target.id, cwd, timeoutSeconds, ...(typeof max === 'number' ? { max } : {}), watches, own }
    const armed = armTrigger(home, callerSid, plan)
    if ('error' in armed) return armed.error
    // A park is the session's call, as online: only with wait:true, never for a watch of the user.
    const park = args.wait === true && !watches
      ? opQueued(home, callerSid, 'task_update', { id: target.id, phase: 'WAITING', wait_until: waitUntil ?? new Date(deps.now() + 4 * 3_600_000).toISOString() })
      : null
    return triggerArmedAnswer(home, armed.id, plan, parkWords(plan, park, waitUntil))
  }

  /** What a trigger made here is armed with: every input decided (by this host's call, or the follower's). */
  interface TriggerPlan {
    run: string; prompt: string; description: string; name: string; everyMs: number; taskId: string; cwd: string
    timeoutSeconds: number; max?: number; watches: string | null; own: boolean
  }

  /**
   * Arm a trigger here under an id this host gives: its def checked by this daemon, the
   * `trigger_create` record (a hold that is on, with its def) the server replays under the same
   * id, and the check armed at once. The one way in for this host's call and the follower's.
   */
  function armTrigger(home: string, callerSid: string, p: TriggerPlan, opId?: string): { id: string } | { error: GatewayResult } {
    const table = deps.triggers!
    const here = slices.get(home)?.host ?? ''
    // The server's routine id shape (cron/jobs.ts generateId) with a longer random part, so
    // an id this host gives can never be one the server gave (trigger-api.ts HOST_TRIGGER_ID_RE).
    const id = `${deps.now().toString(36)}-${deps.randomHex(4)}`
    const def: OfflineTrigger = {
      id, name: p.name, everyMs: p.everyMs,
      check: { run: p.run, ...(p.cwd ? { cwd: p.cwd } : {}), timeoutSeconds: p.timeoutSeconds },
      // wireFireCap (trigger-push.ts): a stored 0 ("no limit") goes out as a cap nothing reaches.
      ...(typeof p.max === 'number' ? { limits: { maxFiresPerDay: p.max > 0 ? p.max : 1_000_000 } } : {}),
      deliver: { home, taskId: p.taskId, prompt: p.prompt },
    }
    const checked = table.validate ? table.validate(def) : { ok: false as const, error: 'this daemon cannot check a trigger' }
    if (!checked.ok) return { error: fail('bad_request', checked.error) }
    // What the server is asked to store, all of it decided here: the same id, the task (not
    // "this": the session could be replaced by then), this host, the cwd it runs in.
    const replayArgs: Record<string, unknown> = {
      id, run: p.run, prompt: p.prompt, description: p.description, name: p.name, every: p.everyMs, session: p.taskId, host: here === 'local' ? '__local__' : here,
      ...(p.cwd ? { cwd: p.cwd } : {}), timeoutSeconds: p.timeoutSeconds, ...(typeof p.max === 'number' ? { maxFiresPerDay: p.max } : {}), ...(p.watches ? { watches: p.watches } : {}),
    }
    // The budget is charged under the journal lock, so a locked try costs none (opQueued).
    const saved = refusal(append(home, { kind: 'op', op: 'trigger_create', args: replayArgs, callerSid, trigger: def }, false, { ...(opId ? { opId } : {}), admit: () => admitWrite(callerSid) ?? roomFor(home) }))
    if (saved) return { error: saved }
    try { table.changed() } catch (err) { deps.log('warn', 'offline host: triggers did not follow a change here', { id, error: (err as Error).message }) }
    deps.log('info', 'offline host: trigger created here', { home, id, taskId: p.taskId, everyMs: p.everyMs, callerSid })
    return { id }
  }

  /** What the answer says the trigger did to its task (`park`: the queued park's answer, null for none). */
  function parkWords(p: TriggerPlan, park: GatewayResult | null, waitUntil?: string): string {
    const own = deps.watches ? deps.watches.own : 'own'
    if (park) {
      return park.ok
        ? ` The task is queued to wait (Waiting) until it fires${waitUntil ? ` or ${waitUntil}` : ''}; Walnut applies that when the server is back.`
        : ` The task could not be parked here (${park.error.message}); park it with task_update phase=WAITING.`
    }
    if (p.watches === own) return ' The task was not parked: this trigger watches your own work (watches:"own"), which is work going on, so the task reads Working, never Waiting.'
    if (p.watches) return ' The task was not parked: this trigger watches the user\'s ask, and a wait on the user stays Needs you.'
    return p.own ? '' : ' The task it delivers into was left as it is (not your task; pass wait:true to park it).'
  }

  function triggerArmedAnswer(home: string, id: string, p: Pick<TriggerPlan, 'name' | 'description' | 'everyMs' | 'run' | 'cwd' | 'taskId'>, parked: string, duplicate = false): GatewayResult {
    const here = slices.get(home)?.host ?? ''
    return ok({
      id, triggerId: id, name: p.name, host: here, queued: true, offline: true, ...(duplicate ? { duplicate: true } : {}),
      job: { id, name: p.name, description: p.description, schedule: { kind: 'every', everyMs: p.everyMs }, check: { run: p.run, ...(p.cwd ? { cwd: p.cwd } : {}), host: here }, executor: { type: 'session', config: { target: p.taskId } } },
      outcome: `Trigger armed on this host: the daemon here runs the check every ${everyLabel(p.everyMs)} from now on and delivers the prompt into the task's session when it fires, while the Walnut server is away too. Walnut records trigger ${id} under this id when the server is back.${parked}`,
      next: `Do not create it again. Tell the user in one line what is watched and how often. Turn it off with trigger_delete '{"id":"${id}"}' once it has done its job.`,
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
  async function handle(home: string, rawCallerSid: string, capability: string, payload: Record<string, unknown>): Promise<GatewayResult> {
    const callerSid = callerSidOf(home, rawCallerSid)
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
        case 'trigger_list': if (deps.triggers) return opTriggerList(home, args); return needsServer('"trigger_list"', home)
        case 'trigger_test': if (deps.triggers) return await opTriggerTest(home, callerSid, args); return needsServer('"trigger_test"', home)
        case 'trigger_pause': case 'trigger_resume': case 'trigger_delete':
          if (deps.triggers) return opTriggerWrite(home, callerSid, name, args)
          return needsServer(`"${name}"`, home)
        // A Mac that does not replay one under this host's id (an older one) gets it only online.
        case 'trigger_create':
          if (createsTriggers(home)) return whenUnlocked(home, name, () => opTriggerCreate(home, callerSid, args))
          return needsServer('"trigger_create"', home)
        // WP11: a note written while away, when the leading Mac drains notes and this host keeps them.
        case 'note_write': case 'note_edit':
          if (deps.replica && deps.replica.has(home, 'notes') && drainsKind(home, 'note')) {
            return name === 'note_write' ? opNoteWrite(home, callerSid, args) : opNoteEdit(home, callerSid, args)
          }
          // Notes turned off for this host: kept only on the Mac (4f).
          if (deps.replica && typeof deps.replica.isOff === 'function' && deps.replica.isOff(home, 'notes')) return notesNotKept()
          return needsServer(`"${name}"`, home)
        // A MEMORY.md append, when the leading Mac drains `agent-memory`; an older one: as before.
        case 'agent_memory_write':
          if (drainsKind(home, 'agent-memory')) return whenUnlocked(home, name, () => opAgentMemoryWrite(home, callerSid, args, payload.callId))
          return needsServer('"agent_memory_write"', home)
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
    const remoteHost = liveHere(home, row.fromSessionId) ? undefined : row.fromHost
    if (!liveHere(home, row.fromSessionId) && !(remoteHost && deps.relay)) {
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
  async function onResult(sid: string, line: string, v?: number, parseLine?: () => unknown): Promise<void> {
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
        // A task that parked itself (WAITING: a build, a review) is not abandoning the request; its
        // answer comes later and the deadline still counts (the server holds the same, request-progress.ts).
        const owner = row.toTaskId ? tasksWithOverlay(home).find((t) => t.id === row.toTaskId) : undefined
        if (owner?.phase === 'WAITING') continue
        let parsed: { result?: unknown; is_error?: unknown } = {}
        try { parsed = (parseLine ? parseLine() : JSON.parse(line)) as typeof parsed } catch { /* the outcome still stands */ }
        await notify(home, row, parsed.is_error === true ? 'error' : 'completed', typeof parsed.result === 'string' ? parsed.result : undefined)
      }
    }
  }

  /**
   * A trigger fire no server claimed, written into the target task's session on
   * this host (the walnut-trigger daemon builds the envelope), the target picked by
   * this host's copy (triggerTargetOf). The fire's own queue tells the server what
   * happened, on its replay.
   */
  async function deliverTrigger(
    home: string,
    taskId: string,
    text: string,
    messageId: string,
  ): Promise<{ ok: true; sid: string; resumed?: true } | { ok: false; reason: string }> {
    const target = triggerTargetOf(home, taskId)
    if (!target.ok) return target
    return deliverTriggerTo(home, taskId, { sid: target.sid, resume: target.resume }, text, messageId)
  }

  /**
   * Which session of the task on this host takes a fire, by this host's copy: the
   * rule the host's own Walnut server applies over its copies too (host-trigger-target.ts).
   * The pick the server makes: the newest live session of the task, as this copy lists
   * them; else the stopped one, resumed with the fire as its first message (the idle
   * reaper stops a quiet CLI after two hours, so an overnight fire finds it stopped).
   * A COMPLETE task is the server's call (it refuses and tells the user), as is a task
   * with no session here (the server starts one).
   */
  function triggerTargetOf(home: string, taskId: string): HostTriggerTarget {
    const slice = slices.get(home)
    if (!slice) return { ok: false, reason: 'no host copy for this Walnut' }
    if (!deps.triggerTarget) return { ok: false, reason: 'this daemon has no rule for a trigger fire\'s session' }
    const task = tasksWithOverlay(home).find((t) => t.id === taskId)
    const slot = task?.session_id
    const here: HostTriggerSession[] = slice.sessions
      .filter((s) => s.taskId === taskId || (!!slot && s.sid === slot))
      .map((s) => ({ sid: s.sid, live: liveHere(home, s.sid), ...(s.aside ? { aside: true } : {}), ...(s.noResume ? { noResume: true } : {}), ...(s.acp ? { acp: true } : {}) }))
    return deps.triggerTarget(task, here, { resume: !!deps.resume })
  }

  /**
   * The mechanics of a fire's delivery to a session picked already (by this host's copy,
   * or by the host's own Walnut server over its copies: follower.trigger.deliver): a live
   * one gets it in its FIFO (no record: the fire's queue is the record); a stopped one is
   * resumed with it as its first message and journaled `resume`, because the server's
   * record of that session still says stopped.
   */
  async function deliverTriggerTo(
    home: string,
    taskId: string,
    target: { sid: string; resume: boolean },
    text: string,
    messageId: string,
  ): Promise<{ ok: true; sid: string; resumed?: true } | { ok: false; reason: string }> {
    const sid = target.sid
    const row = sessionOf(home, sid)
    if (!row) return { ok: false, reason: 'not a session of this Walnut on this host' }
    if (row.taskId && row.taskId !== taskId) return { ok: false, reason: 'that session belongs to another task' }
    if (row.acp) return { ok: false, reason: 'the target task runs on an ACP engine; the Walnut server delivers it' }
    if (!target.resume) {
      if (!liveHere(home, sid)) return { ok: false, reason: 'that session is not running on this host' }
      try {
        // A fire's id is the same on every try (trigger-check-core.ts fireMessageId): one that went
        // before a restart lost its mark is not written again.
        const delivered = await deliverWithTaskRouting(home, sid, text, messageId, { resend: true })
        return delivered.ok ? { ok: true, sid } : { ok: false, reason: delivered.reason }
      } catch (err) {
        return { ok: false, reason: (err as Error).message }
      }
    }
    if (!deps.resume) return { ok: false, reason: 'no live session of the target task on this host' }
    if (roomFor(home)) return { ok: false, reason: 'this host\'s journal for the Walnut server is full' }
    let resumed: DeliverResult
    try {
      resumed = await resumeWithTaskRouting(home, sid, text, messageId, taskId)
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
    if (!resumed.ok) return { ok: false, reason: resumed.reason }
    append(home, { kind: 'resume', sid, taskId, messageId })
    deps.log('info', 'offline host: resumed a stopped session for a trigger fire', { home, sid, taskId, messageId })
    return { ok: true, sid, resumed: true }
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
        if (!liveHere(home, d.toSid)) return fail('not_running', `session ${d.toSid.slice(0, 8)} is not running on this host`)
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
      if (opensRequest(home, { ...(d.expect_reply !== undefined ? { expect_reply: d.expect_reply } : {}) }, fromTaskId, target.taskId)) {
        const implicit = d.expect_reply === undefined
        row = {
          id: `rq-${deps.randomHex(6)}`,
          fromSessionId: from.sid,
          toSessionId: targetSid,
          ...(target.taskId ? { toTaskId: target.taskId } : {}),
          preview: kit.requestPreview(text),
          status: 'pending',
          createdAt: new Date(deps.now()).toISOString(),
          deadlineAt: deps.now() + replySecs(home, d.reply_timeout, implicit, target.taskId) * 1000,
          fromHost: from.host,
          ...(deps.turnActive(targetSid) ? { skipTurnEnds: 1 } : {}),
        }
        const offset = deps.streamOffset(targetSid)
        if (typeof offset === 'number') row.afterV = offset
      }
      const envelope = kit.buildPeerWrapper(escapeSenderWords(admitted.text), {
        title: typeof from.title === 'string' ? from.title : '', shortId: from.sid.slice(0, 8), sessionId: from.sid,
        taskId: fromTaskId, host: from.host, ...(row ? { requestId: row.id } : {}),
      }, { title: typeof d.title === 'string' ? d.title : undefined })
      const mid = messageId(d.messageId)
      const delivered = await deliverPeer(home, { fromSessionId: from.sid, toSessionId: targetSid, toTaskId: target.taskId, envelope, messageId: mid, row, online: false })
      if (!delivered.ok) return fail('internal', `delivery failed: ${delivered.reason}`)
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
      // An ACP session is never resumed here as a CLI: the server's ACP worker delivers it.
      if (sessionOf(home, sid)?.acp) return fail('not_running', 'this session runs on an ACP engine; the Walnut server delivers it when it is back')
      if (!liveHere(home, sid)) {
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

  /**
   * The slice of `home` as the leader pushed it, for a host's Walnut service that keeps no copy
   * (`follower.slice`, 'copyless-service-v1'; replica/slice-source.ts): its rows as they came,
   * never folded with the journal (the service folds `follower.pending` over them, as over a
   * copy). Lane and environment sessions stay out, as in `sessionsOf`. Null: no slice yet.
   */
  function sliceRowsOf(home: string): { host: string; asOf: number; tasks: OfflineSliceTask[]; sessions: OfflineSliceSession[]; requests: OfflineSliceRequest[]; boards: OfflineSliceBoard[]; boardOf: Record<string, string> } | null {
    const slice = slices.get(home)
    if (!slice) return null
    return {
      host: slice.host, asOf: slice.asOf, tasks: slice.tasks, sessions: slice.sessions.filter((s) => !s.aside),
      requests: slice.requests, boards: slice.boards ?? [], boardOf: slice.boardOf ?? {},
    }
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

  // The key as the caller named it. When the primary keeps one tree by project, an older path
  // queued here still lands right: the primary's resolver follows the move (note-path-moves.ts).
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
    // A locked or hidden note is changed only on the Mac, by its owner (docs/reference/locked-notes.md).
    const kind = noteProtection(current)
    if (kind) return fail('needs_leader', `this note is ${kind}, so it is changed only in Walnut on your Mac`, { detail: { why: `note_${kind}` } })
    const nextKind = req.mode !== 'delete' && typeof req.content === 'string' ? noteProtection(req.content) : null
    if (nextKind) {
      return fail('needs_leader', nextKind === 'locked' ? 'this text is a locked note\'s file: only Walnut\'s Lock on your Mac writes one' : 'this text hides the note: a note is hidden only in Walnut on your Mac', { detail: { why: `${nextKind}_note_text` } })
    }
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
    const budgetKey = budgetOfActor(actor)
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
    configure, foldHome, holdsSlice, hasHome, ownerOf, runtimeOwnerOf, pendingHandover, hasRecords, drain, ack, noteSettings, noteStop, handle, handleLocal, handleFollower, holdWrite,
    /** A same-host send handleLocal may take (its message id set on the payload): the gateway hands it to a follower that answers it. */
    localCandidate: (home: string, rawCallerSid: string, capability: string, payload: Record<string, unknown>): boolean => localCall(home, rawCallerSid, capability, payload) !== null,
    /** A follower's peer message (`follower.peer`): the write into the live CLI and its records. */
    handleFollowerPeer,
    /** A same-host send handed to this host's Walnut server while the server answers: written once, by it or by the relay. */
    openOnline, endOnline,
    /** handleFollower, waiting out another process's journal lock (whenUnlocked): the twins' follower.op. */
    handleFollowerWaiting: (home: string, req: Parameters<typeof handleFollower>[1]) => whenUnlocked(home, String(req.op ?? ''), () => handleFollower(home, req)),
    /** noteSession, waiting out another process's journal lock (whenUnlocked): the twins' host ask. */
    noteSessionWaiting: (home: string, rec: Parameters<typeof noteSession>[1], opId?: string, by?: unknown) => whenUnlocked(home, 'session', () => noteSession(home, rec, opId, by)),
    /** noteRoutineTask, waiting out another process's journal lock: a routine run's task (clock-host-start-v1). */
    noteRoutineTaskWaiting: (home: string, rec: Parameters<typeof noteRoutineTask>[1], opId: string, jobId: string) => whenUnlocked(home, 'task-create', () => noteRoutineTask(home, rec, opId, jobId)),
    noteRoutineTask, checkRoutineRun, knowsSession,
    pendingFor, journalStats, onResult, sweep, deliverTrigger, deliverTriggerTo, liveSessionsOf, deliverFromLeader, deliverHuman, callerOf, answersRead, sessionsOf, sliceRowsOf, noteSession, checkSession, checkTaskStart,
    triggerHolds, triggerHoldsByHome, applyTriggerHolds, homes: () => [...slices.keys()], freshHomes, journal, QUEUEABLE, RETIRED_TASK_INPUTS, CLOSE_NEEDS_SERVER,
    /** The follower's read of this Walnut's triggers here (follower.triggers, follower-triggers-v1). */
    followerTriggers,
    /** The follower's trigger_test (follower.trigger.test): the check run once here, as this host's own trigger_test runs it. */
    followerTriggerTest: (home: string, req: { actor?: unknown; args?: unknown }): Promise<GatewayResult> => {
      const actor = actorOf(req.actor, home)
      if (actor === 'older' || !actor) return Promise.resolve(fail('bad_request', 'follower.trigger.test needs a session or a plugin job'))
      if (!deps.triggers) return Promise.resolve(fail('needs_leader', 'this host runs no trigger checks', { detail: { why: 'routine_writes_need_mac' } }))
      const args = (req.args && typeof req.args === 'object' && !Array.isArray(req.args) ? req.args : {}) as Record<string, unknown>
      return opTriggerTest(home, budgetOfActor(actor), args)
    },
  }
}

/**
 * The offline host with its journal store. The twins pass the store they built (it also
 * migrates v1 journals and serves offline.blob); any other caller gets one in `deps.dir`.
 */
export function createOfflineHost(deps: OfflineHostDeps) {
  return createOfflineHostCore({
    ...deps,
    labels: deps.labels ?? createTriggerLabel(),
    watches: deps.watches ?? createTriggerWatches(),
    triggerTarget: deps.triggerTarget ?? pickHostTriggerTarget,
    journal: deps.journal ?? createOfflineJournal({
      fs: deps.fs, path: deps.path, dir: deps.dir, now: deps.now, randomHex: deps.randomHex, keyOf: deps.keyOf, log: deps.log,
      sha256: (body) => createHash('sha256').update(body).digest('hex'), maxRecords: deps.maxRecords ?? OFFLINE_MAX_RECORDS,
    }),
  })
}

export type OfflineHost = ReturnType<typeof createOfflineHostCore>
