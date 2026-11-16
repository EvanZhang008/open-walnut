/**
 * The class guard for words a session sends off the reply language (src/core/hints/reply-language-drift.ts):
 * every op through which a session writes words the user reads (a letter, a thread post, a Brief, a
 * Board post, a message to another task) is judged, or says why not.
 *   - 2026-11-14: a router's for_user letters went out in English ("Recruiter replied to the person's
 *     own question ..."), a path the session-letter check had not named.
 *   - 2026-11-16: 87 of 114 overnight peer notes and replies (task_send, org_send) were English, and
 *     each receiver answered on in English; no send to another task was judged at all.
 * A new op that writes to the inbox, takes a for_user brief, or carries a text, a message, a note or
 * a prompt fails here until it is listed: judged (its route adds the note, its answer shows it) or
 * exempt with why.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getOp, listOps } from '../../../src/ops/index.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')

/** Each judged op, and the route file whose handler adds the note. */
const JUDGED: Record<string, string> = {
  human_inbox_send: 'src/web/routes/human-inbox-v1.ts',
  human_inbox_reply: 'src/web/routes/human-inbox-v1.ts',
  router_route: 'src/web/routes/router-v1.ts',
  thread_create: 'src/web/routes/org-threads-v1.ts',
  thread_update: 'src/web/routes/org-threads-v1.ts',
  brief_write: 'src/web/routes/brief-v1.ts',
  board_post: 'src/web/routes/board-v1.ts',
  // Messages to another task: a send, a reply (in_reply_to), and a start's own message.
  // (session_send and session_start, the deprecated names, are the same ops: listOps leaves them out.)
  task_send: 'src/web/routes/messages-v1.ts',
  org_send: 'src/web/routes/messages-v1.ts',
  task_start: 'src/web/routes/task-v1.ts',
  task_create: 'src/web/routes/task-v1.ts',
}
/** Ops that carry words but no session's own message to the user or another task, with why. */
const EXEMPT: Record<string, string> = {
  human_inbox_mark: 'read, pin and archive flags only',
  human_inbox_answer: 'the user\'s own answer, quoted in his words (user_words), not a letter to him',
  thread_file: 'files the user\'s own words under a thread',
  thread_split: 'moves the user\'s own message to a thread of its own',
  thread_move: 'hands a thread to another node; its why goes to that node',
  task_not_done_settle: 'a short record on the task of where its not-done items went',
  board_remind: 'a few words naming what to raise; Walnut words the reminder itself',
  api: 'the raw call of a route: the route it reaches judges what it carries',
  triage_rule_set: 'a routing rule\'s note for Inbox Triage, a setting',
  triage_route: 'passes an outside item (a mail, a Slack message) on to its task as it came',
  trigger_create: 'the session\'s own prompt, delivered back to itself when its check fires',
  trigger_update: 'the session\'s own prompt, delivered back to itself when its check fires',
  task_transfer: 'the carry-on line the task\'s own new session starts with',
  task_move: 'the carry-on line the task\'s own new session starts with',
  task_switch_engine: 'the carry-on line the task\'s own new session starts with',
  host_http: 'bytes for a web service on a host',
  browser: 'text typed into a web page',
  subagent_run: 'a prompt for a subagent engine run, which answers its caller',
  subagent_send: 'a prompt for a subagent engine run, which answers its caller',
  hint_set: 'a hint\'s own text, a setting',
}

/** The input fields that carry a session's words. */
const WORDS = ['text', 'message', 'start_message', 'note', 'prompt', 'body']

describe('every op a session sends words the user reads through is judged for the reply language', () => {
  const writes = listOps().filter((op) => !op.tags.readonly && (
    /^(human_inbox|thread|brief)_/.test(op.name) || op.bind?.path?.startsWith('/human-inbox')
    || Object.keys(op.input ?? {}).some((k) => k === 'for_user' || WORDS.includes(k))
  )).map((op) => op.name)

  it('lists each such op as judged or exempt', () => {
    expect(writes.filter((n) => !JUDGED[n] && !EXEMPT[n])).toEqual([])
    expect([...Object.keys(JUDGED), ...Object.keys(EXEMPT)].filter((n) => !writes.includes(n))).toEqual([])
  })

  it('the route of each judged op adds the note', () => {
    for (const file of new Set(Object.values(JUDGED))) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
      expect(src, file).toMatch(/letterLanguageNote|languageNoteOf|messageLanguageNote|startLanguageNote/)
    }
    const inbox = fs.readFileSync(path.join(ROOT, 'src/web/routes/human-inbox-v1.ts'), 'utf8')
    expect(inbox.match(/await languageNoteOf\(/g)?.length, 'send and reply').toBe(2)
  })

  // The note reaches the sender only when the op's answer shows it: an op that rebuilds its answer
  // from the body's fields (a mapResult, a handler) must carry `reply_language` on.
  const NOTE = 'Reply language: this message to another task is not in the user\'s language. <rule>'
  const answer: Record<string, unknown> = {
    reply_language: NOTE, taskId: 't-1', started: true, messageId: 'qm-1', delivery: 'queued',
    task: { id: 't-1', title: 'A teammate' }, message: { id: 'bm-1' }, started_at: 'now',
  }
  const call = async () => answer

  it.each(['task_send', 'session_send', 'org_send', 'task_start', 'session_start', 'task_create', 'board_post'])('%s shows the note in its answer', async (name) => {
    const op = getOp(name)!
    const args: Record<string, unknown> = name === 'board_post' ? { task: 't-1', thread: 'th-1', text: 'x' }
      : name.endsWith('_send') ? { to: 't-1', text: 'x' } : name === 'task_create' ? { title: 'A teammate', message: 'x' } : { id: 't-1', task: 't-1', message: 'x' }
    const out = op.mapResult
      ? op.mapResult({ body: answer, args } as never)
      : await op.handler!(args as never, call as never)
    expect(String((out as { next?: unknown }).next), name).toContain(NOTE)
  })
})
