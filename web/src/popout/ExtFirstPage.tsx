/**
 * The first page's parts the panel puts together (PopoutExtPanel.tsx): the page itself (ExtHome
 * under its header, with the relay pill and the panel it opens, and the strip while an agent acts
 * in this tab), and a task opened from it (Back with its name, and its detail when it has no
 * conversation yet). The panel keeps what they share with Ask: the page, the tab, the key.
 */
import { Suspense, lazy, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Task } from '@open-walnut/core';
import { fromParent } from './ext-frame';
import { ExtHomeHeader, ExtTaskHeader } from './ExtAskChrome';
import { ExtHome, type HomeLaunched, type HomePreset } from './ExtHome';
import type { OpenTask } from './ExtHomeTasks';
import { RelayPanel, RelayPill, RelayStrip } from './ExtRelay';
import { relayPillOf, taskOfOwner, type RelayState } from './ext-relay-model';
import { taskPageTitle } from './ext-home-model';
import { firstQuestionOf, type PanelPage, type VaultState } from './ext-panel-model';
import { taskHead } from './ext-tasks-model';

/** A task with no conversation, opened from the first page: Home's detail, loaded when first needed. */
const ExtTaskDetail = lazy(() => import('./ExtTaskDetail'));

/**
 * The extension's relay word (its agents switch and the tabs agents hold); null from an older
 * extension. Called by the panel itself, so it listens before the extension's first word.
 */
export function useRelayWord(): RelayState | null {
  const [relay, setRelay] = useState<RelayState | null>(null);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = fromParent(e);
      if (m?.type === 'relay') setRelay({ on: m.on, tabs: m.tabs });
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);
  return relay;
}

/** A task's name on its page: its title, or its first question while it wears Walnut's placeholder. */
export function taskNameOf(task: Task | undefined, taskId: string): string {
  return taskPageTitle(task?.title, firstQuestionOf(taskId));
}

interface FirstPageProps {
  surface: 'panel' | 'popup';
  hidden: boolean;
  page: PanelPage | null;
  tab?: number;
  /** Who acts in this tab (`task:<id>`), as the extension says. */
  owner?: string;
  /** Agents may use this browser (the extension's switch). */
  agents: boolean;
  relay: RelayState | null;
  tasks: readonly Task[];
  menuRef: RefObject<HTMLButtonElement | null>;
  menuOn: boolean;
  onMenu: () => void;
  keyed: boolean;
  vault: VaultState | null;
  keyPressed: boolean;
  settings: boolean;
  approvals: ReactNode;
  pageText: (p: { url: string; title?: string }, remote: boolean) => Promise<{ file?: string; inline?: string }>;
  onLaunched: (r: HomeLaunched) => void;
  onOpenTask: OpenTask;
  preset: HomePreset | null;
  onPresetTaken: (id: string) => void;
  /** Stop on the strip: the tab goes back to the person. */
  onStop: () => void;
}

/** The first page: New task over Home's task panel, the relay in its header. */
export function ExtFirstPage(p: FirstPageProps) {
  const [relayOpen, setRelayOpen] = useState(false);
  const relayRef = useRef<HTMLButtonElement>(null);
  const pill = relayPillOf(p.relay, { agents: p.agents, ...(p.owner ? { owner: p.owner } : {}) });
  const ownerTask = p.owner ? p.tasks.find((t) => t.id === taskOfOwner(p.owner!)) : undefined;
  const ownerWho = p.relay?.tabs.find((t) => t.tab === p.tab)?.who;
  return <>
    <ExtHome
      surface={p.surface}
      hidden={p.hidden}
      page={p.page}
      {...(p.tab !== undefined ? { tab: p.tab } : {})}
      canAct={!!p.page && p.tab !== undefined && !p.owner}
      header={
        <ExtHomeHeader
          surface={p.surface}
          menuRef={p.menuRef}
          menuOn={p.menuOn}
          onMenu={p.onMenu}
          relay={<RelayPill kind={pill.kind} label={pill.label} open={relayOpen} onToggle={() => setRelayOpen((v) => !v)} pillRef={relayRef} />}
          keyed={p.keyed}
          vault={p.vault}
          keyPressed={p.keyPressed}
          settings={p.settings}
        />
      }
      approvals={p.approvals}
      strip={p.owner ? <RelayStrip {...(ownerTask ? { task: ownerTask } : {})} {...(ownerWho ? { who: ownerWho } : {})} onStop={p.onStop} /> : null}
      pageText={p.pageText}
      onLaunched={p.onLaunched}
      onOpenTask={p.onOpenTask}
      preset={p.preset}
      onPresetTaken={p.onPresetTaken}
    />
    {relayOpen && !p.hidden && (
      <RelayPanel relay={p.relay} here={p.tab} tasks={p.tasks} anchorRef={relayRef} onClose={() => setRelayOpen(false)} settings={p.settings} />
    )}
  </>;
}

/** A task opened from the first page: Back, its name and its state line. */
export function ExtTaskPageHead({ taskId, tasks, onBack, keyed, vault, keyPressed }: {
  taskId: string; tasks: readonly Task[]; onBack: () => void; keyed: boolean; vault: VaultState | null; keyPressed: boolean;
}) {
  const task = tasks.find((t) => t.id === taskId);
  const head = task ? taskHead(task) : null;
  return (
    <ExtTaskHeader title={taskNameOf(task, taskId)} state={head?.state ?? ''} label={head?.label ?? ''} meta={task?.project ?? ''} onBack={onBack}
      keyed={keyed} vault={vault} keyPressed={keyPressed} />
  );
}

/** A task with no conversation yet, opened from the first page: its detail here, never a Walnut tab. */
export function ExtTaskPageDetail({ taskId, tasks, onOpenSession, onOpenTask, onClose }: {
  taskId: string; tasks: readonly Task[]; onOpenSession: (taskId: string, sessionId: string) => void;
  /** A task the detail links to (parent, subtask, dependency): opened in this frame too. */
  onOpenTask: OpenTask; onClose: () => void;
}) {
  const task = tasks.find((t) => t.id === taskId);
  const loading = <p className="ext-home-loading muted" role="status"><span className="spinner" /> Loading the task…</p>;
  return (
    <div className="ext-panel-detail" data-testid="ext-task-detail">
      <Suspense fallback={loading}>
        {task
          ? <ExtTaskDetail task={task} onOpenSession={(sid) => onOpenSession(task.id, sid)} onOpenTask={onOpenTask} onClose={onClose} />
          : tasks.length ? <p className="ext-home-loading muted" role="status">This task is not on your board any more.</p> : loading}
      </Suspense>
    </div>
  );
}
