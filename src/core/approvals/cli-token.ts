/**
 * The saved ask of `walnut approve --request-only`, read back by `walnut approve --approval <id>`.
 *
 * One file per approval, `<id>.json` in `${XDG_STATE_HOME:-~/.local/state}/open-walnut/approvals/`
 * (dir 0700, file 0600, written atomically): it holds the wait token, which only the asker may
 * hold, and what was asked (the what, the raw detail and its sha256, the signed envelope), so a
 * resumed run can prove it is the same request. Files older than a day are swept on each run.
 * Node builtins only: the daemon bundles it (cli-core.ts).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface SavedApproval {
  id: string
  waitToken: string
  what: string
  /** The raw operation context of the ask (not the server's envelope). */
  detail?: string
  detailSha256: string
  singleUse: boolean
  signingKeyId?: string
  signingKeyPath?: string
  createdAt: string
  expiresAt: string
  /** rec.detail as the server stored it, for a single-use ask: the envelope with its nonce. */
  envelope?: string
}

export const TOKEN_MAX_AGE_MS = 24 * 60 * 60_000

const ID_RE = /^apr-[A-Za-z0-9_-]+$/

export function isApprovalId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 80 && ID_RE.test(id)
}

export function sha256Hex(text: string | undefined): string {
  return crypto.createHash('sha256').update(text ?? '', 'utf8').digest('hex')
}

export function tokenDir(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(os.homedir(), '.local', 'state')
  return path.join(state, 'open-walnut', 'approvals')
}

function fileOf(id: string, dir: string): string {
  if (!isApprovalId(id)) throw new Error(`not an approval id: ${JSON.stringify(id)}`)
  return path.join(dir, `${id}.json`)
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
}

export function saveToken(saved: SavedApproval, dir: string = tokenDir()): string {
  const file = fileOf(saved.id, dir)
  ensureDir(dir)
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(saved) + '\n', { mode: 0o600, flag: 'wx' })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* never written */ }
    throw err
  }
  return file
}

/** The saved ask, or undefined when there is none (or it is not a well-formed one). */
export function loadToken(id: string, dir: string = tokenDir()): SavedApproval | undefined {
  const file = fileOf(id, dir)
  let raw: string
  try { raw = fs.readFileSync(file, 'utf8') } catch { return undefined }
  try {
    const v = JSON.parse(raw) as Partial<SavedApproval>
    if (v.id !== id || typeof v.waitToken !== 'string' || !v.waitToken || typeof v.what !== 'string'
      || typeof v.detailSha256 !== 'string' || typeof v.singleUse !== 'boolean'
      || typeof v.createdAt !== 'string' || typeof v.expiresAt !== 'string') return undefined
    if (v.detail !== undefined && typeof v.detail !== 'string') return undefined
    if (v.envelope !== undefined && typeof v.envelope !== 'string') return undefined
    if (v.signingKeyId !== undefined && typeof v.signingKeyId !== 'string') return undefined
    return v as SavedApproval
  } catch {
    return undefined
  }
}

export function removeToken(id: string, dir: string = tokenDir()): void {
  try { fs.unlinkSync(fileOf(id, dir)) } catch { /* already gone */ }
}

/** Removes saved asks (and stray temp files) last written more than a day ago. */
export function sweepTokens(dir: string = tokenDir(), now: number = Date.now()): number {
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return 0 }
  let removed = 0
  for (const name of names) {
    if (!/^apr-[A-Za-z0-9_-]+\.json(\.tmp-[0-9a-z-]+)?$/.test(name)) continue
    const file = path.join(dir, name)
    try {
      if (now - fs.statSync(file).mtimeMs > TOKEN_MAX_AGE_MS) { fs.unlinkSync(file); removed++ }
    } catch { /* raced with another run */ }
  }
  return removed
}
