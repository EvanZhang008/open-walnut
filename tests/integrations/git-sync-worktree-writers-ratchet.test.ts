/**
 * Class ratchet: no code under src/integrations/ lets git itself write the data
 * repo's live working tree from another commit, except the sites named below.
 *
 * 2026-11-24: `git merge` in the live tree left conflict markers in
 * host-exec-grants.json for seconds (three host_exec reads refused), and ten
 * timed-out merges each fell back to `pull -X theirs`, overwriting live stores
 * with the hub's older content. A pull now computes its result in git's object
 * store and moves the tree through ONE function (git-sync-apply.ts). Every
 * command that would undo that is a string or an argv literal in the source, so
 * a scan finds it: `pull`, `merge` (not merge-tree / merge-base), `rebase`,
 * `checkout --ours/--theirs` (or a computed side), `reset --hard`,
 * `read-tree -u`, `-X theirs`. A new one fails here; if it is truly needed, add
 * it to ALLOWED with the reason, in review.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCAN_DIR = 'src/integrations';

/** Where such a command may appear, and why. `symbol` is the top-level function or const holding it. */
const ALLOWED: Array<{ file: string; symbol: string; why: string }> = [
  {
    file: 'src/integrations/git-sync.ts',
    symbol: 'legacyWorktreePull',
    why: 'the one pull fallback: a checkout that converts content, or the merge on a git before 2.38; it aborts and defers on any failure',
  },
  {
    file: 'src/integrations/git-sync.ts',
    symbol: 'recoverOrphanedGitSurgery',
    why: 'unfreezes a rebase or merge a crashed git left behind 30+ minutes ago; its -X theirs keeps the live worktree snapshot, not the remote',
  },
  {
    file: 'src/integrations/git-hub-hook.ts',
    symbol: 'MANAGED_PULL',
    why: 'the text an old managed hub hook is recognised by, never run by this server',
  },
];

interface Hit { file: string; line: number; symbol: string; text: string }

/**
 * Comments out (blanked, so line numbers hold), string contents kept. Regex
 * literals are skipped whole, so a quote or `//` inside one is not read as a
 * string or a comment.
 */
function stripComments(src: string): string {
  let out = '';
  let prev = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
    } else if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]|^$/.test(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n' && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j++;
      }
      out += ' '.repeat(j + 1 - i);
      i = j + 1;
      prev = '/';
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      prev = c;
    } else {
      out += c;
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out;
}

/** A git command line (after any `git` and `-c k=v` prefix) that writes the tree from another commit. */
function isTreeWritingCommand(text: string): boolean {
  const cmd = text.trim().replace(/^git\s+/, '').replace(/^(?:-c\s+\S+\s+)+/, '');
  // With arguments: a bare 'merge' is a value (a kind, a type); a bare call is ARGV_FORMS' job.
  return /^(?:pull|merge|rebase)\s+\S/.test(cmd)
    || /^checkout\b.*\s--(?:ours|theirs)\b/.test(cmd)
    || /^checkout\s+\$\{/.test(cmd)
    || /^reset\s+(?:-\S+\s+)*--hard\b/.test(cmd)
    || /^read-tree\b.*\s-u\b/.test(cmd)
    || /(?:^|\s)-X\s*theirs\b/.test(cmd);
}

/** Argv forms: `['pull', ...]`, `['-c', 'x=y', 'merge', ...]`, `'reset', '--hard'`, `'-X', 'theirs'`, ... */
const ARGV_FORMS = [
  /\[\s*(?:'-c',\s*'[^']*',\s*)*'(?:pull|merge|rebase)'\s*[,\]]/,
  /\(\s*(['"`])(?:pull|merge|rebase)\1\s*[,)]/,
  /'reset',\s*(?:'-[^']*',\s*)*'--hard'/,
  /'-X',\s*'theirs'/,
  /'checkout',[^\]]*'--(?:ours|theirs)'/,
  /'read-tree',[^\]]*'-u'/,
];

const DECL = /^(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s*(\w+)|(?:const|let|var|class|type|interface)\s+(\w+))/;

function scanSource(file: string, src: string): Hit[] {
  const code = stripComments(src);
  const lines = code.split('\n');
  const symbols: string[] = [];
  let current = '(module)';
  for (const line of lines) {
    const m = DECL.exec(line);
    if (m) current = m[1] ?? m[2];
    symbols.push(current);
  }
  const hits: Hit[] = [];
  const lineOf = (index: number): number => code.slice(0, index).split('\n').length;
  const add = (index: number, text: string): void => {
    const line = lineOf(index);
    hits.push({ file, line, symbol: symbols[line - 1], text: text.slice(0, 120) });
  };
  for (const m of code.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) {
    if (isTreeWritingCommand(m[0].slice(1, -1))) add(m.index!, m[0]);
  }
  for (const form of ARGV_FORMS) {
    for (const m of code.matchAll(new RegExp(form.source, 'g'))) add(m.index!, m[0]);
  }
  return hits;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(?:ts|js|mjs|cjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const allHits = (): Hit[] => sourceFiles(SCAN_DIR).flatMap((f) => scanSource(f, fs.readFileSync(path.join(repoRoot, f), 'utf-8')));

describe('git working-tree writers under src/integrations/', () => {
  it('appear only at the named sites', () => {
    const outside = allHits().filter((h) => !ALLOWED.some((a) => a.file === h.file && a.symbol === h.symbol));
    expect(outside.map((h) => `${h.file}:${h.line} (${h.symbol}) ${h.text}`)).toEqual([]);
  });

  it('every named site still holds one (an empty entry is removed, not kept)', () => {
    const hits = allHits();
    for (const a of ALLOWED) {
      expect(hits.some((h) => h.file === a.file && h.symbol === a.symbol), `${a.file} ${a.symbol}`).toBe(true);
    }
  });

  it('the scan sees every shape it guards (it would fail on the old pull)', () => {
    const sample = [
      'async function pullAgain() {',
      "  await gitSafeAsync(`pull --rebase origin ${branch}`);",
      "  await gitAsync('git pull -X theirs origin main');",
      "  await gitAsync(`merge --no-edit ${remoteRef}`);",
      "  await gitSafeAsync(`checkout ${side} -- \"${file}\"`);",
      "  await gitSafeAsync('checkout --theirs -- a.json');",
      "  await gitSafeAsync(`reset --hard ${target}`);",
      "  await run(['-c', 'merge.renames=false', 'merge', 'origin/main']);",
      "  await run(['reset', '-q', '--hard', target]);",
      "  await run(['read-tree', '-m', '-u', a, b]);",
      "  await gitSafeAsync('pull');",
      '}',
    ].join('\n');
    expect(scanSource('sample.ts', sample).map((h) => h.line).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const fine = [
      'async function fine() {',
      "  await run(['merge-tree', '--write-tree', a, b]);",
      "  await gitSafeAsync(`merge-base --is-ancestor ${a} ${b}`);",
      "  await gitSafeAsync('reset --mixed HEAD');",
      "  log.git.warn('git-sync merge failed — deferred');",
      "  const message = `merge: LWW conflict resolution (${n} files)`;",
      "  const kind: 'rebase' | 'merge' = 'merge'; const re = /'pull/;",
      '  // a comment naming `pull -X theirs` is not a call',
      '}',
    ].join('\n');
    expect(scanSource('fine.ts', fine)).toEqual([]);
  });
});
