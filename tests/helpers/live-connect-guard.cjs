/**
 * Preloaded into every node and bun process a live e2e test starts (NODE_OPTIONS=--require for
 * node, BUN_OPTIONS=--preload for bun, which reads no NODE_OPTIONS; tests/helpers/live-isolation.ts).
 *
 * Refuses a connect to a loopback port in WALNUT_TEST_DENY_PORTS (the user's real Walnut, its
 * daemon and instance lock, a local model proxy, every service that was listening before the test
 * began: livePorts in tests/helpers/live-isolation.ts) and appends each attempt to
 * WALNUT_TEST_CONNECT_GUARD_LOG, which fails the test. On macOS the walls refuse the same ports in the
 * kernel; this is the line that names who tried, and the only one where no walls stand. It covers node:net (http, ws, undici's fetch and
 * WebSocket all connect through it) and, for bun, the global fetch, WebSocket and Bun.connect.
 */
'use strict'
const net = require('node:net')
const fs = require('node:fs')

// Fails closed: a process that got the guard but not its ports (an environment that did not reach it,
// as Bun's does not when it starts in a dir it may not list) must not run unguarded.
if (process.env.WALNUT_TEST_DENY_PORTS === undefined) {
  throw new Error('live test guard: WALNUT_TEST_DENY_PORTS is not set, so this process cannot be held off the real Walnut')
}
const deny = new Set(String(process.env.WALNUT_TEST_DENY_PORTS || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))
const LOG = process.env.WALNUT_TEST_CONNECT_GUARD_LOG || ''
const LOOPBACK = /^(localhost\.?|127\.\d+\.\d+\.\d+|::1|\[::1\]|0\.0\.0\.0|::|\[::\]|::ffff:127\.\d+\.\d+\.\d+)$/i

function refused(host, port) {
  if (!deny.has(Number(port)) || !LOOPBACK.test(String(host ?? 'localhost'))) return null
  const line = `${new Date().toISOString()}\t${process.pid}\t${host ?? 'localhost'}:${port}\t${process.argv.slice(1, 3).join(' ')}\n`
  try { if (LOG) fs.appendFileSync(LOG, line) } catch { /* the error below still refuses it */ }
  return Object.assign(new Error(`live test guard: refused a connect to ${host ?? 'localhost'}:${port} (the user's real Walnut or a model proxy)`), { code: 'ECONNREFUSED' })
}

function urlRefused(input) {
  let u
  try { u = new URL(typeof input === 'string' ? input : (input && (input.url || input.href)) || String(input)) } catch { return null }
  const port = u.port || ({ 'http:': 80, 'ws:': 80, 'https:': 443, 'wss:': 443 })[u.protocol]
  return port ? refused(u.hostname, port) : null
}

if (deny.size > 0) {
  const connect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function guardedConnect(...args) {
    // net.connect hands over its normalized [options, callback]; a direct call passes (options) or (port, host).
    const first = Array.isArray(args[0]) ? args[0][0] : args[0]
    let port
    let host
    if (first && typeof first === 'object') {
      if (first.path) return connect.apply(this, args)
      port = first.port
      host = first.host
    } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
      port = first
      host = typeof args[1] === 'string' ? args[1] : undefined
    } else {
      return connect.apply(this, args) // a unix socket path
    }
    const err = refused(host, port)
    if (!err) return connect.apply(this, args)
    process.nextTick(() => this.destroy(err))
    return this
  }

  if (typeof globalThis.Bun !== 'undefined') {
    const origFetch = globalThis.fetch
    if (typeof origFetch === 'function') {
      globalThis.fetch = function guardedFetch(input, init) {
        const err = urlRefused(input)
        return err ? Promise.reject(err) : origFetch.call(this, input, init)
      }
    }
    const OrigWebSocket = globalThis.WebSocket
    if (typeof OrigWebSocket === 'function') {
      globalThis.WebSocket = new Proxy(OrigWebSocket, {
        construct(target, ctorArgs, newTarget) {
          const err = urlRefused(ctorArgs[0])
          if (err) throw err
          return Reflect.construct(target, ctorArgs, newTarget)
        },
      })
    }
    const origConnect = globalThis.Bun.connect
    if (typeof origConnect === 'function') {
      globalThis.Bun.connect = function guardedBunConnect(opts, ...rest) {
        const err = opts && !opts.unix ? refused(opts.hostname, opts.port) : null
        return err ? Promise.reject(err) : origConnect.call(this, opts, ...rest)
      }
    }
  }
}
