/**
 * Words for the user that name a code review, ticket, pull request or commit with no link to open it
 * get one note back to the writer (src/lib/missing-links.ts; 2026-11-20, the user: every thread,
 * letter and question carries what he needs, "like link i cna just lcick"). The examples are written
 * the way agents write to him: linked, not linked, and only Walnut's own ids (which must stay quiet).
 * The class guard: every op that hands the user words is checked or says why not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { guardedPath } from '../setup/exec-guard.js'
import {
  LINK_NOTE_EXEMPT, LINK_NOTE_OPS, askUserQuestionText, findMissingLinks, opMissingLinksNote,
} from '../../src/lib/missing-links.js'
import { ASK_LINKS_HOOK_COMMAND, askLinksHooks } from '../../src/providers/ask-links-hook.js'
import { sessionSettingsHooks } from '../../src/providers/session-settings-hooks.js'
import { definePluginOp, getOp, listOps, removePluginOps } from '../../src/ops/registry.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'

const refs = (text: string) => findMissingLinks(text).map((m) => `${m.kind}:${m.ref}`)

// Test data in the words agents write to the user: "ticket", "commit", "is live", "please review".
const TICKET = '\u5de5\u5355'
const COMMIT = '\u63d0\u4ea4'
const LANDED = '\u5df2\u4e0a\u7ebf'
const REVIEW = '\u8bf7\u4f60 review'

describe('ids named with a link the user can click stay quiet', () => {
  it.each([
    ['the review URL in the same text', `CR-245678901 ${REVIEW}: https://code.example.com/reviews/CR-245678901`],
    ['a Markdown link whose text is the id', `${REVIEW} [CR-245678901](https://code.example.com/reviews/CR-245678901/revisions/2)`],
    ['a Markdown link whose URL does not carry the id', '[CR-245678901](https://short.example/abc) is ready'],
    ['an HTML link (a letter body)', '<p>Merged <a href="https://github.com/acme/app/pull/4821">PR #4821</a>.</p>'],
    ['the URL right after the id', 'CR-245678901 (https://short.example/x) is ready'],
    ['the URL right before the id', 'See https://short.example/x (PR 12)'],
    ['the URL after a bold id', '**CR-1234567**: https://short.example/x'],
    ['a links section further down', `${TICKET} V1234567890 is updated.\n\nLinks:\n- https://tickets.example.com/V1234567890`],
    ['a pull request URL', 'PR #4821 merged: https://github.com/acme/app/pull/4821'],
    ['a commit URL with the full hash', `${COMMIT} 0e72622de ${LANDED}: https://github.com/acme/app/commit/0e72622de1f3a9c0b6d8e2f4a1b3c5d7e9f0a2b4`],
  ])('%s', (_name, text) => {
    expect(refs(text)).toEqual([])
  })
})

describe('ids named with no link are found, each once', () => {
  it.each([
    ['a code review', `CR-245678901 ${REVIEW}`, ['code review:CR-245678901']],
    ['a ticket', `${TICKET} V1234567890 is updated`, ['ticket:V1234567890']],
    ['a pull request, several spellings', 'PR #4821 and PR 77 and pull request #9', ['pull request:PR #4821', 'pull request:PR 77', 'pull request:pull request #9']],
    ['owner/repo#n', 'Fixed in acme/app#77', ['pull request:acme/app#77']],
    ['a commit glued to CJK text', `${COMMIT}0e72622de${LANDED}`, ['commit:0e72622de']],
    ['a full 40-character hash', 'fixed in 0e72622de1f3a9c0b6d8e2f4a1b3c5d7e9f0a2b4', ['commit:0e72622de1f3a9c0b6d8e2f4a1b3c5d7e9f0a2b4']],
    ['a short hash after "commit"', 'commit 0e72622de is on main; landed as 9815ea32a', ['commit:0e72622de', 'commit:9815ea32a']],
    ['the same id twice', 'CR-1234567 is up. CR-1234567 needs your yes.', ['code review:CR-1234567']],
    ['a URL for one id does not cover another', 'CR-1111111 is done (https://code.example.com/reviews/CR-1111111/x); CR-2222222 needs your yes.', ['code review:CR-2222222']],
    ['a pull request URL of another number', 'PR #12 is ready: https://github.com/acme/app/pull/13 is the old one, see above', ['pull request:PR #12']],
  ])('%s', (_name, text, want) => {
    expect(refs(text)).toEqual(want)
  })
})

describe('Walnut\'s own ids and other hex stay quiet', () => {
  it.each([
    ['a task id (UUID)', 'Task a9b9810d-2559-52fd-a831-c6f3a7501848 is done'],
    ['a session id', 'session 3ccf06d9-dbdd-49a1-ab98-1537944f64d4'],
    ['a short task id', 'task mvm0n3bu-6910 and 30479356'],
    ['letter, thread and request ids', 'lt-3f9a2c1b7d, th-7d64a96ae6ff, rq-7d64a96ae6ff, tm-0e72622de1'],
    ['a temp path and a file name', 'screenshot /tmp/x/0e72622de.png and build-0e72622de.log'],
    ['a sha256 sum', 'sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
    ['a 32-hex id', 'request 0e72622de1f3a9c0b6d8e2f4a1b3c5d7'],
    ['a colour', 'color: #a1b2c3d4'],
    ['a plain number and a hex word', 'took 1234567 ms; deadbeef'],
    ['a fenced log', 'See the log:\n```\n0e72622de fix(x): y\nCR-1234567\n```'],
    ['ids inside a URL only', 'https://code.example.com/reviews/CR-245678901 and https://github.com/acme/app/commit/0e72622de'],
    ['HTML attributes', '<span style="color:#a1b2c3d" data-id="0e72622de">ok</span>'],
    ['words like UTF-8 and ISO-8601', 'UTF-8, ISO-8601, GPT-6'],
    ['uppercase codes', 'error E0000001, part A1234567'],
    ['a short task or session id', 'task a9b9810d is done; session 3ccf06d9 runs; container 4f2a9c1b3d5e'],
    ['a list after "pull request"', 'Open the pull request\n1. Fix x'],
    ['"PR" and one digit of something else', 'the PR 2 days ago'],
    ['a file anchor', 'see docs/guide.md#3 and src/x.ts#12'],
  ])('%s', (_name, text) => {
    expect(refs(text)).toEqual([])
  })
})

describe('a long text', () => {
  it('stays fast: thousands of URLs, tags and hashes', () => {
    const line = (i: number) => `<li><a href="https://github.com/acme/app/commit/${(0xabc0000 + i).toString(16)}f">x</a> commit ${(0xabc0000 + i).toString(16)} CR-${1000000 + i} https://code.example.com/reviews/CR-${1000000 + i}</li>`
    const html = Array.from({ length: 3000 }, (_, i) => line(i)).join('\n')
    const t0 = performance.now()
    expect(findMissingLinks(html)).toEqual([])
    expect(performance.now() - t0).toBeLessThan(1500)
    // Past the scan limit nothing is read.
    expect(findMissingLinks(' '.repeat(250_000) + 'CR-1234567')).toEqual([])
  })
})

describe('the note', () => {
  it('names what is missing, what to add and how to fix it', () => {
    const note = opMissingLinksNote('thread_update', { id: 'th-1234567', reply: `CR-245678901 ${REVIEW}; ${COMMIT} 0e72622de` })!
    expect(note).toMatch(/^Walnut note: Your thread summary \(thread_update reply\) names CR-245678901 \(code review\), 0e72622de \(commit\) for the user with no link to open it\./)
    expect(note).toContain('full https:// URL')
    expect(note).toContain('thread_update with reply')
    expect(opMissingLinksNote('thread_update', { id: 'th-1234567', reply: 'All done: https://code.example.com/reviews/CR-245678901 (CR-245678901)' })).toBeNull()
  })

  it('reads only the fields the user reads', () => {
    // The thread id and the user's own quoted words are not the writer's words for him.
    expect(opMissingLinksNote('thread_update', { id: 'th-0e72622de', close: 'acked', user_words: 'CR-1234567 is fine' })).toBeNull()
    expect(opMissingLinksNote('task_report_set', { id: 't', report: { state: 'needs', ask: 'Approve CR-1234567?', ask_more: 'It is small.' } })).toContain('task_report_set')
    expect(opMissingLinksNote('human_inbox_send', { subject: 'Review', type: 'action_required', markdown: 'ok', actions: [{ label: 'Approve PR #12' }] })).toContain('PR #12')
    expect(opMissingLinksNote('task_send', { to: 't', text: 'landed 0e72622de' })).toBeNull()
  })

  it('reads an AskUserQuestion call\'s questions, headers and options', () => {
    const text = askUserQuestionText({ questions: [{ question: 'Ship it?', header: 'CR-1234567', options: [{ label: 'Yes', description: 'merges PR #12' }] }] })
    expect(refs(text)).toEqual(['code review:CR-1234567', 'pull request:PR #12'])
  })
})

describe('every op that hands the user words is checked or says why not (guard)', () => {
  beforeAll(async () => { await import('../../src/ops/index.js') })

  it('lists each such op, a new one included', () => {
    const handsUser = listOps().filter((op) => !op.tags.readonly && (
      /^(human_inbox|thread|brief)_/.test(op.name)
      || Object.keys(op.input ?? {}).some((k) => k === 'user_kind' || k === 'report')
    )).map((op) => op.name)
    expect(handsUser.filter((n) => !LINK_NOTE_OPS[n] && !LINK_NOTE_EXEMPT[n])).toEqual([])
    expect([...Object.keys(LINK_NOTE_OPS), ...Object.keys(LINK_NOTE_EXEMPT)].filter((n) => !handsUser.includes(n))).toEqual([])
  })

  it('every field it reads is one the op takes', () => {
    for (const [name, spec] of Object.entries(LINK_NOTE_OPS)) {
      const input = getOp(name)!.input as Record<string, unknown>
      for (const f of spec.fields) expect(Object.keys(input), `${name}.${f}`).toContain(f.split('.')[0])
    }
  })
})

describe('the executor adds the note to a session\'s op result', () => {
  const saved = { td: process.env.WALNUT_TASK_DIR, off: process.env.WALNUT_LINK_NOTE }
  const ops = LINK_NOTE_OPS as Record<string, (typeof LINK_NOTE_OPS)[string]>
  beforeAll(() => {
    definePluginOp('link-note-test', {
      name: 'link_note_test_reply', title: 'echo', description: 'Takes a reply (test only).',
      input: { reply: z.string().optional() },
      handler: async () => ({ ok: true }),
      tags: { readonly: true },
    })
    ops.link_note_test_reply = { fields: ['reply'], what: 'Your test reply', fix: 'Fix it.' }
  })
  afterAll(() => {
    removePluginOps('link-note-test')
    delete ops.link_note_test_reply
    for (const [k, v] of [['WALNUT_TASK_DIR', saved.td], ['WALNUT_LINK_NOTE', saved.off]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  })

  it('for a session; never for a person, never when turned off', async () => {
    process.env.WALNUT_TASK_DIR = os.tmpdir()
    delete process.env.WALNUT_LINK_NOTE
    const r = await executeOp('link_note_test_reply', { reply: 'CR-245678901 is up' }, { origin: LOCAL_ORIGIN })
    expect((r as { result: { walnut_note?: string } }).result.walnut_note).toMatch(/^Walnut note: Your test reply names CR-245678901/)
    const linked = await executeOp('link_note_test_reply', { reply: '[CR-245678901](https://code.example.com/reviews/CR-245678901)' }, { origin: LOCAL_ORIGIN })
    expect((linked as { result: Record<string, unknown> }).result.walnut_note).toBeUndefined()
    const person = await executeOp('link_note_test_reply', { reply: 'CR-245678901 is up' }, { origin: LOCAL_ORIGIN, callerMode: 'human' })
    expect((person as { result: Record<string, unknown> }).result.walnut_note).toBeUndefined()
    process.env.WALNUT_LINK_NOTE = '0'
    const off = await executeOp('link_note_test_reply', { reply: 'CR-245678901 is up' }, { origin: LOCAL_ORIGIN })
    expect((off as { result: Record<string, unknown> }).result.walnut_note).toBeUndefined()
  })
})

describe('the AskUserQuestion hook', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-links-'))
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  /** Runs the hook with a `walnut` that keeps the stdin it got and answers as link_check would. */
  function hook(toolInput: unknown, env: Record<string, string> = {}, answer = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"n"}}'): { out: string; stdin: string } {
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
    const got = path.join(root, 'stdin.json')
    fs.rmSync(got, { force: true })
    fs.writeFileSync(path.join(root, 'bin', 'walnut'), `#!/bin/sh\ncat > '${got}'\nprintf '%s\\n' '${answer}'\n`, { mode: 0o755 })
    const input = JSON.stringify({ session_id: '3ccf06d9-dbdd-49a1-ab98-1537944f64d4', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: toolInput })
    const r = spawnSync('/bin/sh', ['-c', ASK_LINKS_HOOK_COMMAND], {
      input, encoding: 'utf8', env: { PATH: guardedPath([], `${path.join(root, 'bin')}:/usr/bin:/bin`), HOME: root, ...env },
    })
    expect(r.status, r.stderr).toBe(0)
    return { out: r.stdout.trim(), stdin: fs.existsSync(got) ? fs.readFileSync(got, 'utf8') : '' }
  }

  it('pipes its input to link_check as hook_input and prints only a hook answer', async () => {
    const q = { questions: [{ question: 'Approve CR-1234567?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }] }] }
    const r = hook(q)
    expect(JSON.parse(r.out).hookSpecificOutput.hookEventName).toBe('PreToolUse')
    const args = JSON.parse(r.stdin) as { hook_input: Record<string, unknown> }
    expect(args.hook_input.tool_input).toEqual(q)
    // The op answers the hook's shape from that input, and nothing for a linked question.
    await import('../../src/ops/index.js')
    const check = getOp('link_check')!.handler!
    const answer = await check(args, async () => ({})) as { hookSpecificOutput?: { additionalContext?: string } }
    expect(answer.hookSpecificOutput?.additionalContext).toMatch(/^Walnut note: Your question to the user \(AskUserQuestion\) names CR-1234567/)
    const linked = { ...args, hook_input: { ...args.hook_input, tool_input: { questions: [{ question: 'Approve [CR-1234567](https://code.example.com/reviews/CR-1234567)?' }] } } }
    expect(await check(linked, async () => ({}))).toEqual({})
  })

  it('prints nothing when link_check has no note, stays quiet when turned off, never decides the permission', () => {
    expect(hook({ questions: [{ question: 'Ship it?' }] }, {}, '{}').out).toBe('')
    expect(hook({ questions: [{ question: 'CR-1234567?' }] }, { WALNUT_LINK_NOTE: '0' })).toEqual({ out: '', stdin: '' })
    expect(ASK_LINKS_HOOK_COMMAND).not.toMatch(/permissionDecision/)
  })

  it('rides every session\'s hooks unless turned off', () => {
    const groups = (sessionSettingsHooks({}) as { PreToolUse: Array<{ matcher?: string }> }).PreToolUse
    expect(groups.some((g) => g.matcher === 'AskUserQuestion')).toBe(true)
    expect(askLinksHooks({ WALNUT_LINK_NOTE: '0' })).toBeNull()
  })
})
