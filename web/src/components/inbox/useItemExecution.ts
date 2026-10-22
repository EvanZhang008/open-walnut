import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { executeItem, prepareItem, itemError, type InboxItemPlan, type InboxLetterItem, type InboxFrozenInput } from '@/api/human-inbox-items';
import { getLeaderPresence } from '@/api/leader-presence';
import { getItemSnapshot, ingestItem, itemKey, mergeItemReceipts, mergeItemResponse, noteItemUnconfirmed,
  refreshItem, setItemSubmitting, subscribeItem, watchItem } from './item-store';

export function useItemExecution(letterId: string, item: InboxLetterItem) {
  const key = itemKey(letterId, item.id);
  const subscribe = useCallback((fn: () => void) => subscribeItem(key, fn), [key]);
  const read = useCallback(() => getItemSnapshot(key), [key]);
  const state = useSyncExternalStore(subscribe, read, read);
  useEffect(() => { ingestItem(key, item); }, [key, item.receipts, item.readObservation]);
  useEffect(() => item.unavailableReason ? undefined : watchItem(key), [key, item.unavailableReason]);
  const prepare = useCallback(async (actionId: string, input: InboxFrozenInput = {}, signal?: AbortSignal) => {
    const result = await prepareItem(letterId, item.id, { actionId, ...input }, signal);
    mergeItemReceipts(key, result.receipts);
    return result;
  }, [key, letterId, item.id]);
  const execute = useCallback(async (plan: InboxItemPlan, lane: string) => {
    if (!getLeaderPresence().answers) throw new Error('Last saved status. Connect to the primary Walnut to act.');
    if (getItemSnapshot(key).uncertain[lane]) throw new Error('Status unconfirmed. Check status before trying again.');
    if (!setItemSubmitting(key, lane, true)) return;
    const requestId = `iw-${crypto.randomUUID()}`;
    try {
      const result = await executeItem(letterId, item.id,
        { actionId: plan.actionId, requestId, confirmed: true, planId: plan.id, planVersion: plan.version });
      mergeItemResponse(key, result);
      return result;
    } catch (error) {
      const failure = itemError(error);
      const unknown = !failure.status || failure.status >= 500 && failure.code !== 'primary_unavailable';
      noteItemUnconfirmed(key, failure.status && failure.status < 500 ? failure.message : undefined,
        unknown ? lane : undefined, unknown ? requestId : undefined);
      // This is a read, never another execute. It survives closing this view.
      await refreshItem(key);
      throw error;
    } finally { setItemSubmitting(key, lane, false); }
  }, [key, letterId, item.id]);
  const direct = useCallback(async (actionId: string, lane: string) => {
    if (!setItemSubmitting(key, lane, true)) return;
    let prepared = false;
    try {
      const result = await prepare(actionId);
      if (!result.plan || result.restrictions.length) throw new Error(result.restrictions[0]?.message ?? 'Could not prepare this action');
      prepared = true;
      // Keep the submitting frame throughout preparation and execution.
      setItemSubmitting(key, lane, false);
      return await execute(result.plan, lane);
    } catch (error) { if (!prepared) noteItemUnconfirmed(key, itemError(error).message); }
    finally { setItemSubmitting(key, lane, false); }
  }, [key, execute, prepare]);
  return { state, prepare, execute, direct, check: () => refreshItem(key) };
}
