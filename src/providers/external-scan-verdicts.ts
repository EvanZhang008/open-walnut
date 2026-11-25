/**
 * The external-session scan's verdicts, kept across restarts (external-session-scan-core.ts).
 *
 * A verdict depends only on a transcript's own bytes, so the scan keeps one per file, keyed by
 * its stat stamp, and reads a head only when the stamp moved. Held in memory only, every restart
 * read every head in the 30-day window again: the Mac's daemon runs inside the server and
 * restarts with every land, and that was most of the scan's 14 s of 395 s of loop CPU in the
 * stall profiles of 2026-11-25. The daemon names the file (its own dir); `rules` names the code
 * that made the verdicts, and a file made by other rules is not read.
 *
 * ⚠️ Compiled into the bun daemon binary with the scan: node builtins only.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import type { CodexHead, ExternalSessionCandidate } from './external-session-scan-core.js'

/** What a stat says about a file's bytes: any write moves size, mtime or ctime
 *  (ctime also moves on utimes, which is how a copy can fake an mtime). */
export interface FileStamp { size: number; mtimeMs: number; ctimeMs: number; ino: number }

export function stampOf(stat: FileStamp): FileStamp {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino }
}

export function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino
}

/** A claude transcript's verdict; `final` as the scan explains it (external-session-scan-core.ts). */
export type ClaudeVerdict = { candidate: ExternalSessionCandidate | null; final?: true }
export type ClaudeVerdicts = Map<string, FileStamp & ClaudeVerdict>
export type CodexHeads = Map<string, FileStamp & { head: CodexHead }>

type KeptStamp = [size: number, mtimeMs: number, ctimeMs: number, ino: number]
interface KeptVerdicts {
  v: 1
  rules: string
  claude: Record<string, [...KeptStamp, ExternalSessionCandidate | null, 0 | 1]>
  codex: Record<string, [...KeptStamp, CodexHead]>
}

const loaded = new Set<string>()
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const stampFrom = (row: unknown[]): FileStamp | null =>
  isNum(row[0]) && isNum(row[1]) && isNum(row[2]) && isNum(row[3]) ? { size: row[0], mtimeMs: row[1], ctimeMs: row[2], ino: row[3] } : null

/** The verdicts a restart left, once per process and file, beneath what this process found itself. */
export async function loadKeptVerdicts(file: string | undefined, rules: string, claude: ClaudeVerdicts, codex: CodexHeads): Promise<void> {
  if (!file || loaded.has(file)) return
  loaded.add(file)
  let kept: Partial<KeptVerdicts>
  try { kept = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<KeptVerdicts> } catch { return }
  if (kept?.v !== 1 || kept.rules !== rules) return
  for (const [filePath, row] of Object.entries(kept.claude ?? {})) {
    if (claude.has(filePath) || !Array.isArray(row) || row.length !== 6) continue
    const stamp = stampFrom(row)
    const candidate = row[4]
    if (!stamp || (candidate !== null && (typeof candidate !== 'object' || typeof candidate.sessionId !== 'string'))) continue
    claude.set(filePath, { ...stamp, candidate, ...(row[5] === 1 && candidate === null ? { final: true as const } : {}) })
  }
  for (const [filePath, row] of Object.entries(kept.codex ?? {})) {
    if (codex.has(filePath) || !Array.isArray(row) || row.length !== 5) continue
    const stamp = stampFrom(row)
    const head = row[4]
    if (!stamp || !head || typeof head !== 'object' || !isNum(head.messageCount)) continue
    codex.set(filePath, { ...stamp, head })
  }
}

/** Each write its own temporary name, and writes in turn: two scans that end together never mix. */
let writeSeq = 0
let writing: Promise<void> = Promise.resolve()

export function saveKeptVerdicts(file: string | undefined, rules: string, claude: ClaudeVerdicts, codex: CodexHeads): Promise<void> {
  if (!file) return writing
  const row = (v: FileStamp): KeptStamp => [v.size, v.mtimeMs, v.ctimeMs, v.ino]
  const body = JSON.stringify({
    v: 1,
    rules,
    claude: Object.fromEntries([...claude].map(([p, v]) => [p, [...row(v), v.candidate, v.final ? 1 : 0]])),
    codex: Object.fromEntries([...codex].map(([p, v]) => [p, [...row(v), v.head]])),
  } satisfies KeptVerdicts)
  const tmp = `${file}.tmp-${process.pid}-${++writeSeq}`
  writing = writing.then(async () => {
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(tmp, body)
      await fsp.rename(tmp, file)
    } catch {
      await fsp.rm(tmp, { force: true }).catch(() => {})
    }
  })
  return writing
}

/** For tests: a restart, which reads the kept file again. */
export function _forgetLoadedVerdictFilesForTesting(): void {
  loaded.clear()
}
