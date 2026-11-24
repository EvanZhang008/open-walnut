/**
 * The reply-language send gate end to end: the real server says what the gate holds words to
 * (GET /api/v1/me/reply-language: the setting and the experiment), the op executor refuses a
 * session's English message before it leaves, a person's and Chinese go out, and the AskUserQuestion
 * hook denies an English question through reply_language_check. A chat reply is never judged: no
 * Stop hook carries the check (tests/core/hints/no-reply-language-reminder.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { guardedPath } from '../../setup/exec-guard.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reply-language-gate'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { executeOp } from '../../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../../src/lib/caller-origin.js'
import { _resetGateSettingCache } from '../../../src/ops/reply-language-gate.js'
import { handleGatewayCapability } from '../../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../../src/core/peers/peer-throttle.js'
import { REPLY_LANGUAGE_HOOK_COMMAND, replyLanguageHooks } from '../../../src/providers/reply-language-hook.js'
import { sessionSettingsHooks } from '../../../src/providers/session-settings-hooks.js'
import '../../../src/ops/index.js'

const RULE = 'Talk to the user in Chinese.'
const EN = 'Landed and pushed; production serves the new build now and the deep test is green again.'
const CN = '\u8fd9\u4e00\u7248\u5df2\u7ecf\u4e0a\u7ebf\uff0c\u751f\u4ea7\u73af\u5883\u5728\u8dd1\u65b0\u4ee3\u7801\uff0c\u6df1\u5ea6\u6d4b\u8bd5\u4e5f\u662f\u7eff\u7684\u3002'
const SID = '3ccf06d9-dbdd-49a1-ab98-000000000001'

let server: HttpServer
let base = ''
beforeAll(async () => {
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${addr.port}/api/v1`
}, 60_000)
afterAll(async () => {
  await stopServer()
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
})
beforeEach(() => _resetGateSettingCache())

async function setting(rule: string | null, on: boolean): Promise<void> {
  await updateConfig({ session: { reply_language: rule ?? '' }, experimental: { reply_language_gate: on } } as never)
}
/** A session agent's own tool call (its MCP tool): the only call the gate judges. */
const AGENT = { callerSid: SID, forAgent: 'mcp' } as const
const send = (text: string, opts: Record<string, unknown> = AGENT) =>
  executeOp('task_send', { to: 'no-such-task-0000', title: 'x', text }, { origin: LOCAL_ORIGIN, apiBase: base, ...opts })
const refused = (r: { ok: boolean; message?: string }) => !r.ok && /was not sent: the user reads it/.test(r.message ?? '')

describe('the route', () => {
  it('names the script while the setting names a language and the experiment is on', async () => {
    await setting(RULE, true)
    expect(await (await fetch(`${base}/me/reply-language`)).json()).toEqual({ rule: RULE, script: 'han', on: true })
    await setting(RULE, false)
    expect(await (await fetch(`${base}/me/reply-language`)).json()).toEqual({ rule: RULE, script: null, on: false })
    await setting(null, true)
    expect(await (await fetch(`${base}/me/reply-language`)).json()).toEqual({ rule: null, script: null, on: true })
  })
})

describe('the executor', () => {
  it('refuses a session\'s English message and lets its Chinese one through', async () => {
    await setting(RULE, true)
    const en = await send(EN)
    expect(refused(en), JSON.stringify(en)).toBe(true)
    expect(en).toMatchObject({ ok: false, invalidArgs: true, code: 'reply_language' })
    const cn = await send(CN)
    expect(refused(cn), JSON.stringify(cn)).toBe(false)
  })

  it('refuses the same words sent through the api passthrough', async () => {
    await setting(RULE, true)
    const r = await executeOp('api', { method: 'POST', path: '/api/v1/messages', body: { to: 'no-such-task-0000', text: EN } }, { origin: LOCAL_ORIGIN, apiBase: base, ...AGENT })
    expect(refused(r), JSON.stringify(r)).toBe(true)
  })

  it('never holds a person, nor anyone while the experiment is off or the setting is empty', async () => {
    await setting(RULE, true)
    expect(refused(await send(EN, { callerMode: 'human' }))).toBe(false)
    await setting(RULE, false)
    _resetGateSettingCache()
    expect(refused(await send(EN))).toBe(false)
    await setting(null, true)
    _resetGateSettingCache()
    expect(refused(await send(EN))).toBe(false)
  })

  // 2026-11-24: the git push gate's `walnut approve "Push commit <sha> to <remote> <branch> in <repo>"`
  // ran inside a session's shell, carried its id, and was refused, so no push could be approved.
  it('never judges a program\'s fixed text: `walnut approve`, a check script, a replayed write', async () => {
    await setting(RULE, true)
    const ask = { what: 'Push commit 1a2b3c4 to origin main in walnut', why: 'the push gate asks before every push', timeout_ms: 60_000, request_only: true }
    // `walnut approve` on the Mac (commands/approve.ts) and a held write replayed later
    // (offline-handover.ts) name the session but no agent surface.
    const program = await executeOp('approval_request', ask, { origin: LOCAL_ORIGIN, apiBase: base, callerSid: SID })
    expect(refused(program), JSON.stringify(program)).toBe(false)
    expect(refused(await send(EN, { callerSid: SID }))).toBe(false)
    // The same words from the agent's own tool call are its words, and are held.
    expect(refused(await executeOp('approval_request', ask, { origin: LOCAL_ORIGIN, apiBase: base, ...AGENT }))).toBe(true)
  })

  it('through a host\'s gateway, judges the agent\'s tool call and never wn-cli\'s own loop (`walnut approve` on a host)', async () => {
    await setting(RULE, true)
    const saved = process.env.OPEN_WALNUT_API_URL
    process.env.OPEN_WALNUT_API_URL = base.replace(/\/api\/v1$/, '')
    try {
      const call = (client: string) => handleGatewayCapability('tools.call', SID, { name: 'task_send', args: { to: 'no-such-task-0000', text: EN }, client }, '__local__', { throttle: new PeerThrottle(), cloudMode: false })
      const viaGateway = (r: unknown) => /was not sent: the user reads it/.test(JSON.stringify(r))
      expect(viaGateway(await call('cli'))).toBe(true)
      expect(viaGateway(await call('program'))).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.OPEN_WALNUT_API_URL; else process.env.OPEN_WALNUT_API_URL = saved
    }
  })

  it('answers a retry of a call that went out from the ledger, never judging it again', async () => {
    await setting(RULE, false)
    _resetGateSettingCache()
    const callId = 'oc-0000000000000000000000000000000a'
    const first = await send(EN, { ...AGENT, callId })
    expect(refused(first)).toBe(false)
    await setting(RULE, true)
    _resetGateSettingCache()
    const again = await send(EN, { ...AGENT, callId })
    expect(refused(again), JSON.stringify(again)).toBe(false)
    expect(refused(await send(EN, { ...AGENT, callId: 'oc-0000000000000000000000000000000b' }))).toBe(true)
  })

  it('lets the send go when no server answers the setting', async () => {
    const r = await executeOp('task_send', { to: 'x', text: EN }, { origin: LOCAL_ORIGIN, apiBase: 'http://127.0.0.1:9/api/v1', ...AGENT })
    expect(refused(r)).toBe(false)
  })
})

describe('the AskUserQuestion hook', () => {
  it('reply_language_check denies an English question and passes a Chinese one', async () => {
    await setting(RULE, true)
    const ask = (question: string) => executeOp('reply_language_check', { hook_input: { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question, header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }] }] } } }, { origin: LOCAL_ORIGIN, apiBase: base, callerSid: SID })
    const en = await ask(EN) as { result: { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } }
    expect(en.result.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(en.result.hookSpecificOutput?.permissionDecisionReason).toMatch(/^Your question to the user \(AskUserQuestion\) was not sent/)
    expect((await ask(CN) as { result: unknown }).result).toEqual({})
    const draft = await executeOp('reply_language_check', { text: EN }, { origin: LOCAL_ORIGIN, apiBase: base, callerSid: SID }) as { result: { passes: boolean; note: string | null } }
    expect(draft.result.passes).toBe(false)
    expect(draft.result.note).toMatch(/^This text was not sent/)
  })

  it('pipes its input on stdin and prints only a deny answer', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-lang-hook-'))
    try {
      fs.mkdirSync(path.join(root, 'bin'))
      const got = path.join(root, 'stdin.json')
      const run = (answer: string, env: Record<string, string> = {}) => {
        fs.rmSync(got, { force: true })
        fs.writeFileSync(path.join(root, 'bin', 'walnut'), `#!/bin/sh\ncat > '${got}'\nprintf '%s\\n' '${answer}'\n`, { mode: 0o755 })
        const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: EN }] } })
        const r = spawnSync('/bin/sh', ['-c', REPLY_LANGUAGE_HOOK_COMMAND], { input, encoding: 'utf8', env: { PATH: guardedPath([], `${path.join(root, 'bin')}:/usr/bin:/bin`), HOME: root, ...env } })
        expect(r.status, r.stderr).toBe(0)
        return { out: r.stdout.trim(), stdin: fs.existsSync(got) ? fs.readFileSync(got, 'utf8') : '' }
      }
      const deny = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"r"}}'
      const r = run(deny)
      expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe('deny')
      expect((JSON.parse(r.stdin) as { hook_input: { tool_name: string } }).hook_input.tool_name).toBe('AskUserQuestion')
      expect(run('{}').out).toBe('')
      expect(run('Unknown op: reply_language_check').out).toBe('')
      expect(run(deny, { WALNUT_REPLY_LANGUAGE_GATE: '0' })).toEqual({ out: '', stdin: '' })
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('rides every session\'s hooks on AskUserQuestion only, never at Stop', () => {
    const cmds = (h: Record<string, unknown> | null, event: string) =>
      ((h?.[event] as Array<{ matcher?: string; hooks: Array<{ command: string }> }> | undefined) ?? []).flatMap((g) => g.hooks.map((x) => ({ matcher: g.matcher, command: x.command })))
    expect(cmds(sessionSettingsHooks({}), 'PreToolUse').filter((c) => c.command === REPLY_LANGUAGE_HOOK_COMMAND).map((c) => c.matcher)).toEqual(['AskUserQuestion'])
    expect(cmds(sessionSettingsHooks({}, { subagent: true }), 'PreToolUse').some((c) => c.command === REPLY_LANGUAGE_HOOK_COMMAND)).toBe(true)
    expect(cmds(sessionSettingsHooks({}), 'Stop').some((c) => /reply_language/.test(c.command))).toBe(false)
    expect(replyLanguageHooks({ WALNUT_REPLY_LANGUAGE_GATE: '0' })).toBeNull()
  })
})
