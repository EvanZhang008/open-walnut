/**
 * The files a task names, and which host has them (2026-11-05: a review task whose brief
 * was a file on clouddev, `/home/me/.local/state/open-walnut/tasks/<id>/review-brief-codex.md`,
 * was placed by load on another Mac that had none of it, and its agent spent the start
 * looking for the brief). Placement (hosts/placement.ts) reads a task's text for absolute
 * paths, asks each host it weighs which of them exist there, and never sends the work to
 * a host that has fewer of them than another.
 *
 * Only absolute paths (`/a/b`, `~/a`) of at least two parts count: a relative name means
 * nothing without its folder, and a route like `/api` is one part. A path that exists on
 * no host weighed (an example, a file still to be written) asks for nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePathRef } from '../../providers/path-ref-parse.js';

/** At most this many paths are checked per task (each is one stat per host). */
const MAX_PATHS = 12;
/** One host's answer for every path, at most (a slow host is "could not check"). */
const CHECK_MS = 4_000;

// A path starts the text or follows a space, a quote, a bracket, `=`, `,` or `;`, so never
// inside a URL (`https://x/y`: its `/` follows `:` or `/`) or a word (`a/b`, `../a`). Any
// character but a space, a quote, a bracket and a few separators belongs to it (a
// folder name in another script included).
const PATH_RE = /(?:^|(?<=[\s"'`(<[{=,;]))(~?\/[^\s"'`()<>[\]{},;|*?]+)/g;

/** A path in quotes or backticks, on one line: absolute, or relative (`"./review notes/a.md"`). */
const QUOTED_RE = /(["'`])((?:~|\.\.?)?\/[^"'`\n]+)\1/g;

/** A home folder alone (`/Users/me`, `/home/me`) says nothing about where the work goes. */
const HOME_ONLY = /^(?:\/local)?\/(?:Users|home)\/[^/]+$/;

/**
 * The absolute paths `text` names, in order, each once (trailing punctuation dropped),
 * at most `max` (12) of those `keep` takes. With `cwd`, a path relative to it (`./brief.md`,
 * `../notes/plan.md`) counts too, as the absolute path it names (review round 4, Sol).
 */
export function namedPaths(text: string, keep: (p: string) => boolean = () => true, opts: { cwd?: string; max?: number } = {}): string[] {
  const max = opts.max ?? MAX_PATHS;
  const out: string[] = [];
  const add = (raw: string) => {
    // A position after the path (`:42`, `:42:7`, `#L10-L20`) is not part of it (path-ref-parse.ts).
    const p = parsePathRef(raw.replace(/[.,=!]+$/, '')).path.replace(/[.,=!]+$/, '').replace(/(.)\/+$/, '$1');
    if (out.length >= max || p.split('/').filter(Boolean).length < 2 || HOME_ONLY.test(p)) return;
    if (!out.includes(p) && keep(p)) out.push(p);
  };
  // A quoted path is the whole quote, spaces included ("/a/review notes/brief.md"); the
  // rest of the text is read with the quotes blanked out.
  const base = opts.cwd?.replace(/\/+$/, '');
  const rest = text.replace(QUOTED_RE, (q: string, _quote: string, inner: string) => {
    // A relative one is whole too, as the absolute path it names with `cwd` (review round 6, Sol).
    if (inner.startsWith('.')) {
      const rel = parsePathRef(inner.replace(/[.,=!]+$/, '')).path;
      if (base && !/^\.\.?\/?$/.test(rel)) add(path.posix.normalize(`${base}/${rel}`));
      return ' '.repeat(q.length);
    }
    add(inner);
    // A quote that holds more than a path ("/a/b.md, then reply"): its paths too.
    // A part cut at a space inside the path ("/a/review" of "/a/review notes/b.md") is not one.
    if (/\s/.test(inner)) {
      for (const m of inner.matchAll(PATH_RE)) if (!/^\s/.test(inner.slice(m.index! + m[0].length))) add(m[1]);
    }
    return ' '.repeat(q.length);
  });
  for (const m of rest.matchAll(PATH_RE)) add(m[1]);
  if (base) {
    for (const m of rest.matchAll(REL_RE)) {
      const rel = parsePathRef(m[1].replace(/[.,=!]+$/, '')).path.replace(/[.,=!]+$/, '');
      if (rel === '.' || rel === '..' || rel === './' || rel === '../') continue;
      add(path.posix.normalize(`${base}/${rel}`));
    }
  }
  return out;
}

/** A path relative to the folder the work runs in, written as one (`./a`, `../a/b`). */
const REL_RE = /(?:^|(?<=[\s"'`(<[{=,;]))(\.\.?\/[^\s"'`()<>[\]{},;|*?]+)/g;

/** More paths than placement checks (MAX_PATHS): a start that names this many stays where it is. */
export function namesTooManyPaths(text: string, cwd?: string): boolean {
  return namedPaths(text, () => true, { cwd, max: MAX_PATHS + 1 }).length > MAX_PATHS;
}

/**
 * A file in a Walnut task's own directory (`.../open-walnut/tasks/<id>/...`): written for
 * a task (a brief, a plan, a diff), so the work goes to the host that has it even when
 * the host it would use has room (isWorkFile names the other files that do).
 */
export function isTaskDirPath(p: string): boolean {
  return /\/open-walnut\/tasks\/[^/]+\/./.test(p);
}

/**
 * A file the work reads (a brief, a plan, notes, data, a picture) rather than a place or a
 * program: a task directory's file, or a document's or data file's name outside the system's own
 * folders. The host a start would use must have these, so one it lacks takes the work to a host
 * that has them (hosts/placement.ts; review round 5: "/srv/projects/<repo>/docs/plan.md" only on
 * clouddev). An app ("/Applications/Walnut.app"), a folder or source code never does (review
 * round 1): the repository's own check covers code.
 */
export function isWorkFile(p: string): boolean {
  if (isTaskDirPath(p)) return true;
  if (/^\/(Applications|System|Library|usr|opt|etc|bin|sbin|private|var|proc|dev)\//.test(p)) return false;
  return /\.(md|markdown|txt|rst|json|jsonl|ya?ml|toml|csv|tsv|log|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|heic|svg|mp4|mov|html?|diff|patch|ipynb)$/i.test(p);
}

/** `p` is `dir` or inside it. */
export function isUnder(p: string, dir: string): boolean {
  const d = dir.replace(/\/+$/, '');
  return !!d && (p === d || p.startsWith(`${d}/`));
}

export interface PathsOnHost {
  /** The paths that exist on the host. */
  present: string[];
  /** The paths it does not have. */
  missing: string[];
}

/** Test seam: what a host answers for `paths`. */
type Checker = (host: string, paths: string[]) => Promise<PathsOnHost | null>;
let checker: Checker | null = null;
export function __setPathsCheckerForTesting(c: Checker | null): void { checker = c; }

/**
 * Which of `paths` exist on `host` (`__local__` = this Mac), or null when it could not
 * be asked in time. A remote host is asked through its daemon's `fs.stat` (it expands
 * `~/` to its own home); this Mac answers itself.
 */
export async function pathsOnHost(host: string, paths: string[]): Promise<PathsOnHost | null> {
  if (paths.length === 0) return { present: [], missing: [] };
  if (checker) return checker(host, paths);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exists = await Promise.race([
      host === '__local__' ? Promise.all(paths.map(localExists)) : remoteExists(host, paths),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), CHECK_MS); timer.unref?.(); }),
    ]);
    if (!exists) return null;
    return { present: paths.filter((_, i) => exists[i]), missing: paths.filter((_, i) => !exists[i]) };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function localExists(p: string): Promise<boolean> {
  const abs = p === '~' || p.startsWith('~/') ? `${os.homedir()}${p.slice(1)}` : p;
  return fs.promises.stat(abs).then(() => true, () => false);
}

async function remoteExists(host: string, paths: string[]): Promise<boolean[]> {
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js');
  // Only a link already open: placement never dials a host to ask (as for its load).
  if (!getConnectedDaemonConnection(host)) throw new Error('not connected');
  const { DaemonFileReader } = await import('../daemon-file-reader.js');
  const reader = new DaemonFileReader(host);
  return Promise.all(paths.map(async (p) => (await reader.stat(p)) !== null));
}

/**
 * The names in a folder on a host: [] when it does not exist, null when the host cannot be
 * asked (not connected, no answer in 4 s, an error other than a missing folder).
 */
export async function dirEntries(host: string, dir: string): Promise<string[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ask = async (): Promise<string[] | null> => {
    if (!host || host === '__local__' || host === 'local') {
      try {
        return await fs.promises.readdir(dir.replace(/^~(?=\/)/, os.homedir()));
      } catch (err) {
        return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? [] : null;
      }
    }
    const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js');
    const conn = getConnectedDaemonConnection(host);
    if (!conn) return null;
    const res = await conn.send('fs.ls', { path: dir }) as { ok?: boolean; error?: string; entries?: Array<{ name: string }> };
    if (res?.ok === false) return /ENOENT|no such file|does not exist/i.test(String(res.error ?? '')) ? [] : null;
    return Array.isArray(res?.entries) ? res.entries.map((e) => e.name) : null;
  };
  try {
    return await Promise.race([
      ask(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), CHECK_MS); timer.unref?.(); }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
