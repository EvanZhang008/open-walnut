/**
 * The topic's side panel: what its host wrote on its thread (the summary and its state), the
 * members with their status (Confirm for a person an agent added, who gets no mail until the user
 * says yes; Remove), Add (the member picker), and how many of this round's member wakes are used.
 * While a person is in the topic (or being added): "Email from", the mailbox they are emailed from.
 * Adding a person, or confirming one, first asks: Walnut will email them, from that mailbox; so does
 * choosing a mailbox while people are in it (mail starts going to them from it).
 * On a narrow window TopicChat lays it over the conversation as a sheet (`sheet`): a close button on
 * top, the rest the same.
 */
import { useMemo, useState, type RefObject } from 'react';
import type { Topic } from '@/api/topics';
import { useConfirm } from '@/hooks/useConfirm';
import { AgentText } from '@/components/common/AgentText';
import { ICON_CLOSE, ICON_PLUS } from '@/components/common/Icons';
import { useOrgThreads } from '@/components/org/useOrgThreads';
import type { PickedMember } from './topic-dialogs';
import { MemberPicker } from './MemberPicker';
import { nameContext, shortName, ROUND_WAKES, activePersonEmails, mailboxConfirm, memberStatusLabel, personEmails, personMailConfirm, refKey } from './topic-model';
import { TopicMailFrom } from './TopicMailFrom';
import { mailboxWords, useMailAccounts } from './useMailAccounts';
import { MemberAvatar } from './TopicAvatars';
import type { TopicActions } from './useTopics';

/** Under a member's name: its status when it is news (Host, Replying, Waiting for your yes), then its project, or a person's email. */
function memberLine(m: Topic['members'][number]): string {
  const label = memberStatusLabel(m);
  const parts = [label === 'Member' ? '' : label, nameContext(m.name), m.ref.kind === 'person' ? `${m.ref.email}${m.ref.bot ? ' · bot' : ''}` : ''];
  return parts.filter(Boolean).join(' · ') || label;
}

function HostThread({ topic }: { topic: Topic }) {
  const link = topic.thread;
  const state = useOrgThreads(link?.node, !!link);
  const t = link ? state.threads?.find((x) => x.id === link.threadId) : undefined;
  if (!link) return null;
  return (
    <section className="topic-side-block" data-testid="topic-host-thread">
      <h3 className="topic-side-head" title="The host writes it on its thread">Where it stands</h3>
      {t?.reply ? <AgentText text={t.reply} compact unknownSource className="topic-host-summary" /> : <p className="topic-muted">The host has not written a summary yet.</p>}
      {t && <p className="topic-side-note" data-testid="topic-host-thread-state">State: {t.closed ? 'closed' : t.state}</p>}
    </section>
  );
}

export function TopicSidePanel({ topic, actions, sheet }: {
  topic: Topic;
  actions: Pick<TopicActions, 'addMembers' | 'removeMember' | 'confirmMember' | 'setMail'>;
  /** Laid over the conversation (a narrow window): its close button, and where focus starts. */
  sheet?: { onClose: () => void; closeRef: RefObject<HTMLButtonElement | null> };
}) {
  const confirm = useConfirm();
  const [adding, setAdding] = useState<PickedMember[] | null>(null);
  const live = useMemo(() => topic.members.filter((m) => m.status !== 'left'), [topic.members]);
  const exclude = useMemo(() => new Set(live.map((m) => refKey(m.ref))), [live]);
  const closed = !!topic.closed;
  const used = Math.min(ROUND_WAKES, topic.round?.hops ?? 0);
  const mailbox = topic.mail?.accountId ?? null;
  const addingEmails = personEmails((adding ?? []).map((p) => p.ref));
  const showsMail = live.some((m) => m.ref.kind === 'person') || addingEmails.length > 0;
  const { accounts } = useMailAccounts(showsMail);
  const from = mailboxWords(accounts, mailbox);

  const remove = async (id: string, name: string) => {
    if (await confirm({ title: `Remove ${name} from this topic?`, message: 'It stops getting the topic’s messages.', confirmLabel: 'Remove', danger: true })) await actions.removeMember(id);
  };
  const add = async () => {
    if (!adding?.length) return;
    // Mail goes out in the user's name: only his yes to these words adds a person.
    if (addingEmails.length && !(await confirm({ title: 'Email from this topic?', message: personMailConfirm(addingEmails, from), confirmLabel: 'Add' }))) return;
    if (await actions.addMembers(adding.map((p) => p.ref))) setAdding(null);
  };
  const pickMailbox = async (accountId: string | null) => {
    // Choosing one starts mail to the people already in the topic: only his yes to these words does.
    const people = activePersonEmails(live);
    const address = mailboxWords(accounts, accountId);
    if (address && people.length && !(await confirm({ title: 'Email from this mailbox?', message: mailboxConfirm(people, address), confirmLabel: 'Use it' }))) return;
    await actions.setMail(accountId);
  };
  const confirmPerson = async (id: string, email: string) => {
    if (await confirm({ title: 'Email from this topic?', message: personMailConfirm([email], from, 'Confirm?'), confirmLabel: 'Confirm' })) await actions.confirmMember(id);
  };

  return (
    <aside className={`topic-side${sheet ? ' is-sheet' : ''}`} data-testid="topic-side" aria-label="Topic members">
      {sheet && (
        <div className="topic-sheet-head">
          <span className="topic-side-head">Members and mail</span>
          <button ref={sheet.closeRef} type="button" className="topic-chip-x topic-sheet-close" data-testid="topic-sheet-close" aria-label="Close the members panel" title="Close (Esc)" onClick={sheet.onClose}>×</button>
        </div>
      )}
      <HostThread topic={topic} />
      <section className="topic-side-block">
        <h3 className="topic-side-head">Members <span className="topic-side-count">{live.length}</span></h3>
        <ul className="topic-members" data-testid="topic-members">
          {live.map((m) => (
            <li key={m.id} className={`topic-member is-${m.status}`} data-testid="topic-member" data-member-id={m.id} data-status={m.status} data-role={m.role}>
              <MemberAvatar who={{ name: m.name, ref: m.ref }} size={24} />
              <span className="topic-member-mid">
                <span className="topic-member-name" title={m.name}>{shortName(m.name)}</span>
                <span className="topic-member-status">{memberLine(m)}</span>
              </span>
              {!closed && m.status === 'pending' && (
                <button type="button" className="btn btn-sm btn-primary" data-testid="topic-member-confirm" title="Let Walnut mail them the topic" onClick={() => void confirmPerson(m.id, m.ref.kind === 'person' ? m.ref.email : m.name)}>Confirm</button>
              )}
              {!closed && m.role !== 'host' && (
                <button type="button" className="topic-member-remove" data-testid="topic-member-remove" aria-label={`Remove ${m.name}`} title="Remove from the topic" onClick={() => void remove(m.id, m.name)}>{ICON_CLOSE}</button>
              )}
            </li>
          ))}
        </ul>
        {!closed && (adding ? (
          <div className="topic-side-add" data-testid="topic-side-add">
            <MemberPicker picked={adding} onChange={setAdding} exclude={exclude} autoFocus />
            <span className="topic-person-actions">
              <button type="button" className="btn" onClick={() => setAdding(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" data-testid="topic-side-add-save" disabled={!adding.length} onClick={() => void add()}>Add {adding.length || ''}</button>
            </span>
          </div>
        ) : (
          <button type="button" className="topic-add-row" data-testid="topic-member-add" onClick={() => setAdding([])}>
            <span className="topic-add-row-icon" aria-hidden="true">{ICON_PLUS}</span>Add a member
          </button>
        ))}
      </section>
      {showsMail && (
        <section className="topic-side-block">
          <TopicMailFrom value={mailbox} onPick={(id) => void pickMailbox(id)} disabled={closed} />
        </section>
      )}
      <section className="topic-side-block">
        <p className="topic-side-note" data-testid="topic-round" title="A member's post wakes at most this many others a round; your next message starts a new round">Round {topic.round?.n ?? 0} · member wakes used {used}/{ROUND_WAKES}</p>
      </section>
    </aside>
  );
}
