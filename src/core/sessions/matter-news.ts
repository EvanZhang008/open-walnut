/**
 * Another team's news on the matter of an open ask, brought to the task that asks (ask-matter.ts).
 *
 * 2026-11-18: a triage leader's letter asked the user to switch a region's traffic back by hand;
 * the task imported for that alarm, in another project, then reported the automatic switch back
 * done. Nothing told the leader, so its letter kept asking the user to act. Each pass of the
 * re-check clock (needs-recheck.ts): a task whose ask of the user is open (its own status question,
 * or a decision letter it sent) gets ONE note per other team's task that said something on the same
 * matter after the ask was made (same-ask-tree.ts matterReportsOf): read it, and withdraw, settle or
 * correct the ask when that news settles it. Recorded on the task first (`matter_news`), so a note
 * is never sent twice for one ask and one reporter. Primary only, like the re-check.
 */
import { log } from '../../logging/index.js';
import { statusDecision } from '../ask-decision.js';
import { matterWords } from '../ask-matter.js';

export interface MatterNews {
  /** The ask the notes were about: a status ask's decision id, or a letter id. */
  ask: string;
  /** The tasks whose news on it was already brought in (`<id>`, and `<id>:done` once it finished). */
  told: string[];
}

/** The note the pass brings into the session. Pure. */
export function matterNewsBody(ask: string, where: string, r: import('../same-ask-tree.js').MatterReport): string {
  return [
    `You asked the user ${where}: "${ask.replace(/\s+/g, ' ').slice(0, 200)}".`,
    `Since then "${r.title.replace(/\s+/g, ' ').slice(0, 100)}" (${r.taskId}), in another team, which works on the same matter (${matterWords(r.matter)}), said at ${r.at.slice(0, 16).replace('T', ' ')} UTC:`,
    `"${r.said.replace(/\s+/g, ' ').slice(0, 400)}"`,
    'Check whether that settles or changes your ask (task_get or task_send that task). If it is done or no longer needed, take the ask off the user now: settle the letter, or report your status without it.',
    'If it conflicts with what you told the user, correct it in the same place. If your ask still stands, keep it and carry on.',
  ].join('\n');
}

/** One pass: a note to each task with an open ask that another team's news on its matter postdates. */
export async function runMatterNews(nowMs = Date.now()): Promise<string[]> {
  const woken: string[] = [];
  try {
    const { listTasks, updateTaskRaw } = await import('../task-manager.js');
    const { matterIndex, askMatter } = await import('../ask-matter.js');
    const { matterReportsOf, readOpenLetterTexts } = await import('../same-ask-tree.js');
    const all = await listTasks();
    const index = matterIndex(all);
    const quieted = new Set(all.flatMap((t) => (t.team_stop?.members ?? []).map((m) => m.id)));
    const { listLetters } = await import('../human-inbox/store.js');
    const { awaitsUserDecision } = await import('../human-inbox/open-decision.js');
    const open = (await listLetters({ archived: false }).catch(() => ({ letters: [] }))).letters.filter(awaitsUserDecision);
    const senders = new Set(open.map((l) => l.sender?.taskId).filter((id): id is string => !!id));
    const words = new Map((await readOpenLetterTexts(open.map((l) => ({ id: l.id, subject: l.subject, taskId: l.sender?.taskId })), senders).catch(() => [])).map((l) => [l.id, l.text] as const));
    const letters = open;
    const byId = new Map(all.map((t) => [t.id, t] as const));
    const finished = (id: string): boolean => {
      const t = byId.get(id);
      return !!t && (t.phase === 'COMPLETE' || t.status === 'done' || t.user_status?.state === 'read' || t.user_status?.state === 'done');
    };
    for (const task of all) {
      if (task.phase === 'COMPLETE' || task.status === 'done' || task.plugin_only || quieted.has(task.id)) continue;
      const asks: Array<{ key: string; ask: string; where: string; text: string; since: number }> = [];
      const s = task.user_status;
      // Main and a lead ask in letters and Threads, never in a Needs you of their own.
      if (!task.org_role && s?.state === 'needs' && s.source === 'session' && s.ask) {
        // Since the ask began, not since it was last checked: a check moves on at every turn end.
        const r = task.status_report?.state === 'needs' ? task.status_report : null;
        const since = Date.parse(r?.ask_since ?? r?.needs_since ?? s.at ?? '');
        asks.push({ key: statusDecision(s)?.id ?? `status:${r?.needs_since ?? s.at ?? ''}`, ask: s.ask, where: 'in your status (Needs you)', text: [s.ask, r?.ask_more ?? ''].join('\n'), since });
      }
      for (const l of letters) {
        if (l.sender?.taskId !== task.id) continue;
        asks.push({ key: l.id, ask: l.subject, where: `in your decision letter ${l.id}`, text: words.get(l.id) ?? `${l.subject}\n${l.textPreview ?? ''}`, since: Number(l.createdAt) });
      }
      for (const a of asks) {
        if (!Number.isFinite(a.since)) continue;
        const keys = askMatter(task.id, a.text, index);
        keys.delete(task.id.toLowerCase());
        const news = matterReportsOf(task.id, keys, all, index.own, nowMs).filter((r) => Date.parse(r.at) > a.since);
        const kept = task.matter_news ?? [];
        const prev = kept.find((m) => m.ask === a.key) ?? null;
        // Once per reporter, and once more when it finishes: the "done" after a "watching it" is the news.
        const mark = (r: { taskId: string }) => (finished(r.taskId) ? `${r.taskId}:done` : r.taskId);
        const fresh = news.find((r) => !prev?.told.includes(mark(r)));
        if (!fresh) continue;
        const { getSessionsForTask } = await import('../session-tracker.js');
        const { pickDeliverySession } = await import('../routines/session-target.js');
        const target = pickDeliverySession(await getSessionsForTask(task.id).catch(() => []));
        if (!target) break;
        const next: MatterNews[] = [...kept.filter((m) => m.ask !== a.key), { ask: a.key, told: [...(prev?.told ?? []), mark(fresh)].slice(-20) }].slice(-10);
        // Recorded first: a failed wake never repeats every pass.
        await updateTaskRaw(task.id, { matter_news: next }, { push: false, source: 'matter-news' }).catch(() => null);
        const { buildWalnutMessage } = await import('../peers/walnut-message-tag.js');
        const { sendMessageToSession } = await import('../session-message-queue.js');
        const { WAIT_UNTIL_SEND_SOURCE } = await import('../task-wait-until.js');
        try {
          await sendMessageToSession(target.claudeSessionId, buildWalnutMessage({
            kind: 'trigger',
            attrs: { from: 'Walnut: news on your ask', note: 'another team reported on the same matter' },
            body: matterNewsBody(a.ask, a.where, fresh),
          }), { source: WAIT_UNTIL_SEND_SOURCE, taskId: task.id });
          woken.push(task.id);
          log.task.info('matter news sent', { taskId: task.id, reporter: fresh.taskId, matter: fresh.matter });
        } catch (err) {
          log.task.warn('matter news not delivered', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
        }
        // One note per task per pass.
        break;
      }
    }
  } catch (err) {
    log.task.warn('matter news pass failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return woken;
}

