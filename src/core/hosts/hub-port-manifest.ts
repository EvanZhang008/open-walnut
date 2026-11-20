/**
 * The `hubPorts` block of a plugin manifest: the ports of this Walnut's own loopback the plugin
 * may open to a host's hub forward (docs/reference/host-network.md, "Reaching a port on the
 * primary"), each with why, shown to the person:
 *
 *   "hubPorts": [{ "port": 18403, "why": "Model requests of your other machines reach coderelay here" }]
 *
 * Declaring a port grants nothing by itself: the plugin then allows one host at a time with
 * `walnut.hosts.allowHubPort(alias, port)` (core/hosts/hub-port-grants.ts), and only a port named
 * here may be allowed.
 *
 * Parsed leniently, like the storage and jobs blocks: a bad entry costs that entry (with a reason
 * the loader logs), never the plugin's load. One rule set for both ends: the host's loader and
 * `walnut-plugin validate` (packages/plugin-cli/src/manifest.ts imports this file, and its build
 * carries it) drop the same entries for the same reasons. So it imports nothing.
 */

export interface HubPortDeclaration {
  port: number
  why: string
}

export const MAX_HUB_PORT_DECLARATIONS = 8
export const MAX_HUB_PORT_WHY = 200

export function parseManifestHubPorts(raw: unknown): { hubPorts?: HubPortDeclaration[]; dropped: string[] } {
  const dropped: string[] = []
  if (raw === undefined || raw === null) return { dropped }
  if (!Array.isArray(raw)) return { dropped: ['hubPorts must be a list like [{ "port": 18403, "why": "..." }]'] }
  const out: HubPortDeclaration[] = []
  raw.forEach((entry, i) => {
    const e = (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}) as { port?: unknown; why?: unknown }
    const port = e.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      dropped.push(`hubPorts[${i}]: port must be a TCP port (1 to 65535)`)
      return
    }
    const why = typeof e.why === 'string' ? e.why.replace(/\s+/g, ' ').trim() : ''
    if (!why) { dropped.push(`hubPorts[${i}]: why must say what the port is for (the person reads it)`); return }
    if (why.length > MAX_HUB_PORT_WHY) { dropped.push(`hubPorts[${i}]: why is longer than ${MAX_HUB_PORT_WHY} characters`); return }
    if (out.some((d) => d.port === port)) { dropped.push(`hubPorts[${i}]: port ${port} is declared twice`); return }
    if (out.length >= MAX_HUB_PORT_DECLARATIONS) { dropped.push(`hubPorts[${i}]: at most ${MAX_HUB_PORT_DECLARATIONS} ports`); return }
    out.push({ port, why })
  })
  return out.length > 0 ? { hubPorts: out, dropped } : { dropped }
}
