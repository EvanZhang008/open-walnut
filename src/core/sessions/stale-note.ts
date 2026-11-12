/**
 * A task's note that still reads as unfinished when its own session completes it, and a question
 * for the user written where the user never reads it (2026-11-11, a VP's daily reflection,
 * "stuck 2" and "stuck 3": four COMPLETE tasks in two days still said "[WAIT] plugin release",
 * "[WIP] review is running", "[WAIT] next rule", and one buried a real "You: decide" in its note
 * and in a reply to another task, so neither its lead nor the user saw it).
 *
 * Two reads, both deterministic (labels and a short phrase list, never a model's guess):
 *
 *   - openNoteLines: the lines of a note that say work is still open: a Progress line labelled
 *     [TODO] / [WIP] / [WAIT] / [BLOCKED], or a sentence of the Executive Summary (or an unlabelled
 *     Progress line) with a phrase like "waiting for", "pending", "is running", "Next:". The
 *     completion gate (owed-to-user.ts admitSessionClose) refuses a session's close of its own
 *     task once while these remain, naming them.
 *   - userQuestionIn: a line that asks someone to decide ("you decide", "your call", "do you want
 *     me to", and the same in Chinese). A task's message carrying one gets a line back telling the
 *     sender to make it its own ask (ops/work.ts task_send); a note line carrying one is named at
 *     completion with the same advice.
 *
 * Quoted lines ("> ...") and code fences are never read: they hold someone else's words or output.
 * Guard test: tests/core/stale-note.test.ts (a corpus of open and closed lines, the four cases).
 */
import { parseNoteSections } from '../session-hooks/builtins.js';

export type OpenLineKind = 'open' | 'stale' | 'question';
export interface OpenNoteLine { kind: OpenLineKind; text: string }

/** A Progress line's label that says the work item is not finished. */
const OPEN_LABEL_RE = /^\s*(?:[-*+]|\d+[.)])?\s*[*_]{0,2}\[\s*(TODO|WIP|WAIT|WAITING|BLOCKED|PENDING|IN[ _-]?PROGRESS)\s*\][*_]{0,2}\s*:?\s*(.*)$/i;
/** Any bracketed label at the start of a line (a finished one included). */
const ANY_LABEL_RE = /^\s*(?:[-*+]|\d+[.)])?\s*[*_]{0,2}\[\s*[A-Z][A-Z _-]{1,15}\s*\]/i;

/** Phrases that say something is still under way or still to do. */
const STALE_RES: readonly RegExp[] = [
  /\bawaiting\b/i,
  /\bwaiting (?:for|on)\b/i,
  // Not the first half of a compound ("the pending-selection bug").
  /\bpending\b(?!-)/i,
  // Lower case only: "In Progress" is mostly the name of a phase ("leaves the task stuck In Progress").
  /\bin progress\b|^In progress\b/,
  /\bunder review\b/i,
  /\b(?:is|are) (?:still )?(?:running|queued)\b/i,
  /\bnot yet (?:landed|pushed|deployed|merged|committed|released|published|verified|tested|done|run|reviewed|fixed|built|live|installed)\b/i,
  /\bstill (?:to do|needs? to|has to|have to|to be)\b/i,
  /\bleft to do\b/i,
  /(?:^|[\s(])(?:next(?: steps?)?|remaining|todo|to do):(?!\s*(?:none|nothing|no|n\/a)\b)/i,
];

/**
 * Words just before a phrase that make it negated or past. A negation may stand one word off ("no
 * longer waiting", "nothing still pending"); a past or finished word must be right before it ("was
 * pending", "after waiting"), so "The PR was posted, awaiting review" still reads as open.
 */
const NEGATED_BEFORE_RE = /(?:\b(?:no longer|nothing|no|not|none|never|0|zero|without|no more)\s+(?:\S+\s+)?|\b(?:was|were|had been|after|stopped|ended|finished|done)\s+)$/i;


/** Phrases that ask someone to decide or say yes (English, then Chinese as escapes). */
const QUESTION_RES: readonly RegExp[] = [
  /\byou decide\b/i,
  /\byou\s*[:,]\s*(?:decide|choose|pick|confirm|approve)\b/i,
  /\byou(?:'ll| will)? need to decide\b/i,
  // Not one already made: "per your call", "applied your decision".
  /(?<!\b(?:per|following|followed|applied|as|with|made|took|on|by|after|did)\s+)\byour (?:call|decision|pick|choice)\b/i,
  /\bup to you\b/i,
  /\b(?:do|would) you (?:want|like) me to\b/i,
  /^\s*shall i\b/i,
  /\bfor (?:the user|you) to (?:decide|choose|pick|confirm|approve)\b/i,
  /\b(?:needs?|waiting for|awaiting|wants?) (?:your|the user's) (?:decision|answer|approval|go-ahead|ok|okay|input|call|pick|choice|confirmation)\b/i,
  // "you (come) decide", "up to you to decide", "please (you) decide"
  /\u4f60\u6765?\u51b3\u5b9a|\u7531\u4f60(?:\u6765)?(?:\u51b3\u5b9a|\u5b9a)|\u8bf7\u4f60?\u51b3\u5b9a/u,
  // "want it or not" (yao bu yao)
  /\u8981\u4e0d\u8981/u,
  // "do you need me to", "do you want me to"
  /\u662f\u5426\u9700\u8981\u6211|\u4f60\u60f3\u8981?\u6211|\u4f60\u8981\u6211/u,
  // "needs you to decide / confirm / sign off", "waits for you to decide / confirm"
  /(?:\u9700\u8981|\u7b49)\u4f60(?:\u6765)?(?:\u51b3\u5b9a|\u786e\u8ba4|\u62cd\u677f)/u,
];

/**
 * A note line written for the user to act on ("You: approve the release", "The user: pick a host").
 * Notes only: in a message, "You, the lead, have the logs" is not a question.
 */
const FOR_USER_LINE_RE = /^\s*(?:you|the user)\s*[:,]\s*\S/i;

const LINE_MAX = 200;

/** Cut to `max` characters, never inside a surrogate pair. */
function cut(t: string, max = LINE_MAX): string {
  const chars = Array.from(t);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : t;
}

const clean = (t: string) => t.replace(/\s+/g, ' ').trim();

/** The lines of a text that are its own words: no code fence, no quoted line. */
function ownLines(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const raw of text.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(raw)) { fenced = !fenced; continue; }
    if (fenced || /^\s*>/.test(raw)) continue;
    out.push(raw);
  }
  return out;
}

/** Split prose into sentences (on ". ", "? ", "! ", "; " and their full-width forms). */
function sentences(line: string): string[] {
  return line.split(/(?<=[.?!;])\s+|(?<=[\u3002\uff1f\uff01\uff1b])/u).map(clean).filter(Boolean);
}

/** Text in quotes or backticks is someone else's words, a UI label or code, never the writer's own. */
const QUOTED_RE = /`[^`]*`|"[^"\n]*"|\u201c[^\u201d\n]*\u201d|\u300c[^\u300d\n]*\u300d/gu;

/** Whether a phrase list matches the text somewhere not negated by the words just before it. */
function matchesLive(raw: string, res: readonly RegExp[]): boolean {
  const text = raw.replace(QUOTED_RE, ' ');
  for (const re of res) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (let m = g.exec(text); m; m = g.exec(text)) {
      if (!NEGATED_BEFORE_RE.test(text.slice(Math.max(0, m.index - 30), m.index))) return true;
      if (m[0].length === 0) g.lastIndex++;
    }
  }
  return false;
}

/** Whether a line asks someone to decide (pure). */
export function asksToDecide(text: string): boolean {
  return matchesLive(text, QUESTION_RES);
}

/** Whether a note line asks the user: a decision phrase, or a line written for the user to act on. */
function noteAsks(text: string): boolean {
  return FOR_USER_LINE_RE.test(text.replace(QUOTED_RE, ' ')) || asksToDecide(text);
}

/** Whether a line says something is still under way (pure). */
export function readsUnfinished(text: string): boolean {
  return matchesLive(text, STALE_RES);
}

/**
 * The first line of a message that asks someone to decide, cut to one line; undefined when none
 * does. Reads the sender's own words only (quoted lines and code fences are skipped).
 */
export function userQuestionIn(...texts: Array<string | readonly string[] | null | undefined>): string | undefined {
  for (const t of texts) {
    const all = Array.isArray(t) ? t.join('\n') : typeof t === 'string' ? t : '';
    for (const line of ownLines(all)) {
      for (const s of sentences(line)) if (asksToDecide(s)) return cut(clean(s.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '')));
    }
  }
  return undefined;
}

/**
 * The lines of a note that still read as unfinished (pure). Progress: a line with an open label,
 * and an unlabelled line with an open phrase; a finished line ([DONE]) and the lines under it are
 * the record of finished work and are not read. Executive Summary: each sentence. A note with none
 * of the usual sections is read only for open labels. The User Request, Context, References and
 * the Work Log are history or the user's words, and never read.
 */
export function openNoteLines(note: string | null | undefined): OpenNoteLine[] {
  if (!note || !note.trim()) return [];
  const out: OpenNoteLine[] = [];
  const seen = new Set<string>();
  const add = (kind: OpenLineKind, text: string) => {
    const t = cut(clean(text));
    const key = t.toLowerCase();
    if (!t || seen.has(key)) return;
    seen.add(key);
    out.push({ kind, text: t });
  };
  const { sections } = parseNoteSections(note);
  const hasSections = Object.keys(sections).length > 0;
  const summary = sections['Executive Summary'];
  if (summary) {
    for (const line of ownLines(summary)) {
      for (const s of sentences(line)) {
        if (noteAsks(s)) add('question', s);
        else if (readsUnfinished(s)) add('stale', s);
      }
    }
  }
  const progress = hasSections ? sections.Progress : note;
  if (progress) {
    let underDone = false;
    for (const raw of ownLines(progress)) {
      if (!raw.trim()) continue;
      const indented = /^\s{2,}|^\t/.test(raw);
      const open = OPEN_LABEL_RE.exec(raw);
      if (open) {
        underDone = false;
        const body = clean(open[2].replace(/^[—–:-]\s*/, ''));
        add(noteAsks(body) ? 'question' : 'open', `[${open[1].toUpperCase()}] ${body}`);
        continue;
      }
      if (ANY_LABEL_RE.test(raw)) { underDone = true; continue; }
      // A note without sections is read only for its labels.
      if (!hasSections) continue;
      if (indented && underDone) continue;
      if (!indented) underDone = false;
      const text = clean(raw.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, ''));
      if (noteAsks(text)) add('question', text);
      else if (readsUnfinished(text)) add('stale', text);
    }
  }
  return out;
}

/** A stable key for a set of open lines: a second close naming the same lines is let through. */
export function openLinesKey(lines: readonly OpenNoteLine[]): string[] {
  return lines.map((l) => l.text.toLowerCase());
}
