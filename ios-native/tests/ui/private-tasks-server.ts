import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Real server, isolated files, and one project that syncs to a fixture service ("Tracker",
// a sync plugin that only records what it is handed: nothing leaves this machine). Seeds a
// synced task and a local one in that project, on the board in Focus, for
// PrivateTasksUITests. GET <control>/state answers the tasks as they are now and every push
// the fixture service got.
const out = process.argv[2]
if (!out || !path.resolve(out).startsWith('/tmp/private-tasks-ios/')) throw new Error('Use a dedicated /tmp/private-tasks-ios/ evidence directory')
await fs.mkdir(out, { recursive: true })
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'private-tasks-ios-'))
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
const { registry } = await import('../../../src/core/integration-registry.js')
const { addTask, ensureProject, getTask, listTasks, settleBackgroundPushes } = await import('../../../src/core/task-manager.js')
const { settleSyncGates } = await import('../../../src/core/private-tasks/sync-gate.js')
const daemon = await createMockDaemon()
sessionRunner.setCliCommand(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tests/providers/mock-claude.mjs'))
sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)

const SERVICE = 'fixture-tracker'
const pushes: Array<{ method: string; args: unknown[] }> = []
let n = 0
const record = (method: string) => async (...args: unknown[]) => { pushes.push({ method, args: JSON.parse(JSON.stringify(args)) }) }
const sync = {
  createTask: async (...args: unknown[]) => { pushes.push({ method: 'createTask', args: JSON.parse(JSON.stringify(args)) }); return { [SERVICE]: { id: `remote-${++n}` } } },
  deleteTask: record('deleteTask'), updateTitle: record('updateTitle'), updateDescription: record('updateDescription'),
  updateSummary: record('updateSummary'), updateNote: record('updateNote'), updateConversationLog: record('updateConversationLog'),
  updatePriority: record('updatePriority'), updatePhase: record('updatePhase'), updateDueDate: record('updateDueDate'),
  updateProject: record('updateProject'), updateDependencies: record('updateDependencies'),
  pushTask: async (...args: unknown[]) => { pushes.push({ method: 'pushTask', args: JSON.parse(JSON.stringify(args)) }); return { serverTimestamp: new Date().toISOString() } },
  associateSubtask: record('associateSubtask'), disassociateSubtask: record('disassociateSubtask'), syncPoll: async () => {},
}

const server = await startServer({ port: 0, dev: true })
registry.register(SERVICE, { name: 'Tracker', config: {}, sync, migrations: [], httpRoutes: [] } as never)
await ensureProject('Atlas', SERVICE)
// Born local and checked (words only here: no model), then sent to the service.
const synced = await addTask({ title: 'Quarter plan for the release', project: 'Atlas', pinned: true, focus_tier: 'focus' } as never)
const kept = await addTask({ title: 'Garden plan notes', project: 'Atlas', source: 'local', pinned: true, focus_tier: 'focus' } as never)
for (let i = 0; i < 3; i++) { await settleSyncGates(); await settleBackgroundPushes() }
const syncedNow = await getTask(synced.task.id)
if (syncedNow.source !== SERVICE) throw new Error(`fixture task did not sync (source ${syncedNow.source})`)

const port = (server.address() as { port: number }).port
const token = (await createDevice('private-tasks-fixture-phone')).token
const control = http.createServer(async (req, res) => {
  const send = (code: number, data: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
  try {
    if (req.url === '/state' && req.method === 'GET') {
      const tasks = (await listTasks()).filter(t => t.project === 'Atlas')
        .map(t => ({ id: t.id, title: t.title, source: t.source, sync_hold: t.sync_hold, ext: t.ext }))
      return send(200, { synced: synced.task.id, kept: kept.task.id, tasks, pushes })
    }
    send(404, { error: 'Unknown fixture route' })
  } catch { send(500, { error: 'Fixture control failed' }) }
})
await new Promise<void>(resolve => control.listen(0, '127.0.0.1', resolve))
const controlPort = (control.address() as { port: number }).port
await fs.writeFile(path.join(out, 'ready.json'), JSON.stringify({ server: `http://127.0.0.1:${port}`, token, control: `http://127.0.0.1:${controlPort}`,
  synced: synced.task.id, kept: kept.task.id }))
console.log('PRIVATE_TASKS_IOS_FIXTURE_READY', port)

let closing = false
async function close() {
  if (closing) return
  closing = true
  control.close()
  registry.unregister(SERVICE)
  await stopServer(); await daemon.stop()
  await fs.rm(home, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGTERM', () => { void close() })
process.on('SIGINT', () => { void close() })
setTimeout(() => { void close() }, 30 * 60_000).unref()
