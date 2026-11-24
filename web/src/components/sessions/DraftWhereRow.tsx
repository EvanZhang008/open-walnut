/**
 * The new task draft's Project + Where row and the one line under it (experiment
 * `project_first_start`, v6; words and rules in draft-work-in.ts, state in useDraftWhere.ts):
 *
 *   [PROJECT  ⑂ Marina   ▾] [WHERE  ● devbox ▾ › ✦Auto New worktree               ⌕]
 *   ◷ Last used for Marina: Auto on devbox, 12 min ago.
 *
 * Where is one path whose first part is the host: the host part opens the Host menu, a middle
 * part opens the Where menu at that level, anything else the Where menu with an empty search.
 * A folder keeps its last three parts, then two, then its name only (never cut). Narrow
 * (< 760 px): host and folder name only, and the whole field opens the Where menu. The field
 * itself is one real button under its parts (keyboard and pointer reach it the same); wide, the
 * host part and the levels are buttons over it.
 * Every slot has a fixed size: no pick, menu or message moves the composer below.
 */
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import * as ICONS from '@/components/common/Icons';
import { MenuCaret } from '@/components/controls';
import { projectDisplayName } from '@/utils/project-display';
import { badge } from '@/components/common/badge';
import { knownHomeOf, pathCrumbItems, shownFolderName, tildePath, type PathCrumb } from '@/utils/home-folder';
import { timeAgo } from '@/utils/time';
import { HostStatusDot } from './path-selector/HostStatusDot';
import { ProjectStartFlyout } from './ProjectStartFlyout';
import { WhereIcon, whereKindOf } from './DraftWhereIcons';
import { DraftWhereMenu } from './DraftWhereMenu';
import { DraftProjectMenu } from './DraftProjectMenu';
import type { DraftColumn } from './draft-column';
import { sourceArrayFields } from './draft-project-start';
import type { DraftWhere } from './useDraftWhere';
import { hostLine, lastUsedParts, type LinePart } from './draft-work-in';

export type RowMenu = null | { kind: 'where'; query: string } | { kind: 'host' } | { kind: 'project' };

export function DraftWhereRow({ draft, where, boundsRef, narrow, menu, setMenu, startError, onUpdate, onCustomizeWalnut }: {
  draft: DraftColumn;
  where: DraftWhere;
  /** The draft panel: every menu stays inside it. */
  boundsRef: RefObject<HTMLElement | null>;
  narrow: boolean;
  menu: RowMenu;
  setMenu: (m: RowMenu) => void;
  /** The server refused the last Start from a project: its words take the line. */
  startError?: string;
  onUpdate: Parameters<typeof DraftWhereMenu>[0]['onUpdate'];
  onCustomizeWalnut?: () => void;
}) {
  const projectRef = useRef<HTMLDivElement>(null);
  const whereRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLButtonElement>(null);
  const close = () => setMenu(null);
  // Measured when the menu opens, never during a render.
  const [menuWidth, setMenuWidth] = useState(WHERE_MENU_PX);
  const whereOpen = menu?.kind === 'where';
  useLayoutEffect(() => { if (whereOpen) setMenuWidth(whereMenuWidth(whereRef, boundsRef, narrow)); }, [whereOpen, narrow, boundsRef]);
  return (
    <div className={`draft-v6-row-slot${menu ? ' has-menu' : ''}`}>
      <div className="draft-v6-row">
        <ProjectField draft={draft} where={where} fieldRef={projectRef} open={menu?.kind === 'project'}
          onOpen={() => setMenu(menu?.kind === 'project' ? null : { kind: 'project' })} />
        <WhereField draft={draft} where={where} fieldRef={whereRef} hostRef={hostRef} narrow={narrow} menu={menu} setMenu={setMenu} />
      </div>
      <WhereLineView where={where} narrow={narrow} startError={startError} onPickFolder={() => setMenu({ kind: 'where', query: '' })} />
      <ProjectStartFlyout open={menu?.kind === 'project'} anchorRef={projectRef} onClose={close} label="Project"
        className="draft-v6-menu draft-v6-project-menu" testId="draft-v6-project-menu" minHeight={200} boundsRef={boundsRef}>
        <DraftProjectMenu where={where} onDone={close} onCustomizeWalnut={onCustomizeWalnut} />
      </ProjectStartFlyout>
      <ProjectStartFlyout open={menu?.kind === 'host'} anchorRef={hostRef} onClose={close} label="Runs on"
        className="draft-v6-menu draft-v6-host-menu" testId="draft-v6-host-menu" minHeight={120} boundsRef={boundsRef}>
        <HostMenu where={where} onDone={close} />
      </ProjectStartFlyout>
      <ProjectStartFlyout open={menu?.kind === 'where'} anchorRef={whereRef} onClose={close} label="Where"
        className="draft-v6-menu draft-v6-where-menu" testId="draft-v6-where-menu" minHeight={200} boundsRef={boundsRef}
        style={{ width: menuWidth, height: 310 }}>
        {menu?.kind === 'where' && (
          <DraftWhereMenu draft={draft} where={where} initialQuery={menu.query} onClose={close} onUpdate={onUpdate} />
        )}
      </ProjectStartFlyout>
    </div>
  );
}

const WHERE_MENU_PX = 440;
/** A narrow draft's Where menu: never under 420 while the draft has the room (review: a 310 px
 *  one cut Auto's title), even over the "Start task" label. */
const NARROW_MENU_MIN_PX = 420;

/** 440 px (review N6: at 480 the menu covered the "Start task" label), narrower when the label is
 *  closer (its rows end in an ellipsis then, never cut). */
function whereMenuWidth(fieldRef: RefObject<HTMLElement | null>, boundsRef: RefObject<HTMLElement | null>, narrow: boolean): number {
  const field = fieldRef.current?.getBoundingClientRect();
  const bounds = boundsRef.current?.getBoundingClientRect();
  if (narrow) return Math.min(Math.max(NARROW_MENU_MIN_PX, field?.width ?? 0), WHERE_MENU_PX, bounds ? bounds.width - 24 : WHERE_MENU_PX);
  const label = boundsRef.current?.querySelector('.draft-v6-send-label')?.getBoundingClientRect();
  if (!field || !label || label.width === 0) return WHERE_MENU_PX;
  return Math.max(240, Math.min(WHERE_MENU_PX, label.left - field.left - 12));
}

function ProjectField({ draft, where, fieldRef, open, onOpen }: {
  draft: DraftColumn; where: DraftWhere; fieldRef: RefObject<HTMLDivElement | null>; open: boolean; onOpen: () => void;
}) {
  const name = where.project;
  const kind = name ? (where.row ? (where.row.startSource ? whereKindOf(where.row.startSource) : 'folder') : 'folder') : 'home';
  // Only a project the folder's code named (stampFolderDetection), never a name made from the folder.
  const detected = !!name && draft.projectSource === 'folder' && (draft.detectedProject ?? '').toLowerCase() === (draft.project ?? '').toLowerCase();
  const title = name ? `Project: ${projectDisplayName(name)}${detected ? ' (detected from the folder)' : ''}` : 'No project: the task goes to the Inbox'; // empty-state-ok: a tooltip
  return (
    <div ref={fieldRef} className={`draft-v6-field draft-v6-project${open ? ' is-open' : ''}`} data-testid="draft-v6-project" title={title}
      onMouseDown={(e) => e.preventDefault()}>
      {/* The field's own button, under its parts (as Where's): the family's link key, so it draws nothing. */}
      <FieldOpen testId="draft-v6-project-open" label={`${title}. Change the project`} open={open} onClick={onOpen} />
      {/* "detected" sits on the key line, so the name below keeps the whole width (review: it was cut). */}
      <span className="draft-v6-field-key">Project{detected && <span className="draft-v6-key-note" data-testid="draft-v6-detected">detected</span>}</span>
      <span className="draft-v6-field-value">
        <span className={`draft-v6-project-icon is-${kind}`}><WhereIcon kind={kind} size={14} /></span>
        <span className={`draft-v6-project-name wn-meta${name ? '' : ' is-empty'}`} data-testid="draft-v6-project-name">{name ? projectDisplayName(name) : 'No project'}</span>{/* empty-state-ok: a field's value */}
        <MenuCaret className="draft-v6-caret" />
      </span>
    </div>
  );
}

/** A field's own button: it lies under the field's parts, Tab reaches it, Enter or a click opens the menu. */
function FieldOpen({ testId, label, open, onClick }: { testId: string; label: string; open: boolean; onClick: () => void }) {
  return (
    <button type="button" className="btn btn-link draft-v6-field-open" data-testid={testId} aria-label={label}
      aria-haspopup="dialog" aria-expanded={open} onClick={onClick} />
  );
}

function HostCrumb({ where, hostRef, onClick, open }: { where: DraftWhere; hostRef: RefObject<HTMLButtonElement | null>; onClick?: () => void; open: boolean }) {
  const key = where.hostKey;
  const name = where.hostName(key);
  const content = (
    <>
      {key === '__local__' ? <span className="draft-v6-dot is-on" aria-hidden="true" /> : <HostStatusDot host={key} label={name} className="draft-v6-host-dot" />}
      <span className="draft-v6-host-name wn-meta">{name}</span>
    </>
  );
  if (!onClick) return <span className="draft-v6-host-static" data-testid="draft-v6-host">{content}</span>;
  return (
    <button ref={hostRef} type="button" className="btn btn-sm draft-v6-host" data-testid="draft-v6-host"
      aria-haspopup="dialog" aria-expanded={open} title={`Runs on ${name}. Pick another host`}
      onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      {content}
      <MenuCaret className="draft-v6-caret" />
    </button>
  );
}

function WhereField({ draft, where, fieldRef, hostRef, narrow, menu, setMenu }: {
  draft: DraftColumn; where: DraftWhere; fieldRef: RefObject<HTMLDivElement | null>; hostRef: RefObject<HTMLButtonElement | null>;
  narrow: boolean; menu: RowMenu; setMenu: (m: RowMenu) => void;
}) {
  const openWhere = (query = '') => setMenu(menu?.kind === 'where' && !query ? null : { kind: 'where', query });
  const gone = where.line?.kind === 'gone';
  const off = (where.autoCurrent && !where.verdict.ok && !where.verdict.noProject) || where.sourceGone || gone;
  const home = knownHomeOf(draft.host);
  const shown = draft.cwd ? tildePath(draft.cwd, home) : '';
  const label = where.autoCurrent
    ? `Where: ${where.hostName(where.hostKey)}, Auto, ${off ? `no ${where.what.words.replace(/^New /, '')} on ${where.hostName(where.hostKey)}` : where.what.words}`
    : `Where: ${where.hostName(where.hostKey)}, ${shown || 'no folder'}`;
  return (
    <div ref={fieldRef} className={`draft-v6-field draft-v6-where${off || where.offHost ? ' is-off' : ''}${menu?.kind === 'where' ? ' is-open' : ''}`}
      role="group" aria-label={label} data-testid="draft-v6-where" data-auto={where.autoCurrent ? 'true' : 'false'}
      title={where.autoCurrent ? undefined : draft.cwd}
      onMouseDown={(e) => { if (!(e.target as Element).closest('input')) e.preventDefault(); }}>
      <FieldOpen testId="draft-v6-where-open" label={`${label}. Change where it runs`} open={menu?.kind === 'where'} onClick={() => openWhere('')} />
      <span className="draft-v6-field-key">Where</span>
      <span className="draft-v6-field-value draft-v6-crumbs">
        {/* Narrow: the whole field opens Where (the spec); the host part is a button only when wide. */}
        <HostCrumb where={where} hostRef={hostRef} open={menu?.kind === 'host'}
          {...(narrow ? {} : { onClick: () => setMenu(menu?.kind === 'host' ? null : { kind: 'host' }) })} />
        <span className="draft-v6-sep" aria-hidden="true">{ICONS.ICON_CHEVRON_RIGHT}</span>
        {where.autoCurrent ? <AutoValue where={where} off={off} gone={gone} picked={draft.fromProjectInputs} /> : (
          <FolderCrumbs path={shown} narrow={narrow} offHost={where.offHost ? where.hostName(where.hostKey) : null} gone={gone}
            onLevel={(dir) => openWhere(`${dir}/`)} />
        )}
      </span>
      {!narrow && <span className="draft-v6-search" aria-hidden="true">{ICONS.ICON_SEARCH}</span>}
    </div>
  );
}

function AutoValue({ where, off, gone, picked }: { where: DraftWhere; off: boolean; gone: boolean; picked?: Record<string, string[]> }) {
  const hostName = where.hostName(where.hostKey);
  const count = where.ps.source && where.what.kind === 'box' ? packagesWords(where.ps.source, picked) : '';
  const words = where.sourceGone ? 'No code source' : gone ? `${where.what.words} is gone` : off ? `No ${where.what.words.replace(/^New /, '')} on ${hostName}` : where.what.words; // empty-state-ok: a field's value
  return (
    <span className="draft-v6-auto-value" data-testid="draft-v6-auto">
      <span className={`${badge(off ? 'warning' : 'neutral')} draft-v6-auto-tag`}><WhereIcon kind={off ? 'ban' : 'auto'} size={11} />Auto</span>
      <span className="draft-v6-auto-words">{words}</span>
      {count && !off && <span className="draft-v6-auto-count"> · {count}</span>}
    </span>
  );
}

/** "2 packages": the first list input's count, as this start has it. */
function packagesWords(source: NonNullable<DraftWhere['ps']['source']>, picked?: Record<string, string[]>): string {
  const f = sourceArrayFields(source, picked)[0];
  if (!f) return '';
  const n = f.values.length;
  const word = f.title.toLowerCase();
  return `${n} ${n === 1 ? word.replace(/s$/, '') : word}`;
}

/** The folder's parts after the host: the widest level that fits (3, 2, then the name only). */
function FolderCrumbs({ path, narrow, offHost, gone, onLevel }: { path: string; narrow: boolean; offHost: string | null; gone: boolean; onLevel: (dir: string) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const levels: PathCrumb[][] = narrow ? [pathCrumbItems(path, 1).slice(-1)] : [pathCrumbItems(path, 3), pathCrumbItems(path, 2), pathCrumbItems(path, 1)];
  const [level, setLevel] = useState(0);
  const at = Math.min(level, levels.length - 1);
  useLayoutEffect(() => { setLevel(0); }, [path, narrow]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && el.scrollWidth > el.clientWidth + 1 && level < levels.length - 1) setLevel(level + 1);
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => { if (el.clientWidth !== w) { w = el.clientWidth; setLevel(0); } });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const crumbs = levels[at];
  return (
    <span ref={ref} className="draft-v6-folder-crumbs" data-testid="draft-v6-folder">
      {(offHost || gone) && <WhereIcon kind="gone" className="draft-v6-gone" />}
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={`${i}-${c.label}`} className="draft-v6-crumb-wrap">
            {i > 0 && <span className="draft-v6-sep" aria-hidden="true">{ICONS.ICON_CHEVRON_RIGHT}</span>}
            {last || !c.dir ? (
              <span className={`draft-v6-crumb${last ? ' is-last' : ''}${c.label === '…' ? ' is-fold' : ''}${c.label === '~' && !last ? ' is-home' : ''}`}>{c.label}</span>
            ) : (
              <button type="button" className="btn btn-link draft-v6-level" title={c.label === '~' ? `Open ${c.dir}: the home folder` : `Open ${c.dir}`}
                onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); onLevel(c.dir); }}>
                {/* The home reads as a home, never as a thin mark between two arrows. */}
                {c.label === '~' && <WhereIcon kind="home" size={13} />}{c.label}
              </button>
            )}
          </span>
        );
      })}
      {offHost && <span className={`${badge('warning')} draft-v6-tag`} data-testid="draft-v6-not-on"><span>not on {offHost}</span></span>}
    </span>
  );
}

function HostMenu({ where, onDone }: { where: DraftWhere; onDone: () => void }) {
  return (
    <div role="listbox" aria-label="Runs on">
      <div className="draft-v6-menu-title">Runs on</div>
      {where.hosts.map((h) => {
        const current = h.key === where.hostKey;
        return (
          <button key={h.key} type="button" role="option" aria-selected={current} className="draft-v6-option wn-pick-row"
            data-testid={`draft-v6-host-${h.key}`} title={h.title} onClick={() => { where.pickHost(h.key); onDone(); }}>
            {h.local ? <span className="draft-v6-dot is-on" aria-hidden="true" /> : <HostStatusDot host={h.key} label={h.name} className="draft-v6-host-dot" />}
            <span className="draft-v6-option-text">
              <span className="draft-v6-option-name wn-title wn-pick-name">{h.name}</span>
              <span className="draft-v6-option-line">{hostLine(h.local, h.connected)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Parts({ parts }: { parts: LinePart[] }) {
  return <>{parts.map((p, i) => (p.style === 'b' ? <b key={i}>{p.text}</b> : p.style === 'code' ? <code key={i}>{p.text}</code> : <span key={i}>{p.text}</span>))}</>;
}

/** The one line under the row: words, then at most two actions. */
function WhereLineView({ where, narrow, startError, onPickFolder }: { where: DraftWhere; narrow: boolean; startError?: string; onPickFolder: () => void }) {
  const l = where.line;
  const hostName = where.hostName(where.hostKey);
  const act = (label: string, onClick: () => void, testId: string) => (
    <button type="button" className="btn btn-link draft-v6-line-act" data-testid={testId}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{label}</button>
  );
  let body: ReactNode = null;
  let tone = '';
  if (startError) {
    // The server's refusal, as every other state line: an icon, its words, the way out.
    tone = ' is-error';
    body = (<>
      <WhereIcon kind="ban" />
      <span className="draft-v6-line-text" data-testid="draft-project-start-error">{startError}</span>
      {act(`Pick a folder on ${hostName}`, onPickFolder, 'draft-v6-line-pick')}
    </>);
  } else if (l?.kind === 'no-source') {
    tone = ' is-warn';
    body = (<>
      <WhereIcon kind="ban" />
      <span className="draft-v6-line-text">{l.reason}</span>
      {act(`Pick a folder on ${hostName}`, onPickFolder, 'draft-v6-line-pick')}
    </>);
  } else if (l?.kind === 'off-host') {
    tone = ' is-warn';
    body = (<>
      <WhereIcon kind="gone" />
      <span className="draft-v6-line-text">This folder is on {where.hostName(l.other)}, not on {hostName}.</span>
      {act(`Run on ${where.hostName(l.other)}`, () => where.pickHost(l.other), 'draft-v6-line-run')}
      {act(`Pick a folder on ${hostName}`, onPickFolder, 'draft-v6-line-pick')}
    </>);
  } else if (l?.kind === 'gone') {
    tone = ' is-warn';
    body = (<>
      <WhereIcon kind="gone" />
      <span className="draft-v6-line-text" data-testid="draft-v6-folder-gone">This folder is gone on {hostName}.</span>
      {act(`Pick a folder on ${hostName}`, onPickFolder, 'draft-v6-line-pick')}
    </>);
  } else if (l?.kind === 'cannot') {
    tone = ' is-warn';
    body = (<>
      <WhereIcon kind="ban" />
      <span className="draft-v6-line-text">{l.reason}</span>
      {act(`Run on ${where.hostName(l.projectHost)}`, () => where.pickAuto(l.projectHost), 'draft-v6-line-run')}
      {act(`Pick a folder on ${hostName}`, onPickFolder, 'draft-v6-line-pick')}
    </>);
  } else if (l?.kind === 'last-used') {
    body = (<>
      <WhereIcon kind="clock" className="draft-v6-line-clock" />
      <span className="draft-v6-line-text" data-testid="draft-v6-last-used">
        <Parts parts={lastUsedParts(l, {
          narrow, hostName: where.hostName,
          folderName: (cwd, h) => shownFolderName(cwd, h === '__local__' ? null : h),
          ago: (iso) => timeAgo(iso, { long: true }),
        })} />
      </span>
      {!l.place.auto && !l.place.first && act('Back to Auto', where.backToAuto, 'draft-v6-back-to-auto')}
    </>);
  } else if (l?.kind === 'suggest') {
    body = (<>
      <WhereIcon kind="auto" />
      <span className="draft-v6-line-text">This folder is {l.project}’s code. Use a fresh workspace instead?</span>
      {act('Use fresh workspace', where.useFresh, 'work-in-suggest-use')}
      {act('Keep', where.keepFolder, 'work-in-suggest-keep')}
    </>);
  } else if (l?.kind === 'moved') {
    const anchor = where.ps.source?.anchor ? tildePath(where.ps.source.anchor, knownHomeOf(where.ps.source.host === '__local__' ? null : where.ps.source.host)) : '';
    body = (<>
      <WhereIcon kind="auto" />
      <span className="draft-v6-line-text">Auto on {hostName}: {where.what.kind === 'git' ? `a new worktree from ${anchor}` : `a fresh workspace from ${anchor}`}.</span>
      {act(`Back to ${where.hostName(l.projectHost)}`, () => where.pickAuto(l.projectHost), 'draft-v6-line-back')}
    </>);
  }
  return (
    <div className={`draft-v6-line${tone}`} role="status" data-testid="draft-v6-line" data-kind={startError ? 'error' : l?.kind ?? 'none'}>
      {body}
    </div>
  );
}
