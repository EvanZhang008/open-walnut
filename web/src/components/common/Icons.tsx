/**
 * Shared SVG icon library. All icons are 14×14, monochrome, use currentColor.
 * Replaces emoji with clean, consistent, platform-independent icons.
 */
import type { ReactNode } from 'react';

// ── Phase icons (task lifecycle) ──
/** ○ hollow circle — To Do */
export const ICON_PHASE_TODO = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6"/></svg>;
/** ◐ half-filled — In Progress */
export const ICON_PHASE_IN_PROGRESS = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 010 12z" fill="currentColor"/></svg>;
/** ✓ single check — Agent Complete */
export const ICON_PHASE_AGENT_COMPLETE = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>;
/** ☑ shield check — Human Verified */
export const ICON_PHASE_HUMAN_VERIFIED = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1L2 4v4c0 3.3 2.6 6.4 6 7 3.4-.6 6-3.7 6-7V4z"/><path d="M5.5 8l2 2 3.5-4" strokeWidth="1.6"/></svg>;
/** 📦 box — Post-Work Completed */
export const ICON_PHASE_POST_WORK = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2 5l6-3 6 3v6l-6 3-6-3z"/><path d="M2 5l6 3 6-3"/><path d="M8 8v6"/></svg>;
/** ✓✓ double check — Complete */
export const ICON_PHASE_COMPLETE = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M1 8l3 3.5L10.5 4"/><path d="M5.5 8l3 3.5L15 4"/></svg>;

// ── Action / UI icons ──
export const ICON_INFO = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.5v4"/><circle cx="8" cy="5.2" r=".8" fill="currentColor" stroke="none"/></svg>;
export const ICON_STAR_EMPTY = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"><path d="M8 1.5l2 4.1 4.5.6-3.2 3.2.8 4.5L8 11.7l-4.1 2.2.8-4.5L1.5 6.2l4.5-.6z"/></svg>;
export const ICON_STAR_FILLED = <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" strokeWidth="0.5" strokeLinejoin="round"><path d="M8 1.5l2 4.1 4.5.6-3.2 3.2.8 4.5L8 11.7l-4.1 2.2.8-4.5L1.5 6.2l4.5-.6z"/></svg>;
export const ICON_PIN = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="5.5" r="3.5"/><path d="M8 9v5"/></svg>;
export const ICON_PIN_FILLED = <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" strokeWidth="0.5" strokeLinecap="round"><circle cx="8" cy="5.5" r="3.5"/><path d="M8 9v5" stroke="currentColor" strokeWidth="1.5"/></svg>;
export const ICON_CLOSE = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>;
export const ICON_EXPAND = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="10 2 14 2 14 6"/><polyline points="6 14 2 14 2 10"/><line x1="14" y1="2" x2="9" y2="7"/><line x1="2" y1="14" x2="7" y2="9"/></svg>;
// Minimize / "collapse back" — two arrows pointing INWARD toward the centre
// (lucide minimize-2). The old version put the brackets at odd offsets and
// rendered as a lightning-zigzag; this is the standard exit-fullscreen glyph.
export const ICON_COLLAPSE = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="13 7 9 7 9 3"/><polyline points="3 9 7 9 7 13"/><line x1="9" y1="7" x2="14" y2="2"/><line x1="2" y1="14" x2="7" y2="9"/></svg>;
export const ICON_REFRESH = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M1.5 8a6.5 6.5 0 0111.3-4.4"/><polyline points="13 1 13 4.5 9.5 4.5"/><path d="M14.5 8a6.5 6.5 0 01-11.3 4.4"/><polyline points="3 15 3 11.5 6.5 11.5"/></svg>;
export const ICON_SEARCH = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5"/></svg>;
export const ICON_LOCATE = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="8" r="3.5"/><line x1="8" y1="1" x2="8" y2="3.5"/><line x1="8" y1="12.5" x2="8" y2="15"/><line x1="1" y1="8" x2="3.5" y2="8"/><line x1="12.5" y1="8" x2="15" y2="8"/></svg>;
export const ICON_CHAT = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2 2h12v9H5l-3 3V2z"/></svg>;
export const ICON_TERMINAL = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="2" width="14" height="12" rx="2"/><path d="M4 6l3 2.5L4 11"/><path d="M9 11h3"/></svg>;
export const ICON_WARNING = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1L1 14h14z"/><path d="M8 6v4"/><circle cx="8" cy="12" r=".5" fill="currentColor" stroke="none"/></svg>;
export const ICON_LIGHTNING = <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" stroke="none"><path d="M9 1L3 9h4.5L6 15l7-8H8.5z"/></svg>;
export const ICON_CLIPBOARD = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="2" width="10" height="12" rx="1.5"/><path d="M6 2V1h4v1"/><path d="M6 6h4M6 9h4M6 12h2"/></svg>;
export const ICON_NOTES_EXPAND = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 2v12M2 6h12"/></svg>;
/** ⧉ open in new tab — box with an arrow leaving the top-right corner */
export const ICON_NEW_TAB = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H3.5A1.5 1.5 0 002 4.5v8A1.5 1.5 0 003.5 14h8a1.5 1.5 0 001.5-1.5V8"/><polyline points="10 2 14 2 14 6"/><line x1="7" y1="9" x2="14" y2="2"/></svg>;
export const ICON_VSCODE = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2.5v11l-3.2 1.2L5.5 9.8 2.7 12 1 10.7l3-2.7-3-2.7L2.7 4l2.8 2.2 5.3-4.9z"/><path d="M10.8 1.3v13.4M5.5 6.2L8 8l-2.5 1.8"/></svg>;
export const ICON_ROBOT = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="10" height="8" rx="2"/><circle cx="6" cy="9" r="1" fill="currentColor" stroke="none"/><circle cx="10" cy="9" r="1" fill="currentColor" stroke="none"/><path d="M8 2v3"/><circle cx="8" cy="1.5" r="1"/></svg>;
export const ICON_QUESTION = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M6 6a2 2 0 013.5 1.5c0 1-1.5 1.5-1.5 2.5"/><circle cx="8" cy="12" r=".5" fill="currentColor" stroke="none"/></svg>;
export const ICON_TRASH = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2 4h12"/><path d="M5 4V2.5a.5.5 0 01.5-.5h5a.5.5 0 01.5.5V4"/><path d="M3.5 4l.7 9.5a1 1 0 001 .5h5.6a1 1 0 001-.5L12.5 4"/></svg>;
export const ICON_STOP = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/></svg>;
export const ICON_LOCK = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 016 0v2"/></svg>;
export const ICON_UNLOCK = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 015.5-1.2"/></svg>;
// Sliders / filter-options icon — three horizontal tracks each with a knob.
export const ICON_SLIDERS = <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/><circle cx="11" cy="4" r="1.7" fill="var(--bg-elevated,#1c1e24)"/><circle cx="5" cy="8" r="1.7" fill="var(--bg-elevated,#1c1e24)"/><circle cx="10" cy="12" r="1.7" fill="var(--bg-elevated,#1c1e24)"/></svg>;

/**
 * Binary task-state icon — the ONLY glyph pair the interactive task toggle uses:
 * hollow circle = open, single check = done. The 7-phase lifecycle still exists in
 * the data model (and keeps its per-phase COLOR via .task-phase-*), but the shape is
 * deliberately two-valued so a task row reads like a plain todo item.
 */
export function binaryPhaseIcon(isDone: boolean): ReactNode {
  return isDone ? ICON_PHASE_AGENT_COMPLETE : ICON_PHASE_TODO;
}

// ── Phase icon map (for TodoPanel, StatusBadge, ChatMessage) ──
export function phaseIcon(phase: string): ReactNode {
  switch (phase) {
    case 'TODO': return ICON_PHASE_TODO;
    case 'IN_PROGRESS': return ICON_PHASE_IN_PROGRESS;
    case 'AGENT_COMPLETE': return ICON_PHASE_AGENT_COMPLETE;
    case 'HUMAN_VERIFIED': return ICON_PHASE_HUMAN_VERIFIED;
    case 'POST_WORK_COMPLETED': return ICON_PHASE_POST_WORK;
    case 'COMPLETE': return ICON_PHASE_COMPLETE;
    default: return ICON_PHASE_TODO;
  }
}

// ── Focus-tier icons (crosshair / planet+satellite / hourglass) ──
// Stroke-style on purpose: task PHASE icons are filled-circle shapes, so the
// tier marks must read as a different visual family (no plain dots).

export const ICON_TIER_FOCUS = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><circle cx="12" cy="12" r="6.5"/><line x1="12" y1="1.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22.5"/><line x1="1.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22.5" y2="12"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/></svg>;

export const ICON_TIER_SATELLITE = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><circle cx="12" cy="12" r="5"/><path d="M3.3 16.8 A 10.5 10.5 0 0 1 12 1.8" opacity="0.55"/><circle cx="20" cy="17.5" r="2.8" fill="currentColor" stroke="none"/></svg>;

export const ICON_TIER_WAIT = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6.5 3 h11 M6.5 21 h11"/><path d="M8 3 v3.2 c0 2.6 8 4 8 7.3 v4.5 M16 3 v3.2 c0 2.6 -8 4 -8 7.3 v4.5"/></svg>;

/** Tier icon lookup — used by tier section headers, Recent pinned badges, and the kebab menu. */
export function tierIcon(tier: 'focus' | 'satellite' | 'wait'): ReactNode {
  switch (tier) {
    case 'focus': return ICON_TIER_FOCUS;
    case 'wait': return ICON_TIER_WAIT;
    default: return ICON_TIER_SATELLITE;
  }
}

// ── Todo panel section-tab icons ──
// Same stroke family as the tier icons above (the tab strip mixes both), sized
// to 13px so every tab glyph shares one optical weight.

/** ALL — the stacked/combined view (every section at once). */
export const ICON_SECTION_ALL = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3.5" width="18" height="5" rx="1.6"/><rect x="3" y="11" width="18" height="4" rx="1.4" opacity="0.7"/><rect x="3" y="17.5" width="18" height="3.5" rx="1.2" opacity="0.45"/></svg>;

/** RECENT — clock (recently touched tasks). */
export const ICON_SECTION_RECENT = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5.4l3.6 2.4"/></svg>;

/** TASKS — checklist (the full filterable task list). */
export const ICON_SECTION_TASKS = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 6.5l2.2 2.2L10 4.4"/><path d="M3.5 16.5l2.2 2.2L10 14.4"/><path d="M13 7h7.5M13 17h7.5"/></svg>;

/** NOTES — scratchpad page with a folded corner. */
export const ICON_SECTION_NOTES = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5"/><path d="M8.5 13h7M8.5 17h4.5"/></svg>;
