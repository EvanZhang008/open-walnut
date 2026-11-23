/**
 * Which recordings produced the text of a draft, so a send names them and the server pairs the
 * box's text with each take exactly (src/core/stt/compare/sent-text.ts). Without it the server
 * could only guess by how alike the texts are: two alike dictations swapped, and a send edited a
 * lot or sent late paired nothing.
 *
 * A box (a composer, keyed by its draft key) notes a take only once the engine's final text for it
 * landed in the box (MicButton onTake). At the send the box claims the takes whose words are still
 * in its own text (takeWordsKept); a take it does not carry is dropped then. The send carries the
 * claimed ids and that box text (`dictationIds`, `dictationText`: the words as the person typed
 * them, before Walnut adds attachment headers, thread lines, quotes or reference tags). A send that
 * was accepted settles the claim; one that failed keeps it for the retry (the claim rides the
 * draft origin). A box that is emptied, or a draft discarded, forgets its takes. Held in memory
 * only, for TAKE_TTL_MS.
 */

export interface DictatedTake { id: string; text: string; at: number; seq: number }

const TAKE_TTL_MS = 2 * 60 * 60_000;
const MAX_PER_BOX = 20;
const MAX_BOXES = 50;
/** A take is still in a text when at least MIN_PAIRS of its neighbouring word pairs are, and at least MIN_SHARE of them. */
const MIN_PAIRS = 3;
const MIN_SHARE = 0.5;

const boxes = new Map<string, DictatedTake[]>();
let seq = 0;

/** English words and digits as one token each, every other letter on its own (as the server's learn-from-sends). */
function tokens(s: string): string[] {
  return [...s.matchAll(/[A-Za-z0-9][A-Za-z0-9'.+-]*[A-Za-z0-9]|[A-Za-z0-9]|[^\s\p{P}\p{S}]/gu)].map((m) => m[0].toLowerCase());
}

/** Each pair of neighbouring tokens. */
function pairs(toks: string[]): string[] {
  return toks.slice(1).map((t, i) => `${toks[i]} ${t}`);
}

const bare = (s: string) => s.replace(/\s+/g, '');

/**
 * Are a take's words still in `sent`? Counted on neighbouring pairs of words (characters in CJK),
 * each once: at least MIN_PAIRS of them and MIN_SHARE of the take's. A take too short to have
 * MIN_PAIRS pairs ("ok", two characters) counts only when its whole text is there, spaces aside.
 */
export function takeWordsKept(take: string, sent: string): boolean {
  const want = pairs(tokens(take));
  if (want.length < MIN_PAIRS) return bare(take).length > 0 && bare(sent).includes(bare(take));
  const have = new Map<string, number>();
  for (const t of pairs(tokens(sent))) have.set(t, (have.get(t) ?? 0) + 1);
  let kept = 0;
  for (const t of want) {
    const n = have.get(t) ?? 0;
    if (n > 0) { kept++; have.set(t, n - 1); }
  }
  return kept >= MIN_PAIRS && kept >= MIN_SHARE * want.length;
}

const live = (box: string, now: number) => (boxes.get(box) ?? []).filter((t) => now - t.at <= TAKE_TTL_MS);

/** The engine's final text for recording `id` landed in `box`. */
export function noteDictatedTake(box: string | null | undefined, id: string, text: string, now = Date.now()): void {
  if (!box || !id || !text.trim()) return;
  const takes = live(box, now).filter((t) => t.id !== id);
  takes.push({ id, text, at: now, seq: ++seq });
  boxes.delete(box);
  boxes.set(box, takes.slice(-MAX_PER_BOX));
  while (boxes.size > MAX_BOXES) boxes.delete(boxes.keys().next().value!);
}

/** The box was emptied or its draft discarded: none of its takes is in it any more. */
export function forgetDictatedTakes(box: string | null | undefined): void {
  if (box) boxes.delete(box);
}

/** What a send carries of its dictations: the recordings and the box's own text. */
export interface SentDictation { readonly ids: readonly string[]; readonly text: string }

export interface DictationClaim {
  /** The recordings whose words the box text still holds, oldest first, with that text; null when none. */
  dictation: SentDictation | null;
  /** The send was accepted: the takes noted up to the claim are done with (a later dictation stays). */
  settle: () => void;
}

/** The takes of `box` that its text being sent (`boxText`, as the person typed it) carries; the others are dropped. */
export function claimDictation(box: string | null | undefined, boxText: string, now = Date.now()): DictationClaim {
  if (!box) return { dictation: null, settle: () => {} };
  const upTo = seq;
  const takes = live(box, now);
  const kept = takes.filter((t) => takeWordsKept(t.text, boxText));
  // Sent without them: their words are gone from this draft.
  if (kept.length < takes.length) boxes.set(box, (boxes.get(box) ?? []).filter((t) => kept.includes(t) || t.seq > upTo));
  return {
    dictation: kept.length ? { ids: kept.map((t) => t.id), text: boxText } : null,
    settle: () => {
      const left = (boxes.get(box) ?? []).filter((t) => t.seq > upTo);
      if (left.length) boxes.set(box, left);
      else boxes.delete(box);
    },
  };
}

/** The RPC fields for a send that carries dictations (nothing for none: an older server ignores them anyway). */
export function dictationField(d: SentDictation | null | undefined): { dictationIds?: string[]; dictationText?: string } {
  return d?.ids.length ? { dictationIds: [...d.ids], dictationText: d.text } : {};
}

/** Test hook. */
export function _resetDictatedTakes(): void {
  boxes.clear();
  seq = 0;
}
