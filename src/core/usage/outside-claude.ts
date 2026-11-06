/**
 * Claude Code sessions Walnut did not start, read by each host's daemon beside Walnut's own
 * (usage.scan with `outside`). The daemon names every such session with how it began
 * (`entrypoint`) and where (`cwd`); this decides, once per session, which of them count as
 * outside Walnut and notes it in the origin table the Started by filter reads.
 *
 * - A session Walnut has a record of started by `claude -p` (entrypoint `sdk-cli`) is Walnut's
 *   own; one that began in the terminal or another client and was imported is outside.
 * - A session Walnut has no record of is outside, unless usage was already stored for it (a
 *   session whose task was deleted): that usage is Walnut's, and stays so.
 * Walnut's own helper calls (entrypoint `walnut-utility`) are never read here.
 */
import type { ClaudeSessionMeta } from '../../providers/claude-outside-core.js';
import { WALNUT_SESSION_ENTRYPOINTS } from '../../providers/claude-outside-core.js';
import type { CostRollup, RunOrigin } from './cost-rollup.js';
import type { UsageOwner } from './response-store.js';
import { taskIdOfCwd } from './codex-account.js';

export function classifyClaudeOutside(opts: {
  rollup: CostRollup; host: string; metas: ClaudeSessionMeta[]; hasRows: (sessionId: string) => boolean;
  /** Sessions Walnut has a record of on this machine, each with the host name its record uses (a machine reached two ways has two). */
  known: ReadonlyMap<string, string>;
}): UsageOwner[] {
  const { rollup, host } = opts;
  const origins: RunOrigin[] = [];
  const owners: UsageOwner[] = [];
  for (const meta of opts.metas) {
    const known = opts.known.has(meta.sessionId);
    const home = opts.known.get(meta.sessionId) ?? host;
    const before = rollup.originOf(home, meta.sessionId);
    // Rows this pass stored stay its own whatever Walnut learns later (an import of the session included).
    const keptStored = !!before?.stored;
    // Walnut's own entrypoint settles a session it has a record of, even over a look an older build kept as outside.
    const ownEntry = WALNUT_SESSION_ENTRYPOINTS.has(meta.entrypoint);
    let outside: boolean;
    if (known) outside = ownEntry ? false : keptStored || !!meta.entrypoint;
    else {
      // The first look decides and is kept: rows stored later for the session must not turn it into Walnut's.
      if (before) { owners.push({ sessionId: meta.sessionId, taskId: taskIdOfCwd(meta.cwd) }); continue; }
      outside = !opts.hasRows(meta.sessionId);
      owners.push({ sessionId: meta.sessionId, taskId: taskIdOfCwd(meta.cwd) });
    }
    // `stored`: the rows came from this pass, not from a Walnut session's record (an import's day cutoff ignores them).
    origins.push({ host: home, sessionId: meta.sessionId, originator: meta.entrypoint, provider: '', cwd: meta.cwd, outside, stored: (keptStored && !(known && ownEntry)) || (outside && !known), firstAt: '', lastAt: '' });
  }
  rollup.recordOrigins(origins);
  return owners;
}
