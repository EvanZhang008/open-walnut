/**
 * Run by tests/providers/one-service-session-walnut.test.ts with bun: a host's one Walnut service as
 * it runs on a box that installed an older released `walnut` first on PATH. One process holds the
 * daemon runtime (selfHome; `leads` for the Mac's leading service), with NO follower spec kept and no
 * follower socket or seat: the in-process server is the follower. Its own session start (through the
 * runtime's in-process link, as the server's session runner sends it) names the server's own loopback
 * root in its settings. The stand-in CLI says what `walnut` resolves to. Prints one JSON line.
 * argv: <temp root> <follower|leader>.
 * MACHINE SAFETY: the temp root only; the stand-in CLI is stopped with the runtime (the script ends
 * it by the pid it wrote).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createDaemonRuntime } from '../../../src/providers/daemon-standalone.ts'

const [root, kind] = process.argv.slice(2) as [string, 'follower' | 'leader']
const HOME = '/fixture/marina-home'
const dir = path.join(root, 'daemon')
const home = path.join(root, 'home')
const oldBin = path.join(root, 'old-walnut', 'bin')
for (const d of [dir, home, oldBin]) fs.mkdirSync(d, { recursive: true })
// An older released `walnut` (it would speak plain HTTP to the root, which answers 401 not_paired).
fs.writeFileSync(path.join(oldBin, 'walnut'), '#!/bin/sh\necho \'{"code":"not_paired"}\' >&2\nexit 1\n', { mode: 0o755 })
const out = path.join(root, 'cli.jsonl')
const cli = path.join(root, 'fake-claude.cjs')
fs.writeFileSync(cli, `
const fs = require('fs')
const { spawnSync } = require('child_process')
const walnut = spawnSync('/bin/sh', ['-c', 'command -v walnut'], { env: process.env, encoding: 'utf8' }).stdout.trim()
fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify({ pid: process.pid, walnut, path: process.env.PATH }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n')
process.on('SIGTERM', () => process.exit(0))
setTimeout(() => process.exit(0), 60000)
`)

const env: NodeJS.ProcessEnv = {
  ...process.env, HOME: home, SHELL: '/bin/sh', WALNUT_HOME_OVERRIDE: home,
  // The box's own older `walnut` first, ahead of everything the daemon adds.
  PATH: [oldBin, process.env.PATH ?? '/usr/bin:/bin'].join(':'),
  WALNUT_DAEMON_DIR: dir, WALNUT_STREAMS_DIR: path.join(root, 'streams'), WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'),
  WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'), WALNUT_JOURNAL_DIR: path.join(root, 'journal'),
}
for (const k of ['OPEN_WALNUT_HOME', 'OPEN_WALNUT_API_URL', 'WALNUT_AGENT_SOCKET', 'WALNUT_SESSION_ID', 'WALNUT_CALL_SOCKET', 'WALNUT_CALL_TOKEN']) delete env[k]
const runtime = await createDaemonRuntime({
  env, mode: 'start', listen: false, door: true, serves: 'walnut-serve', selfHome: HOME,
  ...(kind === 'leader' ? { leadsWalnut: 'wmarinaleads0001' } : {}),
  exit: () => {},
})
await runtime.start()
const client = runtime.connect(() => {})
const sid = 'abababab-0000-4000-8000-0000000000ab'
const args = ['/bin/sh', '-c', `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"`, 'sh', '--output-format', 'stream-json',
  '--settings', JSON.stringify({ env: { OPEN_WALNUT_API_URL: 'http://127.0.0.1:43182' } }), '--input-format', 'stream-json', '--session-id', sid]
const started = await client.request('start', { sid, cwd: root, message: '', mode: 'default', args, origin: { home: HOME } })
const deadline = Date.now() + 30_000
const said = () => { try { return JSON.parse(fs.readFileSync(out, 'utf8').trim().split('\n')[0]!) as { pid: number; walnut: string; path: string } } catch { return null } }
while (!said() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
const rec = said()
if (rec?.pid && rec.pid > 1) { try { process.kill(rec.pid, 'SIGTERM') } catch { /* gone */ } }
client.close()
await runtime.stop()
console.log(JSON.stringify({ ok: started.ok === true, error: started.error ?? null, walnut: rec?.walnut ?? null, path: rec?.path ?? null, shim: path.join(dir, 'bin', 'walnut'), oldWalnut: path.join(oldBin, 'walnut') }))
process.exit(0)
