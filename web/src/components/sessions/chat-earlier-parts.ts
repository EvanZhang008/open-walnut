/**
 * The pure half of ChatEarlierBlock: the row shape GET /api/v1/sessions/:id/chat-earlier
 * serves (the phone's message rows), and how the block folds them.
 */

export interface ChatEarlierMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt?: string;
  kind?: 'tool' | 'thinking' | 'notification';
}

export type EarlierPart =
  | { kind: 'text'; row: ChatEarlierMessage }
  | { kind: 'steps'; key: string; count: number };

/** Text rows as they are; the tool and thinking rows between them fold into one
 *  muted "N steps" line (their detail stays on the phone and in the old session). */
export function earlierParts(rows: readonly ChatEarlierMessage[]): EarlierPart[] {
  const out: EarlierPart[] = [];
  for (const row of rows) {
    if (row.kind === 'tool' || row.kind === 'thinking') {
      const last = out[out.length - 1];
      if (last?.kind === 'steps') last.count += 1;
      else out.push({ kind: 'steps', key: row.id, count: 1 });
      continue;
    }
    if (row.text.trim()) out.push({ kind: 'text', row });
  }
  return out;
}
