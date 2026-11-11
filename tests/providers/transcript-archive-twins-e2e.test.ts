/**
 * The session history archive on both daemon twins (transcript-archive.ts):
 * `transcript.archive` compresses an old session and leaves a live one, and
 * every file command a reader uses (fs.stat, fs.read, fs.readRange, fs.ls,
 * fs.find) gets the archived session back plain, byte for byte, before it
 * answers. `transcript.restore` brings one back by id, and the capability is
 * advertised on both twins.
 *
 * MACHINE SAFETY: HOME, the Claude config dir and the daemon dirs are temp
 * paths; the only processes started and stopped are the daemons this file spawns.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { guardedPath } from '../setup/exec-guard.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { startFakeS3, type FakeS3 } from '../helpers/fake-s3.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-archive-twins-')))
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
const CORE = path.resolve(__dirname, '../../src/providers/task-dir-core.ts')
const scriptPath = path.join(root, 'src', 'daemon.cjs')
// The source twin loads the archive from its sidecar, which only bun builds (as scripts/build-daemon.sh does).
const TWINS: Array<{ name: string; command: [string, string[]] }> = BUN ? [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: [SOURCE_TWIN.file, [scriptPath, '--start']] },
  { name: 'standalone twin (bun)', command: [BUN, [STANDALONE, '--start']] },
] : []

interface Daemon { proc: ChildProcess; ws: WebSocket }
const daemons: Daemon[] = []
let rpcId = 1

beforeAll(() => {
  if (!BUN) return
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
  const built = spawnSync(BUN, ['build', '--target=node', '--format=cjs', '--outfile', path.join(path.dirname(scriptPath), 'task-dir-core.cjs'), CORE], { encoding: 'utf8' })
  if (built.status !== 0) throw new Error('sidecar build failed: ' + built.stderr)
})

async function boot(command: [string, string[]], name: string, home: string): Promise<Daemon> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: home,
    WALNUT_HOME_OVERRIDE: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    WALNUT_DAEMON_DIR: path.join(root, name, 'daemon'),
    WALNUT_STREAMS_DIR: path.join(root, name, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, name, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, name, 'spawn-journal.jsonl'),
    WALNUT_DAEMON_PARENT_PID: String(process.pid),
  }
  const proc = spawn(command[0], command[1], { env, stdio: ['ignore', 'pipe', 'ignore'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 60_000)
    let out = ''
    proc.stdout?.on('data', (chunk) => {
      out += chunk.toString()
      const m = out.match(/^(\d+)$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[1], 10)) }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    onDaemonEarlyExit(proc, { daemonDir: env.WALNUT_DAEMON_DIR }, (err) => { clearTimeout(timer); reject(err) })
  })
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  const d = { proc, ws }
  daemons.push(d)
  return d
}

function rpc(d: Daemon, cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), 60_000)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); d.ws.off('message', onMessage); resolve(msg) }
    }
    d.ws.on('message', onMessage)
    d.ws.send(JSON.stringify({ id, ...cmd }))
  })
}

function writeSession(projectDir: string, sid: string): { main: string; agent: string } {
  const main = Array.from({ length: 400 }, (_, i) => JSON.stringify({ type: 'assistant', uuid: `u${i}`, message: { content: `line ${i} ${'x'.repeat(120)}` } }) + '\n').join('')
  const agent = Array.from({ length: 200 }, (_, i) => JSON.stringify({ type: 'assistant', uuid: `a${i}`, message: { content: `agent ${i} ${'y'.repeat(120)}` } }) + '\n').join('')
  const mainPath = path.join(projectDir, `${sid}.jsonl`)
  const agentPath = path.join(projectDir, sid, 'subagents', 'agent-a1.jsonl')
  fs.mkdirSync(path.dirname(agentPath), { recursive: true })
  fs.writeFileSync(mainPath, main)
  fs.writeFileSync(agentPath, agent)
  return { main, agent }
}

afterAll(async () => {
  for (const d of daemons) {
    try { d.ws.close() } catch { /* closed */ }
    if (d.proc.exitCode === null) {
      d.proc.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { try { d.proc.kill('SIGKILL') } catch { /* gone */ } resolve() }, 10_000)
        d.proc.once('exit', () => { clearTimeout(t); resolve() })
      })
    }
  }
  fs.rmSync(root, { recursive: true, force: true })
}, 60_000)

describe.each(TWINS)('session history archive: $name', ({ name, command }) => {
  const slug = name.replace(/\W+/g, '-')

  it('archives an old session, and every file command reads it back whole', async () => {
    const home = path.join(root, slug, 'home')
    const proj = path.join(home, '.claude', 'projects', '-work-marina')
    for (const sid of ['sid-a', 'sid-b', 'sid-c']) writeSession(proj, sid)
    const d = await boot(command, slug, home)
    const caps = (await rpc(d, { cmd: 'hello' })).capabilities as string[]
    expect(caps).toContain('transcript-archive-v1')
    expect(caps).toContain('host-cache-prune-v1')

    // Files made now have a ctime of now: a 1-day cutoff spares them, so nothing goes.
    expect(await rpc(d, { cmd: 'transcript.archive', olderThanDays: 1 })).toMatchObject({ ok: true, sessions: 0 })
    expect(await rpc(d, { cmd: 'transcript.archive', olderThanDays: 0 })).toMatchObject({ ok: false })
    expect(fs.existsSync(path.join(proj, 'sid-a.jsonl'))).toBe(true)
    const dry = await rpc(d, { cmd: 'transcript.archive', olderThanDays: 1, dryRun: true })
    expect(dry).toMatchObject({ ok: true, dryRun: true })
  }, 120_000)

  it('restores on fs.stat, fs.read, fs.readRange, fs.ls, fs.find and transcript.restore', async () => {
    const home = path.join(root, slug + '-r', 'home')
    const proj = path.join(home, '.claude', 'projects', '-work-marina')
    const bodies: Record<string, { main: string; agent: string }> = {}
    for (const sid of ['s-stat', 's-read', 's-range', 's-ls', 's-find', 's-restore']) bodies[sid] = writeSession(proj, sid)
    // Archive them with the module the daemon bundles (the daemon's own pass needs a 60-day-old ctime).
    const { archiveTranscripts } = await import('../../src/providers/transcript-archive.js')
    const r = await archiveTranscripts([path.join(home, '.claude', 'projects')], { olderThanMs: 86_400_000, now: Date.now() + 2 * 86_400_000 })
    expect(r.sessions).toBe(6)
    const d = await boot(command, slug + '-r', home)

    const st = await rpc(d, { cmd: 'fs.stat', path: path.join(proj, 's-stat.jsonl') })
    expect(st.ok).toBe(true)
    expect(st.size).toBe(Buffer.byteLength(bodies['s-stat'].main))

    const rd = await rpc(d, { cmd: 'fs.read', path: path.join(proj, 's-read.jsonl'), encoding: 'utf-8' })
    expect(rd.ok).toBe(true)
    expect(rd.data).toBe(bodies['s-read'].main)

    const rr = await rpc(d, { cmd: 'fs.readRange', path: path.join(proj, 's-range.jsonl'), start: 0, length: 100 })
    expect(rr.ok).toBe(true)

    const ls = await rpc(d, { cmd: 'fs.ls', path: path.join(proj, 's-ls', 'subagents') })
    expect(ls.ok).toBe(true)
    expect(JSON.stringify(ls)).toContain('agent-a1.jsonl')
    expect(JSON.stringify(ls)).not.toContain('agent-a1.jsonl.gz')
    expect(fs.readFileSync(path.join(proj, 's-ls', 'subagents', 'agent-a1.jsonl'), 'utf8')).toBe(bodies['s-ls'].agent)

    const found = await rpc(d, { cmd: 'fs.find', path: '~/.claude/projects', name: 's-find.jsonl', maxDepth: 3 })
    expect(found).toMatchObject({ ok: true, files: [path.join(proj, 's-find.jsonl')] })
    expect(fs.readFileSync(path.join(proj, 's-find.jsonl'), 'utf8')).toBe(bodies['s-find'].main)

    expect(await rpc(d, { cmd: 'transcript.restore', sessionId: 's-restore' })).toMatchObject({ ok: true, path: path.join(proj, 's-restore.jsonl') })
    expect(fs.readFileSync(path.join(proj, 's-restore', 'subagents', 'agent-a1.jsonl'), 'utf8')).toBe(bodies['s-restore'].agent)
    expect(await rpc(d, { cmd: 'transcript.restore', sessionId: 'no-such' })).toMatchObject({ ok: true, path: null })

    // Nothing of the archive is left behind.
    expect(fs.readdirSync(proj).filter((n) => n.endsWith('.gz') || n.includes('walnut-archive'))).toEqual([])
  }, 120_000)

  it('a session kept in remote storage comes back through its server (history.fetch), checked by hash', async () => {
    const home = path.join(root, slug + '-s3', 'home')
    const proj = path.join(home, '.claude', 'projects', '-work-marina')
    const body = writeSession(proj, 's-remote')
    writeSession(proj, 's-alone')
    const found = writeSession(proj, 's-found')
    const { archiveTranscripts, setRemoteFetcher } = await import('../../src/providers/transcript-archive.js')
    const { offloadArchived, fetchRemoteArchive, OFFLOAD_KEEP_MS } = await import('../../src/providers/transcript-offload.js')
    const { remoteStore, resolveRemote } = await import('../../src/core/history-remote/store.js')
    const projects = [path.join(home, '.claude', 'projects')]
    const later = Date.now() + 400 * 86_400_000
    await archiveTranscripts(projects, { olderThanMs: 86_400_000, now: later })
    await archiveTranscripts(projects, { olderThanMs: 86_400_000, now: later })
    const keys = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY }
    process.env.AWS_ACCESS_KEY_ID = 'AKIAFAKEFAKEFAKE'
    process.env.AWS_SECRET_ACCESS_KEY = 'fake-secret'
    const s3: FakeS3 = await startFakeS3('twins-history')
    try {
      const store = await remoteStore(resolveRemote({ enabled: true, bucket: s3.bucket, endpoint: s3.url, region: 'us-east-1' }))
      const tier = { olderThanMs: 180 * 86_400_000, keyPrefix: 'walnut-history/twin' }
      expect((await offloadArchived(projects, { ...tier, now: later, store })).uploaded).toBe(3)
      expect((await offloadArchived(projects, { ...tier, now: later + OFFLOAD_KEEP_MS, store })).offloaded).toBe(3)
      expect(fs.readdirSync(proj).filter((n) => n.endsWith('.gz'))).toEqual([])
      setRemoteFetcher(null)

      const d = await boot(command, slug + '-s3', home)
      await rpc(d, { cmd: 'hello' })
      // This test plays the daemon's server: it answers history.fetch the way the server does.
      const asked: unknown[] = []
      d.ws.on('message', (data: Buffer) => {
        let msg: { ev?: string; relayId?: number; capability?: string; payload?: { dir?: string; sessionId?: string } }
        try { msg = JSON.parse(data.toString()) } catch { return }
        if (msg.ev !== 'gateway-request' || msg.capability !== 'history.fetch') return
        asked.push(msg.payload)
        void fetchRemoteArchive(msg.payload!.dir!, msg.payload!.sessionId!, store).then(
          (files) => d.ws.send(JSON.stringify({ id: rpcId++, cmd: 'gateway-result', relayId: msg.relayId, result: { files } })),
          (e: Error) => d.ws.send(JSON.stringify({ id: rpcId++, cmd: 'gateway-result', relayId: msg.relayId, error: e.message, errorCode: 'internal' })),
        )
      })
      const rd = await rpc(d, { cmd: 'fs.read', path: path.join(proj, 's-remote.jsonl'), encoding: 'utf-8' })
      expect(rd.ok).toBe(true)
      expect(rd.data).toBe(body.main)
      expect(asked).toEqual([{ dir: proj, sessionId: 's-remote' }])
      expect(fs.readFileSync(path.join(proj, 's-remote', 'subagents', 'agent-a1.jsonl'), 'utf8')).toBe(body.agent)
      expect(fs.existsSync(path.join(proj, 's-remote.walnut-archive.json'))).toBe(false)

      // A find by id (cwd unknown): only the manifest is here, and it answers the transcript, restored.
      const f = await rpc(d, { cmd: 'fs.find', name: 's-found.jsonl' })
      expect(f.ok).toBe(true)
      expect(f.files).toEqual([path.join(proj, 's-found.jsonl')])
      expect(fs.readFileSync(path.join(proj, 's-found.jsonl'), 'utf8')).toBe(found.main)
      expect(asked).toEqual([{ dir: proj, sessionId: 's-remote' }, { dir: proj, sessionId: 's-found' }])

      // Storage down: the read finds no file and the session stays as it was, only in remote storage.
      s3.faults.failAll = true
      const down = await rpc(d, { cmd: 'fs.read', path: path.join(proj, 's-alone.jsonl'), encoding: 'utf-8' })
      expect(down.ok).toBe(false)
      expect(fs.existsSync(path.join(proj, 's-alone.walnut-archive.json'))).toBe(true)
      expect(fs.readdirSync(proj).filter((n) => n.startsWith('s-alone') && (n.endsWith('.gz') || n.includes('walnut-tmp')))).toEqual([])
    } finally {
      await s3.close()
      if (keys.id === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = keys.id
      if (keys.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = keys.secret
    }
  }, 120_000)

  it('a fork of an archived session restores its source before the CLI starts', async () => {
    const home = path.join(root, slug + '-f', 'home')
    const proj = path.join(home, '.claude', 'projects', '-work-marina')
    const body = writeSession(proj, 'fork-parent')
    const { archiveTranscripts } = await import('../../src/providers/transcript-archive.js')
    expect((await archiveTranscripts([path.join(home, '.claude', 'projects')], { olderThanMs: 86_400_000, now: Date.now() + 2 * 86_400_000 })).sessions).toBe(1)
    const parent = path.join(proj, 'fork-parent.jsonl')
    const marker = path.join(root, slug + '-f', 'seen.json')
    // A stand-in CLI that only says what it found when it started.
    const fake = path.join(root, slug + '-f', 'fake-cli.cjs')
    fs.writeFileSync(fake, [
      "const fs = require('fs')",
      'const a = process.argv',
      `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ plain: fs.existsSync(${JSON.stringify(parent)}) ? fs.readFileSync(${JSON.stringify(parent)}, 'utf8') : null, gz: fs.existsSync(${JSON.stringify(parent + '.gz')}) }))`,
      "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: a[a.indexOf('--session-id') + 1] }))",
      'process.stdin.resume()',
    ].join('\n'))
    const d = await boot(command, slug + '-f', home)
    const sh = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"`
    const reply = await rpc(d, { cmd: 'start', sid: 'fork-child', cwd: root, message: '', resume: false, args: ['/bin/sh', '-c', sh, 'sh', '--resume', 'fork-parent', '--fork-session', '--session-id', 'fork-child'] })
    expect(reply.ok).toBe(true)
    for (let n = 0; n < 200 && !fs.existsSync(marker); n++) await new Promise((r) => setTimeout(r, 50))
    expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toEqual({ plain: body.main, gz: false })
    await rpc(d, { cmd: 'stop', sid: 'fork-child' })
  }, 120_000)
})
