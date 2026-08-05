import crypto from 'node:crypto';

/**
 * Generate a short unique ID: base36 timestamp + 4 random chars.
 */
export function generateId(): string {
  const timePart = Date.now().toString(36);
  const randPart = crypto.randomBytes(2).toString('hex');
  return `${timePart}-${randPart}`;
}

/**
 * Priority display symbol.
 */
export function prioritySymbol(priority: string): string {
  switch (priority) {
    case 'immediate': return '!!!';
    case 'important': return '!!';
    case 'backlog': return '!';
    case 'none': return '';
    default: return '';
  }
}

/**
 * Format ISO date string to a short display form.
 */
export function shortDate(isoString: string): string {
  const d = new Date(isoString);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${min}`;
}

/**
 * Project name for a remote list display name.
 *
 * Projects are the single grouping layer, so a new list is named after the
 * project verbatim. Legacy MS To-Do lists still carry the retired two-level
 * "Category / Project" encoding, so a pull keeps splitting on " / " and takes
 * the trailing segment as the project name (the leading category segment is
 * dropped — the registry's `remote_list` alias remembers the full display name
 * so pushes keep landing in the same remote list).
 *
 * "Work / VPA" → "VPA";  "A / B / C" → "B / C";  "personal" → "Personal".
 *
 * NOTE: this is the raw split only. Sync pulls must go through
 * `routePulledListToProject` so the retired grouping names route to Inbox.
 */
export function parseProjectFromListName(listDisplayName: string): string {
  const sep = ' / ';
  const raw = (listDisplayName ?? '').trim();
  const idx = raw.indexOf(sep);
  // Trim the extracted segment too: "Work / VPA " must yield "VPA", not "VPA ".
  // The registry trims on insert but JS-side lookups compare lowercase WITHOUT
  // trimming, so a trailing space here made a task invisible in its project lane
  // and re-dirtied the delta-pull catch-up on every sync tick.
  if (idx === -1) return titleCase(raw);
  return titleCase(raw.slice(idx + sep.length).trim());
}

/**
 * The retired hardcoded quick-add landing group ("<any category> / Quick Start").
 * It was a routing artifact, never a real project.
 */
export function isRetiredQuickStartGroup(name: string): boolean {
  return (name ?? '').trim().toLowerCase() === 'quick start';
}

/** The retired "Inbox" grouping name. Inbox is now the ABSENCE of a project. */
export function isLegacyInboxGroup(name: string): boolean {
  return (name ?? '').trim().toLowerCase() === 'inbox';
}

/**
 * Local project for a remote list a sync pull just read. '' = Inbox.
 *
 * WHY this exists (do not inline `parseProjectFromListName` on a pull path):
 * the v4→v5 migration routes the degenerate legacy groups to Inbox — 'Quick
 * Start' under ANY category, and the 'Inbox' category itself (see
 * `promoteLegacyGroup` in src/core/task-db.ts). The remote lists still carry
 * those names ("Passion / Quick Start", "Inbox / Quick Start", "Inbox"), so a
 * pull that only split the name would re-create 'Quick Start'/'Inbox' as real
 * projects and its catch-up pass would rewrite `project='Quick Start'` back onto
 * the migrated tasks — i.e. sync would silently undo the migration. The two
 * sides MUST apply the same rule, so both call into these predicates.
 *
 * Remote lists are never touched: only the LOCAL project mapping changes.
 */
export function routePulledListToProject(listDisplayName: string): string {
  const raw = (listDisplayName ?? '').trim();
  if (!raw) return '';
  // Whole list name is the legacy Inbox group (mirrors promoteLegacyGroup's
  // degenerate branch for category 'Inbox').
  if (isLegacyInboxGroup(raw)) return '';
  const project = parseProjectFromListName(raw);
  if (isRetiredQuickStartGroup(project)) return '';
  return project;
}

/** Capitalize the first letter of a string, preserving the rest. */
function titleCase(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Status display symbol.
 */
export function statusSymbol(status: string): string {
  switch (status) {
    case 'todo': return '○';
    case 'in_progress': return '◐';
    case 'done': return '●';
    default: return '?';
  }
}
