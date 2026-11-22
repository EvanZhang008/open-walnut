/**
 * One-letter provider badge next to a project name — glanceable "where does
 * this project sync". Local projects render NOTHING (no badge = local), so the
 * common case stays clean and only synced projects carry a mark.
 *
 * It is the one `.badge` (a count's square, styles/badge.css); an unknown
 * provider shows its first letter.
 */

const KNOWN: Record<string, { ch: string; title: string }> = {
  'ms-todo': { ch: 'M', title: 'Synced with Microsoft To Do' },
  'jira': { ch: 'J', title: 'Synced with Jira' },
};

export function ProjectSourceBadge({ source }: { source?: string }) {
  if (!source || source === 'local') return null;
  const known = KNOWN[source];
  return (
    <span
      className="badge badge-count project-src-badge"
      title={known?.title ?? `Synced with ${source}`}
    >
      {known?.ch ?? source.charAt(0).toUpperCase()}
    </span>
  );
}
