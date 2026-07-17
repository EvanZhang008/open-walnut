/**
 * Unified ranking for the session path selector — ONE scorer for all input
 * states (browse / dir-browse / segment / scoped-search).
 *
 * Sort keys, in priority order:
 *   1. history/frequent hit → top, ordered by frecency (recency-decayed count)
 *   2. match position: leaf-segment hit > mid-path hit
 *   3. match quality: prefix > contiguous substring > subsequence
 *   4. shallower depth first, then alphabetical
 *
 * Admission rule (user-verified "Marina" example): a LIVE deep candidate whose
 * only match is a middle segment (leafHit=false) is shown ONLY if it's in
 * history — otherwise it's noise and is dropped entirely.
 *
 * Pure functions — no React, no IO.
 */

import { matchQuality, qualityRank, fuzzyScore, type MatchQuality } from '@/utils/fuzzy';
import type { WorkingDirEntry } from '@/api/sessions';
import type { InputState } from './input-model';

/** Frecency: count decayed by age with a ~7-day half-life. */
const FRECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

export function frecencyScore(count: number, lastUsedIso: string, now: number = Date.now()): number {
  const age = Math.max(0, now - new Date(lastUsedIso).getTime());
  return count * Math.exp(-(age * Math.LN2) / FRECENCY_HALF_LIFE_MS);
}

export interface Candidate {
  cwd: string;
  host: string | null;
  hostLabel?: string;
  /** live = from a directory listing (confirmed to exist); history = frequent-dirs entry. */
  source: 'live' | 'history';
  /** Depth relative to the listed parent (1 = direct child). 0 for history-only entries. */
  depth: number;
  /** Set when this cwd is ALSO a history/frequent entry (marker + frecency source). */
  history?: WorkingDirEntry;
}

export interface RankedItem extends Candidate {
  quality: MatchQuality;
  leafHit: boolean;
  frecency: number;
}

function leafOf(cwd: string): string {
  const p = cwd.replace(/\/+$/, '');
  return p.slice(p.lastIndexOf('/') + 1);
}

/** The needle a given input state matches candidates against ('' = admit all). */
function needleOf(state: InputState): string {
  switch (state.kind) {
    case 'browse': return state.query.trim();
    case 'dir-browse': return '';
    case 'segment': return state.partial;
    case 'scoped-search': return state.keyword;
  }
}

export function rankCandidates(state: InputState, candidates: Candidate[], now: number = Date.now()): RankedItem[] {
  const needle = needleOf(state);

  const ranked: RankedItem[] = [];
  for (const c of candidates) {
    const frecency = c.history ? frecencyScore(c.history.count, c.history.lastUsed, now) : 0;
    if (!needle) {
      ranked.push({ ...c, quality: 'prefix', leafHit: true, frecency });
      continue;
    }
    const leafQ = matchQuality(needle, leafOf(c.cwd));
    if (leafQ !== 'none') {
      ranked.push({ ...c, quality: leafQ, leafHit: true, frecency });
      continue;
    }
    // Leaf doesn't match — check the rest of the path (mid-segment hit).
    // browse mode matches loosely across the whole path (multi-token fuzzy);
    // path modes require a real quality band on the path string.
    const pathQ: MatchQuality = state.kind === 'browse'
      ? (fuzzyScore(needle, c.cwd) > 0 ? 'substring' : 'none')
      : matchQuality(needle, c.cwd);
    if (pathQ === 'none') continue;
    // ADMISSION RULE: live deep candidates matching only mid-path are shown
    // only when they're in history (otherwise pure noise).
    if (c.source === 'live' && !c.history) continue;
    ranked.push({ ...c, quality: pathQ, leafHit: false, frecency });
  }

  ranked.sort((a, b) => {
    const aHist = a.history ? 1 : 0;
    const bHist = b.history ? 1 : 0;
    if (aHist !== bHist) return bHist - aHist;                       // 1. history hits on top
    if (aHist && bHist && a.frecency !== b.frecency) return b.frecency - a.frecency; //    ...by frecency
    if (a.leafHit !== b.leafHit) return Number(b.leafHit) - Number(a.leafHit);       // 2. leaf > mid
    const qd = qualityRank(b.quality) - qualityRank(a.quality);
    if (qd !== 0) return qd;                                         // 3. prefix > substring > subseq
    if (a.depth !== b.depth) return a.depth - b.depth;               // 4. shallower first
    return a.cwd.localeCompare(b.cwd);                               //    then alphabetical
  });
  return ranked;
}

export interface Section {
  id: string;
  /** Display label, e.g. "📁 subdirectories" or a host name for grouped mode. */
  label: string;
  /** Host key this section belongs to ('__local__' for local). */
  hostKey: string;
  items: RankedItem[];
}

export interface BuildSectionsOpts {
  /** All-tab path mode: group by host (local first, then by history activity). */
  hostGrouping: boolean;
  /** Per-host activity (sum of history counts) for remote-host ordering. */
  hostActivity: Map<string, number>;
}

const hostKeyOf = (c: Candidate): string => c.host ?? '__local__';

/**
 * Build display sections from ranked items.
 *  - hostGrouping: one section per host; local ALWAYS first, remotes by activity desc.
 *  - single host: "🕘 history" section (history-only entries) then "📁 subdirectories"
 *    (live entries — items also in history carry the marker via `history`).
 *  Items keep their ranked order within each section.
 */
export function buildSections(ranked: RankedItem[], opts: BuildSectionsOpts): Section[] {
  if (opts.hostGrouping) {
    const byHost = new Map<string, RankedItem[]>();
    for (const item of ranked) {
      const key = hostKeyOf(item);
      const arr = byHost.get(key);
      if (arr) arr.push(item);
      else byHost.set(key, [item]);
    }
    const hostKeys = Array.from(byHost.keys()).sort((a, b) => {
      if (a === '__local__') return -1;
      if (b === '__local__') return 1;
      return (opts.hostActivity.get(b) ?? 0) - (opts.hostActivity.get(a) ?? 0);
    });
    return hostKeys.map(key => ({
      id: `host:${key}`,
      label: key === '__local__' ? 'Local' : (byHost.get(key)![0].hostLabel ?? key),
      hostKey: key,
      items: byHost.get(key)!,
    }));
  }

  const historyItems = ranked.filter(i => i.source === 'history');
  const liveItems = ranked.filter(i => i.source === 'live');
  const sections: Section[] = [];
  if (historyItems.length > 0) {
    sections.push({
      id: 'history',
      label: '🕘 history',
      hostKey: hostKeyOf(historyItems[0]),
      items: historyItems,
    });
  }
  if (liveItems.length > 0) {
    sections.push({
      id: 'live',
      label: '📁 subdirectories',
      hostKey: hostKeyOf(liveItems[0]),
      items: liveItems,
    });
  }
  return sections;
}
