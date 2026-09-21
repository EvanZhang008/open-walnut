/**
 * Strip the git environment variables that override a spawned git's `cwd`.
 *
 * Loaded via `setupFiles`, so it runs INSIDE every vitest worker before any test
 * module is imported — same channel and same reason as runtime-dir-isolation.ts
 * (env that must hold inside a worker has to be set inside the worker;
 * `globalSetup` only covers the runner and what the runner spawns).
 *
 * What it protects (2026-09-20 incident)
 * --------------------------------------
 * Roughly twenty test files build a throwaway repo and drive real git through
 * `execSync(cmd, { cwd: tmpDir })`. `cwd` is not authoritative: GIT_DIR and
 * GIT_WORK_TREE win over it, and execSync inherits `process.env`. A session that
 * had exported those vars while assembling a candidate tree then ran the quick
 * tier from that tree, so every git call in those files addressed the REAL
 * open-walnut repo instead of its temp dir:
 *
 *   - `git init -q -b main` re-initialised the real repo and, because the cwd
 *     differed from the repo root, wrote `core.worktree = <candidate dir>`;
 *   - `git config user.email t@t && git config user.name t` overwrote the
 *     maintainer's identity in the real .git/config;
 *   - `git add -A && git commit -q -m init` committed the candidate snapshot onto
 *     main as af34664d, deleting 35 paths another agent had just committed
 *     (a whole iOS feature) and tracking node_modules as symlinks.
 *
 * Nothing was pushed and no worktree file was lost, but main needed a reset and
 * the config a repair. The same class already bit scripts/cloud/setup.sh, which
 * unsets these two vars because git exports them while running hooks.
 *
 * Scope: only vars that change WHICH repository, index, object store or config
 * git touches. Identity vars (GIT_AUTHOR_*, GIT_COMMITTER_*) are left alone —
 * they cannot redirect a write, and a test that wants them sets them itself.
 * A test is also free to set any of these AFTER setup (git-sync.test.ts sets
 * GIT_CONFIG_GLOBAL and restores it); this only clears what was INHERITED.
 */
import { GIT_REPO_REDIRECT_VARS } from '../../src/lib/git-env.js';

/**
 * Vars that make git ignore the cwd a test asked for.
 *
 * The repo-targeting half is shared with the production guard
 * (`src/lib/git-env.ts`, which the server's own git spawns use) so there is one
 * list to keep current. Tests strip MORE than production does: a test needs no
 * outside config at all, while a user may legitimately keep their credential
 * helper in a config path named by GIT_CONFIG_GLOBAL.
 */
export const GIT_REDIRECT_ENV_VARS = [
  ...GIT_REPO_REDIRECT_VARS,
  'GIT_CEILING_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
] as const;

/**
 * Remove every inherited redirect from `env`, and return the names removed so a
 * caller can log or assert on them.
 *
 * `GIT_CONFIG_COUNT` carries numbered `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`
 * companions, so the numbered pairs are swept by prefix rather than by a fixed
 * list — leaving them behind would keep applying an outside caller's `-c`
 * overrides to every test repo.
 */
export function stripGitRedirectEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const name of GIT_REDIRECT_ENV_VARS) {
    if (env[name] !== undefined) {
      delete env[name];
      removed.push(name);
    }
  }
  for (const name of Object.keys(env)) {
    if (name === 'GIT_CONFIG_COUNT' || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}

const removed = stripGitRedirectEnv();
if (removed.length > 0) {
  // Loud on purpose: a run that inherited these was addressing another repo, and
  // whoever launched it needs to fix their launcher, not just enjoy the rescue.
  console.warn(
    `[git-env-isolation] removed inherited git env (${removed.join(', ')}) — `
    + 'without this, every test git call would have targeted that repo instead of its temp dir.',
  );
}
