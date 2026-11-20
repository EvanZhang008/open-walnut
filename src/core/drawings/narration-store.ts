/**
 * A drawing's walkthrough file on disk (narration.ts): `Name.narration.json` beside
 * `Name.excalidraw` in the Notes vault. The Notes tree does not list it (only notes and
 * attachments), it moves with its drawing (a rename, a Notes move: note-moves.ts) and goes when the
 * drawing is deleted (notes-v2.ts).
 *
 * A save replaces one take by its id (a recorder saves the same take again as it grows), under the
 * file's lock, so two tabs recording at once both keep their takes. A file this version cannot
 * read is never overwritten: the save is refused. Takes a newer version wrote are written back
 * as they were.
 */

import fsp from 'node:fs/promises'
import { log } from '../../logging/index.js'
import { withUserFileLock } from '../../utils/user-file-lock.js'
import { cleanScenePath } from './paths.js'
import { cleanTake, NARRATION_LIMITS, NARRATION_VERSION, narrationPathFor, parseNarrationFile, sceneLabels, type NarrationTake } from './narration.js'
import { narrationDetail, narrationOverview, orderedTakes, type DetailQuery } from './narration-align.js'
import { isLargeScene, runCodec } from './scene-codec.js'
import { DrawingInputError, type DrawingScene } from './scene.js'
import { fileIdentity, moveBesideScene, readOrNull, readSceneFile, replaceAtomically, resolveVaultFile } from './vault-files.js'

/** A file's JSON, parsed off the event loop when it is large; null when it is not JSON. */
async function rawOf(bytes: string): Promise<Record<string, unknown> | null> {
  try {
    return await runCodec<Record<string, unknown>>('object', bytes, isLargeScene(bytes.length))
  } catch {
    return null
  }
}

/** The file is this scene's (the letter case may differ: a case-only rename on a case-insensitive disk). */
function belongsTo(raw: Record<string, unknown> | null, scene: string): boolean {
  return typeof raw?.scene === 'string' && raw.scene.toLowerCase() === scene.toLowerCase()
}

/** The takes of a drawing, empty when it has none (or its file cannot be read, or is another drawing's: logged). */
export async function readNarration(rawScenePath: unknown): Promise<NarrationTake[]> {
  const scene = cleanScenePath(rawScenePath)
  const abs = await resolveVaultFile(narrationPathFor(scene))
  const bytes = await readOrNull(abs)
  if (bytes === null) return []
  const raw = await rawOf(bytes)
  const file = raw ? parseNarrationFile(raw) : null
  if (!file || !belongsTo(raw, scene)) {
    log.memory.warn('drawing walkthrough file is not this drawing\'s, or unreadable', { path: narrationPathFor(scene) })
    return []
  }
  return file.takes
}

/** Compact JSON: a long take is mostly numbers. */
function fileBytes(version: number, scene: string, takes: unknown[]): string {
  return `${JSON.stringify({ version, scene, takes })}\n`
}

/** Save one take of a drawing (replacing the take with its id); answers how many takes it has. */
export async function saveNarrationTake(rawScenePath: unknown, rawTake: unknown): Promise<{ takes: number }> {
  const scene = cleanScenePath(rawScenePath)
  const take = cleanTake(rawTake)
  const sceneAbs = await resolveVaultFile(scene)
  const abs = await resolveVaultFile(narrationPathFor(scene))
  return withUserFileLock(abs, async () => {
    // Checked under the lock: a rename or delete that ran meanwhile took the file with it, and a
    // save now must not make a new one at the old name.
    await resolveVaultFile(narrationPathFor(scene))
    if (!(await fileIdentity(sceneAbs))) throw new DrawingInputError('drawing not found', 404)
    const bytes = await readOrNull(abs)
    let takes: unknown[] = []
    let version = NARRATION_VERSION
    if (bytes !== null) {
      const raw = await rawOf(bytes)
      if (!raw || !Array.isArray(raw.takes) || !parseNarrationFile(raw)) {
        throw new DrawingInputError('the walkthrough file beside this drawing cannot be read, so Walnut does not overwrite it', 409)
      }
      if (belongsTo(raw, scene)) {
        takes = raw.takes
        version = Math.max(version, typeof raw.version === 'number' ? raw.version : version)
      } else if (typeof raw.scene === 'string' && (await fileIdentity(await resolveVaultFile(cleanScenePath(raw.scene)).catch(() => '')).catch(() => null))) {
        throw new DrawingInputError('the walkthrough file beside this drawing belongs to another drawing', 409)
      } else {
        // Left behind by a drawing that is gone: this drawing's walkthroughs start afresh.
        log.memory.warn('drawing walkthrough file of a drawing that is gone replaced', { path: narrationPathFor(scene), was: raw.scene })
      }
    }
    const at = takes.findIndex((t) => !!t && typeof t === 'object' && (t as { id?: unknown }).id === take.id)
    if (at >= 0) takes[at] = take
    else if (takes.length >= NARRATION_LIMITS.takes) throw new DrawingInputError(`a drawing keeps at most ${NARRATION_LIMITS.takes} walkthroughs`, 413)
    else takes.push(take)
    const next = fileBytes(version, scene, takes)
    if (Buffer.byteLength(next) > NARRATION_LIMITS.fileBytes) throw new DrawingInputError('the walkthroughs of this drawing are too large to keep', 413)
    await replaceAtomically(abs, next)
    return { takes: takes.length }
  })
}

/** Takes of two files as one list: by id, the second's copy wins (it is the one moving in). */
function mergeTakes(into: unknown[], from: unknown[]): unknown[] {
  const idOf = (t: unknown) => (t && typeof t === 'object' ? (t as { id?: unknown }).id : undefined)
  const ids = new Set(from.map(idOf))
  return [...into.filter((t) => !ids.has(idOf(t))), ...from]
}

/**
 * A drawing moved (`fromScene` -> `toScene`, the scene already at its new path): its walkthroughs
 * go along when the file is ours. A file already at the new path is merged with it when it is a
 * leftover (not another drawing's), so nothing is left behind at the old name. True when moved.
 */
export async function moveNarration(fromScene: string, toScene: string): Promise<boolean> {
  const from = narrationPathFor(fromScene)
  const to = narrationPathFor(toScene)
  try {
    const fromAbs = await resolveVaultFile(from)
    const toAbs = await resolveVaultFile(to)
    return await withUserFileLock(fromAbs, async () => {
      const bytes = await readOrNull(fromAbs)
      if (bytes === null) return false
      const raw = await rawOf(bytes)
      if (!raw || !Array.isArray(raw.takes) || !belongsTo(raw, fromScene)) return false
      const moved = fileBytes(typeof raw.version === 'number' ? raw.version : NARRATION_VERSION, toScene, raw.takes)
      if (await moveBesideScene({ rel: from, abs: fromAbs }, { rel: to, abs: toAbs }, moved)) return true
      // Something is at the new name already: a leftover of a drawing once there takes these in.
      return withUserFileLock(toAbs, async () => {
        const there = await readOrNull(toAbs)
        const thereRaw = there === null ? null : await rawOf(there)
        if (!thereRaw || !Array.isArray(thereRaw.takes)) return false
        if (typeof thereRaw.scene === 'string' && !belongsTo(thereRaw, toScene) && (await fileIdentity(await resolveVaultFile(cleanScenePath(thereRaw.scene)).catch(() => '')).catch(() => null))) return false
        const takes = belongsTo(thereRaw, toScene) ? mergeTakes(thereRaw.takes, raw.takes as unknown[]) : raw.takes as unknown[]
        await replaceAtomically(toAbs, fileBytes(NARRATION_VERSION, toScene, takes))
        await fsp.unlink(fromAbs)
        return true
      })
    })
  } catch (err) {
    log.memory.warn('drawing walkthroughs did not follow their drawing', { from: fromScene, to: toScene, error: (err as Error).message })
    return false
  }
}

/** A drawing was deleted: its walkthrough file goes too when it is ours. True when removed. */
export async function deleteNarration(sceneRel: string): Promise<boolean> {
  try {
    const abs = await resolveVaultFile(narrationPathFor(sceneRel))
    return await withUserFileLock(abs, async () => {
      const bytes = await readOrNull(abs)
      if (bytes === null || !belongsTo(await rawOf(bytes), sceneRel)) return false
      await fsp.unlink(abs)
      return true
    })
  } catch (err) {
    log.memory.warn('drawing walkthroughs not deleted with their drawing', { path: sceneRel, error: (err as Error).message })
    return false
  }
}

/** The words on each element of a drawing now, by id (404 when the drawing is gone). */
async function labelsOf(scene: string): Promise<Map<string, string>> {
  const { bytes } = await readSceneFile(await resolveVaultFile(scene))
  const { scene: decoded } = await runCodec<{ scene: DrawingScene }>('decode', bytes, isLargeScene(bytes.length))
  return sceneLabels(decoded.elements as unknown as Array<Record<string, unknown>>)
}

function positiveInt(v: unknown, what: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n) || n < 1) throw new DrawingInputError(`${what} must be a whole number from 1`)
  return n
}

function seconds(v: unknown, what: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) throw new DrawingInputError(`${what} must be seconds from the start of the take`)
  return n
}

export interface NarrationAnswer {
  path: string
  takes: number
  /** The coarse view (no take, part, from or to asked): one line per part; '' when none. */
  overview?: string
  /** The fine view of the take, part or span asked for. */
  detail?: string
}

/**
 * What an AI reads about a drawing's walkthroughs: the overview by default, the detail of one
 * part or time span when `take`, `part`, `from` or `to` is given (404 when it does not exist).
 */
export async function narrationAnswer(rawScenePath: unknown, query: Record<string, unknown> = {}): Promise<NarrationAnswer> {
  const scene = cleanScenePath(rawScenePath)
  const takes = await readNarration(scene)
  const q: DetailQuery = {
    take: positiveInt(query.take, 'take'), part: positiveInt(query.part, 'part'),
    from: seconds(query.from, 'from'), to: seconds(query.to, 'to'),
  }
  const overviewAsked = q.take === undefined && q.part === undefined && q.from === undefined && q.to === undefined
  if (takes.length === 0) {
    // Most drawings have none: answered without reading the scene (every read of a drawing asks).
    if (!overviewAsked) throw new DrawingInputError('this drawing has no recorded walkthrough', 404)
    if (!(await fileIdentity(await resolveVaultFile(scene)))) throw new DrawingInputError('Drawing not found', 404)
    return { path: scene, takes: 0, overview: '' }
  }
  const labels = await labelsOf(scene)
  if (overviewAsked) return { path: scene, takes: takes.length, overview: narrationOverview(takes, labels) }
  const detail = narrationDetail(takes, labels, q)
  if (detail === null) {
    const n = q.take ?? takes.length
    throw new DrawingInputError(n > takes.length ? `there are ${takes.length} takes` : `take ${n} has no part ${q.part}`, 404)
  }
  return { path: scene, takes: orderedTakes(takes).length, detail }
}
