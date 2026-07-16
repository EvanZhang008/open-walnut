/**
 * Bash file-op parser — extract file CREATE / DELETE / RENAME operations from the
 * shell commands a session ran, so the Changed view covers moves/renames/deletes
 * (done via `mv`/`git mv`/`rm`/`git rm`/`cp`/`touch`/redirection) and not just the
 * Edit/Write/MultiEdit tool ops.
 *
 * ## Why this exists
 * session-changes.ts reconstructs a session's diff by replaying its Edit/Write ops
 * from JSONL. But agents frequently MOVE or DELETE files with a Bash command
 * (`git mv A B`, `rm old.ts`, `touch new.ts`), which leaves no Edit/Write op — so
 * those changes were invisible in the default (JSONL) Changed view. This parser
 * turns the recorded Bash command strings into structured path ops that the
 * reconstruction step folds in.
 *
 * ## Conservative by design (correctness over recall)
 * Shell is untyped and unbounded; a wrong guess would fabricate a diff. So we ONLY
 * emit an op when the command is unambiguous:
 *   - the statement's first word is a known file command (`mv`/`cp`/`rm`/`touch`,
 *     or `git mv`/`git rm`), optionally behind `sudo`;
 *   - every operand is a plain literal path — NO globs (`* ? [ ] { }`), NO variable
 *     or command substitution (`$`, backticks), NO tilde (unexpanded `~`);
 *   - operand arity matches (mv/cp take exactly 2; rm/touch take ≥1).
 * Anything else is skipped (better a missing op than a fabricated one — the git
 * comparison modes remain the authoritative fallback for whatever we skip).
 *
 * Paths are resolved to ABSOLUTE using a running cwd that starts at the JSONL
 * line's `cwd` and follows in-command `cd` statements (agents routinely
 * `cd repo && git mv ...`). Relative operands with no known cwd are skipped.
 *
 * The parser is intentionally dependency-light and disk-agnostic: it does not know
 * whether a path is a file or a directory (a `mv` target could be either). It emits
 * the literal from/to; the disk-aware resolution (file vs dir, target-is-existing-
 * dir) happens in session-changes.ts where a filesystem reader is available.
 */

import path from 'node:path';

export interface BashFileOp {
  kind: 'create' | 'delete' | 'rename';
  /** Absolute target path (for rename: the destination). */
  path: string;
  /** Absolute source path (rename only). */
  from?: string;
}

/** Characters that make an operand ambiguous — a glob, a shell expansion, or an
 *  unexpanded tilde. Presence of any → we refuse to guess. */
const UNSAFE_OPERAND = /[*?[\]{}$`~]/;

/** True when a token is a plain literal path we can resolve safely. */
function isSafeOperand(tok: string): boolean {
  return tok.length > 0 && !UNSAFE_OPERAND.test(tok);
}

/**
 * Split a shell command into sequential statements at `;`, `&&`, `||`, `|`, and
 * newlines. Separators inside single/double quotes are preserved. This is a
 * best-effort split (no here-docs / subshell awareness) — good enough for the
 * simple file commands we target; anything fancier just yields operands that fail
 * the safety check and get skipped.
 */
function splitStatements(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) { cur += command[++i]!; }
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '\n' || c === ';') { out.push(cur); cur = ''; continue; }
    if ((c === '&' && command[i + 1] === '&') || (c === '|' && command[i + 1] === '|')) {
      out.push(cur); cur = ''; i++; continue;
    }
    if (c === '|') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Tokenize one statement into words, honoring single/double quotes and backslash
 * escapes, and stripping the surrounding quotes from the resulting tokens. A `>`
 * or `>>` redirection operator is emitted as its own token so the caller can spot
 * a created file. Returns null if quoting is unbalanced (skip such statements).
 */
function tokenize(stmt: string): string[] | null {
  const tokens: string[] = [];
  let cur = '';
  let has = false; // whether cur holds a (possibly empty-quoted) token
  let quote: '"' | "'" | null = null;
  const push = () => { if (has) { tokens.push(cur); cur = ''; has = false; } };
  for (let i = 0; i < stmt.length; i++) {
    const c = stmt[i]!;
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === '\\' && quote === '"' && i + 1 < stmt.length) { cur += stmt[++i]!; has = true; continue; }
      cur += c; has = true; continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < stmt.length) { cur += stmt[++i]!; has = true; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { push(); continue; }
    if (c === '>') {
      push();
      if (stmt[i + 1] === '>') { tokens.push('>>'); i++; } else { tokens.push('>'); }
      continue;
    }
    if (c === '<') { push(); tokens.push('<'); continue; }
    cur += c; has = true;
  }
  if (quote) return null; // unbalanced
  push();
  return tokens;
}

/** Resolve an operand against the running cwd → absolute, or null if unresolvable
 *  (relative path with no cwd). Absolute operands pass through. */
function resolveOperand(operand: string, cwd: string | undefined): string | null {
  if (path.isAbsolute(operand)) return path.normalize(operand);
  if (!cwd) return null;
  return path.resolve(cwd, operand);
}

/**
 * Parse all file ops from one Bash command string.
 *
 * @param command  The raw shell command the agent ran.
 * @param cwd      The working directory recorded on the JSONL line (starting cwd).
 */
export function parseBashFileOps(command: string, cwd: string | undefined): BashFileOp[] {
  const ops: BashFileOp[] = [];
  let runningCwd = cwd;

  for (const stmt of splitStatements(command)) {
    const trimmed = stmt.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const rawToks = tokenize(trimmed);
    if (!rawToks || rawToks.length === 0) continue;

    // Separate redirections from the command+operands. A stdout redirect
    // (`> file` / `>> file`, no leading fd) CREATES its target. An fd-numbered
    // redirect (`2>/dev/null`, `1>&2`) is just stream plumbing — strip it as noise
    // so it doesn't disqualify the command (the `git mv … 2>/dev/null || mv …`
    // idiom relies on this). `< file` (input) is stripped too.
    const toks: string[] = [];
    for (let k = 0; k < rawToks.length; k++) {
      const t = rawToks[k]!;
      if (t === '>' || t === '>>') {
        const prev = toks[toks.length - 1];
        const isFdRedirect = prev !== undefined && /^\d+$/.test(prev);
        const target = rawToks[k + 1];
        if (isFdRedirect) toks.pop(); // drop the fd number we already pushed
        else if (target && isSafeOperand(target)) {
          const abs = resolveOperand(target, runningCwd);
          if (abs) ops.push({ kind: 'create', path: abs });
        }
        k++; // skip the redirect target
        continue;
      }
      if (t === '<') { k++; continue; } // input redirect + its source
      toks.push(t);
    }
    if (toks.length === 0) continue;

    // Drop a leading `sudo`.
    let idx = 0;
    if (toks[idx] === 'sudo') idx++;

    let cmd = toks[idx];
    if (!cmd) continue;

    // `cd <dir>` updates the running cwd for subsequent statements.
    if (cmd === 'cd') {
      const dir = toks[idx + 1];
      if (dir && isSafeOperand(dir)) {
        const abs = resolveOperand(dir, runningCwd);
        if (abs) runningCwd = abs;
      }
      continue;
    }

    // `git mv` / `git rm` → treat like mv/rm.
    let isGit = false;
    if (cmd === 'git') {
      const sub = toks[idx + 1];
      if (sub === 'mv') { cmd = 'mv'; isGit = true; idx += 2; }
      else if (sub === 'rm') { cmd = 'rm'; isGit = true; idx += 2; }
      else continue; // other git subcommands don't map to file ops here
    } else {
      idx++;
    }

    if (cmd !== 'mv' && cmd !== 'cp' && cmd !== 'rm' && cmd !== 'touch') continue;

    // Remaining tokens: operands + flags. Flags start with '-' (skip them). We
    // deliberately ignore `--` end-of-options too (drop it).
    const operands: string[] = [];
    let sawUnsafe = false;
    for (let j = idx; j < toks.length; j++) {
      const t = toks[j]!;
      if (t === '--') continue;
      if (t.startsWith('-')) continue; // a flag (e.g. rm -rf, cp -r, git mv -f)
      if (!isSafeOperand(t)) { sawUnsafe = true; break; }
      operands.push(t);
    }
    void isGit;
    if (sawUnsafe || operands.length === 0) continue;

    if (cmd === 'mv' || cmd === 'cp') {
      // Exactly source + dest. (>2 operands = "into a directory" form, ambiguous
      // without disk knowledge of which arg is the dir — skip to stay safe.)
      if (operands.length !== 2) continue;
      const from = resolveOperand(operands[0]!, runningCwd);
      const to = resolveOperand(operands[1]!, runningCwd);
      if (!from || !to) continue;
      if (cmd === 'mv') ops.push({ kind: 'rename', path: to, from });
      else ops.push({ kind: 'create', path: to }); // cp: destination is new content
    } else if (cmd === 'rm') {
      for (const o of operands) {
        const abs = resolveOperand(o, runningCwd);
        if (abs) ops.push({ kind: 'delete', path: abs });
      }
    } else if (cmd === 'touch') {
      for (const o of operands) {
        const abs = resolveOperand(o, runningCwd);
        if (abs) ops.push({ kind: 'create', path: abs });
      }
    }
  }

  return ops;
}
