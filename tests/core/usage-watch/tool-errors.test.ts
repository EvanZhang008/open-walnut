/**
 * Failed Walnut tool calls by session, op, code and host (src/core/usage-watch/tool-errors.ts).
 *
 * 2026-11-23, the daily audit asked for tool and op errors readable by session, by op and by error
 * code, Mac and clouddev, without reading raw JSONL. The session hook sees every session's tool
 * results on every host, so it counts what the server never saw too: Walnut unreachable from the
 * client, a tool gone after the MCP link dropped, Claude Code refusing the input. Codes only.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeUsageWatchStore, pruneStore, readEvents, readToolErrors, setUsageWatchFile } from '../../../src/core/usage-watch/store.js'
import { _resetUsageRecorderForTesting, flushUsage, recordToolError } from '../../../src/core/usage-watch/record.js'
import { toolErrorCode, walnutToolCall } from '../../../src/core/usage-watch/normalize.js'
import { runUsageWatchAction } from '../../../src/core/usage-watch/actions.js'
import { deriveSessionHookPoints } from '../../../src/core/session-hooks/derive/session.js'
import { EventNames } from '../../../src/core/event-bus.js'

let dir: string
const ctx = { callerTask: null, taskInfo: async () => null }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-errors-'))
  setUsageWatchFile(path.join(dir, 'usage-watch.sqlite'))
  _resetUsageRecorderForTesting(true)
})

afterEach(() => {
  closeUsageWatchStore()
  setUsageWatchFile(null)
  _resetUsageRecorderForTesting(false)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the code of a failed call, from what the agent read', () => {
  it('reads the CLI\'s failure JSON, the MCP server\'s line and Claude Code\'s own refusals', () => {
    expect(toolErrorCode('Exit code 3\n{\n  "ok": false,\n  "error": {\n    "code": "hub_unreachable",\n    "message": "x"\n  }\n}')).toBe('hub_unreachable')
    expect(toolErrorCode('walnut: internal: Walnut API error (not_request_target): request rq-80da2e51ba47 was not addressed')).toBe('not_request_target')
    expect(toolErrorCode('walnut: hub_timeout: the server did not answer')).toBe('hub_timeout')
    expect(toolErrorCode('walnut: bad_request: Invalid arguments for search: (root): Unrecognized key: "query"')).toBe('bad_args')
    expect(toolErrorCode('<tool_use_error>Error: No such tool available: mcp__walnut__task_get</tool_use_error>')).toBe('no_such_tool')
    expect(toolErrorCode('<tool_use_error>InputValidationError: task_get failed due to the following issue')).toBe('client_bad_args')
    expect(toolErrorCode('MCP error -32001: Request timed out')).toBe('mcp_timeout')
    expect(toolErrorCode('MCP error -32000: Connection closed')).toBe('mcp_disconnected')
    expect(toolErrorCode('Exit code 127\nzsh: command not found: walnut')).toBe('cli_missing')
    expect(toolErrorCode('Something else went wrong')).toBe('other')
  })

  it('a code is a short token, never the text', () => {
    expect(toolErrorCode('{"code": "Not A Code with spaces"}')).toBe('other')
    expect(toolErrorCode('x'.repeat(5000))).toBe('other')
  })
})

describe('the session hook counts every failed Walnut call it reads', () => {
  it('records session, task, host, op, client and code, and skips a replayed line and a non-Walnut tool', async () => {
    const { realUseHook, _resetRealUseHookForTesting } = await import('../../../src/core/usage-watch/session-hook.js')
    _resetRealUseHookForTesting()
    const base = { taskId: 'task-1', sessionId: 'sess-cloud', session: { host: 'clouddev' } }
    const use = (toolName: string, toolUseId: string, input: Record<string, unknown> = {}) =>
      realUseHook.handler!({ ...base, toolName, toolUseId, input } as never)
    const result = (toolUseId: string, text: string, more: Record<string, unknown> = {}) =>
      realUseHook.handler!({ ...base, toolUseId, result: text, ...more } as never)
    await use('mcp__walnut__task_get', 'u1')
    await result('u1', '<tool_use_error>Error: No such tool available: mcp__walnut__task_get</tool_use_error>', { isError: true })
    await use('Bash', 'u2', { command: 'walnut tools call task_history \'{"id":"x"}\' 2>/dev/null' })
    await result('u2', 'Exit code 3\n{"ok":false,"error":{"code":"hub_unreachable","message":"down"}}', { isError: true })
    // A result read again after a restart, a call that worked, and another server's tool: not counted.
    await use('mcp__walnut__search', 'u3')
    await result('u3', 'walnut: hub_timeout: x', { isError: true, replayed: true })
    await use('mcp__walnut__search', 'u4')
    await result('u4', '{"ok":true}')
    await use('mcp__other__read', 'u5')
    await result('u5', 'MCP error -32000: Connection closed', { isError: true })
    // A shell line whose walnut call worked and whose pipe failed after it is not Walnut's failure.
    await use('Bash', 'u6', { command: 'walnut tools call task_get \'{"id":"x"}\' | python3 -c "import json,sys; json.load(sys.stdin)[\'nope\']"' })
    await result('u6', 'Exit code 1\nTraceback (most recent call last):\nKeyError: \'nope\'', { isError: true })
    flushUsage(Date.now() + 60_000)
    const rows = readToolErrors({ since: 0 }).sort((a, b) => a.op.localeCompare(b.op))
    expect(rows.map(({ at: _at, ...r }) => r)).toEqual([
      { sid: 'sess-cloud', taskId: 'task-1', host: 'clouddev', op: 'task_get', client: 'mcp', code: 'no_such_tool' },
      { sid: 'sess-cloud', taskId: 'task-1', host: 'clouddev', op: 'task_history', client: 'cli', code: 'hub_unreachable' },
    ].sort((a, b) => a.op.localeCompare(b.op)))
  })

  it('the hook point carries whether the call failed and whether the line was read before', () => {
    const event = { name: EventNames.SESSION_TOOL_RESULT, data: { sessionId: 's', toolUseId: 't', result: 'x', isError: true, replayed: true } }
    const points = deriveSessionHookPoints(event as never, new Map(), () => {})
    expect(points[0]?.extraPayload).toMatchObject({ toolUseId: 't', isError: true, replayed: true })
  })
})

describe('a cut counts for an op only when what was cut was its answer', () => {
  // 2026-11-23: `walnut tools call task_history '{..}' > /tmp/x 2>&1; python3 - <<EOF` printed
  // 16 KB from the python, and it was counted as task_history's answer cut.
  const bash = (command: string) => walnutToolCall('Bash', { command })
  it('reads where the walnut call\'s output went', () => {
    expect(bash("walnut tools call task_get '{\"id\":\"x\"}'")).toEqual({ op: 'task_get', answered: true })
    expect(bash("walnut tools call task_get '{}' 2>&1")).toEqual({ op: 'task_get', answered: true })
    expect(bash("walnut tools call task_get '{}' 2>/dev/null")).toEqual({ op: 'task_get', answered: true })
    expect(bash("walnut tools call task_get '{}' >&2")).toEqual({ op: 'task_get', answered: true })
    expect(bash("cd /x && walnut tools call task_get '{}' || echo failed")).toEqual({ op: 'task_get', answered: true })
    for (const away of [
      "walnut tools call task_history '{}' > /tmp/h.json 2>&1; python3 - <<'EOF'\nprint(1)\nEOF",
      "walnut tools call task_history '{}' >/tmp/h.json",
      "walnut tools call task_history '{}' >> /tmp/h.json",
      "walnut tools call task_history '{}' 1>/tmp/h.json",
      "walnut tools call task_history '{}' &>/tmp/h.json",
      "walnut tools call task_history '{}' | python3 -c 'import json,sys; print(json.load(sys.stdin))'",
      "walnut tools call task_history '{}' 2>&1 | tee /tmp/h.json",
      "walnut tools call task_history '{\"id\":\"x\",\"_full\":true}'",
    ]) expect(bash(away), away).toEqual({ op: 'task_history', answered: false })
    expect(walnutToolCall('mcp__walnut__task_history', { id: 'x', _full: true })).toEqual({ op: 'task_history', answered: false })
    expect(walnutToolCall('mcp__walnut__task_history', { id: 'x' })).toEqual({ op: 'task_history', answered: true })
  })

  it('the session hook counts the op\'s own cut and skips the others', async () => {
    const { realUseHook, _resetRealUseHookForTesting } = await import('../../../src/core/usage-watch/session-hook.js')
    _resetRealUseHookForTesting()
    const base = { taskId: 'task-1', sessionId: 's', session: { host: 'local' } }
    const persisted = '<persisted-output>\nOutput too large (16.6KB). Full output saved to: /tmp/x.txt'
    const run = async (id: string, toolName: string, input: Record<string, unknown>) => {
      await realUseHook.handler!({ ...base, toolName, toolUseId: id, input } as never)
      await realUseHook.handler!({ ...base, toolUseId: id, result: persisted } as never)
    }
    await run('c1', 'Bash', { command: "walnut tools call task_history '{\"id\":\"x\"}' > /tmp/h.json 2>&1; python3 - <<'EOF'\nprint('x' * 17000)\nEOF" })
    await run('c2', 'Bash', { command: "walnut tools call task_history '{\"id\":\"x\",\"_full\":true}'" })
    await run('c3', 'mcp__walnut__task_history', { id: 'x', _full: true })
    await run('c4', 'Bash', { command: "walnut tools call task_get '{\"id\":\"x\"}' 2>&1" })
    flushUsage(Date.now() + 60_000)
    expect(readEvents({ since: 0 }).filter((e) => e.problem === 'cut').map((e) => [e.name, e.code])).toEqual([['task_get', 'cut_cli']])
  })
})

describe('usage_watch errors reads them grouped', () => {
  const at = Date.parse('2026-11-23T10:00:00Z')
  const seed = () => {
    const add = (sid: string, host: string, op: string, code: string, ago: number) =>
      recordToolError({ at: at - ago, sid, taskId: `task-${sid}`, host, op, client: 'mcp', code })
    add('s-mac', 'local', 'search', 'bad_args', 60_000)
    add('s-mac', 'local', 'search', 'bad_args', 120_000)
    add('s-cloud', 'clouddev', 'task_history', 'hub_unreachable', 180_000)
    add('s-cloud', 'clouddev', 'task_get', 'no_such_tool', 240_000)
    add('s-old', 'clouddev', 'task_get', 'no_such_tool', 3 * 86_400_000)
    flushUsage(at)
  }

  it('by op, by code, by session and by host, over the range asked', async () => {
    seed()
    const byOp = await runUsageWatchAction({ action: 'errors', range: '24h' }, { ...ctx, now: at }) as { total: number; rows: { key: string; errors: number; codes?: Record<string, number> }[]; hosts: Record<string, number> }
    expect(byOp.total).toBe(4)
    expect(byOp.rows.map((r) => [r.key, r.errors])).toEqual([['search', 2], ['task_history', 1], ['task_get', 1]])
    expect(byOp.rows[0]!.codes).toEqual({ bad_args: 2 })
    expect(byOp.hosts).toEqual({ local: 2, clouddev: 2 })
    const byCode = await runUsageWatchAction({ action: 'errors', by: 'code' }, { ...ctx, now: at }) as { total: number; rows: { key: string; errors: number }[] }
    expect(byCode.total).toBe(5)
    expect(byCode.rows.map((r) => [r.key, r.errors])).toEqual([['bad_args', 2], ['no_such_tool', 2], ['hub_unreachable', 1]])
    const bySession = await runUsageWatchAction({ action: 'errors', by: 'session', range: '24h' }, { ...ctx, now: at }) as { rows: { key: string; task?: string; host?: string }[] }
    expect(bySession.rows.map((r) => [r.key, r.task, r.host])).toEqual([['s-mac', 'task-s-mac', 'local'], ['s-cloud', 'task-s-cloud', 'clouddev']])
    const byHost = await runUsageWatchAction({ action: 'errors', by: 'host', range: '24h' }, { ...ctx, now: at }) as { rows: { key: string; errors: number }[] }
    expect(byHost.rows.map((r) => [r.key, r.errors])).toEqual([['local', 2], ['clouddev', 2]])
  })

  it('one session, by its id, its task\'s id or their start, with its failures one by one', async () => {
    seed()
    for (const session of ['s-cloud', 'task-s-cl']) {
      const r = await runUsageWatchAction({ action: 'errors', session, range: '24h' }, { ...ctx, now: at }) as { total: number; recent: { op: string; code: string }[] }
      expect(r.total, session).toBe(2)
      expect(r.recent.map((e) => [e.op, e.code])).toEqual([['task_history', 'hub_unreachable'], ['task_get', 'no_such_tool']])
    }
  })

  it('the op offers exactly the groupings the report has', async () => {
    const { getOp } = await import('../../../src/ops/index.js')
    const { ERROR_GROUPS } = await import('../../../src/core/usage-watch/tool-errors.js')
    const by = getOp('usage_watch')!.input.by as unknown as { unwrap: () => { options: string[] } }
    expect([...by.unwrap().options].sort()).toEqual([...ERROR_GROUPS].sort())
  })

  it('refuses a grouping it does not have, and the store keeps 14 days', async () => {
    await expect(runUsageWatchAction({ action: 'errors', by: 'words' }, ctx)).rejects.toMatchObject({ code: 'bad_by' })
    recordToolError({ at: Date.now() - 15 * 86_400_000, sid: 's', host: 'local', op: 'x', client: 'mcp', code: 'other' })
    recordToolError({ sid: 's', host: 'local', op: 'y', client: 'mcp', code: 'other' })
    flushUsage(Date.now())
    pruneStore(Date.now())
    expect(readToolErrors({ since: 0 }).map((r) => r.op)).toEqual(['y'])
  })
})
