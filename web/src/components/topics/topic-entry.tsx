/**
 * The ways into a topic from the rest of the app (experiment `topics`), each one line where it is
 * used: the "Add to topic…" row of the task ⋮ menu, of the Org row menu and of the org chart's node
 * menu; a "+ New topic" button; and opening a topic, which selects it on the Org page.
 * With the experiment off every one of them renders nothing.
 */
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useNavigate } from 'react-router-dom';
import type { Task } from '@open-walnut/core';
import { orgDisplayTitle, orgProjectNode } from '@open-walnut/org-tree';
import type { ContextMenuItem } from '@/utils/context-menu';
import { openAddToTopic, openNewTopic, type PickedMember } from './topic-dialogs';
import { orgRef, taskRef, topicKey } from './topic-model';
import { topicsOnNow, useTopicsOn } from './topics-flag';

/** "Add to topic…" for a ContextMenu, or nothing while the experiment is off. */
export function topicMenuItems(members: PickedMember[]): ContextMenuItem[] {
  if (!topicsOnNow() || !members.length) return [];
  return [{ key: 'add-to-topic', label: 'Add to topic…', onSelect: () => openAddToTopic(members) }];
}

/** The member an Org node is: the CEO ('main') or a project's VP ('project:<key>'); routers are not. */
export function orgNodeMember(row: { key: string; kind?: string; name: string; vpName?: string }): PickedMember[] {
  if (row.kind === 'router' || !(row.key === 'main' || row.key.startsWith('project:'))) return [];
  const name = row.key === 'main' ? orgDisplayTitle({ title: row.name, org_role: 'main' }) : row.vpName ?? `${row.name} VP`;
  return [{ ref: orgRef(row.key), name }];
}

export const taskMember = (task: Pick<Task, 'id' | 'title' | 'project' | 'org_role' | 'org_name'>): PickedMember =>
  ({ ref: taskRef(task.id), name: orgDisplayTitle(task) });

/** A Threads view's own node as a member: the CEO and a VP as org nodes (the topic follows the node), any other task as itself. */
export function nodeMember(task: Pick<Task, 'id' | 'title' | 'project' | 'org_role' | 'org_name'>): PickedMember {
  const name = orgDisplayTitle(task);
  if (task.org_role === 'main') return { ref: orgRef('main'), name };
  if (task.org_role === 'lead') return { ref: orgRef(orgProjectNode(task.project)), name };
  return taskMember(task);
}

/** The Threads view's row of actions: "+ New topic" with its node already picked. */
export function ThreadsTopicBar({ owner }: { owner: Pick<Task, 'id' | 'title' | 'project' | 'org_role' | 'org_name'> | undefined }) {
  const on = useTopicsOn();
  if (!on) return null;
  return (
    <div className="org-threads-bar" data-testid="org-threads-topic-bar">
      <NewTopicButton members={owner ? [nodeMember(owner)] : []} testId="org-threads-new-topic" />
    </div>
  );
}

/** The task ⋮ menu's row (TaskMenuRows): this task into an open topic or a new one. */
export function AddToTopicMenuItem({ task, afterAction }: { task: Pick<Task, 'id' | 'title' | 'project' | 'org_role' | 'org_name'>; afterAction: () => void }) {
  const on = useTopicsOn();
  if (!on) return null;
  return (
    <button
      type="button"
      className="task-kebab-item"
      data-testid="kebab-add-to-topic"
      onClick={(e) => { e.stopPropagation(); afterAction(); openAddToTopic([taskMember(task)]); }}
    >
      <span className="task-kebab-icon" aria-hidden="true">#</span>
      <span>Add to topic…</span>
    </button>
  );
}

/** "+ New topic": opens the dialog with these members already picked. */
export function NewTopicButton({ members = [], testId = 'topic-new', className = 'btn btn-sm' }: { members?: PickedMember[]; testId?: string; className?: string }) {
  const on = useTopicsOn();
  if (!on) return null;
  return (
    <button type="button" className={className} data-testid={testId} title="Start a group chat with tasks, VPs and people" onClick={() => openNewTopic(members)}>
      + New topic
    </button>
  );
}

/** Open a topic: it is selected on the Org page, from wherever the person is. */
export function useOpenTopic(): (topicId: string) => void {
  const navigate = useNavigate();
  return useLeanCallback((topicId: string) => {
    navigate(`/org?node=${encodeURIComponent(topicKey(topicId))}`);
  }, [navigate]);
}
