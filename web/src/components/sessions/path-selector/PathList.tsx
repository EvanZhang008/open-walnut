/**
 * PathList — sectioned result list for the session path selector.
 *
 * Renders labeled sections ("📁 subdirectories" / "🕘 history" / per-host
 * groups), explicit per-host empty states ("directory does not exist on X" /
 * "no subdirectories"), subtle host-down rows, and the "create & start" row.
 * History matches never impersonate live results — each lives under its own
 * section label.
 */
import { forwardRef, useRef } from 'react';
import type { Section, RankedItem } from './ranking';
import type { HostLiveState } from './useLiveDirs';

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
}

export const PathList = forwardRef<HTMLDivElement, Props>(function PathList(
  {
    sections, selectedIdx, expandSelected, loading, loadError, hostStates, pathMode,
    activeHostLabel, createOption, emptyHint, onItemClick, onItemHover, onCreate,
  },
  ref,
) {
  const totalItems = sections.reduce((n, s) => n + s.items.length, 0);

  // Per-host live diagnostics (path mode): missing dir, empty dir, host down.
  const liveNotes: { key: string; kind: 'missing' | 'empty' | 'down'; label: string }[] = [];
  if (pathMode) {
    for (const [hostKey, state] of hostStates) {
      const label = hostKey === '__local__' ? 'Local' : hostKey;
      if (state.status === 'error') liveNotes.push({ key: hostKey, kind: 'down', label });
      else if (state.status === 'done' && !state.exists) liveNotes.push({ key: hostKey, kind: 'missing', label });
      else if (state.status === 'done' && state.exists && state.dirs.length === 0) liveNotes.push({ key: hostKey, kind: 'empty', label });
    }
  }

  let flatIdx = -1;
  return (
    <div className="sps-path-list" ref={ref}>
      {loading && totalItems === 0 && <div className="sps-empty">Loading paths...</div>}
      {/* A stale history error next to a live "Loading paths..." reads as a
          contradiction (both rendered in the 2026-07-19 freeze incident) —
          suppress the error while a load is in flight. */}
      {loadError && !loading && <div className="sps-error">{loadError}</div>}

      {sections.map(section => (
        <div className="sps-section" key={section.id}>
          <div className="sps-section-label">{section.label}</div>
          {section.items.map(item => {
            flatIdx++;
            const idx = flatIdx;
            const isActive = idx === selectedIdx;
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
                    {hostLabel && (
                      <span className={`sps-path-host-tag${isLive ? ' sps-tag-live' : ''}`} title={hostLabel}>
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
      {liveNotes.map(note => (
        <div key={note.key} className={note.kind === 'down' ? 'sps-host-down' : 'sps-live-note'}>
          {note.kind === 'down' && `${note.label} not responding`}
          {note.kind === 'missing' && `Directory does not exist on ${note.label}`}
          {note.kind === 'empty' && `No subdirectories on ${note.label}`}
        </div>
      ))}

      {createOption && (
        <div className="sps-create-row" onClick={onCreate}>
          <span className="sps-create-icon">+</span>
          {/* "Create folder … in it" — a bare "Create …" read as "create session". */}
          <span>Create folder <code>{createOption}</code> &amp; start session in it</span>
        </div>
      )}

      {!loading && !loadError && totalItems === 0 && liveNotes.length === 0 && !createOption && (
        <div className="sps-empty">{emptyHint}</div>
      )}
    </div>
  );
});
