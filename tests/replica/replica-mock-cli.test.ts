/**
 * The `claude` of the replica cluster (tests/helpers/replica-mock-cli.cjs, WP7
 * S10): one long-running stream-json process across turns, the shape of the real
 * CLI. A turn says it runs, thinks (MOCK_THINK_MS, 300 ms by default, so the
 * person's words land before the reply), answers "echo: <the person's words>"
 * with Walnut's wrapping peeled off, says it is idle, and files both lines in
 * its own transcript. A line that lands mid-turn waits for that turn.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const MOCK = path.resolve(import.meta.dirname, '../helpers/replica-mock-cli.cjs')
const SID = 'cccccccc-7003-4003-8003-000000000003'

interface Line { at: number; o: Record<string, any> }
let proc: ChildProcess | null = null
let home = ''

function start(env: Record<string, string> = {}) {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-mock-'))
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(home, 'work-')))
  const config = path.join(home, '.claude')
  proc = spawn(process.execPath, [MOCK, '--session-id', SID, '-p', '--input-format', 'stream-json'], {
    cwd, env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_CONFIG_DIR: config, ...env }, stdio: ['pipe', 'pipe', 'ignore'],
  })
  const lines: Line[] = []
  let buf = ''
  proc.stdout!.on('data', (b: Buffer) => {
    buf += b.toString('utf8')
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const l = buf.slice(0, nl); buf = buf.slice(nl + 1)
      if (l.trim()) lines.push({ at: Date.now(), o: JSON.parse(l) })
    }
  })
  const send = (o: unknown) => proc!.stdin!.write(JSON.stringify(o) + '\n')
  const until = async (pred: (ls: Line[]) => boolean, ms = 10_000) => {
    const t0 = Date.now()
    while (!pred(lines)) {
      if (Date.now() - t0 > ms) throw new Error(`timed out; got ${JSON.stringify(lines.map((l) => l.o.type + ':' + (l.o.subtype ?? l.o.state ?? '')))}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  const transcript = path.join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SID}.jsonl`)
  return { lines, send, until, transcript }
}
const user = (uuid: string, text: string) => ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } })
const idles = (ls: Line[]) => ls.filter((l) => l.o.type === 'system' && l.o.subtype === 'session_state_changed' && l.o.state === 'idle')

afterEach(async () => {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const p = proc
    await new Promise<void>((r) => { p.once('exit', () => r()); p.kill('SIGTERM') })
  }
  proc = null
  if (home) fs.rmSync(home, { recursive: true, force: true })
})

describe('the replica cluster\'s mock CLI', () => {
  it('thinks before it answers, answers the words with the wrapping peeled off, and goes idle', async () => {
    const m = start()
    await m.until((ls) => ls.some((l) => l.o.subtype === 'init'))
    const wrapped = [
      '[Walnut Context]', 'task: Release plan', '[/Walnut Context]',
      'Why does the build fail on devbox?',
      '[Rich output mode is on: answer in rich blocks.]',
      '---walnut-refs---', 'ref: task Release plan', '---/walnut-refs---',
    ].join('\n')
    const sent = Date.now()
    m.send(user('u-1', wrapped))
    await m.until((ls) => idles(ls).length === 1)
    const at = (pred: (o: Record<string, any>) => boolean) => m.lines.find((l) => pred(l.o))!
    const startedAt = at((o) => o.type === 'command_lifecycle' && o.state === 'started' && o.command_uuid === 'u-1')
    const running = at((o) => o.subtype === 'session_state_changed' && o.state === 'running')
    const answer = at((o) => o.type === 'assistant')
    const result = at((o) => o.type === 'result')
    const completed = at((o) => o.type === 'command_lifecycle' && o.state === 'completed')
    // The order of a real turn, and a think between the words and the reply.
    const order = [startedAt, running, answer, result, completed, idles(m.lines)[0]!].map((l) => m.lines.indexOf(l))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(answer.at - sent).toBeGreaterThanOrEqual(250)
    expect(answer.o.message.content[0].text).toBe('echo: Why does the build fail on devbox?')
    expect(result.o.result).toBe('echo: Why does the build fail on devbox?')
    // Both lines in the CLI's own transcript, the user line under Walnut's uuid, chained.
    const rows = fs.readFileSync(m.transcript, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(rows.map((r) => r.type)).toEqual(['user', 'assistant'])
    expect(rows[0].uuid).toBe('u-1')
    expect(rows[1].parentUuid).toBe('u-1')
  })

  it('a line that lands mid-turn waits for that turn; control requests are answered at once', async () => {
    const m = start({ MOCK_THINK_MS: '400' })
    await m.until((ls) => ls.some((l) => l.o.subtype === 'init'))
    m.send(user('u-1', 'first'))
    await m.until((ls) => ls.some((l) => l.o.subtype === 'session_state_changed' && l.o.state === 'running'))
    m.send(user('u-2', 'second'))
    m.send({ type: 'control_request', request_id: 'r-1', request: { subtype: 'get_settings' } })
    await m.until((ls) => ls.some((l) => l.o.type === 'control_response'), 2_000)
    // Answered before the first turn ended.
    expect(idles(m.lines)).toHaveLength(0)
    await m.until((ls) => idles(ls).length === 2)
    const replies = m.lines.filter((l) => l.o.type === 'assistant').map((l) => l.o.message.content[0].text)
    expect(replies).toEqual(['echo: first', 'echo: second'])
    const firstIdle = m.lines.indexOf(idles(m.lines)[0]!)
    const secondStart = m.lines.findIndex((l) => l.o.type === 'command_lifecycle' && l.o.command_uuid === 'u-2' && l.o.state === 'started')
    expect(secondStart).toBeGreaterThan(firstIdle)
  })
})

describe('the mock CLI asks before a tool (WP10 W9)', () => {
  it('"please run <command>" raises a can_use_tool prompt and answers by the control_response', async () => {
    const m = start({ MOCK_THINK_MS: '50' })
    m.send(user('aaaaaaaa-0000-4000-8000-00000000000a', 'please run ls -la'))
    await m.until((ls) => ls.some((l) => l.o.type === 'control_request'))
    const ask = m.lines.find((l) => l.o.type === 'control_request')!.o
    expect(ask.request).toMatchObject({ subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls -la' } })
    // No answer yet: the turn waits on it.
    expect(m.lines.some((l) => l.o.type === 'result')).toBe(false)
    m.send({ type: 'control_response', response: { subtype: 'success', request_id: ask.request_id, response: { behavior: 'allow', updatedInput: { command: 'ls -la' } } } })
    await m.until((ls) => idles(ls).length >= 1)
    expect(m.lines.find((l) => l.o.type === 'result')!.o.result).toBe('echo: ran ls -la')
    m.send(user('aaaaaaaa-0000-4000-8000-00000000000b', 'please run rm -rf build'))
    await m.until((ls) => ls.filter((l) => l.o.type === 'control_request').length >= 2)
    const second = m.lines.filter((l) => l.o.type === 'control_request')[1]!.o
    m.send({ type: 'control_response', response: { subtype: 'success', request_id: second.request_id, response: { behavior: 'deny', message: 'no' } } })
    await m.until((ls) => idles(ls).length >= 2)
    expect(m.lines.filter((l) => l.o.type === 'result')[1]!.o.result).toBe('echo: did not run rm -rf build')
  })

  it('"please ask <question>" raises an AskUserQuestion prompt and answers with the person\'s answer', async () => {
    const m = start({ MOCK_THINK_MS: '50' })
    m.send(user('aaaaaaaa-0000-4000-8000-00000000000c', 'please ask Which day is the drill?'))
    await m.until((ls) => ls.some((l) => l.o.type === 'control_request'))
    const ask = m.lines.find((l) => l.o.type === 'control_request')!.o
    expect(ask.request).toMatchObject({ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which day is the drill?' }] } })
    m.send({ type: 'control_response', response: { subtype: 'success', request_id: ask.request_id, response: { behavior: 'allow', updatedInput: { ...ask.request.input, answers: { 'Which day is the drill?': 'Friday' } } } } })
    await m.until((ls) => idles(ls).length >= 1)
    expect(m.lines.find((l) => l.o.type === 'result')!.o.result).toBe('echo: answered Friday')
  })
})
