import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createMockConstants } from '../helpers/mock-constants.js'

const isolation = vi.hoisted(() => {
  const previous = process.env.WALNUT_DAEMON_DIR
  const dir = `/tmp/walnut-task-cli-daemon-${process.pid}-${Date.now()}`
  process.env.WALNUT_DAEMON_DIR = dir
  return { dir, previous }
})
vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-cli', process.env.WALNUT_VERIFY_DAEMON_DIR
  ? { DAEMON_BINARIES_DIR: process.env.WALNUT_VERIFY_DAEMON_DIR } : {}))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { getSessionsForTask } from '../../src/core/session-tracker.js'

let daemon: ChildProcess | undefined
let base: string
const cliPath = process.env.WALNUT_VERIFY_CLI || path.resolve('src/cli-fast.ts')
const streamFilePath = (sid: string) => path.join(`${isolation.dir}-streams`, `${sid}.jsonl`)
const daemonBin = path.join(process.env.WALNUT_VERIFY_DAEMON_DIR || path.resolve('dist/daemon-binaries'), 'daemon-darwin-arm64')

async function cli(name: string, args: Record<string, unknown> = {}) {
  const prefix = cliPath.endsWith('.ts') ? ['--import', 'tsx'] : []
  return new Promise<{ code: number; body: any; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [...prefix, cliPath, 'tools', 'call', name, JSON.stringify(args)], {
      env: { ...process.env, OPEN_WALNUT_API_URL: base, WALNUT_SESSION_ID: '', WALNUT_AGENT_SOCKET: '', WALNUT_CLI_DIRECT: '' },
      timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') { reject(error); return }
      try { resolve({ code: error?.code ?? 0, body: stdout.trim() ? JSON.parse(stdout) : undefined, stderr }) }
      catch { reject(new Error(`CLI returned invalid JSON: ${stdout}\n${stderr}`)) }
    })
  })
}

beforeAll(async () => {
  await fs.mkdir(path.join(WALNUT_HOME, '.toolbox/bin'), { recursive: true })
  await fs.mkdir(isolation.dir, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, '.toolbox/bin/claude'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve('tests/providers/mock-claude.mjs'))} "$@"\n`, { mode: 0o755 })
  const port = await new Promise<number>((resolve, reject) => {
    daemon = spawn(daemonBin, ['--start'], {
      env: { ...process.env, HOME: WALNUT_HOME, SHELL: '/bin/sh', WALNUT_HOME_OVERRIDE: WALNUT_HOME,
        MOCK_CLAUDE_TRANSCRIPT_DIR: path.join(WALNUT_HOME, '.claude/projects'),
        WALNUT_LEGACY_STREAMS_DIR: path.join(isolation.dir, 'legacy'), WALNUT_DAEMON_PARENT_PID: String(process.pid) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const deadline = setTimeout(() => reject(new Error('Isolated daemon startup timed out')), 30_000)
    daemon.stdout!.on('data', (data: Buffer) => {
      const match = data.toString().match(/^\d+$/m)
      if (match) { clearTimeout(deadline); resolve(Number(match[0])) }
    })
    daemon.stderr!.on('data', () => {})
    daemon.once('error', (error) => { clearTimeout(deadline); reject(error) })
    daemon.once('exit', (code) => { clearTimeout(deadline); reject(new Error(`Isolated daemon exited: ${code}`)) })
  })
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${port}`)
  const server = await startServer({ port: 0, dev: true })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected ephemeral server port')
  base = `http://127.0.0.1:${address.port}`
}, 60_000)

afterAll(async () => {
  await stopServer()
  sessionRunner.setTestDaemonUrl(undefined)
  if (daemon && daemon.exitCode === null) {
    const child = daemon
    const exited = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Isolated daemon did not exit')), 15_000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
    child.kill('SIGTERM')
    await exited
  }
  if (isolation.previous === undefined) delete process.env.WALNUT_DAEMON_DIR
  else process.env.WALNUT_DAEMON_DIR = isolation.previous
}, 25_000)

describe('task CLI lifecycle through a real server and process transport', () => {
  it('saves an explicit placeholder, starts by task id, sends twice, and reads the conversation', async () => {
    const saved = await cli('task_create', { title: 'Deferred CLI work', record_only: true })
    expect(saved.code, saved.stderr).toBe(0)
    const id = saved.body.task.id
    expect(saved.body.execution.state).toBe('not_started')
    expect(await getSessionsForTask(id)).toEqual([])
    expect((await cli('task_history', { id })).body.messages).toEqual([])

    const started = await cli('task_start', { id, cwd: WALNUT_HOME, message: 'snapshot-clean-turn:first-cli-turn', host: 'local' })
    expect(started.code, started.stderr).toBe(0)
    expect(started.body.started).toBe(true)
    const records = await getSessionsForTask(id)
    expect(records).toHaveLength(1)
    expect(records[0].pid).toBeGreaterThan(1)
    expect(records[0].claudeSessionId).toBe(started.body.sessionId)

    await vi.waitFor(async () => {
      expect(await fs.readFile(streamFilePath(records[0].claudeSessionId), 'utf8')).toContain('"result":"first-cli-turn"')
    }, { timeout: 10_000 })
    for (const text of ['second-cli-turn', 'third-cli-turn']) {
      const sent = await cli('task_send', { to: id, text: `snapshot-clean-turn:${text}`, expect_reply: false })
      expect(sent.code, sent.stderr).toBe(0)
      expect(sent.body.outcome).toContain('queued')
      await vi.waitFor(async () => {
        const stream = await fs.readFile(streamFilePath(records[0].claudeSessionId), 'utf8')
        expect(stream).toContain(`"result":"${text}"`)
      }, { timeout: 15_000, interval: 100 })
    }
    const detail = await cli('task_get', { id })
    expect(detail.code, detail.stderr).toBe(0)
    expect(detail.body.task).not.toHaveProperty('session_id')
    expect(['running', 'idle']).toContain(detail.body.task.execution.state)
    const history = await cli('task_history', { id, fresh: true })
    expect(history.code, history.stderr).toBe(0)
    expect(JSON.stringify(history.body.messages)).toContain('third-cli-turn')
    expect(await getSessionsForTask(id)).toHaveLength(1)
  }, 90_000)

  it('creates and starts by default, preserves a long Unicode instruction, and rejects duplicate starts', async () => {
    const message = 'snapshot-clean-turn:' + 'Review the fixtures. '.repeat(600) + String.fromCodePoint(0x4e2d, 0x6587, 0x1f330)
    const created = await cli('task_create', { title: 'Default CLI execution', message, cwd: WALNUT_HOME })
    expect(created.code, created.stderr).toBe(0)
    const id = created.body.task.id
    expect(created.body.started).toBe(true)
    expect((await cli('task_get', { id })).body.task.description).toBe(message)
    const duplicate = await cli('task_start', { id })
    expect(duplicate.code).not.toBe(0)
    expect(duplicate.stderr).toContain('task_send')
    expect(await getSessionsForTask(id)).toHaveLength(1)
  }, 60_000)

  it('fails honestly, keeps the task and failed run, and retries that same task', async () => {
    const created = await cli('task_create', { title: 'Recover CLI execution', message: 'snapshot-clean-turn:preserved-retry-instruction', cwd: path.join(WALNUT_HOME, 'missing') })
    expect(created.code).not.toBe(0)
    expect(created.body, created.stderr).toBeDefined()
    const id = created.body.task.id
    expect(created.body.start_error).toContain('Working directory no longer exists')
    const detail = await cli('task_get', { id })
    expect(detail.body.task.execution.state).toBe('error')
    expect(detail.body.task.execution.error).toContain('Working directory no longer exists')
    const retried = await cli('task_start', { id, cwd: WALNUT_HOME })
    expect(retried.code, retried.stderr).toBe(0)
    expect(retried.body.started).toBe(true)
    const rows = await getSessionsForTask(id)
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.claudeSessionId !== retried.body.sessionId)?.errorMessage).toContain('Working directory no longer exists')
    await vi.waitFor(async () => {
      expect(await fs.readFile(streamFilePath(retried.body.sessionId), 'utf8')).toContain('preserved-retry-instruction')
    }, { timeout: 10_000 })
  }, 60_000)

  it('allows only one of two concurrent starts of the same placeholder', async () => {
    const created = await cli('task_create', { title: 'Concurrent CLI execution', record_only: true })
    const id = created.body.task.id
    const results = await Promise.all([cli('task_start', { id, cwd: WALNUT_HOME, message: 'snapshot-clean-turn:concurrent' }), cli('task_start', { id, cwd: WALNUT_HOME, message: 'snapshot-clean-turn:concurrent' })])
    expect(results.map((r) => r.code === 0).sort()).toEqual([false, true])
    expect(results.find((r) => r.code !== 0)?.stderr).toContain('task_send')
    expect(await getSessionsForTask(id)).toHaveLength(1)
  }, 60_000)
})
