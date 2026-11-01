/**
 * Host rows that belong to the host network (`transport: net`, core/net/net-mac.ts)
 * are written by the network, never by the Remote Hosts editor: a hosts map the
 * editor sends keeps every such row as it is (its transport and endpoint included),
 * and an older editor, which knows neither field, cannot turn one into an SSH host.
 */
type HostRow = Record<string, unknown>

/** The editor sent an SSH host under the name of a machine on the host network. */
export class NetHostAliasTaken extends Error {
  constructor(public alias: string) {
    super(`"${alias}" is a machine that joined with a link; give the SSH host another name.`)
    this.name = 'NetHostAliasTaken'
  }
}

export function keepNetHosts(sent: Record<string, HostRow | undefined>, current: Record<string, unknown>): Record<string, HostRow | undefined> {
  const out: Record<string, HostRow | undefined> = { ...sent }
  for (const [key, row] of Object.entries(current)) {
    const h = row as HostRow | undefined
    if (!h || h.transport !== 'net') continue
    const s = out[key]
    // An editor that knows the row (an older one sends it back as it read it) sends its
    // hostname unchanged; another hostname is a new SSH host under a taken name.
    if (s && s.transport !== 'net' && typeof s.hostname === 'string' && s.hostname !== h.hostname) throw new NetHostAliasTaken(key)
    // The editor may still switch a machine on or off and give it a label.
    out[key] = {
      ...h,
      ...(s && typeof s.enabled === 'boolean' ? { enabled: s.enabled } : {}),
      ...(s && typeof s.label === 'string' ? { label: s.label } : {}),
    }
  }
  // A row the editor sent as `net` that is not one already is not the editor's to make.
  for (const [key, s] of Object.entries(out)) {
    if (s && s.transport === 'net' && (current[key] as HostRow | undefined)?.transport !== 'net') {
      const { transport: _t, endpoint: _e, ...rest } = s
      out[key] = rest
    }
  }
  return out
}
