#!/usr/bin/env node
/**
 * Control probe: a second, independent client of the cloud `/bridge`
 * endpoint (Node + the `ws` library, not the daemon's Bun client) that
 * mimics the daemon's traffic, so a drop can be pinned on the path or the
 * cloud side (both links drop together) versus the daemon (only it drops).
 *
 *   hello {ev:'hello', hostAlias:'probe'} on open, like the daemon
 *   watchdog    the daemon's (BRIDGE_WATCHDOG in lib/classify.mjs): after a
 *               ping interval (15 s) with nothing heard, {ev:'bridge-ping'};
 *               the replica answers with a `ping` RPC, which the probe acks
 *               (that round trip is the RTT sample). When the third ping is
 *               due with still nothing, the link is torn down, 45 to 50 s
 *               after the last inbound frame.
 *   every 30 s  a 64 KB frame; every 15 min a 2 MB burst, placed away from
 *               the replica's 5-minute tick. Each frame carries seq + sha256.
 *   redial      1 s doubling to 60 s with jitter
 *
 * Per connection it logs the daemon's open/close fields to
 * ~/Library/Logs/Walnut/bridge-monitor/probe-YYYY-MM-DD.ndjson.
 *
 * SHIPPED DISABLED. Dialing the real cloud box needs a machine token named
 * `bridge-probe` minted on that box, which is a change to the box the user
 * approves first (see docs/reference/cloud-sync.md, "Bridge monitor").
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { ensureDir, loadConfig } from './lib/config.mjs'
import { Store } from './lib/store.mjs'
import { BRIDGE_WATCHDOG, quantile } from './lib/classify.mjs'

const VERSION = 'bridge-probe/1'

function payload(bytes) {
  const data = crypto.randomBytes(Math.ceil((bytes * 3) / 4)).toString('base64').slice(0, bytes)
  return { data, sha256: crypto.createHash('sha256').update(data).digest('hex') }
}

/** Next wall-clock time (ms) with (t/1000 - phaseSec) a multiple of everyMs/1000. */
export function nextBurstAt(nowMs, everyMs, phaseSec) {
  const period = everyMs / 1000
  const k = Math.ceil((nowMs / 1000 - phaseSec) / period)
  let t = (k * period + phaseSec) * 1000
  if (t <= nowMs) t += everyMs
  return Math.round(t)
}

/**
 * Start the probe loop. Returns { stop(), current() }.
 * @param {object} o  probe settings (see DEFAULTS.probe) plus url, token, log(rec)
 */
export function startProbe(o) {
  const log = o.log ?? (() => {})
  const instanceId = `p-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
  let ws = null
  let conn = null
  let seq = 0
  let connSeq = 0
  let backoff = 1000
  let stopped = false
  let redialTimer = null
  let burstTimer = null
  const drift = []
  let expected = Date.now() + 1000
  const driftTimer = setInterval(() => {
    const now = Date.now()
    drift.push(Math.max(0, now - expected))
    if (drift.length > 60) drift.shift()
    expected = now + 1000
    if (conn && ws) conn.bufferedPeak = Math.max(conn.bufferedPeak, ws.bufferedAmount)
  }, 1000)

  const send = (obj, kind) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const text = JSON.stringify(obj)
    const bytes = Buffer.byteLength(text)
    ws.send(text)
    conn.framesOut++
    conn.bytesOut += bytes
    if (bytes > conn.maxOutFrameBytes) { conn.maxOutFrameBytes = bytes; conn.maxOutFrameKind = kind }
    conn.bufferedPeak = Math.max(conn.bufferedPeak, ws.bufferedAmount)
  }

  const sendPayload = (bytes, kind) => {
    const p = payload(bytes)
    seq++
    send({ ev: 'probe-payload', seq, kind, bytes, sha256: p.sha256, data: p.data }, kind)
    return seq
  }

  const scheduleBurst = () => {
    clearTimeout(burstTimer)
    const at = nextBurstAt(Date.now(), o.burstEveryMs, o.burstPhaseSec ?? 150)
    burstTimer = setTimeout(async () => {
      if (conn && ws?.readyState === WebSocket.OPEN) {
        const started = Date.now()
        const s = sendPayload(o.burstBytes, 'burst')
        const c = conn
        while (ws && ws === c.ws && ws.bufferedAmount > 0 && Date.now() - started < 120_000) {
          await new Promise((r) => setTimeout(r, 50))
        }
        log({ kind: 'probe', ev: 'burst', connId: c.connId, seq: s, bytes: o.burstBytes, drainMs: Date.now() - started })
      }
      if (!stopped) scheduleBurst()
    }, at - Date.now())
  }

  const scheduleRedial = () => {
    if (stopped || redialTimer) return
    const delay = Math.round(Math.min(backoff, o.backoffMaxMs) * (0.75 + Math.random() * 0.5))
    backoff = Math.min(backoff * 2, o.backoffMaxMs)
    redialTimer = setTimeout(() => { redialTimer = null; dial() }, delay)
  }

  function dial() {
    if (stopped) return
    const dialStart = Date.now()
    const url = new URL(o.url)
    if (o.tokenInQuery !== false) url.searchParams.set('token', o.token)
    const headers = o.tokenInQuery === false ? { Authorization: `Bearer ${o.token}` } : {}
    const sock = new WebSocket(url.toString(), { handshakeTimeout: o.dialTimeoutMs, perMessageDeflate: false, headers, maxPayload: 32 * 1024 * 1024 })
    ws = sock
    let opened = false
    let lastError = null
    let silence = false
    let pingTimer = null
    let payloadTimer = null
    let pingSentAt = null

    sock.on('open', () => {
      opened = true
      backoff = 1000
      connSeq++
      conn = {
        ws: sock, connId: `${instanceId}-${connSeq}`, openAt: Date.now(), dialMs: Date.now() - dialStart,
        bytesIn: 0, bytesOut: 0, framesIn: 0, framesOut: 0, maxOutFrameBytes: 0, maxOutFrameKind: null,
        bufferedPeak: 0, lastInbound: Date.now(), rtts: [], acks: 0, corrupt: 0,
      }
      log({ kind: 'probe', ev: 'connected', connId: conn.connId, dialMs: conn.dialMs })
      send({ ev: 'hello', hostAlias: o.hostAlias, version: VERSION, instanceId, sids: [] }, 'hello')
      // The daemon's watchdog: checks are counted, any inbound frame resets
      // the count, a ping goes out on every checksPerPing-th silent check.
      const w = { ...BRIDGE_WATCHDOG, ...(o.pingEveryMs ? { pingIntervalMs: o.pingEveryMs } : {}) }
      let heardAt = conn.lastInbound
      let silentChecks = 0
      pingTimer = setInterval(() => {
        if (conn.lastInbound !== heardAt) { heardAt = conn.lastInbound; silentChecks = 0; return }
        silentChecks++
        if (silentChecks % w.checksPerPing !== 0) return
        if (silentChecks >= w.checksPerPing * w.silentPings) {
          silence = true
          log({ kind: 'probe', ev: 'silence-detected', connId: conn.connId, silentMs: Date.now() - conn.lastInbound })
          try { sock.close() } catch { /* already closing */ }
          setTimeout(() => { if (sock.readyState !== WebSocket.CLOSED) sock.terminate() }, 2000).unref()
          return
        }
        pingSentAt = Date.now()
        send({ ev: 'bridge-ping', ts: pingSentAt }, 'ping')
      }, Math.round(w.pingIntervalMs / w.checksPerPing))
      payloadTimer = setInterval(() => sendPayload(o.payloadBytes, 'payload'), o.payloadEveryMs)
    })

    sock.on('message', (data) => {
      if (!conn || conn.ws !== sock) return
      const text = data.toString()
      conn.lastInbound = Date.now()
      conn.framesIn++
      conn.bytesIn += Buffer.byteLength(text)
      let msg
      try { msg = JSON.parse(text) } catch { return }
      if (typeof msg.id === 'number' && typeof msg.cmd === 'string') {
        if (msg.cmd === 'ping') {
          if (pingSentAt != null) { conn.rtts.push(Date.now() - pingSentAt); pingSentAt = null }
          send({ id: msg.id, ok: true }, 'rpc')
        } else {
          send({ id: msg.id, ok: false, error: 'probe: not a daemon' }, 'rpc')
        }
      } else if (msg.ev === 'probe-ack') {
        if (msg.ok) conn.acks++
        else conn.corrupt++
      }
    })

    sock.on('unexpected-response', (_req, res) => {
      lastError = `HTTP ${res.statusCode}`
      sock.terminate()
    })
    // Keep the FIRST error: terminate() after a 401 raises a generic second one.
    sock.on('error', (err) => { lastError = lastError ?? String(err?.message ?? err).slice(0, 200) })

    sock.on('close', (code, reasonBuf) => {
      clearInterval(pingTimer)
      clearInterval(payloadTimer)
      if (ws === sock) ws = null
      if (!opened) {
        log({ kind: 'probe', ev: 'dial-failed', dialMs: Date.now() - dialStart, error: lastError ?? `close ${code}` })
        scheduleRedial()
        return
      }
      const c = conn
      conn = null
      const tcp = sock._socket
      log({
        kind: 'probe', ev: 'conn-close', connId: c.connId, uptimeMs: Date.now() - c.openAt, code,
        reason: reasonBuf?.toString().slice(0, 120) ?? '', wasClean: code !== 1006, lastError,
        bytesIn: c.bytesIn, bytesOut: c.bytesOut, framesIn: c.framesIn, framesOut: c.framesOut,
        tcpBytesRead: tcp?.bytesRead ?? null, tcpBytesWritten: tcp?.bytesWritten ?? null,
        maxOutFrameBytes: c.maxOutFrameBytes, maxOutFrameKind: c.maxOutFrameKind,
        bufferedAmountPeak: c.bufferedPeak, bufferedAmountAtClose: sock.bufferedAmount,
        lastInboundAgeMs: Date.now() - c.lastInbound, rttMsP50: quantile(c.rtts, 0.5), rttMsMax: c.rtts.length ? Math.max(...c.rtts) : null,
        loopDriftMax60sMs: drift.length ? Math.max(...drift) : 0, loopDriftMax5sMs: drift.length ? Math.max(...drift.slice(-5)) : 0,
        acks: c.acks, corrupt: c.corrupt,
      })
      log({ kind: 'probe', ev: silence ? 'silence' : 'closed', connId: c.connId, ...(silence ? { silentMs: Date.now() - c.lastInbound } : {}) })
      scheduleRedial()
    })
  }

  dial()
  scheduleBurst()
  return {
    current: () => (conn ? { connId: conn.connId, rtts: conn.rtts.slice(), acks: conn.acks, corrupt: conn.corrupt, seq } : null),
    async stop() {
      stopped = true
      clearTimeout(redialTimer)
      clearTimeout(burstTimer)
      clearInterval(driftTimer)
      const sock = ws
      if (sock && sock.readyState !== WebSocket.CLOSED) {
        await new Promise((resolve) => {
          sock.once('close', resolve)
          try { sock.close(1000, 'probe stopping') } catch { resolve() }
          setTimeout(() => { try { sock.terminate() } catch { /* gone */ } resolve() }, 3000).unref()
        })
      }
    },
  }
}

/** 'auto' burst phase: half a cycle away from the M1 slot the summarizer found. */
export function resolveBurstPhase(setting, stateDir) {
  if (typeof setting === 'number') return setting
  try {
    const last = JSON.parse(fs.readFileSync(path.join(stateDir, 'last-summary.json'), 'utf-8'))
    if (typeof last?.phase?.phaseSec === 'number') return (last.phase.phaseSec + 150) % 300
  } catch { /* no summary yet */ }
  return 150
}

async function main() {
  const { cfg } = loadConfig()
  const p = cfg.probe
  if (!p.enabled) {
    process.stdout.write('bridge probe is disabled in the config (probe.enabled=false); exiting\n')
    return
  }
  const url = p.url ?? cfg.bridgeUrl
  let token = null
  try { token = fs.readFileSync(p.tokenFile, 'utf-8').trim() } catch { /* handled below */ }
  if (!url || !token) {
    process.stdout.write('bridge probe needs probe.url and a readable probe.tokenFile; exiting\n')
    return
  }
  ensureDir(cfg.logDir)
  ensureDir(cfg.stateDir)
  const store = new Store(cfg.logDir, { prefix: 'probe' })
  const pidFile = path.join(cfg.stateDir, 'probe.pid')
  fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 })
  const log = (rec) => { void store.append({ t: new Date().toISOString(), ...rec }) }
  const burstPhaseSec = resolveBurstPhase(p.burstPhaseSec, cfg.stateDir)
  log({ kind: 'probe', ev: 'start', version: VERSION, pid: process.pid, burstPhaseSec })
  const probe = startProbe({ ...p, url, token, burstPhaseSec, log })
  const stop = async (why) => {
    await probe.stop()
    log({ kind: 'probe', ev: 'stop', why })
    try { fs.rmSync(pidFile, { force: true }) } catch { /* gone */ }
    setTimeout(() => process.exit(0), 200)
  }
  process.on('SIGTERM', () => void stop('SIGTERM'))
  process.on('SIGINT', () => void stop('SIGINT'))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) await main()
