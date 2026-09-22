/**
 * The content blocks of EngineSettingsPopover: the sentences under the scope
 * switch, the filter, the rows area (skeleton, error, empty, no match, rows)
 * and the footer (saved sentence, link to the full page, Files list).
 *
 * Every sentence comes from `@/utils/engine-settings-copy`; nothing here
 * branches on an engine id. Row rendering is `EngineSettingRow` as-is; what
 * this file adds around a row (the not-honored line, the Walnut-environment
 * line, the help match, the project-scope lock for a global-only file) sits in
 * the row's wrapper so the shared component stays untouched.
 */
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import type { EngineSettingView, EngineSettingsView, EngineSettingsWriteScope } from '@/api/engine-settings';
import type { EngineSettingsHook, EngineSettingsLastWrite } from '@/hooks/useEngineSettings';
import { rowHonoredHere, rowLacksProjectLayer, sessionsGroup } from '@/hooks/engine-settings-model';
import {
  appliesOnSentence, emptySentence, envUncheckedSentence, filterSettingRows, noMatchSentence,
  otherGroupsLink, projectFileRelative, savedSentence, scopeSentence, shortenUnderCwd,
} from '@/utils/engine-settings-copy';
import { EngineSettingRow } from '@/components/settings/sections/EngineSettingRows';
import { log } from '@/utils/log';

const SLOW_LOAD_MS = 2000;
const SKELETON_ROWS = 6;

/* ── Under the scope switch ── */

export interface ScopeNotesProps {
  view: EngineSettingsView | null;
  scope: EngineSettingsWriteScope;
  displayName: string;
  hostText: string;
  /**: the uncommitted-draft warning, drawn OVER the scope sentence, right under the switch it answers. */
  draftGuard: string | null;
}

/**
 * The sentences under the switch: ONE line for the scope, one for when a change
 * applies (the fine print lives in the About overlay). Both scope sentences fit
 * one line at the popover's width, so neither the view landing nor a scope
 * switch moves the filter and the rows. The draft guard is drawn over the scope
 * line while it dims: the block keeps its height and shows no blank band, and
 * the guard sits right under the switch the user just clicked.
 */
export function EngineSettingsScopeNotes({ view, scope, displayName, hostText, draftGuard }: ScopeNotesProps) {
  const projectFile = view ? projectFileRelative(view.files, view.cwd) : undefined;
  const applies = appliesOnSentence(view?.appliesOn, displayName);
  const envUnchecked = !!view && !view.envChecked;
  return (
    <div className={`engine-settings-popover-notes${envUnchecked ? ' has-env-note' : ''}${draftGuard ? ' has-guard' : ''}`}>
      <p className="engine-settings-scope-note" data-testid="engine-settings-scope-note" aria-hidden={draftGuard ? true : undefined}>
        {scopeSentence(scope, displayName, hostText, projectFile)}
      </p>
      {draftGuard && <p className="engine-settings-draft-guard" role="status">{draftGuard}</p>}
      {applies && <p className="engine-settings-applies-on" data-testid="engine-settings-applies-on">{applies}</p>}
      {envUnchecked && (
        <p className="engine-settings-env-unchecked" data-testid="engine-settings-env-unchecked">{envUncheckedSentence(hostText)}</p>
      )}
    </div>
  );
}

/* ── Filter ── */

export interface FilterBarProps {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (next: string) => void;
  /**: no rows to filter yet (loading, a failed first load, an empty group): the box is disabled like the switch. */
  disabled: boolean;
}

/** The filter alone: the group's help sentence moved into the About overlay. */
export function EngineSettingsFilterBar({ inputRef, value, onChange, disabled }: FilterBarProps) {
  return (
    <div className="engine-settings-filter-bar">
      <input
        ref={inputRef}
        type="search"
        className="engine-settings-filter"
        placeholder="Find a setting"
        aria-label="Find a setting"
        value={value}
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/* ── Rows area ── */

function Skeleton({ hostText }: { hostText: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_LOAD_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="engine-settings-skeleton" aria-busy="true" aria-label="Loading settings">
      {slow && <p className="engine-settings-slow-note">Still reading settings files on {hostText}…</p>}
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <div key={i} className="engine-settings-skeleton-row" aria-hidden>
          <span className="engine-settings-skeleton-bar is-label" />
          <span className="engine-settings-skeleton-bar is-help" />
          <span className="engine-settings-skeleton-bar is-control" />
        </div>
      ))}
    </div>
  );
}

const HELP_HIGHLIGHT = 'engine-settings-help-match';

interface HighlightApi {
  highlights?: Map<string, { add(r: Range): void; delete(r: Range): boolean }>;
}

/**
 * Mark the matched help fragments IN PLACE through the CSS Custom Highlight
 * API: the row's own help text node gets the ranges, no second copy of the
 * sentence exists. Returns false where the API is missing (the caller then
 * renders the marked copy and hides the row's help line instead).
 */
function useHelpHighlight(rowRef: RefObject<HTMLDivElement | null>, help: string, ranges: Array<[number, number]> | undefined): boolean {
  const [inPlace, setInPlace] = useState(false);
  const rangesKey = ranges && ranges.length > 0 ? JSON.stringify(ranges) : '';
  useEffect(() => {
    if (!rangesKey) { setInPlace(false); return; }
    const api = (globalThis as unknown as { CSS?: HighlightApi }).CSS?.highlights;
    const HighlightCtor = (globalThis as unknown as { Highlight?: new () => { add(r: Range): void; delete(r: Range): boolean } }).Highlight;
    const text = rowRef.current?.querySelector('.engine-setting-help')?.firstChild;
    if (!api || !HighlightCtor || !text || text.nodeType !== Node.TEXT_NODE || text.textContent !== help) { setInPlace(false); return; }
    const highlight = api.get(HELP_HIGHLIGHT) ?? new HighlightCtor();
    if (!api.has(HELP_HIGHLIGHT)) api.set(HELP_HIGHLIGHT, highlight);
    const made = (JSON.parse(rangesKey) as Array<[number, number]>).map(([start, end]) => {
      const r = new Range();
      r.setStart(text, start);
      r.setEnd(text, Math.min(end, help.length));
      return r;
    });
    for (const r of made) highlight.add(r);
    setInPlace(true);
    return () => { for (const r of made) highlight.delete(r); };
  }, [rowRef, help, rangesKey]);
  return inPlace;
}

/** The matched help fragments, marked, so the user sees why a row is in a filtered list. */
function HelpMatch({ help, ranges }: { help: string; ranges: Array<[number, number]> }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], i) => {
    if (start > cursor) parts.push(help.slice(cursor, start));
    parts.push(<mark key={i}>{help.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < help.length) parts.push(help.slice(cursor));
  return <span className="engine-setting-help-match">{parts}</span>;
}

export interface RowsAreaProps {
  rowsRef: RefObject<HTMLDivElement | null>;
  settings: EngineSettingsHook;
  engine: string;
  displayName: string;
  hostText: string;
  scope: EngineSettingsWriteScope;
  filter: string;
  busy: boolean;
  onLink: (e: ReactMouseEvent) => void;
}

export function EngineSettingsRowsArea(props: RowsAreaProps) {
  const { rowsRef, settings, engine, displayName, hostText, scope, filter, busy, onLink } = props;
  const { view, loading, loadError } = settings;
  const group = sessionsGroup(view);
  let body: ReactNode;
  if (loading) {
    body = <Skeleton hostText={hostText} />;
  } else if (loadError) {
    body = (
      <div className="engine-settings-popover-error-block" role="alert">
        <p className="engine-settings-popover-error">{loadError.message}</p>
        <button type="button" className="engine-settings-retry" onClick={settings.reload}>Retry</button>
      </div>
    );
  } else if (!view || !group || group.items.length === 0) {
    body = (
      <p className="engine-settings-popover-empty">
        {emptySentence(displayName)}{' '}
        <a href="/settings#engines" onClick={onLink}>Open Settings › Engines</a>
      </p>
    );
  } else {
    const { items, helpMarks } = filterSettingRows(group.items, filter);
    body = items.length === 0
      ? <p className="engine-settings-popover-nomatch">{noMatchSentence(filter.trim())}</p>
      : items.map((item) => (
        <PopoverRow
          key={item.key}
          engine={engine}
          item={item}
          view={view}
          scope={scope}
          saving={settings.savingKeys.includes(item.key)}
          onSet={settings.onSet}
          onReset={settings.onReset}
          helpMarks={helpMarks.get(item.key)}
        />
      ));
  }
  return (
    <div ref={rowsRef} className="engine-settings-popover-rows" aria-busy={busy || undefined}>
      {body}
    </div>
  );
}

interface PopoverRowProps {
  engine: string;
  item: EngineSettingView;
  view: EngineSettingsView;
  scope: EngineSettingsWriteScope;
  saving: boolean;
  onSet: EngineSettingsHook['onSet'];
  onReset: EngineSettingsHook['onReset'];
  helpMarks: Array<[number, number]> | undefined;
}

function PopoverRow({ engine, item, view, scope, saving, onSet, onReset, helpMarks }: PopoverRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const inPlace = useHelpHighlight(rowRef, item.help, helpMarks);
  const ownFile = view.files.find((f) => f.id === item.file);
  // A key kept in a file with no per-project layer (the server says which) is
  // shown but locked under "this project only": the engine would never read it
  // from a project file, and the server refuses the write.
  const globalOnly = scope === 'project' && rowLacksProjectLayer(item);
  // Both sentences sit INSIDE the card, right after the status line
  // (the row component's `statusExtra` slot), never in the gap between cards.
  // The saving cue is in the DOM from the first frame of a save and fades in
  // after 300ms (CSS): a fast save never flashes it, a slow one names itself.
  const honored = rowHonoredHere(item);
  const statusExtra = (honored && !saving) ? undefined : (
    <>
      {!honored && <span className="engine-setting-not-honored">Does not change this session.</span>}
      {saving && <span className="engine-setting-saving" role="status" data-testid={`engine-setting-saving-${item.key}`}>Saving…</span>}
    </>
  );
  const row = (
    <EngineSettingRow engine={engine} item={item} files={view.files} saving={saving} onSet={onSet} onReset={onReset} statusExtra={statusExtra} />
  );
  // The sentence reads ONCE. With the Highlight API the row's own help is
  // marked in place; without it the marked copy is shown and the row's help line
  // is hidden (CSS on has-help-match).
  const hasMatch = !!helpMarks && helpMarks.length > 0;
  const showCopy = hasMatch && !inPlace;
  // Once the write target already holds the value in force (an overlay
  // the status line names), "Saves to <same file>" repeats it; CSS hides it.
  const targetIsSource = item.source === 'overlay' && item.overlay?.file === item.writeTarget.file;
  return (
    <div
      ref={rowRef}
      className={`engine-settings-popover-row${globalOnly ? ' is-global-only' : ''}${showCopy ? ' has-help-match' : ''}`}
      data-key={item.key}
      data-help-match={hasMatch ? (inPlace ? 'in-place' : 'copy') : undefined}
      data-target-is-source={targetIsSource || undefined}
      data-saving={saving || undefined}
    >
      {globalOnly ? (
        <fieldset
          className="engine-settings-row-lock is-global-only"
          disabled
          title={`Stored in ${ownFile?.label ?? item.file}, which has no per-project layer`}
        >
          {row}
        </fieldset>
      ) : row}
      {item.envOverride && (
        <span className="engine-setting-env-walnut">
          Overridden by {item.envOverride.name}={item.envOverride.value} in Walnut's own environment
        </span>
      )}
      {showCopy && <HelpMatch help={item.help} ranges={helpMarks} />}
    </div>
  );
}

/* ── Footer ── */

export interface FooterProps {
  view: EngineSettingsView | null;
  lastWrite: EngineSettingsLastWrite | null;
  /** A failed save's sentence (verbatim from the server); shown in the status slot with a Dismiss. */
  banner: string | null;
  onDismissBanner: () => void;
  scope: EngineSettingsWriteScope;
  hostText: string;
  cwdShort: string;
  isLocalHost: boolean;
  existedAtOpen: Map<string, boolean> | null;
  onLink: (e: ReactMouseEvent) => void;
  onOpenPath?: (path: string) => void;
}

function copyPath(path: string) {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!clip) return;
  clip.writeText(path).catch((err) => log.warn('settings', 'engine settings path copy failed', { error: String(err) }));
}

/**
 * The footer's first block is a STATUS SLOT: the saved or
 * removed sentence, or a failed save with its Dismiss. One line is reserved at
 * rest; a landed sentence may take up to three (the footer grows from the
 * bottom, so the rows' top and every control above stay put; three is what the
 * project sentence needs with a 48-character cwd, and the created-file and git
 * answer in it is the one the user most wants to read). A longer sentence is
 * clamped there with the whole text in `title` and a VISIBLE "More" control
 * that unfolds it. A failed save's sentence is never clamped: the server's
 * words take the lines they need.
 */
function StatusSlot({ banner, onDismissBanner, saved }: {
  banner: string | null; onDismissBanner: () => void; saved: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const current = banner ?? saved ?? '';
  useEffect(() => { setExpanded(false); }, [current]);
  // Measured after paint: the clamp hides text only when the sentence needs a fourth line.
  useLayoutEffect(() => {
    const el = textRef.current;
    setClipped(!!el && !expanded && el.scrollHeight > el.clientHeight + 1);
  }, [current, expanded]);
  const cls = `engine-settings-status-slot${expanded ? ' is-expanded' : ''}`;
  if (banner) {
    return (
      <div className={`${cls} is-alert`}>
        <div className="engine-settings-popover-alert" role="alert" data-testid="engine-settings-banner">
          <span>{banner}</span>
          <button type="button" aria-label="Dismiss" onClick={onDismissBanner}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className={cls}>
      <p ref={textRef} className="engine-settings-saved" aria-live="polite" data-testid="engine-settings-saved" title={saved ?? undefined}>{saved ?? ''}</p>
      {saved && (clipped || expanded) && (
        <button
          type="button"
          className="engine-settings-status-more"
          data-testid="engine-settings-status-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Less' : 'More'}
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {expanded ? <path d="M3 10l5-5 5 5" /> : <path d="M3 6l5 5 5-5" />}
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * A path with a break opportunity after every slash, so a long one wraps
 * at a segment boundary instead of splitting `settings.json` mid-token. The
 * text content is unchanged (`<wbr>` adds no characters).
 */
function PathText({ path }: { path: string }) {
  const parts = path.split('/');
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>{i > 0 ? '/' : ''}{part}{i < parts.length - 1 && <wbr />}</span>
      ))}
    </>
  );
}

export function EngineSettingsFooter(props: FooterProps) {
  const { view, lastWrite, banner, onDismissBanner, hostText, cwdShort, isLocalHost, existedAtOpen, onLink, onOpenPath } = props;
  const files = view?.files ?? [];
  const anyError = files.some((f) => !!f.error);
  const [filesOpen, setFilesOpen] = useState(anyError);
  useEffect(() => { if (anyError) setFilesOpen(true); }, [anyError]);
  const saved = view && lastWrite
    ? savedSentence({
      result: lastWrite.result, scope: lastWrite.scope, op: lastWrite.op, hostLabel: hostText, cwdShort, files, key: lastWrite.key, cwd: view.cwd,
    })
    : null;
  return (
    <footer className="engine-settings-popover-footer">
      <StatusSlot banner={banner} onDismissBanner={onDismissBanner} saved={saved} />
      {/* The link and the Files disclosure share ONE line (the details
          spans the row; its summary sits in the reserved right column). */}
      <div className="engine-settings-footer-row">
        {/* Neutral text until the view answers; the sentence with the
            groups and the count is built from that answer. */}
        <a className="engine-settings-more-link" href="/settings#engines" onClick={onLink} title={otherGroupsLink(view ? view.groups : null)}>
          {otherGroupsLink(view ? view.groups : null)}
        </a>
        {view && (
          <details className="engine-settings-files" data-testid="engine-settings-files" open={filesOpen} onToggle={(e) => setFilesOpen(e.currentTarget.open)}>
            {/* A chevron says the line unfolds, and points down while it is open. */}
            <summary>
              <svg className="engine-settings-files-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M6 3l5 5-5 5" />
              </svg>
              <span className="engine-settings-files-summary-text">Files ({files.length})</span>
            </summary>
            {/* The list shows its entries in full (the rows lend the room
                only while it is open); paths break at slashes, clickable ones
                read as links at rest, the full path stays in the title. */}
            <div className="engine-settings-files-list">
              {files.map((file) => {
                const created = file.exists && existedAtOpen?.get(file.id) === false;
                const shortPath = shortenUnderCwd(file.path, view.cwd, cwdShort);
                return (
                  <p key={file.id} className="engine-settings-file" data-file-id={file.id} data-path={file.path}>
                    <span className="engine-settings-file-label">{file.label}</span>
                    {isLocalHost && onOpenPath ? (
                      <button type="button" className="engine-settings-file-open" title={`Open ${file.path}`} onClick={() => onOpenPath(file.path)}>
                        <code><PathText path={shortPath} /></code>
                      </button>
                    ) : <code title={file.path}><PathText path={shortPath} /></code>}
                    {!file.exists && <span className="engine-settings-file-missing"> (not created yet)</span>}
                    {created && <span className="engine-settings-file-created">created just now</span>}
                    {file.error && <span className="engine-settings-file-error">{file.error}</span>}
                    {!isLocalHost && (
                      <button type="button" className="engine-settings-copy-path" onClick={() => copyPath(file.path)}>Copy path</button>
                    )}
                  </p>
                );
              })}
            </div>
          </details>
        )}
      </div>
    </footer>
  );
}
