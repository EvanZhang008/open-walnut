/**
 * The Where picker's Auto row (experiment `project_first_start`): what the project makes on the
 * draft's machine, or why that machine cannot, with one way out; a code source's packages sit
 * right under it. Words: draft-work-in.ts.
 */
import type { ReactNode } from 'react';
import { badge } from '@/components/common/badge';
import { tildePath } from '@/utils/home-folder';
import { WhereIcon } from './DraftWhereIcons';
import { DraftSourcePackages } from './DraftSourcePackages';
import type { DraftColumn } from './draft-column';
import type { DraftRowUpdate, DraftWhere } from './useDraftWhere';
import { autoNote, ownHostOf } from './draft-work-in';

export function DraftWhereAuto({ draft, where, homeOf, active, onActive, onPick, onUpdate }: {
  draft: DraftColumn;
  where: DraftWhere;
  homeOf: (key: string) => string | undefined;
  /** The keyboard is on it. */
  active: boolean;
  onActive: () => void;
  /** Auto on `hostKey`: saved, the picker closes. */
  onPick: (hostKey: string) => void;
  onUpdate: DraftRowUpdate;
}) {
  const hostKey = where.hostKey;
  const hostName = where.hostName(hostKey);
  const v = where.verdict;
  const autoLine = where.row ? autoNote(where.row, v, {
    anchorShown: where.row.startSource ? tildePath(where.row.startSource.anchor, homeOf(where.row.startSource.host)) : undefined,
    folderShown: where.row.defaultCwd ? tildePath(where.row.defaultCwd, homeOf(where.row.defaultHost ?? '__local__')) : undefined,
    picked: draft.fromProjectInputs,
  }) : autoNote(undefined, v);
  // Auto in the project's own folder, which is gone: the row says so (never "Works in" a folder that is not there).
  const autoGone = where.autoCurrent && where.line?.kind === 'gone';
  const ownKey = ownHostOf(where.row);
  const recommended = !where.autoCurrent && !!where.detected?.hasSource && where.detected.project === where.project;
  if (!where.project) {
    return (
      <div className="draft-v6-wm-row is-disabled draft-v6-auto-row" role="option" aria-disabled="true" aria-selected={false} data-testid="draft-v6-auto-row" data-state="no-project">
        <span className="draft-v6-wm-ico"><WhereIcon kind="auto" size={15} /></span>
        <span className="draft-v6-wm-text"><span className="draft-v6-wm-name is-dim"><Title>Auto</Title></span><span className="draft-v6-wm-line">{autoLine}</span></span>
      </div>
    );
  }
  if (!v.ok) {
    return (
      <div className="draft-v6-wm-row is-disabled draft-v6-auto-row is-cannot" role="option" aria-disabled="true" aria-selected={false} data-testid="draft-v6-auto-row" data-state="cannot"
        title={`Auto cannot run on ${hostName}: ${autoLine}`}>
        <span className="draft-v6-wm-ico is-ban"><WhereIcon kind="ban" size={15} /></span>
        <span className="draft-v6-wm-text">
          <span className="draft-v6-wm-name is-dim"><Title>Auto · {where.what.words} on {hostName}</Title></span>
          {/* The reason is read whole: it wraps to a second line, never cut. */}
          <span className="draft-v6-wm-line is-reason">{autoLine}</span>
          <button type="button" className="btn btn-sm draft-v6-mini" data-testid="draft-v6-auto-way-out" title={`Auto on ${where.hostName(ownKey)}`}
            onClick={() => onPick(ownKey)}>
            Run on {where.hostName(ownKey)}
          </button>
        </span>
      </div>
    );
  }
  return (
    <>
      <div className={`draft-v6-wm-row wn-pick-row draft-v6-auto-row${active ? ' is-active' : ''}`} role="option" aria-selected={where.autoCurrent}
        data-testid="draft-v6-auto-row" data-state="ok" onMouseEnter={onActive} onClick={() => onPick(hostKey)}>
        <span className="draft-v6-wm-ico"><WhereIcon kind="auto" size={15} /></span>
        <span className="draft-v6-wm-text">
          <span className="draft-v6-wm-name wn-pick-name"><Title>Auto · {where.what.words} on {hostName}</Title>{recommended && <span className={`${badge('accent')} draft-v6-tag is-rec`}><span>recommended</span></span>}</span>
          <span className="draft-v6-wm-line">{autoGone ? `This folder is gone on ${hostName}` : autoLine}</span>
        </span>
        <span className="draft-v6-wm-right" />
      </div>
      {where.ps.source && <DraftSourcePackages draft={draft} source={where.ps.source} onUpdate={onUpdate} />}
    </>
  );
}

/** A row's title: its own box, so a long one wraps before the tag (never cut). */
export function Title({ children }: { children: ReactNode }) {
  return <span className="draft-v6-wm-title wn-title">{children}</span>;
}
