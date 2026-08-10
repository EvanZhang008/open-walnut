/**
 * One-letter provider badge next to a project name — glanceable "where does
 * this project sync". Local projects render NOTHING (no badge = local), so the
 * common case stays clean and only synced projects carry a mark.
 *
 * Colors live in CSS (.project-src-badge--<source> in globals.css) so they can
 * adapt to the dark theme; unknown providers fall back to the neutral variant
 * with their first letter.
 */

const KNOWN: Record<string, { ch: string; title: string }> = {
  'ms-todo': { ch: 'M', title: 'Synced with Microsoft To Do' },
  'jira': { ch: 'J', title: 'Synced with Jira' },
};

export function ProjectSourceBadge({ source }: { source?: string }) {
  if (!source || source === 'local') return null;
  const known = KNOWN[source];
  const variant = known ? source : 'generic';
  return (
    <span
      className={`project-src-badge project-src-badge--${variant}`}
      title={known?.title ?? `Synced with ${source}`}
    >
      {known?.ch ?? source.charAt(0).toUpperCase()}
    </span>
  );
}
