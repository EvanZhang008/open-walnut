/**
 * Raw private stream -> shape-only fixture (production.ts convertRawStream), refused unless the
 * result validates and replays like the raw stream (production.ts replayParity). Prints counts,
 * never the stream's words.
 *
 *   bun scripts/incident-replay/convert.ts ~/.local/state/open-walnut/incident-replays/<name>.jsonl \
 *     --out tests/fixtures/incident-replays/<name>.shape.jsonl [--skip-partials] [--tail <lines>] \
 *     [--usage-limit five_hour|seven_day|seven_day_opus|seven_day_sonnet|overage|unknown] [--force]
 *
 * --tail keeps the last N raw lines (ids renumber from the first kept line). --usage-limit writes
 * the synthetic usage-limit variant (shape.mjs usageLimitVariant). Without --force an existing
 * --out is never overwritten; the output path is never followed through a symlink.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertShapeOnly, usageLimitVariant } from './shape.mjs'
import { convertRawStream, replayParity } from './production.js'

const USAGE = 'usage: bun scripts/incident-replay/convert.ts <raw.jsonl> --out <fixture.jsonl> [--skip-partials] [--tail <lines>] [--usage-limit <window>] [--force]'

function writeOut(file: string, content: string, force: boolean): void {
  const { O_WRONLY, O_CREAT, O_EXCL, O_TRUNC, O_NOFOLLOW } = fs.constants
  const flags = O_WRONLY | O_CREAT | (force ? O_TRUNC : O_EXCL) | (O_NOFOLLOW ?? 0)
  const fd = fs.openSync(file, flags, 0o644)
  try { fs.writeSync(fd, content) } finally { fs.closeSync(fd) }
}

function main(argv: string[]): number {
  const val = (flag: string): string | undefined => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1] }
  const src = argv[0] && !argv[0].startsWith('-') ? argv[0] : undefined
  const out = val('--out')
  const tail = val('--tail')
  const window = val('--usage-limit')
  if (!src || !out || (tail !== undefined && !/^[1-9]\d*$/.test(tail))) { console.error(USAGE); return 2 }
  let raw = fs.readFileSync(src, 'utf8')
  if (tail !== undefined) {
    const lines = raw.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    raw = lines.slice(-Number(tail)).join('\n') + '\n'
  }
  const opts = { skipPartials: argv.includes('--skip-partials') }
  const { content, report } = convertRawStream(raw, opts)
  // The fixture must replay what the recording did: the fold and line-fate read it the same, line by line.
  const parity = replayParity(raw, opts)
  if (!parity.ok) {
    console.error(`convert: the converted stream replays differently (${parity.diffs.join(', ')}${parity.line ? ` after raw line ${parity.line}` : ''}); not written`)
    return 1
  }
  const final = window ? usageLimitVariant(content, { window: window as 'five_hour' }) : content
  try {
    assertShapeOnly(final, out)
  } catch (err) {
    console.error((err as Error).message)
    return 1
  }
  try {
    writeOut(out, final, argv.includes('--force'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    console.error(code === 'EEXIST' ? `convert: ${out} exists (pass --force to replace it)` : code === 'ELOOP' ? `convert: ${out} is a symlink; not written` : `convert: ${(err as Error).message}`)
    return 1
  }
  // Dropped lines are reported by count (their types may be private words, so never by name).
  const warnings = [
    report.unknownType ? `${report.unknownType} line(s) of an event type or system subtype the schema does not list became stand-in lines` : '',
    report.malformed ? `${report.malformed} line(s) were not JSON objects and became stand-in lines` : '',
    report.tornTail ? 'the last line was torn (no newline, not JSON) and was dropped' : '',
  ].filter(Boolean)
  console.log(JSON.stringify({ wrote: out, report, replayParity: parity.ok, usageLimit: window ?? null, warnings }))
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
