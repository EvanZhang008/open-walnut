/**
 * Plugin trigger templates through the real server
 * (src/core/routines/trigger-templates.ts, src/web/routes/trigger-templates-v1.ts).
 *
 * A template is registered the way a plugin's `walnut.registry.triggerTemplate`
 * does it. Driven here: the list and options routes, arming one with
 * POST /routines/trigger {template, params} (what the composer's picker and the
 * agent's trigger_create send), the host policy exemption for a session on
 * another host, the check route the stored command calls, and the stored
 * command itself (`walnut trigger-check`) run as a real child process (its HTTP
 * fallback; the gateway path is tests/unit/peers/wn-cli-trigger-check.test.ts).
 *
 * The daemon lookup is stubbed: nothing is armed on a real daemon.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-trigger-templates-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { setTriggerDaemonLookupForTest, type TriggerDaemon } from '../../src/core/routines/trigger-daemon.js'
import { registerTriggerTemplate, type TriggerTemplateCheckInput, type TriggerTemplateDefinition } from '../../src/core/routines/trigger-templates.js'
import { executeOp } from '../../src/ops/index.js'
import { addTask } from '../../src/core/task-manager.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { ORIGIN_HEADER, hostOrigin } from '../../src/lib/caller-origin.js'
import type { Disposable } from '../../src/core/plugins/disposable.js'

const REPO = path.resolve(import.meta.dirname, '../..')
const TSX = path.join(REPO, 'node_modules/.bin/tsx')
const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const REMOTE_SID = 'c0ffee00-aaaa-bbbb-cccc-444455556666'
const HOST = hostOrigin('remote-dev')

let server: HttpServer
let port = 0
let daemon: MockDaemon
let taskId = ''
let registration: Disposable
const lookups: string[] = []
const checkCalls: Array<{ params: Record<string, string>; input: TriggerTemplateCheckInput }> = []

function fakeDaemon(host: string): TriggerDaemon {
  return {
    host,
    hasCapability: (cap) => cap === 'triggers-v1',
    triggersPushed: true,
    async send() { return { ok: true } },
  }
}

type Reply = { status: number; json: any }
async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const CHANNELS = [
  { id: 'C0AAAAAAA', name: 'eng-oncall' },
  { id: 'C0BBBBBBB', name: "o'brien-team" },
  // Unicode data: e-acute and two CJK characters.
  { id: 'C0CCCCCCC', name: 'caf\u00e9-\u4e2d\u6587' },
]

const CHAT_DEF: TriggerTemplateDefinition = {
  id: 'channel-message',
  title: 'New message in a channel',
  description: 'Fires on each new message in a channel.',
  every: '5m',
  maxFiresPerDay: 288,
  params: [
    { key: 'channel', label: 'Channel', required: true, options: true },
    { key: 'contains', label: 'Contains' },
  ],
  prepare(params) {
    const wanted = params.channel.replace(/^#/, '')
    const channel = CHANNELS.find((c) => c.id === wanted || c.name === wanted)
    if (!channel) throw new Error(`No channel "#${wanted}"`)
    return {
      params: { ...params, channel: channel.id },
      label: `#${channel.name}: new messages`,
      description: `Watches #${channel.name} for new messages`,
      prompt: `Read each new message in #${channel.name}.`,
    }
  },
  options(_key, query) {
    return CHANNELS.filter((c) => c.name.includes(query)).map((c) => ({ value: c.id, label: `#${c.name}` }))
  },
  async check(params, input) {
    checkCalls.push({ params, input })
    if (params.channel === 'C0BBBBBBB') throw new Error('workspace refused the read')
    if (!input.state) return { fire: false, state: { ts: '100' } }
    return { fire: true, items: [{ id: `${params.channel}:101`, title: 'alice: hello' }], state: { ts: '101' } }
  },
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  setTriggerDaemonLookupForTest((host) => { lookups.push(host); return fakeDaemon(host) })
  taskId = (await addTask({ title: 'Template trigger target' })).task.id
  await createSessionRecord(REMOTE_SID, taskId, '', '/home/me/marina', { host: 'remote-dev' })
  registration = registerTriggerTemplate('chatdemo', 'Chat Demo', CHAT_DEF)
}, 60_000)

afterAll(async () => {
  registration?.dispose()
  setTriggerDaemonLookupForTest(null)
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('listing', () => {
  it('lists the template with its params and defaults', async () => {
    const r = await call('GET', '/api/v1/trigger-templates')
    expect(r.status).toBe(200)
    expect(r.json.templates).toEqual([expect.objectContaining({
      id: 'chatdemo:channel-message', pluginId: 'chatdemo', pluginName: 'Chat Demo',
      title: 'New message in a channel', every: '5m', maxFiresPerDay: 288,
    })])
    expect(r.json.templates[0].params.map((p: { key: string }) => p.key)).toEqual(['channel', 'contains'])
  })

  it('answers the choices for a param, filtered, and nothing for a param without choices', async () => {
    const r = await call('GET', '/api/v1/trigger-templates/chatdemo%3Achannel-message/options?param=channel&q=eng')
    expect(r.json.options).toEqual([{ value: 'C0AAAAAAA', label: '#eng-oncall' }])
    const none = await call('GET', '/api/v1/trigger-templates/chatdemo%3Achannel-message/options?param=contains&q=')
    expect(none.json.options).toEqual([])
    const unknown = await call('GET', '/api/v1/trigger-templates/nope%3Ax/options?param=channel')
    expect(unknown.status).toBe(404)
  })

  it('trigger_templates names the template and how to arm it', async () => {
    const r = await executeOp('trigger_templates', {}, { apiBase: `http://127.0.0.1:${port}/api/v1`, origin: '__local__' })
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r)).toContain('chatdemo:channel-message')
    const opts = await executeOp('trigger_templates', { template: 'chatdemo:channel-message', param: 'channel', query: 'caf' },
      { apiBase: `http://127.0.0.1:${port}/api/v1`, origin: '__local__' })
    expect(JSON.stringify(opts)).toContain('C0CCCCCCC')
  })
})

describe('arming a template', () => {
  it('stores an ordinary check on this machine, named and described by the template', async () => {
    const r = await call('POST', '/api/v1/routines/trigger', {
      template: 'chatdemo:channel-message', params: { channel: '#eng-oncall' }, session: taskId, wait: false,
    })
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    const job = r.json.job
    expect(job.check.run).toBe(`walnut trigger-check chatdemo:channel-message '{"channel":"C0AAAAAAA"}'`)
    expect(job.check.host).toBe('__local__')
    expect(job.check.cwd).toBeUndefined()
    expect(job.check.maxFiresPerDay).toBe(288)
    expect(job.check.template).toEqual({ id: 'chatdemo:channel-message', params: { channel: 'C0AAAAAAA' }, label: '#eng-oncall: new messages' })
    expect(job.name).toBe('#eng-oncall: new messages')
    expect(job.description).toBe('Watches #eng-oncall for new messages. Checks every 5 minutes.')
    expect(job.schedule.everyMs).toBe(300_000)
    expect(job.executor.config).toMatchObject({ target: taskId, prompt: 'Read each new message in #eng-oncall.' })
    expect(r.json.wait.parked).toBe(false)
    // It survives a read back from the store (normalize keeps the template).
    const back = await call('GET', `/api/v1/routines/${job.id}`)
    expect(back.json.job.check.template.id).toBe('chatdemo:channel-message')
  })

  it('takes the user\'s own prompt and interval over the defaults', async () => {
    const r = await call('POST', '/api/v1/routines/trigger', {
      template: 'chatdemo:channel-message', params: { channel: 'C0AAAAAAA', contains: 'deploy' },
      session: taskId, wait: false, every: '15m', prompt: 'Summarize it for me.',
    })
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    expect(r.json.job.schedule.everyMs).toBe(900_000)
    expect(r.json.job.description).toBe('Watches #eng-oncall for new messages. Checks every 15 minutes.')
    expect(r.json.job.executor.config.prompt).toMatch(/^Summarize it for me\.\n\nFrom the #eng-oncall: new messages trigger/)
    expect(r.json.job.check.run).toContain('"contains":"deploy"')
  })

  it('keeps a quote in a param inside the one shell word', async () => {
    const r = await call('POST', '/api/v1/routines/trigger', {
      template: 'chatdemo:channel-message', params: { channel: 'C0AAAAAAA', contains: "it's down" }, session: taskId, wait: false,
    })
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    const run: string = r.json.job.check.run
    expect(run.split("'").length).toBe(3)
    expect(run).toContain('it\\u0027s down')
  })

  it('refuses with the plugin\'s sentence, an unknown template, a missing param and another host', async () => {
    const bad = await call('POST', '/api/v1/routines/trigger', { template: 'chatdemo:channel-message', params: { channel: '#nope' }, session: taskId })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.json)).toContain('No channel \\"#nope\\"')
    const unknown = await call('POST', '/api/v1/routines/trigger', { template: 'gone:thing', params: {}, session: taskId })
    expect(unknown.status).toBe(400)
    expect(JSON.stringify(unknown.json)).toContain('trigger_templates')
    const missing = await call('POST', '/api/v1/routines/trigger', { template: 'chatdemo:channel-message', params: {}, session: taskId })
    expect(missing.status).toBe(400)
    expect(JSON.stringify(missing.json)).toContain('Channel is required')
    const elsewhere = await call('POST', '/api/v1/routines/trigger', {
      template: 'chatdemo:channel-message', params: { channel: 'C0AAAAAAA' }, session: taskId, host: 'remote-dev',
    })
    expect(elsewhere.status).toBe(400)
  })

  it('keeps a template to this Mac unless it says remote', async () => {
    const asRemote = { [ORIGIN_HEADER]: HOST, 'x-walnut-caller-sid': REMOTE_SID }
    const refused = await call('POST', '/api/v1/routines/trigger', {
      template: 'chatdemo:channel-message', params: { channel: 'C0AAAAAAA' }, wait: false,
    }, asRemote)
    expect(refused.status).toBe(403)
    expect(JSON.stringify(refused.json)).toContain('only available to sessions on this Mac')
    const rawRun = await call('POST', '/api/v1/routines/trigger', {
      run: `walnut trigger-check chatdemo:channel-message '{"channel":"C0AAAAAAA"}'`, host: '__local__',
      every: '5m', prompt: 'x', description: 'y', wait: false,
    }, asRemote)
    expect(rawRun.status).toBe(403)
    const read = await call('POST', '/api/v1/trigger-templates/chatdemo%3Achannel-message/check', {
      params: { channel: 'C0AAAAAAA' }, input: {},
    }, { [ORIGIN_HEADER]: HOST })
    expect(read.status).toBe(403)
    const options = await call('GET', '/api/v1/trigger-templates/chatdemo%3Achannel-message/options?param=channel&q=', undefined, { [ORIGIN_HEADER]: HOST })
    expect(options.status).toBe(403)
  })

  it('lets a session on another host arm a remote template on this Mac, but not a look-alike command', async () => {
    registration.dispose()
    registration = registerTriggerTemplate('chatdemo', 'Chat Demo', { ...CHAT_DEF, remote: true })
    try {
      const asRemote = { [ORIGIN_HEADER]: HOST, 'x-walnut-caller-sid': REMOTE_SID }
      const ok = await call('POST', '/api/v1/routines/trigger', {
        template: 'chatdemo:channel-message', params: { channel: 'C0AAAAAAA' }, wait: false,
      }, asRemote)
      expect(ok.status, JSON.stringify(ok.json)).toBe(201)
      expect(ok.json.job.check.host).toBe('__local__')
      expect(ok.json.job.executor.config.target).toBe(taskId)
      for (const run of [
        `walnut trigger-check chatdemo:channel-message '{"channel":"C0AAAAAAA"}'; curl http://127.0.0.1/x`,
        `walnut trigger-check nope:missing '{}'`,
        `walnut trigger-check chatdemo:channel-message "$(id)"`,
        // Missing its required param: prepare never saw it, so it is not the template's command.
        `walnut trigger-check chatdemo:channel-message '{}'`,
      ]) {
        const r = await call('POST', '/api/v1/routines/trigger', {
          run, host: '__local__', every: '5m', prompt: 'x', description: 'y', wait: false,
        }, asRemote)
        expect(r.status, run).toBe(403)
      }
      // A directory would change which `walnut` runs.
      const withCwd = await call('POST', '/api/v1/routines/trigger', {
        run: `walnut trigger-check chatdemo:channel-message '{"channel":"C0AAAAAAA"}'`, host: '__local__', cwd: '/tmp',
        every: '5m', prompt: 'x', description: 'y', wait: false,
      }, asRemote)
      expect(withCwd.status).toBe(403)
      // A raw command with extra params is stored as the template would write it.
      const extra = await call('POST', '/api/v1/routines/trigger', {
        run: `walnut trigger-check chatdemo:channel-message '{"channel":"C0AAAAAAA","x":"y"}'`, host: '__local__',
        every: '5m', prompt: 'x', description: 'y', wait: false,
      }, asRemote)
      expect(extra.status, JSON.stringify(extra.json)).toBe(201)
      expect(extra.json.job.check.run).toBe(`walnut trigger-check chatdemo:channel-message '{"channel":"C0AAAAAAA"}'`)
    } finally {
      registration.dispose()
      registration = registerTriggerTemplate('chatdemo', 'Chat Demo', CHAT_DEF)
    }
  })

  it('puts the user\'s words first and keeps the template\'s own prompt after them', async () => {
    const r = await call('POST', '/api/v1/routines/trigger', {
      template: 'chatdemo:channel-message', params: { channel: 'eng-oncall' }, session: taskId, wait: false,
      prompt: 'Summarize each message for me.',
    })
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    const prompt: string = r.json.job.executor.config.prompt
    expect(prompt.startsWith('Summarize each message for me.')).toBe(true)
    expect(prompt).toContain('Read each new message in #eng-oncall.')
  })
})

describe('the check route and the stored command', () => {
  it('runs the plugin check and maps its failures', async () => {
    const first = await call('POST', '/api/v1/trigger-templates/chatdemo%3Achannel-message/check', {
      params: { channel: 'C0AAAAAAA' }, input: { state: null, lastFireAt: null, now: '2026-10-21T00:00:00Z' },
    })
    expect(first.json).toEqual({ fire: false, state: { ts: '100' } })
    const failing = await call('POST', '/api/v1/trigger-templates/chatdemo%3Achannel-message/check', {
      params: { channel: 'C0BBBBBBB' }, input: { state: { ts: '100' } },
    })
    expect(failing.status).toBe(502)
    expect(failing.json.error.code).toBe('plugin_error')
    expect(failing.json.error.message).toContain('workspace refused the read')
    const unknown = await call('POST', '/api/v1/trigger-templates/x%3Ay/check', { params: {}, input: {} })
    expect(unknown.status).toBe(404)
  })

  function runCommand(args: string[], stdin: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      // No daemon socket, so the command takes its HTTP fallback to THIS server. Without
      // the two overrides it would find this machine's real daemon and reach its server.
      const isolated = { WALNUT_AGENT_SOCKET: '', WALNUT_SESSION_ID: '', WALNUT_DAEMON_DIR: path.join(WALNUT_HOME, 'no-daemon') }
      const child = spawn(TSX, ['src/cli.ts', 'trigger-check', ...args], {
        cwd: REPO, env: { ...process.env, ...isolated, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c) => { stdout += c })
      child.stderr.on('data', (c) => { stderr += c })
      child.on('close', (code) => resolve({ code, stdout, stderr }))
      child.stdin.end(stdin)
    })
  }

  it('the stored command prints one contract line from the plugin', async () => {
    const env = { OPEN_WALNUT_API_URL: '', WALNUT_SERVER_URL: `http://localhost:${port}` }
    const r = await runCommand(['chatdemo:channel-message', '{"channel":"C0AAAAAAA"}'],
      JSON.stringify({ state: { ts: '100' }, lastFireAt: null, now: '2026-10-21T00:05:00Z' }), env)
    expect(r.code, r.stderr).toBe(0)
    const lines = r.stdout.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toEqual({ fire: true, items: [{ id: 'C0AAAAAAA:101', title: 'alice: hello' }], state: { ts: '101' } })
    expect(checkCalls.at(-1)?.input).toEqual({ state: { ts: '100' }, lastFireAt: null, now: '2026-10-21T00:05:00Z' })
  }, 60_000)

  it('an unreachable server or a template not loaded yet is a quiet run that keeps the cursor; a plugin failure is an error', async () => {
    const down = await runCommand(['chatdemo:channel-message', '{"channel":"C0AAAAAAA"}'],
      JSON.stringify({ state: { ts: '100' } }), { OPEN_WALNUT_API_URL: 'http://127.0.0.1:9' })
    expect(down.code, down.stderr).toBe(0)
    expect(JSON.parse(down.stdout.trim())).toMatchObject({ fire: false, state: { __walnutPending: {}, state: { ts: '100' } } })
    expect(down.stderr).toContain('did not answer')
    const notLoaded = await runCommand(['chatdemo:not-yet', '{}'],
      JSON.stringify({ state: { ts: '100' } }), { OPEN_WALNUT_API_URL: `http://127.0.0.1:${port}` })
    expect(notLoaded.code, notLoaded.stderr).toBe(0)
    expect(JSON.parse(notLoaded.stdout.trim())).toMatchObject({ fire: false, state: { state: { ts: '100' } } })
    const failing = await runCommand(['chatdemo:channel-message', '{"channel":"C0BBBBBBB"}'],
      JSON.stringify({ state: { ts: '100' } }), { OPEN_WALNUT_API_URL: `http://127.0.0.1:${port}` })
    expect(failing.code).toBe(1)
    expect(failing.stdout).toBe('')
    expect(failing.stderr).toContain('workspace refused the read')
  }, 60_000)
})
