/**
 * Parse, check, encode and hash scene files without holding the web server's event loop.
 *
 * A scene with pasted pictures runs to megabytes, and a save used to parse, stringify and hash it
 * several times on the server thread (hundreds of ms for 10 MB, every route frozen meanwhile).
 * Now every step is done once, and for a scene over LARGE_SCENE_BYTES in a worker thread:
 *
 *   hash     bytes -> revision
 *   inspect  file bytes -> { revision, texts }          (a read: the scene object never crosses)
 *   decode   file bytes -> { scene, revision }          (an edit, a render: they need the object)
 *   encode   { scene, validate } -> { bytes, revision, texts }
 *   body     PUT body text -> { path, revision, bytes, newRevision, texts }   (the editor's save:
 *            the server thread never parses the scene at all)
 *
 * One implementation: `codecOp` below and the validator (scene.ts validateSceneShape) and text
 * reader (scene-text.ts sceneText) it calls are self-contained functions, and the worker runs
 * them from their own source text. A worker that cannot start or dies falls back to doing the
 * step here (correct, only slower), so a save never fails for want of a thread.
 */

import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { log } from '../../logging/index.js'
import { sceneText } from './scene-text.js'
import { DrawingInputError, validateSceneShape, type DrawingScene } from './scene.js'

/** A scene over this is parsed, encoded and hashed in the worker. */
export const LARGE_SCENE_BYTES = 1024 * 1024
const JOB_DEADLINE_MS = 30_000
const IDLE_MS = 15_000

export type CodecOp = 'hash' | 'inspect' | 'decode' | 'encode' | 'body'

interface CodecLib {
  validate: (raw: unknown, requireVersion: boolean) => DrawingScene
  texts: (scene: { elements: ReadonlyArray<Record<string, unknown>> }) => string[]
  hash: (bytes: string) => string
}

/**
 * One codec step. SELF-CONTAINED (builtins and `lib` only): the worker runs it from its source.
 * Refusals are plain Errors carrying `status`.
 */
export function codecOp(op: string, input: unknown, lib: CodecLib): unknown {
  const fail = (message: string, status: number): never => { throw Object.assign(new Error(message), { status }) }
  const encode = (scene: unknown) => `${JSON.stringify(scene, null, 2)}\n`
  const parseFile = (bytes: string): DrawingScene => {
    let parsed: unknown
    try { parsed = JSON.parse(bytes) } catch { return fail('This file is not a readable drawing (invalid JSON)', 422) }
    try { return lib.validate(parsed, true) } catch (err) { return fail(`This file is not a readable drawing: ${(err as Error).message}`, 422) }
  }
  if (op === 'hash') return lib.hash(input as string)
  if (op === 'inspect') {
    const scene = parseFile(input as string)
    return { revision: lib.hash(input as string), texts: lib.texts(scene) }
  }
  if (op === 'decode') return { scene: parseFile(input as string), revision: lib.hash(input as string) }
  if (op === 'encode') {
    const { scene, validate } = input as { scene: unknown; validate: boolean }
    const checked = validate ? lib.validate(scene, false) : scene as DrawingScene
    const bytes = encode(checked)
    return { bytes, revision: lib.hash(bytes), texts: lib.texts(checked) }
  }
  if (op === 'body') {
    let body: unknown
    try { body = JSON.parse(input as string) } catch { return fail('The request body is not JSON', 400) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('The request body must be an object', 400)
    const { path, revision, scene } = body as Record<string, unknown>
    const checked = lib.validate(scene, false)
    const bytes = encode(checked)
    return { path, revision, bytes, newRevision: lib.hash(bytes), texts: lib.texts(checked) }
  }
  return fail(`unknown codec step ${op}`, 400)
}

const hereLib: CodecLib = {
  validate: validateSceneShape,
  texts: sceneText,
  hash: (bytes) => createHash('sha256').update(bytes).digest('hex'),
}

function workerSource(): string {
  return [
    "const { parentPort } = require('node:worker_threads');",
    "const { createHash } = require('node:crypto');",
    `const validate = (${validateSceneShape.toString()});`,
    `const texts = (${sceneText.toString()});`,
    `const codecOp = (${codecOp.toString()});`,
    "const lib = { validate, texts, hash: (b) => createHash('sha256').update(b).digest('hex') };",
    'parentPort.on("message", ({ id, op, input }) => {',
    '  try { parentPort.postMessage({ id, ok: true, value: codecOp(op, input, lib) }); }',
    '  catch (err) { parentPort.postMessage({ id, ok: false, message: String(err && err.message || err), status: err && err.status }); }',
    '});',
  ].join('\n')
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
let worker: Worker | null = null
let idle: NodeJS.Timeout | null = null
let nextId = 1
const pending = new Map<number, Pending>()
let warned = false

/** Refusals from the worker carry the codec's status; anything else is the worker failing. */
class CodecRefusal extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

function dropWorker(reason: Error): void {
  const w = worker
  worker = null
  if (idle) { clearTimeout(idle); idle = null }
  for (const [id, job] of pending) { clearTimeout(job.timer); job.reject(reason); pending.delete(id) }
  if (w) void w.terminate().catch(() => {})
}

function ensureWorker(): Worker {
  if (worker) return worker
  const w = new Worker(workerSource(), { eval: true, execArgv: [] })
  w.on('message', (reply: { id: number; ok: boolean; value?: unknown; message?: string; status?: number }) => {
    const job = pending.get(reply.id)
    if (!job) return
    pending.delete(reply.id)
    clearTimeout(job.timer)
    if (reply.ok) job.resolve(reply.value)
    else job.reject(new CodecRefusal(reply.message ?? 'refused', reply.status ?? 400))
    if (pending.size === 0 && worker === w) {
      w.unref()
      idle = setTimeout(() => { if (worker === w && pending.size === 0) dropWorker(new Error('idle')) }, IDLE_MS)
      idle.unref?.()
    }
  })
  w.on('error', (err: unknown) => { if (worker === w) dropWorker(err instanceof Error ? err : new Error(String(err))) })
  w.on('exit', () => { if (worker === w) dropWorker(new Error('scene worker exited')) })
  worker = w
  return w
}

function inWorker(op: CodecOp, input: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const w = ensureWorker()
    if (idle) { clearTimeout(idle); idle = null }
    w.ref()
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`scene worker took over ${JOB_DEADLINE_MS} ms`))
      dropWorker(new Error('scene worker deadline'))
    }, JOB_DEADLINE_MS)
    pending.set(id, { resolve, reject, timer })
    w.postMessage({ id, op, input })
  })
}

function refusal(err: unknown): DrawingInputError {
  const status = (err as { status?: number }).status
  return new DrawingInputError((err as Error).message, status === 422 ? 422 : status === 413 ? 413 : 400)
}

/**
 * Run a codec step: here for a small scene, in the worker for a large one (`large`). A refusal
 * is a DrawingInputError; a worker that fails is logged once and the step runs here instead.
 */
export async function runCodec<T>(op: CodecOp, input: unknown, large: boolean): Promise<T> {
  if (large) {
    try {
      return await inWorker(op, input) as T
    } catch (err) {
      if (err instanceof CodecRefusal) throw refusal(err)
      if (!warned) {
        warned = true
        log.memory.warn('drawing scene worker unavailable; doing the step on the server thread', { op, error: (err as Error).message })
      }
    }
  }
  try {
    return codecOp(op, input, hereLib) as T
  } catch (err) {
    if ((err as { status?: number }).status) throw refusal(err)
    throw err
  }
}

/** Whether a scene of this many characters is large (UTF-16 length; a byte count is never smaller). */
export function isLargeScene(chars: number): boolean {
  return chars > LARGE_SCENE_BYTES
}

/** For tests: whether the last large step really ran in the worker. */
export function _sceneWorkerRunning(): boolean {
  return worker !== null
}
