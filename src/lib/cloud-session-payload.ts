/** Large companion send bodies are parsed and encoded off the server event loop. */
import { Worker } from 'node:worker_threads'

export interface DecodedCloudSessionSend {
  host: string
  sessionId: string
  uuid: string
  lostPid?: number
  /** An object encoded by the worker from explicit daemon parameter fields only. */
  paramsJson: string
}

export class InvalidCloudSessionPayloadError extends Error {
  constructor() { super('Invalid session payload'); this.name = 'InvalidCloudSessionPayloadError' }
}

// Static JavaScript: bundled builds need neither a TypeScript loader nor another file.
const WORKER_SOURCE = String.raw`
const { parentPort } = require('node:worker_threads');
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HOST = /^[A-Za-z0-9_.-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
parentPort.on('message', ({ kind, input }) => {
  try {
    if (kind === 'encode') {
      const json = JSON.stringify(input);
      if (typeof json !== 'string') throw new Error('invalid');
      parentPort.postMessage({ ok: true, value: json });
      return;
    }
    const body = JSON.parse(Buffer.from(input).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid');
    const { host, sessionId, message, uuid, markers, stopFence, lostPid } = body;
    if (typeof host !== 'string' || !HOST.test(host) || host === '__local__' || host === '__cloudbox__'
      || typeof sessionId !== 'string' || !ID.test(sessionId)
      || typeof message !== 'string' || !message.trim()
      || typeof uuid !== 'string' || !UUID.test(uuid)
      || !Array.isArray(markers) || markers.length === 0
      || markers.some((row) => !row || typeof row !== 'object' || Array.isArray(row)
        || typeof row.message !== 'string' || typeof row.messageId !== 'string' || !ID.test(row.messageId))
      || (stopFence !== null && typeof stopFence !== 'string')
      || (lostPid !== undefined && (!Number.isSafeInteger(lostPid) || lostPid <= 1))) throw new Error('invalid');
    const paramsJson = JSON.stringify({
      sid: sessionId, message, uuid,
      markers: markers.map(({ message, messageId }) => ({ message, messageId })),
      stopFence, dedupe: true, ...(lostPid !== undefined ? { lostPid } : {}),
    });
    parentPort.postMessage({ ok: true, value: { host, sessionId, uuid, paramsJson, ...(lostPid !== undefined ? { lostPid } : {}) } });
  } catch {
    parentPort.postMessage({ ok: false });
  }
});
`

const MAX_WORKERS = 2
const MAX_QUEUED_JOBS = 8
const JOB_DEADLINE_MS = 10_000
const IDLE_MS = 15_000
interface Job {
  kind: 'encode' | 'decode'
  input: unknown
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  slot?: Slot
}
interface Slot {
  worker: Worker
  job: Job | null
  retiring: boolean
  idle?: NodeJS.Timeout
}
const slots = new Set<Slot>()
const queue: Job[] = []

function finish(job: Job, error: Error | null, value?: unknown): void {
  clearTimeout(job.timer)
  if (error) job.reject(error)
  else job.resolve(value)
}

function retire(slot: Slot): void {
  if (slot.retiring) return
  slot.retiring = true
  if (slot.idle) clearTimeout(slot.idle)
  slot.worker.unref()
  // Keep the slot reserved until exit, so timed-out jobs cannot spawn a storm.
  void slot.worker.terminate().catch(() => {})
}

function newSlot(): Slot {
  const worker = new Worker(WORKER_SOURCE, { eval: true, execArgv: [] })
  const slot: Slot = { worker, job: null, retiring: false }
  slots.add(slot)
  worker.on('message', (reply: { ok?: boolean; value?: unknown }) => {
    if (slot.retiring || !slot.job) return
    const job = slot.job
    slot.job = null
    finish(job, reply?.ok === true ? null : new InvalidCloudSessionPayloadError(), reply?.value)
    worker.unref()
    slot.idle = setTimeout(() => retire(slot), IDLE_MS)
    slot.idle.unref?.()
    pump()
  })
  worker.on('error', () => {
    if (slot.job) { finish(slot.job, new Error('Session payload worker failed')); slot.job = null }
    retire(slot)
  })
  worker.on('exit', () => {
    if (slot.idle) clearTimeout(slot.idle)
    if (slot.job) finish(slot.job, new Error('Session payload worker exited'))
    slots.delete(slot)
    pump()
  })
  return slot
}

function pump(): void {
  while (queue.length) {
    let slot = [...slots].find((item) => !item.retiring && !item.job)
    if (!slot && slots.size < MAX_WORKERS) {
      try { slot = newSlot() } catch {
        finish(queue.shift()!, new Error('Session payload worker unavailable'))
        continue
      }
    }
    if (!slot) return
    const job = queue.shift()!
    if (slot.idle) { clearTimeout(slot.idle); slot.idle = undefined }
    slot.job = job
    job.slot = slot
    slot.worker.ref()
    try { slot.worker.postMessage({ kind: job.kind, input: job.input }) } catch {
      slot.job = null
      finish(job, new InvalidCloudSessionPayloadError())
      retire(slot)
    }
  }
}

function run(kind: Job['kind'], input: unknown, timeoutMs = JOB_DEADLINE_MS): Promise<unknown> {
  if (queue.length >= MAX_QUEUED_JOBS) return Promise.reject(new Error('Session payload workers busy'))
  return new Promise((resolve, reject) => {
    const job: Job = { kind, input, resolve, reject, timer: setTimeout(() => {
      const index = queue.indexOf(job)
      if (index >= 0) queue.splice(index, 1)
      if (job.slot?.job === job) { job.slot.job = null; retire(job.slot) }
      finish(job, new Error('Session payload deadline exceeded'))
    }, Math.max(1, Math.min(timeoutMs, JOB_DEADLINE_MS))) }
    queue.push(job)
    pump()
  })
}

/** Decodes, validates and builds the daemon send object without parsing on the loop. */
export async function decodeCloudSessionSend(raw: Buffer, opts: { timeoutMs?: number } = {}): Promise<DecodedCloudSessionSend> {
  if (!Buffer.isBuffer(raw)) throw new InvalidCloudSessionPayloadError()
  return await run('decode', raw, opts.timeoutMs) as DecodedCloudSessionSend
}

/** Client-side encoding uses the same two-worker budget as companion decoding. */
export async function encodeCloudSessionPayload(payload: unknown, opts: { timeoutMs?: number } = {}): Promise<string> {
  return await run('encode', payload, opts.timeoutMs) as string
}

/** Tests only: end owned workers and settle queued jobs, never other processes. */
export async function _closeCloudSessionPayloadWorkersForTesting(): Promise<void> {
  for (const job of queue.splice(0)) finish(job, new Error('Session payload worker closed'))
  const closing = [...slots]
  for (const slot of closing) {
    if (slot.job) { finish(slot.job, new Error('Session payload worker closed')); slot.job = null }
    retire(slot)
  }
  await Promise.all(closing.map((slot) => slot.worker.terminate().catch(() => undefined)))
}
