/**
 * The custom speech vocabulary's shared pieces (config/share/stt-vocab.txt, one word
 * per line, `#` comments): the one rule that turns the file into words, and the
 * write listeners the Mac's `stt-vocab` copy kind rounds on
 * (replication/kinds/stt-vocab.ts). Its own module so the copy kind and the routes
 * reach it without loading the engines (core/stt/index.ts).
 */

/** The file's words: each line trimmed, blank lines and `#` comments left out. */
export function vocabWords(raw: string): string[] {
  return raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
}

const writeListeners = new Set<() => void>()

/** Called after this process wrote the vocabulary file (a hand edit waits for the copy sweep). Returns the stop. */
export function onSttVocabWritten(cb: () => void): () => void {
  writeListeners.add(cb)
  return () => { writeListeners.delete(cb) }
}

/** The vocabulary file was written by this process. */
export function noteSttVocabWritten(): void {
  for (const cb of writeListeners) {
    try { cb() } catch { /* one listener never stops the others */ }
  }
}
