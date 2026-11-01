/**
 * The user's private-task words (config `private_tasks.words`, Settings › Tasks › Private tasks):
 * a task whose text matches one is kept local in a project that syncs to an outside service,
 * whoever makes it, and an edit that adds one stops the task before its next push (sync-gate.ts,
 * sync-guard.ts). The list lives in the user's own config, never in the repo.
 *
 * One entry per line. A plain entry matches as a whole word, case-insensitively (`pay` matches
 * "Pay review" but not "repay"); an entry holding CJK text matches anywhere, since CJK has no
 * word breaks. `/pattern/flags` is a regular expression (case-insensitive unless it says
 * otherwise). An entry that does not compile, or an empty one, is skipped, never an error: a
 * typo in the list must not stop every task from being created.
 */
import { CJK_CHAR_RE } from '../cjk.js';

/** One compiled entry: the text the user wrote (what a match reports) and its test. */
export interface PrivateWordRule {
  entry: string;
  re: RegExp;
  /** The user's own /pattern/ (run on a shorter text). */
  pattern?: boolean;
}

/** Longest entry compiled; a longer one is skipped (a pasted paragraph is not a rule). */
const MAX_ENTRY_CHARS = 200;
/** How much of one field a rule is run against. */
const MAX_TEXT_CHARS = 100_000;
/** How much of one field a user's own /pattern/ is run against: it runs on the server's one
 *  event loop, at every create and push. */
export const MAX_PATTERN_TEXT_CHARS = 20_000;

/**
 * A pattern that can take exponential time (a quantified group holding a quantifier, such as
 * `(a+)+` or `(\w+\s?)*`, or a back-reference) is not used: one such pattern on a long text
 * would freeze every route of the server. Settings lists it as not used.
 */
export function slowPattern(source: string): boolean {
  if (/\\[1-9]|\\k</.test(source)) return true;
  const QUANT = /[+*]|\{\d*,\d*\}/;
  // Escapes and character classes are single atoms; then groups are folded innermost first,
  // a group that holds or carries a quantifier becoming one quantified atom (`q+`).
  let s = source.replace(/\\./g, 'e').replace(/\[[^\]]*\]/g, 'c');
  for (let i = 0; i < 100; i++) {
    const m = /\(([^()]*)\)((?:[+*?]|\{\d*,?\d*\})?)/.exec(s);
    if (!m) break;
    const inner = QUANT.test(m[1].replace(/^\?[:=!]|^\?<[=!]?[\w]*>?/, ''));
    const outer = QUANT.test(m[2]);
    if (inner && outer) return true;
    s = s.slice(0, m.index) + (inner || outer ? 'q+' : 'e') + s.slice(m.index + m[0].length);
  }
  return false;
}

const cache = new Map<string, PrivateWordRule[]>();

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(entry: string): RegExp | null {
  const raw = entry.trim();
  if (!raw || raw.length > MAX_ENTRY_CHARS) return null;
  const re = /^\/(.+)\/([a-z]*)$/s.exec(raw);
  try {
    if (re) {
      if (slowPattern(re[1])) return null;
      // No flags = case-insensitive; flags given are used as given (g and y dropped: .test()
      // on them is stateful).
      const given = [...new Set(re[2].replace(/[gy]/g, '').split(''))].join('');
      const flags = re[2] ? given : 'i';
      return new RegExp(re[1], flags.includes('u') || flags.includes('v') ? flags : `${flags}u`);
    }
    const body = escapeRe(raw).replace(/\s+/g, '\\s+');
    if (CJK_CHAR_RE.test(raw)) return new RegExp(body, 'iu');
    // A whole word: no letter or digit right before or after (works for any script).
    return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu');
  } catch {
    return null;
  }
}

/** The compiled rules of a word list (cached by the list itself). */
export function compilePrivateWords(words: readonly string[] | undefined): PrivateWordRule[] {
  if (!words?.length) return [];
  const key = JSON.stringify(words);
  const hit = cache.get(key);
  if (hit) return hit;
  const rules: PrivateWordRule[] = [];
  for (const entry of words) {
    if (typeof entry !== 'string') continue;
    const re = compile(entry);
    if (re) rules.push({ entry: entry.trim(), re, ...(/^\/.+\/[a-z]*$/s.test(entry.trim()) ? { pattern: true } : {}) });
  }
  if (cache.size > 20) cache.clear();
  cache.set(key, rules);
  return rules;
}

/** Entries of a list that do not compile (Settings shows them). */
export function invalidPrivateWords(words: readonly string[] | undefined): string[] {
  return (words ?? []).filter((w) => typeof w === 'string' && w.trim() && !compile(w));
}

/** The first entry any of `texts` matches, or null. */
export function matchPrivateWords(words: readonly string[] | undefined, texts: ReadonlyArray<string | undefined | null>): string | null {
  const rules = compilePrivateWords(words);
  if (rules.length === 0) return null;
  for (const text of texts) {
    if (!text) continue;
    for (const rule of rules) {
      if (ruleMatches(rule, text)) return rule.entry;
    }
  }
  return null;
}

/** One rule against one text, within the rule's text budget. */
export function ruleMatches(rule: PrivateWordRule, text: string): boolean {
  const cap = rule.pattern ? MAX_PATTERN_TEXT_CHARS : MAX_TEXT_CHARS;
  return rule.re.test(text.length > cap ? text.slice(0, cap) : text);
}
