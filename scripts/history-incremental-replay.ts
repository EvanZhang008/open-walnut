/**
 * Replay a real transcript's growth through the history reader's incremental
 * rules and count the whole-file reads they force, with why.
 *
 *   bun scripts/history-incremental-replay.ts <transcript.jsonl> [--from 0.5] [--every 10]
 *
 * The file is read up to --from of its lines (a full read that seeds the
 * incremental state with the real seed, seedIncrementalState), then grows
 * --every lines at a time, each step one history read: the append is taken
 * incrementally under the same rules as tryIncrementalHistoryRead (a tail past
 * the roll size is rolled in memory, a prefix tool whose result arrives drops the state), and a
 * read with no state is a full read that seeds again. Nothing is written; the
 * transcript is only read. Prints one JSON line.
 */
import fs from 'node:fs'
import {
  parseSessionMessages,
  _seedIncrementalStateForTesting as seed,
  _rollIncrementalTailForTesting as roll,
  incrementalTailRolls,
  type _HistoryIncrementalState as Inc,
} from '../src/core/session-history.js'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
if (!file) { console.error('usage: bun scripts/history-incremental-replay.ts <transcript.jsonl> [--from 0.5] [--every 10]'); process.exit(2) }
const opt = (name: string, dflt: number) => { const i = args.indexOf(`--${name}`); return i === -1 ? dflt : Number(args[i + 1]) }
const from = opt('from', 0.5)
const every = opt('every', 10)

const content = fs.readFileSync(file, 'utf8')
const ends: number[] = []
for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) ends.push(i + 1)
const startLine = Math.max(1, Math.floor(ends.length * from))

const reasons: Record<string, number> = {}
let fullReads = 0
let fullBytes = 0
let incReads = 0
let incBytes = 0
let rolls = 0
let inc: Inc | undefined
let parsedChars = 0

function fullRead(upto: number, why: string): void {
  fullReads++
  fullBytes += Buffer.byteLength(content.slice(0, upto), 'utf8')
  reasons[why] = (reasons[why] ?? 0) + 1
  const text = content.slice(0, upto)
  const messages = parseSessionMessages(text)
  const out: { reason?: string } = {}
  inc = seed('replay', { content: text, source: 'local' }, messages, file, out)
  parsedChars = upto
  if (!inc) reasons[`seed-skipped:${out.reason}`] = (reasons[`seed-skipped:${out.reason}`] ?? 0) + 1
}

fullRead(ends[startLine - 1], 'first')
const t0 = Date.now()
for (let line = startLine + every; line <= ends.length; line += every) {
  const upto = ends[Math.min(line, ends.length) - 1]
  if (!inc) { fullRead(upto, 'no-state'); continue }
  const appended = content.slice(parsedChars, upto)
  if (inc.pendingToolIds.some((id) => appended.includes(id))) { inc = undefined; fullRead(upto, 'prefix-tool-result'); continue }
  if (incrementalTailRolls(inc, inc.tailText + appended)) {
    const rolled = await roll('replay', inc, inc.tailText + appended)
    if (!rolled) { inc = undefined; fullRead(upto, 'tail-roll-failed'); continue }
    inc = rolled.inc
    rolls++
  } else {
    inc.tailText += appended
  }
  incReads++
  incBytes += Buffer.byteLength(appended, 'utf8')
  parsedChars = upto
}
console.log(JSON.stringify({
  file: file.split('/').pop(), fileBytes: Buffer.byteLength(content, 'utf8'), lines: ends.length, replayedFrom: startLine, every,
  reads: fullReads + incReads, fullReads, fullMB: Math.round(fullBytes / 1e6), incReads, incMB: +(incBytes / 1e6).toFixed(1), rolls, reasons,
  ms: Date.now() - t0,
}))
