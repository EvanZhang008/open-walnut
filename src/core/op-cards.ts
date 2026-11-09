/**
 * The Walnut ops that carry words to someone, and what their card says.
 *
 * A session that sends a message, updates one of the user's Threads, writes its
 * Brief, mails the inbox or posts on a Board shows that call in its chat as a card
 * (web SessionOutboundCard): To whom, a Title, a Summary of a line or two, and the
 * full words folded below with the raw call. 2026-11-09, the user, of a lead's
 * chat where every send read "Payload from file — the text is not in this
 * transcript": the card must show what was sent however the call was made.
 *
 * One table, read twice: the `walnut` CLI computes a call's card from the exact
 * arguments it sent (and the answer it got) and records it with the server
 * (core/sessions/op-call-log.ts), so `@file`, stdin and a payload built in a
 * subshell card as well as inline JSON; the web computes the same fields from the
 * arguments it can read in the transcript (an MCP call, inline JSON, a heredoc)
 * for history recorded before, or a server it cannot ask.
 *
 * Pure and dependency-free: the web imports it (`@open-walnut/op-cards`).
 */

export type OpCardKind = 'send' | 'reply' | 'thread' | 'brief' | 'letter' | 'board' | 'task'

export interface OpCardFields {
  /** The op that ran. */
  op: string
  kind: OpCardKind
  /** Who it went to: task ids, session ids or prefixes, in order. */
  to: string[]
  /** What the target is when no task names it ("Your inbox", "Thread th-…"). */
  toLabel?: string
  /** The sender's own TL;DR, else the first sentence of the words. */
  title?: string
  /** A line or two of the words, after the title. */
  summary?: string
  /** Every word that was sent, as written (markdown). */
  detail?: string
}

type Args = Record<string, unknown>

interface OpCardSpec {
  kind: OpCardKind | ((args: Args) => OpCardKind)
  /** Arguments naming the target, first present wins per key; arrays spread. */
  to?: string[]
  /** Read from the op's answer when the arguments name no one (a new task's id). */
  toFromResult?: string[]
  toLabel?: (args: Args) => string | undefined
  title?: (args: Args) => string | undefined
  /** The words, in order of preference. */
  detail: (args: Args) => string | undefined
  /** An explicit summary the op carries (a thread's summary is its `reply`). */
  summary?: (args: Args) => string | undefined
}

function s(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

function first(args: Args, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = s(args[k])
    if (v) return v
  }
  return undefined
}

/** A letter's html as text, for a card (never rendered as html here). */
function htmlText(html: string | undefined): string | undefined {
  if (!html) return undefined
  return s(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
}

/** A Brief's exact-string edits, as words a reader follows. */
function editsText(edits: unknown): string | undefined {
  if (!Array.isArray(edits) || edits.length === 0) return undefined
  const parts = edits.map((e) => {
    const o = e && typeof e === 'object' ? e as Args : {}
    const next = s(o.new) ?? s(o.new_string) ?? ''
    const old = s(o.old) ?? s(o.old_string) ?? ''
    return next ? next : old ? `(removed) ${old}` : ''
  }).filter(Boolean)
  return parts.length ? parts.join('\n\n') : undefined
}

function threadWords(args: Args): string | undefined {
  const lines: string[] = []
  if (s(args.reply)) lines.push(args.reply as string)
  if (s(args.ask)) lines.push(`**Ask:** ${args.ask as string}`)
  if (s(args.merge_into)) lines.push(`Merged into another thread (${args.merge_into as string}).`)
  if (s(args.state)) lines.push(`State: ${args.state as string}.`)
  if (args.close === true) lines.push('Closed.')
  if (args.reopen === true) lines.push('Reopened.')
  if (s(args.snooze)) lines.push(`Snoozed until ${args.snooze as string}.`)
  return lines.length ? lines.join('\n\n') : undefined
}

const SEND: OpCardSpec = {
  kind: (a) => (s(a.in_reply_to) || s(a.inReplyTo) ? 'reply' : 'send'),
  to: ['to'],
  // The task the server says the message reached (`to` may be a title or a prefix).
  toFromResult: ['targetTaskId'],
  title: (a) => s(a.title),
  detail: (a) => first(a, ['text']) ?? s(a.result),
}

const START: OpCardSpec = {
  kind: 'task',
  to: ['id', 'task'],
  detail: (a) => first(a, ['message', 'text']),
}

/**
 * Every op that carries words to someone. A new op with a message-like argument
 * either joins this table or `NOT_CARDED` below (tests/web/op-card-forms.test.ts).
 */
export const OP_CARDS: Record<string, OpCardSpec> = {
  task_send: SEND,
  session_send: SEND,
  org_send: { kind: 'send', to: ['to'], title: (a) => s(a.title), detail: (a) => s(a.text) },
  // A mail or Slack item handed to the task that takes it, with the router's brief.
  router_route: {
    kind: 'send', to: ['task_id'], toFromResult: ['taskId', 'targetTaskId'],
    toLabel: (a) => (a.not_routed === true ? 'Not routed' : undefined),
    title: (a) => s(a.new_task_title) ?? s(a.reason), detail: (a) => s(a.text) ?? s(a.reason),
  },
  triage_route: { kind: 'send', toFromResult: ['taskId', 'targetTaskId'], title: (a) => s(a.item), detail: (a) => s(a.text) },
  // A thread, a Brief and a Board are the node's own (`task` defaults to the
  // caller's): the card names the place, never the caller as its own target.
  thread_update: {
    kind: 'thread',
    toLabel: () => 'Thread',
    title: (a) => s(a.title),
    summary: (a) => s(a.reply),
    detail: threadWords,
  },
  thread_create: { kind: 'thread', toLabel: () => 'New thread', title: (a) => s(a.title), detail: (a) => s(a.text) },
  thread_file: { kind: 'thread', toLabel: () => 'Thread', title: (a) => s(a.title), detail: (a) => s(a.text) },
  brief_write: {
    kind: 'brief',
    toLabel: () => 'Brief',
    title: (a) => (s(a.content) ? 'Brief rewritten' : 'Brief edited'),
    detail: (a) => s(a.content) ?? editsText(a.edits),
  },
  human_inbox_send: {
    kind: 'letter',
    to: ['task_refs'],
    toLabel: () => 'Your inbox',
    title: (a) => s(a.subject),
    detail: (a) => first(a, ['markdown', 'text']) ?? htmlText(s(a.html)),
  },
  human_inbox_reply: {
    kind: 'letter',
    toLabel: (a) => (s(a.letter) ? `Inbox letter ${a.letter as string}` : 'Your inbox'),
    detail: (a) => first(a, ['markdown', 'text']) ?? htmlText(s(a.html)),
  },
  human_inbox_answer: {
    kind: 'letter',
    toLabel: (a) => (s(a.id) ? `Inbox letter ${a.id as string}` : 'Your inbox'),
    title: (a) => (s(a.action_id) ? `Answered: ${a.action_id as string}` : undefined),
    detail: (a) => first(a, ['note', 'text']),
  },
  board_post: { kind: 'board', to: ['task'], toLabel: (a) => (s(a.thread) ? `Board · ${a.thread as string}` : 'Board'), detail: (a) => s(a.text) },
  task_create: {
    kind: 'task',
    toFromResult: ['id', 'task_id', 'taskId'],
    toLabel: () => 'New task',
    title: (a) => s(a.title),
    detail: (a) => first(a, ['start_message', 'message', 'description']),
  },
  task_start: START,
  session_start: START,
  task_transfer: { ...START, toFromResult: ['id', 'task_id', 'taskId', 'newTaskId'] },
  task_move: START,
  task_switch_engine: { ...START, detail: (a) => s(a.text) },
}

/**
 * Ops with a message-like argument that are not words to anyone, and why. A card
 * would claim a conversation that did not happen.
 */
export const NOT_CARDED: Record<string, string> = {
  task_update: 'edits a task field; its description is no message',
  agent_skill_write: 'the session writes its own skill',
  triage_rule_set: 'saves a routing rule; its note is the rule\'s own',
  router_context: 'reads routing context; its message names the item to read',
  router_item: 'reads one routed item',
  router_work: 'the receiver records its own note on the work',
  task_note_write: 'the session writes its own task note',
  agent_memory_write: 'the session writes its own memory',
  memory_write: 'writes memory, not to anyone',
  note_write: 'writes a note file',
  task_not_done_settle: 'bookkeeping on a result',
  board_remind: 'sets a reminder clock',
  hint_set: 'configuration',
  api: 'a raw HTTP call',
  host_http: 'a raw HTTP call to a host service',
  browser: 'types into a web page',
  thread_split: 'moves a message between threads',
  trigger_create: 'a watch script, not a message',
}

/** Message-like argument names: an op taking one is carded or listed in NOT_CARDED. */
export const MESSAGE_ARG_KEYS = ['text', 'markdown', 'reply', 'content', 'message', 'note', 'body', 'start_message', 'description']

export function isCardedOp(op: string): boolean {
  return Object.prototype.hasOwnProperty.call(OP_CARDS, op)
}

/** How long each field may be when recorded or shown folded. */
export const OP_CARD_TITLE_MAX = 160
export const OP_CARD_SUMMARY_MAX = 280
export const OP_CARD_DETAIL_MAX = 20_000

function clip(text: string, max: number): string {
  const points = [...text]
  return points.length > max ? `${points.slice(0, max - 1).join('').trimEnd()}…` : text
}

/** Markdown that would print as noise in a one-line title or summary. */
function plain(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*(```|~~~|\|)/.test(l))
    .map((l) => (/^\s{0,3}#{1,6}\s+\S/.test(l) && !/[.:!?]\s*$/.test(l) ? `${l.trim()}:` : l)
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|`)/g, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The first sentence of `text`, and what follows it. */
function splitFirstSentence(line: string): [string, string] {
  const stop = /[.!?](?=\s|$)|[。！？]/g
  for (let m = stop.exec(line); m; m = stop.exec(line)) {
    if (m.index >= 16) return [line.slice(0, m.index + 1), line.slice(m.index + 1).trim()]
  }
  return [line, '']
}

function refsOf(v: unknown): string[] {
  if (typeof v === 'string' && v.trim()) return [v.trim()]
  if (Array.isArray(v)) return v.flatMap(refsOf)
  return []
}

function resultRefs(result: unknown, keys: string[]): string[] {
  if (!result || typeof result !== 'object') return []
  const r = result as Args
  for (const k of keys) {
    const v = s(r[k])
    if (v) return [v]
  }
  for (const k of ['task', 'target']) {
    const o = r[k] && typeof r[k] === 'object' ? r[k] as Args : undefined
    const id = o ? s(o.id) ?? s(o.taskId) : undefined
    if (id) return [id]
  }
  return []
}

/**
 * The card of one call of `op` with `args` (and its `result`, when known), or
 * null for an op no card covers. Never throws.
 */
export function opCardFields(op: string, args: Args | undefined, result?: unknown): OpCardFields | null {
  const spec = OP_CARDS[op]
  if (!spec) return null
  const a: Args = args && typeof args === 'object' ? args : {}
  try {
    const kind = typeof spec.kind === 'function' ? spec.kind(a) : spec.kind
    const to = [
      ...(spec.to ?? []).flatMap((k) => refsOf(a[k])),
      ...(spec.toFromResult ? resultRefs(result, spec.toFromResult) : []),
    ]
    const detailRaw = spec.detail(a)
    const detail = detailRaw ? clip(detailRaw, OP_CARD_DETAIL_MAX) : undefined
    const given = spec.title?.(a)
    const words = detail ? plain(spec.summary?.(a) ?? detail) : ''
    let title: string | undefined
    let summary: string | undefined
    if (given) {
      title = clip(given.replace(/\s+/g, ' ').trim(), OP_CARD_TITLE_MAX)
      summary = words || undefined
    } else if (words) {
      const [head, rest] = splitFirstSentence(words)
      title = clip(head, OP_CARD_TITLE_MAX)
      summary = rest || undefined
    }
    const toLabel = spec.toLabel?.(a)
    return {
      op,
      kind,
      to: [...new Set(to)],
      ...(toLabel ? { toLabel } : {}),
      ...(title ? { title } : {}),
      ...(summary ? { summary: clip(summary, OP_CARD_SUMMARY_MAX) } : {}),
      ...(detail ? { detail } : {}),
    }
  } catch {
    return { op, kind: 'send', to: [] }
  }
}
