/**
 * A host's daemon for host_copy tests, in-process, over a temp "home" dir: fs.readRange
 * and fs.rm answer the way both daemon twins do (their error text included, which
 * host-copy-paths.ts reads; fs.rm keeps the twins' two-segment floor), and fs.writePart
 * is the REAL transfer core. Knobs: a delay per read (a slow link), a corrupted part
 * (bytes changed on the way), a hook after each read (a source that changes), a path
 * whose command never answers (the link's timeout, as a macOS permission dialog makes
 * it), and the capabilities it reports (an older daemon). `sent` records each command
 * with the timeout it was sent with.
 */
import { spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createTransferCore, type TransferCoreDeps, type TransferError } from '../../src/providers/transfer-core.js'
import type { TransferConn } from '../../src/core/transfer/daemon-transfer-client.js'

export const COPY_HOST_CAPS = ['fs.readRange', 'fs.stat', 'fs-write-part-v1', 'fs-mutate-v1']

export interface FakeCopyHost {
  conn: TransferConn
  home: string
  sent: Array<{ cmd: string; params: Record<string, unknown>; timeoutMs?: number }>
  knobs: {
    readDelayMs: number
    /** Flip one byte of every part written here. */
    corrupt: boolean
    afterRead?: (p: string, start: number) => void
    /** A command on this path gets no answer: it fails the way the link's timeout does. */
    hangs?: (cmd: string, p: string) => boolean
    caps: string[]
  }
}

export function fakeCopyHost(home: string): FakeCopyHost {
  fs.mkdirSync(home, { recursive: true })
  const core = createTransferCore({ fs, path, crypto, spawn: spawn as unknown as TransferCoreDeps['spawn'], env: {}, home })
  const expand = (p: unknown) => {
    const s = String(p ?? '')
    return s === '~' || s.startsWith('~/') ? home + s.slice(1) : s
  }
  const host: FakeCopyHost = {
    home,
    sent: [],
    knobs: { readDelayMs: 0, corrupt: false, caps: [...COPY_HOST_CAPS] },
    conn: {
      hasCapability: (c) => host.knobs.caps.includes(c),
      async send(cmd, params, timeoutMs) {
        host.sent.push({ cmd, params, timeoutMs })
        if (host.knobs.hangs?.(cmd, expand(params.path))) throw new Error(`daemon command timeout: ${cmd} (${timeoutMs ?? 0}ms)`) // DaemonConnection's words
        try {
          if (cmd === 'fs.readRange') {
            if (host.knobs.readDelayMs) await new Promise((r) => setTimeout(r, host.knobs.readDelayMs))
            const p = expand(params.path)
            const st = await fs.promises.stat(p)
            if (!st.isFile()) return { ok: false, error: 'fs.readRange failed: not a regular file (ENOTFILE)' }
            const start = Number(params.start ?? 0)
            const length = Math.min(Number(params.length ?? 1024 * 1024), 4 * 1024 * 1024)
            const fh = await fs.promises.open(p, 'r')
            try {
              const size = (await fh.stat()).size
              const n = Math.max(0, Math.min(length, size - start))
              const buf = Buffer.alloc(n)
              const { bytesRead } = n ? await fh.read(buf, 0, n, start) : { bytesRead: 0 }
              host.knobs.afterRead?.(p, start)
              return { ok: true, data: buf.subarray(0, bytesRead).toString('base64'), bytesRead, fileSize: size, eof: start + bytesRead >= size }
            } finally {
              await fh.close()
            }
          }
          if (cmd === 'fs.rm') {
            const p = expand(params.path)
            // The twins' floor (fsMutateFloor): fewer than two segments is never removed.
            if (p.split('/').filter(Boolean).length < 2) return { ok: false, error: 'fs.rm refused: path outside the mutation floor (EDENIED)' }
            await fs.promises.rm(p)
            return { ok: true, removed: true }
          }
          if (cmd === 'fs.writePart') {
            const data = host.knobs.corrupt && typeof params.data === 'string' && params.data.length
              ? (() => { const b = Buffer.from(params.data as string, 'base64'); b[0] ^= 0xff; return b.toString('base64') })()
              : params.data
            try {
              return { ok: true, ...(await core.writePart({ ...params, data })) }
            } catch (err) {
              const e = err as TransferError
              return { ...(e.data ?? {}), ok: false, error: 'fs.writePart failed: ' + e.message, code: e.code }
            }
          }
          return { ok: false, error: `${cmd} failed: not in this fake` }
        } catch (err) {
          const e = err as NodeJS.ErrnoException
          return { ok: false, error: `${cmd} failed: ${e.message}${e.code && cmd === 'fs.readRange' ? ` (${e.code})` : ''}` }
        }
      },
    },
  }
  return host
}
