/**
 * The class list of the console's one label (styles/badge.css; standard.md, "Status labels").
 * `badge('accent')` -> "badge badge-accent"; a button or span takes it next to its own layout class.
 */
export type BadgeTone = 'neutral' | 'accent' | 'warning' | 'error' | 'alert';

/** `long`: a label that names a time or a sentence (Wait until ..., Due Mon 6:53) keeps a soft corner; every other label is round. */
export function badge(tone: BadgeTone = 'neutral', opts: { count?: boolean; paused?: boolean; long?: boolean } = {}): string {
  return ['badge', tone !== 'neutral' && `badge-${tone}`, opts.count && 'badge-count', opts.paused && 'badge-paused', opts.long && 'badge-long']
    .filter(Boolean)
    .join(' ');
}

/** A priority as a badge tone (immediate red, important amber, the rest grey). */
export function priorityTone(priority: string): BadgeTone {
  if (priority === 'immediate' || priority === 'high') return 'error';
  if (priority === 'important' || priority === 'medium') return 'warning';
  return 'neutral';
}

/** A letter's kind (human inbox) as a badge: a decision amber, a review blue, the rest grey. */
export function letterTypeBadge(type: string): string {
  return badge(type === 'action_required' ? 'warning' : type === 'review' ? 'accent' : 'neutral');
}
