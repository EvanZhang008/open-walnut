import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { assertDemoPaths, demoPaths, DEMO_PORT, DEMO_URL, type DemoPaths } from './demo-home.js'
import { readDemoState, writeDemoState, type DemoState } from './demo.js'
import { demoProcessStart } from './demo-process.js'
import { closeDemoWork } from '../core/sessions/demo-admission.js'
import { closeDemoSignIns, reopenDemoSignIns, writeDemoSignInScript } from './demo-sign-ins.js'
import { demoBeforeRoutes } from './demo-routes.js'
import { startDemoRealSsh } from './demo-real-ssh.js'

/** Which configured hosts the Demo runs its own daemon on (providers/demo-remote-host.ts); none when config cannot be read. */
async function demoLiftedHosts(): Promise<{ lifted(host: string): boolean }> {
  const [{ isDemoLiftedHost }, { IS_DEMO }, { getConfig }] = await Promise.all([
    import('../providers/demo-remote-host.js'), import('../constants.js'), import('../core/config-manager.js'),
  ])
  const hosts = (await getConfig().catch(() => null))?.hosts ?? {}
  return { lifted: host => Object.hasOwn(hosts, host) && isDemoLiftedHost(host, hosts[host], IS_DEMO) }
}

export async function stopDemoProcesses(paths: DemoPaths, recovering = false): Promise<void> {
  await closeDemoSignIns(paths)
  const [{ localDaemon }, tracker, owners, connections, demoHosts] = await Promise.all([
    import('../providers/local-daemon.js'), import('../core/session-tracker.js'),
    import('../core/sessions/owner-stop.js'), import('../providers/daemon-connection.js'),
    demoLiftedHosts(),
  ])
  await (await import('./demo-terminals.js')).stopDemoTerminals(paths)
  const records = (await tracker.listSessions()).filter(row => !row.host || row.host === '__local__' || !demoHosts.lifted(row.host))
  // A host the Demo runs its own daemon on is stopped before this (demo-remote-stop.ts); any other remote row blocks.
  if (records.some(row => row.host && row.host !== '__local__')) {
    throw new Error('Demo contains remote sessions. Their own host must confirm they stopped before reset.')
  }
  const daemonPortFile = path.join(paths.daemon, 'daemon.port')
  const daemonExists = await fs.stat(daemonPortFile).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  })
  if (!daemonExists && !recovering) {
    if (records.some(row => row.pid || row.acpRuntimeId)) throw new Error('Demo daemon is unavailable; sessions cannot be confirmed stopped')
    return
  }
  // stopServer closed the dial gate, so a stopping server leaves every daemon link to the next one
  // (providers/daemon-dial-gate.ts). No next server dials the Demo's own daemon: this confirm is the
  // last thing that talks to it before it stops, so it dials past the gate, which closes again after.
  const gate = await import('../providers/daemon-dial-gate.js')
  const reopened = gate.daemonDialsClosed()
  if (reopened) gate.reopenDaemonDials()
  try {
    const port = await localDaemon.ensureRunning()
    const conn = await connections.getDirectDaemonConnection('__local__', `ws://127.0.0.1:${port}`)
    const deps = { connection: async () => conn }
    const quiet = await conn.send('demo.quiesce', { home: paths.data }, 30_000)
    if (quiet.ok !== true || quiet.quiet !== true || !Array.isArray(quiet.acpRuntimes)
      || quiet.acpRuntimes.some((row: { sid?: unknown }) => !row || typeof row.sid !== 'string' || !row.sid)) {
      throw new Error('Demo daemon did not confirm that pending work settled; data was kept')
    }
    const acpRecords = new Map<string, Pick<typeof records[number], 'claudeSessionId' | 'host' | 'acpRuntimeId'>>(
      records.filter(row => row.acpRuntimeId).map(row => [row.acpRuntimeId!, row]),
    )
    for (const runtime of quiet.acpRuntimes as Array<{ sid: string }>) {
      if (!acpRecords.has(runtime.sid)) acpRecords.set(runtime.sid, {
        claudeSessionId: runtime.sid, host: '__local__', acpRuntimeId: runtime.sid,
      })
    }
    for (const row of acpRecords.values()) {
      if (row.acpRuntimeId) {
        if (await owners.stopAcpThroughOwner(row, 'demo_reset', deps) !== 'stopped') {
          throw new Error('Demo agent did not confirm its stop; data was kept')
        }
        const reply = await conn.send('acpState', { sid: row.acpRuntimeId }, 10_000)
        if (reply.ok !== false || reply.errorKind !== 'no_worker') throw new Error('Demo agent is still stopping; data was kept')
      }
    }
    const listed = await conn.send('list', {}, 10_000)
    const rows = listed.sessions
    if (!Array.isArray(rows)) throw new Error('Demo daemon did not list its sessions; data was kept')
    for (const row of rows as Array<{ sid: string; alive: boolean }>) {
      if (row.alive && await owners.stopThroughOwner({ claudeSessionId: row.sid, host: '__local__' }, 'user', 'demo_reset', deps, 'human') !== 'stopped') {
        throw new Error('Demo session did not confirm its stop; data was kept')
      }
    }
    const remaining = await conn.send('list', {}, 10_000)
    if (!Array.isArray(remaining.sessions) || remaining.sessions.some((row: { alive?: boolean }) => row.alive)) {
      throw new Error('Demo still has live sessions; data was kept')
    }
    const running = await (await import('../providers/exec-runs-hold.js')).execRunsProven(conn, 10_000)
    if (running === null) throw new Error('Demo daemon did not list its commands; data was kept')
    if (running > 0) throw new Error('Demo still has commands running; wait for them to finish before reset')
    await localDaemon.stopIfIsolated()
  } finally {
    if (reopened) gate.closeDaemonDials()
  }
}

export async function runDemoServer(): Promise<void> {
  const root = process.env.WALNUT_DEMO_ROOT
  const generation = process.env.WALNUT_DEMO_GENERATION
  const token = process.env.WALNUT_DEMO_TOKEN
  if (!root || !generation || !token || !/^[a-f0-9-]{36}$/.test(token)) throw new Error('Demo startup is missing its isolated identity')
  const paths = demoPaths(root, generation)
  await assertDemoPaths(paths)
  if (process.env.HOME !== paths.home || process.env.OPEN_WALNUT_HOME !== paths.data
    || process.env.WALNUT_DAEMON_DIR !== paths.daemon || !process.argv.includes('--_ephemeral-child')) {
    throw new Error('Demo refuses to start outside its own HOME, data and daemon directories')
  }
  delete process.env.WALNUT_DEMO_TOKEN
  const recovering = process.env.WALNUT_DEMO_RECOVER === '1'
  delete process.env.WALNUT_DEMO_RECOVER
  const markerDeadline = Date.now() + 10_000
  for (;;) {
    const marker = await readDemoState(paths.state)
    if (marker?.token === token && marker.pid === process.pid && marker.generation === generation) break
    if (Date.now() >= markerDeadline) throw new Error('Demo launcher did not record this child')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const { startServer, stopServer, armGracefulSignalExit } = await import('../web/server.js')
  const startTime = await demoProcessStart(process.pid)
  if (!startTime) throw new Error('Demo could not read its own process start time')
  let state: DemoState = { v: 1, generation, token, controlPort: 0, pid: process.pid, startTime, status: 'starting' }
  let stopping: Promise<void> | null = null
  const stop = (): Promise<void> => {
    if (stopping) return stopping
    // A failed stop remains closed, including clocks and terminal opens already in flight.
    const quiet = closeDemoWork()
    stopping = (async () => {
      await quiet
      const ws = await import('../web/ws/handler.js')
      ws.setRpcGate(() => 'Demo is stopping; no new work is accepted')
      ws.closeAllClients(1012, 'Demo is stopping')
      // While the server still holds its daemon links: the Demo's own daemons on remote hosts go first.
      const remote = await import('./demo-remote-stop.js')
      await remote.stopDemoRemoteHosts(await remote.defaultDemoRemoteStopDeps())
      await stopServer({ dropConnections: true, reason: 'demo_stop' })
      // The server kept its SSH masters for a next process; this data dir has none (demo-ssh-masters.ts).
      await (await import('./demo-ssh-masters.js')).endDemoSshMasters()
      await stopDemoProcesses(paths)
      state = { ...state, status: 'stopped', error: undefined }
      await writeDemoState(paths, state)
    })().catch(async error => {
      state = { ...state, status: 'failed', error: error instanceof Error ? error.message : String(error) }
      await writeDemoState(paths, state)
      stopping = null
      throw error
    })
    return stopping
  }
  const control = http.createServer((req, res) => {
    const supplied = req.headers['x-walnut-demo-token']
    const suppliedBytes = typeof supplied === 'string' ? Buffer.from(supplied) : null
    const tokenBytes = Buffer.from(token)
    const allowed = suppliedBytes !== null && suppliedBytes.length === tokenBytes.length
      && timingSafeEqual(suppliedBytes, tokenBytes)
    if (!allowed) { res.writeHead(403); res.end(); return }
    if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403); res.end(); return }
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    if (req.method === 'GET' && req.url === '/status') { res.end(JSON.stringify(state)); return }
    // Only a Demo whose stop failed exits on request: it serves nothing and accepts no work, and
    // the launcher's recovery then stops what that stop left (demo.ts).
    if (req.method === 'POST' && req.url === '/exit') {
      if (state.status !== 'failed') { res.writeHead(409); res.end(JSON.stringify({ ...state, error: 'Only a Demo whose stop failed exits this way' })); return }
      res.end(JSON.stringify(state))
      control.close(() => process.exit(1))
      return
    }
    if (req.method !== 'POST' || req.url !== '/stop') { res.writeHead(404); res.end(); return }
    if (state.status === 'starting') { res.writeHead(409); res.end(JSON.stringify({ ...state, error: 'Demo is still starting; reset after it is ready' })); return }
    void stop().then(() => {
      res.end(JSON.stringify(state))
      control.close(() => process.exit(0))
    }).catch(() => { res.statusCode = 409; res.end(JSON.stringify(state)) })
  })
  await new Promise<void>((resolve, reject) => {
    control.once('error', reject)
    control.listen(0, '127.0.0.1', resolve)
  })
  const address = control.address()
  if (!address || typeof address === 'string') throw new Error('Demo control did not open its loopback port')
  state.controlPort = address.port
  await writeDemoState(paths, state)
  const signalStop = () => {
    if (state.status === 'starting') { process.exit(1); return }
    void stop().then(() => control.close(() => process.exit(0))).catch(() => process.exit(1))
  }
  process.on('SIGINT', signalStop)
  process.on('SIGTERM', signalStop)
  process.on('SIGHUP', signalStop)
  armGracefulSignalExit()
  try {
    if (recovering) {
      await stopDemoProcesses(paths, true)
      await reopenDemoSignIns(paths)
    }
    const signInCommand = await writeDemoSignInScript(paths).catch(() => null)
    // The Demo lists the person's own SSH hosts by itself: read the account's ~/.ssh (demo-real-ssh.ts).
    await startDemoRealSsh(paths)
    const server = await startServer({
      port: DEMO_PORT, bindAddress: '127.0.0.1',
      beforeRoutes: demoBeforeRoutes({
        paths, generation, signInCommand, host: `127.0.0.1:${DEMO_PORT}`, url: DEMO_URL,
        closed: () => !!stopping || state.status === 'failed',
      }),
    })
    const onUpgrade = server.listeners('upgrade')
    server.removeAllListeners('upgrade')
    server.on('upgrade', (req, socket, head) => {
      if (req.headers.host !== `127.0.0.1:${DEMO_PORT}`) {
        socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      const clientGeneration = new URL(req.url ?? '/', DEMO_URL).searchParams.get('demo-generation')
      if (clientGeneration !== generation) {
        socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      if (stopping || state.status === 'failed') { socket.destroy(); return }
      for (const listener of onUpgrade) listener.call(server, req, socket, head)
    })
    state = { ...state, status: 'ready' }
    await writeDemoState(paths, state)
  } catch (error) {
    state = { ...state, status: 'failed', error: error instanceof Error ? error.message : String(error) }
    await writeDemoState(paths, state)
    process.stderr.write(`Demo startup failed: ${state.error}\n`)
  }
}
