import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import net from 'node:net'

/**
 * Start the walnut-time fixture server (time-app-server.ts) for one spec file and stop it
 * after. It is a real Walnut server on its own port and data home, so a spec may write
 * to it freely.
 */

export interface TimeFixture {
  port: number
  home: string
  slots: { taskId: string; emptyTaskId: string; sessionIds: string[]; today: string }
}

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a fixture port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

export async function startTimeFixture(env: Record<string, string>): Promise<{ fixture: TimeFixture; stop: () => Promise<void> }> {
  const port = await reservePort()
  let output = ''
  const child: ChildProcessWithoutNullStreams = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/time-app-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PW_TIME_APP_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  const fixture = await new Promise<TimeFixture>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Time fixture did not start\n${output.slice(-8000)}`)), 180_000)
    const timer = setInterval(() => {
      const match = /TIME_APP_READY (\{.*\})/.exec(output)
      if (match) {
        clearInterval(timer)
        clearTimeout(deadline)
        resolve(JSON.parse(match[1]!) as TimeFixture)
      } else if (child.exitCode !== null) {
        clearInterval(timer)
        clearTimeout(deadline)
        reject(new Error(`Time fixture exited early (${child.exitCode})\n${output.slice(-8000)}`))
      }
    }, 250)
  })
  const stop = async () => {
    if (child.exitCode !== null) return
    const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    const graceful = await Promise.race([
      stopped.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20_000)),
    ])
    if (!graceful) child.kill('SIGKILL')
  }
  return { fixture, stop }
}
