import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertNoMachineHold } from '../../../src/lib/machine-hold.js'

// A real isolated server for the native Pin menu. Only the session daemon is mocked.
assertNoMachineHold()
const out = process.argv[2]
if (!out || !path.resolve(out).startsWith('/tmp/pin-tiers-ios/')) {
  throw new Error('Use a dedicated /tmp/pin-tiers-ios/ evidence directory')
}
await fs.mkdir(out, { recursive: true })
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pin-tiers-ios-'))
Object.assign(process.env, {
  HOME: home, USERPROFILE: home, OPEN_WALNUT_HOME: home,
  WALNUT_DAEMON_DIR: path.join(home, 'daemon'), WALNUT_STREAMS_DIR: path.join(home, 'streams'),
  WALNUT_SPAWN_JOURNAL: path.join(home, 'spawn.jsonl'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  WALNUT_LEGACY_STREAMS_DIR: path.join(home, 'legacy-streams'), WALNUT_DISABLE_SEARCH: '1',
  WALNUT_DISABLE_BACKGROUND_AI: '1', WALNUT_LOCAL_CLAUDE_PROBE: '0', WALNUT_ORG_AUTOSTART: '0',
  MOCK_CLAUDE_TRANSCRIPT_DIR: path.join(home, '.claude/projects'),
  MOCK_CLAUDE_TURN_TRANSCRIPT_DIR: path.join(home, '.claude/projects'),
})
for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name]
process.argv.push('--_ephemeral-child')
const { startServer, stopServer } = await import('../../../src/web/server.js')
const { sessionRunner } = await import('../../../src/providers/claude-code-session.js')
const { createMockDaemon } = await import('../../../tests/helpers/mock-daemon.js')
const { createDevice } = await import('../../../src/core/device-auth.js')
const { addTask, createCustomTier, updateTaskRaw } = await import('../../../src/core/task-manager.js')
const daemon = await createMockDaemon()
sessionRunner.setCliCommand(path.resolve(import.meta.dirname, '../../../tests/providers/mock-claude.mjs'))
sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
const server = await startServer({ port: 0, dev: true })
const custom = (await createCustomTier('Virtual Teammate')).tier
// Legacy pins remain on the wire. The phone should offer only Focus and Satellite.
const legacy = await addTask({ title: 'Legacy pin compatibility', source: 'local', pinned: true, focus_tier: 'wait' })
const focus = await addTask({ title: 'Focus reference task', source: 'local', pinned: true, focus_tier: 'focus' })
const teammate = await addTask({ title: 'Custom pin reference task', source: 'local', pinned: true, focus_tier: custom.id })
const waiting = await addTask({ title: 'Waiting is still a task state', source: 'local', pinned: true, focus_tier: 'satellite' })
await updateTaskRaw(waiting.task.id, { phase: 'WAITING', wait_until: new Date(Date.now() + 86_400_000).toISOString() })
for (let index = 0; index < 36; index++) {
  await addTask({ title: `Board density task ${index + 1}`, source: 'local', pinned: true, focus_tier: 'focus' })
}
const token = (await createDevice('pin-tiers-fixture-phone')).token
const port = (server.address() as { port: number }).port
await fs.writeFile(path.join(out, 'ready.json'), JSON.stringify({
  server: `http://127.0.0.1:${port}`, token, row: legacy.task.id,
  focus: focus.task.id, custom: teammate.task.id, waiting: waiting.task.id, tier: custom.id,
}))
let closing = false
async function close() {
  if (closing) return
  closing = true
  await stopServer()
  await daemon.stop()
  await fs.rm(home, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGTERM', () => { void close() })
process.on('SIGINT', () => { void close() })
setTimeout(() => { void close() }, 30 * 60_000).unref()
