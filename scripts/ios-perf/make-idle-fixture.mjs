// Generates a SessionTranscript fixture matching the SHAPE + SIZE DISTRIBUTION
// measured on the sessions that produced the 2026-08-07 build-35 watchdog kills
// (three 0x8BADF00D freezes on IDLE — not streaming — giant sessions).
//
// Measured from the real /history payloads (content itself is neutral synthetic
// here; only the statistics are borrowed):
//   286 API rows / 787KB JSON, but only 87KB of assistant TEXT.
//   assistant text chars: p50=0, p90=78, p99=9388, max=29792 (5 rows >4K, 1 >16K)
//   249 of 286 rows carried a `tools` entry; tool entry JSON p50=1009,
//     p90=2971, max=6517 (input command + clipped result preview)
//   159 rows carried `thinking`; p50=673, max=9786
// The v1 transcript FLATTENS those side-payloads into their own rows
// (kind:"tool" with detail+resultPreview, kind:"thinking"), so 286 API rows
// expand to ~700 transcript rows — well past the client's 400-row hard cap.
//
// ⚠️ SCALE DISCRIMINATOR (2026-08-07). The phone does NOT consume /history —
// it consumes /api/v1/sessions/:id/transcript, which the server caps hard:
// TEXT_MAX=4000 chars per row, TRANSCRIPT_TAIL=100 rows (200 over the bridge),
// and the client caps again at 150 rendered rows while pinned. The bytes the
// crashing phones ACTUALLY received were therefore much smaller than the
// /history payloads:
//   346e5e9e: 75,636 B / 123 rows / 8,346 text chars / largest row 1,654 / ZERO rows >4K
//   c6ce9199: 123,443 B / 117 rows / 44,406 text chars / largest row 3,102 / ZERO rows >4K
// So run BOTH scales and treat the pair as the experiment:
//   MODE=field  (default) — 117 rows / ~123KB, what the phone really got.
//   MODE=history          — ~500 rows / ~1.2MB, the /history-derived overshoot.
// If the FIELD scale freezes, the bug is an unbounded LOOP (cycle count), not
// payload cost. If only the history scale freezes, it is cost-per-cycle and the
// field freeze needs a different explanation.
//
// Usage: node make-idle-fixture.mjs [outPath] [apiRows]   (env: MODE=field|history)
import fs from 'node:fs'

const OUT = process.argv[2] || '/tmp/ios-freeze/idle-fixture.json'
const MODE = process.env.MODE || 'field'
const FIELD = MODE === 'field'
// Server row cap: TEXT_MAX per row. Field data had ZERO rows above it.
const TEXT_MAX = 4000
const API_ROWS = Number(process.argv[3] || (FIELD ? 66 : 286))

// Deterministic PRNG so every run reproduces the same fixture.
let seed = 0x5eed1234
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

const CJK = '这一轮的分析结论如下:控制面在高负载下的重列风暴会导致缓存穿透,监控指标显示每分钟请求量峰值翻三倍,下游存储层延迟同步上升。**关键点**:先确认限流开关的默认值,再评估回退方案的爆炸半径。'
const CODE = '```bash\nkubectl get pods -A --no-headers | awk \'{print $1}\' | sort | uniq -c | sort -rn | head -20\n```'

function table(n, rows = 14) {
  let t = `| 指标${n} | 基线 | 峰值 | P99 | 判定 |\n|---|---|---|---|---|\n`
  for (let i = 1; i <= rows; i++) t += `| metric-${n}-${i} | ${i * 13}ms | ${i * 97}ms | ${i * 211}ms | ${i % 2 ? '超标' : '正常'} |\n`
  return t.trimEnd()
}

/** Grow a heavy-markdown block to ~`chars` characters (headings/tables/code/prose). */
function heavy(chars, salt) {
  let out = `## 第 ${salt} 轮结论\n\n`
  let n = 0
  while (out.length < chars) {
    switch (n++ % 4) {
      case 0: out += CJK + '\n\n'; break
      case 1: out += table(salt + n, 14) + '\n\n'; break
      case 2: out += CODE + '\n\n'; break
      default: out += `- 项目 ${n}:验证完成\n- 项目 ${n + 1}:等待复核\n- 项目 ${n + 2}:已回滚\n\n`
    }
  }
  return out.slice(0, chars)
}

/** Sample assistant text length from the measured percentile curve. */
function sampleTextLen(i) {
  const r = rand()
  if (FIELD) {
    // What the phone really received: largest row 3,102 chars, zero rows >4K.
    if (r < 0.45) return 0
    if (r < 0.85) return 40 + Math.floor(rand() * 260)
    return 800 + Math.floor(rand() * 2_300) // max 3,100 = the real largest row
  }
  if (i === 137) return 29792          // the one >16K row
  if (r < 0.50) return 0               // tool-only rows carry no text
  if (r < 0.90) return 20 + Math.floor(rand() * 60)
  if (r < 0.98) return 300 + Math.floor(rand() * 3_700)
  return 4_000 + Math.floor(rand() * 6_000)
}

const ts = (i) => new Date(Date.UTC(2026, 7, 6, 12, 0, i * 30)).toISOString()
const messages = []

for (let i = 0; i < API_ROWS; i++) {
  // 87% of rows are assistant, the rest user/system — matching the real mix.
  const r = i % 10
  if (r === 8) {
    messages.push({
      role: 'user',
      text: '继续第 ' + i + ' 项,注意别动生产配置,只读操作。把结果整理成表格。',
      timestamp: ts(i), kind: null, detail: null, resultPreview: null,
    })
    continue
  }
  if (r === 9) {
    // "system" rows arrive as notification-shaped assistant rows in v1.
    messages.push({
      role: 'assistant',
      text: '**Session Result**(第 ' + i + ' 阶段):' + CJK,
      timestamp: ts(i), kind: null, detail: null, resultPreview: null,
    })
    continue
  }
  // 56% of rows carried thinking — its own transcript row.
  if (rand() < 0.56) {
    let tlen = rand() < 0.5 ? 400 + Math.floor(rand() * 600) : 2_000 + Math.floor(rand() * 7_800)
    // Field arm: the server's TEXT_MAX clip applies to every row kind — the
    // real payloads had ZERO rows over 4K, thinking rows included.
    if (FIELD) tlen = Math.min(tlen, 3_100)
    messages.push({
      role: 'assistant', text: heavy(tlen, i).replace(/\n/g, ' ').slice(0, tlen),
      timestamp: ts(i), kind: 'thinking', detail: null, resultPreview: null,
    })
  }
  const textLen = sampleTextLen(i)
  if (textLen > 0) {
    messages.push({
      role: 'assistant', text: heavy(textLen, i),
      timestamp: ts(i), kind: null, detail: null, resultPreview: null,
    })
  }
  // 87% of rows carried a tool call — its own transcript row with a clipped
  // result preview (this is where most of the real payload bytes lived).
  if (rand() < 0.87) {
    // Match the measured tool-entry curve (p50=1009, p90=2971, max=6517)
    // rather than a uniform draw, which over-weighted the tail 3x. The field
    // arm respects the server's TEXT_MAX clip that the real payloads showed.
    const q = rand()
    let plen = q < 0.5 ? 300 + Math.floor(rand() * 700)
      : q < 0.9 ? 1_000 + Math.floor(rand() * 1_970)
      : 2_970 + Math.floor(rand() * 3_550)
    if (FIELD) plen = Math.min(plen, TEXT_MAX)
    messages.push({
      role: 'assistant', text: ['Bash', 'Read', 'Edit', 'Grep', 'Task'][i % 5],
      timestamp: ts(i), kind: 'tool',
      detail: 'kubectl get events --field-selector reason=Failed -n ns-' + i,
      resultPreview: heavy(plen, i + 1000),
    })
  }
}

// Server TRANSCRIPT_TAIL: the phone only ever sees the last 100 (200 via the
// bridge) rows, so the fixture must be tail-capped like the real endpoint or
// the "field" arm silently stops being the field arm.
const tail = FIELD ? 117 : messages.length
const kept = messages.slice(-tail)
const out = {
  version: 1, sessionId: 'freeze-repro-session', exportedAt: ts(API_ROWS),
  truncated: messages.length > tail, messages: kept,
}
messages.length = 0
messages.push(...kept)
fs.mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out))
const chars = messages.reduce((a, m) => a + m.text.length + (m.resultPreview || '').length, 0)
console.log(`[idle-fixture] ${OUT}: ${messages.length} transcript rows, ${chars} chars, ${(fs.statSync(OUT).size / 1024).toFixed(0)}KB JSON`)
console.log(`  kinds: ${['tool', 'thinking', null].map(k => k + '=' + messages.filter(m => m.kind === k).length).join(' ')}`)
