// Host caller plumbing and the mail guard together: the gateway runs plugin ops with no HTTP hop, so no middleware.
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('mail-router-gateway-test'))
vi.mock('../../src/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config-manager.js')>()
  return {
    ...actual,
    getConfig: vi.fn(async () => ({ version: 1, user: { name: 'test' }, defaults: { priority: 'none' }, provider: { type: 'bedrock' }, plugins: {} })),
    updatePluginConfig: vi.fn(async (_id: string, patch: Record<string, unknown>) => patch),
  }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { removePluginOps } from '../../src/ops/registry.js'
import { executeOp } from '../../src/ops/executor.js'
import { PluginContext, type PluginLogger } from '../../src/core/plugins/plugin-context.js'
import { createServerPluginApi } from '../../src/core/plugins/server-api.js'
import { IntegrationRegistry } from '../../src/core/integration-registry.js'
import { handleGatewayCapability } from '../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../src/core/peers/peer-throttle.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import type { RouterAreasFile } from '../../src/core/router/areas.js'
import { sourceReaderFor, type SourceCaller, type SourceReaderDeps } from '../../src/core/router/source-reader.js'
import type { MailAgentDeps } from '../../src/integrations/mail/agent-surface.js'
import { MailServiceError, type MailMessageDto } from '../../src/integrations/mail/contract.js'
import { createMailOps } from '../../src/integrations/mail/ops.js'
import { guardMailOps, guardMailTools } from '../../src/integrations/mail/router-read-guard.js'
import { mailDeliveryVersion } from '../../src/integrations/mail/router-source.js'
import { createMailTools } from '../../src/integrations/mail/tools.js'
import { createTestPluginApi } from './plugin-test-utils.js'

const ACCOUNT = 'desk@example.invalid'
const SENT_AT = 1_700_000_000_000
const rfcOf = (id: string) => `<${id}@example.invalid>`
// Each row's delivery through the real helper (no received time; these metadata-only fixtures hold no body ref).
const versionOf = (id: string) => mailDeliveryVersion(SENT_AT, null, null, rfcOf(id))

const dto = (id: string): MailMessageDto => ({
  accountId: ACCOUNT, messageId: id, rfcMessageId: rfcOf(id), threadId: 'thread-1', mailboxId: 'inbox',
  from: { address: 'sender@example.invalid' }, to: [], subject: `Subject ${id}`, snippet: `Preview ${id}`,
  sentAt: SENT_AT, deliveryVersion: versionOf(id), flags: [], attachments: [], hasBody: true,
} as unknown as MailMessageDto)

const REGISTRY: RouterAreasFile = {
  version: 1,
  areas: [{ id: 'beta', name: 'Beta', host: '__local__', taskIds: ['t-beta'], sources: [{ kind: 'mail', account: ACCOUNT }] }],
  routers: [],
  items: [{ source: { kind: 'mail', account: ACCOUNT, message: 'm-beta', version: versionOf('m-beta') }, areaId: 'beta' }],
}

const logger: PluginLogger = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn(() => logger),
}

const contexts: PluginContext[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.dispose().catch(() => undefined)
  removePluginOps('mail')
})

// `legacy`: the registry row was saved before delivery versions, so it restricts the handle and grants nothing.
function registerGuardedMail(options: { legacy?: boolean } = {}) {
  const calls: string[] = []
  const callers: SourceCaller[] = []
  const all = ['m-plain', 'm-beta'].map(dto)
  const find = (id: string) => {
    const one = all.find((m) => m.messageId === id || m.rfcMessageId === id)
    if (!one) throw new MailServiceError('unknown_message', `No cached message "${id}".`, 404)
    return one
  }
  const deps = {
    replica: () => false,
    service: {
      async listAccounts() { return [{ accountId: ACCOUNT, address: ACCOUNT }] },
      async readEnvelope(_a: string, id: string) { return find(id) },
      async readMessage(_a: string, id: string) { calls.push(`body:${id}`); return { message: find(id), body: { text: `Body words of ${id}` } } },
      async threadMessages() { return all },
      async markReadMany(_a: string, ids: string[]) { calls.push(`markReadMany:${ids.join(',')}`); return ids.map((messageId) => ({ messageId, ok: true })) },
    },
    drafts: {
      async get() { throw new Error('This read-only fixture never reads drafts') },
      async patch() { throw new Error('This read-only fixture never edits drafts') },
    },
    approvals: {
      async requestSend() { throw new Error('This read-only fixture never requests a send') },
    },
    unsubscribe: {
      async requestFromAgent() { throw new Error('This read-only fixture never requests an unsubscribe') },
    },
  } as unknown as MailAgentDeps
  const readerDeps: SourceReaderDeps = {
    async readAreas() {
      const file = structuredClone(REGISTRY)
      if (options.legacy) for (const item of file.items) delete item.source.version
      return file
    },
    // sid-beta is beta's area session; every other sid is an ordinary session with no area.
    async session(sid) { return sid === 'sid-beta' ? { taskId: 't-beta', profile: { areaId: 'beta' } } as never : null },
    async task() { return undefined },
    async sessionsForTask() { return [] },
  }
  const context = new PluginContext({ id: 'mail', dataDir: path.join(WALNUT_HOME, 'plugin-data', 'mail'), logger })
  contexts.push(context)
  const { api: legacyApi, collected } = createTestPluginApi({ id: 'mail', name: 'mail' })
  const api = createServerPluginApi({ context, pluginName: 'mail', legacyApi, contributions: collected, integrationRegistry: new IntegrationRegistry() })
  const guard = {
    readerFor: (caller: SourceCaller) => { callers.push(caller); return sourceReaderFor(caller, readerDeps) },
    ledger: async () => new Set<string>(),
  }
  for (const op of guardMailOps(createMailOps(deps), deps, createMailOps, guard)) api.registry.op(op)
  for (const tool of guardMailTools(createMailTools(deps), deps, createMailTools, guard)) api.registry.tool(tool)
  // An op that reads mail again in-process while claiming to be a person.
  api.registry.op({
    name: 'nest', title: 'Nested read', description: 'Reads one message through a nested human executeOp.', readonly: true,
    handler: async () => executeOp('mail_read', { message: 'm-beta' }, { origin: LOCAL_ORIGIN, callerMode: 'human' }),
  })
  const tool = (name: string) => collected.tools.find((one) => one.name === name)!
  return { calls, callers, tool }
}

// The guard asks for the caller's reader once when the op starts and again at every judgement, so
// it never judges on a stale registry: a mail_read of a body (judged before, after and on the
// result) asks 4 times, a denied one stops at its first judgement after 2. Every ask names the
// same caller, which is what these counts pin.
const READS_OF_A_BODY = 4
const READS_OF_A_DENIED = 2
const asks = (caller: SourceCaller, count: number) => Array.from({ length: count }, () => caller)

const gateway = (sid: string, name: string, args: Record<string, unknown>) =>
  handleGatewayCapability('tools.call', sid, { name, args }, '__local__', { throttle: new PeerThrottle(), cloudMode: false })

describe('mail ops over the daemon gateway', () => {
  it('an ordinary session reads unassigned mail and never an assigned body', async () => {
    const { calls, callers } = registerGuardedMail()
    expect(JSON.stringify(await gateway('sid-vp', 'mail_read', { message: 'm-plain' }))).toContain('Body words of m-plain')
    const denied = JSON.stringify(await gateway('sid-vp', 'mail_read', { message: 'm-beta' }))
    expect(denied).toContain('area_forbidden')
    expect(denied).not.toContain('Body words')
    expect(calls).toEqual(['body:m-plain'])
    expect(callers).toEqual(asks({ kind: 'session', sid: 'sid-vp' }, READS_OF_A_BODY + READS_OF_A_DENIED))
  })

  it('a thread anchored on unassigned mail drops the assigned reply', async () => {
    registerGuardedMail()
    const out = JSON.stringify(await gateway('sid-vp', 'mail_thread', { message: 'm-plain' }))
    expect(out).toContain('Subject m-plain')
    expect(out).not.toContain('Subject m-beta')
  })

  it('mark_read of an assigned message writes nothing', async () => {
    const { calls } = registerGuardedMail()
    expect(JSON.stringify(await gateway('sid-vp', 'mail_mark_read', { messages: ['m-beta'] }))).toContain('area_forbidden')
    expect(calls.filter((c) => c.startsWith('markReadMany:'))).toEqual([])
  })

  it('an anonymous executeOp (no sid, not a person) is an outside agent: unassigned only, no env', async () => {
    const before = process.env.WALNUT_SESSION_ID
    process.env.WALNUT_SESSION_ID = 'sid-vp'
    try {
      const { calls, callers } = registerGuardedMail()
      const out = JSON.stringify(await executeOp('mail_read', { message: 'm-beta' }, { origin: LOCAL_ORIGIN }))
      expect(out).toContain('area_forbidden')
      expect(out).not.toContain('Body words')
      expect(calls).toEqual([])
      expect(JSON.stringify(await executeOp('mail_read', { message: 'm-plain' }, { origin: LOCAL_ORIGIN }))).toContain('Body words of m-plain')
      expect(callers).toEqual(asks({ kind: 'agent' }, READS_OF_A_DENIED + READS_OF_A_BODY))
    } finally {
      if (before === undefined) delete process.env.WALNUT_SESSION_ID
      else process.env.WALNUT_SESSION_ID = before
    }
  })

  it('a nested call that claims to be a person keeps the outer caller', async () => {
    const { calls, callers } = registerGuardedMail()
    const anonymous = JSON.stringify(await executeOp('mail_nest', {}, { origin: LOCAL_ORIGIN }))
    expect(anonymous).toContain('area_forbidden')
    const session = JSON.stringify(await gateway('sid-vp', 'mail_nest', {}))
    expect(session).toContain('area_forbidden')
    for (const out of [anonymous, session]) expect(out).not.toContain('Body words')
    expect(calls).toEqual([])
    // Each nested read is denied at its first judgement, under the outer caller, never as a person.
    expect(callers).toEqual([...asks({ kind: 'agent' }, READS_OF_A_DENIED), ...asks({ kind: 'session', sid: 'sid-vp' }, READS_OF_A_DENIED)])
  })

  it('the area session reads the delivery confirmed for its area', async () => {
    const { calls } = registerGuardedMail()
    expect(JSON.stringify(await gateway('sid-beta', 'mail_read', { message: 'm-beta' }))).toContain('Body words of m-beta')
    expect(JSON.stringify(await gateway('sid-beta', 'mail_read', { message: 'm-plain' }))).toContain('area_forbidden')
    expect(calls).toEqual(['body:m-beta'])
  })

  it('a legacy registry row with no delivery version still restricts the handle and grants no area a body', async () => {
    const { calls } = registerGuardedMail({ legacy: true })
    for (const sid of ['sid-vp', 'sid-beta']) {
      const out = JSON.stringify(await gateway(sid, 'mail_read', { message: 'm-beta' }))
      expect(out).toContain('area_forbidden')
      expect(out).not.toContain('Body words')
    }
    expect(JSON.stringify(await executeOp('mail_read', { message: 'm-beta' }, { origin: LOCAL_ORIGIN }))).toContain('area_forbidden')
    expect(calls).toEqual([])
    expect(JSON.stringify(await gateway('sid-vp', 'mail_read', { message: 'm-plain' }))).toContain('Body words of m-plain')
  })

  it('a person with no sid reads as before through executeOp', async () => {
    const { callers } = registerGuardedMail()
    const out = await executeOp('mail_read', { message: 'm-beta' }, { origin: LOCAL_ORIGIN, callerMode: 'human' })
    expect(JSON.stringify(out)).toContain('Body words of m-beta')
    expect(callers).toEqual([])
  })
})

describe('mail tools through the registered plugin tool wrapper', () => {
  it('a session caller on the tool meta reads unassigned mail, never an assigned body', async () => {
    const { tool, calls, callers } = registerGuardedMail()
    const meta = { callerSid: 'sid-vp', callerKind: 'agent' as const }
    expect(String(await tool('mail_read').execute({ message: 'm-plain' }, meta))).toContain('Body words of m-plain')
    const denied = String(await tool('mail_read').execute({ message: 'm-beta' }, meta))
    expect(denied).toContain('area_forbidden')
    expect(denied).not.toContain('Body words')
    expect(calls).toEqual(['body:m-plain'])
    expect(callers).toEqual(asks({ kind: 'session', sid: 'sid-vp' }, READS_OF_A_BODY + READS_OF_A_DENIED))
  })

  it('an explicit person on the tool meta reads as before', async () => {
    const { tool, callers } = registerGuardedMail()
    expect(String(await tool('mail_read').execute({ message: 'm-beta' }, { callerKind: 'person' }))).toContain('Body words of m-beta')
    expect(callers).toEqual([])
  })

  it('a tool call with no caller, or an anonymous agent, is an outside agent: unassigned only', async () => {
    const { tool, calls } = registerGuardedMail()
    for (const meta of [undefined, {}, { callerKind: 'agent' as const }, { toolUseId: 'tu-1', source: 'cron' }]) {
      const out = String(await tool('mail_read').execute({ message: 'm-beta' }, meta))
      expect(out).toContain('area_forbidden')
      expect(out).not.toContain('Body words')
    }
    expect(calls).toEqual([])
    expect(String(await tool('mail_read').execute({ message: 'm-plain' }, undefined))).toContain('Body words of m-plain')
  })
})
