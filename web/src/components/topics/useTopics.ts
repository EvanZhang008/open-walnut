/**
 * Topics in the browser: one list and one copy of each open topic for the whole page, kept current
 * by the server's `topic:updated` event ({ topicId }) and read again after a reconnect, the way the
 * Org Threads are (useOrgThreads). Every surface (the Org list, a chat, a thread card, the pickers)
 * reads the same copy. Nothing is fetched while the experiment is off. A post is drawn at once and
 * meets the server's copy by its clientId; a failed send's clientId stays with its words, so sending
 * them again is answered once (topic-send.ts).
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import {
  closeTopic, confirmTopicMember, editTopicMembers, listTopics, newClientId, postTopicMessage, readTopic, setTopicMail,
  type MemberRef, type Topic, type TopicMessage, type TopicSummary,
} from '@/api/topics';
import { wsClient } from '@/api/ws';
import { log } from '@/utils/log';
import { parseMentions } from './topic-model';
import { sendClientId, withAnswer, withSending, type PendingSend } from './topic-send';

interface ListState { list: TopicSummary[] | null; error: string | null }
interface OneState { topic: Topic | null; error: string | null; seq: number }

let listState: ListState = { list: null, error: null };
let listSeq = 0;
let listInflight: Promise<void> | null = null;
const ones = new Map<string, OneState>();
/** Per topic, the send not yet answered with success: the same words sent again reuse its clientId. */
const pendingSends = new Map<string, PendingSend>();
/** How many views show each topic: only those are read again on an event. */
const watching = new Map<string, number>();
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function loadList(why: string): Promise<void> {
  if (listInflight) return listInflight;
  const seq = ++listSeq;
  const p = listTopics()
    .then((list) => { if (seq === listSeq) listState = { list, error: null }; })
    .catch((err) => {
      log.warn('topics', 'list read failed', { why, error: errText(err) });
      if (seq === listSeq) listState = { list: listState.list, error: errText(err) };
    })
    .finally(() => { listInflight = null; notify(); });
  listInflight = p;
  return p;
}

function setOne(id: string, next: Partial<OneState>) {
  const was = ones.get(id) ?? { topic: null, error: null, seq: 0 };
  ones.set(id, { ...was, ...next });
  notify();
}

function loadOne(id: string, why: string): Promise<void> {
  const seq = (ones.get(id)?.seq ?? 0) + 1;
  setOne(id, { seq });
  return readTopic(id)
    .then((topic) => {
      if (ones.get(id)?.seq !== seq) return;
      // A message still on its way stays drawn under what the server has so far, until the server has it.
      const before: LocalMessage[] = ones.get(id)?.topic?.messages ?? [];
      setOne(id, { topic: { ...topic, messages: withSending<LocalMessage>(topic.messages, before) }, error: null });
    })
    .catch((err) => {
      log.warn('topics', 'topic read failed', { topicId: id, why, error: errText(err) });
      if (ones.get(id)?.seq === seq) setOne(id, { error: errText(err) });
    });
}

/** Coalesce a burst of events (a post, its delivery, a reply) into one read per thing. */
const timers = new Map<string, number>();
function soon(key: string, fn: () => void, ms = 250) {
  const was = timers.get(key);
  if (was) window.clearTimeout(was);
  timers.set(key, window.setTimeout(() => { timers.delete(key); fn(); }, ms));
}

let bound = false;
function bindEvents() {
  if (bound) return;
  bound = true;
  wsClient.onEvent('topic:updated', (data: unknown) => {
    const id = (data as { topicId?: string } | null)?.topicId;
    soon('list', () => { void loadList('event'); });
    if (id && watching.get(id)) soon(`one:${id}`, () => { void loadOne(id, 'event'); });
  });
  wsClient.onEvent('_ws:reconnected', () => {
    void loadList('reconnect');
    for (const [id, n] of watching) if (n > 0) void loadOne(id, 'reconnect');
  });
}

/** Every topic (open and closed), or null until the first read. */
export function useTopicList(enabled: boolean): ListState & { reload: () => void } {
  const state = useSyncExternalStore(subscribe, () => listState);
  useEffect(() => {
    if (!enabled) return;
    bindEvents();
    if (!listState.list && !listInflight) void loadList('mount');
  }, [enabled]);
  const reload = useLeanCallback(() => { void loadList('reload'); }, []);
  return enabled ? { ...state, reload } : { list: [], error: null, reload };
}

export interface TopicActions {
  /** Resolves false when the server refused: the composer keeps the words. */
  post: (text: string) => Promise<boolean>;
  addMembers: (refs: MemberRef[]) => Promise<boolean>;
  removeMember: (memberId: string) => Promise<boolean>;
  confirmMember: (memberId: string) => Promise<boolean>;
  /** The mailbox the topic's people are emailed from (null: none). */
  setMail: (accountId: string | null) => Promise<boolean>;
  close: () => Promise<boolean>;
}

/** A message on its way: drawn at once, replaced by the server's when it answers. */
export interface LocalMessage extends TopicMessage { local?: 'sending' }

function withLocal(id: string, msg: LocalMessage | null, dropId?: string) {
  const s = ones.get(id);
  if (!s?.topic) return;
  const kept = s.topic.messages.filter((m) => m.id !== dropId);
  setOne(id, { topic: { ...s.topic, messages: msg ? [...kept, msg] : kept } });
}

/** One topic, live, and what the person can do in it. */
export function useTopic(id: string | null, enabled: boolean): { topic: Topic | null; error: string | null } & TopicActions {
  const state = useSyncExternalStore(subscribe, () => (id ? ones.get(id) : undefined));
  useEffect(() => {
    if (!enabled || !id) return;
    bindEvents();
    watching.set(id, (watching.get(id) ?? 0) + 1);
    void loadOne(id, 'mount');
    return () => { watching.set(id, Math.max(0, (watching.get(id) ?? 1) - 1)); };
  }, [enabled, id]);

  const write = useLeanCallback(async (what: string, fn: () => Promise<Topic | void>): Promise<boolean> => {
    if (!id) return false;
    try {
      const topic = await fn();
      if (topic) setOne(id, { topic, error: null });
      void loadList('write');
      return true;
    } catch (err) {
      log.warn('topics', `${what} failed`, { topicId: id, error: errText(err) });
      setOne(id, { error: `Could not ${what}: ${errText(err)}` });
      return false;
    }
  }, [id]);

  const post = useLeanCallback(async (text: string): Promise<boolean> => {
    const topic = id ? ones.get(id)?.topic : null;
    if (!id || !topic || !text.trim()) return false;
    const clientId = sendClientId(pendingSends.get(id), text, newClientId);
    const retry = pendingSends.get(id)?.clientId === clientId;
    pendingSends.set(id, { text, clientId });
    const localId = `local-${clientId}`;
    const mentions = parseMentions(text, topic.members);
    // A retry whose first try the server kept (its answer was lost) is drawn already: no second copy.
    const held = topic.messages.some((m) => !(m as LocalMessage).local && m.clientId === clientId);
    if (!held) withLocal(id, { id: localId, clientId, at: new Date().toISOString(), author: 'human', text, mentions, via: 'ui', local: 'sending' }, localId);
    log.info('topics', 'post', { topicId: id, mentions: mentions.length, retry });
    try {
      const res = await postTopicMessage(id, text, { mentions, clientId });
      if (pendingSends.get(id)?.clientId === clientId) pendingSends.delete(id);
      // The server's copy replaces ours (by clientId), unless a read brought it first; the read after it brings the delivery lines.
      const s = ones.get(id);
      setOne(id, { ...(s?.topic ? { topic: { ...s.topic, messages: withAnswer<LocalMessage>(s.topic.messages, res.message, localId) } } : {}), error: null });
      soon(`one:${id}`, () => { void loadOne(id, 'post'); });
      void loadList('post');
      return true;
    } catch (err) {
      withLocal(id, null, localId);
      log.warn('topics', 'post failed', { topicId: id, error: errText(err) });
      setOne(id, { error: `Could not send: ${errText(err)}` });
      return false;
    }
  }, [id]);

  return {
    topic: state?.topic ?? null,
    error: state?.error ?? null,
    post,
    addMembers: (refs) => write('add members', () => editTopicMembers(id!, { add: refs })),
    removeMember: (mid) => write('remove the member', () => editTopicMembers(id!, { remove: [mid] })),
    confirmMember: (mid) => write('confirm the person', () => confirmTopicMember(id!, mid)),
    setMail: (accountId) => write('choose the mailbox', () => setTopicMail(id!, accountId)),
    close: () => write('close the topic', () => closeTopic(id!)),
  };
}

/** After a topic is made elsewhere (the dialog), the list shows it before the event lands. */
export function topicMade(topic: Topic): void {
  setOne(topic.id, { topic, error: null });
  void loadList('created');
}

/** For tests: forget everything this page read. */
export function resetTopicsStore(): void {
  listState = { list: null, error: null };
  ones.clear();
  pendingSends.clear();
  watching.clear();
  notify();
}
