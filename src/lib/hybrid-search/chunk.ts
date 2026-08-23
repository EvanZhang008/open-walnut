/**
 * Passage extraction for embedding.
 *
 * Doc-level kinds get ONE passage (title + summary + head of note). Chunked
 * kinds (long transcripts) get seq 0 = title+summary plus one passage per
 * ~1400 chars of note, split on paragraph boundaries: a 50KB transcript whose
 * relevant exchange is 2% of the text embeds that exchange as its own vector
 * instead of drowning it in the mean pool. Rescore takes the max cosine over
 * a doc's seqs, so more chunks can only help a doc, never dilute it.
 */

export const CHUNK_TARGET_CHARS = 1400;
/** Hard cap per doc — a whale transcript must not own the vector table. */
export const MAX_CHUNKS_PER_DOC = 40;

export interface PassageSource {
  title: string;
  summary?: string;
  note?: string;
}

function head(doc: PassageSource): string {
  return [doc.title, doc.summary].filter((s) => s && s.trim()).join('\n');
}

export function passagesForDoc(doc: PassageSource, chunked: boolean): string[] {
  const note = doc.note ?? '';
  if (!chunked) {
    const text = [head(doc), note.slice(0, CHUNK_TARGET_CHARS)]
      .filter((s) => s.trim()).join('\n');
    return text.trim() ? [text] : [];
  }

  const chunks: string[] = [];
  let current = '';
  for (const para of note.split(/\n{2,}/)) {
    if (!para.trim()) continue;
    if (current && current.length + para.length + 2 > CHUNK_TARGET_CHARS) {
      chunks.push(current);
      current = '';
    }
    // A single paragraph longer than the target splits hard — transcripts
    // contain unbroken tool-output walls that would otherwise blow the
    // tokenizer's 512 cap.
    if (para.length > CHUNK_TARGET_CHARS) {
      for (let i = 0; i < para.length; i += CHUNK_TARGET_CHARS) {
        chunks.push(para.slice(i, i + CHUNK_TARGET_CHARS));
      }
      continue;
    }
    current = current ? `${current}\n\n${para}` : para;
  }
  if (current) chunks.push(current);

  // Over the cap, keep the TAIL: chunked bodies are chronological transcripts
  // (the serializer already feeds a tail window), so the newest turns are the
  // ones a query is most likely about — capping from the head would embed the
  // oldest text and drop exactly the part that matters.
  const passages: string[] = [];
  const h = head(doc);
  if (h.trim()) passages.push(h);
  const room = MAX_CHUNKS_PER_DOC - passages.length;
  passages.push(...(chunks.length > room ? chunks.slice(-room) : chunks));
  return passages;
}
