/**
 * The Org list's DIRECTORS section: the "sections" Directors layout (Settings → Org; 2026-11-20, the
 * user's "P1"). After the VPs, a heading "Directors · N", then every Director as the list's one plain
 * row (OrgListRow): a smaller round avatar in its VP's letter and colour and its title; its state and
 * its VP are in its hover and its label (2026-11-22, the user: "We need to be super simple"). By VP in the list's order, then the tree's order; a Director under a Director
 * is just the next row (no indent, no fold). A click opens it beside the page, a right-click opens the
 * same menu as in the fold (director-actions.ts), and the section ends with "+ New Director", whose
 * picker lists every VP's projects; a VP's "New Director…" opens it on that VP's first project.
 *
 * Inside the list's listbox it is a group of options; Up and Down walk them through the list's own
 * key handler (OrgChannelList), as they walk a fold's.
 */
import { useEffect, useState, type MouseEvent } from 'react';
import { ContextMenu, useContextMenu } from '@/components/common/ContextMenu';
import { type ChannelRow, shownName } from './org-channels-model';
import { NodeAvatar } from './OrgAvatar';
import { OrgListRow } from './OrgListRow';
import { directorRows, type LeaderGroup, type LeaderNode } from './org-leaders';
import { directorMenuItems, endNewDirector, useDirectorActions, useNewDirectorAsk, type DirectorProject } from './director-actions';
import { OrgNewDirector } from './OrgNewDirector';
import '@/styles/org-leaders.css';

export const DIRECTORS_SECTION_LABEL = 'Directors';

interface Props {
  vps: readonly ChannelRow[];
  groupsOf: (row: ChannelRow) => readonly LeaderGroup[];
  projectsOf: (row: ChannelRow) => readonly DirectorProject[];
  query: string;
  openTaskIds?: ReadonlySet<string> | undefined;
}

export function OrgDirectorSection({ vps, groupsOf, projectsOf, query, openTaskIds }: Props) {
  const actions = useDirectorActions();
  const menu = useContextMenu<LeaderNode>({ ignorePressSelection: true });
  const asked = useNewDirectorAsk('list');
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (asked) setAdding(true); }, [asked?.n]); // eslint-disable-line react-hooks/exhaustive-deps -- one answer per ask
  const onAdding = (on: boolean) => { setAdding(on); if (!on && asked) endNewDirector(asked.n); };
  const rows = directorRows(vps, groupsOf, query);
  const projects = vps.flatMap((vp) => projectsOf(vp).map((p) => ({ ...p, vpName: shownName(vp) })));
  const askedVp = asked ? vps.find((v) => v.key === asked.vpKey) : undefined;
  const defaultProject = askedVp ? projectsOf(askedVp)[0]?.project : undefined;
  if (!rows.length && !adding) return null;
  const onMenu = (e: MouseEvent, d: LeaderNode) => menu.open(e, d);
  const picked = menu.state?.payload;
  return (
    <div className="org-directors" role="group" aria-label={DIRECTORS_SECTION_LABEL} data-testid="org-directors" data-count={rows.length}>
      <div className="org-list-section" role="presentation" data-testid="org-directors-head">{DIRECTORS_SECTION_LABEL} · {rows.length}</div>
      {rows.map(({ director: d, vp }) => {
        const vpName = shownName(vp);
        const state = d.stateText;
        const open = openTaskIds?.has(d.id);
        return (
          <div key={d.id} className="org-channel-wrap" role="presentation">
            <OrgListRow
              avatar={<NodeAvatar taskId={d.id} name={vp.name} size={26} className="is-director" />}
              name={d.title}
              // A Director that needs the user wears the list's one red dot.
              dot={d.state === 'needs' ? state : null}
              aria-current={open || undefined}
              className={`is-director${open ? ' is-open' : ''}`}
              data-testid="org-director-row"
              data-task-id={d.id}
              data-vp={vp.key}
              data-state={d.state}
              aria-label={`${d.title}: Director under ${vpName}, ${state}, leads ${d.leads}${d.watched ? ', watched' : ''}`}
              title={`${d.title}: ${state} · ${vpName}`}
              onClick={() => actions.openTask(d.id)}
              onContextMenu={(e) => onMenu(e, d)}
            />
          </div>
        );
      })}
      <div className="org-directors-new" role="presentation">
        <OrgNewDirector key={asked?.n ?? 0} projects={projects} defaultProject={defaultProject} inList editing={adding} onEditing={onAdding} />
      </div>
      {menu.state && picked && (
        <ContextMenu
          point={menu.state.point}
          items={directorMenuItems({
            id: picked.id,
            title: picked.title,
            openChat: () => actions.openChat({ id: picked.id, sessionId: picked.sessionId }),
            openTask: () => actions.openTask(picked.id),
            remove: () => actions.remove(picked.id, picked.leads),
          })}
          onClose={menu.close}
          returnFocus={menu.state.origin}
          ariaLabel="Director actions"
          testId="org-director-menu"
        />
      )}
    </div>
  );
}
