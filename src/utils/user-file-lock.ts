/**
 * The lock for a file a person edits: a file in a repo or a session's working folder, a note in
 * the vault. Use `withUserFileLock` for those; `withFileLock` is for Walnut's own stores.
 *
 * `withFileLock` keeps its lock beside the file (`<file>.lock`). Beside someone else's file that
 * is wrong twice over: the path can already be theirs (a `Gemfile.lock` is the lock path of a
 * `Gemfile`; before the 2026-10-05 fix an old one was deleted as a stale lock on every save of
 * the Gemfile), and the lock dirs show up in git status, editors and sync tools. So such a file is
 * locked under WALNUT_HOME/locks, named by the sha256 of its resolved path: every writer of one
 * file (the Files panel, the notes editor, an agent) takes the same lock whatever path, symlink
 * or letter case it came in by.
 *
 * A path that resolves into Walnut's own data (WALNUT_HOME or the daemon dir, outside the notes
 * vault) keeps `<file>.lock`: that is the lock its store code takes, so a Files panel save of a
 * store still excludes the store's own writer.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { LOG_DIR, NOTES_DIR, WALNUT_HOME } from '../constants.js';
import { withFileLock } from './file-lock.js';

/** The real path: symlinks resolved (and, on macOS, the letter case on disk). A path that does
 *  not exist yet resolves through its nearest existing folder. */
async function resolveReal(p: string): Promise<string> {
  const abs = path.resolve(p);
  try {
    return await fsp.realpath(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(await resolveReal(parent), path.basename(abs));
  }
}

function isInside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The path `withUserFileLock` hands to `withFileLock` for `filePath`. */
export async function userFileLockTarget(filePath: string): Promise<string> {
  const [real, home, daemonDir, vault] = await Promise.all(
    [filePath, WALNUT_HOME, LOG_DIR, NOTES_DIR].map(resolveReal),
  );
  if ((isInside(real, home) || isInside(real, daemonDir)) && !isInside(real, vault)) return real;
  return path.join(WALNUT_HOME, 'locks', crypto.createHash('sha256').update(real).digest('hex'));
}

/** `withFileLock` for a file a person edits; see the top of this file. */
export async function withUserFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(await userFileLockTarget(filePath), fn);
}
