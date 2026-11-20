/**
 * Keeping a drawing's companion note (companion.ts) in step with its scene, on disk.
 *
 *  - A save hands over what it just wrote (revision, texts, the file's identity): the companion
 *    is never built by reading and parsing the scene again. Under the companion's note lock it
 *    first checks that the scene file is still the one that save wrote; if another save landed
 *    since, it does nothing, because that later save brings the companion up to date itself.
 *  - A save may CREATE the companion; a read never does (`create: false`): it only repairs one
 *    that exists and is ours.
 *  - Notes moving or deleting a scene takes its companion along, under the same note lock, and
 *    only when the companion is ours (isOwnCompanion).
 */

import fsp from 'node:fs/promises'
import { log } from '../../logging/index.js'
import { computeContentHash } from '../../utils/file-ops.js'
import { withUserFileLock } from '../../utils/user-file-lock.js'
import { bus, EventNames } from '../event-bus.js'
import { invalidateNotesTree } from '../notes-tree.js'
import { withNoteId } from '../parse-frontmatter.js'
import { companionPathFor, isOwnCompanion, mergeCompanion, retargetCompanion } from './companion.js'
import { titleOfScenePath } from './paths.js'
import { isLargeScene, runCodec } from './scene-codec.js'
import { DrawingInputError } from './scene.js'
import {
  createExclusively, fileIdentity, moveBesideScene, readOrNull, readSceneFile, replaceAtomically, resolveVaultFile, sameIdentity, type FileIdentity,
} from './vault-files.js'

/** What a save or a read knows about the scene file it handled. */
export interface SceneFacts {
  revision: string
  texts: string[]
  identity: FileIdentity | null
}

/** Scenes whose companion is known current: scene abs path -> revision and the companion's mtime. */
const synced = new Map<string, { revision: string; mdMtimeMs: number }>()

async function mtimeOf(abs: string): Promise<number | null> {
  try {
    return (await fsp.lstat(abs)).mtimeMs
  } catch {
    return null
  }
}

/** Whether the companion of this scene is known to match `revision` (no file read). */
export async function companionKnownCurrent(sceneAbs: string, mdRel: string, revision: string): Promise<boolean> {
  const hit = synced.get(sceneAbs)
  if (!hit || hit.revision !== revision) return false
  const mdAbs = await resolveVaultFile(mdRel).catch(() => null)
  return !!mdAbs && hit.mdMtimeMs === await mtimeOf(mdAbs)
}

function announce(mdRel: string, content: string, created: boolean): void {
  if (created) {
    invalidateNotesTree()
    bus.emit(EventNames.NOTES_TREE_CHANGED, { path: mdRel }, ['web-ui'])
  }
  // The shared note-write contract: `notes/{path without .md}` (notes-v2.ts, api-v1.ts).
  bus.emit(EventNames.NOTES_UPDATED, { source: `notes/${mdRel.replace(/\.md$/, '')}`, contentHash: computeContentHash(content) }, ['web-ui'])
}

/**
 * Bring a scene's companion up to date with `facts`. Never throws: a failure is returned as the
 * warning the answer carries (`indexWarning`), and the next read of the drawing tries again.
 */
export async function syncDrawingCompanion(sceneRel: string, facts: SceneFacts, opts: { create: boolean }): Promise<string | undefined> {
  const mdRel = companionPathFor(sceneRel)
  let sceneAbs = ''
  try {
    sceneAbs = await resolveVaultFile(sceneRel)
    const mdAbs = await resolveVaultFile(mdRel).catch((err) => {
      if (err instanceof DrawingInputError) throw new Error(`${mdRel} is a link, so Walnut left it unchanged`)
      throw err
    })
    if (await companionKnownCurrent(sceneAbs, mdRel, facts.revision)) return undefined

    const outcome = await withUserFileLock(mdAbs, async () => {
      // A later save replaced the scene since: that save brings the companion up to date.
      if (!sameIdentity(await fileIdentity(sceneAbs), facts.identity)) return { skipped: true as const }
      const current = await readOrNull(mdAbs)
      if (current === null && !opts.create) return { skipped: true as const }
      const merge = mergeCompanion(current, { scenePath: sceneRel, title: titleOfScenePath(sceneRel), revision: facts.revision, texts: facts.texts })
      if (merge.kind === 'foreign') return { warning: merge.reason }
      if (merge.kind === 'unchanged') return {}
      const { content } = withNoteId(merge.content, current)
      if (merge.created) {
        if (!(await createExclusively(mdAbs, content))) throw new Error(`${mdRel} appeared while Walnut was writing it; the next save tries again`)
      } else {
        await replaceAtomically(mdAbs, content)
      }
      return { content, created: merge.created }
    })
    if ('skipped' in outcome) return undefined
    if (outcome.warning) {
      synced.delete(sceneAbs)
      return outcome.warning
    }
    synced.set(sceneAbs, { revision: facts.revision, mdMtimeMs: (await mtimeOf(mdAbs)) ?? -1 })
    if (outcome.content !== undefined) announce(mdRel, outcome.content, outcome.created === true)
    return undefined
  } catch (err) {
    if (sceneAbs) synced.delete(sceneAbs)
    const message = err instanceof Error ? err.message : String(err)
    log.memory.warn('drawing companion not updated', { path: sceneRel, error: message })
    return `The drawing is saved, but its Notes entry (${mdRel}) could not be updated: ${message}. Opening the drawing again retries.`
  }
}

/** Whether the companion path of `sceneRel` holds a note (or link) that is not ours. */
export async function companionPathForeign(sceneRel: string): Promise<boolean> {
  try {
    const abs = await resolveVaultFile(companionPathFor(sceneRel))
    const current = await readOrNull(abs)
    return current !== null && !isOwnCompanion(current, sceneRel)
  } catch {
    return true
  }
}

/**
 * Whether a renamed scene may not go to `sceneRel` because of its companion path: anything is there
 * (ours, someone else's, a leftover whose scene was deleted outside Walnut, a link), so the
 * companion could not follow and would be left behind. `ownSceneRel`'s own companion does not
 * count (a change of letter case only: on a case-insensitive disk both paths are that one file).
 */
export async function companionPathTaken(sceneRel: string, ownSceneRel?: string): Promise<boolean> {
  try {
    const abs = await resolveVaultFile(companionPathFor(sceneRel))
    const there = await fsp.lstat(abs).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (!there) return false
    if (!ownSceneRel) return true
    const mine = await fileIdentity(await resolveVaultFile(companionPathFor(ownSceneRel)))
    return !(mine && mine.ino === there.ino)
  } catch {
    return true
  }
}

/** Facts about a scene file on disk, for a companion refresh outside a save. */
async function factsOnDisk(sceneRel: string): Promise<SceneFacts> {
  const { bytes, identity } = await readSceneFile(await resolveVaultFile(sceneRel))
  const { revision, texts } = await runCodec<{ revision: string; texts: string[] }>('inspect', bytes, isLargeScene(bytes.length))
  return { revision, texts, identity }
}

/**
 * Notes moved a scene (`fromScene` -> `toScene`, the scene file is already at its new path): its
 * companion goes along when it is ours and nothing is at the new companion path, with its
 * `drawing:` and block pointed at the new place. Returns the companion's old and new paths for the
 * caller's index bookkeeping, or null when nothing moved.
 */
export async function moveDrawingCompanion(fromScene: string, toScene: string): Promise<{ from: string; to: string } | null> {
  const from = companionPathFor(fromScene)
  const to = companionPathFor(toScene)
  let moved = false
  try {
    const fromAbs = await resolveVaultFile(from)
    const toAbs = await resolveVaultFile(to)
    moved = await withUserFileLock(fromAbs, async () => {
      const current = await readOrNull(fromAbs)
      if (current === null || !isOwnCompanion(current, fromScene)) return false
      return moveBesideScene({ rel: from, abs: fromAbs }, { rel: to, abs: toAbs }, retargetCompanion(current, toScene))
    })
    synced.delete(await resolveVaultFile(fromScene))
  } catch (err) {
    log.memory.warn('drawing companion did not follow its drawing', { from: fromScene, to: toScene, error: (err as Error).message })
    return null
  }
  if (!moved) return null
  invalidateNotesTree()
  // The block names the old path and link: bring it to the new place (a read-free refresh).
  try {
    await syncDrawingCompanion(toScene, await factsOnDisk(toScene), { create: false })
  } catch { /* the next save or read repairs it */ }
  return { from, to }
}

/**
 * Notes deleted a scene: its companion goes too when it is ours, under the companion's note lock
 * (`remove` is the Notes delete, with its index and bookmark bookkeeping). Returns the removed
 * companion's path, or null.
 */
export async function deleteDrawingCompanion(sceneRel: string, remove: (abs: string) => Promise<unknown>): Promise<string | null> {
  const mdRel = companionPathFor(sceneRel)
  try {
    const mdAbs = await resolveVaultFile(mdRel)
    const removed = await withUserFileLock(mdAbs, async () => {
      const current = await readOrNull(mdAbs)
      if (current === null || !isOwnCompanion(current, sceneRel)) return false
      await remove(mdAbs)
      return true
    })
    return removed ? mdRel : null
  } catch (err) {
    log.memory.warn('drawing companion not deleted with its drawing', { path: sceneRel, error: (err as Error).message })
    return null
  }
}

/** For tests: forget what is known current. */
export function resetCompanionCache(): void {
  synced.clear()
}
