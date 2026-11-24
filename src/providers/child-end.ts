/**
 * End a child process and wait until it is gone: the signal asked for, then SIGKILL when it is
 * still there after `graceMs` (a wrapper that traps TERM, a process that ignores it), then a last
 * short wait. Resolves true once the child exited, false when even SIGKILL did not show an exit in
 * time (a process stuck in the kernel). Imports nothing: the daemon and the ACP worker bundle it.
 */
import type { ChildProcess } from 'node:child_process'

/** The child already ended (an exit code, or the signal that ended it: exitCode stays null then). */
export function childGone(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

const KILL_WAIT_MS = 3_000

export async function endChild(child: ChildProcess, opts: { signal?: NodeJS.Signals; graceMs?: number } = {}): Promise<boolean> {
  if (childGone(child)) return true
  const exited = new Promise<true>((resolve) => child.once('exit', () => resolve(true)))
  const within = async (ms: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const r = await Promise.race([exited, new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms) })])
    if (timer) clearTimeout(timer)
    return r
  }
  try { child.kill(opts.signal ?? 'SIGTERM') } catch { /* gone already */ }
  if (await within(opts.graceMs ?? KILL_WAIT_MS)) return true
  try { child.kill('SIGKILL') } catch { /* gone already */ }
  return within(KILL_WAIT_MS)
}
