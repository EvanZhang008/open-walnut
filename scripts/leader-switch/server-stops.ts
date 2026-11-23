/**
 * How a rehearsal's server process stops, as `walnut web` does (src/commands/web.ts): a signal is the
 * ordinary planned stop; a leader switch's stop is asked through the API (server.ts onSwitchStopRequest)
 * and may run its final batch past the usual bail; a signal during it aborts the batch (no final mark)
 * and the process ends within SWITCH_ABORT_BAIL_MS. Shared by rehearsal-server.ts and machine-server.ts.
 */
export async function wireServerStops(o: { bailMs: number }): Promise<{ stop: () => Promise<void> }> {
  const [{ stopServer, onSwitchStopRequest }, { SWITCH_ABORT_BAIL_MS }] = await Promise.all([import('../../src/web/server.js'), import('../../src/commands/web.js')])
  let stopping = false
  let switchStop: import('../../src/web/server.js').SwitchStop | null = null
  let bail: ReturnType<typeof setTimeout> | null = null
  const armBail = (ms: number) => { if (bail) clearTimeout(bail); bail = setTimeout(() => process.exit(1), ms) }
  const stop = async (forSwitch?: import('../../src/web/server.js').SwitchStop) => {
    if (stopping) {
      if (switchStop && !forSwitch) { switchStop.abort('stopped by a signal'); switchStop = null; armBail(SWITCH_ABORT_BAIL_MS) }
      return
    }
    stopping = true
    switchStop = forSwitch ?? null
    armBail(o.bailMs + (forSwitch?.windowMs ?? 0))
    try { await stopServer({ reason: forSwitch ? 'leader-switch' : 'SIGTERM' }) } catch { /* exit anyway */ }
    if (bail) clearTimeout(bail)
    process.exit(0)
  }
  onSwitchStopRequest((s) => { if (stopping) return false; void stop(s); return true })
  process.on('SIGTERM', () => { void stop() })
  process.on('SIGINT', () => { void stop() })
  return { stop: () => stop() }
}
