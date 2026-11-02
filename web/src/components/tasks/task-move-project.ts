/**
 * Pure helpers for "drag a task into another project".
 *
 * Two questions the panel has to answer before it can move a task, both of which
 * are answerable without React: does this move cross a provider boundary (so the
 * user must confirm the destructive twin archival first), and which project run
 * did the card actually land in?
 *
 * Kept side-effect free so they can be tested without mounting TodoPanel:
 * tests/web/task-move-project.test.ts.
 */

/** Outcome of the cross-source question. `from`/`to` are provider source ids
 *  ('local' | 'ms-todo' | …) — only meaningful for the confirm copy. */
export interface MoveMigration {
  migrates: boolean;
  from: string;
  to: string;
  /** Moved into a project of another service: it stays local there until someone
   *  chooses Sync, so nothing is sent to `to` by the move. */
  held?: boolean;
}

/** Human name for a provider source id, for dialog copy ("Microsoft To Do", not
 *  "ms-todo"): the plugin's own name when the integrations list is known, else a
 *  built-in one. Unknown ids pass through verbatim — better a raw id than a lie. */
export function sourceDisplayName(source: string, plugins?: ReadonlyArray<{ id: string; name: string }>): string {
  const named = plugins?.find((p) => p.id === source)?.name;
  if (named) return named;
  const KNOWN: Record<string, string> = {
    'local': 'Local',
    'ms-todo': 'Microsoft To Do',
    'jira': 'Jira',
  };
  return KNOWN[source] ?? source;
}

/**
 * Would moving `taskSource` into `targetProject` take the task off its service (the
 * old remote twin renamed "[Moved] …" + marked complete)?
 *
 * Mirrors the project-move branch of updateTask in src/core/task-manager.ts:
 *  - Inbox ('') is structurally local-only and never claimed → target 'local'.
 *  - A project the registry doesn't know yet is created LOCAL (never the task's
 *    own service), so a synced task moved there leaves its service.
 *  - A LOCAL task filed under a provider-claimed project stays local (the
 *    project is just a folder here, nothing is pushed).
 *  - A synced task moved into a project of ANOTHER service leaves its own and
 *    stays local there (`held`): nothing is sent to the destination's service
 *    until someone chooses Sync. A move never pushes a task to a new service.
 *  - A synced task moved to a local project or the Inbox leaves its service.
 *
 * KNOWN BLIND SPOT: the mirror covers REGISTRY claims only. A claim that lives
 * solely in `plugins.<id>.project` config (registry row lost in a restore) is
 * invisible to /api/projects, so the server migrates through
 * validateProjectSource while this returns migrates:false — the move proceeds
 * without a confirm. Closing it needs the config claims exposed to the client.
 *
 * @param taskSource the dragged task's `source` (undefined is treated as local)
 * @param targetProject destination project name; '' = Inbox
 * @param sourceByName lowercased project name → source, from useProjectRegistry
 */
export function resolveMoveMigration(
  taskSource: string | undefined,
  targetProject: string,
  sourceByName: Map<string, string>,
): MoveMigration {
  const from = taskSource ?? 'local';
  // Trim first — the backend trims before its registry lookup, and an untrimmed
  // name that misses the lookup here would silently read as "unknown → no confirm".
  const requested = targetProject.trim();
  // Inbox has no registry row; every other name must be looked up case-insensitively
  // (project identity is NOCASE server-side). An unknown name is created local.
  const to = requested === ''
    ? 'local'
    : sourceByName.get(requested.toLowerCase()) ?? 'local';
  // Local stays local: folder-only move, no remote twin is ever created.
  if (from === 'local') return { migrates: false, from, to };
  if (to === from) return { migrates: false, from, to };
  return { migrates: true, from, to, ...(to !== 'local' ? { held: true } : {}) };
}

/**
 * Which project run did the dragged card land in, within a project-clustered tier?
 *
 * PRECONDITION, and the only thing that makes this function mean anything: the
 * caller must pass an array the drop ACTUALLY MOVED THE CARD IN — a cross-tier
 * array dragOver spliced it into, or a reorder array built from the drop target.
 * It answers from the card's NEIGHBOURS, so handing it the tier's AT-REST order
 * makes it re-read where the card already lived rather than where it landed, and
 * `prev` winning then reports "the run ABOVE you" for the first card of any run.
 * That is a silent reprojection with no visible gesture, and it shipped twice (a
 * 12px twitch, then a 40px sideways slip); TodoPanel's maybeMoveProject now calls
 * this only for the spliced cases and reads dnd-kit's own aim record otherwise.
 *
 * Given that array, the tier's id order is all there is: folder labels are plain
 * DOM, not sortable items, so the only evidence of "which folder is this slot
 * inside" is the neighbours. Walk outward from the dragged card to the nearest ids
 * that map to a project, skipping ids with no project (group chip sentinels,
 * unknown ids).
 *
 * When the two neighbours disagree the card sits at a run boundary, and `prev`
 * wins: visually the card is at the BOTTOM of the previous folder because the
 * next run's folder label renders below the drop point.
 *
 * @param finalIds the tier's final id order, group chip sentinels included
 * @param activeId the dragged card's id
 * @param projectOf id → project ('' = Inbox, a REAL value); undefined = no project
 * @returns the landed project, or null for "no information" (never use '' for that)
 */
export function inferTierDropProject(
  finalIds: string[],
  activeId: string,
  projectOf: (id: string) => string | undefined,
): string | null {
  const at = finalIds.indexOf(activeId);
  if (at === -1) return null;

  // prev wins outright: it is both the agreeing answer when the neighbours match
  // and the winning one when they straddle a run boundary, so next is only ever
  // consulted when there is nothing above the drop point at all.
  for (let i = at - 1; i >= 0; i--) {
    const p = projectOf(finalIds[i]);
    if (p !== undefined) return p;
  }
  for (let i = at + 1; i < finalIds.length; i++) {
    const p = projectOf(finalIds[i]);
    if (p !== undefined) return p;
  }
  return null;
}
