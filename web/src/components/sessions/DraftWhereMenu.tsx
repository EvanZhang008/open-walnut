/**
 * The Where menu (experiment `project_first_start`, v6): a fixed 440 x 310 box under the Where
 * field. Its first row is Auto (what the project makes on this host, or why the host cannot,
 * with one way out); a code source's packages sit right under it; then the recent folders by
 * host. Typing searches every host's folders; a path (`/`, `~`) lists that level on the draft's
 * host, with its breadcrumb and "Use this path". ↑↓ move, Enter picks, → completes a level.
 * Rows and their words: draft-where-menu.ts and draft-work-in.ts. Mounted per open, so the
 * search starts from the field's click each time.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import * as ICONS from '@/components/common/Icons';
import { SearchField } from '@/components/common/SearchField';
import { badge } from '@/components/common/badge';
import { projectDisplayName } from '@/utils/project-display';
import { knownHomeOf, tildePath, untildePath } from '@/utils/home-folder';
import { timeAgo } from '@/utils/time';
import { useWorkingDirs } from './path-selector/useWorkingDirs';
import { useLiveDirs } from './path-selector/useLiveDirs';
import { liveListingPrefix } from './path-selector/input-model';
import { WhereIcon } from './DraftWhereIcons';
import { DraftSourcePackages } from './DraftSourcePackages';
import type { DraftColumn } from './draft-column';
import type { DraftRowUpdate, DraftWhere } from './useDraftWhere';
import { autoNote, detectProjectForFolder, draftHostFor, ownHostOf } from './draft-work-in';
import { folderSections, isPathQuery, shownPath, typedPathView, type MenuFolderRow } from './draft-where-menu';

interface Pickable { id: string; pick: () => void; complete?: string }

export function DraftWhereMenu({ draft, where, initialQuery, onClose, onUpdate }: {
  draft: DraftColumn;
  where: DraftWhere;
  initialQuery: string;
  onClose: () => void;
  onUpdate: DraftRowUpdate;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { hosts: configured } = useWorkingDirs(true);
  const hostKey = where.hostKey;
  const host = where.hostName(hostKey);
  const homeOf = (key: string) => knownHomeOf(draftHostFor(key));
  const pathMode = isPathQuery(query);
  const prefix = pathMode && query !== '~' ? liveListingPrefix(typedPathView(query, undefined).state) : '';
  const { byHost } = useLiveDirs(prefix, hostKey, configured);
  const typed = pathMode && query !== '~' ? typedPathView(query, byHost.get(hostKey)) : null;
  const sections = useMemo(() => (pathMode ? [] : folderSections(where.dirs, {
    hostKey, hostName: where.hostName, homeOf, rows: where.rows, query,
    current: !where.autoCurrent && draft.cwd ? { cwd: draft.cwd, host: hostKey } : null,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- homeOf reads a module cache
  })), [pathMode, where.dirs, hostKey, where.hostName, where.rows, query, where.autoCurrent, draft.cwd]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const pickFolder = (cwd: string, key: string, label?: string, lastLaunch?: MenuFolderRow['lastLaunch']) => {
    where.pickFolder(cwd, key, label, lastLaunch);
    onClose();
  };
  const pickables: Pickable[] = [];
  const showAuto = !pathMode && !query.trim();
  const v = where.verdict;
  if (showAuto && where.project && v.ok) pickables.push({ id: 'auto', pick: () => { where.pickAuto(hostKey); onClose(); } });
  if (typed?.use && typed.use.validity !== 'missing') {
    const path = untildePath(typed.use.path, homeOf(hostKey));
    pickables.push({ id: 'use', pick: () => pickFolder(path, hostKey), complete: `${typed.use.path}/` });
  }
  const homeRows = pathMode && query === '~' ? where.hosts : [];
  for (const h of homeRows) pickables.push({ id: `home:${h.key}`, pick: () => pickFolder(h.local ? (knownHomeOf(null) ?? '~') : '~', h.key), complete: '~/' });
  for (const c of typed?.children ?? []) pickables.push({ id: `child:${c}`, pick: () => pickFolder(c, hostKey), complete: `${tildePath(c, homeOf(hostKey))}/` });
  for (const s of sections) for (const r of s.rows) {
    pickables.push({ id: `dir:${r.key}`, pick: () => pickFolder(r.cwd, r.host, r.hostLabel, r.lastLaunch), complete: r.host === hostKey ? `${tildePath(r.cwd, homeOf(r.host))}/` : undefined });
  }
  const at = Math.min(active, Math.max(0, pickables.length - 1));
  const activeId = pickables[at]?.id;
  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = pickables.length;
      if (n) setActive((a) => (Math.min(a, n - 1) + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickables[at]?.pick();
    } else if (e.key === 'ArrowRight' && inputRef.current?.selectionStart === query.length) {
      const next = pickables[at]?.complete;
      if (next) { e.preventDefault(); setQuery(next); }
    }
  };
  const rowProps = (id: string) => ({
    className: `draft-v6-wm-row${id === activeId ? ' is-active' : ''}`,
    onMouseEnter: () => { const i = pickables.findIndex((p) => p.id === id); if (i >= 0) setActive(i); },
  });

  const autoLine = where.row ? autoNote(where.row, v, {
    anchorShown: where.row.startSource ? tildePath(where.row.startSource.anchor, homeOf(where.row.startSource.host)) : undefined,
    folderShown: where.row.defaultCwd ? tildePath(where.row.defaultCwd, homeOf(where.row.defaultHost ?? '__local__')) : undefined,
    picked: draft.fromProjectInputs,
  }) : autoNote(undefined, v);
  const ownKey = ownHostOf(where.row);
  const recommended = !where.autoCurrent && !!where.detected?.hasSource && where.detected.project === where.project;

  return (
    <div className="draft-v6-wm" data-testid="draft-v6-where-menu-body">
      <div className="draft-v6-wm-search">
        {/* The one search field (standard.md "Fields"); a typed path reads in the code font. */}
        <SearchField small fieldClassName="draft-v6-wm-field"
          ref={inputRef}
          className={pathMode ? 'draft-v6-wm-path' : undefined}
          data-no-draft="search"
          data-testid="draft-v6-where-search"
          placeholder="Search folders, or type / or ~"
          aria-label="Search folders or type a path"
          title="Esc closes"
          value={query}
          spellCheck={false}
          autoComplete="off"
          setText={setQuery}
          onClear={() => { setQuery(''); }}
          onKeyDown={onKey}
        />
      </div>
      <div ref={listRef} className="draft-v6-wm-list" role="listbox" aria-label="Where">
        {showAuto && (
          <>
            {!where.project ? (
              <div className="draft-v6-wm-row is-disabled draft-v6-auto-row" role="option" aria-disabled="true" aria-selected={false} data-testid="draft-v6-auto-row" data-state="no-project">
                <span className="draft-v6-wm-ico"><WhereIcon kind="auto" size={15} /></span>
                <span className="draft-v6-wm-text"><span className="draft-v6-wm-name is-dim"><Title>Auto</Title></span><span className="draft-v6-wm-line">{autoLine}</span></span>
              </div>
            ) : !v.ok ? (
              <div className="draft-v6-wm-row is-disabled draft-v6-auto-row is-cannot" role="option" aria-disabled="true" aria-selected={false} data-testid="draft-v6-auto-row" data-state="cannot"
                title={`Auto cannot run on ${host}: ${autoLine}`}>
                <span className="draft-v6-wm-ico is-ban"><WhereIcon kind="ban" size={15} /></span>
                <span className="draft-v6-wm-text">
                  <span className="draft-v6-wm-name is-dim"><Title>Auto · {where.what.words} on {host}</Title></span>
                  {/* The reason is read whole: it wraps to a second line, never cut. */}
                  <span className="draft-v6-wm-line is-reason">{autoLine}</span>
                  {/* Under the reason, so title and reason keep the row's whole width in a narrow menu. */}
                  <button type="button" className="btn btn-sm draft-v6-mini" data-testid="draft-v6-auto-way-out" title={`Auto on ${where.hostName(ownKey)}`}
                    onClick={() => { where.pickAuto(ownKey); onClose(); }}>
                    Run on {where.hostName(ownKey)}
                  </button>
                </span>
              </div>
            ) : (
              <div {...rowProps('auto')} role="option" aria-selected={where.autoCurrent} data-testid="draft-v6-auto-row" data-state="ok"
                onClick={() => { where.pickAuto(hostKey); onClose(); }}>
                <span className="draft-v6-wm-ico"><WhereIcon kind="auto" size={15} /></span>
                <span className="draft-v6-wm-text">
                  <span className="draft-v6-wm-name"><Title>Auto · {where.what.words} on {host}</Title>{recommended && <span className={`${badge('accent')} draft-v6-tag is-rec`}>recommended</span>}</span>
                  <span className="draft-v6-wm-line">{autoLine}</span>
                </span>
                <span className="draft-v6-wm-right">{where.autoCurrent && <span className="draft-v6-check">{ICONS.ICON_CHECK}</span>}</span>
              </div>
            )}
            {where.project && v.ok && where.ps.source && (
              <DraftSourcePackages draft={draft} source={where.ps.source} onUpdate={onUpdate} />
            )}
          </>
        )}
        {typed && (
          <>
            <div className="draft-v6-wm-crumbs" data-testid="draft-v6-typed-crumbs">
              <WhereIcon kind="folder" />
              {typed.crumbs.map((c, i) => (
                <span key={`${i}-${c.label}`} className="draft-v6-crumb-wrap">
                  {i > 0 && <span className="draft-v6-sep" aria-hidden="true">›</span>}
                  {c.dir ? <button type="button" className="btn btn-link draft-v6-level" onClick={() => { setQuery(`${c.dir === '/' ? '' : c.dir}/`); inputRef.current?.focus(); }}>{c.label}</button>
                    : <span className="draft-v6-crumb">{c.label}</span>}
                </span>
              ))}
            </div>
            {typed.use && (
              typed.use.validity === 'missing' ? (
                <div className="draft-v6-wm-row is-disabled" role="option" aria-disabled="true" aria-selected={false} data-testid="draft-v6-use-path" data-state="missing">
                  <span className="draft-v6-wm-ico">/</span>
                  <span className="draft-v6-wm-text">
                    <span className="draft-v6-wm-name is-dim" title={typed.use.path}><Title>Use this path</Title><code>{shownPath(typed.use.path, undefined, 2)}</code></span>
                    <span className="draft-v6-wm-line">Folder not found on {host}</span>
                  </span>
                </div>
              ) : (
                <div {...rowProps('use')} role="option" aria-selected={false} data-testid="draft-v6-use-path" data-state={typed.use.validity}
                  onClick={() => pickables.find((p) => p.id === 'use')?.pick()}>
                  <span className="draft-v6-wm-ico">/</span>
                  <span className="draft-v6-wm-text">
                    <span className="draft-v6-wm-name" title={typed.use.path}><Title>Use this path</Title><code>{shownPath(typed.use.path, undefined, 2)}</code></span>
                    <span className="draft-v6-wm-line">{pathUseLine(typed.use.path, hostKey, where, homeOf(hostKey), typed.use.validity)}</span>
                  </span>
                </div>
              )
            )}
            {typed.children.length > 0 && <div className="draft-v6-wm-group">{typed.children.length} on {host}</div>}
            {typed.children.map((c) => (
              <FolderRow key={c} id={`child:${c}`} rowProps={rowProps} onPick={() => pickFolder(c, hostKey)} name={c.slice(c.lastIndexOf('/') + 1)}
                path={shownPath(c, homeOf(hostKey))} project={detectProjectForFolder(c, hostKey, where.rows, { home: homeOf(hostKey) })?.project} />
            ))}
            {typed.loading && !typed.children.length && <div className="draft-v6-wm-empty">Listing on {host}…</div>}
          </>
        )}
        {homeRows.map((h) => (
          <FolderRow key={h.key} id={`home:${h.key}`} rowProps={rowProps} onPick={() => pickables.find((p) => p.id === `home:${h.key}`)?.pick()}
            name="~" path={`Home on ${h.name}`} />
        ))}
        {sections.map((s) => (
          <div key={s.title} role="group" aria-label={s.title}>
            <div className="draft-v6-wm-group">{s.title}</div>
            {!s.rows.length && <div className="draft-v6-wm-empty is-quiet">No folder used on {where.hostName(hostKey)} yet. Type a path: / or ~</div>}
            {s.rows.map((r) => (
              <FolderRow key={r.key} id={`dir:${r.key}`} rowProps={rowProps} onPick={() => pickFolder(r.cwd, r.host, r.hostLabel, r.lastLaunch)}
                name={r.name} path={r.path} project={r.project} at={r.at} current={r.current} />
            ))}
          </div>
        ))}
        {!pathMode && query.trim() && !sections.length && <div className="draft-v6-wm-empty">No folder matches. Type a path: / or ~</div>}
      </div>
      <div className="draft-v6-wm-foot" aria-hidden="true">
        <kbd className="draft-v6-kbd">↑↓</kbd> move <kbd className="draft-v6-kbd">Enter</kbd> pick <kbd className="draft-v6-kbd">→</kbd> open a level
        <span className="draft-v6-wm-count">{where.dirs.length} {where.dirs.length === 1 ? 'folder' : 'folders'}</span>
      </div>
    </div>
  );
}

function pathUseLine(path: string, hostKey: string, where: DraftWhere, home: string | undefined, validity: 'valid' | 'unknown'): string {
  if (validity === 'unknown') return `Checking on ${where.hostName(hostKey)}…`;
  const found = detectProjectForFolder(untildePath(path, home), hostKey, where.rows, { home });
  return found ? `Project: ${projectDisplayName(found.project)} (detected)` : 'No project, use this folder';
}

function FolderRow({ id, rowProps, onPick, name, path, project, at, current }: {
  id: string;
  rowProps: (id: string) => { className: string; onMouseEnter: () => void };
  onPick: () => void;
  name: string;
  path: string;
  project?: string;
  at?: string;
  current?: boolean;
}) {
  return (
    <div {...rowProps(id)} role="option" aria-selected={!!current} data-testid="draft-v6-folder-row" data-name={name} onClick={onPick}>
      <span className="draft-v6-wm-ico"><WhereIcon kind="folder" size={15} /></span>
      <span className="draft-v6-wm-text">
        <span className="draft-v6-wm-name"><Title>{name}</Title>{project && <span className={`${badge()} draft-v6-tag`}><span>{projectDisplayName(project)}</span></span>}</span>
        <span className="draft-v6-wm-line is-path">{path}</span>
      </span>
      <span className="draft-v6-wm-right">
        {current ? <span className="draft-v6-check">{ICONS.ICON_CHECK}</span> : at ? <span className="draft-v6-wm-time">{timeAgo(at, { long: true })}</span> : null}
      </span>
    </div>
  );
}

/** A row's title: its own box, so a long one ends in an ellipsis before the tag and the check. */
function Title({ children }: { children: ReactNode }) {
  // The words that tell one row from another wrap, never cut (standard.md "Text that does not fit").
  return <span className="draft-v6-wm-title wn-title">{children}</span>;
}
