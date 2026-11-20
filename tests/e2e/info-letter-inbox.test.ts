/**
 * An info letter enters the inbox only when it is a report the user asked for (2026-11-20, the user
 * on a plugin's "Chat app: 1 new (0 mentions, 1 DM)" letter: "why send me this";
 * src/core/human-inbox/info-letter-rule.ts), against a real server:
 *
 *   - a plugin's letter with no actions becomes a notice of the plugin, the call still succeeds,
 *     and the inbox list never shows it; a newer count replaces the last notice;
 *   - a plugin's approval (a letter with actions) still lands, and so does a report it marks asked;
 *   - a session's info letter is refused (409 info_not_inbox) and says what to do; the same with
 *     user_asked:true lands (a daily digest a scheduled task sends the user);
 *   - a script's info letter (no session) becomes a notice and the route still answers 201.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants('info-letter-inbox', { IS_EPHEMERAL: true }))
import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask } from '../../src/core/task-manager.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { executeOp } from '../../src/ops/index.js'
import { IntegrationRegistry } from '../../src/core/integration-registry.js'
import { PluginContext, type PluginLogger } from '../../src/core/plugins/plugin-context.js'
import { createServerPluginApi, _resetPluginLetterQuotaForTesting } from '../../src/core/plugins/server-api.js'
import { createTestPluginApi } from '../core/plugin-test-utils.js'

let server: Server
let root: string
const contexts: PluginContext[] = []

const logger: PluginLogger = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn(() => logger),
}

function pluginApi(pluginId: string) {
  const context = new PluginContext({ id: pluginId, dataDir: path.join(WALNUT_HOME, 'plugin-data', pluginId), logger })
  contexts.push(context)
  const { api: legacyApi, collected } = createTestPluginApi({ id: pluginId, name: pluginId })
  return createServerPluginApi({ context, pluginName: pluginId, legacyApi, contributions: collected, integrationRegistry: new IntegrationRegistry() })
}

const run = async (name: string, args: Record<string, unknown>, sid: string) => {
  const out = await executeOp(name, args, { apiBase: root, origin: '__local__', callerMode: 'session', callerSid: sid })
  if (!out.ok) throw Object.assign(new Error(out.message), { out })
  return out.result as Record<string, any>
}

const post = (body: Record<string, unknown>, sid?: string) => fetch(`${root}/api/v1/human-inbox`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) }, body: JSON.stringify(body),
})

async function inboxSubjects(): Promise<string[]> {
  const res = await fetch(`${root}/api/v1/human-inbox`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { letters: Array<{ subject: string }> }).letters.map((l) => l.subject)
}

async function notices(): Promise<Array<{ title: string; body?: string; dedupKey: string; taskId?: string; kind: string }>> {
  const res = await fetch(`${root}/api/v1/notifications`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { feed: Array<{ title: string; body?: string; dedupKey: string; taskId?: string; kind: string }> }).feed
}

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true })
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  _resetPluginLetterQuotaForTesting()
})
afterAll(async () => {
  for (const context of contexts.splice(0)) await context.dispose().catch(() => undefined)
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('a plugin\'s letter with no actions', () => {
  it('becomes a notice of the plugin; the inbox never shows it; a newer count replaces it', async () => {
    const chat = pluginApi('chat-app')
    const task = (await addTask({ title: 'Chat follow-ups' })).task
    const first = await chat.letters.send({ subject: 'Chat app: 1 new (0 mentions, 1 DM)', markdown: 'One new direct message from Avery.', taskRefs: [task.id] })
    expect(first).toMatchObject({ letterId: '', outcome: 'notice' })
    expect(first.noticeId).toMatch(/^notif-/)
    expect(await inboxSubjects()).not.toContain('Chat app: 1 new (0 mentions, 1 DM)')

    const feed = (await notices()).filter((n) => n.dedupKey.startsWith('plugin:chat-app:letter:'))
    expect(feed).toHaveLength(1)
    // Same subject and preview as the letter; a tap opens the task it named.
    expect(feed[0]).toMatchObject({ kind: 'skill', title: 'Chat app: 1 new (0 mentions, 1 DM)', body: 'One new direct message from Avery.', taskId: task.id })

    await chat.letters.send({ subject: 'Chat app: 3 new (1 mentions, 2 DM)', markdown: 'Three new messages.' })
    const after = (await notices()).filter((n) => n.dedupKey.startsWith('plugin:chat-app:letter:'))
    expect(after.map((n) => n.title)).toEqual(['Chat app: 3 new (1 mentions, 2 DM)'])
    expect(await inboxSubjects()).not.toContain('Chat app: 3 new (1 mentions, 2 DM)')
  })

  it('an approval still lands, and so does a report the person asked for', async () => {
    const mail = pluginApi('mail-like')
    const approval = await mail.letters.send({ subject: 'Approve this send', markdown: 'To: ops@example.invalid', actions: [{ id: 'send', label: 'Send' }] })
    expect(approval.outcome).toBe('letter')
    expect(approval.letterId).toMatch(/^lt-/)
    const asked = await mail.letters.send({ subject: 'Mail digest: 4 unread across 1 account', markdown: 'Four unread.', userAsked: true })
    expect(asked).toMatchObject({ outcome: 'letter' })
    const subjects = await inboxSubjects()
    expect(subjects).toEqual(expect.arrayContaining(['Approve this send', 'Mail digest: 4 unread across 1 account']))
  })
})

describe('a session\'s info letter', () => {
  it('is refused with info_not_inbox unless the user asked for it', async () => {
    const worker = (await addTask({ title: 'Build cache cleanup' })).task
    await createSessionRecord('s-info-worker', worker.id, '', WALNUT_HOME)
    const res = await post({ subject: 'Progress: cache cleanup half done', type: 'info', markdown: 'Halfway there.' }, 's-info-worker')
    expect(res.status).toBe(409)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('info_not_inbox')
    expect(body.error.message).toMatch(/only for a report the user asked for[\s\S]*thread or note[\s\S]*user_asked:true/)
    // The op answers the same refusal to the session.
    await expect(run('human_inbox_send', { subject: 'Progress: cache cleanup', type: 'info', markdown: 'Halfway.' }, 's-info-worker')).rejects.toThrow(/user_asked:true/)
    expect(await inboxSubjects()).not.toContain('Progress: cache cleanup half done')

    // The report the user asked for lands, as a scheduled digest task sends it each day.
    const digest = (await addTask({ title: 'Daily digest (scheduled)' })).task
    await createSessionRecord('s-info-digest', digest.id, '', WALNUT_HOME)
    const sent = await run('human_inbox_send', { subject: 'Daily digest 11-20', type: 'info', html: '<p>Today: three stories.</p>', text: 'Three stories', user_asked: true }, 's-info-digest')
    expect(sent.letterId).toMatch(/^lt-/)
    expect(await inboxSubjects()).toContain('Daily digest 11-20')
  })

  it('types other than info are unchanged', async () => {
    const t = (await addTask({ title: 'Release notes draft' })).task
    await createSessionRecord('s-info-review', t.id, '', WALNUT_HOME)
    expect((await run('human_inbox_send', { subject: 'Release notes: please review', type: 'review', markdown: 'Draft attached.' }, 's-info-review')).letterId).toMatch(/^lt-/)
  })
})

describe('through a replica\'s relay', () => {
  it('a session\'s info letter is refused the same; a caller with no session gets a notice', async () => {
    const { handleHumanInboxRelayAction } = await import('../../src/core/human-inbox/relay.js')
    const t = (await addTask({ title: 'Garden irrigation check' })).task
    await createSessionRecord('s-info-relay', t.id, '', WALNUT_HOME)
    await expect(handleHumanInboxRelayAction('send', { subject: 'Irrigation: valves checked', type: 'info', markdown: 'All open.', callerSid: 's-info-relay' }))
      .rejects.toMatchObject({ code: 'info_not_inbox', status: 409 })
    const noticed = await handleHumanInboxRelayAction('send', { subject: 'Relay: sync lag 4 min', type: 'info', markdown: 'Catching up.' }) as { outcome: string }
    expect(noticed.outcome).toBe('notice')
    const asked = await handleHumanInboxRelayAction('send', { subject: 'Irrigation report you asked for', type: 'info', markdown: 'All open.', user_asked: true, callerSid: 's-info-relay' }) as { outcome: string; id: string }
    expect(asked).toMatchObject({ outcome: 'letter', id: expect.stringMatching(/^lt-/) })
    const subjects = await inboxSubjects()
    expect(subjects).toContain('Irrigation report you asked for')
    expect(subjects).not.toContain('Irrigation: valves checked')
    expect(subjects).not.toContain('Relay: sync lag 4 min')
  })
})

describe('a script\'s info letter (no session)', () => {
  it('becomes a notice and the route still answers 201', async () => {
    const res = await post({ subject: 'Disk low: 9 GB free', type: 'info', markdown: 'The data disk has 9 GB free.' })
    expect(res.status).toBe(201)
    const body = await res.json() as { outcome: string; notice: { id: string; dedupKey: string }; id?: string }
    expect(body.outcome).toBe('notice')
    // No letter id: a notice id read as a letter's would only meet a 404.
    expect(body.id).toBeUndefined()
    expect(body.notice.dedupKey).toMatch(/^letter-notice:api:/)
    expect((await notices()).find((n) => n.dedupKey === body.notice.dedupKey)).toMatchObject({ title: 'Disk low: 9 GB free', body: 'The data disk has 9 GB free.' })
    expect(await inboxSubjects()).not.toContain('Disk low: 9 GB free')
    // A retry of the same words is that notice again, not a second toast.
    const again = await (await post({ subject: 'Disk low: 9 GB free', type: 'info', markdown: 'The data disk has 9 GB free.' })).json() as { notice: { id: string } }
    expect(again.notice.id).toBe(body.notice.id)
    // A script's letter that needs him (a review) is a letter, with the outcome named.
    const review = await post({ subject: 'Backup restore test failed', type: 'review', markdown: 'See the log.' })
    expect(review.status).toBe(201)
    expect(await review.json()).toMatchObject({ outcome: 'letter', id: expect.stringMatching(/^lt-/) })
  })
})
