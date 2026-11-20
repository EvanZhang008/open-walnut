/**
 * Guard: a Thread the user reads (the Org page's and a task's Threads, the phone app's) never
 * says "Answered", and an open thread never says "Done". Its state value stays `answered` inside
 * Walnut; the word he reads is "To read" (USER_STATE_LABELS.read). "Done" is only a thread he closed.
 *
 * 2026-11-20, the user, on the Threads state word: "what does answered mean? ... completed? ...
 * for you to review": the word became "Done". The same day, a task's one thread read "Done" while
 * the task's ask waited for his answer above the chat ("there are werid thing happened ... one says
 * Done and the other waits for him"): an answered thread waits for his look and has not ended, so
 * its word became "To read", and a thread holding the task's ask reads Needs you
 * (src/core/org/thread-report-ask.ts).
 *
 * The class: every web and iOS source file that renders an org thread (it names the thread type
 * or its API), found from the source, so a new card, list or header joins by itself. A string
 * literal with the word "Answered" in any of them fails, and so does a label of an open state
 * (new, working, needs, answered, pending) that reads "Done" or "Answered"; comments and the
 * `answered` state value (lowercase) are free.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..');

function walk(dir: string, exts: readonly string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

/** Comments out, string literals kept: `//` lines and block comments go (good enough for a word scan). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Quoted literals ('…', "…", `…`) holding the word Answered. */
function answeredLiterals(src: string): string[] {
  const lits = stripComments(src).match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];
  return lits.filter((l) => /\bAnswered\b/.test(l));
}

const OPEN_STATES = 'new|working|needs|answered|pending'
/** The labels an open thread state reads, by state: `answered: 'X'` (a TS map) or `case "answered": return "X"` (Swift). */
function openStateLabels(src: string): string[] {
  const code = stripComments(src)
  const ts = [...code.matchAll(new RegExp(`\\b(${OPEN_STATES})\\s*:\\s*(['"\`])([^'"\`\\n]*)\\2`, 'g'))].map((m) => `${m[1]}: ${m[3]}`)
  const swift = [...code.matchAll(new RegExp(`case\\s+"(${OPEN_STATES})"\\s*:\\s*return\\s+"([^"\\n]*)"`, 'g'))].map((m) => `${m[1]}: ${m[2]}`)
  return [...ts, ...swift]
}
const ENDED = /:\s*(Done|Answered)\b/

const WEB_MARK = /api\/org-threads|useOrgThreads|\bOrgThread\b/;
const IOS_MARK = /\bOrgThread\b/;

const webFiles = walk(join(ROOT, 'web', 'src'), ['.ts', '.tsx']).filter((f) => WEB_MARK.test(readFileSync(f, 'utf8')));
const iosFiles = walk(join(ROOT, 'ios-native', 'Walnut'), ['.swift']).filter((f) => IOS_MARK.test(readFileSync(f, 'utf8')));

describe('Threads never show "Answered", and an open thread never "Done"', () => {
  it('finds the files that render a thread (the class is not empty)', () => {
    const rel = [...webFiles, ...iosFiles].map((f) => relative(ROOT, f));
    expect(rel).toContain('web/src/components/org/OrgThreads.tsx');
    expect(rel).toContain('ios-native/Walnut/Views/Org/OrgThreadModel.swift');
  });

  it('no file that renders a thread has "Answered" in a string', () => {
    const hits = [...webFiles, ...iosFiles].flatMap((f) =>
      answeredLiterals(readFileSync(f, 'utf8')).map((l) => `${relative(ROOT, f)}: ${l}`));
    expect(hits, 'a thread state reads "Done" to the user, never "Answered"').toEqual([]);
  });

  it('no open thread state reads Done or Answered in any file that renders a thread', () => {
    const hits = [...webFiles, ...iosFiles].flatMap((f) =>
      openStateLabels(readFileSync(f, 'utf8')).filter((l) => ENDED.test(l)).map((l) => `${relative(ROOT, f)}: ${l}`));
    expect(hits, 'an open thread has not ended: Done is only a thread he closed').toEqual([]);
  });

  it('the answered state reads To read on the web and on the phone', () => {
    expect(readFileSync(join(ROOT, 'web/src/components/org/OrgThreads.tsx'), 'utf8')).toMatch(/answered: USER_STATE_LABELS\.read/);
    expect(readFileSync(join(ROOT, 'src/core/user-status.ts'), 'utf8')).toMatch(/read: 'To read'/);
    expect(readFileSync(join(ROOT, 'ios-native/Walnut/Views/Org/OrgThreadModel.swift'), 'utf8')).toMatch(/case "answered": return "To read"/);
  });

  it('the scans catch the old words (self-check)', () => {
    expect(answeredLiterals(`const L = { answered: 'Answered' }; // Answered in a comment`)).toEqual([`'Answered'`]);
    expect(answeredLiterals(`/* 'Answered' */ const ok = 'answered'`)).toEqual([]);
    expect(openStateLabels(`const L = { new: 'New', answered: 'Done' }`).filter((l) => ENDED.test(l))).toEqual(['answered: Done']);
    expect(openStateLabels(`switch s {\ncase "answered": return "Done"\n}`).filter((l) => ENDED.test(l))).toEqual(['answered: Done']);
    expect(openStateLabels(`case "pending": return "Answered"`).filter((l) => ENDED.test(l))).toEqual(['pending: Answered']);
    // A closed thread reads Done: no open state's label, so free.
    expect(openStateLabels(`if let c = t.closed { return c.how == "acked" ? "Done" : "Dropped" }`)).toEqual([]);
  });
});
