/**
 * A session whose Walnut MCP server went away is counted once per drop (usage-watch/mount-watch.ts).
 *
 * 2026-11-25 audit: Main resumed with "119 deferred tools are no longer available (MCP server
 * disconnected)" and `usage_watch` had no row; the MCP server cannot tell of its own end. Claude
 * Code's `mcp_status` at each turn end is judged here. A role's shorter list is a whole list, never
 * a drop (8 sessions moved to 84 to 88 tools that day: the worker and thread_keeper lists).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeUsageWatchStore, readToolErrors, setUsageWatchFile } from '../../../src/core/usage-watch/store.js'
import { _resetUsageRecorderForTesting, flushUsage } from '../../../src/core/usage-watch/record.js'
import { judgeWalnutMount, recordToolsGone, TOOLS_GONE_CODE, walnutMountStatus, type MountSeen } from '../../../src/core/usage-watch/mount-watch.js'
import { SHORT_LIST_OP } from '../../../src/core/usage-watch/gateway-record.js'

const status = (walnut: Record<string, unknown> | null) => ({ mcpServers: [{ name: 'other', status: 'connected' }, ...(walnut ? [{ name: 'walnut', ...walnut }] : [])] })

describe('what a turn end\'s mcp_status says of the mount', () => {
  it('connected is no drop; failed, absent and connected with no tool are', () => {
    expect(judgeWalnutMount(undefined, 1, status({ status: 'connected' })).gone).toBeUndefined()
    expect(judgeWalnutMount(undefined, 1, status({ status: 'connected', tools: [{ name: 'task_get' }] })).gone).toBeUndefined()
    expect(judgeWalnutMount(undefined, 1, status({ status: 'failed' })).gone).toBe('failed')
    expect(judgeWalnutMount(undefined, 1, status({ status: 'needs-auth' })).gone).toBe('needs-auth')
    expect(judgeWalnutMount(undefined, 1, status(null)).gone).toBe('absent')
    expect(judgeWalnutMount(undefined, 1, status({ status: 'connected', tools: [] })).gone).toBe('no_tools')
  })

  it('a mount turned off, or an answer that names no list, judges nothing', () => {
    expect(judgeWalnutMount(undefined, 1, status({ status: 'disabled' })).gone).toBeUndefined()
    expect(judgeWalnutMount(undefined, 1, null).gone).toBeUndefined()
    expect(judgeWalnutMount(undefined, 1, { error: 'unknown subtype' }).gone).toBeUndefined()
    expect(walnutMountStatus({ mcpServers: 'x' })).toBeNull()
  })

  it('pending at one turn end is a handshake; at the next one of the same process, a turn ran without it', () => {
    const a = judgeWalnutMount(undefined, 1, status({ status: 'pending' }))
    expect(a.gone).toBeUndefined()
    expect(judgeWalnutMount(a.seen, 1, status({ status: 'pending' })).gone).toBe('pending')
    // A new process starts its own handshake.
    expect(judgeWalnutMount(a.seen, 2, status({ status: 'pending' })).gone).toBeUndefined()
    // Connected in between: the next pending is a first one again.
    const up = judgeWalnutMount(a.seen, 1, status({ status: 'connected' }))
    expect(judgeWalnutMount(up.seen, 1, status({ status: 'pending' })).gone).toBeUndefined()
  })

  it('one drop counts once; seen connected again, the next drop counts; a new process\'s drop counts', () => {
    let seen: MountSeen | undefined
    const turn = (pid: number, s: Record<string, unknown> | null) => { const r = judgeWalnutMount(seen, pid, status(s)); seen = r.seen; return r.gone }
    expect(turn(7, { status: 'failed' })).toBe('failed')
    expect(turn(7, { status: 'failed' })).toBeUndefined()
    expect(turn(7, { status: 'connected' })).toBeUndefined()
    expect(turn(7, { status: 'failed' })).toBe('failed')
    expect(turn(8, { status: 'failed' })).toBe('failed')
  })
})

describe('the drop in usage_watch', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-watch-'))
    setUsageWatchFile(path.join(dir, 'usage-watch.sqlite'))
    _resetUsageRecorderForTesting(true, Date.now() - 3_600_000)
  })
  afterEach(() => {
    closeUsageWatchStore()
    setUsageWatchFile(null)
    _resetUsageRecorderForTesting(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a failed tools/list of the session, code tools_gone; a runner that just re-attached takes a recent row for it', () => {
    const sid = '3ea08ceb-37c2-4adc-86ea-2ef5b6fb8446'
    expect(recordToolsGone({ sid, taskId: 'mtask-main', host: '__local__', why: 'failed' })).toBe(true)
    flushUsage()
    // A server restart: the runner knows nothing yet and sees the same drop.
    expect(recordToolsGone({ sid, host: null, why: 'failed', fresh: true })).toBe(false)
    // A runner that saw it connected and then a new drop counts it.
    expect(recordToolsGone({ sid, host: null, why: 'failed' })).toBe(true)
    flushUsage()
    expect(readToolErrors({ since: 0, limit: 10 }).map((r) => [r.sid, r.op, r.code, r.client, r.host])).toEqual([
      [sid, SHORT_LIST_OP, TOOLS_GONE_CODE, 'mcp', 'local'],
      [sid, SHORT_LIST_OP, TOOLS_GONE_CODE, 'mcp', 'local'],
    ])
  })
})
