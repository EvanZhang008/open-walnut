/**
 * The Where picker's left side (experiment `project_first_start`, design A): Recent and most used,
 * the machines (a click browses that machine from its home, nothing saved until "Use this
 * folder"), and the places on the browsed machine (its home, the root, and the top folders the
 * person used outside the home). A narrow picker lays the same items out in one row above the list.
 */
import { Fragment, type ReactNode } from 'react';
import { HostStatusDot } from './path-selector/HostStatusDot';
import { WhereIcon } from './DraftWhereIcons';
import type { WhereHost } from './useDraftWhere';

export function DraftWhereSide({ hosts, host, hostName, listOn, browsing, places, onList, onHost, onPlace }: {
  hosts: readonly WhereHost[];
  /** The machine being browsed (or shown). */
  host: string;
  hostName: (key: string) => string;
  /** The Recent / Most used list shows. */
  listOn: boolean;
  /** The folder being browsed, as shown ('' when the list shows). */
  browsing: string;
  /** The places on `host`, as shown (`~`, `/`, `/srv/data`). */
  places: readonly string[];
  onList: () => void;
  onHost: (key: string) => void;
  onPlace: (dir: string) => void;
}) {
  return (
    <div className="draft-v6-ws" data-testid="draft-v6-where-side">
      <div role="listbox" aria-label="Lists" className="draft-v6-ws-sec">
      <button type="button" role="option" aria-selected={listOn} className="draft-v6-ws-item wn-pick-row" data-testid="draft-v6-side-recent"
        onMouseDown={(e) => e.preventDefault()} onClick={onList}>
        <WhereIcon kind="clock" size={14} /><span className="draft-v6-ws-name wn-title wn-pick-name">Recent and most used</span>
      </button>
      </div>
      <div className="draft-v6-ws-group wn-meta">Places on {hostName(host)}</div>
      <div role="listbox" aria-label={`Places on ${hostName(host)}`} className="draft-v6-ws-sec">
      {places.map((p) => (
        <button key={p} type="button" role="option" aria-selected={!listOn && browsing === p}
          className="draft-v6-ws-item wn-pick-row" data-testid="draft-v6-side-place" data-path={p} title={`Browse ${p}`}
          onMouseDown={(e) => e.preventDefault()} onClick={() => onPlace(p)}>
          <WhereIcon kind={p === '~' ? 'home' : 'folder'} size={14} />
          <span className="draft-v6-ws-name wn-title wn-pick-name">{p === '~' ? '~ Home' : withBreaks(p)}</span>
        </button>
      ))}
      </div>
      <div className="draft-v6-ws-group wn-meta">Machines</div>
      <div role="listbox" aria-label="Machines" className="draft-v6-ws-sec">
      {hosts.map((h) => {
        const on = !h.local && !h.connected ? false : true;
        return (
          <button key={h.key} type="button" role="option" aria-selected={!listOn && h.key === host} aria-disabled={!on || undefined}
            className={`draft-v6-ws-item wn-pick-row${on ? '' : ' is-off'}`} data-testid={`draft-v6-side-host-${h.key}`}
            title={on ? `Browse ${h.name} from its home folder` : `${h.name} is offline`}
            onMouseDown={(e) => e.preventDefault()} onClick={() => { if (on) onHost(h.key); }}>
            {h.local ? <span className="draft-v6-dot is-on" aria-hidden="true" /> : <HostStatusDot host={h.key} label={h.name} className="draft-v6-host-dot" />}
            <span className={`draft-v6-ws-name wn-title wn-pick-name${h.key === host ? ' is-host' : ''}`}>{h.name}</span>
            {!on && <span className="draft-v6-ws-note">offline</span>}
          </button>
        );
      })}
      </div>
    </div>
  );
}

/** A path that wraps at its slashes, never inside a name (`/srv/projects`, not `/srv/project` + `s`). */
function withBreaks(p: string): ReactNode {
  return p.split('/').map((part, i) => (i === 0 ? part : <Fragment key={i}>/<wbr />{part}</Fragment>));
}
