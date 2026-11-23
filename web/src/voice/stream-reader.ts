/**
 * Voice mode reads an answer as it is written: this picks, from one turn's streaming
 * text, the parts that can be said now. Pure (no timers, no browser calls).
 *
 * Text arrives as increments per assistant message (`msgId`). A message's text is
 * released a complete sentence at a time: one ending in a Chinese full stop,
 * exclamation or question mark, in '.', '!' or '?' followed by whitespace, or at a
 * newline. What it releases is raw text; the server cleans it into plain speech
 * (POST /api/v1/voice/spoken with `piece: true`).
 *
 *   - a line holding only `---` ends what is read of that message (the detail below
 *     it stays on screen), and the reader records that it cut, so the rest-on-screen
 *     line is said once at the end; a rule with nothing before it is not a cut (the
 *     server's spokenPart rule);
 *   - fenced code (``` or ~~~) is skipped; an unclosed fence holds everything after it;
 *     a table row (a line starting with `|`) is skipped too;
 *   - a list number ("1. Open the file") and an abbreviation ("Dr.", "e.g.") are not
 *     sentence ends, and a closing quote or bracket goes with the sentence it closes;
 *   - a message's unfinished last sentence is released when the message closes: a
 *     tool call starts, another message begins, or the turn ends;
 *   - a running estimate of spoken seconds stops it at the budget (a cut too);
 *   - `mute()` (the person talked over it) says nothing more of what is open or
 *     comes next, until `resume()` (they sent something): messages after that are read.
 */

export const STREAM_BUDGET_SECONDS = 40;

/** Seconds a voice takes, roughly: about 4 Chinese characters or 2.5 English words a second
 *  (the server's src/core/tts/spoken-text.ts estimatedSeconds). */
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

// The ideographic full stop, then the full-width exclamation and question marks.
const CJK_ENDS = new Set(['\u3002', '\uFF01', '\uFF1F']);
const ASCII_ENDS = new Set(['.', '!', '?']);
// Quotes and brackets that close a sentence: '"', "'", ')', ']', and their full-width forms.
const CLOSERS = new Set(['"', "'", ')', ']', '\u201D', '\u2019', '\u300D', '\u300F', '\uFF09']);
/** Words whose dot is not a sentence end. */
const ABBREVIATIONS = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'sr', 'jr', 'st', 'vs', 'e.g', 'i.e', 'cf', 'approx', 'fig']);

/** The dot at the end of `seg` belongs to an abbreviation. */
function abbreviation(seg: string): boolean {
  const word = seg.slice(seg.search(/\S+$/)).replace(/^[("'\[]+/, '').toLowerCase();
  return ABBREVIATIONS.has(word);
}
const FENCES = ['```', '~~~'];

interface Message {
  text: string;
  /** Next index of `text` to look at. */
  pos: number;
  /** The sentence being built (fenced text left out). */
  seg: string;
  lineStart: number;
  fence: string | null;
  /** Index just after the `---` line that ended its spoken part, or -1. */
  ruleEnd: number;
  muted: boolean;
}

export type ResultOutcome = 'read' | 'muted' | 'unseen';

export interface ResultMatch {
  outcome: ResultOutcome;
  /** The message the result is (its order in the turn), or -1. */
  index: number;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const speakable = (s: string) => /[\p{L}\p{N}]/u.test(s);

export class StreamReader {
  private readonly messages: Message[] = [];
  private readonly open = new Map<string, Message>();
  private seconds = 0;
  private overBudget = false;
  private muteNew = false;
  /** Bumps on every mute: a piece released before it is dropped wherever it still waits. */
  muteCount = 0;
  /** Segments released this turn. */
  released = 0;
  /** How many messages had begun when a message was sent during this turn, or -1. */
  sendMark = -1;

  constructor(private readonly budgetSeconds = STREAM_BUDGET_SECONDS) {}

  /** `delta` of message `msgId` arrived; returns the segments that can be said now. */
  feed(msgId: string | undefined, delta: string): string[] {
    const key = msgId ?? '';
    const out: string[] = [];
    let m = this.open.get(key);
    if (!m) {
      // Another message begins: the ones still open are finished.
      out.push(...this.closeOpen());
      m = { text: '', pos: 0, seg: '', lineStart: 0, fence: null, ruleEnd: -1, muted: this.muteNew };
      this.messages.push(m);
      this.open.set(key, m);
    }
    m.text += delta;
    out.push(...this.scan(m, false));
    return out;
  }

  /** The open messages are finished (a tool call starts): their last sentences go too. */
  closeOpen(): string[] {
    const out: string[] = [];
    for (const m of this.open.values()) out.push(...this.scan(m, true));
    this.open.clear();
    return out;
  }

  /** The turn ended. */
  finish(): string[] {
    return this.closeOpen();
  }

  mute(): void {
    this.muteCount++;
    this.muteNew = true;
    for (const m of this.messages) m.muted = true;
  }

  /** Messages that begin from now on are read again (what is open stays muted). */
  resume(): void {
    this.muteNew = false;
  }

  /** The person sent a message while this turn runs: what began before it answers the older one. */
  markSend(): void {
    if (this.sendMark < 0) this.sendMark = this.messages.length;
  }

  /** No text of this turn has arrived yet. */
  get empty(): boolean {
    return this.messages.length === 0;
  }

  /** Something was left out: a `---` rule with detail after it, or the budget ran out. */
  get cut(): boolean {
    return this.overBudget || this.messages.some((m) => !m.muted && m.ruleEnd >= 0 && m.text.slice(m.ruleEnd).trim() !== '');
  }

  /** Every message's text, for the server to find the rest-on-screen line in. */
  allText(): string {
    return this.messages.map((m) => m.text).join('\n\n');
  }

  /** Whether the turn's final text (`result`) was read as it streamed, muted, or never seen. */
  outcome(result: string): ResultOutcome {
    return this.match(result).outcome;
  }

  /** The same, with the message it matched. */
  match(result: string): ResultMatch {
    const want = norm(result);
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (norm(m.text) === want) return { outcome: m.muted ? 'muted' : 'read', index: i };
    }
    return { outcome: 'unseen', index: -1 };
  }

  private scan(m: Message, final: boolean): string[] {
    const out: string[] = [];
    const t = m.text;
    let i = m.pos;
    let seg = m.seg;
    const push = () => {
      const s = seg.trim();
      seg = '';
      // A table row has no spoken form.
      if (!speakable(s) || m.muted || this.overBudget || t.slice(m.lineStart).trimStart().startsWith('|')) return;
      const secs = estimatedSeconds(s);
      if (this.seconds > 0 && this.seconds + secs > this.budgetSeconds) { this.overBudget = true; return; }
      this.seconds += secs;
      this.released++;
      out.push(s);
    };
    while (i < t.length && m.ruleEnd < 0) {
      if (m.fence) {
        const close = t.indexOf(m.fence, i);
        if (close < 0) {
          // A closing fence may be split across increments: look again from its possible start.
          i = final ? t.length : Math.max(i, t.length - (m.fence.length - 1));
          break;
        }
        i = close + m.fence.length;
        m.fence = null;
        m.lineStart = i;
        continue;
      }
      const c = t[i]!;
      if (c === '`' || c === '~') {
        const mark = FENCES.find((f) => f[0] === c)!;
        if (t.startsWith(mark, i)) { push(); m.fence = mark; i += mark.length; continue; }
        // One or two marks at the end: a fence may be starting.
        if (!final && mark.startsWith(t.slice(i))) break;
      }
      if (c === '\n') {
        if (t.slice(m.lineStart, i).trim() === '---' && t.slice(0, m.lineStart).trim() !== '') {
          seg = '';
          m.ruleEnd = i + 1;
          break;
        }
        push();
        i++;
        m.lineStart = i;
        continue;
      }
      if (CJK_ENDS.has(c)) { seg += c; i++; push(); continue; }
      if (ASCII_ENDS.has(c)) {
        let j = i + 1;
        while (j < t.length && CLOSERS.has(t[j]!)) j++;
        // "2.5", "app.ts": the end shows only with the next character after any closers.
        if (j >= t.length && !final) break;
        const ends = (j >= t.length || /\s/.test(t[j]!))
          && !(c === '.' && (abbreviation(seg) || /^\s*\d+$/.test(t.slice(m.lineStart, i))));
        seg += t.slice(i, j);
        i = j;
        if (ends) push();
        continue;
      }
      seg += c;
      i++;
    }
    m.pos = i;
    m.seg = seg;
    if (final && m.ruleEnd < 0) {
      // The last line may be the rule itself (nothing after it: not a cut).
      if (!m.fence && t.slice(m.lineStart).trim() === '---' && t.slice(0, m.lineStart).trim() !== '') m.ruleEnd = t.length;
      else push();
      m.seg = '';
      m.pos = t.length;
    }
    return out;
  }
}
