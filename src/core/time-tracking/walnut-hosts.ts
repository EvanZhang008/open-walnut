/**
 * The names this Mac's Walnut was opened under in a browser, read from the
 * requests themselves: every heartbeat batch arrives on the hostname the page
 * was loaded from (a LAN name, a tailnet name, an IP). The foreground sampler
 * reports a browser's site by hostname, so without this list a tab on such a
 * name would read as "another app" and the report would cut its lease time.
 *
 * Kept on this Mac only: WALNUT_HOME/time-tracking/outside/walnut-hosts.json
 * (outside/ is not synced). The config-derived names (walnutHostsFromConfig)
 * stay the base; this adds to them.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { walnutHostsFromConfig } from './outside-view.js'
import type { Config } from '../types.js'

const MAX_HOSTS = 32
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function hostsFile(): string {
  return path.join(WALNUT_HOME, 'time-tracking', 'outside', 'walnut-hosts.json')
}

/** Newest last; loaded once, then kept in memory. */
let hosts: string[] | null = null
let loading: Promise<string[]> | null = null
let writing: Promise<void> = Promise.resolve()

async function load(): Promise<string[]> {
  if (hosts) return hosts
  loading ??= (async () => {
    try {
      const raw = JSON.parse(await fsp.readFile(hostsFile(), 'utf8')) as { hosts?: unknown }
      hosts = Array.isArray(raw.hosts) ? raw.hosts.filter((h): h is string => typeof h === 'string' && HOST_RE.test(h)).slice(-MAX_HOSTS) : []
    } catch {
      hosts = []
    }
    return hosts
  })()
  return loading
}

/** A hostname a heartbeat came in on, cleaned; null for loopback or junk. */
export function cleanHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const h = raw.trim().toLowerCase().replace(/\.$/, '')
  if (!h || h.length > 253 || LOOPBACK.has(h) || !HOST_RE.test(h)) return null
  return h
}

/** Remember a hostname the browser reached Walnut on. Cheap when already known; never throws. */
export async function noteWalnutHost(raw: unknown): Promise<void> {
  const h = cleanHost(raw)
  if (!h) return
  const list = await load()
  if (list.includes(h)) return
  list.push(h)
  if (list.length > MAX_HOSTS) list.splice(0, list.length - MAX_HOSTS)
  const body = JSON.stringify({ hosts: list }, null, 2)
  writing = writing.then(async () => {
    const file = hostsFile()
    const tmp = `${file}.${process.pid}.tmp`
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(tmp, body)
    await fsp.rename(tmp, file)
  }).catch(() => { /* best effort, like the rest of telemetry */ })
  await writing
}

/** Every hostname that is Walnut's own page: the config's names plus the ones heartbeats came in on. */
export async function walnutHostsFor(config: Pick<Config, 'cloud_bridge'> | undefined): Promise<string[]> {
  return [...new Set([...walnutHostsFromConfig(config), ...await load().catch(() => [])])]
}

/** Tests: forget what was loaded. */
export function resetWalnutHosts(): void {
  hosts = null
  loading = null
  writing = Promise.resolve()
}
