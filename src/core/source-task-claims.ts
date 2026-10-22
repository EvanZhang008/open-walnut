import path from 'node:path';
import { WALNUT_HOME } from '../constants.js';
import { readJsonFile, updateJsonFile } from '../utils/fs.js';
import { stableJson, taskIdForKey } from './task-create-idempotency.js';

export interface SourceTaskClaim {
  key: string; taskId: string; aliases: string[]; created: boolean; legacy: boolean;
  createPayload?: Record<string, unknown>;
  confirmed?: { intent: string; goal: string; targetTaskId: string };
  updatedAt: string;
}
interface ClaimFile { version: 1; claims: Record<string, SourceTaskClaim>; aliases: Record<string, string> }
const FILE = path.join(WALNUT_HOME, 'source-task-claims.json');
const empty = (): ClaimFile => ({ version: 1, claims: {}, aliases: {} });
export class SourceClaimConflict extends Error { readonly status = 409; readonly code = 'source_conflict'; }
export const sourcePairKey = (account: string, message: string) => JSON.stringify([account, message]);
export interface SourceClaimAdapter {
  legacyTaskId(key: string): Promise<string | undefined>;
  writeLegacy(key: string, taskId: string): Promise<void>;
}
export async function lookupSourceClaim(key: string, pair: string, adapter: SourceClaimAdapter): Promise<SourceTaskClaim | undefined> {
  const file = await readJsonFile<ClaimFile>(FILE, empty());
  const mapped = Object.hasOwn(file.aliases, pair) ? file.aliases[pair] : undefined;
  if (mapped && mapped !== key) throw new SourceClaimConflict('This email identity conflicts with its saved source mapping');
  const claim = Object.hasOwn(file.claims, key) ? file.claims[key] : undefined;
  const legacy = await adapter.legacyTaskId(key);
  if (legacy && claim && legacy !== claim.taskId) throw new SourceClaimConflict('The saved email task records disagree. Review the existing task');
  return claim ?? (legacy ? { key, taskId: legacy, aliases: [pair], legacy: true, created: true, updatedAt: '' } : undefined);
}
/** Reserve BEFORE create. The durable claim is also the write-ahead log for the legacy ledger. */
export async function claimSourceTask(input: {
  key: string; pair: string; targetTaskId?: string; createPayload?: Record<string, unknown>;
  confirmation?: SourceTaskClaim['confirmed']; adapter: SourceClaimAdapter;
}): Promise<SourceTaskClaim> {
  let result!: SourceTaskClaim;
  await updateJsonFile(FILE, empty(), async file => {
    const alias = Object.hasOwn(file.aliases, input.pair) ? file.aliases[input.pair] : undefined;
    if (alias && alias !== input.key) throw new SourceClaimConflict('This email identity conflicts with its saved source mapping');
    const legacyId = await input.adapter.legacyTaskId(input.key);
    const existing = Object.hasOwn(file.claims, input.key) ? file.claims[input.key] : undefined;
    if (existing && legacyId && existing.taskId !== legacyId) throw new SourceClaimConflict('The saved email task records disagree');
    const taskId = existing?.taskId ?? legacyId ?? input.targetTaskId ?? taskIdForKey(`mail-source:${input.key}`);
    if (input.targetTaskId && taskId !== input.targetTaskId) throw new SourceClaimConflict('This email is already linked to another task');
    if (existing?.confirmed && input.confirmation && stableJson(existing.confirmed) !== stableJson(input.confirmation)) {
      throw new SourceClaimConflict('This email already has a different confirmed action. Review its task first.');
    }
    result = { ...existing, key: input.key, taskId,
      created: existing?.created ?? !!legacyId, legacy: existing?.legacy ?? !!legacyId,
      aliases: [...new Set([...(existing?.aliases ?? []), input.pair])],
      createPayload: existing?.createPayload ?? input.createPayload,
      confirmed: existing?.confirmed ?? input.confirmation,
      updatedAt: new Date().toISOString(),
    };
    file.claims[input.key] = result;
    file.aliases[input.pair] = input.key;
    return file;
  }, { durable: true });
  // A crash here is safe: the reservation is already durable; the next call reconciles this write.
  await input.adapter.writeLegacy(input.key, result.taskId);
  return result;
}
export async function markSourceTaskCreated(key: string, taskId: string): Promise<void> {
  await updateJsonFile(FILE, empty(), file => {
    const claim = Object.hasOwn(file.claims, key) ? file.claims[key] : undefined;
    if (!claim || claim.taskId !== taskId) throw new SourceClaimConflict('The email task claim changed');
    claim.created = true;
    claim.updatedAt = new Date().toISOString();
    return file;
  }, { durable: true });
}
