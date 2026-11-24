/**
 * Ratchet: every `git add` the data repo's sync runs gets a timeout scaled to the
 * bytes it hashes (2026-11-24: a flat 30 s add timed out on large tracked data and
 * every other change stopped syncing; git-sync-large-files.ts).
 *
 * Enumerates the add calls in src/integrations/git-sync*.ts from the source, so a
 * NEW add that takes the flat default fails here until it names its timeout.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '../../src/integrations');
const FILES = fs.readdirSync(DIR).filter((f) => /^git-sync.*\.ts$/.test(f));

/** A line that runs (or builds) a git add: a string or argv form. */
const ADD_CALL = /(['"`]add (-A|--|-u|-f|\.)|'add',\s*'-A'|\[\s*'add'\s*,|'--literal-pathspecs',\s*'add'|'hash-object'|stageAllArgs\(|addListed\()/;

/** How a line may bound its add. */
const SCALED = /addTimeoutFor\(|wholeTreeAddTimeout\(|fileAddTimeout\(/;

/** Adds that are bounded by what they stage, not by user data: each with why. */
const ALLOWED: Array<{ file: string; snippet: string; why: string }> = [
  { file: 'git-sync.ts', snippet: "add -- .gitignore", why: 'the data repo\'s own .gitignore, a few KB' },
  { file: 'git-sync.ts', snippet: "export function stageAllArgs(", why: 'builds the argument line; its call site is checked' },
  { file: 'git-sync.ts', snippet: "return 'add -A';", why: 'stageAllArgs body' },
  { file: 'git-sync-large-files.ts', snippet: 'export async function addListed(', why: 'its call sites are checked' },
  { file: 'git-sync-large-files.ts', snippet: "await git([...(opts.config ?? []), 'add', '-A'", why: "addListed body: the caller's timeout; call sites checked" },
  { file: 'git-sync.ts', snippet: 'return `add -A -- . ${neverStageTreeExcludes()', why: 'stageAllArgs body' },
];

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

describe('every data-repo git add has a scaled timeout', () => {
  const found: Array<{ file: string; line: number; text: string }> = [];
  for (const file of FILES) {
    fs.readFileSync(path.join(DIR, file), 'utf-8').split('\n').forEach((text, i) => {
      if (!isComment(text) && ADD_CALL.test(text)) found.push({ file, line: i + 1, text: text.trim() });
    });
  }

  it('finds the add calls it guards (the scan itself works)', () => {
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect(found.some((f) => f.file === 'git-sync-large-files.ts')).toBe(true);
  });

  it.each(found.map((f) => [`${f.file}:${f.line}`, f] as const))('%s', (_name, f) => {
    const allowed = ALLOWED.some((a) => a.file === f.file && f.text.includes(a.snippet));
    if (allowed) return;
    // A string form names its timeout on its own line; an argv call's options object
    // may start on the next line (`await git([...], {` then `timeout: ...`).
    const source = fs.readFileSync(path.join(DIR, f.file), 'utf-8').split('\n');
    const multiLine = /\{\s*$/.test(f.text);
    const window = source.slice(f.line - 1, f.line + (multiLine ? 2 : 0)).join('\n');
    expect(SCALED.test(window), `${f.file}:${f.line} runs git add without a timeout scaled to its bytes: ${f.text}`).toBe(true);
  });

  // status hashes touched tracked files too: a timed-out status reads as a clean
  // tree, so the tick's status goes through porcelainStatus (raised big-file
  // threshold, timeout scaled to what diff-files says it may hash).
  it('runs the tick\'s status only through porcelainStatus', () => {
    const lines = fs.readFileSync(path.join(DIR, 'git-sync.ts'), 'utf-8').split('\n')
      .map((text, i) => ({ text, line: i + 1 }))
      .filter((l) => !isComment(l.text) && /status --porcelain/.test(l.text) && /Async\(/.test(l.text));
    expect(lines.map((l) => l.text.trim())).toEqual([
      'return gitSafeAsync(`-c core.bigFileThreshold=${STAGE_BIG_FILE_THRESHOLD} status --porcelain -uall`, {',
      // Scoped to the replica's never-author paths (letters, plugin text files): small by design.
      'const status = await gitSafeAsync(`status --porcelain -- ${scope}`, gitOpts);',
    ]);
  });
});
