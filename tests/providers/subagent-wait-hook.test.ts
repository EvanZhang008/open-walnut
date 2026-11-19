/**
 * The SubagentStop hook that keeps a subagent from ending its run while a background command it
 * started still runs (src/providers/subagent-wait-hook.ts), run for real: the exact command string
 * Walnut puts in `--settings`, through every POSIX shell on this machine, with the JSON a Claude
 * Code SubagentStop hook receives on stdin and a subagent transcript holding the lines the CLI
 * writes when it hands the model a background task id.
 *
 * The guard for the whole class: every phrasing the CLI uses for a background task's id
 * (BACKGROUND_ID_LINES, copied from Claude Code 2.1.322's tool results) must be read, and a new
 * one added there without the hook reading it fails here.
 *
 * MACHINE SAFETY: the hook reads its stdin and one transcript file, and writes one state file
 * under the TMPDIR this test gives it; the loop it prints runs here against files this test made.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { SUBAGENT_WAIT_HOOK_COMMAND, subagentWaitHooks } from '../../src/providers/subagent-wait-hook.js'
import { sessionSettingsHooks } from '../../src/providers/session-settings-hooks.js'

const SHELLS = ['/bin/sh', '/bin/bash', '/bin/dash', '/usr/bin/dash', '/bin/zsh'].filter((s) => fs.existsSync(s))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-wait-'))
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }))

const TASKS = path.join(TMP, 'tasks')
fs.mkdirSync(TASKS)
const out = (id: string) => path.join(TASKS, `${id}.output`)

/** Every way the CLI's tool results name a background task id (Bash and Monitor), one id each. */
const BACKGROUND_ID_LINES: Array<{ id: string; kind: 'command' | 'monitor'; text: (id: string) => string }> = [
  { id: 'b9ei3h8oa', kind: 'command', text: (id) => `Command running in background with ID: ${id}. Output is being written to: ${out(id)}. You will be notified when it completes.` },
  { id: 'bpuccduww', kind: 'command', text: (id) => `Command did not complete within its 600s timeout and was moved to the background (ID: ${id}). Output is being written to: ${out(id)}. You will be notified when it completes.` },
  { id: 'bmovedmsg', kind: 'command', text: (id) => `Command was moved to the background (ID: ${id}) so that a message that arrived while it was running can reach you; it was not interrupted. Output is being written to: ${out(id)}.` },
  { id: 'bmovedran', kind: 'command', text: (id) => `Command was moved to the background (ID: ${id}) after running for 42s. Output is being written to: ${out(id)}.` },
  { id: 'bbyuser01', kind: 'command', text: (id) => `Command was manually backgrounded by user with ID: ${id}. Output is being written to: ${out(id)}.` },
  { id: 'bmonitor1', kind: 'monitor', text: (id) => `Monitor started (task ${id}, timeout 300000ms). You will be notified on each event.` },
]

/** A subagent transcript line the way the CLI writes a tool result into it. */
function toolResult(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }] }, timestamp: '2026-11-19T04:00:00.000Z' })
}

let seq = 0
function transcript(lines: string[]): string {
  const f = path.join(TMP, `agent-${++seq}.jsonl`)
  fs.writeFileSync(f, [JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the work' } }), ...lines].join('\n') + '\n')
  return f
}

/** A live background task as the CLI lists it (type labels as 2.1.322 sends them). */
const task = (id: string, type = 'shell') => ({ id, type, status: 'running', description: `run ${id}`, command: `bun run test # "quoted" id` })

/** One SubagentStop; the subagent is a background one (listed live under its id) unless `foreground`. */
function stop(shell: string, opts: { agent?: string; transcript: string; live?: Array<Record<string, unknown>> | null; foreground?: boolean; last?: string; env?: Record<string, string> }) {
  const agent = opts.agent ?? 'a9a2a9ebeb5731cde'
  const input: Record<string, unknown> = {
    session_id: 's', transcript_path: '/x.jsonl', cwd: '/home/u/repo', permission_mode: 'bypassPermissions',
    hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id: agent,
    agent_transcript_path: opts.transcript, agent_type: 'general-purpose',
    // The final text can quote JSON; its quotes arrive escaped and are never read as a task.
    last_assistant_message: opts.last ?? 'I will wait for the tests.',
  }
  if (opts.live !== null) input.background_tasks = [...(opts.live ?? []), ...(opts.foreground ? [] : [task(agent, 'subagent')])]
  input.session_crons = [{ id: 'cron1', schedule: '*/5 * * * *', recurring: true, prompt: 'x' }]
  const r = spawnSync(shell, ['-c', SUBAGENT_WAIT_HOOK_COMMAND], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: '/home/u', TMPDIR: path.join(TMP, `state-${shell.replace(/\W/g, '')}`), ...opts.env },
  })
  expect(r.status, r.stderr).toBe(0)
  if (r.stdout.trim() === '') return null
  const answer = JSON.parse(r.stdout) as { decision: string; reason: string }
  expect(answer.decision).toBe('block')
  return answer.reason
}

describe.each(SHELLS)('SubagentStop wait hook through %s', (shell) => {
  it('asks a subagent ending its run with its own command still running to wait for it, once', () => {
    const t = transcript([toolResult(BACKGROUND_ID_LINES[0].text('b9ei3h8oa'))])
    const agent = `a-once-${seq}`
    const reason = stop(shell, { agent, transcript: t, live: [task('b9ei3h8oa')] })
    expect(reason).toContain('do not end your run yet')
    expect(reason).toContain(`b9ei3h8oa (output ${out('b9ei3h8oa')})`)
    expect(reason).toContain('no run_in_background')
    // The same command still running at its next stop: the subagent chose to leave it, so it ends.
    expect(stop(shell, { agent, transcript: t, live: [task('b9ei3h8oa')] })).toBeNull()
    // A new command of its own is asked about again.
    const t2 = transcript([toolResult(BACKGROUND_ID_LINES[0].text('b9ei3h8oa')), toolResult(BACKGROUND_ID_LINES[0].text('bnewone01'))])
    expect(stop(shell, { agent, transcript: t2, live: [task('b9ei3h8oa'), task('bnewone01')] })).toContain('bnewone01')
  })

  it('reads every phrasing the CLI names a background task id with (the class guard)', () => {
    for (const line of BACKGROUND_ID_LINES) {
      const t = transcript([toolResult(line.text(line.id))])
      const reason = stop(shell, { agent: `a-class-${line.id}`, transcript: t, live: [task(line.id, line.kind === 'monitor' ? 'monitor' : 'shell')] })
      expect(reason, `the hook does not read: ${line.text(line.id)}`).toContain(line.id)
      if (line.kind === 'command') expect(reason).toContain(out(line.id))
      else expect(reason).toContain('TaskStop')
    }
  })

  it('lets the stop go ahead when nothing of the subagent\'s own still runs', () => {
    const t = transcript([toolResult(BACKGROUND_ID_LINES[0].text('bdone0001'))])
    // Its command already ended (not in the live list), though its final text and a cron quote the
    // id in JSON; the caller's own command is not its.
    expect(stop(shell, { agent: 'a-none', transcript: t, live: [task('bmainsess')], last: 'Done. {"id":"bdone0001"}' })).toBeNull()
    // A foreground subagent: its caller waits for it in its own turn, so nothing is asked.
    expect(stop(shell, { agent: 'a-fore', transcript: t, live: [task('bdone0001')], foreground: true })).toBeNull()
    expect(stop(shell, { agent: 'a-none', transcript: t, live: [] })).toBeNull()
    // An older CLI that hands no list.
    expect(stop(shell, { agent: 'a-none', transcript: t, live: null })).toBeNull()
    // No transcript to read.
    expect(stop(shell, { agent: 'a-none', transcript: path.join(TMP, 'missing.jsonl'), live: [task('bdone0001')] })).toBeNull()
    // Turned off in the session's env.
    expect(stop(shell, { agent: 'a-off', transcript: t, live: [task('bdone0001')], env: { WALNUT_SUBAGENT_WAIT: '0' } })).toBeNull()
  })

  it('never takes quoted text for its own command: a transcript it read, or a prompt that quotes the CLI', () => {
    const quoted = toolResult(`build output\n${BACKGROUND_ID_LINES[1].text('bcaller02')}`) + '\n' + toolResult(BACKGROUND_ID_LINES[0].text('bcaller01'))
    const quotedJsonl = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: `cat caller.jsonl\n${quoted}` }] } })
    const prompt = JSON.stringify({ type: 'user', message: { role: 'user', content: 'The CLI says "Command running in background with ID: bcaller01" there.' } })
    const t = transcript([quotedJsonl, prompt])
    expect(stop(shell, { agent: 'a-quoted', transcript: t, live: [task('bcaller01'), task('bcaller02')] })).toBeNull()
    // The same lines as its own tool results, the second after its command's output, do count.
    const own = transcript([toolResult(BACKGROUND_ID_LINES[0].text('bcaller01')), toolResult(`build output\n${BACKGROUND_ID_LINES[1].text('bcaller02')}`)])
    const reason = stop(shell, { agent: 'a-own', transcript: own, live: [task('bcaller01'), task('bcaller02')] })
    expect(reason).toContain('bcaller01')
    expect(reason).toContain('bcaller02')
  })

  it('reads a line naming thousands of ids in linear time', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `Command running in background with ID: c${i}x. Output is being written to: ${out(`c${i}x`)}.`).join('\n')
    const t = transcript([toolResult(many), toolResult(BACKGROUND_ID_LINES[0].text('bperf0001'))])
    const started = Date.now()
    expect(stop(shell, { agent: `a-perf-${seq}`, transcript: t, live: [task('bperf0001'), task('c4999x')] })).toContain('c4999x')
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('prints a wait loop that runs as given and ends once every output has its closing line, a killed one too', () => {
    const ids = ['bloopone1', 'blooptwo2']
    const t = transcript(ids.map((id) => toolResult(BACKGROUND_ID_LINES[0].text(id))))
    const reason = stop(shell, { agent: `a-loop-${seq}`, transcript: t, live: ids.map((id) => task(id)) })!
    const loop = reason.slice(reason.indexOf('for i in $(seq'), reason.indexOf('; run it again'))
    // A command's own output naming an exit code is not its end.
    fs.writeFileSync(out(ids[0]), 'child exited with code 1\nstill running\n')
    fs.writeFileSync(out(ids[1]), 'partial\n\n[killed]\n')
    const early = spawnSync(shell, ['-c', `${loop.replace('seq 110', 'seq 1')}; [ $d = 1 ]`], { encoding: 'utf8', timeout: 20_000, env: { PATH: guardedPath([], '/usr/bin:/bin') } })
    expect(early.status).toBe(1)
    fs.writeFileSync(out(ids[0]), 'test output\nchild exited with code 1\n\n[exited with code 0]\n')
    const started = Date.now()
    const r = spawnSync(shell, ['-c', loop], { encoding: 'utf8', timeout: 20_000, env: { PATH: guardedPath([], '/usr/bin:/bin') } })
    expect(r.status).toBe(0)
    expect(Date.now() - started).toBeLessThan(4000)
  })
})

describe('the wait hook in every session', () => {
  it('rides every session, its own and a subagent lane\'s, and turns off by env', () => {
    for (const opts of [{}, { subagent: true }, { orgRole: 'lead' as const }]) {
      const hooks = sessionSettingsHooks({}, opts) as Record<string, Array<{ hooks: Array<{ command: string }> }>>
      expect(hooks.SubagentStop?.flatMap((g) => g.hooks.map((h) => h.command))).toContain(SUBAGENT_WAIT_HOOK_COMMAND)
    }
    expect(subagentWaitHooks({ WALNUT_SUBAGENT_WAIT: '0' })).toBeNull()
    expect((sessionSettingsHooks({ WALNUT_SUBAGENT_WAIT: '0' }) as Record<string, unknown>).SubagentStop).toBeUndefined()
  })
})
