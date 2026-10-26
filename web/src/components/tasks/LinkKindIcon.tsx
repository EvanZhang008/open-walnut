import type { LinkKindGroup } from '../../../../src/core/link-tags';

/**
 * The small glyph before a link pill's name: what kind of link it is (a document, a code review,
 * a ticket or issue, a thread, a web page). The name says which one; the hover card spells the
 * kind out. Drawn in the pill's own color.
 */
export function LinkKindIcon({ group }: { group: LinkKindGroup }) {
  return (
    <svg className="tag-chip-icon" data-kind-group={group} viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      {group === 'doc' && <><path d="M3 1.5h4l2.5 2.5v6.5h-6.5z" /><path d="M7 1.5V4h2.5M4.8 6.5h3M4.8 8.5h3" /></>}
      {group === 'review' && <><circle cx="3.5" cy="2.8" r="1.3" /><circle cx="3.5" cy="9.2" r="1.3" /><circle cx="8.5" cy="9.2" r="1.3" /><path d="M3.5 4.1v3.8M8.5 7.9V5.5a1.6 1.6 0 0 0-1.6-1.6H5.5" /></>}
      {group === 'ticket' && <><circle cx="6" cy="6" r="4.5" /><circle cx="6" cy="6" r="1.2" fill="currentColor" stroke="none" /></>}
      {group === 'thread' && <path d="M2 2.5h8v5.5H5.5L3 10V8H2z" />}
      {group === 'link' && <><path d="M5 7l2-2" /><path d="M6.5 3.2l.7-.7a2 2 0 0 1 2.8 2.8l-.7.7M5.5 8.8l-.7.7a2 2 0 0 1-2.8-2.8l.7-.7" /></>}
    </svg>
  );
}
