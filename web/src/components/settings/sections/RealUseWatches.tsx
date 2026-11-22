/**
 * Settings > Real Use, the watches of shipped changes and the notes sent to tasks
 * (server: src/core/usage-watch/watches.ts and route.ts). A watch names its targets and checks;
 * at its check time each target is judged on its real use since then.
 */
import { Link } from 'react-router-dom';
import type { UsageNote, UsageWatch } from '@/api/usage-watch';
import { NoticeStatus } from '@/components/common/NoticeCard';
import { taskPath } from '@/utils/task-path';
import { DEFAULT_WATCH_CHECKS, checksText, noteStatus, stamp, targetResultText, watchStatus, watchWhen } from './real-use-model';

/** Task id to title, from the watches (the only titles the report carries). */
export function taskTitles(watches: readonly UsageWatch[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of watches) if (w.taskTitle) out.set(w.taskId, w.taskTitle);
  return out;
}

function TaskLink({ id, titles, fallback }: { id: string; titles: Map<string, string>; fallback: string }) {
  const title = titles.get(id);
  return <Link className="health-task-link" to={taskPath(id)} title={id}>{title ?? fallback}</Link>;
}

function WatchRow({ w, now, titles }: { w: UsageWatch; now: number; titles: Map<string, string> }) {
  const status = watchStatus(w.state);
  const when = watchWhen(w, now);
  return (
    <tr className="ru-watch-row" data-watch={w.id} data-state={w.state}>
      <td>
        <Link className="health-task-link" to={taskPath(w.taskId)}>{w.taskTitle ?? 'Its task'}</Link>
        {w.shipAt !== undefined && <span className="ru-sub">shipped {stamp(w.shipAt, now)}</span>}
      </td>
      <td>
        {w.exempt
          ? <span className="health-dim">(exempt)</span>
          : w.targets.map((t) => {
            const words = targetResultText(t, w.result?.find((r) => r.target === t), w.state);
            return <span key={t} className="ru-target"><code className="ru-mono">{t}</code>{words && <> {words}</>}</span>;
          })}
      </td>
      <td>{checksText(w)}</td>
      <td>
        {w.who === 'this task' ? 'this task' : <TaskLink id={w.who} titles={titles} fallback={w.who} />}
        {when && <span className="ru-sub">{when}</span>}
      </td>
      <td><NoticeStatus tone={status.tone}>{status.text}</NoticeStatus></td>
    </tr>
  );
}

export function WatchesBlock({ watches, now }: { watches: UsageWatch[]; now: number }) {
  const titles = taskTitles(watches);
  return (
    <section className="ru-block" data-testid="real-use-watches">
      <h4 className="ru-h">Watches</h4>
      <p className="ru-caption">What each shipped change is watched for in real use, and how it went</p>
      <table className="ru-table ru-watch-table">
        <thead>
          <tr><th>Task</th><th>Targets and results</th><th>Checks</th><th className="ru-w-who">Who, when</th><th className="ru-w-state">State</th></tr>
        </thead>
        <tbody>
          {watches.length === 0
            ? <tr><td className="ru-empty" colSpan={5}>No watches yet. A task that ships a change names what real use should show with usage_watch.</td></tr>
            : watches.map((w) => <WatchRow key={w.id} w={w} now={now} titles={titles} />)}
        </tbody>
      </table>
      <p className="ru-legend">
        A watch ends at its check time: <b>Passed</b> (each target had enough use and met every check), <b>Failed</b> (names the
        check), <b>Too little use</b> (fewer than {DEFAULT_WATCH_CHECKS.min_uses} calls on a target: checked again once), <b>Unknown</b> (some
        hours were not recorded). <b>Exempt</b>: the task recorded why real use cannot show its change.
        {' '}<b>Closed unwatched</b>: its lead or you closed it after it shipped, with nothing watching.
      </p>
    </section>
  );
}

function NoteRow({ n, now, titles }: { n: UsageNote; now: number; titles: Map<string, string> }) {
  const status = noteStatus(n, now);
  return (
    <li className="ru-note-row" data-note={n.id} data-state={n.state}>
      <span className="ru-when">{stamp(n.sentAt ?? n.dueAt, now)}</span>
      <span className="ru-note-text">
        To <TaskLink id={n.recipient} titles={titles} fallback={n.recipientTitle ?? 'its task'} />: {n.items} alarm{n.items === 1 ? '' : 's'}
        {n.titles.length > 0 && <> ({n.titles.join('; ')})</>}
      </span>
      <NoticeStatus tone={status.tone} title={status.text}>{status.text}</NoticeStatus>
    </li>
  );
}

export function NotesBlock({ notes, now, watches, alarmsOn }: { notes: UsageNote[]; now: number; watches: UsageWatch[]; alarmsOn: boolean }) {
  const titles = taskTitles(watches);
  return (
    <section className="ru-block" data-testid="real-use-notes">
      <h4 className="ru-h">Notes sent</h4>
      <p className="ru-caption">What rang, told to the task that shipped it or to its project's lead: at most one note every 4 hours</p>
      {notes.length === 0
        ? <p className="ru-empty">{alarmsOn ? 'No notes yet.' : 'No notes: Real-use watch is off, so nobody is told.'}</p>
        : <ul className="ru-notes">{notes.map((n) => <NoteRow key={n.id} n={n} now={now} titles={titles} />)}</ul>}
    </section>
  );
}
