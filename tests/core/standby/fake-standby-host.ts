/**
 * A standby host's daemon link, in process (remote-transport tests): fs.writePart is the
 * daemons' own transfer core, fs.readRange reads the file, exec.script runs the receive op as
 * the walnut CLI would. `state.down` takes the link away; `state.fault` answers or drops one
 * command; `log` records each command and its payload bytes.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createTransferCore, type TransferCoreDeps, type TransferError } from '../../../src/providers/transfer-core.js'
import { markLinkFailure } from '../../../src/providers/link-failure.js'
import type { DaemonLink } from '../../../src/core/standby/remote-transport.js'
import { RECEIVE_MARK, runReceiveOp, type ReceiveOptions } from '../../../src/core/standby/receive.js'

export type Fault = (cmd: string, params: Record<string, unknown>) => 'lost-before' | 'lost-after' | Record<string, unknown> | undefined

/** A daemon link to this machine: the real transfer core, exec.script running the receive op in process. */
export function fakeStandbyHost(root: string) {
  const core = createTransferCore({ fs, path, crypto, spawn: spawn as unknown as TransferCoreDeps['spawn'], env: {}, home: root })
  const log: Array<{ cmd: string; bytes: number }> = []
  const state = { down: false, fault: null as Fault | null }
  const run = async (cmd: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (cmd === 'fs.writePart') {
      try {
        return { ok: true, ...(await core.writePart(params)) }
      } catch (err) {
        const e = err as TransferError
        return { ...(e.data ?? {}), ok: false, error: `fs.writePart failed: ${e.message}`, code: e.code }
      }
    }
    if (cmd === 'fs.readRange') {
      const buf = fs.readFileSync(String(params.path))
      const start = Number(params.start)
      const part = buf.subarray(start, start + Number(params.length))
      log[log.length - 1].bytes += part.length
      return { ok: true, data: part.toString('base64'), bytesRead: part.length, fileSize: buf.length, eof: start + part.length >= buf.length }
    }
    if (cmd === 'exec.script') {
      const args = params.args as string[]
      if (args.slice(0, 3).join(' ') !== 'walnut standby receive') return { ok: true, code: 127, stdout: '', stderr: `not walnut: ${args.join(' ')}`, timedOut: false, truncated: false }
      const [op, dir, ...rest] = args.slice(3)
      const o: Record<string, string | boolean> = {}
      for (let i = 0; i < rest.length; i++) {
        const k = rest[i].replace(/^--/, '').replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
        if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) o[k] = rest[++i]
        else o[k] = true
      }
      const answer = await runReceiveOp(op, dir, o as ReceiveOptions).catch((err: Error) => ({ error: err.message }))
      return { ok: true, code: 0, stdout: `${RECEIVE_MARK}${JSON.stringify(answer)}\n`, stderr: '', timedOut: false, truncated: false }
    }
    return { ok: false, error: `unknown command ${cmd}` }
  }
  const link: DaemonLink = {
    async send(cmd, params = {}) {
      log.push({ cmd: cmd === 'exec.script' ? `receive ${(params.args as string[])[3]}` : cmd, bytes: typeof params.data === 'string' ? Buffer.from(params.data, 'base64').length : 0 })
      if (state.down) throw markLinkFailure(new Error('link down'), 'no-link')
      const f = state.fault?.(cmd, params)
      if (f === 'lost-before') throw markLinkFailure(new Error('link lost'), 'lost')
      if (f && f !== 'lost-after') return f
      const reply = await run(cmd, params)
      if (f === 'lost-after') throw markLinkFailure(new Error('link lost after the command ran'), 'lost')
      return reply
    },
  }
  return { link, log, state }
}

