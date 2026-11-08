import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { singleFile } from '../lib/single-file.js'
import { withFileLock } from '../utils/file-lock.js'
import { writeJsonFile } from '../utils/fs.js'
import { demoProcessStart, demoServerGroupGone } from './demo-process.js'
import { assertDemoPaths, clearDemoHome, demoChildEnv, demoPaths, DEMO_PORT, DEMO_URL, keptDemoGenerations, prepareDemoHome, type DemoKept, type DemoPaths } from './demo-home.js'

export interface DemoState {
  v: 1
  generation: string
  token: string
  controlPort: number
  pid: number
  startTime?: string
  status: 'starting' | 'ready' | 'stopped' | 'failed'
  error?: string
}

export async function readDemoState(file: string): Promise<DemoState | null> {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as DemoState
    if (!value || value.v !== 1 || typeof value.generation !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(value.generation)
      || typeof value.token !== 'string' || !/^[a-f0-9-]{36}$/.test(value.token) || !Number.isInteger(value.pid) || value.pid <= 1
      || !Number.isInteger(value.controlPort) || value.controlPort < 0 || value.controlPort > 65535
      || (value.startTime !== undefined && (typeof value.startTime !== 'string' || !/^(proc:\d+|ps:.+)$/.test(value.startTime)))
      || (value.controlPort === 0 && value.status !== 'starting')
      || !['starting', 'ready', 'stopped', 'failed'].includes(value.status)) {
      throw new Error('Demo state is invalid; no data was cleared')
    }
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof SyntaxError) throw new Error('Demo state could not be read. Its data was kept; restore state.json from a backup before continuing.')
    throw error
  }
}

export async function writeDemoState(paths: DemoPaths, state: DemoState): Promise<void> {
  await writeJsonFile(paths.state, state, { mode: 0o600, durable: true })
}

export async function demoControl(state: DemoState, action: 'status' | 'stop' | 'exit'): Promise<DemoState> {
  const response = await fetch(`http://127.0.0.1:${state.controlPort}/${action}`, {
    method: action === 'status' ? 'GET' : 'POST',
    headers: { 'x-walnut-demo-token': state.token },
    signal: AbortSignal.timeout(action === 'stop' ? 90_000 : 3000), redirect: 'error',
  })
  const answer = await response.json() as DemoState
  if (!response.ok || answer.token !== state.token || answer.generation !== state.generation || answer.pid !== state.pid) {
    throw new Error(answer.error ?? 'The running server did not prove its Demo identity')
  }
  return answer
}

/** One sentence ending in a single period, for joining a server's error to the next step. */
function sentence(text: string): string {
  const t = text.trim()
  return /[.!?]$/.test(t) ? t : `${t}.`
}

/** The reset's one line when it kept the old generation, by why (`demoKeptBy`). */
export const DEMO_KEPT_LINE: Record<DemoKept, string> = {
  unknown: 'Clearing demo data...     Kept for now: a background process could not be checked. A later reset clears it.',
  unread: 'Clearing demo data...     Kept for now: this computer was too busy to list its processes in time. A later reset clears it.',
  unsupported: 'Clearing demo data...     Kept: this system cannot be checked for Demo processes, so old Demo data stays.',
}

async function waitDemoGone(state: DemoState, stillMessage: string): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    if (await demoServerGroupGone(state)) return
    if (Date.now() >= deadline) throw new Error(stillMessage)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

export function assertDemoPortFree(): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', () => reject(new Error(`Port ${DEMO_PORT} is in use. Demo will not stop another server.`)))
    probe.listen(DEMO_PORT, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()))
  })
}

async function waitForDemo(paths: DemoPaths, child: ReturnType<typeof spawn>, token: string): Promise<DemoState> {
  const deadline = Date.now() + 90_000
  let spawnError: Error | undefined
  child.once('error', error => { spawnError = error })
  for (;;) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Demo could not start. Its data was kept; see server.log in the Demo directory.')
    const state = await readDemoState(paths.state)
    if (state?.token === token) {
      if (state.status === 'failed') throw new Error(`${sentence(state.error ?? 'Demo startup failed')} Run walnut demo reset to start a new-user Demo.`)
      if (state.status === 'ready') return demoControl(state, 'status')
    }
    if (Date.now() >= deadline) throw new Error('Demo is still starting. Its data was kept; run walnut demo again to check it.')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

async function openDemo(): Promise<void> {
  let demoApp: string | undefined
  if (process.platform === 'darwin') {
    const home = (await import('../lib/account.js')).accountInfo().homedir
    for (const candidate of [
      path.join(path.dirname(process.execPath), 'Walnut Demo.app'),
      '/Applications/Walnut.app/Contents/Helpers/Walnut Demo.app',
      path.join(home, 'Applications/Walnut.app/Contents/Helpers/Walnut Demo.app'),
      '/Applications/Walnut Demo.app', path.join(home, 'Applications/Walnut Demo.app'),
    ]) {
      if (await fs.stat(candidate).then(stat => stat.isDirectory(), () => false)) { demoApp = candidate; break }
    }
  }
  const file = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', DEMO_URL] : [demoApp ?? DEMO_URL]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Could not open Demo; open ${DEMO_URL} in your browser.`)))
  })
}

export async function runDemo(action?: string, options: { _child?: boolean; _headless?: boolean; _root?: string } = {}): Promise<void> {
  if (options._child) {
    await (await import('./demo-server.js')).runDemoServer()
    return
  }
  if (action !== undefined && action !== 'reset') throw new Error('Use walnut demo or walnut demo reset')
  const root = demoPaths(options._root)
  await assertDemoPaths(root)
  await fs.mkdir(root.root, { recursive: true, mode: 0o700 })
  await fs.chmod(root.root, 0o700)
  await withFileLock(root.state, async () => {
    let state = await readDemoState(root.state)
    if (!state) {
      for (const name of ['d', 'homes', 'data', 'task-dirs']) {
        const entries = await fs.readdir(path.join(root.root, name)).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
          throw error
        })
        if (entries.length) throw new Error('Demo state is missing but its generation directories remain; no data was cleared')
      }
    }
    let recovering = false
    if (state && state.status !== 'stopped') {
      state = await demoControl(state, 'status').catch(async error => {
        if (await demoServerGroupGone(state!)) {
          recovering = true
          return { ...state!, status: 'stopped' as const }
        }
        if (action === 'reset') throw new Error(`Demo is not answering. Its sessions cannot be confirmed stopped, so no data was cleared. ${error instanceof Error ? error.message : String(error)}`)
        throw error
      })
      if (state.status === 'starting') throw new Error('Demo is still starting; run walnut demo again shortly.')
      // A stop that failed left the server closed with nothing serving (2026-11-09 review: no
      // command brought it back). Its process exits on request, and the recovery below stops
      // whatever the failed stop left, as after a crash.
      let failedStop: string | undefined
      if (state.status === 'failed') {
        failedStop = state.error ?? 'Demo could not stop'
        const failed = await demoControl(state, 'exit')
        await waitDemoGone(failed, 'Demo server is still stopping; no data was cleared. Run walnut demo again shortly.')
        recovering = true
        state = { ...failed, status: 'stopped' as const }
      }
      if (action === 'reset' && !recovering) {
        try {
          state = await demoControl(state, 'stop')
        } catch (error) {
          throw new Error(`${sentence(error instanceof Error ? error.message : String(error))} No data was cleared. Run walnut demo to bring the Demo back.`)
        }
        if (state.status !== 'stopped') throw new Error('Demo sessions are not confirmed stopped; no data was cleared. Run walnut demo to bring the Demo back.')
        await waitDemoGone(state, 'Demo server is still stopping; no data was cleared')
      }
      if (failedStop && action === 'reset') throw new Error(`${sentence(failedStop)} The Demo was closed and data was kept. Run walnut demo to bring it back, then walnut demo reset.`)
    }
    if (recovering && action === 'reset') throw new Error('Demo stopped unexpectedly. Run walnut demo to recover it before resetting; data was kept.')
    if (action === 'reset') {
      if (state && !await demoServerGroupGone(state)) throw new Error('Demo server has not exited; no data was cleared')
      await assertDemoPortFree()
      console.log('Stopping demo sessions... [████████████████████] Done')
      if (state) {
        const cleared = await clearDemoHome(demoPaths(root.root, state.generation), true)
        console.log(cleared === true ? 'Clearing demo data...     [████████████████████] Done' : DEMO_KEPT_LINE[cleared])
        // A generation an earlier reset kept goes once its processes are gone; a failure keeps it and never stops the reset.
        for (const generation of await keptDemoGenerations(root.root, state.generation)) {
          await clearDemoHome(demoPaths(root.root, generation), true).catch(() => false)
        }
      } else console.log('Clearing demo data...     [████████████████████] Done')
      state = null
    }
    if (!state || state.status === 'stopped') {
      await assertDemoPortFree()
      const generation = state?.generation ?? randomUUID()
      const paths = demoPaths(root.root, generation)
      const token = randomUUID()
      const startTime = await demoProcessStart(process.pid)
      if (!startTime) throw new Error('Demo launcher identity is unavailable; data was kept')
      await writeDemoState(paths, { v: 1, generation, token, controlPort: 0, pid: process.pid, startTime, status: 'starting' })
      await prepareDemoHome(paths)
      const logFile = await fs.open(path.join(paths.root, 'server.log'), 'a', 0o600)
      const childArgs = singleFile() ? ['demo', '--_child', '--_ephemeral-child']
        : [path.resolve(process.argv[1]!), 'demo', '--_child', '--_ephemeral-child']
      const child = spawn(process.execPath, childArgs, {
        cwd: paths.home, env: { ...demoChildEnv(process.env, paths, token), ...(recovering ? { WALNUT_DEMO_RECOVER: '1' } : {}) },
        detached: true, stdio: ['ignore', logFile.fd, logFile.fd],
      })
      child.once('error', () => {})
      if (!child.pid) { await logFile.close(); throw new Error('Demo child could not start; data was kept') }
      await writeDemoState(paths, { v: 1, generation, token, controlPort: 0, pid: child.pid, status: 'starting' })
      await logFile.close()
      child.unref()
      state = await waitForDemo(paths, child, token)
    }
    if (state.status !== 'ready') throw new Error(`${sentence(state.error ?? 'Demo is not ready; its data was kept')} Run walnut demo reset to start a new-user Demo.`)
    const health = await fetch(`${DEMO_URL}/api/config`, { signal: AbortSignal.timeout(5000), redirect: 'error' })
    if (!health.ok) throw new Error('Demo is not serving its first-run page yet; data was kept')
    if (action === 'reset') console.log('Starting a fresh demo...  [████████████████████] Ready')
    else { console.log('Walnut Demo'); console.log('[████████████████████] Ready') }
    if (!options._headless) {
      await openDemo()
      console.log(action === 'reset' ? 'Opening Walnut Demo. This is a new-user first run.' : 'Opening Walnut Demo.')
    } else console.log(action === 'reset' ? `Walnut Demo is at ${DEMO_URL}. This is a new-user first run.` : `Walnut Demo is at ${DEMO_URL}.`)
    console.log('Your real Walnut and data are unchanged.')
  }, { timeoutMs: 120_000 })
}
