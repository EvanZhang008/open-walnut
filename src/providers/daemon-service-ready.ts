/**
 * Whether a service's daemon is up, as `walnut daemon install|update|restart` checks it: ready
 * (the new instance answers a managed hello from the expected executable) and, for an update,
 * stays (the same instance still serving a while later). Split from daemon-service-cli.ts.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { WebSocket } from '#ws'
import { setTimeout as delay } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'

export async function daemonReady(runtimeDir: string, expectedExecutable?: string, timeoutMs = 15_000, previousInstance?: string): Promise<boolean> {
  // Monotonic, as every deadline here: timers stop during a Mac's sleep while Date.now() jumps (2026-11-04 review).
  const deadline = performance.now() + timeoutMs
  const expected = expectedExecutable ? await fs.realpath(expectedExecutable) : undefined
  const markers = () => Promise.all(['daemon.port', 'daemon.instance', 'daemon.service']
    .map((name) => fs.readFile(path.join(runtimeDir, name), 'utf8').then((value) => value.trim())))
  do {
    try {
      const before = await markers()
      const [portText, instanceId, serviceId] = before
      const port = Number(portText)
      if (instanceId && instanceId !== previousInstance && instanceId === serviceId && Number.isInteger(port) && port > 0 && port <= 65535) {
        const reply = await helloOnce(port, Math.max(1, Math.min(1500, deadline - performance.now())))
        const managed = reply?.cronSupervision as { managed?: unknown } | undefined
        if (reply?.ok === true && reply.instanceId === instanceId && managed?.managed === true
          && Array.isArray(reply.capabilities) && reply.capabilities.includes('cron-supervision-v1')
          && (!expected || (typeof reply.serviceExecutable === 'string'
            && await fs.realpath(reply.serviceExecutable) === expected))) {
          const after = await markers()
          if (before.every((value, index) => value === after[index])) return true
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (performance.now() < deadline) await delay(Math.min(250, deadline - performance.now()))
  } while (performance.now() < deadline)
  return false
}

/** One hello to the daemon on `port`: its reply, or null (no answer within timeoutMs, a refused or closed socket). */
function helloOnce(port: number, timeoutMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: 128 * 1024 })
    let finished = false
    const finish = (value: Record<string, unknown> | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      socket.terminate()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    socket.on('error', () => finish(null))
    socket.on('close', () => finish(null))
    socket.on('open', () => socket.send(JSON.stringify({ id: 1, cmd: 'hello' })))
    socket.on('message', (raw) => {
      try {
        const value = JSON.parse(raw.toString())
        if (value?.id === 1) finish(value)
      } catch { finish(null) }
    })
  })
}

/** How long an update's new daemon must stay serving after it first answered (daemonStays). */
export const SERVICE_STAY_MS = 30_000

/**
 * The daemon that just answered stays: `stayMs` later the same instance still owns the runtime
 * dir and answers. null when it does, else why not (the update then rolls back as a build that
 * did not start). 2026-11-04 review: one hello counted, so a build that listened and then exited
 * (launchd or systemd restarting it in a loop) read as an update that went through.
 */
export async function daemonStays(runtimeDir: string, stayMs = SERVICE_STAY_MS): Promise<string | null> {
  const read = (name: string) => fs.readFile(path.join(runtimeDir, name), 'utf8').then((value) => value.trim(), () => '')
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } }
  const [instance, pidText] = await Promise.all([read('daemon.instance'), read('daemon.pid')])
  if (!instance) return 'the new daemon left no instance in its runtime dir after it answered'
  const pid = Number(pidText)
  const secs = Math.round(stayMs / 1000)
  const gone = (why: string) => `the new daemon answered and then did not stay serving for ${secs} s (${why})`
  // Looked at every second (its pid, its instance), so a daemon gone early is caught early; the
  // hello at the end has a slow loop's time to answer, so a busy daemon is not taken for a dead one.
  const deadline = performance.now() + stayMs
  while (performance.now() < deadline) {
    await delay(Math.min(1000, Math.max(1, deadline - performance.now())))
    if (await read('daemon.instance') !== instance) return gone('another instance took the runtime dir')
    if (Number.isInteger(pid) && pid > 1 && !alive(pid)) return gone('its process exited')
  }
  const port = Number(await read('daemon.port'))
  const reply = Number.isInteger(port) && port > 0 && port <= 65535 ? await helloOnce(port, 10_000) : null
  if (reply?.ok !== true || reply.instanceId !== instance) return gone('it no longer answered')
  return null
}
