/**
 * A Walnut server's session side in a bun process of its own (tests/providers/fixtures/
 * walnut-session-side.ts): its start on an env the test made, one call per command, its stop.
 * Used by tests/providers/one-service-shared-host-e2e.test.ts and in-process-daemon-takeover-e2e.test.ts.
 * MACHINE SAFETY: the process ends when its stdin closes or on `exit`; nothing is signalled.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'

const FIXTURE = path.resolve(__dirname, '../providers/fixtures/walnut-session-side.ts')

export interface SessionSide {
  pid: number
  child: ChildProcess
  call(cmd: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  output(): string
  stop(): Promise<void>
}

export function startSessionSide(env: NodeJS.ProcessEnv, root: string, track: ChildProcess[] = []): Promise<SessionSide> {
  const child = spawn(process.execPath, [FIXTURE, root], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  track.push(child)
  let out = ''
  let err = ''
  const waiting = new Map<number, (v: Record<string, unknown>) => void>()
  let next = 1
  let buf = ''
  child.stderr!.on('data', (c) => { err = (err + c).slice(-20_000) })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the session side did not start: ${err.slice(-2000)}`)), 60_000)
    child.stdout!.on('data', (c) => {
      out = (out + c).slice(-20_000)
      buf += c
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.startsWith('OUT ')) continue
        const v = JSON.parse(line.slice(4)) as Record<string, unknown>
        if (v.ready) { clearTimeout(timer); resolve(side(Number(v.pid))); continue }
        const done = typeof v.id === 'number' ? waiting.get(v.id) : undefined
        if (done) { waiting.delete(v.id as number); done(v) }
      }
    })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the session side exited ${code}: ${err.slice(-2000)}`)) })
  })

  function side(pid: number): SessionSide {
    return {
      pid, child,
      call: (cmd, timeoutMs = 60_000) => new Promise((resolve, reject) => {
        const id = next++
        const t = setTimeout(() => { waiting.delete(id); reject(new Error(`no answer to ${String(cmd.op)} in ${timeoutMs} ms\n${err.slice(-3000)}`)) }, timeoutMs)
        waiting.set(id, (v) => { clearTimeout(t); resolve(v) })
        child.stdin!.write(JSON.stringify({ id, ...cmd }) + '\n')
      }),
      output: () => `${out}\n--- stderr ---\n${err}`,
      stop: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return
        const gone = new Promise((r) => child.once('exit', r))
        try { child.stdin!.end() } catch { /* closed */ }
        await gone
      },
    }
  }
}
