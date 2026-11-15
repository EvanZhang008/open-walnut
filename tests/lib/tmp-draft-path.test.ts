/**
 * A draft, plan or evidence path in a temp directory, handed to the user or a lead, gets one note
 * back to the session (src/lib/tmp-draft-path.ts): any Walnut op's arguments (the executor, so
 * MCP, the CLI and a gateway call alike), and the text a turn ends with (the Stop hook's sh reads
 * the paths, open_items judges them). The TypeScript judgment and the Write/Bash hook's awk run on
 * one table here, so they never drift apart.
 *
 * Why (2026-11-04): a task asked the user a question naming the temp folder its draft lived in,
 * waited 10 hours, and nothing flagged it; only a Write of a draft got a note.
 *
 * MACHINE SAFETY: the only files made are this test's own folder in /tmp (a handed path must
 * exist) and a stub `walnut` inside it; the hooks only read their stdin and test paths.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { guardedPath } from '../setup/exec-guard.js'
import {
  findTempDraftPaths, isTempDraftPath, opTmpPathNote, stopTmpPathNote, TASK_DIR_VAR, TMP_NOTE_EXEMPT_OPS,
} from '../../src/lib/tmp-draft-path.js'
import { TMP_WRITE_NOTE_COMMAND } from '../../src/providers/tmp-write-note-hook.js'
import { STOP_UNANSWERED_HOOK_COMMAND } from '../../src/providers/stop-unanswered-hook.js'
import { getOp, listOps, definePluginOp, removePluginOps } from '../../src/ops/registry.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'

const TASK_DIR = '/home/u/.local/state/open-walnut/tasks/T1'
const ENV = { tmpdir: '/var/folders/ab/T/', taskDir: TASK_DIR }

// [path, a draft?] Judged the same by the awk hook and by isTempDraftPath.
const TABLE: Array<[string, boolean]> = [
  ['/tmp/slack-draft.md', true], ['/tmp/PLAN.MD', true], ['/private/tmp/work/plan.markdown', true],
  ['/tmp/x/design.mdx', true], ['/tmp/x/notes.org', true], ['/var/folders/ab/T/handoff.rst', true],
  ['/private/var/folders/ab/T/summary.txt', true], ['/tmp/x/commit-msg.txt', true], ['/tmp/x/pr-body.txt', true],
  ['/tmp/reply_to_ana.txt', true], ['/tmp/run-42/evidence/result.json', true], ['/tmp/reports/latency.csv', true],
  ['/tmp/x/drafts/post', true], ['/tmp/todo', true], ['/tmp/slackDraft.txt', true], ['/tmp/draft2.txt', true],
  ['/tmp/watchlist-risk-report/correction', true], ['/tmp/cr-desc.txt', true],
  ['/tmp/shot.png', false], ['/tmp/evidence/shot.png', false], ['/tmp/x/recording.mp4', false], ['/tmp/x/plan-run.log', false],
  ['/tmp/test-output.json', false], ['/tmp/run.txt', false], ['/tmp/x/result.html', false], ['/tmp/explain/report.html', false],
  ['/tmp/x/playwright-report/data.json', false], ['/tmp/x/test-results/notes-spec/trace.json', false], ['/tmp/plans.tar.gz', false],
  ['/tmp/planet.json', false], ['/tmp/explanation.txt', false], ['/home/u/repo/README.md', false], ['/home/u/notes/plan.md', false],
  [`${TASK_DIR}/plan.md`, false], ['/tmpfoo/plan.md', false], ['/tmp/scratch', false],
  // Claude Code's own scratch tree: the project folder is named for the repo (review, 2026-11-15).
  ['/private/tmp/claude-503/-Users-me-notes-app/s1/tasks/b1.output', false], ['/tmp/claude-501/-home-me-plans/x.md', false],
]

describe('one judgment in TypeScript and in the hook\'s awk', () => {
  it.each(TABLE)('%s → draft=%s', (p, draft) => {
    expect(isTempDraftPath(p, ENV)).toBe(draft)
    const r = spawnSync('/bin/sh', ['-c', TMP_WRITE_NOTE_COMMAND], {
      input: JSON.stringify({ hook_event_name: 'PostToolUse', cwd: '/home/u', tool_name: 'Write', tool_input: { file_path: p, content: 'x' }, tool_response: {} }),
      encoding: 'utf8',
      env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: '/home/u', TMPDIR: ENV.tmpdir, WALNUT_TASK_DIR: TASK_DIR },
    })
    expect(r.stdout !== '').toBe(draft)
  })
})

let root = ''
let draftDir = ''
let draftFile = ''
let shot = ''
beforeAll(() => {
  root = fs.mkdtempSync('/tmp/walnut-handed-note-')
  draftDir = path.join(root, 'watchlist-risk-report', 'correction')
  fs.mkdirSync(draftDir, { recursive: true })
  draftFile = path.join(root, 'slack-draft.md')
  fs.writeFileSync(draftFile, 'x')
  shot = path.join(root, 'shot.png')
  fs.writeFileSync(shot, 'x')
  fs.mkdirSync(path.join(root, 'bin'))
})
afterAll(() => { if (root.startsWith('/tmp/walnut-handed-note-')) fs.rmSync(root, { recursive: true, force: true }) })

describe('finding temp drafts in text', () => {
  const find = (text: string) => findTempDraftPaths(text, { taskDir: TASK_DIR })
  it('finds an existing draft wherever the text names it', () => {
    expect(find(`Should I send it? The draft lives in ${draftDir}/.`)).toEqual([draftDir])
    expect(find(`files:\n${draftFile}\n${shot}`)).toEqual([draftFile])
    expect(find(`**${draftFile}**, and \`${draftDir}\``)).toEqual([draftFile, draftDir])
    // A non-ASCII word right after the path (the CJK word for "inside").
    expect(find(`draft: ${draftFile}里`)).toEqual([draftFile])
  })

  it('stays quiet for a screenshot, a missing or moved path, the tail of a longer path', () => {
    expect(find(`see ${shot}`)).toEqual([])
    expect(find(`moved /tmp/never-made-${process.pid}/plan.md into the task directory`)).toEqual([])
    expect(find(`/home/u${draftFile} and file:/${draftFile}x`)).toEqual([])
  })

  it('stays fast on text listing hundreds of scratch paths', () => {
    const many = Array.from({ length: 400 }, (_, i) => `/tmp/scratch/out${i}.txt`).join(' ')
    const t0 = Date.now()
    expect(find(`${many} /tmp/${'a'.repeat(200_000)} ${draftFile}`)).toEqual([])
    expect(Date.now() - t0).toBeLessThan(500)
  })
})

describe('every Walnut op is checked unless it acts on a machine (guard)', () => {
  beforeAll(async () => { await import('../../src/ops/index.js') })

  it('each exempt op exists and says why', () => {
    for (const [name, why] of Object.entries(TMP_NOTE_EXEMPT_OPS)) {
      expect(getOp(name), `${name} is no op`).toBeTruthy()
      expect(why.length).toBeGreaterThan(10)
    }
  })

  it('every other op, a new one included, notes a temp draft in its arguments', () => {
    const ops = listOps().map((o) => o.name)
    expect(ops.length).toBeGreaterThan(100)
    const quiet = [...ops, 'a_new_op_nobody_listed']
      .filter((name) => !(name in TMP_NOTE_EXEMPT_OPS))
      .filter((name) => !opTmpPathNote(name, { text: { nested: [`see ${draftFile}`] } }, { taskDir: TASK_DIR, checkDisk: true })?.includes(draftFile))
    expect(quiet).toEqual([])
    for (const name of Object.keys(TMP_NOTE_EXEMPT_OPS)) expect(opTmpPathNote(name, { text: draftFile }, { taskDir: TASK_DIR, checkDisk: true })).toBeNull()
  })

  it('a session on another host is judged by the words, with the variable it expands', () => {
    const note = opTmpPathNote('task_send', { text: 'draft at /tmp/elsewhere/plan.md' }, { taskDir: TASK_DIR_VAR, checkDisk: false })
    expect(note).toContain(`mv '/tmp/elsewhere/plan.md' "$WALNUT_TASK_DIR/"`)
    expect(opTmpPathNote('task_send', { text: 'draft at /tmp/elsewhere/plan.md' }, { taskDir: TASK_DIR, checkDisk: true })).toBeNull()
  })
})

describe('the executor adds the note to a session\'s op result', () => {
  const saved = { td: process.env.WALNUT_TASK_DIR, off: process.env.WALNUT_TMP_WRITE_NOTE }
  beforeAll(() => {
    definePluginOp('tmp-note-test', {
      name: 'tmp_note_test_echo', title: 'echo', description: 'Echoes its text (test only).',
      input: { text: z.string().optional() },
      handler: async () => ({ ok: true }),
      tags: { readonly: true },
    })
  })
  afterAll(() => { removePluginOps('tmp-note-test') })

  it('in a session\'s own process; never for a person, never when turned off', async () => {
    try {
      process.env.WALNUT_TASK_DIR = TASK_DIR
      delete process.env.WALNUT_TMP_WRITE_NOTE
      const r = await executeOp('tmp_note_test_echo', { text: `Draft at ${draftDir}/. OK?` }, { origin: LOCAL_ORIGIN })
      expect(r.ok).toBe(true)
      expect((r as { result: { walnut_note?: string } }).result.walnut_note).toContain(`This Walnut call (tmp_note_test_echo) names ${draftDir}`)
      const person = await executeOp('tmp_note_test_echo', { text: draftFile }, { origin: LOCAL_ORIGIN, callerMode: 'human' })
      expect((person as { result: Record<string, unknown> }).result.walnut_note).toBeUndefined()
      process.env.WALNUT_TMP_WRITE_NOTE = '0'
      const off = await executeOp('tmp_note_test_echo', { text: draftFile }, { origin: LOCAL_ORIGIN })
      expect((off as { result: Record<string, unknown> }).result.walnut_note).toBeUndefined()
    } finally {
      if (saved.td === undefined) delete process.env.WALNUT_TASK_DIR; else process.env.WALNUT_TASK_DIR = saved.td
      if (saved.off === undefined) delete process.env.WALNUT_TMP_WRITE_NOTE; else process.env.WALNUT_TMP_WRITE_NOTE = saved.off
    }
  })
})

describe('the turn\'s final text (Stop hook and open_items)', () => {
  function stop(message: string, opts: { active?: boolean; taskDir?: string } = {}): string {
    // A walnut that answers a block with the arguments it got (the hook prints only a block).
    fs.writeFileSync(path.join(root, 'bin', 'walnut'), '#!/bin/sh\nprintf \'{"decision":"block","args":%s}\\n\' "$4"\n', { mode: 0o755 })
    const input = JSON.stringify({ session_id: 's', transcript_path: '/nonexistent.jsonl', cwd: '/home/u', hook_event_name: 'Stop', stop_hook_active: opts.active ?? false, last_assistant_message: message })
    const r = spawnSync('/bin/sh', ['-c', STOP_UNANSWERED_HOOK_COMMAND], {
      input, encoding: 'utf8',
      env: { PATH: guardedPath([], `${path.join(root, 'bin')}:/usr/bin:/bin`), HOME: '/home/u', WALNUT_TASK_DIR: opts.taskDir ?? TASK_DIR },
    })
    expect(r.status, r.stderr).toBe(0)
    const out = r.stdout.trim()
    return out ? JSON.stringify((JSON.parse(out) as { args: unknown }).args) : ''
  }

  it('the hook passes the temp paths that exist, and only those', () => {
    const args = JSON.parse(stop(`Should I send it? The draft lives in ${draftDir}/.\nAlso ${shot}, and /tmp/never-made-${process.pid}/plan.md`)) as { hook: string; tmp_paths?: string }
    expect(args.hook).toBe('stop')
    expect(args.tmp_paths?.split('|')).toEqual([`${draftDir}/`, shot])
    expect(JSON.parse(stop('All done.')).tmp_paths).toBeUndefined()
    // Glued to CJK text and full-width punctuation ("draft is at ... , please look").
    expect(JSON.parse(stop(`\u8349\u7a3f\u5728 ${draftFile}\u3002\u8bf7\u770b`)).tmp_paths).toBe(draftFile)
    expect(JSON.parse(stop(`${draftFile}\u8bf7\u770b`)).tmp_paths).toBe(draftFile)
    // Each path once, at most five: the argument stays small.
    expect(JSON.parse(stop(Array(50).fill(draftFile).join(' '))).tmp_paths).toBe(draftFile)
    expect(JSON.parse(stop(`see /home/u${draftFile}`)).tmp_paths).toBeUndefined()
    // No task directory (an older daemon), or a continuation the hook asked for: nothing.
    expect(JSON.parse(stop(`draft: ${draftFile}`, { taskDir: '' })).tmp_paths).toBeUndefined()
    expect(stop(`draft: ${draftFile}`, { active: true })).toBe('')
  })

  it('open_items holds the turn with the note first, before the server\'s own reason', async () => {
    await import('../../src/ops/index.js')
    const map = getOp('open_items')!.mapResult!
    const saved = process.env.WALNUT_TASK_DIR
    process.env.WALNUT_TASK_DIR = TASK_DIR
    try {
      const both = map({ body: { stop: { reason: 'You hold request rq-1.' } }, args: { hook: 'stop', tmp_paths: `${draftDir}/|${shot}` } }) as { decision?: string; reason?: string }
      expect(both.decision).toBe('block')
      expect(both.reason).toMatch(/^Walnut note: Your reply names .*correction, in a temp directory\..* You hold request rq-1\.$/)
      expect(both.reason).toContain('tell the reader the new path')
      const alone = map({ body: { stop: null }, args: { hook: 'stop', tmp_paths: shot } })
      expect(alone).toEqual({})
      expect(map({ body: { stop: { reason: 'R' } }, args: { hook: 'stop' } })).toEqual({ decision: 'block', reason: 'R' })
    } finally {
      if (saved === undefined) delete process.env.WALNUT_TASK_DIR; else process.env.WALNUT_TASK_DIR = saved
    }
  })

  it('names the variable when the process does not know the task directory', () => {
    expect(stopTmpPathNote('/tmp/x/plan.md', { taskDir: TASK_DIR_VAR })).toContain(`"$WALNUT_TASK_DIR/"`)
    expect(stopTmpPathNote('', { taskDir: TASK_DIR })).toBeNull()
  })
})
