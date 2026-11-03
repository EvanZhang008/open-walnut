/**
 * The host network update io (src/providers/daemon-net-update-io.ts) against BOTH daemon
 * twins booted for real: the upload rides fs.writePart (each chunk checked by the
 * daemon), the checks and the launch ride exec.run (the login shell, then /bin/sh), the
 * final `walnut daemon update` runs from a script outside every exec job's process group,
 * is asked again while it answers "has active operations", and its answer is read back
 * with fs.read; the staging dir is gone afterwards.
 *
 * What it cannot show: a real service handover. `walnut daemon update` refuses a test
 * account (daemon-service-cli.ts: VITEST, a fake HOME) and a twin started here is no
 * OS service, so the uploaded "daemon" is a fake script that answers like one. The
 * handover itself is covered by daemon-service-handover-busy-twins-e2e.test.ts.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the task root are temp paths; the only
 * staging dirs touched are the /tmp/open-walnut-update.* ones this file's runs made;
 * the daemon is SIGKILLed after each twin.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { createNetUpdateIo } from '../../src/providers/daemon-net-update-io.js'
import { updateRemoteDaemonService } from '../../src/providers/daemon-service-update.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const VERSION = 'walnut-daemon-288f4bee1ea6'
const STAGING = /\/tmp\/open-walnut-update\.[a-zA-Z0-9]+/
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-net-update-twins-')))
const made = new Set<string>()
afterAll(() => {
  for (const dir of made) if (STAGING.test(dir)) fs.rmSync(dir, { recursive: true, force: true })
  if (root.includes('walnut-net-update-twins-')) fs.rmSync(root, { recursive: true, force: true })
})
const scriptPath = path.join(root, 'daemon.cjs')
fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
if (BUN) {
  for (const name of ['task-dir-core', 'host-exec-core']) {
    const built = spawnSync(BUN, ['build', '--target=node', '--format=cjs', '--outfile', path.join(root, `${name}.cjs`),
      path.resolve(__dirname, `../../src/providers/${name}.ts`)], { encoding: 'utf8' })
    if (built.status !== 0) throw new Error('sidecar build failed: ' + built.stderr)
  }
}
// The source twin runs exec.run only with its sidecar, which needs bun to build.
const TWINS: Array<{ name: string; command: () => [string, string[]] }> = BUN ? [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  { name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] },
] : []

let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1
afterEach(async () => {
  try { ws?.close() } catch { /* closed */ }
  ws = null
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((r) => { const t = setTimeout(r, 10_000); proc!.once('exit', () => { clearTimeout(t); r() }) })
    proc.kill('SIGKILL')
    await exited
  }
  proc = null
})

async function boot(twin: (typeof TWINS)[number], dir: string): Promise<void> {
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env: Record<string, string | undefined> = {
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, WALNUT_HOME_OVERRIDE: home,
    WALNUT_DAEMON_DIR: path.join(dir, 'daemon'), WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TASK_DIR_ROOT: path.join(dir, 'state', 'tasks'),
  }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    onDaemonEarlyExit(proc!, { daemonDir: env.WALNUT_DAEMON_DIR }, (err) => { clearTimeout(timer); reject(err) })
  })
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
}

function rpc(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  const sock = ws!
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); sock.off('message', onMessage); resolve(msg) }
    }
    sock.on('message', onMessage)
    sock.send(JSON.stringify({ id, ...cmd }))
  })
}

describe.skipIf(TWINS.length === 0)('host network update over the daemon link', () => {
  it.each(TWINS)('$name: uploads, checks and runs the update detached over the daemon\'s own commands', async (twin) => {
    const dir = path.join(root, twin.name.replace(/\W+/g, '-'))
    const state = path.join(dir, 'fake-state')
    fs.mkdirSync(state, { recursive: true })
    await boot(twin, dir)
    const caps = (await rpc({ cmd: 'hello' })).capabilities as string[]
    for (const cap of ['host-exec-v1', 'fs-write-part-v1']) expect(caps).toContain(cap)

    // The "daemon" uploaded: its version, then `walnut daemon update` busy once, then done.
    const binary = path.join(dir, 'daemon-src')
    fs.writeFileSync(binary, [
      '#!/bin/sh',
      `s='${state}'`,
      `if [ "$1 $2" = "__daemon --version" ]; then echo ${VERSION}; exit 0; fi`,
      'n=$(cat "$s/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$s/count"',
      'echo "pgid=$(ps -o pgid= -p $$ | tr -d " ") $*" >> "$s/calls"',
      `if [ "$n" -le 1 ]; then printf '%s\\n' '{"ok":false,"failure":{"code":"updateRefused","message":"Daemon has active operations; retry after they finish"}}'; exit 1; fi`,
      `printf '%s\\n' '{"ok":true,"status":{"scope":"user"}}'`,
      '',
    ].join('\n'), { mode: 0o755 })

    const sent: Array<{ cmd: string; output?: string }> = []
    const conn = {
      async send(cmd: string, params: Record<string, unknown> = {}, timeoutMs?: number) {
        const reply = await rpc({ cmd, ...params }, timeoutMs)
        const output = typeof reply.output === 'string' ? reply.output : undefined
        for (const m of (output ?? '').matchAll(new RegExp(STAGING.source, 'g'))) made.add(m[0])
        sent.push({ cmd, output })
        return reply
      },
    }
    const latestMarker = path.join(root, `latest-${twin.name.replace(/\W+/g, '-')}`)
    await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(conn, { pauseSeconds: 0.3, settleSeconds: 0, pollMs: 200, waitMs: 60_000, latestMarker }), 'user')

    const cmds = sent.map((s) => s.cmd)
    expect(cmds.filter((c) => c === 'fs.writePart').length).toBeGreaterThanOrEqual(2) // the chunks, then the script
    expect(cmds).toContain('fs.read')
    const updates = fs.readFileSync(path.join(state, 'calls'), 'utf8').trim().split('\n')
    expect(updates).toHaveLength(2)
    expect(updates[1]).toMatch(/walnut daemon update --yes --scope user --executable \/tmp\/open-walnut-update\.\w+\/daemon$/)
    // The launcher saw the script in a group of its own, and the update ran in that group.
    const launch = sent.find((s) => /walnut-update-started/.test(s.output ?? ''))?.output ?? ''
    const [, group, own] = /group=(\d+) own=(\d+)/.exec(launch) ?? []
    expect(group).toBeTruthy()
    expect(group).not.toBe(own)
    expect(updates.every((u) => u.startsWith(`pgid=${group} `))).toBe(true)
    // The launch named itself the latest update, so an older runner would stop.
    expect(fs.readFileSync(latestMarker, 'utf8').trim()).toMatch(STAGING)
    for (const d of made) expect(fs.existsSync(d)).toBe(false)
  }, 120_000)
})
