/**
 * Refuse every connection a test process makes to the production Walnut.
 *
 * Loaded inside every vitest worker before any test module: imported by
 * runtime-dir-isolation.ts (the first setup file of every config built on
 * vitest.config.ts) and listed directly in the standalone configs.
 *
 * What it protects (2026-09-29 incident)
 * --------------------------------------
 * The op clients (src/ops/executor.ts, src/utils/api-client.ts, the MCP server)
 * pick their target as: explicit apiBase, else the server listening in this
 * process, else OPEN_WALNUT_API_URL, else http://127.0.0.1:3456. A test that
 * runs an op with no apiBase before its own server listens therefore talks to
 * the user's real Walnut: from a terminal through the :3456 default, and from a
 * Walnut session through the OPEN_WALNUT_API_URL that session exports, which
 * is the same :3456. tests/mcp/ops-registry.test.ts did this on every run since
 * 2026-08-21: four PATCH /api/v1/tasks/x (one per phase) reached the production
 * server. They answered 404 only because no task "x" exists; the same call with
 * a real id would have changed a task on the user's board. The test passed
 * either way, because the executor turns a transport error into `{ ok: false }`
 * and the test accepted that.
 *
 * How
 * ---
 * Every in-process TCP or unix-socket client (fetch/undici, http, https, ws,
 * net) ends in net.Socket.prototype.connect, so that one method is wrapped. A
 * connect to port 3456 on this machine (loopback, a local interface address or
 * the host name), or to a unix socket in the production runtime dir (where the
 * live daemon's agent gateway listens), never opens: the socket fails the way a
 * refused connection does, the attempt is printed with its stack, and the test
 * FAILS in afterEach even when the code under test swallowed the error.
 *
 * Model APIs get the same refusal (modelApiReason): a socket to Anthropic, Bedrock,
 * Vertex or OpenAI from a test means a mock was missed, and the call would spend
 * the user's money with their credentials (CI has none, so there it only fails
 * later and differently). Every test runs on mocks; the live tier, which calls
 * real models on purpose, sets WALNUT_TEST_REAL_CLAUDE=1. The CLI half of the
 * same rule is src/core/test-claude-guard.ts.
 *
 * Not covered: child processes. A CLI or server a test spawns resolves its own
 * target, so give it an explicit OPEN_WALNUT_API_URL (the spawning tests do).
 * A child that reaches for the real claude or ssh is the exec guard's
 * (tests/setup/exec-guard.ts).
 */
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, expect } from 'vitest'

/** The production server's port (scripts/dev-prod.sh). */
export const PROD_SERVER_PORT = 3456

/** Captured before any test can install fake timers over the global. */
const realSetImmediate = setImmediate

/** The production runtime dir, both spellings (macOS /tmp is /private/tmp). */
const PROD_RUNTIME_DIRS = ['/tmp/open-walnut', '/private/tmp/open-walnut'] // safe: comparison only

export interface ConnectTarget { host?: string; port?: number; path?: string }

interface GuardState {
  installed: boolean
  /** Ports refused on this machine: 3456, plus a scratch port a guard test adds. */
  ports: Set<number>
  /** Refused attempts not yet reported by a hook. */
  violations: string[]
}

// One state per worker, kept on globalThis so a re-evaluated module cannot wrap
// connect twice or lose attempts recorded before it ran.
const STATE_KEY = Symbol.for('open-walnut.test.prod-server-guard')
const holder = globalThis as unknown as Record<symbol, GuardState | undefined>
export const guardState: GuardState = holder[STATE_KEY] ??= {
  installed: false,
  ports: new Set([PROD_SERVER_PORT]),
  violations: [],
}

/**
 * The target of a Socket#connect call. net.connect() and createConnection()
 * pass a pre-normalized `[options, callback]` array; a direct call passes
 * `(options)`, `(port, host?)` or `(path)`.
 */
export function connectTarget(args: readonly unknown[]): ConnectTarget {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0]
  if (first && typeof first === 'object') {
    const o = first as { host?: unknown; port?: unknown; path?: unknown }
    if (typeof o.path === 'string' && o.path) return { path: o.path }
    const port = o.port === undefined || o.port === null || o.port === '' ? NaN : Number(o.port)
    return {
      host: typeof o.host === 'string' ? o.host : undefined,
      port: Number.isInteger(port) ? port : undefined,
    }
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return { port: Number(first), host: typeof args[1] === 'string' ? args[1] : undefined }
  }
  if (typeof first === 'string' && first) return { path: first }
  return {}
}

/** True when `host` names this machine. No host means localhost (net's default). */
export function isThisMachine(host: string | undefined): boolean {
  if (!host) return true
  let h = host.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '')
  if (h.startsWith('::ffff:')) h = h.slice('::ffff:'.length)
  if (h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h)) return true
  if (h === '::1' || h === '0:0:0:0:0:0:0:1' || h === '0.0.0.0' || h === '::') return true
  if (h === os.hostname().toLowerCase()) return true
  // A server bound to 0.0.0.0 also answers on every LAN address of this machine.
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.address.toLowerCase() === h) return true
  }
  return false
}

/** Why connecting to `target` would reach the production Walnut, or null. */
export function productionTargetReason(
  target: ConnectTarget,
  ports: ReadonlySet<number> = guardState.ports,
): string | null {
  if (target.path) {
    const resolved = path.resolve(target.path)
    const inside = PROD_RUNTIME_DIRS.some((dir) => resolved === dir || resolved.startsWith(dir + path.sep))
    return inside ? `the unix socket ${target.path} in the production runtime dir` : null
  }
  if (target.port === undefined || !ports.has(target.port)) return null
  if (!isThisMachine(target.host)) return null
  return `${target.host || 'localhost'}:${target.port}, the production Walnut server`
}

/** Model API hosts (a trailing-dot-free, lower-case host name). */
const MODEL_API_HOSTS: readonly RegExp[] = [
  /(^|\.)anthropic\.com$/,
  /^bedrock(-runtime|-agent-runtime)?(-fips)?\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/,
  /(^|[.-])aiplatform\.googleapis\.com$/, // Vertex: <region>-aiplatform.googleapis.com
  /^api\.openai\.com$/,
]

/** Why connecting to `target` would call a real model API, or null. */
export function modelApiReason(target: ConnectTarget, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.WALNUT_TEST_REAL_CLAUDE === '1' || !target.host) return null
  const host = target.host.toLowerCase().replace(/\.$/, '')
  return MODEL_API_HOSTS.some((re) => re.test(host)) ? `${host}, a model API` : null
}

/** The running test, for the refusal message (a fetch stack never names it). */
function currentTest(): string {
  try {
    const { testPath, currentTestName } = expect.getState()
    return [testPath && path.relative(process.cwd(), testPath), currentTestName].filter(Boolean).join(' > ')
  } catch {
    return ''
  }
}

/** Wrap Socket#connect once per worker. */
export function installProdServerGuard(): void {
  if (guardState.installed) return
  guardState.installed = true
  const original = net.Socket.prototype.connect as (this: net.Socket, ...args: unknown[]) => net.Socket
  const guarded = function (this: net.Socket, ...args: unknown[]): net.Socket {
    const target = connectTarget(args)
    const walnut = productionTargetReason(target)
    const reason = walnut ?? modelApiReason(target)
    if (!reason) return original.apply(this, args)
    const test = currentTest()
    const message =
      `[prod-server-guard] A test${test ? ` (${test})` : ''} tried to connect to ${reason}. ` +
      (walnut
        ? 'Refused: tests must never reach the user\'s real Walnut. Pass an explicit apiBase ' +
          '(or OPEN_WALNUT_API_URL) for a server the test started itself (startServer({ port: 0 })) ' +
          'or for a local stub.'
        : 'Refused: tests run on mocks, never a real model. Mock sendMessage or the provider ' +
          'client this code path uses.')
    const where = new Error('connect attempted here').stack ?? ''
    guardState.violations.push(`${message}\n${where}`)
    // eslint-disable-next-line no-console
    console.error(`${message}\n${where}`)
    const err = Object.assign(new Error(message), { code: 'ERR_TEST_PROD_SERVER' })
    // Fail like a refused connection. Marked as connecting, so a write made
    // meanwhile (http sends the request at once) waits instead of failing first
    // with ERR_SOCKET_CLOSED; then destroyed asynchronously, once the caller has
    // attached its 'error' listener. The real setImmediate, so a test running
    // fake timers still gets the error instead of a hang.
    ;(this as { connecting: boolean }).connecting = true
    realSetImmediate(() => this.destroy(err))
    return this
  }
  net.Socket.prototype.connect = guarded as typeof net.Socket.prototype.connect
}

/** Throw once for every refused attempt not yet reported. */
export function failOnViolations(when: string): void {
  if (guardState.violations.length === 0) return
  const found = guardState.violations.splice(0)
  throw new Error(
    `${found.length} connection attempt(s) to the production Walnut or a model API were refused ${when}:\n\n${found.join('\n\n')}`,
  )
}

installProdServerGuard()
beforeAll(() => failOnViolations('before this file started (left over from an earlier file in this worker)'))
afterEach(() => failOnViolations('during this test'))
afterAll(() => failOnViolations('in this file\'s hooks'))
