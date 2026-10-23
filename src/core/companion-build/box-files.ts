/**
 * The companion's build layout and the small async file helpers its steps use
 * (box.ts). R is WALNUT_COMPANION_ROOT, else ~/.open-walnut-host: the host
 * install layout (host-server/install.ts) plus R/companion, the state the
 * launcher shares.
 */

import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export function companionRoot(): string {
  const r = process.env.WALNUT_COMPANION_ROOT?.trim()
  return path.resolve(r || path.join(os.homedir(), '.open-walnut-host'))
}

export function dirs(R = companionRoot()) {
  const incoming = path.join(R, 'incoming')
  const state = path.join(R, 'companion')
  return {
    R, incoming, state,
    app: (id: string) => path.join(R, 'app', id),
    ready: (id: string) => path.join(R, 'app', id, '.ready'),
    /** The runtime the build was smoke-booted on (`bun` or `node`): the launcher runs a dist build only on that one. */
    runtime: (id: string) => path.join(R, 'app', id, '.runtime'),
    tgz: (id: string) => path.join(incoming, `${id}.tgz`),
    part: (id: string) => path.join(incoming, `${id}.tgz.part`),
    meta: (id: string) => path.join(incoming, `${id}.upload.json`),
    in: (id: string, ext: string) => path.join(incoming, `${id}.${ext}`),
    current: path.join(state, 'current'),
    trial: path.join(state, 'trial'),
    attempts: path.join(state, 'attempts'),
    previous: path.join(state, 'previous'),
    failedDir: path.join(state, 'failed'),
    installRec: path.join(state, 'install.json'),
    activateRec: path.join(state, 'activate.json'),
  }
}
export type Dirs = ReturnType<typeof dirs>

// ── small async file helpers ────────────────────────────────────────────────

export async function readLine(file: string): Promise<string | null> {
  try {
    const line = (await fsp.readFile(file, 'utf8')).split('\n')[0]!.trim()
    return line || null
  } catch {
    return null
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    const v = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown
    return v && typeof v === 'object' ? (v as T) : null
  } catch {
    return null
  }
}

/** Write a whole file with tmp + rename. The tmp name starts with a dot, so no reader takes it for a build id. */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  await fsp.writeFile(tmp, text)
  await fsp.rename(tmp, file)
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

export async function sizeOf(file: string): Promise<number | null> {
  try {
    return (await fsp.stat(file)).size
  } catch {
    return null
  }
}

export const rmFile = (file: string) => fsp.rm(file, { force: true })

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    createReadStream(file).on('error', reject).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex')))
  })
}

export function knobMs(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))
