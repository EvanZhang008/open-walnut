/**
 * What a right-click on an Org row offers (OrgPage → OrgChannelList's menu): open it on a tab,
 * and move its project the way the chart does (the chart opens on the same question, so a move is
 * confirmed in one place).
 *
 * The menu stays short (2026-10-26, the user: "too messy ... create a dedicated VP for this
 * project, that is what it means"): a list of VPs or of projects is ONE row that opens a picker at
 * the cursor, the way a folder menu's Project row does, never a run of rows; and a VP is named the
 * way a person says it ("the Routines VP", not "Routines's VP"). With the Directors on, a VP's row
 * also offers "New Director…" (director-actions.ts: its fold, or the DIRECTORS section, opens on a
 * name input). Pure, so tests reach it.
 */
import type { ContextMenuItem } from '@/utils/context-menu';
import type { ChartStart } from './OrgChartSheet';
import type { ChannelMenuTarget } from './OrgChannelList';
import type { OrgTab } from './OrgNodeDetail';
import { dropPlan, type VpCard } from './org-chart-model';
import { rowTaskId, type ChannelRow } from './org-channels-model';
import { orgNodeMember, topicMenuItems } from '@/components/topics/topic-entry';

/** A picker one row opens: what it is for, its rows, and what a pick does. */
export interface OrgRowPick {
  label: string;
  options: Array<{ value: string; label: string }>;
  onPick: (value: string) => void;
}

export function orgRowMenu({ target, cards, select, openChart, pick, newDirector, editAvatar }: {
  target: ChannelMenuTarget;
  cards: readonly VpCard[];
  select: (key: string, tab?: OrgTab) => void;
  openChart: (start?: ChartStart) => void;
  pick: (p: OrgRowPick) => void;
  /** Absent while the Directors are off. */
  newDirector?: ((vpKey: string) => void) | undefined;
  /** The row's name and avatar are edited here ("Edit name and avatar…"). */
  editAvatar?: (row: ChannelRow) => void;
}): ContextMenuItem[] {
  const projectOf = (key: string) => cards.flatMap((c) => c.projects).find((p) => p.key === key);
  const canGetVp = (key: string) => { const p = projectOf(key); return !!p && !!dropPlan(cards, p, null); };
  const dedicated = (key: string, name: string): ContextMenuItem =>
    ({ key: `own:${key}`, label: `Create a dedicated VP for ${name}…`, onSelect: () => openChart({ project: key, to: null }) });

  if ('moved' in target) {
    const m = target.moved;
    return [
      { key: 'head', section: true, label: m.project },
      { key: 'open', label: `Open the ${m.vpName} VP`, onSelect: () => select(m.vpKey) },
      { key: 'sep', divider: true },
      ...(canGetVp(m.key) ? [dedicated(m.key, m.project)] : []),
    ];
  }
  const r = target.row;
  // The detail's own tabs: chat with whoever answers for it (OrgNodeDetail canTalk), its team.
  const canTalk = r.kind === 'main' || !!r.contactId || !!r.node?.needsLead;
  const items: ContextMenuItem[] = [
    { key: 'head', section: true, label: r.name },
    ...(canTalk ? [{ key: 'chat', label: 'Open chat', onSelect: () => select(r.key, 'chat') }] : []),
    { key: 'team', label: 'Open tasks', onSelect: () => select(r.key, 'team') },
    ...(editAvatar && rowTaskId(r) ? [{ key: 'avatar', label: 'Edit name and avatar…', onSelect: () => editAvatar(r) }] : []),
    ...topicMenuItems(orgNodeMember(r)),
  ];
  if (r.kind === 'main') return [...items, { key: 'sep', divider: true }, { key: 'chart', label: 'Open the org chart', onSelect: () => openChart() }];

  const vp = newDirector ? cards.find((c) => c.key === r.key && c.role === 'VP' && c.projects.length > 0) : undefined;
  if (vp && newDirector) items.push({ key: 'sep-director', divider: true }, { key: 'director', label: 'New Director…', onSelect: () => newDirector(vp.key) });
  const own = projectOf(r.key);
  const under = own ? cards.filter((c) => c.key !== r.key && dropPlan(cards, own, c)) : [];
  const led = (r.led ?? []).filter((l) => canGetVp(l.key));
  // New Director and the moves are one group: what changes under this VP.
  if ((under.length || led.length) && !vp) items.push({ key: 'sep-move', divider: true });
  if (under.length) {
    items.push({
      key: 'move',
      label: 'Move under another VP…',
      onSelect: () => pick({
        label: `Move ${r.name} under`,
        options: under.map((c) => ({ value: c.key, label: `${c.name} VP` })),
        onPick: (to) => openChart({ project: r.key, to }),
      }),
    });
  }
  if (led.length === 1) items.push(dedicated(led[0]!.key, led[0]!.name));
  else if (led.length > 1) {
    items.push({
      key: 'own',
      label: 'Create a dedicated VP…',
      onSelect: () => pick({
        label: 'Create a dedicated VP for',
        options: led.map((l) => ({ value: l.key, label: l.name })),
        onPick: (project) => openChart({ project, to: null }),
      }),
    });
  }
  return items;
}
