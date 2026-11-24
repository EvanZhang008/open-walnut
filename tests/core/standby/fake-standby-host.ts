/**
 * A standby host's daemon link, in process (remote-transport tests): fs.writePart is the
 * daemons' own transfer core, fs.readRange reads the file, exec.script runs the receive op as
 * the walnut CLI would, and exec.run (background) runs it as a job.
 * `state.down` takes the link away; `state.fault` answers or drops one command; `log` records
 * each command and its payload bytes; `state.applyPoint` runs at each commit point of an apply
 * job (a gate, a delay); `state.applyRuns` counts the apply jobs that ran.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createTransferCore, type TransferCoreDeps, type TransferError } from '../../../src/providers/transfer-core.js'
import { markLinkFailure } from '../../../src/providers/link-failure.js'
import type { DaemonLink } from '../../../src/core/standby/remote-transport.js'
import { RECEIVE_MARK, receiveApply, runReceiveOp, type ReceiveOptions } from '../../../src/core/standby/receive.js'
import type { CommitHooks } from '../../../src/core/standby/target.js'

export type Fault = (cmd: string, params: Record<string, unknown>) => 'lost-before' | 'lost-after' | Record<string, unknown> | undefined

/** A daemon link to this machine: the real transfer core, exec.script running the receive op in process. */
export function fakeStandbyHost(root: string) {
  const core = createTransferCore({ fs, path, crypto, spawn: spawn as unknown as TransferCoreDeps['spawn'], env: {}, home: root })
  const log: Array<{ cmd: string; bytes: number; path?: string }> = []
  const state = {
    down: false,
    fault: null as Fault | null,
    /** Awaited before each command reaches the host (a test holding one until something else ended). */
    before: null as ((cmd: string, params: Record<string, unknown>) => Promise<void>) | null,
    applyPoint: null as CommitHooks['point'] | null,
    applyRuns: 0,
  }
  const hostHome = path.join(root, 'standby-host-home')
  /** `walnut standby receive <op> <dir> ...` as the CLI runs it: its exit code and output. */
  const receive = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    if (args.slice(0, 3).join(' ') !== 'walnut standby receive') return { code: 127, stdout: '', stderr: `not walnut: ${args.join(' ')}` }
    const [op, dir, ...rest] = args.slice(3)
    const o: Record<string, string | boolean> = {}
    for (let i = 0; i < rest.length; i++) {
      const k = rest[i].replace(/^--/, '').replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
      if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) o[k] = rest[++i]
      else o[k] = true
    }
    const point = state.applyPoint
    const answer = await (op === 'apply' && point
      ? receiveApply(dir, String(o.upload), { verify: o.verify === true, status: typeof o.status === 'string' ? o.status : undefined, hooks: { point } })
      : runReceiveOp(op, dir, o as ReceiveOptions, hostHome)).catch((err: Error) => ({ error: err.message }))
    return { code: 'error' in (answer as object) ? 1 : 0, stdout: `${RECEIVE_MARK}${JSON.stringify(answer)}\n`, stderr: '' }
  }
  const jobs = new Map<string, { running: boolean; exitCode: number | null; output: string }>()
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
      if (!fs.existsSync(String(params.path))) return { ok: false, error: `fs.readRange failed: ENOENT: no such file or directory, stat '${String(params.path)}' (ENOENT)` }
      const buf = fs.readFileSync(String(params.path))
      const start = Number(params.start)
      const part = buf.subarray(start, start + Number(params.length))
      log[log.length - 1].bytes += part.length
      return { ok: true, data: part.toString('base64'), bytesRead: part.length, fileSize: buf.length, eof: start + part.length >= buf.length }
    }
    if (cmd === 'exec.script') {
      const r = await receive(params.args as string[])
      return { ok: true, code: r.code === 127 ? 127 : 0, stdout: r.stdout, stderr: r.stderr, timedOut: false, truncated: false }
    }
    if (cmd === 'exec.run') {
      const id = String(params.jobId)
      if (jobs.has(id)) return { ok: false, code: 'job_exists', error: `exec.run failed: job ${id} already exists` }
      const job = { running: true, exitCode: null as number | null, output: '' }
      jobs.set(id, job)
      const argv = params.argv as string[]
      if (argv[3] === 'apply') state.applyRuns++
      void receive(argv).then((r) => { job.output = r.stdout + r.stderr; job.exitCode = r.code; job.running = false })
      return { ok: true, jobId: id, running: true }
    }
    return { ok: false, error: `unknown command ${cmd}` }
  }
  const link: DaemonLink = {
    async send(cmd, params = {}) {
      log.push({ cmd: cmd === 'exec.script' ? `receive ${(params.args as string[])[3]}` : cmd === 'exec.run' ? `receive ${(params.argv as string[])[3]}` : cmd, bytes: typeof params.data === 'string' ? Buffer.from(params.data, 'base64').length : 0, ...(typeof params.path === 'string' ? { path: params.path } : {}) })
      if (state.down) throw markLinkFailure(new Error('link down'), 'no-link')
      await state.before?.(cmd, params)
      const f = state.fault?.(cmd, params)
      if (f === 'lost-before') throw markLinkFailure(new Error('link lost'), 'lost')
      if (f && f !== 'lost-after') return f
      const reply = await run(cmd, params)
      if (f === 'lost-after') throw markLinkFailure(new Error('link lost after the command ran'), 'lost')
      return reply
    },
  }
  return { link, log, state, jobs }
}

