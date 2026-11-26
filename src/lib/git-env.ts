/**
 * The environment variables that make a spawned `git` ignore the `cwd` it was
 * given, and the one helper that builds a child env without them.
 *
 * Why this exists: `cwd` reads like "operate on the repo in this directory", but
 * git resolves its target from the environment FIRST — `GIT_DIR` wins over cwd,
 * `GIT_WORK_TREE` relocates the tree, `GIT_INDEX_FILE` moves the index. A child
 * process inherits `process.env` by default, so a Walnut process launched from a
 * context that exported any of them (git exports GIT_DIR while running its own
 * hooks — see scripts/cloud/setup.sh, which unsets them for exactly this reason)
 * would have git-sync auto-commit the data repo's state into somebody else's
 * repository. The test harness hit the same class on 2026-09-20 and put a
 * candidate tree's snapshot on this repo's main branch.
 *
 * Every Walnut call site already knows which repository it means (it passes cwd,
 * or `-C`), so honouring an inherited redirect can only ever be wrong.
 *
 * Deliberately NOT stripped here: `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` and the
 * identity vars. Those name where git reads CONFIG and who authors a commit, not
 * which repo is written, and a user may genuinely keep their credential helper in a
 * non-default config path. The test harness strips those too, because a test needs
 * no outside config at all (tests/setup/git-env-isolation.ts).
 */

import { readOnlyGitEnv } from './leader-home-gate.js';

/** Vars that redirect WHICH repository, index or object store git touches. */
export const GIT_REPO_REDIRECT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
] as const;

/**
 * The env to hand a `git` child: the current environment (`base`, default process.env; a
 * daemon runtime passes its own) plus `extra`, minus every inherited redirect, and with `cwd` in a data home under a
 * leader switch the read-only settings of lib/leader-home-gate.ts readOnlyGitEnv on top. `extra` wins
 * over the inherited value, and an explicit `extra` entry is kept even if it names a
 * redirect: a caller that deliberately sets GIT_DIR is choosing a repo, not inheriting one.
 */
export function gitChildEnv(extra?: NodeJS.ProcessEnv, base: NodeJS.ProcessEnv = process.env, cwd?: string): NodeJS.ProcessEnv {
  // In a data home under a leader switch (only there), optional locks off and no diff index refresh: a read leaves the
  // home byte for byte as it was (lib/leader-home-gate.ts readOnlyGitEnv). Applied after `extra`, so no caller's env
  // turns it back on there; without `cwd` nothing is added.
  const env: NodeJS.ProcessEnv = readOnlyGitEnv({ ...base, ...extra }, cwd ?? '');
  for (const name of GIT_REPO_REDIRECT_VARS) {
    if (extra && name in extra) continue;
    delete env[name];
  }
  return env;
}
