/**
 * The side panel's and the toolbar popup's own parts around Walnut's Ask (PopoutExtPanel): the
 * header (≡, the ask's title over "Ask Walnut ⌄", the key button, New chat or the side panel
 * button), the composer's page and Act in tab chips, and the ≡ drawer with its foot rows. The
 * drawer is Home's (AskWalnutDrawer) in its `panel` shape.
 *
 * The key button only says where it is: the extension page draws the key popover over this frame
 * (the vault's token never enters a Walnut page), so a press sends the button's place up.
 */
import { forwardRef, type ReactNode, type RefObject } from 'react';
import { timeAgo } from '@/utils/time';
import { askActivityAt } from '@open-walnut/ask-list';
import { AskWalnutDrawer, AskWalnutMenuButton, type DrawerRow } from '@/components/chat/AskWalnutDrawer';
import type { Task } from '@open-walnut/core';
import type { AskAgent } from '@/components/chat/ask-walnut-slot-model';
import { toParent } from './ext-frame';
import { hostOf, type VaultState } from './ext-panel-model';
import { askRowDetail } from './ext-tasks-model';
import { mainLineOf, type ExtAsks } from './useExtAsks';

const S = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const ICON_KEY = <svg {...S}><circle cx="8" cy="15" r="4" /><path d="M10.85 12.15 19 4" /><path d="m18 5 2 2" /><path d="m15 8 2 2" /></svg>;
const ICON_LOCK = <svg {...S} width={9} height={9} strokeWidth={2.6}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
const ICON_COMPOSE = <svg {...S}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;
const ICON_SIDE = <svg {...S}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>;
const ICON_CARET = <svg {...S} width={11} height={11}><path d="m6 9 6 6 6-6" /></svg>;
const ICON_POINTER = <svg {...S} width={13} height={13}><path d="m4 4 7 17 2.5-7.5L21 11z" /></svg>;
const ICON_TASKS = <svg {...S}><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12 2.5 2.5 4.5-5" /></svg>;
const ICON_OUT = <svg {...S}><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></svg>;

/** The key with its padlock badge while Passwords is locked. */
export function KeyGlyph({ locked }: { locked: boolean }) {
  return <span className="ext-key-glyph">{ICON_KEY}{locked && <span className="ext-key-badge" data-testid="ext-key-locked">{ICON_LOCK}</span>}</span>;
}

interface HeaderProps {
  surface: 'panel' | 'popup';
  /** The ask on show ("New chat" before the first question). The popup shows the agent alone. */
  title: string;
  agent: AskAgent;
  canSwitch: boolean;
  menuRef: RefObject<HTMLButtonElement | null>;
  menuOn: boolean;
  onMenu: () => void;
  onAgents: () => void;
  /** The extension draws the key popover (`ext=2`); an older one has its own Passwords tab. */
  keyed: boolean;
  vault: VaultState | null;
  keyPressed: boolean;
  onNew: () => void;
}

export function ExtAskHeader(p: HeaderProps) {
  const agentSwitch = p.canSwitch ? (
    <button type="button" className="ext-ask-agent" data-testid="ext-ask-agent" onClick={p.onAgents} title="Switch agent">
      {p.agent.project}<span aria-hidden="true">{ICON_CARET}</span>
    </button>
  ) : <span className="ext-ask-agent is-plain">{p.agent.project}</span>;
  const locked = p.vault?.locked !== false;
  const keyLabel = locked ? 'Passwords, locked' : 'Passwords';
  return (
    <header className={`ext-ask-head is-${p.surface}`} data-testid="ext-ask-head">
      <AskWalnutMenuButton ref={p.menuRef} open={p.menuOn} onToggle={p.onMenu} label={p.agent.project} />
      {p.surface === 'panel' ? (
        <div className="ext-ask-titles">
          <span className="ext-ask-title" data-testid="ext-ask-title" title={p.title}>{p.title}</span>
          {agentSwitch}
        </div>
      ) : <div className="ext-ask-titles is-popup">{agentSwitch}</div>}
      {p.keyed && (
        <button
          type="button"
          className={`ext-ask-icon ext-ask-key${p.keyPressed ? ' is-pressed' : ''}`}
          data-testid="ext-ask-key"
          aria-label={keyLabel}
          aria-haspopup="dialog"
          aria-expanded={p.keyPressed}
          title={keyLabel}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            toParent({ type: 'key-toggle', rect: { top: r.top, right: r.right, bottom: r.bottom, left: r.left } });
          }}
        >
          <KeyGlyph locked={locked} />
        </button>
      )}
      {p.surface === 'panel' ? (
        <button type="button" className="ext-ask-icon" data-testid="ext-panel-new" aria-label="New chat" title="New chat about this page" onClick={p.onNew}>{ICON_COMPOSE}</button>
      ) : (
        <button type="button" className="ext-ask-icon" data-testid="ext-ask-side-panel" aria-label="Open in the side panel" title="Open in the side panel" onClick={() => toParent({ type: 'open-side-panel' })}>{ICON_SIDE}</button>
      )}
    </header>
  );
}

interface ChipsProps {
  page: { url: string; title?: string } | null;
  pageOn: boolean;
  onPage: (on: boolean) => void;
  /** Absent while the tab cannot be offered (none, or another conversation acts in it). */
  act?: { on: boolean; onToggle: (on: boolean) => void };
}

/** The composer's bottom-row chips: the page that goes with the next message, and Act in tab. */
export function ExtComposerChips({ page, pageOn, onPage, act }: ChipsProps) {
  // The page's web address (a site, never a Walnut host).
  const site = page ? hostOf(page.url) : '';
  const letter = (site.replace(/^www\./, '').match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase();
  return (
    <div className="ext-chips">
      {page && (
        <span className={`ext-chip ext-chip-page${pageOn ? ' is-on' : ''}`}>
          <button
            type="button"
            role="switch"
            aria-checked={pageOn}
            className="ext-chip-body"
            data-testid="ext-panel-include"
            title={pageOn ? `${page.title ?? site} goes with your next message` : 'Send this page with your next message'}
            onClick={() => onPage(!pageOn)}
          >
            <span className="ext-chip-fav" aria-hidden="true">{letter}</span>
            <span className="ext-chip-label">{page.title ? `${page.title} · ${site}` : site}</span>
          </button>
          {pageOn && (
            <button type="button" className="ext-chip-x" data-testid="ext-panel-page-drop" aria-label="Leave the page out of the next message" title="Leave the page out of the next message" onClick={() => onPage(false)}>&times;</button>
          )}
        </span>
      )}
      {act && (
        <button
          type="button"
          role="switch"
          aria-checked={act.on}
          className={`ext-chip ext-chip-act${act.on ? ' is-on' : ''}`}
          data-testid="ext-panel-act"
          title={act.on ? "Walnut's agents may act in this tab only, until you take it back. Click to take it back." : 'Let Walnut act in this tab. Stop on the page gives it back.'}
          onClick={() => act.onToggle(!act.on)}
        >
          {ICON_POINTER}<span>Act in tab</span>
        </button>
      )}
    </div>
  );
}

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  asks: ExtAsks;
  agentsFirst: boolean;
  onPickAgent: (id: string) => void;
  selectedTaskId: string | null;
  mainSelected: boolean;
  onPick: (taskId: string) => void;
  onPickMain: () => void;
  onNew: () => void;
  keyed: boolean;
  vault: VaultState | null;
  onView: (view: 'tasks' | 'passwords') => void;
}

/** Home's drawer of asks, with the side panel's foot: Tasks, Passwords, Open Walnut. */
export function ExtAsksDrawer(p: DrawerProps) {
  const locked = p.vault?.locked !== false;
  const count = p.vault?.siteCount;
  const pwMeta = locked ? 'Locked' : typeof count === 'number' ? (count === 1 ? '1 login here' : `${count} logins here`) : '';
  const foot = (
    <>
      {p.keyed && (
        <FootRow testid="ext-drawer-tasks" icon={ICON_TASKS} label="Tasks" onClick={() => { p.onClose(); p.onView('tasks'); }}
          end={p.asks.needs > 0 ? <span className="ext-drawer-count" data-testid="ext-drawer-tasks-count">{p.asks.needs}</span> : null} />
      )}
      {p.keyed && (
        <FootRow testid="ext-drawer-passwords" icon={<KeyGlyph locked={locked} />} label="Passwords" onClick={() => { p.onClose(); p.onView('passwords'); }}
          end={pwMeta ? <span className="ext-drawer-meta" data-testid="ext-drawer-passwords-meta">{pwMeta}</span> : null} />
      )}
      <FootRow testid="ext-drawer-open-walnut" icon={ICON_OUT} label="Open Walnut" onClick={() => { p.onClose(); toParent({ type: 'open-walnut', path: '/' }); }} />
    </>
  );
  return (
    <AskWalnutDrawer
      open={p.open}
      onClose={p.onClose}
      returnFocusRef={p.returnFocusRef}
      agents={p.asks.agents}
      agent={p.asks.agent}
      onPickAgent={p.onPickAgent}
      rows={p.asks.rows}
      loading={p.asks.loading}
      selectedTaskId={p.selectedTaskId}
      onPick={p.onPick}
      onNew={p.onNew}
      agentsFirst={p.agentsFirst}
      {...(p.asks.isGeneral ? { main: { selected: p.mainSelected, ...(p.asks.mainTask ? { task: p.asks.mainTask } : {}), onPick: p.onPickMain } } : {})}
      panel={{ rowDetail: askRowDetail, mainLine: mainLineOf(p.asks.needs), foot }}
    />
  );
}

const FootRow = forwardRef<HTMLButtonElement, { testid: string; icon: ReactNode; label: string; end?: ReactNode; onClick: () => void }>(
  function FootRow({ testid, icon, label, end, onClick }, ref) {
    return (
      <button ref={ref} type="button" className="ext-drawer-row" data-testid={testid} onClick={onClick}>
        <span className="ext-drawer-row-ic" aria-hidden="true">{icon}</span>
        <span className="ext-drawer-row-label">{label}</span>
        {end}
      </button>
    );
  },
);

/** One ask in the popup's Continue list: the drawer's two-line row. */
export function ContinueRow({ row, onPick }: { row: DrawerRow; onPick: () => void }) {
  const d = row.task ? askRowDetail(row.task) : { line: '', needs: false };
  const at = row.task ? askActivityAt(row.task as Task) : undefined;
  return (
    <button type="button" className="ext-continue-row" data-testid="ext-continue-row" data-task-id={row.id} data-needs={d.needs ? 'true' : 'false'} onClick={onPick} title={row.title}>
      <span className={`ask-walnut-drawer-needs${d.needs ? ' is-on' : ''}`} aria-label={d.needs ? 'Needs you' : undefined} />
      <span className="ask-walnut-drawer-item-text">
        <span className="ask-walnut-drawer-item-title">{row.title}</span>
        {d.line && <span className="ask-walnut-drawer-item-line">{d.line}</span>}
      </span>
      {at && <span className="ask-walnut-drawer-item-time">{timeAgo(at)}</span>}
    </button>
  );
}
