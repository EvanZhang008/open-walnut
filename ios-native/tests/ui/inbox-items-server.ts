import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { InboxItemAction } from '../../../packages/plugin-api/src/inbox-items.js'

// Real server, isolated files and neutral mail provider. No saved user plugins or sessions.
const out = process.argv[2]
if (!out || !path.resolve(out).startsWith('/tmp/inbox-item-actions/')) throw new Error('Use a dedicated Inbox evidence directory')
await fs.mkdir(out, { recursive: true })
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-items-ios-'))
Object.assign(process.env, {
  HOME: home, USERPROFILE: home, OPEN_WALNUT_HOME: home, WALNUT_DAEMON_DIR: path.join(home, 'daemon'),
  WALNUT_STREAMS_DIR: path.join(home, 'streams'), WALNUT_SPAWN_JOURNAL: path.join(home, 'spawn.jsonl'),
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'), WALNUT_LEGACY_STREAMS_DIR: path.join(home, 'legacy-streams'),
  WALNUT_DISABLE_SEARCH: '1', WALNUT_DISABLE_BACKGROUND_AI: '1', WALNUT_LOCAL_CLAUDE_PROBE: '0',
  MOCK_CLAUDE_TRANSCRIPT_DIR: path.join(home, '.claude/projects'), MOCK_CLAUDE_TURN_TRANSCRIPT_DIR: path.join(home, '.claude/projects'),
})
for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name]
process.argv.push('--_ephemeral-child')
const { startServer, stopServer } = await import('../../../src/web/server.js')
const { sessionRunner } = await import('../../../src/providers/claude-code-session.js')
const { createMockDaemon } = await import('../../../tests/helpers/mock-daemon.js')
const { registerInboxMailSource } = await import('../../../src/core/human-inbox/item-source-registry.js')
const { definePluginOp } = await import('../../../src/ops/registry.js')
const { createDevice } = await import('../../../src/core/device-auth.js')
const { sendLetter, agentReply } = await import('../../../src/core/human-inbox/store.js')
const { addTask, updateTask, listTasks } = await import('../../../src/core/task-manager.js')
const daemon = await createMockDaemon()
sessionRunner.setCliCommand(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tests/providers/mock-claude.mjs'))
sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
const calls: unknown[] = []
const legacy = new Map<string, string>()
let sourceDispose = () => {}
const mailOp = definePluginOp('fixture-mail', { name: 'mail_mark_read', title: 'Flag fixture mail', description: 'Isolated provider only',
  input: { account: z.string(), messages: z.array(z.string()), read: z.boolean() }, tags: { readonly: false, remote: 'deny' },
  handler: async args => { calls.push(args); return JSON.stringify({ account: args.account, read: args.read, changed: 1 }) },
})
const targetA = await addTask({ title: 'Review the update', project: '', description: 'Compare the release notes, not documents' })
const targetB = await addTask({ title: 'Review the update', project: '', description: 'Review the documents update, not release notes' })
const complete = await addTask({ title: 'Finished review', project: '', description: 'Already reviewed' })
await updateTask(complete.task.id, { phase: 'COMPLETE' })
const items = Array.from({ length: 30 }, (_, n) => ({ id: `mail-${n}`, subject: `Fixture update ${n}`, summary: `Saved email summary ${n}. No instructions are extracted.`,
  source: { kind: 'mail' as const, account: n % 2 ? 'account-two' : 'account-one', message: `message-${n}` },
  display: { sender: { name: `Sender ${n}`, address: `sender${n}@example.test` }, sentAt: '2026-10-21T10:00:00Z', accountLabel: 'Personal', accountHint: n % 2 ? 'two@example.test' : 'one@example.test' },
  actions: [
    { id: `read-${n}`, kind: 'op', intent: 'mark_read' }, { id: `find-${n}`, kind: 'op', intent: 'find_task' }, { id: `create-${n}`, kind: 'op', intent: 'create_task' },
    ...(n === 5 ? [
      { id: 'ask-first-5', kind: 'reply_ai', label: 'Explain fixture five', question: 'Explain only this fixture update' },
      { id: 'ask-second-5', kind: 'reply_ai', label: 'Compare fixture five', question: 'Compare only this fixture update' },
    ] : []),
  ] as InboxItemAction[],
}))
const letter = await sendLetter({ subject: 'Email item fixture', type: 'review', markdown: 'Mailbox snapshot at 2026-10-21T10:00:00Z', items,
  sender: { sessionId: 'external', host: '__local__' },
})
await agentReply(letter.id, { text: 'One additional email', markdown: 'Thread snapshot', items: [{ ...items[0], id: 'thread-mail', source: { kind: 'mail', account: 'account-one', message: 'thread-message' },
  actions: [{ id: 'thread-read', kind: 'op', intent: 'mark_read' }] }] })
const server = await startServer({ port: 0, dev: true })
// Startup installs the real mail cache service. Replace it only after that has settled.
sourceDispose = registerInboxMailSource({ resolve: async source => ({ source,
  key: `cache:${JSON.stringify([source.account, source.message])}`,
  adapter: { legacyTaskId: async key => legacy.get(key), writeLegacy: async (key, id) => { legacy.set(key, legacy.get(key) ?? id) } },
  readObservation: { read: false, observedAt: '2026-10-21T10:00:00Z' },
}) })
const port = (server.address() as { port: number }).port
const token = (await createDevice('inbox-items-fixture-phone')).token
const control = http.createServer(async (req, res) => {
  const send = (code: number, data: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
  try {
    if (req.url === '/state' && req.method === 'GET') {
      return send(200, { letterId: letter.id, targetA: targetA.task.id, targetB: targetB.task.id, completed: complete.task.id,
        tasks: await listTasks(), mailCalls: calls, starts: daemon.getCommandHistory().filter(c => c.cmd === 'start') })
    }
    if (req.url === '/start-fault' && req.method === 'POST') {
      if (req.headers['x-inbox-fixture-fault'] === 'on') daemon.injectStartFault('Fixture launch refused')
      else if (req.headers['x-inbox-fixture-fault'] === 'off') daemon.injectStartFault(null)
      else return send(400, { error: 'Use the explicit on or off fixture fault header' })
      return send(200, { ok: true })
    }
    send(404, { error: 'Unknown fixture route' })
  } catch { send(500, { error: 'Fixture control failed' }) }
})
await new Promise<void>(resolve => control.listen(0, '127.0.0.1', resolve))
const controlPort = (control.address() as { port: number }).port
server.prependListener('request', (_req, res) => res.setHeader('x-inbox-fixture-control', `http://127.0.0.1:${controlPort}`))
await fs.writeFile(path.join(out, 'ready.json'), JSON.stringify({ server: `http://127.0.0.1:${port}`, token, control: `http://127.0.0.1:${controlPort}`,
  letterId: letter.id, targetA: targetA.task.id, targetB: targetB.task.id, completed: complete.task.id }))
if (process.argv.includes('--self-test')) {
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${route}`, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-walnut-origin': 'remote-http' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) })
    return { status: response.status, data: await response.json() as Record<string, any> }
  }
  const base = `/human-inbox/${letter.id}/items/mail-0`
  const readPlan = await request(`${base}/prepare`, { actionId: 'read-0' })
  if (readPlan.data.plan || !readPlan.data.restrictions?.some((r: { code: string }) => r.code === 'local_only')) throw new Error('Phone read restriction missing')
  const preview = await request(`${base}/tasks/${targetB.task.id}`)
  if (preview.data.id !== targetB.task.id || !preview.data.description.includes('documents')) throw new Error('Exact task preview mismatch')
  const planResponse = await request(`${base}/prepare`, { actionId: 'create-0', title: 'Review fixture', project: '', goal: 'Compare fixture notes' })
  const plan = planResponse.data.plan
  if (!plan || plan.ops.map((op: { tool: string }) => op.tool).join(',') !== 'task_create,task_start') throw new Error('Source-bound plan missing')
  const execute = { actionId: plan.actionId, requestId: 'ios-fixture-self-test', confirmed: true, planId: plan.id, planVersion: plan.version }
  await request(`${base}/execute`, execute)
  let receipt: Record<string, any> | undefined
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    receipt = (await request(`${base}/execution`)).data.receipts?.find((r: { requestId: string }) => r.requestId === execute.requestId)
    if (receipt?.status === 'success') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (receipt?.status !== 'success' || receipt.taskId !== plan.taskId) throw new Error('Exact task start not confirmed')
  await request(`${base}/execute`, execute)
  const starts = daemon.getCommandHistory().filter(command => command.cmd === 'start')
  if (starts.length !== 1) throw new Error('Duplicate fixture start')
  const stored = await request(`/tasks/${plan.taskId}`)
  const task = stored.data.task ?? stored.data
  if (!task.description?.includes('Compare fixture notes') || task.description.includes('Saved email summary')) throw new Error('Unconfirmed email text entered instructions')
  if (calls.length) throw new Error('Phone mail action reached provider')
  await fs.writeFile(path.join(out, 'self-test.json'), JSON.stringify({ passed: true, exactTask: true, duplicateStarts: false, phoneMailCalls: 0, previewExactId: true }))
  await fs.writeFile(path.join(out, 'exact-task-evidence.json'), JSON.stringify({ plan, receipt, task, preview: preview.data, starts, mailCalls: calls }))
  console.log('INBOX_IOS_FIXTURE_SELF_TEST: exact task, source, one start, remote mail restriction, preview passed')
  control.close(); sourceDispose(); mailOp.dispose(); await stopServer(); await daemon.stop(); process.exit(0)
}
let closing = false
async function close() {
  if (closing) return
  closing = true
  control.close(); sourceDispose(); mailOp.dispose()
  await stopServer(); await daemon.stop()
  process.exit(0)
}
process.on('SIGTERM', () => { void close() })
process.on('SIGINT', () => { void close() })
setTimeout(() => { void close() }, 30 * 60_000).unref()
