/**
 * memory-edits.ts: the change a MEMORY.md / USER.md save asks for, as pure functions shared by
 * the primary's write (web/routes/memory.ts) and the companion's journal save
 * (replica/companion-copy-routes.ts).
 *
 * A save is the whole new text (`content`) or exact-string `edits` on the stored text, the way
 * brief_write and board_edit take them. Edits exist because the whole-file replace forced a
 * read-modify-write script on every agent that changed one line, and one such script misread
 * the read's result, never called the write, and took the read's output for "saved"
 * (2026-11-06, USER.md). An edit whose old text is not there refuses the whole save.
 */

/** One exact-string change to a memory doc, as brief_write and board_edit take them. */
export interface MemoryEdit { old: string; new: string }

/**
 * A memory change that cannot be made as asked: an edit whose `old` is not in the file (or is
 * there twice), or a body with neither `content` nor `edits`. Nothing is written.
 */
export class MemoryEditError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly index?: number) {
    super(message)
    this.name = 'MemoryEditError'
  }
}

/** Apply exact-string edits in order, each `old` exactly once, all or none. Pure. */
export function applyMemoryEdits(text: string, edits: readonly MemoryEdit[], fileName: string): string {
  if (!Array.isArray(edits) || !edits.length) throw new MemoryEditError(400, 'bad_request', '`edits` must be a non-empty array of { old, new }')
  let out = text
  edits.forEach((e, index) => {
    if (!e || typeof e.old !== 'string' || typeof e.new !== 'string' || !e.old) {
      throw new MemoryEditError(400, 'bad_request', `edits[${index}] must be { old: non-empty string, new: string }`, index)
    }
    const first = out.indexOf(e.old)
    if (first === -1) {
      throw new MemoryEditError(409, 'memory_edit_not_found', `edits[${index}].old does not occur in ${fileName}, so nothing was written: read it again (memory_read) and copy the exact text`, index)
    }
    if (out.indexOf(e.old, first + 1) !== -1) {
      throw new MemoryEditError(409, 'memory_edit_not_unique', `edits[${index}].old occurs more than once in ${fileName}, so nothing was written: include more of the line`, index)
    }
    out = out.slice(0, first) + e.new + out.slice(first + e.old.length)
  })
  return out
}

/**
 * The new text a PUT body asks for: `content` (the whole doc) or `edits` on the stored one,
 * never both. Throws MemoryEditError for a body that asks for neither.
 */
export function memoryChangeOf(body: Record<string, unknown>): string | { edits: MemoryEdit[] } {
  const hasContent = body.content !== undefined
  const hasEdits = body.edits !== undefined
  if (hasContent && hasEdits) throw new MemoryEditError(400, 'bad_request', 'pass content (the whole document) or edits, not both')
  if (hasEdits) {
    if (!Array.isArray(body.edits)) throw new MemoryEditError(400, 'bad_request', '`edits` must be a non-empty array of { old, new }')
    return { edits: body.edits as MemoryEdit[] }
  }
  if (typeof body.content !== 'string') throw new MemoryEditError(400, 'bad_request', 'content (string) or edits ([{ old, new }]) is required')
  return body.content
}
