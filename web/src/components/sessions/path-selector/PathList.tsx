/**
 * PathList — sectioned result list for the session path selector.
 *
 * Renders labeled sections ("📁 subdirectories" / "🕘 history" / per-host
 * groups), explicit per-host empty states ("directory does not exist on X" /
 * "no subdirectories"), subtle host-down rows, and the "create & start" row.
 * History matches never impersonate live results — each lives under its own
 * section label.
 */
import { forwardRef } from 'react';
import type { Section, RankedItem } from './ranking';
import type { HostLiveState } from './useLiveDirs';

function timeAgo(iso: string): string {
  const ms = Math.max(0, Date.now() - new Date(iso).getTime());
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

interface Props {
  sections: Section[];
  /** Flat index of the keyboard-selected item across all sections. */
  selectedIdx: number;
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
    sections, selectedIdx, loading, loadError, hostStates, pathMode,
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
      {loadError && <div className="sps-error">{loadError}</div>}

      {sections.map(section => (
        <div className="sps-section" key={section.id}>
          <div className="sps-section-label">{section.label}</div>
          {section.items.map(item => {
            flatIdx++;
            const idx = flatIdx;
            const isLive = item.source === 'live';
            const fullCwd = `${item.cwd}${isLive ? '/' : ''}`;
            return (
              <div
                key={`${item.cwd}::${item.host ?? ''}::${item.source}`}
                className={`sps-path-item${idx === selectedIdx ? ' active' : ''}${isLive ? ' sps-live' : ''}`}
                onClick={() => onItemClick(item)}
                onMouseEnter={() => onItemHover(idx)}
              >
                <div className="sps-path-main">
                  {/* title is the only way to read the full path once it wraps in a narrow popover */}
                  <span className="sps-path-cwd" title={fullCwd}>{fullCwd}</span>
                </div>
                <div className="sps-path-meta">
                  <span className={`sps-path-host-tag${isLive ? ' sps-tag-live' : ''}`}>
                    {item.host ? (item.hostLabel ?? item.host) : 'local'}
                  </span>
                  {/* live dir that's also in history gets the marker */}
                  {isLive && item.history && <span className="sps-hist-marker" title="In your session history">🕘 recent</span>}
                  {item.history && (
                    <>
                      <span className="sps-path-category">{item.history.category}</span>
                      <span>{item.history.count} session{item.history.count !== 1 ? 's' : ''}</span>
                      {item.history.lastUsed && <span>{timeAgo(item.history.lastUsed)}</span>}
                    </>
                  )}
                </div>
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
