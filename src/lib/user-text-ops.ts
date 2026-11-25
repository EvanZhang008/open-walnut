/**
 * Where a session's op hands the user words to read: one list, read by every check of such words.
 *  - the send gate (src/ops/reply-language-gate.ts): words in another language than his Reply language
 *    setting are not sent (every entry);
 *  - the link note (src/lib/missing-links.ts): a code review, ticket or pull request named with no link
 *    to open it (entries with `links`).
 *
 * `fields` are paths into the op's arguments (`report.ask`, `actions.label`; an array is walked).
 * `others` names the op's other prose arguments and why the user does not read them as the session's
 * words (his own quoted words, a reason for Walnut). The class guard
 * (tests/lib/user-text-ops.test.ts) fails when an op that takes prose is in neither list, or a prose
 * argument of a listed op is in neither `fields` nor `others`.
 */

export interface UserTextSpec {
  /** The arguments the user reads, as paths. */
  fields: readonly string[]
  /** What the words are, for the session reading a note or a refusal: "Your letter (human_inbox_send)". */
  what: string
  /** Prose arguments the user does not read as the session's words, with why. */
  others?: Readonly<Record<string, string>>
  /** The link note's fix, when ids with no link are noted for this op (missing-links.ts). */
  links?: string
}

const HIS_WORDS = 'the user\'s own words, quoted as he wrote them'
const FOR_WALNUT = 'a reason Walnut checks or logs, not a message to the user'
/** user_kind_why: Walnut judges it (org/user-kind.ts) and never shows it: a letter drops it (user-kind-letter.ts), no card reads it. */
const KIND_WHY = 'why the ask is one of his kinds: Walnut checks it and never shows it to him'
const REPORT = ['report.ask', 'report.ask_more', 'report.next', 'report.waiting_on', 'report.ask_new', 'report.ask_options.label', 'report.ask_options.detail']
const REPORT_OTHERS = {
  'report.user_kind_words': HIS_WORDS, 'report.user_words': HIS_WORDS, 'report.user_kind_why': KIND_WHY,
  'report.design_review': 'the path of a design review and its scores', 'report.same_as': 'the id of an earlier ask',
} as const

export const USER_TEXT_OPS: Record<string, UserTextSpec> = {
  task_send: {
    fields: ['title', 'text', 'result'], what: 'Your message (task_send)',
    others: { user_words: HIS_WORDS, reason: FOR_WALNUT },
  },
  org_send: { fields: ['title', 'text'], what: 'Your message (org_send)' },
  task_create: {
    fields: ['message', 'start_message'], what: 'Your first message to the new task (task_create)',
    others: {
      title: 'a task title: it may sync to an outside tracker other people read',
      description: 'a task description: it may sync to an outside tracker other people read',
      user_request: HIS_WORDS, user_words: HIS_WORDS, project_reason: FOR_WALNUT, new_reason: FOR_WALNUT,
    },
  },
  task_start: { fields: ['message'], what: 'Your message to the task you start (task_start)', others: { user_request: HIS_WORDS } },
  task_transfer: { fields: ['message'], what: 'Your message to the moved task (task_transfer)' },
  task_move: { fields: ['text'], what: 'Your message to the moved task (task_move)', others: { user_request: HIS_WORDS, reason: FOR_WALNUT } },
  task_switch_engine: { fields: ['text'], what: 'Your message to the task on its new engine (task_switch_engine)', others: { reason: FOR_WALNUT } },
  task_complete: { fields: ['result'], what: 'Your result (task_complete)', others: { user_words: HIS_WORDS, reason: FOR_WALNUT } },
  thread_update: {
    fields: ['reply', 'title', 'ask', 'since_you_wrote', 'options.label', 'options.detail'],
    what: 'Your thread (thread_update)',
    others: { user_words: HIS_WORDS, user_kind_words: HIS_WORDS, user_kind_why: KIND_WHY, design_review: 'the path of a design review and its scores', same_ask_reason: FOR_WALNUT, separate_reason: FOR_WALNUT, place_why: FOR_WALNUT },
    links: 'Write the summary again with the links (thread_update with reply).',
  },
  thread_create: {
    fields: ['text', 'title', 'reply', 'options.label', 'options.detail'],
    what: 'Your new thread (thread_create)',
    others: { user_kind_words: HIS_WORDS, user_kind_why: KIND_WHY, design_review: 'the path of a design review and its scores', same_ask_reason: FOR_WALNUT, separate_reason: FOR_WALNUT },
    links: 'Put the links in the thread\'s summary (thread_update with reply).',
  },
  human_inbox_send: {
    fields: ['subject', 'markdown', 'html', 'text', 'actions.label', 'actions.description'],
    what: 'Your letter (human_inbox_send)',
    others: {
      'items.subject': 'a mail item: the words of the mail it carries', 'items.summary': 'a mail item: the words of the mail it carries',
      'items.actions.label': 'a mail item\'s action', 'items.actions.question': 'a mail item\'s action',
      'items.source.message': 'a mail item: the id of the mail it carries',
      user_kind_words: HIS_WORDS, user_kind_why: KIND_WHY, design_review: 'the path of a design review and its scores',
      snooze_reason: FOR_WALNUT, resend_reason: FOR_WALNUT, same_ask_reason: FOR_WALNUT,
    },
    links: 'Do not send the letter again: reply to it with the links (human_inbox_reply with its letter id).',
  },
  human_inbox_reply: {
    fields: ['markdown', 'html', 'text'], what: 'Your reply in the letter (human_inbox_reply)',
    others: {
      'items.subject': 'a mail item: the words of the mail it carries', 'items.summary': 'a mail item: the words of the mail it carries',
      'items.actions.label': 'a mail item\'s action', 'items.actions.question': 'a mail item\'s action', 'items.source.message': 'a mail item: the id of the mail it carries',
    },
    links: 'Reply once more with the links (human_inbox_reply).',
  },
  task_report_set: {
    fields: REPORT, what: 'Your task report (task_report_set)', others: REPORT_OTHERS,
    links: 'Set the report again with the links (task_report_set; a Needs you ask carries them in ask_more).',
  },
  task_update: {
    fields: REPORT, what: 'Your task report (task_update report)',
    others: {
      ...REPORT_OTHERS, title: 'a task title: it may sync to an outside tracker other people read',
      description: 'a task description: it may sync to an outside tracker other people read',
      user_words: HIS_WORDS, reason: FOR_WALNUT, waiting_on: 'who or what the task waits on: a name or an id',
    },
    links: 'Set the report again with the links (task_report_set; a Needs you ask carries them in ask_more).',
  },
  brief_write: {
    fields: ['content', 'edits.new'], what: 'Your Brief (brief_write)',
    links: 'Write the Brief again with the links (brief_write).',
  },
  board_post: { fields: ['text'], what: 'Your Board post (board_post)' },
  board_set: { fields: ['html'], what: 'Your Board page (board_set)', others: { same_ask_reason: FOR_WALNUT } },
  board_edit: { fields: ['edits.new'], what: 'Your Board edit (board_edit)', others: { same_ask_reason: FOR_WALNUT } },
  board_project_set: { fields: ['title', 'summary', 'latest', 'next'], what: 'Your Board section (board_project_set)' },
  board_card_set: { fields: ['summary'], what: 'Your Board card (board_card_set)', others: { waiting_on: 'who or what the card waits on: a name or an id' } },
  board_remind: { fields: ['note'], what: 'Your Board reminder (board_remind)' },
  task_not_done_settle: { fields: ['note'], what: 'Your note on what a task left not done (task_not_done_settle)' },
  router_route: {
    fields: ['text', 'ask', 'options.label', 'options.description'], what: 'Your brief or question (router_route)',
    others: { 'source.message': 'the id of the mail or message it routes', reason: FOR_WALNUT },
  },
  approval_request: {
    fields: ['what', 'why'], what: 'Your approval request (approval_request)',
    others: { detail: 'what is to be approved, as it will go out (a command, a message for someone else)' },
  },
}

/** Ops that take prose the user does not read as a session's words to him, with why (the class guard reads this list). */
export const USER_TEXT_EXEMPT: Readonly<Record<string, string>> = {
  human_inbox_mark: 'read, pin and archive flags only',
  human_inbox_answer: 'records the user\'s own answer, in his words',
  thread_file: 'files the user\'s own words under a thread',
  thread_split: 'moves the user\'s own message to a thread of its own',
  thread_move: 'hands a thread to another node; its why goes to that node',
  thread_audit: 'reads the thread check\'s counts or runs one check: a node id and numbers, no prose',
  task_ask_answer_withdraw: 'names the answer taken back and why, for the task that asked',
  task_sync_to_project: 'carries the user\'s own words only',
  project_create: 'a project\'s name and where it comes from',
  folder_create: 'a folder\'s name',
  places_label_set: 'a place\'s name',
  task_update_bulk: 'task titles and descriptions: they may sync to an outside tracker other people read',
  memory_write: 'a memory file: a document keeps the language it is written in',
  note_write: 'a note in the user\'s notes: a document keeps the language it is written in',
  locked_note_save: 'a locked note\'s text, written back by an agent the user approved: a document keeps the language it is written in',
  task_note_write: 'a task\'s working note, which its sessions write for themselves and the next session',
  agent_skill_write: 'a skill an agent reads',
  agent_memory_write: 'an agent\'s own memory folder',
  org_node_create: 'an org node\'s instructions: its agent reads them',
  org_node_edit: 'an org node\'s instructions: its agent reads them',
  topic_create: 'a topic may hold people outside, by email: its posts are words for them too',
  topic_post: 'a topic may hold people outside, by email: its posts are words for them too',
  triage_rule_set: 'a routing rule\'s note: the triage agent reads it',
  triage_route: 'routes an incoming item: its text is the item\'s own words',
  trigger_create: 'a watch\'s prompt goes into a session, its name and description are labels',
  trigger_update: 'a watch\'s prompt goes into a session, its name and description are labels',
  approval_consume: 'what was approved, as it goes out',
  browser: 'types into a web page: words for that site and the people on it',
  subagent_run: 'a prompt an agent reads',
  subagent_send: 'a message an agent reads',
  hint_set: 'a hint that rides messages to sessions',
}

/** Every string at `path` inside `v`, into `out` (an array is walked item by item). */
export function at(v: unknown, path: readonly string[], out: string[]): void {
  if (Array.isArray(v)) { for (const x of v) at(x, path, out); return }
  if (!path.length) { if (typeof v === 'string') out.push(v); return }
  if (v && typeof v === 'object') at((v as Record<string, unknown>)[path[0]], path.slice(1), out)
}

/**
 * The words of a listed op's arguments the user reads, with its spec; null for any other op.
 * `text` joins them all; `byField` keeps each field's words apart (an array's items joined), so a
 * check can judge a body on its own and not let a title carry it.
 */
export function opUserText(op: string, args: unknown): { text: string; byField: Array<{ field: string; text: string }>; spec: UserTextSpec } | null {
  const spec = USER_TEXT_OPS[op]
  if (!spec || !args || typeof args !== 'object') return null
  const byField: Array<{ field: string; text: string }> = []
  for (const f of spec.fields) {
    const parts: string[] = []
    at(args, f.split('.'), parts)
    if (parts.length) byField.push({ field: f, text: parts.join('\n\n') })
  }
  return { text: byField.map((b) => b.text).join('\n\n'), byField, spec }
}
