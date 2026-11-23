/**
 * What the old leader's server does before it writes its handover record (POST
 * /api/leader/handover, web/routes/leader-switch.ts), each a step that must land in auth.json or
 * beside the home before the switch's final batch reads them. One fails, the handover is refused
 * with its reason and nothing was handed over (the switch rolls back and this server leads on).
 *
 *   console   this machine's console on the new leader (console-credential.ts)
 */
import { prepareConsoleForHandover } from './console-credential.js'

export interface BeforeHandoverInput {
  to: string
  machine: string
  home: string
  address: { port: number; host: string } | null
}

export async function beforeHandover(o: BeforeHandoverInput): Promise<{ ok: true } | { ok: false; why: string }> {
  if (!o.address) return { ok: false, why: 'this server does not know the address it listens on' }
  const consoleStep = await prepareConsoleForHandover({ to: o.to, machine: o.machine, home: o.home, address: o.address }).catch((err: unknown) => ({ ok: false as const, why: err instanceof Error ? err.message : String(err) }))
  if (!consoleStep.ok) return { ok: false, why: `this machine's console was not prepared: ${consoleStep.why}` }
  return { ok: true }
}
