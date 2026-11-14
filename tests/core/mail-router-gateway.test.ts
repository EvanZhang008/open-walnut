// Mail ops over the daemon gateway and the plugin tool wrapper (no HTTP hop). Since 2026-11-14 a mailbox's
// router hands each mail on with its original text, and no area hides that text from any other reader: a VP
// session reads a message an older build confirmed into an area (and so restricted) like any other.
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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

import fs from 'node:fs/promises'
import { WALNUT_HOME } from '../../src/constants.js'
import { removePluginOps } from '../../src/ops/registry.js'
import { PluginContext, type PluginLogger } from '../../src/core/plugins/plugin-context.js'
import { createServerPluginApi } from '../../src/core/plugins/server-api.js'
import { IntegrationRegistry } from '../../src/core/integration-registry.js'
import { handleGatewayCapability } from '../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../src/core/peers/peer-throttle.js'
import { addTask } from '../../src/core/task-manager.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { routerAreasPath } from '../../src/core/router/areas.js'
import type { MailAgentDeps } from '../../src/integrations/mail/agent-surface.js'
import { MailServiceError, type MailMessageDto } from '../../src/integrations/mail/contract.js'
import { createMailOps } from '../../src/integrations/mail/ops.js'
import { mailDeliveryVersion } from '../../src/integrations/mail/router-source.js'
import { createMailTools } from '../../src/integrations/mail/tools.js'
import { createTestPluginApi } from './plugin-test-utils.js'

const ACCOUNT = 'desk@example.invalid'
const SENT_AT = 1_700_000_000_000
const rfcOf = (id: string) => `<${id}@example.invalid>`
const versionOf = (id: string) => mailDeliveryVersion(SENT_AT, null, null, rfcOf(id))
const VP_SID = 'sid-vp'

const dto = (id: string): MailMessageDto => ({
  accountId: ACCOUNT, messageId: id, rfcMessageId: rfcOf(id), threadId: 'thread-1', mailboxId: 'inbox',
  from: { address: 'sender@example.invalid' }, to: [], subject: `Subject ${id}`, snippet: `Preview ${id}`,
  sentAt: SENT_AT, deliveryVersion: versionOf(id), flags: [], attachments: [], hasBody: true,
} as unknown as MailMessageDto)

const logger: PluginLogger = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn(() => logger),
}

const contexts: PluginContext[] = []

beforeAll(async () => {
  // The registry an older build wrote: m-beta confirmed into area beta, which then restricted every other reader.
  const file = routerAreasPath(WALNUT_HOME)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    areas: [{ id: 'beta', name: 'Beta', host: '__local__', taskIds: ['t-beta'], sources: [{ kind: 'mail', account: ACCOUNT }] }],
    routers: [],
    items: [{ source: { kind: 'mail', account: ACCOUNT, message: 'm-beta', version: versionOf('m-beta') }, areaId: 'beta' }],
  }))
  const vp = (await addTask({ title: 'Garden VP', project: 'Garden' })).task
  await createSessionRecord(VP_SID, vp.id, '', WALNUT_HOME, { mode: 'dontAsk' })
})

afterAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.dispose().catch(() => undefined)
  removePluginOps('mail')
})

function registerMail() {
  const calls: string[] = []
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
  } as unknown as MailAgentDeps
  const context = new PluginContext({ id: 'mail', dataDir: path.join(WALNUT_HOME, 'plugin-data', 'mail'), logger })
  contexts.push(context)
  const { api: legacyApi, collected } = createTestPluginApi({ id: 'mail', name: 'mail' })
  const api = createServerPluginApi({ context, pluginName: 'mail', legacyApi, contributions: collected, integrationRegistry: new IntegrationRegistry() })
  for (const op of createMailOps(deps)) api.registry.op(op)
  for (const tool of createMailTools(deps)) api.registry.tool(tool)
  const tool = (name: string) => collected.tools.find((one) => one.name === name)!
  return { calls, tool }
}

const gateway = (sid: string, name: string, args: Record<string, unknown>) =>
  handleGatewayCapability('tools.call', sid, { name, args }, '__local__', { throttle: new PeerThrottle(), cloudMode: false })

describe('a VP session reads mail an older build restricted to an area', () => {
  it('over the daemon gateway: the body, the whole thread and mark_read', async () => {
    const { calls } = registerMail()
    const read = JSON.stringify(await gateway(VP_SID, 'mail_read', { message: 'm-beta' }))
    expect(read).toContain('Body words of m-beta')
    expect(read).not.toContain('area_forbidden')
    const thread = JSON.stringify(await gateway(VP_SID, 'mail_thread', { message: 'm-plain' }))
    expect(thread).toContain('Subject m-plain')
    expect(thread).toContain('Subject m-beta')
    expect(JSON.stringify(await gateway(VP_SID, 'mail_mark_read', { messages: ['m-beta'] }))).not.toContain('area_forbidden')
    expect(calls).toEqual(['body:m-beta', 'markReadMany:m-beta'])
  })

  it('through the registered plugin tool, with or without a caller on the meta', async () => {
    const { tool } = registerMail()
    for (const meta of [{ callerSid: VP_SID, callerKind: 'agent' as const }, undefined]) {
      expect(String(await tool('mail_read').execute({ message: 'm-beta' }, meta))).toContain('Body words of m-beta')
    }
  })
})
