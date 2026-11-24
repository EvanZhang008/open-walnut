/**
 * Run by tests/providers/daemon-direct-call.test.ts with bun: one daemon runtime in this process
 * (createDaemonRuntime) and a client of it (connect()). Each case asks the same command twice,
 * once as a frame (send(), the reply through onFrame) and once as a direct call (call(), the
 * reply from the call), and records both replies without their ids, plus any frame that came
 * for an id after its answer (a second answer). A second runtime is a Demo's own daemon, fenced
 * by demo.quiesce, so its gate refuses a write both ways. Prints one JSON line.
 *
 * argv[2]: a temp root this script may fill (the test removes it).
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createDaemonRuntime, type DaemonFrame } from '../../../src/providers/daemon-standalone.ts'

const root = fs.realpathSync(process.argv[2]!)
const out: Record<string, unknown> = {}

async function connected(env: Record<string, string>) {
  const runtime = await createDaemonRuntime({ env: { ...process.env, SHELL: '/bin/sh', ...env }, mode: 'start', exit: () => {} })
  await runtime.start()
  const waiting = new Map<number, (f: DaemonFrame) => void>()
  const answered = new Set<number>()
  const extra: DaemonFrame[] = []
  const client = runtime.connect((f) => {
    const id = typeof f.id === 'number' && f.ev === undefined ? f.id : null
    if (id === null) return
    const own = waiting.get(id)
    if (own) { waiting.delete(id); answered.add(id); own(f); return }
    extra.push(f)
  })
  let nextId = 1
  const strip = (f: DaemonFrame | null) => { if (!f) return f; const { id: _id, ...rest } = f; return rest }
  const viaFrame = (cmd: string, params: Record<string, unknown>) => new Promise<DaemonFrame>((resolve) => {
    const id = nextId++
    waiting.set(id, resolve)
    client.send({ ...params, id, cmd })
  })
  const viaCall = async (cmd: string, params: Record<string, unknown>) => {
    const id = nextId++
    const called = client.call({ ...params, id, cmd })
    if (!called) return 'not-direct'
    const reply = await called
    answered.add(id)
    return reply
  }
  /** The same command both ways: [frame reply, direct reply], ids dropped. */
  const both = async (cmd: string, params: Record<string, unknown> = {}, direct: Record<string, unknown> = params) => {
    const frame = strip(await viaFrame(cmd, params))
    const called = await viaCall(cmd, direct)
    return [frame, typeof called === 'string' ? called : strip(called)]
  }
  await client.request('hello')
  return { runtime, client, both, extra, answered }
}

const home = path.join(root, 'home')
const dir = path.join(root, 'files')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, 'a.txt')
fs.writeFileSync(file, 'hello direct call\n')
const repo = path.join(root, 'repo')
execFileSync('git', ['init', '-q', repo])
fs.writeFileSync(path.join(repo, 'x.txt'), 'x\n')

const a = await connected({ HOME: home, WALNUT_DAEMON_DIR: path.join(root, 'daemon'), WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy') })
const cases: Record<string, unknown> = {}
// fs (daemon-fs-read.ts, daemon-fs-write.ts)
cases.fsRead = await a.both('fs.read', { path: file, encoding: 'utf-8' })
cases.fsReadMissingPath = await a.both('fs.read', {})
cases.fsReadThrows = await a.both('fs.read', { path: 42 })
cases.fsStatMissing = await a.both('fs.stat', { path: path.join(dir, 'missing') })
cases.fsLs = await a.both('fs.ls', { path: dir })
cases.fsReadRange = await a.both('fs.readRange', { path: file, start: 0, length: 5 })
cases.fsWrite = await a.both('fs.write', { path: path.join(dir, 'w1.txt'), data: 'abc', encoding: 'utf-8' }, { path: path.join(dir, 'w2.txt'), data: 'abc', encoding: 'utf-8' })
cases.fsWritten = [fs.readFileSync(path.join(dir, 'w1.txt'), 'utf8'), fs.readFileSync(path.join(dir, 'w2.txt'), 'utf8')]
// git (daemon-git.ts) and the session commit (daemon-changes.ts)
cases.gitStatus = await a.both('git.status', { dirs: [repo] })
cases.gitDiffMissingCwd = await a.both('git.diff', {})
cases.gitCommitJob = await a.both('git.commitJob', { jobId: 'no-such-job' })
// changes (daemon-changes.ts)
cases.changesMissingSid = await a.both('changes.compute', {})
cases.changesUnknownSid = await a.both('changes.compute', { sid: 'no-such-session' })
// transcripts (daemon-transcripts.ts)
cases.rewindMissingSid = await a.both('transcript.rewindProbe', {})
cases.readyKeys = await a.both('history.readyKeys', { items: [] })
// skills, hooks, triggers
cases.skillsProbe = await a.both('skills.sync', { probe: true })
cases.hooksInvalid = await a.both('hooks.configure', { config: { version: 2 } })
// A new hash each way: both pushes change the rules.
cases.hooksValid = await a.both('hooks.configure', { config: { version: 1, hooks: [], hash: 'h1' } }, { config: { version: 1, hooks: [], hash: 'h2' } })
cases.triggersAckUnknown = await a.both('triggers.ack', { triggerId: 'no-such-trigger', seq: 1 })
cases.triggersRunUnknown = await a.both('triggers.run', { triggerId: 'no-such-trigger' })
// host-local commands (transferAnswer) and host services
cases.secretsList = await a.both('secrets.list', {})
cases.transferRealpath = await a.both('transfer.realpath', { path: dir })
cases.transferRealpathMissing = await a.both('transfer.realpath', { path: path.join(dir, 'missing') })
cases.hubStatus = await a.both('hub.status', {})
// A command the runtime does not answer by function is not called: it goes as a frame.
cases.listNotDirect = await a.both('list', {})
out.cases = cases
// Give a late second answer time to arrive.
await new Promise((resolve) => setTimeout(resolve, 200))
out.extra = a.extra
out.answered = a.answered.size

// A Demo's own daemon, fenced: its gate refuses new work both ways, reads of the allowlist pass.
const demoRoot = path.join(root, 'open-walnut-demo')
const generation = 'g1'
fs.mkdirSync(path.join(demoRoot, 'homes', generation), { recursive: true })
fs.mkdirSync(path.join(demoRoot, 'data', generation), { recursive: true })
const d = await connected({ HOME: path.join(demoRoot, 'homes', generation), WALNUT_DAEMON_DIR: path.join(demoRoot, 'd', generation), WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'), WALNUT_DEMO_ROOT: demoRoot, WALNUT_DEMO_GENERATION: generation })
out.quiesce = await d.client.request('demo.quiesce', { home: path.join(demoRoot, 'data', generation) })
out.demo = {
  write: await d.both('fs.write', { path: path.join(dir, 'demo.txt'), data: 'x', encoding: 'utf-8' }),
  read: await d.both('fs.read', { path: file, encoding: 'utf-8' }),
  execList: await d.both('exec.list', {}),
}
out.demoWrote = fs.existsSync(path.join(dir, 'demo.txt'))

// After the client closed, call() refuses as send() does.
a.client.close()
try { a.client.call({ id: 999, cmd: 'fs.read', path: file }); out.callAfterClose = 'no throw' } catch (err) { out.callAfterClose = (err as Error).message }

out.stopA = await a.runtime.stop()
out.stopD = await d.runtime.stop()
process.stdout.write(JSON.stringify(out) + '\n')
// No process.exit: the process ends once nothing of the runtimes is left.
