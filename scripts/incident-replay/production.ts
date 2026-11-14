/**
 * The shape-only converter bound to the production readers of an error's words, plus a replay
 * parity check. shape.mjs stays free of TypeScript imports (the mock CLI loads it under any
 * runtime); this file is the bun side that converts RAW recordings, where what a result's text
 * MEANS must survive as a canonical text:
 *   - a usage limit (usage-limit-text.ts) -> USAGE_LIMIT_TEXT[window], the window as
 *     usage-limit-model.ts claudeWindowFromText reads it (the reset time is not kept);
 *   - otherwise the canonical ERROR_TEXT that every detector in DETECTORS reads the same way as
 *     the raw text; when none does, the fallback for its retryable/terminal x CLI-phrasing pair.
 */
import { matchesUsageLimitText } from '../../src/providers/usage-limit-text.js'
import { claudeWindowFromText } from '../../src/core/sessions/usage-limit-model.js'
import { classifyTurnError } from '../../src/providers/daemon-core.js'
import { isCliErrorText } from '../../src/core/sessions/cli-error-reply.js'
import { isContextFullText } from '../../src/core/sessions/context-full.js'
import { usersErrorKind } from '../../src/core/sessions/session-error-owner.js'
import { foldLine, initialFoldState, type FoldState } from '../../src/providers/daemon-fold.js'
import { lineFateScan, type LineFateScan } from '../../src/providers/line-fate-core.js'
import {
  ERROR_TEXT,
  PLACEHOLDER,
  USAGE_LIMIT_TEXT,
  convertStream,
  createStreamConverter,
  type ConvertOptions,
  type ConvertReport,
} from './shape.mjs'

/**
 * Every production reading of an error's or result's words that the shape must keep. A new
 * text detector the session paths branch on belongs here (and its canonical text in
 * schema.mjs ERROR_TEXT); the privacy test checks each canonical text reads as its own class.
 */
export const DETECTORS: ReadonlyArray<readonly [string, (text: string) => unknown]> = [
  ['turnError', (t) => classifyTurnError(t)],
  ['cliErrorText', (t) => isCliErrorText(t)],
  ['contextFull', (t) => isContextFullText(t)],
  ['userErrorKind', (t) => usersErrorKind(t)],
  // claude-code-session.ts, session-health-monitor.ts and daemon-file-reader-shared.ts test this phrase.
  ['conversationLost', (t) => t.includes('No conversation found')],
]

/** How the detectors read a text: one comparable value. */
export function detectorReading(text: string): string {
  return JSON.stringify(DETECTORS.map(([, read]) => read(text) ?? null))
}

const SPECIFIC = [ERROR_TEXT.contextFull, ERROR_TEXT.noConversation, ERROR_TEXT.signIn, ERROR_TEXT.credentials,
  ERROR_TEXT.permissions, ERROR_TEXT.spending, ERROR_TEXT.retryableCli, ERROR_TEXT.retryable, ERROR_TEXT.terminalCli, ERROR_TEXT.terminal]
const SPECIFIC_READINGS = SPECIFIC.map((t) => [detectorReading(t), t] as const)

/** A result or error text -> its canonical class text. */
export function productionClassifyText(text: string, isError: boolean): string {
  if (!text.trim()) return ''
  if (matchesUsageLimitText(text)) {
    const window = claudeWindowFromText(text)
    return window && Object.hasOwn(USAGE_LIMIT_TEXT, window) ? USAGE_LIMIT_TEXT[window as keyof typeof USAGE_LIMIT_TEXT] : USAGE_LIMIT_TEXT.unknown
  }
  const reading = detectorReading(text)
  if (!isError && reading === detectorReading(PLACEHOLDER.result)) return PLACEHOLDER.result
  const exact = SPECIFIC_READINGS.find(([r]) => r === reading)
  if (exact) return exact[1]
  const cli = isCliErrorText(text)
  if (!isError) return cli ? ERROR_TEXT.terminalCli : PLACEHOLDER.result
  const retryable = classifyTurnError(text) === 'retryable'
  return retryable ? (cli ? ERROR_TEXT.retryableCli : ERROR_TEXT.retryable) : (cli ? ERROR_TEXT.terminalCli : ERROR_TEXT.terminal)
}

/** Raw stream -> shape-only stream, with the production classifier. */
export function convertRawStream(content: string, opts: Omit<ConvertOptions, 'classifyText'> = {}): { content: string; report: ConvertReport } {
  return convertStream(content, { ...opts, classifyText: productionClassifyText })
}

/** Raw (or already shape-only) stream text -> shape-only stream text. */
export function toShapeOnly(content: string, opts: Omit<ConvertOptions, 'classifyText'> = {}): string {
  return convertRawStream(content, opts).content
}

/** The fold's verdict without byte offsets or ids (both change by design in a conversion). */
function foldVerdict(state: FoldState): Record<string, unknown> {
  const bg = Object.values(state.bgTasks)
  return {
    turnActive: state.turnActive,
    sawAnchor: state.sawAnchor,
    lastResult: state.lastResult ? { isError: state.lastResult.isError, numTurns: state.lastResult.numTurns } : null,
    sawNormalResult: state.sawNormalResult,
    followupResult: state.followupResult,
    trailingIdle: state.trailingIdle,
    failedLocalCommand: state.failedLocalCommand === true,
    commandFailureHeld: state.commandFailureHeld === true,
    settledCommandFailure: state.settledCommandFailure === true,
    gating: bg.filter((t) => !t.terminal && !t.isBackgrounded && !t.endedPerLevel).length,
    detached: bg.filter((t) => !t.terminal && t.isBackgrounded && !t.endedPerLevel).length,
    terminal: bg.filter((t) => t.terminal).length,
    teamActive: state.teamActive,
    cronActive: Object.keys(state.cronIds).length,
    pendingCronCreates: Object.keys(state.pendingCronCreates).length,
    wakeupAt: state.wakeupAt,
  }
}

const diffKeys = (a: Record<string, unknown>, b: Record<string, unknown>): string[] =>
  Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8')

/**
 * Does the converted stream replay the way the raw one does? Two production readers, compared
 * after EVERY raw line (a stream that differs mid-way but converges at the end still fails):
 *   - the daemon fold (daemon-fold.ts foldLine): its whole verdict;
 *   - line-fate (line-fate-core.ts lineFateScan): for every line uuid the stream names (a
 *     marker's walnutMessageId, a command_lifecycle's command_uuid) and every process pid, what
 *     the scan says of that line, at the end of the stream (pids and ids compared through the
 *     conversion's own map, a marker's time by presence).
 * Returns field names and a raw line number only, never values.
 */
export function replayParity(raw: string, opts: Omit<ConvertOptions, 'classifyText'> = {}): { ok: boolean; diffs: string[]; line: number | null } {
  const conv = createStreamConverter({ ...opts, classifyText: productionClassifyText })
  const parts = raw.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  let a = initialFoldState()
  let b = initialFoldState()
  let va = 0
  let vb = 0
  const out: string[] = []
  const uuids = new Set<string>()
  const pids = new Set<number>()
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]
    va += byteLen(line) + 1
    a = foldLine(a, line, va)
    let o: Record<string, unknown> | undefined
    try { o = JSON.parse(line) } catch { o = undefined }
    // A torn last line is dropped by the conversion (convertStream), and the fold reads it as nothing.
    const tornLast = i === parts.length - 1 && !raw.endsWith('\n') && (!o || typeof o !== 'object')
    if (o && typeof o === 'object') {
      if (typeof o.walnutMessageId === 'string') uuids.add(o.walnutMessageId)
      if (typeof o.command_uuid === 'string') uuids.add(o.command_uuid)
      if (typeof o.walnutPid === 'number') pids.add(o.walnutPid)
    }
    const c = tornLast ? null : conv.line(line)
    if (c !== null) {
      vb += byteLen(c) + 1
      b = foldLine(b, c, vb)
      out.push(c)
    }
    const d = diffKeys(foldVerdict(a), foldVerdict(b))
    if (d.length) return { ok: false, diffs: d.map((k) => `fold.${k}`), line: i + 1 }
  }
  const converted = out.join('\n') + '\n'
  const pidOut = (p: number | null | undefined): number | null => (typeof p === 'number' ? conv.lookupPid(p) ?? -1 : null)
  const norm = (s: LineFateScan, mapPid: (p: number | null | undefined) => number | null): Record<string, unknown> =>
    ({ ...s, markerAt: typeof s.markerAt === 'number', curPid: mapPid(s.curPid), startPid: mapPid(s.startPid) })
  for (const uuid of uuids) {
    for (const pid of [null, ...pids]) {
      const ra = lineFateScan(raw, { uuid, messageIds: [uuid], pid }, null)
      const cu = conv.lookupId(uuid) ?? ''
      const rb = lineFateScan(converted, { uuid: cu, messageIds: [cu], pid: pid === null ? null : conv.lookupPid(pid) ?? null }, null)
      const d = diffKeys(norm(ra, pidOut), norm(rb, (p) => (typeof p === 'number' ? p : null)))
      if (d.length) return { ok: false, diffs: d.map((k) => `lineFate.${k}`), line: null }
    }
  }
  return { ok: true, diffs: [], line: null }
}
