/**
 * Settings > Phones & Cloud as four tabs: Cloud companion, Tailscale, the browser
 * link (named after the tunnel plugin that brings it), and Devices. Each tab is its
 * own pane (settings-way-panes.ts); every one of them leads with this bar and with
 * what that tab is, when to use it and its state now, then its own settings. The
 * tab the phone uses also says how the phone reaches Walnut right now.
 *
 * Phones & Cloud itself (../PhonesCloudLanding.tsx) opens the tab in use
 * (ways-model `landingWay`), so its first screen answers "how does my phone reach
 * Walnut".
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { SettingsSection } from '../../SettingsSection';
import { useIsReplicaServer, useServerCapability } from '@/hooks/useServerRole';
import { DEVICES_TAB, WAY_PANES, type PhonesCloudTab } from '../../settings-way-panes';
import { useBrowserLinkName } from './browser-link-name';
import { useDevicesData, useExposeStatus, type DeviceEntry } from './useDevicesData';
import { DEVICES_INTRO, deriveWays, landingWay, type NowLine, type Way, type WayDot } from './ways-model';
import '@/styles/devices-ways.css';

export const PANE_TITLE = 'Phones & Cloud';

interface TabView {
  id: PhonesCloudTab;
  label: string;
  dot?: WayDot;
  tag: string;
  what: string;
  useWhen: string;
  status?: string;
}

export interface PhonesCloudView {
  tabs: TabView[];
  now: NowLine;
  /** The tab Phones & Cloud opens on; null while the list loads. */
  landing: PhonesCloudTab | null;
}

const isPhone = (d: DeviceEntry) => (d.role ?? 'phone') === 'phone';

/**
 * The bar as the last tab drew it. Every tab is its own pane, so a click mounts a
 * new bar whose reads start over: it shows the last known states and count until
 * they answer, instead of blank tags for a moment on every switch.
 */
let lastTabs: TabView[] | null = null;

/** What the bar and the intros say, from the same reads the Devices tab makes (shared in flight). */
export function usePhonesCloudView(): PhonesCloudView {
  const replica = useIsReplicaServer();
  const publicDoor = useServerCapability('public-door');
  const { devices, cloudDevices, targets, listState, tailscale, tailscaleStale, tailscaleAt, cloudError, cloudUnpaired, cloudWithheld, settled } = useDevicesData({ replica });
  const expose = useExposeStatus(replica);
  const linkName = useBrowserLinkName();
  const { now, ways } = deriveWays({
    listState,
    phoneUses: [
      ...devices.filter(isPhone).map((d) => ({ name: d.name, via: 'lan' as const, lastUsedAt: d.lastUsedAt })),
      ...cloudDevices.filter(isPhone).map((d) => ({ name: d.name, via: 'cloud' as const, lastUsedAt: d.lastUsedAt })),
    ],
    targets,
    cloudError,
    cloudUnpaired,
    cloudWithheld,
    tailscale,
    tailscaleAsOf: tailscaleStale ? tailscaleAt : null,
    expose,
    linkName,
  });
  // One row per device name: a phone paired to this Mac and the companion is one phone.
  const names = new Set([...devices, ...cloudDevices].filter((d) => isPhone(d) || d.role === 'browser').map((d) => d.name));
  const wayTab = (w: Way): TabView => ({
    id: WAY_PANES[w.id],
    label: w.title,
    dot: w.dot,
    tag: w.inUse ? 'In use' : w.tag,
    what: w.what,
    useWhen: w.useWhen,
    status: w.status,
  });
  const devicesTab: TabView = {
    id: DEVICES_TAB,
    label: 'Devices',
    tag: listState === 'ready' ? String(names.size) : '',
    what: DEVICES_INTRO.what,
    useWhen: DEVICES_INTRO.useWhen,
  };
  // A replica's own console has no Tailscale or browser link to set up (those panes need the Mac);
  // it shows its own public address only when it has one (the companion's public door).
  const shown = replica ? ways.filter((w) => w.id === 'cloud' && publicDoor) : ways;
  let landed = replica ? (listState === 'loading' ? null : 'devices') : landingWay({ listState, cloudError }, ways);
  // Devices only because Tailscale's first probe has not answered yet: wait for it (a few seconds at most).
  if (landed === 'devices' && !settled) landed = null;
  const fresh = [...shown.map(wayTab), devicesTab];
  const loaded = listState !== 'loading' && expose !== null;
  if (loaded) lastTabs = fresh;
  return {
    tabs: loaded || !lastTabs ? fresh : lastTabs,
    now,
    landing: landed === null ? null : landed === 'devices' ? DEVICES_TAB : WAY_PANES[landed],
  };
}

export function TabBar({ tabs, current }: { tabs: readonly TabView[]; current: PhonesCloudTab | null }) {
  // A narrow pane scrolls the bar sideways: bring the open tab into it (the bar only, never the page).
  const barRef = useRef<HTMLElement>(null);
  // A tab's tag and dot arrive with the data and widen it: the open tab is brought into
  // view again then (it stayed cut off at the right edge of a phone).
  const shape = tabs.map((t) => `${t.id}:${t.label}:${t.tag ?? ''}:${t.dot ?? ''}`).join('|');
  useLayoutEffect(() => {
    const bar = barRef.current;
    const tab = bar?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!bar || !tab) return;
    const left = tab.getBoundingClientRect().left - bar.getBoundingClientRect().left + bar.scrollLeft;
    const right = left + tab.offsetWidth;
    if (left < bar.scrollLeft) bar.scrollLeft = Math.max(0, left - 12);
    else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right - bar.clientWidth + 12;
  }, [current, shape]);
  // Which sides have more tabs past the edge: that edge fades, so a phone sees the bar scrolls.
  const [more, setMore] = useState('');
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const read = () => {
      const left = bar.scrollLeft > 1;
      const right = bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 1;
      setMore([left ? 'left' : '', right ? 'right' : ''].filter(Boolean).join(' '));
    };
    read();
    bar.addEventListener('scroll', read, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    ro?.observe(bar);
    return () => { bar.removeEventListener('scroll', read); ro?.disconnect(); };
  }, [shape]);
  return (
    <nav ref={barRef} className="pc-tabs" aria-label={PANE_TITLE} data-testid="pc-tabs" data-more={more || undefined}>
      {tabs.map((t) => (
        // A same-page hash link: SettingsPage turns it into a hash replace, as for the nav.
        <a
          key={t.id}
          href={`#${t.id}`}
          className="pc-tab"
          aria-current={t.id === current ? 'page' : undefined}
          data-testid={`pc-tab-${t.id}`}
        >
          {t.dot && <span className="devices-way-dot" data-dot={t.dot} aria-hidden="true" />}
          <span className="pc-tab-label">{t.label}</span>
          {t.tag && <span className="devices-way-tag" data-dot={t.tag === 'In use' ? 'on' : t.dot}>{t.tag}</span>}
        </a>
      ))}
    </nav>
  );
}

function NowLineView({ now }: { now: NowLine }) {
  return (
    <div className="devices-now" data-tone={now.tone} data-testid="devices-now">
      <div className="devices-now-title">{now.title}</div>
      {now.hops && (
        <div className="devices-now-hops" aria-label={now.hops.join(' to ')}>
          {now.hops.map((h, i) => (
            <span key={`${i}-${h}`} className="devices-now-hop-wrap">
              {i > 0 && <span className="devices-now-arrow" aria-hidden="true">→</span>}
              <span className="devices-now-hop">{h}</span>
            </span>
          ))}
        </div>
      )}
      {now.detail && <div className="devices-now-detail">{now.detail}</div>}
    </div>
  );
}

/** The bar, then what this tab is and when to use it, then (on the tab in use) how the phone gets in now. */
export function PhonesCloudTabHead({ tab, view }: { tab: PhonesCloudTab; view: PhonesCloudView }) {
  const t = view.tabs.find((x) => x.id === tab);
  // No "add to Home Screen or Safari signs you out in a week" tip any more: a
  // browser's sign-in renews from a cookie Safari's 7-day rule never clears.
  return (
    <div className="pc-head">
      <TabBar tabs={view.tabs} current={tab} />
      {t && (
        <div className="pc-intro" data-testid={`pc-intro-${tab}`}>
          <p className="pc-intro-what">{t.what}</p>
          <p className="pc-intro-when"><span className="pc-intro-key">Use it when</span>{t.useWhen}</p>
          {t.status && (
            <p className="pc-intro-now">
              <span className="pc-intro-key">Now</span>
              <span className="devices-way-dot" data-dot={t.dot} aria-hidden="true" />
              {t.status}
            </p>
          )}
        </div>
      )}
      {view.landing === tab && <NowLineView now={view.now} />}
    </div>
  );
}

/** A tab's pane: Phones & Cloud's header and bar over the tab's own settings. */
export function PhonesCloudTabPane({ tab, children }: { tab: PhonesCloudTab; children: ReactNode }) {
  const view = usePhonesCloudView();
  return (
    <SettingsSection id={tab} title={PANE_TITLE}>
      <PhonesCloudTabHead tab={tab} view={view} />
      {children}
    </SettingsSection>
  );
}
