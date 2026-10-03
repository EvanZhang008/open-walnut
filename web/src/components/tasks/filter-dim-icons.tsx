/**
 * filter-dim-icons: one 14px glyph per filter property, drawn at the left of
 * the panel menu's filter rows. Same box and stroke as the toolbar icons in
 * common/Icons.tsx (16-unit viewBox, 1.5 stroke, round caps).
 */
import type { ReactNode } from 'react';
import type { FilterDim } from './filter-bar-types';

const P = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

const ICONS: Record<FilterDim, ReactNode> = {
  status: <svg {...P}><circle cx="8" cy="8" r="5.5" strokeDasharray="3 2.2" /></svg>,
  project: <svg {...P}><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z" /></svg>,
  date: <svg {...P}><rect x="2" y="3" width="12" height="11" rx="1.5" /><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" /></svg>,
  source: <svg {...P}><path d="M6.5 9.5l3-3M5 7l-1.75 1.75a2.5 2.5 0 0 0 3.54 3.54L8.5 10.5M7.5 5.5l1.75-1.75a2.5 2.5 0 0 1 3.54 3.54L11 9" /></svg>,
  priority: <svg {...P}><path d="M3 13V9.5M8 13V6M13 13V2.5" /></svg>,
  blocked: <svg {...P}><circle cx="8" cy="8" r="5.5" /><path d="M4.1 4.1l7.8 7.8" /></svg>,
  tags: <svg {...P}><path d="M2.5 8.5V3.5A1 1 0 0 1 3.5 2.5h5l5 5-6 6z" /><circle cx="6" cy="6" r="0.9" fill="currentColor" stroke="none" /></svg>,
  sprint: <svg {...P}><path d="M3.5 14V2.5M3.5 3h8.5l-1.5 3 1.5 3H3.5" /></svg>,
  time: <svg {...P}><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.3l2.2 1.3" /></svg>,
};

/** The View row and the view hits: a window with a sidebar. */
export const ICON_VIEW: ReactNode = <svg {...P}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M6 3v10" /></svg>;

export function dimIcon(dim: FilterDim): ReactNode {
  return ICONS[dim];
}
