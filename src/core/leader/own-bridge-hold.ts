/**
 * The old leader's own daemon keeps its bridge off for the rest of this process (the leader switch,
 * core/leader/switch/host-follow.ts dropOwnDaemonDuties): the companion takes one `__local__`
 * bridge, and the new leader's daemon holds it once it configured itself with the bridge-local
 * token. The server's periodic bridge push to its own daemon (DaemonConnection.pushBridgeConfig)
 * would turn it on again before the stop, so it sends nothing while this holds. A new process starts
 * with it off: a rollback's restart pushes the bridge as every boot does. No imports.
 */
let held = false

export function holdOwnBridge(on: boolean): void {
  held = on
}

export function ownBridgeHeld(): boolean {
  return held
}
