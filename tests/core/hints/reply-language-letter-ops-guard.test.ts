/**
 * The class guard for letters off the reply language (src/core/hints/reply-language-drift.ts):
 * every op through which a session writes words the user reads as a letter is judged, or says why
 * not. 2026-11-14: a router's for_user letters went out in English ("Recruiter replied to the
 * person's own question ..."), a path the session-letter check had not named. A new op that
 * writes to the inbox, or takes a for_user brief, fails here until it is listed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listOps } from '../../../src/ops/index.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')

/** Each judged op, and the route file whose handler adds the note. */
const JUDGED: Record<string, string> = {
  human_inbox_send: 'src/web/routes/human-inbox-v1.ts',
  human_inbox_reply: 'src/web/routes/human-inbox-v1.ts',
  router_route: 'src/web/routes/router-v1.ts',
  thread_create: 'src/web/routes/org-threads-v1.ts',
  thread_update: 'src/web/routes/org-threads-v1.ts',
  brief_write: 'src/web/routes/brief-v1.ts',
}
/** Ops that reach the inbox but carry no words of a session's own to the user, with why. */
const EXEMPT: Record<string, string> = {
  human_inbox_mark: 'read, pin and archive flags only',
  human_inbox_answer: 'the user\'s own answer, quoted in his words (user_words), not a letter to him',
  thread_file: 'files the user\'s own words under a thread',
  thread_split: 'moves the user\'s own message to a thread of its own',
  thread_move: 'hands a thread to another node; its why goes to that node',
}

describe('every op a session writes the user a letter through is judged for the reply language', () => {
  const writes = listOps().filter((op) => !op.tags.readonly && (
    /^(human_inbox|thread|brief)_/.test(op.name) || op.bind?.path?.startsWith('/human-inbox') || Object.keys(op.input ?? {}).includes('for_user')
  )).map((op) => op.name)

  it('lists each such op as judged or exempt', () => {
    expect(writes.filter((n) => !JUDGED[n] && !EXEMPT[n])).toEqual([])
    expect([...Object.keys(JUDGED), ...Object.keys(EXEMPT)].filter((n) => !writes.includes(n))).toEqual([])
  })

  it('the route of each judged op adds the note', () => {
    for (const file of new Set(Object.values(JUDGED))) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
      expect(src, file).toMatch(/letterLanguageNote|languageNoteOf/)
    }
    const inbox = fs.readFileSync(path.join(ROOT, 'src/web/routes/human-inbox-v1.ts'), 'utf8')
    expect(inbox.match(/await languageNoteOf\(/g)?.length, 'send and reply').toBe(2)
  })
})
