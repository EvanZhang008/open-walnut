import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { InboxItemAction } from '../../../packages/plugin-api/src/inbox-items.js'

// Talk to CEO and New task on the phone, against a real server with isolated files: a mock CLI
// and a mock daemon run the CEO, so nothing reaches a real session, mailbox or model.
// Usage: bun ios-native/tests/ui/content-actions-server.ts /tmp/content-actions/<run>
const out = process.argv[2]
if (!out || !path.resolve(out).startsWith('/tmp/content-actions/')) throw new Error('Use a dedicated /tmp/content-actions/<run> directory')
await fs.mkdir(out, { recursive: true })
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'content-actions-ios-'))
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
const { createDevice } = await import('../../../src/core/device-auth.js')
const { sendLetter } = await import('../../../src/core/human-inbox/store.js')
const daemon = await createMockDaemon()
sessionRunner.setCliCommand(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tests/providers/mock-claude.mjs'))
sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)

const mail = (n: number, subject: string, actions: InboxItemAction[]) => ({
  id: `mail-${n}`, subject, summary: `The sender asks for a decision on item ${n} by Friday. No instructions are extracted.`,
  source: { kind: 'mail' as const, account: 'account-one', message: `message-${n}` },
  display: { sender: { name: `Sender ${n}`, address: `sender${n}@example.test` }, sentAt: '2026-11-02T17:14:00Z', accountLabel: 'Personal', accountHint: 'one@example.test' },
  actions,
})
// A new letter: the mail plugin now offers only Mark read on each item.
const fresh = await sendLetter({
  subject: 'Mail reminder', type: 'review', markdown: 'Three emails need a look.',
  items: [
    mail(1, 'Quarterly budget review: please confirm the final numbers before the Friday meeting', [{ id: 'read-1', kind: 'op', intent: 'mark_read' }]),
    mail(2, 'Lease renewal', [{ id: 'read-2', kind: 'op', intent: 'mark_read' }]),
    // Non-ASCII subject (CJK test data) to check the draft and the CEO text keep it whole.
    mail(3, 'Conference talk accepted: \u4F1A\u8BAE\u901A\u77E5', [{ id: 'read-3', kind: 'op', intent: 'mark_read' }]),
  ],
  sender: { sessionId: 'external', host: '__local__' },
})
// An older letter still carries the confirmed create-task button. A new item never keeps a task
// intent, so this one is written the way an older Walnut wrote it (item-schema.ts).
Object.assign(process.env, { VITEST: '1', WALNUT_TEST_LEGACY_TASK_INTENTS: '1' })
const old = await sendLetter({
  subject: 'Older mail reminder', type: 'review', markdown: 'Sent before the content actions.',
  items: [mail(4, 'Dentist appointment', [{ id: 'read-4', kind: 'op', intent: 'mark_read' }, { id: 'create-4', kind: 'op', intent: 'create_task' }])],
  sender: { sessionId: 'external', host: '__local__' },
})
delete process.env.VITEST
delete process.env.WALNUT_TEST_LEGACY_TASK_INTENTS
const server = await startServer({ port: 0, dev: true })
const port = (server.address() as { port: number }).port
const token = (await createDevice('content-actions-fixture-phone')).token

// The CEO already has a chat, filed as a transcript the way Claude Code files one; from then on
// the mock CLI files every plain turn there too, so the phone shows Talk to CEO's message.
const { sendToMain } = await import('../../../src/web/routes/quick-input-v1.js')
const { getSessionByClaudeId } = await import('../../../src/core/session-tracker.js')
const { encodeProjectPath } = await import('../../../src/core/session-history.js')
const ceo = await sendToMain('Good morning. What needs me today?')
const sid = ceo.sessionId
if (!sid) throw new Error('The CEO chat did not start')
let record = await getSessionByClaudeId(sid)
for (let i = 0; i < 100 && (!record?.cwd || record.process_status === 'running'); i++) {
  await new Promise(resolve => setTimeout(resolve, 200))
  record = await getSessionByClaudeId(sid)
}
if (!record?.cwd) throw new Error('The CEO chat has no folder')
const projects = path.join(home, '.claude', 'projects')
const transcript = path.join(projects, encodeProjectPath(record.cwd), `${sid}.jsonl`)
await fs.mkdir(path.dirname(transcript), { recursive: true })
const at = new Date().toISOString()
const seed = { sessionId: sid, cwd: record.cwd, timestamp: at, isSidechain: false }
await fs.writeFile(transcript, [
  { ...seed, type: 'user', uuid: 'seed-u', parentUuid: null, message: { role: 'user', content: 'Good morning. What needs me today?' } },
  { ...seed, type: 'assistant', uuid: 'seed-a', parentUuid: 'seed-u', message: { id: 'msg_seed', role: 'assistant', content: [{ type: 'text', text: 'Morning. Nothing needs you yet.' }] } },
].map(line => JSON.stringify(line)).join('\n') + '\n')
process.env.MOCK_CLAUDE_PERSIST_DIR = projects
process.env.MOCK_CLAUDE_PERSIST_SESSIONS = sid
await fs.writeFile(path.join(out, 'ready.json'), JSON.stringify({ server: `http://127.0.0.1:${port}`, token, freshLetter: fresh.id, oldLetter: old.id, home }))
console.log(`CONTENT_ACTIONS_FIXTURE_READY http://127.0.0.1:${port}`)

let closing = false
async function close() {
  if (closing) return
  closing = true
  await stopServer(); await daemon.stop()
  await fs.rm(home, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGTERM', () => { void close() })
process.on('SIGINT', () => { void close() })
setTimeout(() => { void close() }, 120 * 60_000).unref()
