/**
 * Settings > Remote Hosts: where a press lands. Whatever a press made or showed comes into view
 * in the upper part of the pane, flashes once and holds the focus with its ring (2026-11-04:
 * Add host appended a row off screen, so a press looked like nothing happened), and the focus
 * never falls to the page (a removed row hands it to the next row, a closed edit to its More).
 *
 *   ssh(key, f)  a new or opened SSH row: its Hostname field (or the field `f`, its first empty one)
 *   join()       "Making a link..." at once, then the link (its Copy) or why not (its fix)
 *   row(key)     a row whose Details opened: in view, the focus stays put
 *   after(t)     after the row went: 'add', a row key, 'more:<row key>', or 'join-closed' (the
 *                line a closed link that still works leaves in its place)
 *
 * The focus moves only while nobody put it elsewhere since the press: 2026-11-04, a late
 * landing took it from the Hostname box mid-typing and the rest went into Alias.
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { flashHostsOf, hostRowId, useHostSettingsFocus } from '@/utils/host-settings-nav';
import { landOnRow } from '@/utils/scroll-land';
import { flashOnce, focusLanded } from '@/utils/focus-landed';
import type { HostEntry } from './remote-hosts-model';
import type { HostNetwork } from './useHostNetwork';

const FLASH_MS = 1500;
/** Each 'Open Settings' request flashes its row once, even across remounts. */
let flashedNonce = 0;
const JOIN_COPY = '[data-testid="host-network-copy"], [data-testid="host-network-windows-link-copy"], [data-testid="host-network-windows-copy"]';
const JOIN_ROWS = '[data-testid="host-network-making"], [data-testid="host-network-invite"], [data-testid="host-network-invite-error"]';
/**
 * A failed link's fix, whichever it offers (HostJoinError), in this order: Close comes first on
 * the row, so one selector list would land on Close, never on the fix.
 */
const JOIN_FIXES = ['host-network-start', 'host-network-open-cloud', 'host-network-show-open', 'host-network-try-again', 'host-network-error-done'];
const joinFixIn = (row: HTMLElement) => JOIN_FIXES.map((id) => row.querySelector<HTMLElement>(`[data-testid="${id}"]`)).find((el) => !!el) ?? null;
/** Where the focus may be taken from: the press that asked for the landing. */
const PRESSED = '[data-testid="remote-hosts-add"], .rh-add-menu, [data-testid="host-network-making"], [data-testid="host-network-start"], [data-testid="host-network-invite-error"]';

type Landing = { kind: 'ssh'; key: number; field?: 'hostname' | 'alias' | 'user' } | { kind: 'join' } | { kind: 'row'; key: string };

const rowEl = (key: string) => document.querySelector<HTMLElement>(`[data-row-key="${key}"]`);
/**
 * The focus is on nothing: the page, or an element no longer in it (WebKit keeps a removed field
 * as the active element for a while: Escape closing a host's fields left it there, so the focus
 * never went to the row's More; seen 2026-11-04).
 */
const lost = (a: Element | null) => !a || a === document.body || !a.isConnected;

export function useHostRowLanding({ hostsRef, rowKeys, network, rowCount }: {
  hostsRef: MutableRefObject<HostEntry[]>;
  rowKeys: string[];
  network: Pick<HostNetwork, 'making'>;
  rowCount: number;
}) {
  const landRef = useRef<(() => void) | null>(null);
  const bring = (el: HTMLElement, focus = false) => {
    landRef.current?.();
    landRef.current = landOnRow(el, { focus });
  };
  useEffect(() => () => landRef.current?.(), []);

  const [landing, setLanding] = useState<Landing | null>(null);
  // At once, once the change is on the page (an effect runs after the commit): a frame later was
  // too late in WebKit under load (frames half a second apart), where the focus keeper had already
  // put the focus elsewhere and the landing then held back.
  useEffect(() => {
    if (!landing) return;
    setLanding(null);
    const row = landing.kind === 'join' ? document.querySelector<HTMLElement>(JOIN_ROWS) : rowEl(landing.kind === 'ssh' ? `ssh:${landing.key}` : landing.key);
    if (!row) return;
    bring(row);
    if (landing.kind === 'row') return;
    flashOnce(row);
    const active = document.activeElement;
    const own = landing.kind === 'ssh' && !!active?.closest(`[data-row-key="ssh:${landing.key}"] [data-testid="rh-row-more"]`);
    const free = lost(active) || own || !!active!.closest(PRESSED);
    if (!free) return;
    if (landing.kind === 'ssh') {
      const idx = hostsRef.current.findIndex((h) => h._key === landing.key);
      focusLanded(document.getElementById(`rh-${landing.field ?? 'hostname'}-${idx}`));
    } else {
      const target = row.matches('[data-testid="host-network-invite"]') ? row.querySelector<HTMLElement>(JOIN_COPY)
        : row.matches('[data-testid="host-network-invite-error"]') ? joinFixIn(row)
        : null;
      focusLanded(target ?? row);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landing]);

  // A link being made lands twice: on "Making a link..." at once, and on what came of it.
  const joinPending = useRef(false);
  useEffect(() => {
    if (!joinPending.current) return;
    if (network.making) {
      // What was pressed may have gone with its card (Start the host network, once the network
      // runs): "Making a link..." holds the focus until the link comes, so the net under the page
      // does not hand it to another row first (Chromium, a slow link: the focus went to a row's
      // button and the link's Copy never got it).
      const making = document.querySelector<HTMLElement>('[data-testid="host-network-making"]');
      if (making && lost(document.activeElement)) focusLanded(making);
      return;
    }
    joinPending.current = false;
    setLanding({ kind: 'join' });
  }, [network.making]);

  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  // Where the focus goes after a row went or its fields closed: at once, once the change is on the
  // page (an effect runs after the commit). A frame later was too late in WebKit under load, whose
  // frames came half a second apart: the focus keeper had already put the focus elsewhere.
  useEffect(() => {
    if (!focusAfter) return;
    setFocusAfter(null);
    if (focusAfter === 'add') { focusLanded(document.querySelector<HTMLElement>('[data-testid="remote-hosts-add"]')); return; }
    if (focusAfter === 'join-closed') {
      focusLanded(document.querySelector<HTMLElement>('[data-testid="host-network-closed"]') ?? document.querySelector<HTMLElement>('[data-testid="remote-hosts-add"]'));
      return;
    }
    if (focusAfter.startsWith('more:')) {
      // Still in the fields that close (WebKit can keep the focus on a field it removed).
      const a = document.activeElement;
      if (!lost(a) && !a!.closest('.rh-edit')) return;
      focusLanded(rowEl(focusAfter.slice(5))?.querySelector<HTMLElement>('[data-testid="rh-row-more"]'));
      return;
    }
    focusLanded(rowEl(focusAfter));
  }, [focusAfter]);

  // 'Open Settings' from a banner row, the picker or an error bar: scroll to that host's row
  // and flash it, on every request (a nonce, not the hash: the same hash twice fires nothing).
  const focus = useHostSettingsFocus();
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!focus.alias || focus.nonce <= flashedNonce) return;
    const nonce = focus.nonce;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(hostRowId(focus.alias!));
      if (!el) return;
      flashedNonce = nonce;
      // Upper part of the pane, held through late layout, focus on the row (N3-2).
      bring(el, true);
      el.classList.remove('rh-row-flash');
      void el.offsetWidth; // restart the animation for a second request
      el.classList.add('rh-row-flash');
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => el.classList.remove('rh-row-flash'), FLASH_MS);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.nonce, focus.alias, rowCount]);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  // 'and N more' on the banner: the rows its cap hid each flash once, the first scrolls into
  // view. The state is used once, then replaced away, so a reload does not flash again.
  const location = useLocation();
  const navigate = useNavigate();
  const flashKey = flashHostsOf(location.state).join('\n');
  useEffect(() => {
    if (!flashKey || rowCount === 0) return;
    const raf = requestAnimationFrame(() => {
      const els = flashKey.split('\n').map((a) => document.getElementById(hostRowId(a))).filter((el): el is HTMLElement => !!el);
      if (els[0]) bring(els[0]);
      for (const el of els) flashOnce(el);
      navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true, state: null });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flashKey, rowCount]);

  /** A row of the list shown and focused (a node of the network map, "need a look"). */
  const show = (row: HTMLElement | null): boolean => {
    if (!row) return false;
    bring(row);
    flashOnce(row);
    focusLanded(row);
    return true;
  };

  return {
    ssh: (key: number, field?: 'hostname' | 'alias' | 'user') => setLanding({ kind: 'ssh', key, field }),
    join: () => { joinPending.current = true; setLanding({ kind: 'join' }); },
    row: (key: string) => setLanding({ kind: 'row', key }),
    after: (target: string) => setFocusAfter(target),
    nextRowAfter: (key: string) => {
      const at = rowKeys.indexOf(key);
      return rowKeys[at + 1] ?? rowKeys[at - 1] ?? 'add';
    },
    showHostRow: (host: string) => show(document.getElementById(hostRowId(host))),
    /**
     * The `index`-th row the "need a look" count counts, brought into view and flashed; the focus
     * stays on the count, so the next press is right there. Its name, for the count's label.
     */
    showLook: (index: number): string | null => {
      const rows = document.querySelectorAll<HTMLElement>('[data-testid="remote-hosts-list"] [data-needs-look="true"]');
      const row = rows[index] ?? rows[0];
      if (!row) return null;
      bring(row);
      flashOnce(row);
      return row.querySelector('.rh-host-name')?.textContent ?? null;
    },
  };
}
