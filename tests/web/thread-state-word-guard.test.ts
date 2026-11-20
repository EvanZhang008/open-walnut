/**
 * Guard: a Thread the user reads (the Org page's and a task's Threads, the phone app's) never
 * says "Answered". Its state value stays `answered` inside Walnut; the word he reads is "Done".
 *
 * 2026-11-20, the user, on the Threads state word: "what does answered mean? ... completed? ...
 * for you to review". Most threads in that state are a finished result waiting for his look,
 * so the word became "Done" ("Needs you" stays the one that asks him to decide).
 *
 * The class: every web and iOS source file that renders an org thread (it names the thread type
 * or its API), found from the source, so a new card, list or header joins by itself. A string
 * literal with the word "Answered" in any of them fails; comments and the `answered` state value
 * (lowercase) are free.
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

const WEB_MARK = /api\/org-threads|useOrgThreads|\bOrgThread\b/;
const IOS_MARK = /\bOrgThread\b/;

const webFiles = walk(join(ROOT, 'web', 'src'), ['.ts', '.tsx']).filter((f) => WEB_MARK.test(readFileSync(f, 'utf8')));
const iosFiles = walk(join(ROOT, 'ios-native', 'Walnut'), ['.swift']).filter((f) => IOS_MARK.test(readFileSync(f, 'utf8')));

describe('Threads never show the word "Answered"', () => {
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

  it('the answered state reads Done on the web and on the phone', () => {
    expect(readFileSync(join(ROOT, 'web/src/components/org/OrgThreads.tsx'), 'utf8')).toMatch(/answered: 'Done'/);
    expect(readFileSync(join(ROOT, 'ios-native/Walnut/Views/Org/OrgThreadModel.swift'), 'utf8')).toMatch(/case "answered": return "Done"/);
  });

  it('the scan catches the old word (self-check)', () => {
    expect(answeredLiterals(`const L = { answered: 'Answered' }; // Answered in a comment`)).toEqual([`'Answered'`]);
    expect(answeredLiterals(`/* 'Answered' */ const ok = 'answered'`)).toEqual([]);
  });
});
