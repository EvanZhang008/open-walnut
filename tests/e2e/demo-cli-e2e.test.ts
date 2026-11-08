import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import http from 'node:http'
import { WebSocket } from 'ws'
import { demoControl, readDemoState } from '../../src/commands/demo.js'
import { DEMO_URL, demoPaths } from '../../src/commands/demo-home.js'
import { demoSignInScriptFile, shellQuote } from '../../src/commands/demo-sign-ins.js'
import { removeDemoTerminalDir } from '../../src/lib/demo-terminal-dir.js'
import { guardedPath } from '../setup/exec-guard.js'

let base: string
let root: string
let env: NodeJS.ProcessEnv
const cli = path.resolve(import.meta.dirname, '../../src/cli.ts')

async function command(reset = false): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [cli, 'demo', ...(reset ? ['reset'] : []), '--_headless', '--_root', root], {
    cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', data => { output += data.toString() })
  child.stderr.on('data', data => { output += data.toString() })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve({ code, output }))
  })
}

beforeAll(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'demo-cli-')))
  root = path.join(base, 'open-walnut-demo')
  const bin = path.join(base, 'bin')
  const launcherHome = path.join(base, 'launcher-home')
  await fs.mkdir(bin)
  await fs.mkdir(launcherHome)
  await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "2.1.284 (Claude Code)\\n"; exit 0; fi\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then printf "{\\"loggedIn\\":false}\\n"; exit 0; fi\nexit 1\n', { mode: 0o755 })
  await fs.writeFile(path.join(base, 'real-data-sentinel'), 'unchanged')
  env = { HOME: launcherHome, PATH: guardedPath([bin, path.dirname(process.execPath)]),
    OPEN_WALNUT_API_URL: DEMO_URL, WALNUT_SERVER_URL: DEMO_URL,
    OPEN_WALNUT_HOME: path.join(launcherHome, 'launch-data'),
    WALNUT_DAEMON_DIR: path.join(launcherHome, 'launch-daemon'), WALNUT_RUNTIME_DIR: path.join(launcherHome, 'runtime') }
})

afterAll(async () => {
  const state = await readDemoState(path.join(root, 'state.json'))
  if (state && state.status !== 'stopped') {
    const stopped = await demoControl(state, 'stop').catch(() => ({ status: 'unknown' }))
    // A stop the Demo refused keeps its data for a look, but never its server: a failed run on
    // a test host left four of them running for days (2026-11-12). The pid is the one this run's
    // Demo recorded for its own child.
    const gone = async (ms: number) => {
      const until = Date.now() + ms
      for (;;) {
        try { process.kill(state.pid, 0) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error }
        if (Date.now() >= until) return false
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    if (stopped.status !== 'stopped' || !(await gone(15_000))) {
      // Only a process that still is this Demo's server (a pid can be reused).
      let args = ''
      try { args = execFileSync('ps', ['-o', 'args=', '-p', String(state.pid)], { encoding: 'utf8' }) } catch { /* gone */ }
      if (state.pid > 1 && / demo /.test(` ${args} `) && args.includes('--_child')) {
        try { process.kill(state.pid, 'SIGTERM') } catch { /* already gone */ }
      }
      await gone(15_000)
      throw new Error(stopped.status !== 'stopped'
        ? 'Demo cleanup did not confirm stopped; its data was kept, its server was ended'
        : 'Demo child did not exit; its data was kept, its server was ended')
    }
  }
  for (const generation of await fs.readdir(path.join(root, 'data')).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })) {
    const paths = demoPaths(root, generation)
    await removeDemoTerminalDir(paths.terminals, paths.data)
  }
  await fs.rm(base, { recursive: true, force: true })
}, 120_000)

describe('Demo CLI with a real isolated server and an unsigned-in mock CLI', () => {
  it('starts once, reopens the same environment, and resets only Demo data to a new first run', async () => {
    const first = await command()
    expect(first.code, first.output).toBe(0)
    expect(first.output).toContain('Walnut Demo\n[████████████████████] Ready')
    const before = await readDemoState(path.join(root, 'state.json'))
    expect(before?.status).toBe('ready')
    expect(before?.startTime).toMatch(/^(?:proc|ps):/)
    const config = await fetch(`${DEMO_URL}/api/config`)
    expect(config.status).toBe(200)
    const generation = await fetch(`${DEMO_URL}/api/demo/generation`)
    expect(generation.headers.get('cache-control')).toBe('no-store')
    const firstGeneration = await generation.json() as { generation: string; signInCommand: string | null }
    expect(firstGeneration.generation).toBe(before!.generation)
    // One short line that runs this generation's script; the script holds the env -i line.
    const scriptFile = demoSignInScriptFile(demoPaths(root, before!.generation))
    expect(firstGeneration.signInCommand).toBe(`/bin/sh ${shellQuote(scriptFile)}`)
    const script = await fs.readFile(scriptFile, 'utf-8')
    expect(script).toContain('/usr/bin/env -i HOME=')
    expect(script).toContain(demoPaths(root, before!.generation).home)
    expect((await fs.stat(scriptFile)).mode & 0o777).toBe(0o700)
    for (const host of ['localhost:3458', '127.0.0.1', 'demo.example:3458']) {
      const page = await fetch(DEMO_URL + '/', { headers: { host }, redirect: 'manual' })
      expect(page.status).toBe(308)
      expect(page.headers.get('location')).toBe(DEMO_URL)
      expect(page.headers.get('cache-control')).toBe('no-store')
      const api = await fetch(DEMO_URL + '/api/demo/generation', { headers: { host }, redirect: 'manual' })
      expect(api.status).toBe(421)
      const write = await fetch(DEMO_URL + '/api/tasks', { method: 'POST', headers: { host, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Must not create through a Demo alias' }) })
      expect(write.status).toBe(421)
      const upgradeStatus = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(DEMO_URL.replace('http:', 'ws:') + '/ws', { headers: { host }, handshakeTimeout: 3000 })
        socket.once('unexpected-response', (_request: http.ClientRequest, response: http.IncomingMessage) => {
          response.resume()
          resolve(response.statusCode!)
          socket.terminate()
        })
        socket.once('error', reject)
        socket.once('open', () => { socket.close(); reject(new Error('Demo alias upgraded unexpectedly')) })
      })
      expect(upgradeStatus).toBe(421)
    }
    const reopened = await command()
    expect(reopened.code, reopened.output).toBe(0)
    expect((await readDemoState(path.join(root, 'state.json')))?.pid).toBe(before!.pid)
    for (const query of ['', '?demo-generation=other-generation']) {
      const status = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(DEMO_URL.replace('http:', 'ws:') + '/ws' + query, { handshakeTimeout: 3000 })
        socket.once('unexpected-response', (_request: http.ClientRequest, response: http.IncomingMessage) => {
          response.resume()
          resolve(response.statusCode!)
          socket.terminate()
        })
        socket.once('error', reject)
        socket.once('open', () => { socket.close(); reject(new Error('Unstamped Demo socket upgraded unexpectedly')) })
      })
      expect(status).toBe(409)
    }
    const currentSocket = new WebSocket(DEMO_URL.replace('http:', 'ws:') + '/ws?demo-generation=' + before!.generation)
    await new Promise<void>((resolve, reject) => { currentSocket.once('open', resolve); currentSocket.once('error', reject) })
    await new Promise<void>(resolve => { currentSocket.once('close', () => resolve()); currentSocket.close() })
    const unstamped = await fetch(`${DEMO_URL}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Must not create without a Demo generation' }) })
    expect(unstamped.status).toBe(409)
    const made = await fetch(`${DEMO_URL}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-walnut-demo-generation': before!.generation }, body: JSON.stringify({ title: 'Demo task before reset' }) })
    expect(made.status).toBe(201)
    const task = await made.json() as { task: { id: string } }
    const unload = (generation?: string) => fetch(`${DEMO_URL}/api/browser-logs`, {
      method: 'POST', keepalive: true,
      headers: { 'content-type': 'application/json', ...(generation ? { 'x-walnut-demo-generation': generation } : {}) },
      body: JSON.stringify({ entries: [] }),
    })
    expect((await unload()).status).toBe(409)
    expect((await unload(before!.generation)).status).toBe(204)
    const reset = await command(true)
    expect(reset.code, reset.output).toBe(0)
    expect(reset.output).toContain('Stopping demo sessions... [████████████████████] Done')
    expect(reset.output).toContain('This is a new-user first run.')
    const after = await readDemoState(path.join(root, 'state.json'))
    expect(after?.status).toBe('ready')
    expect(after!.generation).not.toBe(before!.generation)
    expect(after!.pid).not.toBe(before!.pid)
    const nextGeneration = await (await fetch(`${DEMO_URL}/api/demo/generation`)).json() as { generation: string; signInCommand: string | null }
    expect(nextGeneration.generation).toBe(after!.generation)
    const nextScriptFile = demoSignInScriptFile(demoPaths(root, after!.generation))
    expect(nextGeneration.signInCommand).toBe(`/bin/sh ${shellQuote(nextScriptFile)}`)
    const nextScript = await fs.readFile(nextScriptFile, 'utf-8')
    expect(nextScript).toContain(demoPaths(root, after!.generation).home)
    expect(nextScript).not.toContain(demoPaths(root, before!.generation).home)
    expect((await unload(before!.generation)).status).toBe(409)
    expect((await unload(after!.generation)).status).toBe(204)
    const stale = await fetch(`${DEMO_URL}/api/tasks`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-walnut-demo-generation': before!.generation,
    }, body: JSON.stringify({ title: 'Must not restore an old draft' }) })
    expect(stale.status).toBe(409)
    expect((await fetch(`${DEMO_URL}/api/tasks/${task.task.id}`, { headers: { 'x-walnut-demo-generation': after!.generation } })).status).toBe(404)
    expect((await fetch(`${DEMO_URL}/api/tasks`, { headers: { 'x-walnut-demo-generation': before!.generation } })).status).toBe(409)
    expect((await fetch(`${DEMO_URL}/api/tasks`)).status).toBe(200)
    expect(await fs.readFile(path.join(base, 'real-data-sentinel'), 'utf8')).toBe('unchanged')
    const keptOld = reset.output.includes('Kept for now')
    const generations = keptOld ? [before!.generation, after!.generation].sort() : [after!.generation]
    expect((await fs.readdir(path.join(root, 'homes'))).sort()).toEqual(generations)
    expect((await fs.readdir(path.join(root, 'data'))).sort()).toEqual(generations)
    expect(demoPaths(root, before!.generation).daemon).not.toBe(demoPaths(root, after!.generation).daemon)
  }, 240_000)
})
