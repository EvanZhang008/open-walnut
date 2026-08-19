/**
 * Host-local symbol search — "find references" for the Files viewer.
 *
 * Runs where the files are (in-process for the local host, in the daemon for a
 * remote one, per the repo's host-local design principle): one RPC crosses the
 * tunnel and only the small match list comes back, never the searched bytes.
 *
 * Two tools, in preference order:
 *  git grep  the repo's tracked content — honors .gitignore for free, reaches
 *            into submodules, and is an index-backed search rather than a walk.
 *  grep -r   the fallback for a directory that is not in a git repo at all,
 *            with the same heavy-directory prune list the path resolver uses.
 *
 * Never throws: an invalid symbol, a missing tool, or a blown deadline all come
 * back as a result carrying `error`, because a reference panel that shows an
 * errno is a bug rather than a diagnosis.
 *
 * Self-contained on purpose (node builtins only) so the daemon binary can bundle
 * it without dragging in the server's module graph.
 */

import path from 'node:path';
import { execFile } from 'node:child_process';

export interface GrepMatch {
  /** Absolute path of the file the match is in. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The matched line, trimmed of a trailing CR and capped. */
  text: string;
  /** 'def' when the line looks like where the symbol is DECLARED. */
  kind: 'def' | 'ref';
}

export interface GrepRefsOptions {
  /** Absolute path of the file the symbol was clicked in — anchors the search. */
  file: string;
  /** Identifier to search for. Word-boundary, fixed-string (never a regex). */
  symbol: string;
  /** Cap on returned matches (default 500, clamped to 1..2000). */
  maxMatches?: number;
  /** Wall-clock budget for the search subprocess. */
  budgetMs?: number;
}

export interface GrepRefsResult {
  /** Repo root (git) or the searched directory (fallback). '' when rejected. */
  root: string;
  matches: GrepMatch[];
  /** true = the cap was hit, or a partial result came back from a failed run. */
  truncated: boolean;
  tool: 'git-grep' | 'grep' | 'none';
  /** Set instead of matches when the search could not run or produced nothing. */
  error?: string;
}

/** A plausible identifier. Anything else is rejected rather than searched. */
const SYMBOL_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;

/** Directories never worth searching (mirrors path-resolve-core's list). */
const PRUNE_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'target',
  'coverage', '.cache', 'vendor', '__pycache__', '.venv', 'venv',
  '.gradle', '.idea', 'Pods', '.terraform', '.tox', '.mypy_cache',
];

const DEFAULT_MAX_MATCHES = 500;
const HARD_MAX_MATCHES = 2000;
const DEFAULT_BUDGET_MS = 10_000;
/** Ceiling on one grep subprocess, under any caller's budget. */
const SUBPROCESS_TIMEOUT_MS = 8_000;
/** Longest match line we return — a minified file has 1MB "lines". */
const MAX_TEXT_CHARS = 300;

/**
 * Run a subprocess, never throwing. `code` is the exit status, or -1 when the
 * process could not run / was killed (timeout). grep-family tools exit 1 for
 * "no matches", which is a normal answer and NOT an error.
 */
function run(
  cmd: string,
  args: string[],
  cwd: string | undefined,
  budgetMs: number | undefined,
): Promise<{ stdout: string; code: number }> {
  const timeout = Math.min(budgetMs ?? DEFAULT_BUDGET_MS, SUBPROCESS_TIMEOUT_MS);
  return new Promise((resolve) => {
    const child = execFile(
      cmd, args,
      { cwd, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf-8' },
      (err, stdout) => {
        if (!err) return resolve({ stdout: stdout || '', code: 0 });
        const code = typeof (err as { code?: unknown }).code === 'number'
          ? (err as unknown as { code: number }).code
          : -1;
        resolve({ stdout: stdout || '', code });
      },
    );
    child.on('error', () => resolve({ stdout: '', code: -1 }));
  });
}

/** Escape a string for literal use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does `lineText` look like the place `symbol` is DECLARED?
 *
 * Deliberately a set of small language-agnostic shapes rather than a parser: the
 * viewer only needs definitions sorted to the top, and a wrong guess costs an
 * ordering, not a wrong answer. The keyword rule is anchored to the symbol so a
 * line that merely CONTAINS `func` (a closure calling the symbol) stays a ref.
 */
export function classifyDefinition(lineText: string, symbol: string): boolean {
  if (!lineText || !SYMBOL_RE.test(symbol)) return false;
  const sym = escapeRe(symbol);
  // Declaration keyword directly before the symbol. The optional `(...)` covers
  // a Go method receiver: `func (f *Factory) HasSynced(`.
  if (new RegExp('\\b(func|fn|def|function|class|struct|interface|trait|enum|impl|type|module|macro)\\s+(\\([^)]*\\)\\s*)?' + sym + '\\b').test(lineText)) return true;
  // Binding keyword.
  if (new RegExp('\\b(const|let|var|val|final|readonly)\\s+' + sym + '\\b').test(lineText)) return true;
  // Top-level assignment / Go short declaration (`x :=`), but not `x ==`.
  if (new RegExp('^\\s*' + sym + '\\s*:?=[^=]').test(lineText)) return true;
  // Java/C# style method with an access modifier.
  if (new RegExp('\\b(public|private|protected|internal|static)\\s+[^=;]*\\b' + sym + '\\s*\\(').test(lineText)) return true;
  return false;
}

/** One `path:line:text` output line. Non-greedy so the FIRST `:<n>:` wins. */
const GREP_LINE_RE = /^(.*?):(\d+):(.*)$/;

/** Parse grep output into matches, stopping at the cap. */
function parseMatches(
  stdout: string,
  symbol: string,
  maxMatches: number,
  toAbs: (p: string) => string,
): { matches: GrepMatch[]; truncated: boolean } {
  const matches: GrepMatch[] = [];
  let truncated = false;
  for (const raw of stdout.split('\n')) {
    if (!raw) continue;
    if (matches.length >= maxMatches) { truncated = true; break; }
    const m = GREP_LINE_RE.exec(raw);
    if (!m) continue;
    const text = m[3]!.replace(/\r$/, '').slice(0, MAX_TEXT_CHARS);
    matches.push({
      file: toAbs(m[1]!),
      line: Number(m[2]),
      text,
      kind: classifyDefinition(text, symbol) ? 'def' : 'ref',
    });
  }
  return { matches, truncated };
}

/** Definitions first, then file path, then line. Stable. */
function sortMatches(matches: GrepMatch[]): GrepMatch[] {
  return matches
    .map((m, i) => ({ m, i }))
    .sort((a, b) =>
      (a.m.kind === b.m.kind ? 0 : a.m.kind === 'def' ? -1 : 1)
      || (a.m.file < b.m.file ? -1 : a.m.file > b.m.file ? 1 : 0)
      || a.m.line - b.m.line
      || a.i - b.i)
    .map((e) => e.m);
}

function buildResult(
  res: { stdout: string; code: number },
  tool: 'git-grep' | 'grep',
  root: string,
  symbol: string,
  maxMatches: number,
  toAbs: (p: string) => string,
): GrepRefsResult {
  // Exit 1 = zero matches, a normal answer. Anything else is a real failure.
  const failed = res.code !== 0 && res.code !== 1;
  if (failed && !res.stdout) {
    return { root, matches: [], truncated: false, tool, error: 'search timed out or failed' };
  }
  const { matches, truncated } = parseMatches(res.stdout, symbol, maxMatches, toAbs);
  return { root, matches: sortMatches(matches), truncated: truncated || failed, tool };
}

/**
 * Find every mention of `symbol` in the tree that owns `file`.
 *
 * Never throws: bad input and failed searches both come back as a result with
 * `error` set, so the caller always has something to render.
 */
export async function grepReferencesHostLocal(opts: GrepRefsOptions): Promise<GrepRefsResult> {
  const symbol = typeof opts?.symbol === 'string' ? opts.symbol : '';
  if (!SYMBOL_RE.test(symbol)) {
    return { root: '', matches: [], truncated: false, tool: 'none', error: 'invalid symbol' };
  }
  const file = typeof opts?.file === 'string' ? opts.file : '';
  if (!path.isAbsolute(file)) {
    return { root: '', matches: [], truncated: false, tool: 'none', error: 'file must be absolute' };
  }
  const requested = typeof opts.maxMatches === 'number' && Number.isFinite(opts.maxMatches)
    ? Math.floor(opts.maxMatches)
    : DEFAULT_MAX_MATCHES;
  const maxMatches = Math.max(1, Math.min(requested, HARD_MAX_MATCHES));
  const dir = path.dirname(file);
  const budgetMs = opts.budgetMs;

  // Step 1 — is this a git repo? Its root is both the search scope and the base
  // that git grep's relative paths are reported against.
  const top = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel'], undefined, budgetMs);
  const root = top.code === 0 && top.stdout.trim() ? top.stdout.trim() : null;

  // Step 2 — git grep: index-backed, submodule-aware, .gitignore-respecting.
  if (root) {
    const res = await run(
      'git',
      ['grep', '-n', '-I', '--recurse-submodules', '-w', '-F', '-e', symbol, '--'],
      root, budgetMs,
    );
    return buildResult(res, 'git-grep', root, symbol, maxMatches, (rel) => path.join(root, rel));
  }

  // Step 3 — plain grep for a non-git tree. Paths come back absolute already
  // because the search root is absolute.
  //
  // `--devices=skip` is load-bearing, not tidiness: without it a single FIFO in
  // the tree (Walnut's own session pipes live in dirs like this) makes grep
  // BLOCK on the open until the timeout SIGTERMs it — the whole budget spent,
  // zero results. Same failure shape as the daemon fs-pool FIFO wedge.
  const args = ['-r', '-n', '-I', '-w', '-F', '--devices=skip'];
  for (const d of PRUNE_DIRS) args.push('--exclude-dir=' + d);
  args.push('-e', symbol, dir);
  let res = await run('grep', args, dir, budgetMs);
  // BSD grep predating --devices= exits 2 with a usage error. Retry once with
  // -D skip (its spelling); if that's also refused, go without and rely on the
  // timeout, which is the pre-existing behavior rather than a regression.
  if (res.code === 2 && !res.stdout) {
    const bsd = args.map((a) => (a === '--devices=skip' ? '-D' : a));
    bsd.splice(bsd.indexOf('-D') + 1, 0, 'skip');
    res = await run('grep', bsd, dir, budgetMs);
    if (res.code === 2 && !res.stdout) {
      res = await run('grep', args.filter((a) => a !== '--devices=skip'), dir, budgetMs);
    }
  }
  return buildResult(res, 'grep', dir, symbol, maxMatches, (p) => p);
}
