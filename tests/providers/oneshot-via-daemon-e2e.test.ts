/**
 * The three server paths that start `claude -p` outside a session run it in
 * the local daemon (oneshot-v1), each keeping what it had in-process:
 *
 * - warm micro-Claude (AI search, the direct route of `ai.run`): the pool lives
 *   in the daemon, a prewarmed child answers (warm:true), its boot line still
 *   gives the session id, partial text streams, the result line's cost comes back;
 * - the cold micro-Claude path (runInlineSubagent): blocks stream, cost and
 *   session id return;
 * - the claude-cli model adapter: text deltas, usage, and the --resume reuse of
 *   one CLI session across turns of a conversation.
 *
 * Proof that the daemon ran each child: the fake CLI reports its parent pid,
 * and it is the daemon's. A link that drops mid-run ends the run with an error.
 *
 * MACHINE SAFETY: the daemon is the JS twin with a temp HOME and daemon dir; the
 * only `claude` anywhere is a temp-dir shim that runs
 * tests/helpers/oneshot-fake-claude.cjs; the daemon is stopped after the file.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-oneshot-via-daemon'))

import { startDaemonTwin, type DaemonTwin } from '../helpers/daemon-twin.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { _setOneShotDaemonForTest, _resetLocalOneShotForTest, startOneShot, type OneShotConn } from '../../src/providers/oneshot-client.js'
import { runWarmMicroClaude, prewarmMicroClaude } from '../../src/providers/micro-claude-warm.js'
import { runMicroClaude } from '../../src/providers/micro-claude.js'
import { ClaudeCliAdapter } from '../../src/model/providers/adapter-claude-cli.js'
import type { AdapterCallOptions } from '../../src/model/providers/types.js'
import type { StreamingBlock } from '../../src/providers/claude-stream-parser.js'

const FAKE = path.resolve(__dirname, '../helpers/oneshot-fake-claude.cjs')
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-oneshot-daemon-')))
const bin = path.join(tmp, 'bin')
const home = path.join(tmp, 'home')
const shim = path.join(bin, 'claude')
let twin: DaemonTwin
let conn: DaemonConnection
const savedPath = process.env.PATH
const spawnedPids: number[] = []

const infoOf = (text: string) => JSON.parse(text.slice(text.indexOf('{'))) as { pid: number; ppid: number; resume: boolean; model: string }

beforeAll(async () => {
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`, { mode: 0o755 })
  // resolveClaudeCliExecutable finds only a claude a test put in a temp dir.
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? '/usr/bin:/bin'}`
  twin = await startDaemonTwin({ home, mockCli: FAKE })
  conn = new DaemonConnection('__local__', null)
  await conn.connectDirect(twin.url)
  expect(conn.hasCapability('oneshot-v1')).toBe(true)
  _setOneShotDaemonForTest(() => conn as unknown as OneShotConn)
}, 60_000)

afterAll(async () => {
  _setOneShotDaemonForTest(null)
  _resetLocalOneShotForTest()
  process.env.PATH = savedPath
  try { conn?.disconnect() } catch { /* closed */ }
  await twin?.stop()
  for (const pid of spawnedPids) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  fs.rmSync(tmp, { recursive: true, force: true })
}, 60_000)

/** The shim execs node, so the CLI's parent is the daemon itself. */
function ranInDaemon(info: { pid: number; ppid: number }): void {
  spawnedPids.push(info.pid)
  expect(info.ppid).toBe(twin.proc.pid)
}

describe('one-shot claude runs go through the local daemon', () => {
  it('warm micro-Claude: the daemon pool answers, with the session id, partial text and cost', async () => {
    const spec = { system: 'tiny contract', model: 'haiku', tools: [] as string[], partial: true }
    prewarmMicroClaude(spec)
    await new Promise((r) => setTimeout(r, 1500)) // the pooled child boots and prints its init line
    const deltas: string[] = []
    const blocks: StreamingBlock[] = []
    const first = await runWarmMicroClaude({
      ...spec, prompt: 'find it', timeoutMs: 20_000, toolUseId: 'tu-1',
      onTextDelta: (d) => deltas.push(d), onBlock: (b) => blocks.push(b),
    })
    expect(first.warm).toBe(true)
    expect(first.response.startsWith('reply:find it')).toBe(true)
    expect(first.costUsd).toBe(0.0123)
    expect(first.sessionId).toMatch(/^fake-\d+$/)
    expect(deltas.join('')).toBe(first.response)
    expect(blocks.some((b) => b.type === 'text')).toBe(true)
    const info = infoOf(first.response)
    ranInDaemon(info)
    expect(info.model).toBe('haiku')
    expect(first.sessionId).toBe(`fake-${info.pid}`)

    // The run booted its replacement: the next call is warm too, on another child.
    await new Promise((r) => setTimeout(r, 1500))
    const second = await runWarmMicroClaude({ ...spec, prompt: 'again', timeoutMs: 20_000, toolUseId: 'tu-2', onTextDelta: () => {} })
    expect(second.warm).toBe(true)
    const info2 = infoOf(second.response)
    ranInDaemon(info2)
    expect(info2.pid).not.toBe(info.pid)
  }, 60_000)

  it('cold micro-Claude (inline subagent): blocks, cost and session id come back', async () => {
    const blocks: StreamingBlock[] = []
    const run = await runMicroClaude({ system: 'tiny', prompt: 'cold one', model: 'sonnet', timeoutMs: 20_000, onBlock: (b) => blocks.push(b) })
    expect(run.response.startsWith('reply:cold one')).toBe(true)
    expect(run.costUsd).toBe(0.0123)
    expect(run.sessionId).toMatch(/^fake-\d+$/)
    expect(blocks.some((b) => b.type === 'text')).toBe(true)
    ranInDaemon(infoOf(run.response))
  }, 60_000)

  it('the claude-cli adapter streams, reports usage, and resumes its conversation', async () => {
    const adapter = new ClaudeCliAdapter()
    const base: AdapterCallOptions = {
      providerConfig: { api: 'claude-cli', claude_cli_command: shim },
      model: 'default', maxTokens: 1024, system: 'You are the Personal AI.',
      messages: [{ role: 'user', content: 'say hi' }],
    }
    const deltas: string[] = []
    const first = await adapter.sendMessageStream({ ...base, onTextDelta: (d) => deltas.push(d) })
    const text1 = (first.content[0] as { text: string }).text
    expect(text1).toContain('reply:User: say hi')
    // The fake prints both the partial deltas and the finished message, and the
    // adapter forwards both (its in-process behaviour, unchanged here).
    expect(deltas.join('')).toContain(text1)
    expect(first.usage).toMatchObject({ input_tokens: 5, output_tokens: 7 })
    const info1 = infoOf(text1)
    ranInDaemon(info1)
    expect(info1.resume).toBe(false)

    const second = await adapter.sendMessage({
      ...base,
      purpose: 'background',
      messages: [...base.messages, { role: 'assistant', content: text1 }, { role: 'user', content: 'and again' }],
    })
    const text2 = (second.content[0] as { text: string }).text
    expect(text2).toContain('reply:User: and again')
    const info2 = infoOf(text2)
    ranInDaemon(info2)
    expect(info2.resume).toBe(true)
  }, 60_000)

  it('a link that drops mid-run ends the run with an error', async () => {
    const exits: Array<{ error?: string }> = []
    let flipped = false
    const fake: OneShotConn = {
      get connected() { return !flipped && conn.connected },
      get connectionEpoch() { return conn.connectionEpoch },
      hasCapability: (c) => conn.hasCapability(c),
      send: (cmd, params, ms) => conn.send(cmd, params, ms),
    }
    _setOneShotDaemonForTest(() => fake)
    try {
      const handle = await startOneShot({ command: shim, args: ['-p'], env: process.env, input: 'hang', endInput: true }, {
        onExit: (e) => exits.push(e),
      })
      expect(handle.via).toBe('daemon')
      flipped = true
      const until = Date.now() + 5_000
      while (exits.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
      expect(exits).toHaveLength(1)
      expect(exits[0].error).toMatch(/link to the local daemon dropped/)
      flipped = false
      await conn.send('oneshot.cancel', { runId: 'unused' })
      handle.kill('SIGKILL') // the route is gone: a no-op
    } finally {
      _setOneShotDaemonForTest(() => conn as unknown as OneShotConn)
    }
  }, 30_000)
})
