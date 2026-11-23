/**
 * The pictures a person's turn on a letter carries on the cloud companion (inline from the phone,
 * or uploaded here): kept in this box's images folder with their bytes for the journal
 * (human-inbox-replica.ts replicaLetterTurn).
 */

/** The request carries pictures (uploads named here, or inline). */
export function hasPictures(b: Record<string, unknown>): boolean {
  return (Array.isArray(b.images) && b.images.length > 0) || (Array.isArray(b.imageRefs) && b.imageRefs.length > 0)
}

/** The route's time kept for saving and journaling a turn's pictures after a relay that hung. */
export const PICTURE_SAVE_MARGIN_MS = 5_000

/**
 * How many different pictures the request sends (the store keeps at most MAX_ANSWER_PICTURES,
 * and one picture sent twice may be saved once).
 */
function pictureCount(b: Record<string, unknown>, max: number): number {
  const list: unknown[] = Array.isArray(b.imageRefs) && b.imageRefs.length > 0 ? b.imageRefs : Array.isArray(b.images) ? b.images : []
  const key = (p: unknown): string => JSON.stringify(p && typeof p === 'object' ? [(p as Record<string, unknown>).filename, (p as Record<string, unknown>).data, (p as Record<string, unknown>).mediaType] : p)
  return Math.min(new Set(list.slice(0, max).map(key)).size, max)
}

/**
 * The request's pictures saved in this box's images folder, with their bytes, in order; null
 * when any one is not kept (a bad picture, an upload not here, a full disk).
 */
export async function keptPictures(b: Record<string, unknown>): Promise<Array<{ name: string; bytes: Buffer }> | null> {
  const { saveAnswerPictures, MAX_ANSWER_PICTURES } = await import('../../core/answer-pictures.js')
  // A picture that cannot be kept throws ImageAttachError (answer-pictures.ts): it goes up to the
  // route, which says which picture and why, and nothing is held.
  const names = await saveAnswerPictures(b)
  if (names.length === 0 || names.length < pictureCount(b, MAX_ANSWER_PICTURES)) return null
  const { IMAGES_DIR } = await import('../../constants.js')
  const fsp = await import('node:fs/promises')
  const path = await import('node:path')
  try {
    return await Promise.all(names.map(async (name) => ({ name, bytes: await fsp.readFile(path.join(IMAGES_DIR, name)) })))
  } catch {
    return null
  }
}

/** Pictures saved here for a turn the journal then refused (the inline ones: an upload stays). */
export async function dropPictures(names: string[]): Promise<void> {
  const { IMAGES_DIR } = await import('../../constants.js')
  const fsp = await import('node:fs/promises')
  const path = await import('node:path')
  await Promise.all(names.map((n) => fsp.rm(path.join(IMAGES_DIR, n), { force: true }).catch(() => {})))
}
