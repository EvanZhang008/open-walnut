/** Route private-data sync holds to their writer, never the human inbox. */
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { WALNUT_HOME } from '../constants.js';
import { log } from '../logging/index.js';
import type { LetterSender } from '../core/human-inbox/types.js';
import type { SecretHold, SecretHoldNotice } from './git-sync-secrets.js';

export interface HeldFileSummary { file: string; kinds: string[]; lines: number[]; since: string }

/** Quiet Health detail: never contributes to a bell, error episode or Needs you count. */
export async function readSecretHoldSummaries(root = WALNUT_HOME): Promise<HeldFileSummary[]> {
  try {
    const store = JSON.parse(await fsp.readFile(path.join(root, '.git', 'walnut-secret-holds.json'), 'utf8'));
    if (store.version !== 2 || !store.holds) return [];
    return Object.entries(store.holds).map(([file, raw]) => {
      const hold = raw as SecretHold;
      return { file: path.join(root, file), kinds: hold.kinds, lines: hold.lines, since: hold.since };
    });
  } catch { return []; }
}

/** Letter reply bodies use the reply's own sender, never the original letter's sender. */
export async function secretFileWriter(file: string): Promise<LetterSender | undefined> {
  if (file.startsWith('human-inbox/bodies/')) {
    const body = file.slice('human-inbox/bodies/'.length);
    const { readLetterIndexForReplica } = await import('../core/human-inbox/store.js');
    const letters = await readLetterIndexForReplica({ readErrors: 'throw' });
    for (const letter of letters) {
      if (body === `${letter.id}.${letter.bodyFormat === 'html' ? 'html' : 'md'}`) return letter.sender;
      const turn = letter.thread.find((entry) => entry.bodyFile === body);
      if (turn) return turn.sender;
    }
  }
  return undefined;
}

export function secretHoldWriterText(notice: SecretHoldNotice, file: string, hold: SecretHold): string {
  const root = notice.root ?? WALNUT_HOME;
  const findings = hold.kinds.map((kind, i) => `${kind}${hold.lines[i] ? ` (line ${hold.lines[i]})` : ' (file name)'}`).join(', ');
  return [
    '<walnut-message kind="notification" from="Walnut" outcome="private-data-sync-hold">',
    `Walnut kept ${path.join(root, file)} out of the synced history of your private data folder, not the Walnut code repository. The held credential was not sent anywhere. This is not a public leak.`,
    `Findings: ${findings}.`,
    ...(notice.aside ? [`The local copy was preserved at ${path.join(root, notice.aside)} so sync could receive the other machine's version.`] : []),
    ...(notice.aside ? [
      'The credential is in the preserved sidecar, not the incoming file. Move it into Settings or the secrets store, merge only the other needed content back into the original file, then remove the sidecar. The sidecar never syncs.',
    ] : file.startsWith('human-inbox/bodies/') ? [
      `This is a letter body on the Walnut server, not necessarily your host. Keep the credential in Settings or the secrets store, then use POST /api/v1/human-inbox/${path.basename(file).split('.')[0]}/redact-credentials through Walnut's api tool. That existing operation removes credential lines from the letter and updates body sizes and the index together. Do not edit body files directly or read the credential into your transcript.`,
    ] : ['Move the credential into Settings or the never-synced secrets store, and remove only its value from the document (keep the other content). The file syncs again when clean.']),
    'Do this yourself, without asking the user to review, rotate credentials or rewrite history. Do not print the credential or put it in a reply, letter or task note.',
    '</walnut-message>',
  ].join('\n');
}

export async function notifySecretHoldWriter(notice: SecretHoldNotice): Promise<void> {
  if (notice.event === 'released') return;
  for (const { file, hold } of notice.files) {
    const writer = await secretFileWriter(file);
    const { getSessionByClaudeId } = await import('../core/session-tracker.js');
    let sid = writer?.sessionId;
    if (writer?.taskId) {
      const { getTask } = await import('../core/task-manager.js');
      const task = await getTask(writer.taskId).catch(() => null);
      sid = task?.session_id ?? sid;
    }
    const record = sid && sid !== 'external' ? await getSessionByClaudeId(sid) : null;
    if (!record || record.profile?.areaId) {
      log.git.info('git-sync: private data file held locally; writer unknown; nothing sent; see Health', {
        file: path.join(notice.root ?? WALNUT_HOME, file), kinds: hold.kinds, lines: hold.lines,
      });
      continue;
    }
    const { deliverToSession } = await import('../core/sessions/session-send-core.js');
    const text = secretHoldWriterText(notice, file, hold);
    const messageId = `qm-secret-hold-${crypto.createHash('sha256').update(`${notice.event === 'held' ? hold.letterOp ?? notice.op : notice.op}:${file}:${record.claudeSessionId}`).digest('hex').slice(0, 32)}`;
    await deliverToSession(record, { busText: text, enqueueText: text, source: 'walnut-notify', taskId: record.taskId, messageId });
  }
}
