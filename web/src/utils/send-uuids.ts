/**
 * The send uuids one history user row stands for.
 *
 * A row is the CLI's line for one or more sends: its own uuid (`msgId`), the
 * uuid a line taken mid-turn was sent under (`sourceUuid`, from its
 * `queued_command` attachment), and, when Claude Code drained several queued
 * sends into one line, the uuids of the others (`mergedUuids`, its
 * `mergedSendUuids`). Each one is exact proof that its send reached the CLI.
 *
 * Every reader that matches a bubble, a draft or a streamed line to its row goes
 * through here: a collector that read only `msgId` and `sourceUuid` left the
 * first send of a merged line "Delivered ✓" at the bottom of the timeline for
 * good (inc-1794638780357, tests/web/optimistic-dedup-merged-uuid.test.ts).
 */

export interface RowWithSendUuids {
  role: string;
  msgId?: string;
  sourceUuid?: string;
  mergedUuids?: readonly string[];
}

/** The row's send uuids, own line uuid first; empty for any row but a user row. */
export function sendUuidsOfRow(m: RowWithSendUuids): string[] {
  if (m.role !== 'user') return [];
  const out: string[] = [];
  if (m.msgId) out.push(m.msgId);
  if (m.sourceUuid) out.push(m.sourceUuid);
  for (const u of m.mergedUuids ?? []) if (u) out.push(u);
  return out;
}
