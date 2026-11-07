/**
 * The browser relay as the extension's first page shows it (ExtRelay.tsx): the extension's own
 * agent state (packages/browser-extension/src/agent.ts), its "Let Walnut agents use this browser"
 * switch and the tabs agents hold, told by the panel page:
 *
 *   panel page → view   { walnut: 'ext-panel', type: 'relay', on, tabs: [{ tab, owner, who?, title?, url?, handed? }] }
 *   view → panel page   { type: 'relay-set', on } | { type: 'relay-release', tab } | { type: 'relay-stop-all' }
 *
 * An extension older than the first page says nothing of it: the pill then reads the page's own
 * word (`agents`, `owner`). No imports: ext-panel-model.ts reads the word with it.
 */
const hostOf = (url: string): string => { try { return new URL(url).host; } catch { return url; } };

/** A tab an agent holds now, as the extension names it. `handed`: the person shared it from the panel. */
export interface RelayTab { tab: number; owner: string; who?: string; title?: string; url?: string; handed?: boolean }
/** The extension's relay: its agents switch, and the tabs agents hold. */
export interface RelayState { on: boolean; tabs: RelayTab[] }

const OWNER = /^task:[\w.:-]{1,120}$/;
const RELAY_TABS_MAX = 40;

/** The extension's relay word, or null for anything else. */
export function readRelay(d: Record<string, unknown>): RelayState | null {
  if (!Array.isArray(d.tabs)) return null;
  const tabs: RelayTab[] = [];
  for (const raw of d.tabs.slice(0, RELAY_TABS_MAX)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.tab !== 'number' || !Number.isInteger(r.tab) || r.tab < 0) continue;
    if (typeof r.owner !== 'string' || !OWNER.test(r.owner)) continue;
    const str = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);
    const who = str(r.who, 80);
    const title = str(r.title, 300);
    const url = typeof r.url === 'string' && /^https?:\/\//i.test(r.url) ? r.url.slice(0, 4000) : undefined;
    tabs.push({ tab: r.tab, owner: r.owner, ...(who ? { who } : {}), ...(title ? { title } : {}), ...(url ? { url } : {}), ...(r.handed === true ? { handed: true } : {}) });
  }
  return { on: d.on === true, tabs };
}

/** The task an agent tab belongs to (`task:<id>`), or ''. */
export function taskOfOwner(owner: string | undefined): string {
  return owner && owner.startsWith('task:') ? owner.slice(5) : '';
}

export type RelayPillKind = 'tab' | 'on' | 'off';

/**
 * The header's relay pill: "Agent in tab" while an agent acts in the tab the person is on, "Relay
 * on" while agents may use the browser (the switch, or a tab shared from the panel), else "Relay off".
 */
export function relayPillOf(relay: RelayState | null, page: { agents: boolean; owner?: string }): { kind: RelayPillKind; label: string } {
  if (page.owner) return { kind: 'tab', label: 'Agent in tab' };
  const on = relay ? relay.on || relay.tabs.length > 0 : page.agents;
  return on ? { kind: 'on', label: 'Relay on' } : { kind: 'off', label: 'Relay off' };
}

/**
 * The relay panel's two lists: the tabs agents use now (the tab the person is on, and any whose
 * task is working), then the tabs shared earlier, each newest first as the extension lists them.
 */
export function relayGroups(relay: RelayState | null, here: number | undefined, working: (taskId: string) => boolean): { now: RelayTab[]; earlier: RelayTab[] } {
  const now: RelayTab[] = [];
  const earlier: RelayTab[] = [];
  for (const t of relay?.tabs ?? []) (t.tab === here || working(taskOfOwner(t.owner)) ? now : earlier).push(t);
  // The tab the person is on leads.
  now.sort((a, b) => (a.tab === here ? -1 : b.tab === here ? 1 : 0));
  return { now, earlier };
}

/** A relay row's name: the page's title and its site ("Lab Accounts · accounts.example.test"). */
export function relayTabName(t: RelayTab, here: number | undefined): string {
  const site = t.url ? hostOf(t.url) : '';
  const name = t.tab === here ? [t.title ?? site, 'this tab'] : [t.title ?? site, t.title && site ? site : ''];
  return name.filter(Boolean).join(' · ') || `Tab ${t.tab}`;
}

