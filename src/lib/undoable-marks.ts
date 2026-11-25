/**
 * In-memory marks per key ("last input into this task", "last message from A to B") whose newest
 * value is read, where a mark can be taken back: a send stamps its marks before it stores its row,
 * and takes them back when it then stores nothing (lib/send-deadline.ts shut its gate, a guard
 * refused it).
 *
 * Each key keeps its last few marks, newest last, and an undo removes its own mark by identity.
 * So any order of sends and undos reads right: two marks of the same millisecond stay two marks,
 * and with A marks, B marks, A undoes, B undoes, nothing is left (restoring the value seen before
 * B would revive A's refused mark). A key keeps at most `depth` marks: one older than that is
 * forgotten, which only matters when every newer one is taken back.
 */
export interface UndoableMarks<V> {
  /** Mark `key`; the function returned takes this mark back (a no-op once it is gone). */
  set(key: string, value: V): () => void
  /** The newest mark of `key` still standing. */
  get(key: string): V | undefined
  clear(): void
}

export function undoableMarks<V>(maxKeys: number, depth = 8): UndoableMarks<V> {
  const marks = new Map<string, Array<{ value: V }>>()
  return {
    set(key, value) {
      const mark = { value }
      const list = marks.get(key) ?? []
      list.push(mark)
      if (list.length > depth) list.shift()
      // Insertion order is age: the key just marked moves to the end, the oldest keys go past the cap.
      marks.delete(key)
      marks.set(key, list)
      while (marks.size > maxKeys) marks.delete(marks.keys().next().value!)
      return () => {
        const now = marks.get(key)
        const at = now ? now.indexOf(mark) : -1
        if (!now || at < 0) return
        now.splice(at, 1)
        if (now.length === 0) marks.delete(key)
      }
    },
    get(key) {
      const list = marks.get(key)
      return list?.[list.length - 1]?.value
    },
    clear() {
      marks.clear()
    },
  }
}
