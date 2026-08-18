// Minimal mock of the Walnut /api/v1 surface with a controllable session SSE
// stream — feeds the iOS app a long transcript + live-stream pattern so the L2
// freeze smoke (scripts/ios-perf-check.sh --sim) can reproduce long-session
// rendering load without touching a real server. Node 18+, no deps.
//
// This script exists ONLY for the L2 simulator smoke. The parsing perf gates
// live in the WalnutTests XCTest target (ios-native/WalnutTests/), which
// generates its own fixtures in Swift — no shared fixture files.
//
// Env knobs:
//   PORT          listen port                        (default 3510)
//   FIXTURE       SessionTranscript JSON path        (optional; default =
//                 built-in synthetic "mixed" transcript, MSG_COUNT rows)
//   MSG_COUNT     built-in transcript length         (default 1000)
//   LIVE_TEXT_KB  snapshot live-region text size     (default 256)
//   DELTA_MS      text-delta cadence                 (default 150)
//   DELTA_BYTES   bytes per delta                    (default 400)
//   DELTA_COUNT   number of deltas then stop         (default 200)
//   IDLE=1        IDLE session mode: process_status "idle", snapshot reports
//                 isStreaming=false with an EMPTY live region and no deltas.
//                 This is the 2026-08-07 build-35 field shape — all three
//                 watchdog kills were on idle sessions with no live turn, so
//                 the streaming knobs above must be OFF to reproduce them.
//   THINKING_MS   thinking-event cadence, ms (0 = off, default 0). The
//                 2026-08-08 build-36 field shape: the cloud bridge forwards
//                 CLI thinking_deltas 1:1 as `thinking` SSE events (tiny
//                 payloads, high rate — measured 10.7 ev/s sustained with
//                 microbursts to ~700/s). THINKING_MS=93 reproduces the
//                 sustained field rate; text deltas stay on their own knobs.
//   THINKING_COUNT  number of thinking events then stop (default 2000)
import http from 'node:http'
import fs from 'node:fs'

const PORT = Number(process.env.PORT || 3510)
const LIVE_TEXT_KB = Number(process.env.LIVE_TEXT_KB || 256)
const DELTA_MS = Number(process.env.DELTA_MS || 150)
const DELTA_BYTES = Number(process.env.DELTA_BYTES || 400)
const DELTA_COUNT = Number(process.env.DELTA_COUNT || 200)
const MSG_COUNT = Number(process.env.MSG_COUNT || 1000)
const IDLE = process.env.IDLE === '1'
/** Sends to refuse with 503 bridge_offline before accepting (retry-ladder lever). */
let bridgeOfflineSendsLeft = Number(process.env.BRIDGE_OFFLINE_SENDS || 0)
const THINKING_MS = Number(process.env.THINKING_MS || 0)
const THINKING_COUNT = Number(process.env.THINKING_COUNT || 2000)

const CJK = '这一轮的分析结论如下:控制面在高负载下的重列风暴会导致缓存穿透,监控指标显示每分钟请求量峰值翻三倍。**关键点**:先确认限流开关默认值。\n\n'
const TABLE = '| 指标 | 基线 | 峰值 |\n|---|---|---|\n| m1 | 13ms | 97ms |\n| m2 | 26ms | 194ms |\n\n'

// Built-in "mixed" transcript (closest to the field crash shape): CJK prose,
// tables, code blocks, tool rows — same 6:2:2 rhythm as real transcripts.
// Mirrors TranscriptFixtures.swift's mixed profile; neutral synthetic data.
function buildMixedTranscript(count) {
  const CODE = '```bash\nkubectl get pods -A --no-headers | awk \'{print $1}\' | sort | uniq -c | sort -rn | head -20\n```'
  const bigTable = (n) => {
    let t = `| 指标${n} | 基线 | 峰值 | P99 | 判定 |\n|---|---|---|---|---|\n`
    for (let i = 1; i <= 14; i++) t += `| metric-${n}-${i} | ${i * 13}ms | ${i * 97}ms | ${i * 211}ms | ${i % 2 ? '超标' : '正常'} |\n`
    return t.trimEnd()
  }
  const ts = (i) => new Date(Date.UTC(2026, 7, 6, 12, 0, i * 30)).toISOString()
  const messages = []
  for (let i = 0; i < count; i++) {
    const r = i % 10
    if (r < 6) {
      const kind = i % 4
      const text = kind === 0 ? [`## 第 ${i} 轮结论`, CJK.trim(), bigTable(1), CODE].join('\n\n')
        : kind === 1 ? `收到,第 ${i} 步完成。`
        : kind === 2 ? `运行结果:\n${CODE}`
        : [CJK.trim(), bigTable(2)].join('\n\n')
      messages.push({ role: 'assistant', text, timestamp: ts(i) })
    } else if (r < 8) {
      messages.push({
        role: 'assistant', text: 'Bash', timestamp: ts(i), kind: 'tool',
        detail: `kubectl get events --field-selector reason=Failed -n ns-${i}`,
        resultPreview: Array.from({ length: 8 }, (_, j) => `ns-${i}   ${j}m   Warning   Failed   pod/worker-${j}`).join('\n'),
      })
    } else {
      messages.push({ role: 'user', text: `继续第 ${i} 项,注意别动生产配置,只读操作。把结果整理成表格。`, timestamp: ts(i) })
    }
  }
  return { version: 1, sessionId: 'perf-check-session', exportedAt: ts(count), truncated: false, messages }
}

const transcript = process.env.FIXTURE
  ? JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'))
  : buildMixedTranscript(MSG_COUNT)
const SID = transcript.sessionId || 'perf-check-session'
transcript.sessionId = SID
function bigText(kb) {
  let s = '## 长回复\n\n'
  while (Buffer.byteLength(s) < kb * 1024) s += CJK + TABLE
  return s
}

const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  if (p === '/api/v1/sessions') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      sessions: [{
        id: SID, title: 'Perf check session', host: '', process_status: IDLE ? 'idle' : 'running',
        started_at: new Date().toISOString(), last_active_at: new Date().toISOString(),
        message_count: transcript.messages.length, cwd: '/tmp',
      }],
      syncedAt: new Date().toISOString(),
    }))
    return
  }
  if (p === `/api/v1/sessions/${SID}/transcript`) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(transcript))
    return
  }
  if (p === `/api/v1/sessions/${SID}/stream`) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    if (IDLE) {
      // Field shape: idle session, no live region, no deltas ever. The stream
      // stays open (as the real one does) so the client keeps its SSE state.
      send('snapshot', { blocks: [], isStreaming: false, completedLen: 0, processStatus: 'idle' })
      return
    }
    send('snapshot', {
      blocks: [{ type: 'text', content: bigText(LIVE_TEXT_KB), name: null, status: null, parentToolUseId: null }],
      isStreaming: true, completedLen: 0, processStatus: 'running',
    })
    let n = 0
    const unit = CJK + TABLE
    const chunk = unit.repeat(Math.ceil(DELTA_BYTES / Buffer.byteLength(unit))).slice(0, DELTA_BYTES)
    const timer = setInterval(() => {
      if (++n > DELTA_COUNT) { clearInterval(timer); return }
      send('text-delta', { delta: chunk })
    }, DELTA_MS)
    // Build-36 field shape: high-rate tiny `thinking` events riding alongside
    // (or instead of) text deltas — the cloud bridge's 1:1 thinking_delta
    // forwarding. Payload matches the field p50 (7 bytes).
    let tn = 0
    const thinkTimer = THINKING_MS > 0 ? setInterval(() => {
      if (++tn > THINKING_COUNT) { clearInterval(thinkTimer); return }
      send('thinking', { delta: '思考' })
    }, THINKING_MS) : null
    req.on('close', () => { clearInterval(timer); if (thinkTimer) clearInterval(thinkTimer) })
    return
  }
  if (p === `/api/v1/sessions/${SID}/messages` && req.method === 'POST') {
    // Field send path: 202 accepted (the real cloud replica queues the text).
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      // BRIDGE_OFFLINE_SENDS=n → answer the first n sends with the real 503
      // bridge_offline shape (the lid-closed / SSH-flap window), then start
      // accepting. This is the manual-verification lever for the app's
      // automatic send-retry ladder: the composer must NOT report "Not sent",
      // it must ride the backoff out and land the message on its own.
      // Every attempt's messageId is logged so a human can SEE that the retry
      // reused the original id (the server-side dedupe depends on it).
      let mid = null
      try { mid = JSON.parse(body).messageId ?? null } catch { /* not JSON */ }
      if (bridgeOfflineSendsLeft > 0) {
        bridgeOfflineSendsLeft -= 1
        console.log(`[send] 503 bridge_offline messageId=${mid} (${bridgeOfflineSendsLeft} more will fail)`)
        res.statusCode = 503
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          error: { code: 'bridge_offline', message: 'No live bridge to this session\'s host' },
        }))
        return
      }
      console.log(`[send] 202 accepted messageId=${mid}`)
      res.statusCode = 202
      res.end(JSON.stringify({ messageId: mid ?? 'qm-mock-' + Date.now() }))
    })
    return
  }
  if (p === '/api/v1/tasks') { res.end(JSON.stringify({ tasks: [], syncedAt: new Date().toISOString() })); return }
  if (p === '/api/v1/notes') { res.end(JSON.stringify({ notes: [] })); return }
  if (p === '/api/v1/devices/self') { res.end(JSON.stringify({ ok: true })); return }
  if (p === '/api/v1/client-logs') {
    // Echo the app's own telemetry to stdout so the freeze probe can grep for
    // "main thread unresponsive" — that line is the field crash's precursor
    // signal and the only in-app proof of a stall.
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      for (const line of body.split('\n')) {
        if (/freeze|unresponsive|recovered/i.test(line)) console.log('[client-log] ' + line.slice(0, 400))
      }
      res.end('{"ok":true}')
    })
    return
  }
  if (p.startsWith('/api/v1/chat')) { res.end(JSON.stringify({ conversations: [], messages: [] })); return }
  res.statusCode = 404
  res.end('{"error":"not_found"}')
})
server.listen(PORT, () => console.log(`[ios-perf-mock-server] :${PORT} fixture=${process.env.FIXTURE || `built-in mixed x${MSG_COUNT}`} liveKB=${LIVE_TEXT_KB}`))
