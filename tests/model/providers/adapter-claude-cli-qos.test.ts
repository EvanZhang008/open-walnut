/**
 * The claude-cli adapter runs a BACKGROUND turn (AdapterCallOptions.purpose:
 * a title, a summary, a placement) through the utility QoS clamp when the
 * deploy raised the server above that band (src/lib/background-qos.ts), and
 * leaves a turn someone waits on in the server's band.
 *
 * The clamp program is a stand-in that records its argv and execs the rest, and
 * `claude` is a fake script that answers one stream-json result line.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClaudeCliAdapter } from '../../../src/model/providers/adapter-claude-cli.js'
import type { AdapterCallOptions } from '../../../src/model/providers/types.js'
import {
  QOS_CLAMP_ENV,
  _resetQosClampRequestForTest,
  _setQosClampProgramForTest,
  takeQosClampRequest,
} from '../../../src/lib/background-qos.js'

let dir = ''
let fake = ''
let clampLog = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-cli-qos-'))
  fake = path.join(dir, 'fake-claude.sh')
  fs.writeFileSync(fake, `#!/usr/bin/env bash
cat >/dev/null
echo '{"type":"result","subtype":"success","result":"Short title","usage":{"input_tokens":3,"output_tokens":2}}'
`, { mode: 0o755 })
  clampLog = path.join(dir, 'clamp.log')
  const program = path.join(dir, 'clamp-stand-in')
  fs.writeFileSync(program, `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(clampLog)}
[[ "$1" == -c && "$2" == utility ]] || exit 64
shift 2
exec "$@"
`, { mode: 0o755 })
  _setQosClampProgramForTest(program)
  _resetQosClampRequestForTest()
})

afterEach(() => {
  _setQosClampProgramForTest(null)
  _resetQosClampRequestForTest()
  fs.rmSync(dir, { recursive: true, force: true })
})

const call = (purpose?: AdapterCallOptions['purpose']): AdapterCallOptions => ({
  providerConfig: { api: 'claude-cli', claude_cli_command: fake },
  model: 'haiku', maxTokens: 64, system: 'Title the session.',
  messages: [{ role: 'user', content: 'fix the login retry' }],
  ...(purpose ? { purpose } : {}),
})

const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((b) => b.text ?? '').join('')
const clampCalls = () => (fs.existsSync(clampLog) ? fs.readFileSync(clampLog, 'utf8').split('\n').filter(Boolean) : [])

describe('claude-cli adapter and the QoS clamp', () => {
  it('a background turn starts behind the clamp when the server asked for it', async () => {
    expect(takeQosClampRequest({ [QOS_CLAMP_ENV]: '1' })).toBe(true)
    const r = await new ClaudeCliAdapter().sendMessage(call('background'))
    expect(textOf(r)).toBe('Short title')
    const calls = clampCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].startsWith(`-c utility ${fake} -p `)).toBe(true)
  })

  it('a turn someone waits on keeps the server band, asked or not', async () => {
    expect(takeQosClampRequest({ [QOS_CLAMP_ENV]: '1' })).toBe(true)
    const adapter = new ClaudeCliAdapter()
    expect(textOf(await adapter.sendMessage(call()))).toBe('Short title')
    expect(textOf(await adapter.sendMessageStream(call('interactive')))).toBe('Short title')
    expect(clampCalls()).toEqual([])
  })

  it('the fresh-session retry after a failed resume keeps the turn\'s purpose', async () => {
    // A CLI that has lost every session: --resume exits 1 with no output.
    fs.writeFileSync(fake, `#!/usr/bin/env bash
cat >/dev/null
for a in "$@"; do [ "$a" = --resume ] && exit 1; done
echo '{"type":"result","subtype":"success","result":"Short title","usage":{"input_tokens":3,"output_tokens":2}}'
`, { mode: 0o755 })
    expect(takeQosClampRequest({ [QOS_CLAMP_ENV]: '1' })).toBe(true)
    const adapter = new ClaudeCliAdapter()
    const first = call('background')
    expect(textOf(await adapter.sendMessage(first))).toBe('Short title')
    // The same conversation, one exchange longer: the adapter resumes, the
    // resume fails, and it replays the history in a fresh session.
    const next: AdapterCallOptions = {
      ...first,
      messages: [...first.messages, { role: 'assistant', content: 'Short title' }, { role: 'user', content: 'and the logout retry' }],
    }
    expect(textOf(await adapter.sendMessage(next))).toBe('Short title')
    const calls = clampCalls()
    expect(calls).toHaveLength(3)
    expect(calls[1]).toContain(' --resume ')
    expect(calls[2]).toContain(' --session-id ')
  })

  it('a background turn is not clamped when the server was not raised (a terminal or the Mac app)', async () => {
    expect(takeQosClampRequest({})).toBe(false)
    expect(textOf(await new ClaudeCliAdapter().sendMessage(call('background')))).toBe('Short title')
    expect(clampCalls()).toEqual([])
  })
})
