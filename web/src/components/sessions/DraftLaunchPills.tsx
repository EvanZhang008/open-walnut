/**
 * The launch bar's last row, directly above the composer:
 *   [Folder/Host: walnut · Local] [Project: Walnut] More
 *
 * Both say what they are (user: "people don't know what this is"). The folder
 * pill asks the one real question, where the session runs, host included. The
 * project is not asked: it follows the folder, so the row only states it once
 * there is one, and a project Start will create reads "New project: x". Changing
 * it lives in More (the chip opens that menu); a draft without More (a bound or
 * repair draft) opens the project list straight from the chip, and a bound
 * draft's pick moves its existing task right away, since its launch never
 * refiles it. A fork's folder and project are facts, so both render disabled.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { ProjectPickerFlyout } from '@/components/tasks/TaskKebabMenu';
import { serverNow, useHostStatus, useHostStatusHydration } from '@/hooks/useHostStatus';
import { hostDotOf } from '@open-walnut/host-problem';
import { HostStatusDot } from './path-selector/HostStatusDot';
import { hostDisplayLabel, LOCAL_HOST_LABEL } from '@/utils/host-display-label';
import type { DraftColumn } from './draft-column';
import type { DraftDecisionMenu } from './DraftDecisionRow';
import { DRAFT_MENU_OWNER_ATTR } from './DraftDecisionRow';
import type { DraftProjectChipModel } from './draft-project-chip';
import '@/styles/draft-launch-pills.css';

function AiBadge({ on }: { on: boolean }) {
  return on ? <span className="draft-ai-badge" aria-label="AI suggested">✦</span> : null;
}

function basename(cwd: string): string {
  return cwd.replace(/\/+$/, '').split('/').pop() || '/';
}

export function DraftFolderPill({ draft, pillRef, pickerOpen, ai, onOpenPicker }: {
  draft: DraftColumn;
  pillRef: RefObject<HTMLButtonElement | null>;
  pickerOpen: boolean;
  ai: boolean;
  onOpenPicker: () => void;
}) {
  const isFork = !!draft.forkOf;
  const status = useHostStatus(draft.host);
  const hydration = useHostStatusHydration();
  const host = hostDisplayLabel(draft.host, status?.label, draft.hostLabel);
  // The picker tab's own verdict and sentence (hostDotOf), so the two never disagree.
  const hostDot = draft.host
    ? hostDotOf(status, { hydrating: hydration === 'never' || hydration === 'pending', now: serverNow(), label: host })
    : null;
  const dot = hostDot?.kind ?? 'unknown';
  const saysSomething = !!hostDot && ['warn', 'failed', 'off', 'connecting', 'checking'].includes(dot);
  const cls = `session-action-chip draft-folder-pill${pickerOpen ? ' session-action-chip-active' : ''}${ai ? ' session-action-chip-ai' : ''}`;
  let title: string;
  if (isFork) title = `A fork continues the source session, so it runs in its folder: ${draft.cwd}`;
  else if (!draft.cwd) title = 'Pick the folder this session runs in, on this machine or a remote host';
  else {
    const alias = draft.host && host !== draft.host ? ` (alias ${draft.host})` : '';
    const lines = [`Folder: ${draft.cwd}`, `Host: ${draft.host ? host : `${LOCAL_HOST_LABEL} (this machine)`}${alias}`];
    if (ai) lines.push('Walnut picked this folder from what you typed.');
    // A host with something to say: the same one sentence as its picker tab.
    title = saysSomething ? hostDot!.title : lines.join('\n');
  }
  return (
    // OPEN-only, never a toggle (matches the chat launcher pill): the picker's
    // own document-level mousedown closer has already fired by the time this
    // click runs, so a toggle would read the freshly-closed state and re-open.
    <button
      ref={pillRef}
      type="button"
      className={cls}
      onClick={isFork ? undefined : onOpenPicker}
      disabled={isFork}
      title={title}
      aria-label={draft.cwd ? `Folder and host: ${draft.cwd} on ${host}. Change` : 'Choose folder and host'}
    >
      {draft.cwd ? (
        <>
          {/* The spaces are text for copy and specs; flex drops them visually. */}
          <span className="draft-pill-key">Folder/Host:</span>{' '}
          <span className="draft-pill-name">{basename(draft.cwd)}</span>{' '}
          <span className="draft-pill-host">· {host}</span>
          {saysSomething && <HostStatusDot dot={hostDot!} host={draft.host ?? undefined} className="draft-pill-dot" />}
        </>
      ) : 'Choose folder and host…'}
      <AiBadge on={ai} />
    </button>
  );
}

export function DraftProjectChip({ chip, menu, project, onPick }: {
  chip: DraftProjectChipModel;
  /** The draft menu: required when `chip.action === 'menu'`. */
  menu?: DraftDecisionMenu;
  /** The value the flyout ticks ('' = Inbox). */
  project: string;
  /** A pick from the direct flyout (`chip.action === 'flyout'`). */
  onPick: (project: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  // The flyout owns no outside closer (its usual host is a kebab menu that has
  // one), so the chip does, exempting the flyout's own portal.
  useEffect(() => {
    if (!flyoutOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (ref.current?.contains(t)) return;
      if (t?.closest?.('.task-kebab-project-flyout')) return;
      setFlyoutOpen(false);
    };
    // Window capture, consumed: this Escape closes the list and nothing else
    // (the page's own Escape would also clear the focused task).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setFlyoutOpen(false);
      ref.current?.focus({ preventScroll: true });
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [flyoutOpen]);

  const viaMenu = chip.action === 'menu' && !!menu;
  const menuActive = viaMenu && menu.anchor !== null && menu.anchor === ref.current;
  const active = menuActive || flyoutOpen;
  const cls = ['session-action-chip', 'draft-project-chip'];
  if (chip.isNew) cls.push('draft-project-chip-new');
  if (chip.ai) cls.push('session-action-chip-ai');
  if (active) cls.push('session-action-chip-active');
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={cls.join(' ')}
        {...(viaMenu ? { [DRAFT_MENU_OWNER_ATTR]: menu.ownerId } : {})}
        disabled={chip.action === 'none'}
        title={chip.title}
        aria-haspopup={viaMenu ? 'dialog' : 'listbox'}
        aria-expanded={active}
        // WebKit (the Mac app) blurs the composer on a button mousedown even
        // though the button never takes focus; the caret must stay put.
        onMouseDown={viaMenu ? (e) => e.preventDefault() : undefined}
        onClick={chip.action === 'none' ? undefined
          : viaMenu ? (e) => menu.openFrom(e.currentTarget, e)
          : () => setFlyoutOpen((o) => !o)}
      >
        <span className="draft-pill-key">{chip.key}</span>{' '}
        <span className="draft-pill-name">{chip.name}</span>
        <AiBadge on={chip.ai} />
      </button>
      {flyoutOpen && (
        <ProjectPickerFlyout
          open
          anchorRef={ref}
          current={project}
          onPick={(name) => { if (name !== project) onPick(name); }}
          onClose={() => setFlyoutOpen(false)}
          // UPWARD like the folder picker beside it: both live at the column's
          // bottom, and one row opening two directions reads broken.
          preferSide="up"
        />
      )}
    </>
  );
}

/** The narrow layout's forced wrap point (CSS shows it under 421px). */
export function DraftPillsBreak() {
  return <span className="draft-pills-break" aria-hidden="true" />;
}
