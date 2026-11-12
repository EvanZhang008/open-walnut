/**
 * Which files of a checkout a session changed, as its record of edit tools (Edit, Write,
 * MultiEdit) tells: a change made by a command (sed -i, git mv, codegen) is not in it, so a
 * caller says so where it matters (task-work.ts names what else changed there).
 */
import type { SessionRecord } from '../types.js';
import { log } from '../../logging/index.js';
import { LOCAL_HOST } from './planner.js';
import { interruptedByShutdown } from '../server-stopping.js';

const CHANGES_DEADLINE_MS = 60_000;

/**
 * Files the session changed under `repoRoot`, repo-relative, and for each one whose whole
 * history the session's record holds, the sha256 of the file when the session first touched
 * it (`before`): the clear after a move takes a file back only when that equals HEAD, so no
 * other writer's edit sits under the session's. null when the list is unknown.
 */
export async function ownFiles(session: SessionRecord, repoRoot: string, host: string): Promise<{ paths: string[]; before: Record<string, string> } | null> {
  try {
    const { computeSessionChanges } = await import('../session-changes.js');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const res = await Promise.race([
      computeSessionChanges(session.claudeSessionId, session.cwd ?? undefined, host === LOCAL_HOST ? undefined : host, session.outputFile ?? undefined),
      new Promise<null>((r) => { timer = setTimeout(() => r(null), CHANGES_DEADLINE_MS); timer.unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
    if (!res) return null;
    const out = new Set<string>();
    const before: Record<string, string> = {};
    const { createHash } = await import('node:crypto');
    const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
    const until = Date.now() + CHANGES_DEADLINE_MS;
    for (const g of res.groups) {
      if (g.repoRoot.replace(/\/+$/, '') !== repoRoot.replace(/\/+$/, '')) continue;
      for (const f of g.files) {
        if (f.relPath) out.add(f.relPath);
        if (f.oldRelPath) out.add(f.oldRelPath);
        // A rename, or a record that could not be rebuilt whole, never clears.
        if (!f.relPath || f.oldRelPath || f.status === 'renamed') continue;
        let full: { before: string; partial: boolean } | null = res.light ? null : f;
        if (!full && f.filePath && Date.now() < until && Object.keys(before).length < 200) {
          const { fetchSessionFileChangeViaDaemon } = await import('../session-changes.js');
          full = (await fetchSessionFileChangeViaDaemon(session.claudeSessionId, session.cwd ?? undefined, host === LOCAL_HOST ? undefined : host, f.filePath).catch(() => null))?.file ?? null;
        }
        if (full && !full.partial && typeof full.before === 'string') before[f.relPath] = sha(full.before);
      }
    }
    return { paths: [...out], before };
  } catch (err) {
    // This server is stopping: the move pauses (an unknown list would carry only the committed state).
    if (interruptedByShutdown(err)) throw err;
    log.session.info('task move: the session\'s own changes could not be read', { sessionId: session.claudeSessionId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
