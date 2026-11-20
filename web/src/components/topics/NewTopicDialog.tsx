/**
 * New topic: a title, its members (tasks, the CEO and VPs, people by email), which one hosts it,
 * and an optional first message (sent, it starts the conversation). The host defaults to the first
 * org node picked, else the first task, as the server's own default; ★ on a chip moves it. The
 * title and the first message are kept as drafts until the topic is made. With a person picked,
 * "Email from" picks the mailbox they are emailed from, and Create first asks the user's yes to
 * Walnut emailing them (from that mailbox, or none chosen yet: nothing is sent).
 */
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createTopic, newClientId, setTopicMail } from '@/api/topics';
import { useConfirm } from '@/hooks/useConfirm';
import { ModalOverlayOwner, useModalOverlay } from '@/hooks/useModalOverlay';
import { useDraft } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { MicField, MicInput } from '@/components/common/BoxMic';
import { log } from '@/utils/log';
import type { PickedMember } from './topic-dialogs';
import { MemberPicker } from './MemberPicker';
import { topicMade } from './useTopics';
import { defaultHost, personEmails, personMailConfirm } from './topic-model';
import { TopicMailFrom } from './TopicMailFrom';
import { mailboxWords, useMailAccounts } from './useMailAccounts';

export function NewTopicDialog({ initial, onClose, onMade }: {
  initial: PickedMember[];
  onClose: () => void;
  onMade: (topicId: string) => void;
}) {
  const modalOwner = useModalOverlay(onClose);
  const title = useDraft(draftKey('topic-new', 'title'));
  const first = useDraft(draftKey('topic-new', 'text'));
  const firstBox = useRef<HTMLTextAreaElement>(null);
  const [picked, setPicked] = useState<PickedMember[]>(initial);
  const [host, setHost] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One id per dialog: pressing Create again after a lost answer makes the topic once.
  const [clientId] = useState(newClientId);
  const hostIndex = host !== null && host < picked.length && picked[host]?.ref.kind !== 'person' ? host : defaultHost(picked);
  const canHost = (i: number) => picked[i]?.ref.kind !== 'person';
  const ready = !!title.text.trim() && picked.length > 0 && !busy;
  const confirm = useConfirm();
  const [mailFrom, setMailFrom] = useState<string | null>(null);
  const emails = personEmails(picked.map((p) => p.ref));
  const { accounts } = useMailAccounts(emails.length > 0);

  const create = async () => {
    if (!ready) return;
    // Mail goes out in the user's name: only his yes to these words adds the people.
    if (emails.length && !(await confirm({ title: 'Email from this topic?', message: personMailConfirm(emails, mailboxWords(accounts, mailFrom)), confirmLabel: 'Add' }))) return;
    setBusy(true);
    setError(null);
    try {
      const topic = await createTopic({
        title: title.text.trim(),
        members: picked.map((p) => p.ref),
        ...(hostIndex !== undefined ? { host: hostIndex } : {}),
        text: first.text,
        clientId,
      });
      log.info('topics', 'topic created', { topicId: topic.id, members: picked.length });
      let made = topic;
      if (emails.length && mailFrom) {
        made = await setTopicMail(topic.id, mailFrom).catch((err: unknown) => {
          // The topic is made; its side panel offers the mailbox again.
          log.warn('topics', 'mailbox not set on the new topic', { topicId: topic.id, error: err instanceof Error ? err.message : String(err) });
          return topic;
        });
      }
      title.clear();
      first.clear();
      topicMade(made);
      onMade(topic.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('topics', 'create failed', { error: msg });
      setError(`Could not create the topic: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <ModalOverlayOwner.Provider value={modalOwner}>
      <div className="app-modal-overlay" role="dialog" aria-modal="true" aria-label="New topic" data-testid="topic-new-dialog" onMouseDown={onClose}>
        <div className="app-modal topic-dialog" onMouseDown={(e) => e.stopPropagation()}>
          <div className="app-modal-title">New topic</div>
          <p className="topic-muted">A group chat of tasks, VPs and people. A message wakes the members it names with @, or everyone when it names no one.</p>
          <label className="topic-field-label" htmlFor="topic-new-title">Title</label>
          <MicInput
            id="topic-new-title"
            data-draft-key={title.key ?? undefined}
            className="app-modal-input"
            value={title.text}
            setText={title.setText}
            target={title.key}
            placeholder="What it is about"
            data-testid="topic-new-title"
            autoFocus
          />
          <span className="topic-field-label">Members</span>
          <MemberPicker
            picked={picked}
            onChange={setPicked}
            {...(hostIndex !== undefined ? { host: hostIndex } : {})}
            onHost={(i) => { if (canHost(i)) setHost(i); }}
          />
          {emails.length > 0 && <TopicMailFrom value={mailFrom} onPick={setMailFrom} />}
          <label className="topic-field-label" htmlFor="topic-new-text">First message (optional)</label>
          <MicField boxRef={firstBox} text={first.text} setText={first.setText} target={first.key}>
            <textarea
              ref={firstBox}
              id="topic-new-text"
              data-draft-key={first.key ?? undefined}
              className="app-modal-input topic-first-text"
              rows={3}
              value={first.text}
              onChange={(e) => first.setText(e.target.value)}
              placeholder="Sent when the topic is made; @Name wakes only that member"
              data-testid="topic-new-text"
            />
          </MicField>
          {error && <p className="topic-error" data-testid="topic-new-error">{error}</p>}
          <div className="app-modal-actions">
            <button type="button" className="app-modal-btn" onClick={onClose}>Cancel</button>
            <button type="button" className="app-modal-btn primary" data-testid="topic-new-create" disabled={!ready} onClick={() => void create()}>
              {busy ? 'Creating…' : 'Create topic'}
            </button>
          </div>
        </div>
      </div>
    </ModalOverlayOwner.Provider>,
    document.body,
  );
}
