/**
 * Download in the Mac app: the server saves the attachment into this Mac's Downloads folder.
 *
 * The app's web view has no download of its own (desktop/main.swift sets no download delegate), so a
 * `<a download>` there did nothing, and a PDF link replaced the whole console (2026-11-13). Until an
 * app release carries a download delegate, the console asks the server to write the file instead,
 * and says where it went. A browser keeps its own download (`<a download>`), which is the better one.
 */
import { useState } from 'react';
import { mailRequestFailure, saveMailAttachment, type MailAttachmentMeta } from '@/api/mail';
import { log } from '@/utils/log';
import { inMacApp } from '@/utils/mac-app';
import { attachmentName } from './mail-format';

export type AttachmentSaveState =
  | { kind: 'idle' }
  | { kind: 'saving'; id: string; name: string }
  | { kind: 'saved'; id: string; name: string }
  | { kind: 'failed'; id: string; name: string; reason: string };

/** Download goes through the server here; everywhere else it is the browser's own. */
export function savesThroughServer(): boolean {
  return inMacApp();
}

/** The line the person reads after pressing Download, or null before they did. */
export function saveStatusLine(state: AttachmentSaveState): string | null {
  if (state.kind === 'saving') return `Saving ${state.name} to Downloads...`;
  if (state.kind === 'saved') return `Saved to Downloads as ${state.name}`;
  if (state.kind === 'failed') return `Could not save ${state.name}: ${state.reason}`;
  return null;
}

/** One message's saves: the last one's state, and `save` (a second press while one runs waits for it). */
export function useAttachmentSave(accountId: string, messageId: string) {
  const [state, setState] = useState<AttachmentSaveState>({ kind: 'idle' });
  const save = async (attachment: MailAttachmentMeta & { id: string }): Promise<void> => {
    if (state.kind === 'saving') return;
    const name = attachmentName(attachment);
    setState({ kind: 'saving', id: attachment.id, name });
    try {
      const saved = await saveMailAttachment(accountId, messageId, attachment.id);
      setState({ kind: 'saved', id: attachment.id, name: saved.name });
    } catch (error) {
      const reason = mailRequestFailure(error);
      log.warn('mail', 'attachment save failed', { accountId, messageId, attachmentId: attachment.id, reason });
      setState({ kind: 'failed', id: attachment.id, name, reason });
    }
  };
  return { state, save };
}
