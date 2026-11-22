/**
 * The topic dialogs, mounted once in App (topic-dialogs.ts opens them): New topic, and Add to
 * topic, which lists the open topics to add the members to (a topic they are all in already says
 * so) and offers a new one with them. Done, the topic opens on the Org page. Nothing renders while
 * the experiment is off.
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { editTopicMembers } from '@/api/topics';
import { ModalOverlayOwner, useModalOverlay } from '@/hooks/useModalOverlay';
import { log } from '@/utils/log';
import { closeTopicDialog, openNewTopic, useTopicDialog, type PickedMember } from './topic-dialogs';
import { NewTopicDialog } from './NewTopicDialog';
import { openTopics, refKey } from './topic-model';
import { StackedAvatars } from './TopicAvatars';
import { useOpenTopic } from './topic-entry';
import { useTopicsOn } from './topics-flag';
import { useTopicList } from './useTopics';

export function TopicDialogsHost() {
  const on = useTopicsOn();
  const dialog = useTopicDialog();
  const openTopic = useOpenTopic();
  if (!on || !dialog) return null;
  const done = (topicId: string) => { closeTopicDialog(); openTopic(topicId); };
  if (dialog.kind === 'new') return <NewTopicDialog initial={dialog.members} onClose={closeTopicDialog} onMade={done} />;
  return <AddToTopicDialog members={dialog.members} onClose={closeTopicDialog} onAdded={done} />;
}

function AddToTopicDialog({ members, onClose, onAdded }: { members: PickedMember[]; onClose: () => void; onAdded: (topicId: string) => void }) {
  const modalOwner = useModalOverlay(onClose);
  const { list, error: listError } = useTopicList(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = openTopics(list ?? []);
  const keys = members.map((m) => refKey(m.ref));
  const who = members.map((m) => m.name).join(', ');

  const add = async (topicId: string) => {
    setBusy(topicId);
    setError(null);
    try {
      await editTopicMembers(topicId, { add: members.map((m) => m.ref) });
      log.info('topics', 'members added from a menu', { topicId, count: members.length });
      onAdded(topicId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('topics', 'add from a menu failed', { topicId, error: msg });
      setError(`Could not add ${who}: ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  return createPortal(
    <ModalOverlayOwner.Provider value={modalOwner}>
      <div className="app-modal-overlay wn-scrim" role="dialog" aria-modal="true" aria-label="Add to topic" data-testid="topic-add-dialog" onMouseDown={onClose}>
        <div className="app-modal topic-dialog wn-dialog" onMouseDown={(e) => e.stopPropagation()}>
          <div className="app-modal-title">Add {who} to a topic</div>
          {list === null && !listError && <p className="topic-muted" aria-busy="true">Loading…</p>}
          {listError && <p className="topic-error">{listError}</p>}
          {list !== null && shown.length === 0 && <p className="topic-muted">No open topic yet.</p>}
          {shown.length > 0 && (
            <ul className="topic-candidates topic-add-list" data-testid="topic-add-list">
              {shown.map((t) => {
                const inAll = keys.every((k) => t.members.some((m) => m.status !== 'left' && refKey(m.ref) === k));
                return (
                  <li key={t.id}>
                    <button type="button" className="topic-candidate" data-testid="topic-add-pick" data-peek-row="" data-topic-id={t.id}
                      disabled={inAll || busy !== null} title={inAll ? `${who} already in it` : `Add ${who} to “${t.title}”`}
                      onClick={() => void add(t.id)}>
                      <StackedAvatars members={t.members} size={18} />
                      <span className="topic-candidate-name wn-title">{t.title}</span>
                      <span className="topic-candidate-hint">{inAll ? 'Already in' : busy === t.id ? 'Adding…' : `${t.members.filter((m) => m.status !== 'left').length} members`}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {error && <p className="topic-error" data-testid="topic-add-error">{error}</p>}
          <div className="app-modal-actions wn-dialog-foot">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" data-testid="topic-add-new" onClick={() => openNewTopic(members)}>+ New topic with them</button>
          </div>
        </div>
      </div>
    </ModalOverlayOwner.Provider>,
    document.body,
  );
}
