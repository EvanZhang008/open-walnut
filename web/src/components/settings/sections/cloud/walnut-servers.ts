/**
 * "Your Walnut runs on", the line at the top of Phones & Cloud (WalnutServersStrip.tsx): every
 * place this Walnut runs, in one line, above the tabs. Pure, so every shape is unit-tested (tests/web/walnut-servers.test.ts).
 *
 * 2026-11-18, the user: an address a replica server has "is not a separate link, more like under
 * general tab show the replica server we have". A server on an always-on host (it can carry the
 * tunnel's address, so a browser opens Walnut while this Mac sleeps) and the cloud companion are
 * copies of this Mac's Walnut, not ways of their own and not devices: they are listed here, each
 * once, by the name the person knows the machine by, above the ways to reach them.
 *
 *   This Mac           the main Walnut: tasks, notes and sessions live here
 *   Cloud companion    a copy in the cloud; the phone reaches it while this Mac sleeps
 *   <host>             a copy on that host, and the tunnel's address when it carries it
 *
 * Two config rows of one machine (a row found in ~/.ssh/config and the one the person named, which
 * reach one daemon: the server's `knownAs`) are one server, under the named row.
 */
import type { HostServerEntry } from '../host-servers-status';
import { describeHostServer } from '../host-servers-status';
import { hostRowId } from '@/utils/host-settings-nav';

export interface WalnutServerRow {
  id: string;
  name: string;
  line: string;
  /** A few words beside the name in the overview strip ("main", the companion's address, "carries <tunnel>"). */
  short: string;
  dot: 'done' | 'pending' | 'action' | 'error';
  /** A Settings hash that opens its own settings (none for this Mac). */
  href?: string;
}

export interface WalnutServersInput {
  /** The companion's address when this Mac is paired with one; null when there is none. */
  companion: { origin: string } | null;
  /** Why the companion did not answer (its half of the device list), if it did not. */
  companionError?: string | null;
  /** GET /api/host-servers `hosts`; null while it loads or on a server without it. */
  hosts: readonly HostServerEntry[] | null;
  /** The tunnel's name ("Tunnel", or the plugin's), for the host that carries its address. */
  tunnelTitle: string;
}

const bare = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

/** A host that runs a server for this Walnut: its own switch, or it carries this Walnut's tunnel. */
const runsServer = (h: HostServerEntry) => h.settings.enabled || !!h.settings.carriesTunnel;

export function walnutServerRows(i: WalnutServersInput): WalnutServerRow[] {
  const rows: WalnutServerRow[] = [{
    id: 'this-mac',
    name: 'This Mac',
    line: 'The main Walnut: your tasks, notes and sessions live here, and every other server keeps a copy.',
    short: 'main',
    dot: 'done',
  }];
  if (i.companion || i.companionError) {
    rows.push({
      id: 'companion',
      name: 'Cloud companion',
      line: i.companion && !i.companionError
        ? `At ${bare(i.companion.origin)}. Your phone reaches it from anywhere, also while this Mac sleeps.`
        : 'Not answering right now; its tab says why.',
      short: i.companion && !i.companionError ? bare(i.companion.origin) : 'not answering',
      dot: i.companion && !i.companionError ? 'done' : 'action',
      href: '#cloud',
    });
  }
  // One machine, one row: a row that is another alias of a named one folds into it.
  const machines = new Map<string, { name: string; entries: HostServerEntry[] }>();
  for (const h of i.hosts ?? []) {
    if (!runsServer(h)) continue;
    const key = h.knownAs?.hostKey ?? h.hostKey;
    const m = machines.get(key) ?? { name: h.knownAs?.label ?? h.label, entries: [] };
    if (!h.knownAs) m.name = h.label;
    m.entries.push(h);
    machines.set(key, m);
  }
  for (const [key, m] of machines) {
    // The state of the one that runs, else the first; the address of the one that carries the tunnel.
    const lead = m.entries.find((e) => e.view?.phase === 'running') ?? m.entries[0];
    // Running: just that (the Remote Hosts line goes on about where a browser on that host lands).
    const state = lead.view?.phase === 'running' && !lead.view.notice ? { text: 'Running.', dot: 'done' as const } : describeHostServer(lead);
    const carrier = m.entries.find((e) => e.settings.carriesTunnel);
    const tunnel = carrier?.view?.server?.expose;
    const address = carrier && tunnel?.state === 'connected' && tunnel.url
      ? ` ${i.tunnelTitle} opens this Walnut at ${bare(tunnel.url)}, also while this Mac sleeps.`
      : carrier ? ` It carries ${i.tunnelTitle}'s address.` : '';
    rows.push({
      id: `host:${key}`,
      name: m.name,
      line: `${state.text}${address}`,
      short: carrier ? `carries ${i.tunnelTitle}` : state.dot === 'done' ? 'a copy' : 'not running',
      dot: state.dot,
      // The row whose server this is: its switch and its tunnel's settings live there
      // (HostServersGroup.tsx reads one row's settings), not always the named twin's.
      href: `#${hostRowId((carrier ?? lead).hostKey)}`,
    });
  }
  return rows;
}
