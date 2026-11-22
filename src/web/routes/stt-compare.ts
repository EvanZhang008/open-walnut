/**
 * Voice Accuracy (experimental `stt_compare`): /api/stt/compare. Every route
 * answers 409 { error: 'experimental_off' } while the experiment is off, so
 * nothing is kept, run or uploaded then (what was kept before stays until the
 * pane's Delete comparison data removes it).
 *
 *   GET  /summary?engines=a,b     per engine over the shared takes, and by day
 *   GET  /takes?limit&cursor      takes, newest first, with run states
 *   GET  /takes/:id               one take with each engine's word diff against the reference
 *   GET  /takes/:id/audio         the recording, for the user's own Play button
 *   POST /takes/:id/judge         queue the judge again for this take (202; GET /run follows it)
 *   GET  /engines                 engines and the judge: state, consent, quota
 *   PUT  /settings                { engines: { [id]: { enabled, allow_upload } }, nightly, elevenlabs_api_key }
 *   POST /delete-data             remove the compared takes, the stored key and these settings
 *                                 (also while the experiment is off)
 *   POST /run                     { last?, takeIds?, engines?, force? } queue a comparison
 *   GET  /run                     the runner's progress
 *   POST /import-bench            { dir } bring in the 2026-11-21 benchmark (a folder under the
 *                                 Walnut data folder or the system temp folder)
 */
import { Router, type NextFunction, type Request, type Response } from 'express'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { WALNUT_HOME } from '../../constants.js'
import { getConfig } from '../../core/config-manager.js'
import { elevenLabsStatus } from '../../core/stt/compare/elevenlabs.js'
import { CONSENT_ROWS, COMPARE_ENGINES, JUDGE } from '../../core/stt/compare/engines.js'
import { BenchFormatError, importBench } from '../../core/stt/compare/import-bench.js'
import { judgeAgain, runComparison, runProgress, runStatesOf } from '../../core/stt/compare/runner.js'
import { wordDiff } from '../../core/stt/compare/score.js'
import { compareFlag, compareSection, deleteCompareData, engineEnabled, elevenLabsKey, uploadAllowed, writeCompareSettings } from '../../core/stt/compare/settings.js'
import { compareStore, validTakeId } from '../../core/stt/compare/store.js'
import { scoredEngines, summarize } from '../../core/stt/compare/summary.js'
import { takeAudioPath } from '../../core/stt/compare/takes-source.js'
import type { CompareTake } from '../../core/stt/compare/types.js'
import { audioContentType } from '../../core/stt/voice-archive.js'

export const sttCompareRouter = Router()

sttCompareRouter.use(async (req: Request, res: Response, next: NextFunction) => {
  // Deleting what was kept works with the experiment off too.
  if (await compareFlag.on() || (req.method === 'POST' && req.path === '/delete-data')) { next(); return }
  res.status(409).json({ error: 'experimental_off' })
})

const withRun = (take: CompareTake) => ({ ...take, run: runStatesOf(take.id) ?? {} })
const idParam = (req: Request): string | null => (validTakeId(req.params.id) ? String(req.params.id) : null)

sttCompareRouter.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getConfig()
    const takes = await compareStore.all()
    // Shown by default: the engines switched on now that have a score; an engine switched off
    // never shrinks the shared takes.
    const scored = new Set(scoredEngines(takes))
    const engines = typeof req.query.engines === 'string' && req.query.engines
      ? req.query.engines.split(',').filter((id) => COMPARE_ENGINES.some((e) => e.id === id))
      : COMPARE_ENGINES.filter((e) => engineEnabled(config, e.id) && scored.has(e.id)).map((e) => e.id)
    const judge = await JUDGE.status(config)
    res.json({ ...summarize(takes, engines), judge: { state: judge.state, ...(judge.detail ? { detail: judge.detail } : {}) } })
  } catch (err) { next(err) }
})

sttCompareRouter.get('/takes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Number(req.query.limit ?? 50)
    const cursor = typeof req.query.cursor === 'string' && validTakeId(req.query.cursor) ? req.query.cursor : undefined
    const page = await compareStore.list(Number.isFinite(limit) ? limit : 50, cursor)
    res.json({ takes: page.takes.map(withRun), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), total: await compareStore.count() })
  } catch (err) { next(err) }
})

sttCompareRouter.get('/takes/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = idParam(req)
    const take = id ? await compareStore.get(id) : null
    if (!take) { res.status(404).json({ error: 'not_found' }); return }
    const diffs: Record<string, Awaited<ReturnType<typeof wordDiff>>> = {}
    if (take.reference) {
      for (const [engine, result] of Object.entries(take.results)) {
        if (result.text !== undefined) diffs[engine] = await wordDiff(result.text, take.reference.text)
      }
      if (take.sentText) diffs.sent = await wordDiff(take.sentText, take.reference.text)
    }
    res.json({ ...withRun(take), diffs })
  } catch (err) { next(err) }
})

sttCompareRouter.get('/takes/:id/audio', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = idParam(req)
    const take = id ? await compareStore.get(id) : null
    const found = take ? await takeAudioPath(take.audioRef) : null
    const info = found ? await stat(found.path).catch(() => null) : null
    if (!found || !info) { res.status(404).json({ error: 'not_found' }); return }
    res.set({ 'Content-Type': audioContentType(found.format), 'Content-Length': String(info.size), 'Cache-Control': 'no-store' })
    await pipeline(createReadStream(found.path), res)
  } catch (err) { if (!res.headersSent) next(err) }
})

sttCompareRouter.post('/takes/:id/judge', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = idParam(req)
    if (!id || !(await compareStore.has(id))) { res.status(404).json({ error: 'not_found' }); return }
    // The judge's switch and consent are checked before it queues (and again when its turn comes).
    const { state } = await JUDGE.status(await getConfig())
    if (state === 'off') { res.status(409).json({ error: 'engine_off', engine: JUDGE.id }); return }
    if (state === 'needs-consent') { res.status(409).json({ error: 'needs_consent', engine: JUDGE.id }); return }
    res.status(202).json(await judgeAgain(id))
  } catch (err) { next(err) }
})

async function enginesView() {
  const config = await getConfig()
  const section = compareSection(config)
  const rows = await Promise.all(CONSENT_ROWS.map(async (e) => {
    const { state, detail, fix } = await e.status(config).catch((err: unknown) => ({ state: 'not-installed' as const, detail: String(err), fix: undefined }))
    const quota = e.id === 'elevenlabs-scribe' && engineEnabled(config, e.id) && uploadAllowed(config, e.id) && elevenLabsKey(config)
      ? (await elevenLabsStatus(config).catch(() => null))?.quota
      : undefined
    const { runsOn, sends } = e.place(config)
    const model = e.modelFor?.(config)
    return {
      // `label` names what runs now (the configured engine and model); `name` is the engine's own
      // name, for results made earlier, which are labelled by the model they recorded.
      id: e.id, label: e.labelFor?.(config) ?? e.label, name: e.label, kind: e.kind, runsOn, sends,
      ...(e.after ? { after: e.after } : {}), state, ...(detail ? { detail } : {}), ...(fix ? { fix } : {}), ...(model ? { model } : {}),
      enabled: engineEnabled(config, e.id), allow_upload: uploadAllowed(config, e.id), ...(quota ? { quota } : {}),
    }
  }))
  return { engines: rows, nightly: section.nightly === true, hasElevenLabsKey: !!elevenLabsKey(config) }
}

sttCompareRouter.get('/engines', async (_req: Request, res: Response, next: NextFunction) => {
  try { res.json(await enginesView()) } catch (err) { next(err) }
})

sttCompareRouter.put('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    try {
      await writeCompareSettings(req.body ?? {}, CONSENT_ROWS.map((e) => e.id))
    } catch (err) {
      res.status(400).json({ error: 'bad_request', detail: err instanceof Error ? err.message : String(err) })
      return
    }
    res.json(await enginesView())
  } catch (err) { next(err) }
})

sttCompareRouter.post('/delete-data', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await deleteCompareData()
    res.json(await enginesView())
  } catch (err) { next(err) }
})

sttCompareRouter.post('/run', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 500) : undefined)
  const last = typeof body.last === 'number' && Number.isFinite(body.last) ? body.last : undefined
  res.status(202).json(runComparison({
    ...(last !== undefined ? { last } : {}),
    ...(list(body.takeIds) ? { takeIds: list(body.takeIds)!.filter(validTakeId) } : {}),
    ...(list(body.engines) ? { engines: list(body.engines) } : {}),
    force: body.force === true,
  }))
})

sttCompareRouter.get('/run', (_req: Request, res: Response) => {
  res.json(runProgress())
})

/** The folders a benchmark may be read from: the Walnut data folder and the system temp folders. */
async function benchRoots(): Promise<string[]> {
  const roots = [WALNUT_HOME, tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])]
  return (await Promise.all(roots.map((r) => realpath(r).catch(() => null)))).filter((r): r is string => !!r)
}

/** The folder, resolved, when it is under one of benchRoots; else null. */
export async function benchDirAllowed(dir: string): Promise<string | null> {
  const real = await realpath(dir).catch(() => null)
  if (!real) return null
  return (await benchRoots()).some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep)) ? real : null
}

sttCompareRouter.post('/import-bench', async (req: Request, res: Response, next: NextFunction) => {
  const dir = (req.body as { dir?: unknown } | undefined)?.dir
  if (typeof dir !== 'string' || !isAbsolute(dir)) { res.status(400).json({ error: 'bad_request', detail: 'dir must be an absolute path' }); return }
  try {
    const allowed = await benchDirAllowed(dir)
    if (!allowed) { res.status(400).json({ error: 'bad_request', detail: 'dir must be an existing folder under the Walnut data folder or the system temp folder' }); return }
    res.json(await importBench(allowed))
  } catch (err) {
    // The message names the file, never its content.
    if (err instanceof BenchFormatError) { res.status(400).json({ error: 'bad_request', detail: err.message }); return }
    next(err)
  }
})
