/**
 * Run by tests/providers/daemon-served-walnuts-twins-e2e.test.ts with bun: a host's one Walnut
 * service, as it runs (one process): a daemon runtime with its own follower home (selfHome), the
 * door open, no OPEN_WALNUT_HOME in its env (local-daemon.ts buildSpawnEnv drops it), and the
 * follower spec its leader configured kept in its dir, so hostServers.boot() files it as the
 * self entry. An older build left daemon.serves.json with the service's data dir under its own
 * key. Then the replica's own-sessions link, in the same process (runtime.connect), pushes
 * turns.configure and workspace.configure naming that data dir. Prints one JSON line of the
 * record's keys at each step. argv: <temp root>.
 * MACHINE SAFETY: the temp root only; no CLI or server child starts (the self entry has none);
 * the runtime is stopped by the script.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createDaemonRuntime } from '../../src/providers/daemon-standalone.ts'
import { walnutKeyOf } from '../../src/providers/daemon-shared.ts'

const root = process.argv[2]!
const HOME_A = '/fixture/marina-home'
const WALNUT_A = 'wmarinaservedself0001'
const dir = path.join(root, 'daemon')
const home = path.join(root, 'home')
// The layout a leader writes for its server on a host (install.ts walnutDirs).
const data = path.join(root, 'host-root', 'walnuts', WALNUT_A.slice(0, 16), 'data')
fs.mkdirSync(path.join(dir, 'host-server'), { recursive: true, mode: 0o700 })
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(data, { recursive: true })
fs.writeFileSync(path.join(dir, 'host-server', 'server-0011223344556677.json'), JSON.stringify({
  spec: {
    v: 1, home: HOME_A, walnutId: WALNUT_A, command: process.execPath, args: [], cwd: data, log: path.join(root, 'follower.log'), port: 40124, settings: {},
    env: { OPEN_WALNUT_HOME: data },
  },
  token: crypto.randomBytes(32).toString('hex'),
}), { mode: 0o600 })
const servesFile = path.join(dir, 'daemon.serves.json')
fs.writeFileSync(servesFile, JSON.stringify({ v: 1, version: 'older-build', twin: 'binary', capabilities: [], walnuts: { [walnutKeyOf(HOME_A)]: Date.now(), [walnutKeyOf(data)]: Date.now() } }))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const keysInFile = () => Object.keys((JSON.parse(fs.readFileSync(servesFile, 'utf8')) as { walnuts: Record<string, number> }).walnuts).sort()
const env: NodeJS.ProcessEnv = {
  ...process.env, HOME: home, SHELL: '/bin/sh', WALNUT_HOME_OVERRIDE: home,
  WALNUT_DAEMON_DIR: dir, WALNUT_STREAMS_DIR: path.join(root, 'streams'), WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'),
  WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'), WALNUT_JOURNAL_DIR: path.join(root, 'journal'),
}
delete env.OPEN_WALNUT_HOME
const exitCalls: number[] = []
const runtime = await createDaemonRuntime({ env, mode: 'start', listen: false, door: true, selfHome: HOME_A, exit: (code) => { exitCalls.push(code) } })
await runtime.start()
const out: Record<string, unknown> = { leaderKey: walnutKeyOf(HOME_A), dataKey: walnutKeyOf(data) }
out.atStart = keysInFile()

const client = runtime.connect(() => {})
const served = async () => ((await client.request('hello', { run: 'fixture-replica-run' })).served as { walnuts?: Record<string, number> } | undefined)?.walnuts
out.helloAtStart = Object.keys((await served()) ?? {}).sort()
out.turns = (await client.request('turns.configure', { home: data, enabled: false, keep: 5 })).ok
await client.request('workspace.configure', { home: data + '/', config: { providers: [] } })
out.helloAfterPush = Object.keys((await served()) ?? {}).sort()
await sleep(100)
out.fileAfterPush = keysInFile()
client.close()
out.stopCode = await runtime.stop()
out.exitCalls = exitCalls.length
console.log(JSON.stringify(out))
process.exit(0)
