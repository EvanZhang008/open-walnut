/**
 * PathList — sectioned result list for the session path selector.
 *
 * Renders labeled sections ("📁 subdirectories" / "🕘 history" / per-host
 * groups / "🏠 home folders" for a bare word), explicit per-host empty states
 * ("directory does not exist on X" / "no subdirectories"), subtle host-down
 * rows, the "create & start" row, and a muted "listing incomplete" line for a
 * listing some entries did not answer (the server's text, as is).
 * History matches never impersonate live results — each lives under its own
 * section label.
 */
import { forwardRef, type ReactNode } from 'react';
import type { HostDot } from '@open-walnut/host-problem';
import type { DirListingPending } from '@/api/sessions';
import type { Section, RankedItem } from './ranking';
import type { HostLiveState } from './useLiveDirs';
import { HostConnectSteps } from './HostConnectSteps';
import { HostStatusDot } from './HostStatusDot';
import { isMoreRow, moreRowText } from './history-cap';

interface PathParts {
  parent: string;
  leaf: string;
}

function splitPath(cwd: string): PathParts {
  const normalized = cwd.replace(/\/+$/, '') || '/';
  const slash = normalized.lastIndexOf('/');
  if (slash < 0) return { parent: '', leaf: normalized };
  if (slash === 0) return { parent: '/', leaf: normalized.slice(1) };
  return { parent: normalized.slice(0, slash), leaf: normalized.slice(slash + 1) };
}

function withTrailingSlash(parent: string): string {
  if (!parent) return '';
  return parent === '/' ? '/' : `${parent}/`;
}

function shortenHomePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
}

interface Props {
  sections: Section[];
  /** Flat index of the keyboard-selected item across all sections. */
  selectedIdx: number;
  /** True when the highlight was placed by keyboard/default (not mouse hover) —
   *  only then does the selected row expand to its full multi-line path.
   *  Hover must never reflow the row under the pointer. */
  expandSelected: boolean;
  loading: boolean;
  loadError: string | null;
  /** Live listing state per host — drives empty states and host-down rows. */
  hostStates: Map<string, HostLiveState>;
  /** Host alias → human label for the per-host rows. */
  hostLabels?: Map<string, string>;
  /** True when the input is path-like (live listing applies). */
  pathMode: boolean;
  /** Label of the host whose live section is empty/missing (single-host mode). */
  activeHostLabel: string;
  /** Non-null → render the "create & start" row for this path. */
  createOption: string | null;
  emptyHint: string;
  onItemClick: (item: RankedItem) => void;
  onItemHover: (flatIdx: number) => void;
  onCreate: () => void;
  /** The selected host's note (HostNote), first in the list, before any row. */
  topNote?: ReactNode;
  /** A remote host's failure note in the list (HostNote): connect, listing, give-up. */
  renderHostNote?: (hostKey: string, state: HostLiveState) => ReactNode;
  /** Hosts whose connecting / failure rows the topNote already speaks for. */
  noteHosts?: ReadonlySet<string>;
  /** All tab: the dot a history row's host tag wears, only for hosts with a problem. */
  rowDots?: ReadonlyMap<string, HostDot>;
  /** The 'Show N more' row was picked. */
  onShowMore?: () => void;
}

type LiveNote =
  | { key: string; kind: 'missing' | 'empty'; label: string }
  | { key: string; kind: 'connecting'; label: string; pending: DirListingPending }
  | { key: string; kind: 'down'; label: string; message: string; hint?: string };

export const PathList = forwardRef<HTMLDivElement, Props>(function PathList(
  {
    sections, selectedIdx, expandSelected, loading, loadError, hostStates, hostLabels, pathMode,
    activeHostLabel, createOption, emptyHint, onItemClick, onItemHover, onCreate,
    topNote, renderHostNote, noteHosts, rowDots, onShowMore,
  },
  ref,
) {
  const totalItems = sections.reduce((n, s) => n + s.items.length, 0);

  // Per-host live diagnostics (path mode): missing dir, empty dir, host still
  // connecting (with the connect step), host down (with cause + next step).
  const liveNotes: LiveNote[] = [];
  if (pathMode) {
    for (const [hostKey, state] of hostStates) {
      const label = hostKey === '__local__' ? 'Local' : (hostLabels?.get(hostKey) ?? hostKey);
      // The note on top already says it; a test server's 'off' is one line, drawn once elsewhere.
      if (noteHosts?.has(hostKey) && state.status !== 'done') continue;
      if (state.status === 'error' && state.hostError?.kind === 'ephemeral') continue;
      if (state.status === 'error') {
        liveNotes.push({
          key: hostKey, kind: 'down', label,
          message: state.hostError?.message ?? state.error ?? 'not responding',
          hint: state.hostError?.hint,
        });
      } else if (state.status === 'loading' && state.pending) {
        liveNotes.push({ key: hostKey, kind: 'connecting', label, pending: state.pending });
      } else if (state.status === 'done' && !state.exists) liveNotes.push({ key: hostKey, kind: 'missing', label });
      else if (state.status === 'done' && state.exists && state.dirs.length === 0) liveNotes.push({ key: hostKey, kind: 'empty', label });
    }
  }
  // Listings that came back partial (a link into a hung mount did not answer):
  // one muted line each, the server's own text. With two or more, each names its host.
  const incompleteNotes: Array<{ key: string; label: string; message: string }> = [];
  if (pathMode) {
    for (const [hostKey, state] of hostStates) {
      if (state.status !== 'done' || !state.incomplete) continue;
      const label = hostKey === '__local__' ? 'Local' : (hostLabels?.get(hostKey) ?? hostKey);
      incompleteNotes.push({ key: hostKey, label, message: state.incomplete.message });
    }
  }
  // A host-specific "connecting…" row already says what is loading (in the list,
  // or the top note's connect steps for the selected host); the generic line on
  // top of it would read as two spinners for one wait.
  const noteWaits = [...hostStates].some(([k, s]) => noteHosts?.has(k) && s.status === 'loading' && !!s.pending);
  const showGenericLoading = loading && totalItems === 0 && !noteWaits && !liveNotes.some(n => n.kind === 'connecting');

  let flatIdx = -1;
  return (
    <div className="sps-path-list" ref={ref}>
      {topNote}
      {showGenericLoading && <div className="sps-empty">Loading paths...</div>}
      {/* A stale history error next to a live "Loading paths..." reads as a
          contradiction (both rendered in the 2026-07-19 freeze incident) —
          suppress the error while a load is in flight. */}
      {loadError && !loading && <div className="sps-error">{loadError}</div>}

      {sections.map(section => (
        <div className="sps-section" key={section.id} data-section-id={section.id}>
          <div className="sps-section-label">{section.label}</div>
          {section.items.map(item => {
            flatIdx++;
            const idx = flatIdx;
            const isActive = idx === selectedIdx;
            if (isMoreRow(item)) {
              // An option like the rows around it (arrow keys land here); Enter or a click expands.
              return (
                <div
                  key="sps-more-row"
                  role="option"
                  aria-selected={isActive}
                  className={`sps-path-item sps-more-row${isActive ? ' active' : ''}`}
                  onClick={() => onShowMore?.()}
                  onMouseEnter={() => onItemHover(idx)}
                >
                  <span className="sps-more-row-text">{moreRowText(item.moreCount ?? 0)}</span>
                </div>
              );
            }
            const isLive = item.source === 'live';
            const fullCwd = `${item.cwd}${isLive ? '/' : ''}`;
            const hostLabel = item.host ? (item.hostLabel ?? item.host) : 'local';
            const { parent, leaf } = splitPath(item.cwd);
            // Path mode admits only candidates under the typed parent (live AND
            // history), so rows render just their relative segments — the typed
            // prefix already sits in the input. depth > 0 marks path-mode rows;
            // browse-mode history has depth 0 and keeps the full path. The
            // KEYBOARD-highlighted row expands to the full multi-line path so the
            // selection is unambiguous before Enter; hover never expands (the row
            // reflowing under the pointer reads as flicker).
            const expanded = isActive && expandSelected;
            const relative = item.depth > 0 && !expanded;
            const relSegments = relative
              ? item.cwd.replace(/\/+$/, '').split('/').filter(Boolean).slice(-item.depth)
              : [];
            const relLeaf = relSegments[relSegments.length - 1] ?? leaf;
            const relParent = relSegments.slice(0, -1).join('/');
            return (
              <div
                key={`${item.cwd}::${item.host ?? ''}::${item.source}`}
                className={`sps-path-item${isActive ? ' active' : ''}${expanded ? ' sps-expanded' : ''}${isLive ? ' sps-live' : ''}`}
                onClick={() => onItemClick(item)}
                onMouseEnter={() => onItemHover(idx)}
              >
                <div className="sps-path-main">
                  <span className="sps-path-cwd" title={fullCwd}>
                    <bdi dir="ltr">
                      {relative ? (
                        <>
                          {/* "…/" = continues from the typed prefix in the input */}
                          <span className="sps-path-ghost">…/{relParent && `${relParent}/`}</span>
                          <span className="sps-path-leaf">{relLeaf}</span>
                          {isLive && <span className="sps-path-ghost">/</span>}
                        </>
                      ) : (
                        <>
                          <span className="sps-path-ghost">{shortenHomePath(withTrailingSlash(parent))}</span>
                          <span className="sps-path-leaf">{leaf}</span>
                          {isLive && <span className="sps-path-ghost">/</span>}
                        </>
                      )}
                    </bdi>
                  </span>
                </div>
                {(hostLabel || (isLive && item.history)) && (
                  <div className="sps-path-meta">
                    {item.host && rowDots?.get(item.host) && (
                      <HostStatusDot dot={rowDots.get(item.host)!} host={item.host} className="sps-row-host-dot" />
                    )}
                    {hostLabel && (
                      <span
                        className={`sps-path-host-tag${isLive ? ' sps-tag-live' : ''}`}
                        title={item.host && rowDots?.get(item.host) ? rowDots.get(item.host)!.title : hostLabel}
                      >
                        {hostLabel.slice(0, 10)}
                      </span>
                    )}
                    {isLive && item.history && (
                      <span className="sps-hist-marker" title="In your session history">🕘</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {/* Explicit live empty states — never let history matches impersonate live results */}
      {liveNotes.map(note => {
        if (note.kind === 'connecting') {
          // Step chain, not a bare spinner: a first connect installs a runtime and
          // uploads the daemon, so the wait needs to show progress to read as alive.
          return (
            <HostConnectSteps key={note.key} hostKey={note.key} label={note.label} pending={note.pending} />
          );
        }
        if (note.kind === 'down') {
          const state = hostStates.get(note.key);
          return state && renderHostNote ? <div key={note.key}>{renderHostNote(note.key, state)}</div> : null;
        }
        return (
          <div key={note.key} className="sps-live-note">
            {note.kind === 'missing' && `Directory does not exist on ${note.label}`}
            {note.kind === 'empty' && `No subdirectories on ${note.label}`}
          </div>
        );
      })}

      {createOption && (
        <div className="sps-create-row" onClick={onCreate}>
          <span className="sps-create-icon">+</span>
          {/* "Create folder … in it" — a bare "Create …" read as "create session". */}
          <span>Create folder <code>{createOption}</code> &amp; start session in it</span>
        </div>
      )}

      {/* The hint says what Enter does, so it stays under a create row and under a
          "does not exist" / "no subdirectories" note; a host still connecting or
          down speaks for itself. */}
      {!loading && !loadError && totalItems === 0 && liveNotes.every(n => n.kind === 'empty' || n.kind === 'missing') && (
        <div className="sps-empty">{emptyHint}</div>
      )}

      {incompleteNotes.map(note => (
        <div key={note.key} className="sps-list-incomplete" data-host={note.key} title={note.message}>
          {incompleteNotes.length > 1 ? `${note.label}: ${note.message}` : note.message}
        </div>
      ))}
    </div>
  );
});
