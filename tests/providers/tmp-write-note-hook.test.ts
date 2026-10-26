/**
 * The PostToolUse hook that reminds a session after it writes a draft, plan,
 * note or evidence file into a temp directory (src/providers/tmp-write-note-hook.ts),
 * run for real: the exact command string Walnut puts in `--settings`, through
 * every POSIX shell on this machine (macOS: bash-as-sh; CI: dash), with the
 * JSON a Claude Code PostToolUse hook receives on stdin. A note is
 * `additionalContext` on stdout (exit 0, never a decision); a quiet write
 * prints nothing.
 *
 * Why (2026-10-26): a Slack draft and a plan file in /tmp were deleted by the
 * temp cleaner the same day.
 *
 * MACHINE SAFETY: the hook only reads its stdin; nothing here writes a file.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { TMP_WRITE_NOTE_COMMAND, tmpWriteNoteHooks } from '../../src/providers/tmp-write-note-hook.js'

const TASK_DIR = '/home/u/.local/state/open-walnut/tasks/T1'
const SHELLS = ['/bin/sh', '/bin/bash', '/bin/dash', '/usr/bin/dash', '/bin/zsh'].filter((s) => fs.existsSync(s))

function payload(filePath: string, content = 'hello\n', opts: { responseFirst?: boolean; cwd?: string } = {}): string {
  const toolInput = { file_path: filePath, content }
  const toolResponse = { type: 'create', filePath, content, structuredPatch: [] }
  const base = { session_id: 's', transcript_path: '/x.jsonl', cwd: opts.cwd ?? '/home/u/repo', permission_mode: 'bypassPermissions', hook_event_name: 'PostToolUse', tool_name: 'Write' }
  return JSON.stringify(opts.responseFirst
    ? { ...base, tool_response: toolResponse, tool_input: toolInput, tool_use_id: 't' }
    : { ...base, tool_input: toolInput, tool_response: toolResponse, tool_use_id: 't' })
}

function run(shell: string, input: string, env: Record<string, string> = {}) {
  const r = spawnSync(shell, ['-c', TMP_WRITE_NOTE_COMMAND], {
    input,
    encoding: 'utf8',
    env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: '/home/u', TMPDIR: '/var/folders/ab/T/', WALNUT_TASK_DIR: TASK_DIR, ...env },
  })
  let note = ''
  if (r.stdout) {
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: Record<string, string> }
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    // A reminder only: never a permission decision, never a block.
    expect(Object.keys(out)).toEqual(['hookSpecificOutput'])
    expect(Object.keys(out.hookSpecificOutput).sort()).toEqual(['additionalContext', 'hookEventName'])
    note = out.hookSpecificOutput.additionalContext
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, note }
}

// [path written, noted?]
const CASES: Array<[string, boolean]> = [
  // Noted: prose files and named drafts, plans, notes and evidence in a temp dir.
  ['/tmp/slack-draft.md', true],
  ['/tmp/PLAN.MD', true],
  ['/private/tmp/work/plan.markdown', true],
  ['/tmp/x/design.mdx', true],
  ['/tmp/x/notes.org', true],
  ['/var/folders/ab/T/handoff.rst', true],
  ['/private/var/folders/ab/T/summary.txt', true],
  ['/tmp/x/commit-msg.txt', true],
  ['/tmp/x/pr-body.txt', true],
  ['/tmp/reply_to_ana.txt', true],
  ['/tmp/run-42/evidence/result.json', true],
  ['/tmp/reports/latency.csv', true],
  ['/tmp/x/drafts/post', true],
  ['/tmp/todo', true],
  ['/tmp/slackDraft.txt', true],
  ['/tmp/draft2.txt', true],
  ['/tmp/x/slack-message.txt', true],
  ['/tmp/msg.txt', true],
  ['/tmp/cr-desc.txt', true],
  // Quiet: screenshots, media, logs and plain test output; durable places; the task dir itself.
  ['/tmp/shot.png', false],
  ['/tmp/evidence/shot.png', false],
  ['/tmp/x/recording.mp4', false],
  ['/tmp/x/plan-run.log', false],
  ['/tmp/x/out.log', false],
  ['/tmp/test-output.json', false],
  ['/tmp/run.txt', false],
  ['/tmp/x/result.html', false],
  ['/tmp/explain/report.html', false],
  ['/tmp/x/playwright-report/data.json', false],
  ['/tmp/x/test-results/notes-spec/trace.json', false],
  ['/tmp/plans.tar.gz', false],
  ['/tmp/planet.json', false],
  ['/tmp/explanation.txt', false],
  ['/home/u/repo/README.md', false],
  ['/home/u/notes/plan.md', false],
  [`${TASK_DIR}/plan.md`, false],
  [`${TASK_DIR}/drafts/slack.txt`, false],
  ['/tmpfoo/plan.md', false],
]

describe.each(SHELLS)('/tmp write note under %s', (shell) => {
  it.each(CASES)('a Write of %s → noted=%s', (filePath, noted) => {
    const r = run(shell, payload(filePath))
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toBe('')
    if (noted) {
      expect(r.note).toContain(`Walnut note: you wrote ${filePath} in a temp directory`)
      // It names where the file goes instead, and leaves scratch alone.
      expect(r.note).toContain(`mv '${filePath}' '${TASK_DIR}/'`)
      expect(r.note).toContain('Screenshots and scratch output can stay in /tmp')
    } else {
      expect(r.stdout).toBe('')
    }
  })

  it('a relative path is read against the cwd', () => {
    expect(run(shell, payload('notes.md', 'x', { cwd: '/tmp/work' })).note).toContain('/tmp/work/notes.md')
    expect(run(shell, payload('notes.md', 'x', { cwd: '/home/u/repo' })).stdout).toBe('')
  })

  it('reads the path, not the content: a temp path quoted in the file changes nothing', () => {
    const decoy = '{"file_path": "/tmp/plan.md"}\n'.repeat(20)
    expect(run(shell, payload('/home/u/repo/config.json', decoy)).stdout).toBe('')
    expect(run(shell, payload('/home/u/repo/config.json', decoy, { responseFirst: true })).stdout).toBe('')
    expect(run(shell, payload('/tmp/plan.md', decoy, { responseFirst: true })).note).toContain('/tmp/plan.md')
  })

  it('a path with a quote, a backslash or non-ASCII letters still yields valid JSON', () => {
    expect(run(shell, payload('/tmp/a b/it\'s "draft".md')).note).toContain('/tmp/a b/it\'s "draft".md')
    expect(run(shell, payload('/tmp/a\\b/plan.md')).note).toContain('/tmp/a\\b/plan.md')
    // A non-ASCII name (the Chinese word for "draft"): the extension decides, and the bytes survive.
    const cjk = '/tmp/\u8349\u7a3f.md'
    expect(run(shell, payload(cjk)).note).toContain(cjk)
  })

  it('treats /private/var and /var as the same place (a task dir under the macOS temp dir)', () => {
    const td = '/private/var/folders/ab/T/run/tasks/T2'
    expect(run(shell, payload('/var/folders/ab/T/run/tasks/T2/plan.md'), { WALNUT_TASK_DIR: td }).stdout).toBe('')
    expect(run(shell, payload('/var/folders/ab/T/other/plan.md'), { WALNUT_TASK_DIR: `${td}/` }).note).toContain(`'${td}/'`)
  })

  it('judges only the words below the temp root, never the temp dir\'s own path', () => {
    const env = { TMPDIR: '/home/u/notes/tmp/' }
    expect(run(shell, payload('/home/u/notes/tmp/out.json'), env).stdout).toBe('')
    expect(run(shell, payload('/home/u/notes/tmp/plan.md'), env).note).toContain('/home/u/notes/tmp/plan.md')
    expect(run(shell, payload('/var/folders/memo_x/T/out.json'), { TMPDIR: '/var/folders/memo_x/T/' }).stdout).toBe('')
  })

  it('quotes a path with a single quote in the suggested command', () => {
    expect(run(shell, payload("/tmp/ana's plan.md")).note).toContain("mv '/tmp/ana'\\''s plan.md'")
  })

  it('says nothing when the session has no task directory (an older daemon)', () => {
    expect(run(shell, payload('/tmp/plan.md'), { WALNUT_TASK_DIR: '' }).stdout).toBe('')
  })

  it('a missing awk (or one that fails) says nothing and never fails the write', () => {
    // cat stays, so the input is read and the awk step is what is missing.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-note-bin-'))
    try {
      fs.symlinkSync(fs.existsSync('/bin/cat') ? '/bin/cat' : '/usr/bin/cat', path.join(bin, 'cat'))
      const r = run(shell, payload('/tmp/plan.md'), { PATH: guardedPath([], bin) })
      expect(r.stdout).toBe('')
      expect(r.status).toBe(0)
    } finally {
      fs.rmSync(bin, { recursive: true, force: true })
    }
  })

  it('stays fast on a large write, and skips one past its limit', () => {
    // The payload carries the content twice (tool_input and tool_response), in a
    // UTF-8 locale like a real session's.
    const utf8 = { LC_ALL: 'en_US.UTF-8' }
    const t0 = Date.now()
    expect(run(shell, payload('/tmp/plan.md', 'a'.repeat(1_000_000)), utf8).note).toContain('/tmp/plan.md')
    expect(Date.now() - t0).toBeLessThan(5_000)
    // About 5 MB of payload: past the 4 MB cap, never parsed.
    expect(run(shell, payload('/tmp/plan.md', 'a'.repeat(2_500_000)), utf8).stdout).toBe('')
    // A large write outside a temp dir never reaches awk at all.
    const t1 = Date.now()
    expect(run(shell, payload('/home/u/repo/big.md', 'a'.repeat(1_500_000)), utf8).stdout).toBe('')
    expect(Date.now() - t1).toBeLessThan(2_000)
  })

  it('ignores input that is not a file write', () => {
    expect(run(shell, JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat /tmp/plan.md' } })).stdout).toBe('')
    expect(run(shell, '').stdout).toBe('')
  })
})

describe('tmpWriteNoteHooks', () => {
  it('is a PostToolUse hook on Write only, off with WALNUT_TMP_WRITE_NOTE=0', () => {
    const hooks = tmpWriteNoteHooks({}) as { PostToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> }
    expect(Object.keys(hooks)).toEqual(['PostToolUse'])
    expect(hooks.PostToolUse[0].matcher).toBe('Write')
    expect(hooks.PostToolUse[0].hooks[0]).toMatchObject({ type: 'command', command: TMP_WRITE_NOTE_COMMAND })
    expect(tmpWriteNoteHooks({ WALNUT_TMP_WRITE_NOTE: '0' })).toBeNull()
  })

  it('carries no personal path or user name, and no dash punctuation in its note', () => {
    expect(TMP_WRITE_NOTE_COMMAND).not.toMatch(/\/Users\/|\/home\/[a-z]/)
    expect(TMP_WRITE_NOTE_COMMAND).not.toMatch(/[\u2013\u2014]/)
  })
})
