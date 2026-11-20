/**
 * A doc may point only at a file that ships with the repo. A file that exists on disk but that
 * .gitignore keeps out (a new folder under .claude/skills/, which is ignored unless allowlisted)
 * passes an existsSync check here and is missing everywhere else: 2026-11-20, the
 * walnut-ui-requirements skill landed without its SKILL.md and the deep test failed on GitHub.
 */
import { execFileSync } from 'node:child_process';

/** The repo-relative paths git ignores and does not track (a tracked file never counts). */
export function ignoredByGit(root: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  try {
    const out = execFileSync('git', ['check-ignore', '--', ...paths], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.split('\n').filter(Boolean).sort();
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    // 1: none is ignored; 128: not a git checkout (a release tarball), nothing to tell.
    if (e.status === 1 || e.status === 128) return [];
    throw err;
  }
}
