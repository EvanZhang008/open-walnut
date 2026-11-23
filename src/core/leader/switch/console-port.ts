/**
 * Before a switch starts a server on a machine's port: that machine's console replica
 * (replica/console-door.ts) may still hold it. A switch back moves the handed-over home aside at
 * the promotion, and the replica closes its console door within about a second of seeing that;
 * this waits for it, bounded, so the trial start does not meet a taken port.
 *
 * One function, so a remote side (a later phase) asks the same thing of the other machine.
 */
import { consolesOfHome, readHolder } from '../../handed-over-console.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The live console replica holding `port` for a console of `home`, or null. */
export function consoleHolding(home: string, port: number): { pid: number; walnutId: string } | null {
  for (const c of consolesOfHome(home)) {
    const h = readHolder(c.walnutId)
    if (h && h.port === port) return { pid: h.pid, walnutId: c.walnutId }
  }
  return null
}

export async function waitForConsolePort(home: string, port: number, timeoutMs = 30_000): Promise<{ ok: true } | { ok: false; why: string }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const held = consoleHolding(home, port)
    if (!held) return { ok: true }
    if (Date.now() > deadline) {
      return { ok: false, why: `this machine's console replica (pid ${held.pid}) still holds port ${port} after ${Math.round(timeoutMs / 1000)} s` }
    }
    await sleep(250)
  }
}
