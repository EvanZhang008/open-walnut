/**
 * AcpSession's side of the stop that keeps a direct Codex worker: a daemon answer
 * with workerKept leaves the session attached (no cold start for the next message),
 * and a restart always asks for the hard teardown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { AcpSession } from '../../src/providers/acp-session.js'

let tmpDir: string

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-')) })
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

type Internals = {
  _active: boolean
  _turnActive: boolean
  establish(): Promise<string>
  ensureConn(): Promise<{ send(command: string, params: Record<string, unknown>): Promise<Record<string, unknown>> }>
}

function session(answer: Record<string, unknown>) {
  const s = new AcpSession({ taskId: '', project: '', cwd: tmpDir, mode: 'default', engine: 'codex', providerSessionId: 'thread-1', runtimeId: 'runtime-1' })
  const sent: Array<{ command: string; params: Record<string, unknown> }> = []
  const internals = s as unknown as Internals
  internals.ensureConn = async () => ({ send: async (command, params) => { sent.push({ command, params }); return answer } })
  internals._active = true
  internals._turnActive = true
  return { s, internals, sent }
}

describe('a stop on a direct Codex session', () => {
  it('keeps the session attached when the daemon kept the worker', async () => {
    const { s, internals, sent } = session({ ok: true, result: { aborted: true, workerKept: true } })
    await s.abortTurn()
    expect(sent).toHaveLength(1)
    expect(sent[0].command).toBe('acpCancel')
    expect(sent[0].params.hard).toBeUndefined()
    expect(internals._turnActive).toBe(false)
    expect(internals._active).toBe(true)
  })

  it('detaches when the worker was torn down', async () => {
    const { s, internals } = session({ ok: true, result: { aborted: true } })
    await s.abortTurn()
    expect(internals._active).toBe(false)
  })

  it('a restart asks for the hard teardown and starts again', async () => {
    const { s, internals, sent } = session({ ok: true, result: { aborted: true } })
    internals.establish = async () => 'thread-1'
    expect(await s.restart()).toBe('thread-1')
    expect(sent[0].params.hard).toBe(true)
  })
})
