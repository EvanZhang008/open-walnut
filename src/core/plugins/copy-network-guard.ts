/**
 * On a copy of the person's data (closeAccountDoors, core/leader/switch/doors.ts), a plugin's own
 * network code never writes to his accounts either. A plugin that is not built in (the plugin
 * store's, his own under ~/.open-walnut/plugins) runs in this process with the copy's live secrets,
 * and may call the global `fetch` or `node:http(s)` itself instead of `walnut.http.fetch`, so the
 * plugin-fetch door never sees it (2026-11-27: the notes importer reads Notion with its own fetch).
 *
 * `guardPluginNetworkOnCopy` wraps those three once, for the life of the process, and only on a
 * copy. A request whose method may write (anything but GET, HEAD and OPTIONS) to a host that is not
 * this machine is refused when a plugin's own code (a directory `notePluginCodeDir` recorded as the
 * loader loaded it, its node_modules included) is on the caller's stack, before anything leaves.
 * Walnut's own requests carry no such frame, except one made for a plugin: a model call is let
 * through by its host, and `walnut.http.fetch` is refused alike by its own door.
 * A read that a service takes as a POST (a search) is refused too: a copy fails closed.
 *
 * Not covered: a request whose plugin frames the engine dropped (a plugin function that is not
 * async and calls fetch in a tail call, straight from Walnut's call into it; async plugin code keeps
 * its frame), a child process a plugin starts itself (its own MCP server through `walnut.mcp` is
 * covered by the mcp-write door), and a named import of `request` from `node:https` taken before
 * the guard was installed.
 */
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { accountDoorsGuarded, outwardDoorRefusal } from '../leader/switch/doors.js'

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const pluginDirs = new Set<string>()
let installed = false

/** The loader, for every plugin that is not built in: where its code lives (and its real path). */
export function notePluginCodeDir(dir: string): void {
  const add = (p: string) => { if (p) pluginDirs.add(p.endsWith(path.sep) ? p : p + path.sep) }
  add(path.resolve(dir))
  try { add(fs.realpathSync(dir)) } catch { /* a dir that is gone has no frames */ }
}

const THIS_FILE = /copy-network-guard\.(?:ts|js|mjs)/

/**
 * The plugin directory of any frame on `stack` outside this file, or null. Any frame, not only the
 * direct caller: the engine drops the frame of a tail call (`return fetch(url)` in strict code), so
 * the direct caller is often gone. Walnut's own requests made for a plugin (a model call) are let
 * through by their host instead (WALNUT_OWN_HOSTS).
 */
export function pluginFrameIn(stack: string | undefined): string | null {
  if (!stack || pluginDirs.size === 0) return null
  for (const frame of stack.split('\n').slice(1)) {
    if (!/^\s*at\s/.test(frame) || THIS_FILE.test(frame)) continue
    for (const dir of pluginDirs) {
      if (frame.includes(dir)) return dir
    }
  }
  return null
}

/** Hosts Walnut's own model calls reach (src/model), which a plugin may ask for through walnut.model. */
const WALNUT_OWN_HOSTS = ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com', 'openrouter.ai']

function walnutOwnHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return WALNUT_OWN_HOSTS.includes(h) || /^bedrock[a-z-]*\.[a-z0-9-]+\.amazonaws\.com$/.test(h)
}

/** This machine, its loopback or a private network: never one of the person's accounts. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h)
    || h === 'host.docker.internal' || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
}

/**
 * The plugin-fetch door for a plugin's own request: the refusal's sentence, or null when it may go.
 * Asked only for a method that may write, to a host that is not local, from a plugin's own code.
 */
export function pluginNetworkRefusal(method: string, url: URL | null, stack: string | undefined): string | null {
  if (READ_METHODS.has(method.toUpperCase())) return null
  if (url && (isLocalHost(url.hostname) || walnutOwnHost(url.hostname))) return null
  if (!pluginFrameIn(stack)) return null
  // The op id names no URL path: a query string may carry a secret.
  return accountDoorsGuarded() ? outwardDoorRefusal('plugin-fetch', `own:${method.toUpperCase()}:${url?.hostname ?? '?'}`) : null
}

function urlOf(input: unknown): URL | null {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    if (input && typeof input === 'object' && 'url' in input) return new URL(String((input as { url: unknown }).url))
  } catch { /* not a URL: judged by its caller frames alone */ }
  return null
}

function requestTarget(args: unknown[]): { method: string; url: URL | null } {
  let method = 'GET'
  let url: URL | null = null
  for (const a of args) {
    if (typeof a === 'string' || a instanceof URL) url = urlOf(a)
    else if (a && typeof a === 'object' && typeof a !== 'function') {
      const o = a as { method?: unknown; hostname?: unknown; host?: unknown; protocol?: unknown }
      if (typeof o.method === 'string') method = o.method
      const host = typeof o.hostname === 'string' ? o.hostname : typeof o.host === 'string' ? o.host.split(':')[0] : null
      if (host && !url) url = urlOf(`${typeof o.protocol === 'string' ? o.protocol : 'https:'}//${host}`)
    }
  }
  return { method, url }
}

/**
 * Wraps the global fetch and node:http(s) request/get once, on a copy only (web/server.ts calls it
 * after closeAccountDoors closed the account doors). A refused fetch rejects with the door's
 * sentence; a refused http request throws it synchronously, as a bad argument does.
 */
export function guardPluginNetworkOnCopy(): void {
  if (installed) return
  installed = true
  const realFetch = globalThis.fetch
  globalThis.fetch = Object.assign(async function guardedFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    const method = init?.method ?? (input && typeof input === 'object' && 'method' in input ? String((input as Request).method) : 'GET')
    const refused = pluginNetworkRefusal(method, urlOf(input), new Error().stack)
    if (refused) throw new Error(refused)
    return realFetch(input, init)
  }, realFetch) as typeof fetch
  for (const mod of [http, https] as const) {
    for (const name of ['request', 'get'] as const) {
      const real = mod[name] as (...a: unknown[]) => http.ClientRequest
      ;(mod as unknown as Record<string, unknown>)[name] = function guardedRequest(...args: unknown[]) {
        const { method, url } = requestTarget(args)
        const refused = pluginNetworkRefusal(name === 'get' ? 'GET' : method, url, new Error().stack)
        if (refused) throw new Error(refused)
        return real.apply(mod, args)
      }
    }
  }
}

/** Tests only: forget the recorded plugin directories. */
export function _forgetPluginCodeDirsForTesting(): void {
  pluginDirs.clear()
}
