/**
 * A server started on a home a switch is making into the new leader's, by anyone but the switch
 * (the Mac app, a launcher that restarts what it sees stop, a person): it waits, and never leads
 * (docs/reference/leader-switch.md, "A launcher during a switch").
 *
 * Why it does not refuse and exit: a launcher would restart it at once, and again, each start
 * fighting the switch for the port its trial and commit starts need. Why it does not lead: the home
 * is half made, or the switch's own server leads on it. So it holds nothing: no port, no lock, no
 * file in or beside the home; it only looks every second, and ends (`walnut web` exits) once the
 * switch settled and no server of the switch holds the home. Its launcher then starts a fresh one,
 * which boots by the usual rules: it leads (its own machine's record or release), or it is the
 * standby of a home a rolled-back switch left handed over.
 *
 * A home waits while either holds:
 *   - the switch's claim on it (ticket.ts switchClaimFile), written by the target job before its
 *     promotion and removed once it is done or rolled back. Alive or not: a claim whose job died
 *     still holds, since the home may be half swapped until `--resume`;
 *   - promoted.json not yet `led` (a promotion not committed).
 * A start the switch makes itself (side.ts sets WALNUT_LEADER_SWITCH_START to its switch) does not.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { readPromoted } from './records.js'
import { readSwitchClaim } from './ticket.js'
import type { StandbyListener } from './handed-over.js'

export interface PromotionWait { home: string; switchId: string; why: string }

/** Whether a server started on `home` waits (and why), or null when it boots as usual. */
export function promotionWaitAtBoot(o: { home: string; env?: NodeJS.ProcessEnv }): PromotionWait | null {
  const env = o.env ?? process.env
  const own = env.WALNUT_LEADER_SWITCH_START
  const claim = readSwitchClaim(o.home, env)
  if (claim && claim.switchId !== own) return { home: o.home, switchId: claim.switchId, why: `leader switch ${claim.switchId} is making this home the new leader's` }
  const p = readPromoted(o.home)
  if (p && p.state !== 'led' && p.switchId !== own) {
    return { home: o.home, switchId: p.switchId ?? '?', why: `this home is the standby copy that switch ${p.switchId ?? '?'} is making into the new leader's home (${p.torn ? 'its record cannot be read' : p.state ?? 'promoted'}); \`walnut leader switch --resume\` finishes it` }
  }
  return null
}

function serverHolds(home: string): boolean {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(home, 'server.lock.json'), 'utf8')) as { pid?: number }
    if (typeof lock.pid !== 'number' || lock.pid <= 1) return false
    try { process.kill(lock.pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
  } catch { return false }
}

/** The settled test: no claim, no promotion under way, and no server of the switch on the home. */
export function promotionSettled(home: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (readSwitchClaim(home, env)) return false
  const p = readPromoted(home)
  if (p && p.state !== 'led') return false
  return !serverHolds(home)
}

/** The wait: no listener (a server object that never listens, for its caller's shape), ends when the switch settled. */
export function waitForPromotion(w: PromotionWait, o: { env?: NodeJS.ProcessEnv; lookMs?: number } = {}): StandbyListener {
  const env = o.env ?? process.env
  let endWith: (line: string) => void = () => {}
  const ended = new Promise<string>((resolve) => { endWith = resolve })
  let closed = false
  const look = setInterval(() => {
    if (closed || !promotionSettled(w.home, env)) return
    closed = true
    clearInterval(look)
    endWith(`Walnut: switch ${w.switchId} settled on ${w.home}; this waiting process ends, so the next start boots by the usual rules`)
  }, o.lookMs ?? 1_000)
  return {
    server: http.createServer(),
    line: `Walnut waits: ${w.why}. It takes no port and opens nothing until the switch settles`,
    ended,
    close: async () => { closed = true; clearInterval(look) },
  }
}
