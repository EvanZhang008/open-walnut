/**
 * A CLI that fails at startup reads as a failure, with its own message.
 *
 * Claude Code 2.1.314 (2026-10-30): "Fixed `claude -p` exiting with code 0 and no
 * output when startup failed; it now prints the error and exits 1". Both exit shapes
 * must read right: a startup failure (exit 1, stderr, no line of its own on stdout)
 * stays a failure, and a process whose own turn ended stays clean. A `--resume`
 * appends to the previous process's stream and stderr, so the daemon reads only what
 * THIS process wrote (outputStartOffset / stderrStartOffset, set at spawn). Before,
 * the previous turn's result made the failure a clean 0 and its old stderr was quoted.
 * The JS twin's copy is pinned in daemon-intentional-stop-clean-exit.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildDeps, makeTestSession, createDaemonCore } from '../helpers/daemon-core-fixtures.js'

const RESULT = JSON.stringify({ type: 'result', subtype: 'success', stop_reason: 'end_turn', is_error: false }) + '\n'
const INIT = JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'

describe('a CLI exit reads as what this process did', () => {
  let ctx: Awaited<ReturnType<typeof buildDeps>>
  beforeEach(async () => { vi.useFakeTimers(); ctx = await buildDeps() })
  afterEach(async () => { vi.useRealTimers(); await ctx.cleanup() })

  /** A stream and stderr the previous process left: its turn ended, it printed an advisory. */
  function resumed(name: string) {
    const jsonlPath = path.join(ctx.tmpDir, `jsonl-${name}`)
    fs.writeFileSync(jsonlPath, INIT + RESULT)
    fs.writeFileSync(jsonlPath + '.err', 'an advisory the previous process printed\n')
    const session = makeTestSession({ pid: 2000, jsonlPath })
    Object.assign(session, { outputStartOffset: fs.statSync(jsonlPath).size, stderrStartOffset: fs.statSync(jsonlPath + '.err').size })
    ctx.sessions.set(name, session)
    return session
  }
  const deathPayload = () => ctx.spies.broadcastSessionStateFn.mock.calls[0][0] as Record<string, unknown>

  it('a resumed CLI that fails at startup keeps exit 1 and quotes only its own stderr', () => {
    const core = createDaemonCore(ctx.deps)
    const session = resumed('resume-fail')
    fs.appendFileSync(session.jsonlPath + '.err', 'Error: Invalid MCP configuration:\nMCP config is not a valid JSON\n')

    core.reapSession('resume-fail', 1, 'proc-exit')

    expect(session.exitCode).toBe(1)
    expect(session.exitReason).toBe('proc-exit')
    expect(deathPayload()).toMatchObject({ exitCode: 1, stderr: 'Error: Invalid MCP configuration:\nMCP config is not a valid JSON' })
  })

  it('a resumed CLI whose own turn ended is still clean', () => {
    const core = createDaemonCore(ctx.deps)
    const session = resumed('resume-ok')
    fs.appendFileSync(session.jsonlPath, INIT + RESULT)

    core.reapSession('resume-ok', -1, 'orphan-poll-dead')

    expect(session.exitCode).toBe(0)
    expect(session.exitReason).toBe('orphan-poll-dead+turn-complete')
    expect(deathPayload().stderr).toBeUndefined()
  })

  it('a fresh CLI that fails at startup (empty stream) keeps exit 1 with its message', () => {
    const core = createDaemonCore(ctx.deps)
    const jsonlPath = path.join(ctx.tmpDir, 'jsonl-fresh')
    fs.writeFileSync(jsonlPath, '')
    fs.writeFileSync(jsonlPath + '.err', "error: unknown option '--no-such-flag'\n")
    const session = makeTestSession({ pid: 2001, jsonlPath })
    Object.assign(session, { outputStartOffset: 0, stderrStartOffset: 0 })
    ctx.sessions.set('fresh', session)

    core.reapSession('fresh', 1, 'proc-exit')

    expect(session.exitCode).toBe(1)
    expect(deathPayload()).toMatchObject({ exitCode: 1, stderr: "error: unknown option '--no-such-flag'" })
  })

  it('an adopted process (start unknown) reads the whole tail, as before', () => {
    const core = createDaemonCore(ctx.deps)
    const jsonlPath = path.join(ctx.tmpDir, 'jsonl-adopted')
    fs.writeFileSync(jsonlPath, INIT + RESULT)
    const session = makeTestSession({ pid: 2002, jsonlPath })
    ctx.sessions.set('adopted', session)

    core.reapSession('adopted', -1, 'orphan-poll-dead')

    expect(session.exitCode).toBe(0)
  })

  it('both twins record where this process starts writing, at spawn', () => {
    const root = path.resolve(import.meta.dirname, '..', '..')
    for (const rel of ['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts']) {
      const src = fs.readFileSync(path.join(root, rel), 'utf-8')
      expect(src, rel).toMatch(/sessionData\.outputStartOffset = cronStartOffset/)
      expect(src, rel).toMatch(/sessionData\.stderrStartOffset = stderrStartOffset/)
      expect(src, rel).toMatch(/const stderrStartOffset = fs\.fstatSync\(stderrFd\)\.size/)
    }
  })
})
