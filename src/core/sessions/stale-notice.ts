/**
 * A line never reaches a CLI with an instruction notice that CLI does not need (2026-11-21, the org
 * reflection: 78 notices, 23 over 5,000 characters, in 12 hours). A notice is looked up against the
 * prompt the session's record holds when its line is frozen; a cold resume may then run on a prompt
 * rebuilt on the current instructions (prompt-refresh.ts), and a line the host queued while the
 * server was away carries the host's notice from its own copy. 43 of those 78 notices reached a CLI
 * resumed seconds before on a rebuilt prompt, which already held every word of them (11 to 14 KB
 * each at 08:00, when the Mac woke and resumed its sessions); and since such a notice was told on
 * another prompt, the record kept nothing of it, so the next change went out at once, inside the gap.
 *
 * So every line is checked against the prompt of the CLI that takes it, just before it is written:
 * a notice that is not what that CLI must hear now (instruction-notice.ts noticeStillDue) leaves the
 * line, in the queue too (the delivery then records nothing of it), and the next line carries what
 * is due, if anything. Never throws.
 */
import { log } from '../../logging/index.js';
import { leadsWithNotice } from './instruction-notice-flight.js';

type Row = { id?: string; message: string };
/** The prompt that CLI runs on, or a read of it, made only when a row carries a notice. */
type PromptOf = string | undefined | (() => Promise<string | undefined>);

/**
 * Drop a stale notice leading any of `rows`: in place and in the queue's copy, both or neither (the
 * queue's own write keeps its cache and catches the file up on its next write, as for every row). True
 * when one was dropped.
 */
export async function dropStaleNotices(sessionId: string, rows: Row[], promptOf: PromptOf): Promise<boolean> {
  if (!rows.some((r) => leadsWithNotice(r.message))) return false;
  try {
    const { forgetAttachedNotice, leadingNotice, noticeStillDue, stripInstructionNotice } = await import('./instruction-notice.js');
    const prompt = typeof promptOf === 'function' ? await promptOf() : promptOf;
    const stale: Array<{ row: Row; notice: string; to: string }> = [];
    for (const row of rows) {
      const notice = leadingNotice(row.message);
      if (notice && !(await noticeStillDue(sessionId, notice, prompt))) stale.push({ row, notice, to: stripInstructionNotice(row.message) });
    }
    if (!stale.length) return false;
    const { rewriteFrozenRows } = await import('../session-message-queue.js');
    await rewriteFrozenRows(sessionId, stale.flatMap((s) => (s.row.id ? [{ id: s.row.id, from: s.row.message, to: s.to }] : [])));
    for (const s of stale) {
      s.row.message = s.to;
      forgetAttachedNotice(sessionId, s.notice);
      log.session.info('Instruction notice dropped: the CLI that takes the line runs on a prompt that does not need it', {
        sessionId, chars: s.notice.length,
      });
    }
    return true;
  } catch (error) {
    log.session.warn('Instruction notice: stale check failed, the line goes as frozen', { sessionId, error: String(error) });
    return false;
  }
}
