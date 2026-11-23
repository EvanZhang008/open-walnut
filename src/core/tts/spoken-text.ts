/**
 * What voice mode reads aloud from a reply, and in which language.
 *
 * A session's reply is written to be READ: markdown, code, tables, file paths.
 * Read aloud as-is, that is a minute of "asterisk asterisk" and "slash Users
 * slash". A voice send asks the session for a short spoken answer first, with any
 * detail below a line holding only `---` (src/core/sessions/voice-reply.ts), so
 * the first rule is to read only what comes before that line. A reply that
 * ignores the shape (a turn the session started on its own) still has to sound
 * right, so the rest turns any reply into plain sentences and stops at about
 * `SPOKEN_BUDGET_SECONDS` of speech, saying the rest is on screen.
 *
 * The server's copy of ios-native/Walnut/Core/SpokenText.swift, so every client
 * (the web, and the phone through POST /api/v1/voice/spoken) reads the same words.
 * Pure and synchronous.
 */

export interface SpokenText {
  /** The sentences to speak. */
  text: string;
  /** BCP-47 tag for the voice ("zh-CN", "en-US", "ja-JP"). */
  language: string;
  /** Something was left out (the part after `---`, or the budget ran out). */
  truncated: boolean;
  /** `text` split into speakable pieces, in order: a client synthesizes the first
   *  while the next ones are fetched, so the voice starts after one short piece. */
  chunks: string[];
  /** Only when `truncated`: the line said after the cut (`restOnScreen`), so a client that
   *  already said the rest of the answer as it streamed can say only this line. */
  rest?: string;
}

/** About how long one answer may take to say. */
export const SPOKEN_BUDGET_SECONDS = 40;

/** Said after a cut (at the `---` rule or by the length budget), in the answer's own language. */
export const REST_ON_SCREEN = 'The rest is on screen.';
/** The same in Chinese: "the details are on screen." */
const REST_ON_SCREEN_ZH = '\u8be6\u60c5\u5728\u5c4f\u5e55\u4e0a\u3002';

export function restOnScreen(language: string): string {
  return language.toLowerCase().startsWith('zh') ? REST_ON_SCREEN_ZH : REST_ON_SCREEN;
}

/** The longest chunk, in estimated seconds of speech, before it is cut at a clause. */
const CHUNK_SECONDS = 8;

/** nil when nothing speakable is left (a reply that was only code or a table). */
/** `language` (BCP-47): the language it is said in, when the caller knows it better than the text shows. */
export function prepareSpokenText(raw: string, budgetSeconds = SPOKEN_BUDGET_SECONDS, language?: string): SpokenText | null {
  const { head, cutAtRule } = spokenPart(raw);
  const plainText = plain(head);
  if (!plainText) return null;
  language ??= languageOf(plainText);
  const { text: capped, cut } = cap(plainText, budgetSeconds);
  // Any cut says the rest is on screen, here and not in the session's words: the phone
  // (ios-native SpokenText) adds its own line at a cut, so a session that said it too
  // would be heard saying it twice there.
  const truncated = cutAtRule || cut;
  if (!truncated) return { text: capped, language, truncated, chunks: chunksOf(capped) };
  const rest = restOnScreen(language);
  const text = `${capped}${language.toLowerCase().startsWith('zh') ? '' : ' '}${rest}`;
  return { text, language, truncated, chunks: chunksOf(text), rest };
}

/**
 * One part of an answer that is still streaming (web/src/voice/stream-reader.ts picks
 * the sentences): cleaned like a reply, but with no length budget and no rest line,
 * since the reader keeps the budget for the whole turn and the rest line is said once,
 * at the end. Null when nothing in it can be said.
 */
export function prepareSpokenPiece(raw: string): SpokenText | null {
  const text = plain(spokenPart(raw).head);
  if (!text) return null;
  return { text, language: languageOf(text), truncated: false, chunks: chunksOf(text) };
}

/** The text before the first line that holds only `---`, when there is any. */
export function spokenPart(raw: string): { head: string; cutAtRule: boolean } {
  const lines = raw.split('\n');
  const rule = lines.findIndex((l) => l.trim() === '---');
  if (rule < 0) return { head: raw, cutAtRule: false };
  const head = lines.slice(0, rule).join('\n');
  // A reply that OPENS with a rule (front matter, a divider) has no head to read:
  // fall back to the whole text rather than to silence.
  if (!head.trim()) return { head: raw, cutAtRule: false };
  const tail = lines.slice(rule + 1).join('\n');
  return { head, cutAtRule: tail.trim() !== '' };
}

/**
 * Plain sentences, one per source line, each ending in punctuation so the voice
 * pauses between list items instead of running them together.
 */
export function plain(text: string): string {
  let s = text;
  // Blocks that have no spoken form at all.
  s = s.replace(/```[\s\S]*?(```|$)/g, '\n');
  s = s.replace(/~~~[\s\S]*?(~~~|$)/g, '\n');
  s = s.replace(/<(svg|style|script)\b[\s\S]*?(<\/\1>|$)/gi, ' ');
  s = s.replace(/<[^>\n]{1,400}>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  // Links keep their words; images and bare URLs go.
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/https?:\/\/\S+/g, '');
  // Inline code keeps its text; the backticks are not words.
  s = s.replace(/`([^`\n]+)`/g, '$1').replace(/`/g, '');

  const out: string[] = [];
  for (const rawLine of s.split('\n')) {
    let line = rawLine.trim();
    if (!line) continue;
    // Table rows and their separators have no spoken form.
    if (line.startsWith('|')) continue;
    if (/^[-=*_\s]{3,}$/.test(line)) continue;
    line = line.replace(/^#{1,6}\s+/, '');
    line = line.replace(/^>\s?/, '');
    line = line.replace(/^([-*+]|\d+[.)])\s+/, '');
    line = line.replace(/^\[[ xX]\]\s+/, '');
    line = line.replace(/\*\*/g, '').replace(/__/g, '').replace(/~~/g, '');
    line = line.replace(/(?<![\w*])\*(\S[^*\n]*?)\*(?![\w*])/g, '$1');
    line = line.replace(/(?<![\w_])_(\S[^_\n]*?)_(?![\w_])/g, '$1');
    line = shortenPaths(line);
    line = line.replace(/\s{2,}/g, ' ').trim();
    if (!line) continue;
    out.push(endSentence(line));
  }
  return out.join(' ');
}

/**
 * `/Users/me/repo/src/Foo.swift` and `src/Foo.swift` are read as `Foo.swift`.
 * Only path-shaped tokens: one that starts at a root (`/`, `~`, `./`) or whose
 * last part has an extension. "and/or" stays as it is.
 */
export function shortenPaths(line: string): string {
  return line.replace(/(?<![\w/])((?:~|\.{1,2})?\/?(?:[\w.@+-]+\/)+[\w.@+-]+)/g, (token) => {
    const rooted = token.startsWith('/') || token.startsWith('~') || token.startsWith('./') || token.startsWith('../');
    const last = token.split('/').filter(Boolean).pop();
    if (!last) return token;
    return rooted || last.includes('.') ? last : token;
  });
}

const FULL_STOP = '\u3002';
// The ideographic full stop, then the full-width exclamation, question and semicolon.
const CJK_SENTENCE_ENDS = new Set(['\u3002', '\uFF01', '\uFF1F', '\uFF1B']);
// Plus the full-width colon and comma.
const SENTENCE_ENDS = new Set([...CJK_SENTENCE_ENDS, '.', '!', '?', ';', '\uFF1A', ':', '\uFF0C', ',']);
// The full-width comma, the ideographic comma and the full-width colon.
const CLAUSE_ENDS = new Set(['\uFF0C', ',', '\u3001', '\uFF1A', ':']);

function endSentence(line: string): string {
  const last = line[line.length - 1];
  if (last && SENTENCE_ENDS.has(last)) return line;
  return line + (containsCJK(line) ? FULL_STOP : '.');
}

/**
 * The voice's language. Chinese wins whenever the reply is substantially
 * Chinese, even with English words mixed in (a Chinese voice reads "PR" and
 * "Swift" fine; an English voice cannot read Chinese at all).
 */
export function languageOf(text: string): string {
  let cjk = 0, kana = 0, letters = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x3040 && c <= 0x30ff) kana++;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) cjk++;
    else if (/\p{L}/u.test(ch)) letters++;
  }
  if (kana > 0 && kana * 5 >= cjk) return 'ja-JP';
  const total = cjk + letters;
  if (cjk >= 2 && total > 0 && cjk / total >= 0.15) return 'zh-CN';
  return 'en-US';
}

/** Seconds a voice takes, roughly: about 4 Chinese characters or 2.5 English words a second. */
export function estimatedSeconds(text: string): number {
  let cjk = 0, words = 0, inWord = false;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff)) { cjk++; inWord = false; }
    else if (/[\p{L}\p{N}]/u.test(ch)) { if (!inWord) words++; inWord = true; }
    else inWord = false;
  }
  return cjk * 0.25 + words * 0.4;
}

/** Whole sentences while they fit; a first sentence that alone is too long is cut at a character. */
export function cap(text: string, budget: number): { text: string; cut: boolean } {
  if (estimatedSeconds(text) <= budget) return { text, cut: false };
  let kept = '';
  for (const sentence of sentences(text)) {
    const candidate = kept + sentence;
    if (estimatedSeconds(candidate) > budget) break;
    kept = candidate;
  }
  if (!kept.trim()) {
    let cut = '';
    for (const ch of text) {
      if (estimatedSeconds(cut + ch) > budget) break;
      cut += ch;
    }
    kept = cut;
  }
  return { text: kept.trim(), cut: true };
}

/** Split after each sentence end, keeping the terminator with its sentence. */
export function sentences(text: string): string[] {
  const ends = new Set([...CJK_SENTENCE_ENDS, '.', '!', '?', ';']);
  const out: string[] = [];
  let current = '';
  for (const ch of text) {
    current += ch;
    if (ends.has(ch)) {
      out.push(current);
      current = '';
    }
  }
  if (current) out.push(current);
  return mergeDecimals(out);
}

/** Put back together a split made inside a number or a dotted name ("v2." + "5 is out"). */
function mergeDecimals(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.endsWith('.') && /\w$/.test(prev.slice(0, -1)) && /^\w/.test(p)) {
      out[out.length - 1] = prev + p;
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * Speakable pieces: one sentence each, a very long sentence cut at a clause
 * (comma) so the first piece is short and the voice starts soon. Short sentences
 * after the first are joined, so a reply is a few requests, not one per clause.
 */
export function chunksOf(text: string): string[] {
  const pieces: string[] = [];
  for (const raw of sentences(text)) {
    const s = raw.trim();
    if (!s) continue;
    if (estimatedSeconds(s) <= CHUNK_SECONDS) { pieces.push(s); continue; }
    let current = '';
    for (const ch of s) {
      current += ch;
      if (CLAUSE_ENDS.has(ch) && estimatedSeconds(current) >= CHUNK_SECONDS / 2) {
        pieces.push(current.trim());
        current = '';
      }
    }
    if (current.trim()) pieces.push(current.trim());
  }
  // The first piece stays alone (it decides when the voice starts); later ones join up to the limit.
  const out: string[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (out.length >= 2 && last !== undefined && estimatedSeconds(last + p) <= CHUNK_SECONDS * 2) {
      out[out.length - 1] = joinPieces(last, p);
    } else {
      out.push(p);
    }
  }
  return out;
}

function joinPieces(a: string, b: string): string {
  return containsCJK(a) ? a + b : `${a} ${b}`;
}

function containsCJK(s: string): boolean {
  return /[\u4e00-\u9fff]/.test(s);
}
