import type { InboxMailSource, InboxReadObservation } from './types.js';
import type { SourceClaimAdapter } from '../source-task-claims.js';

export interface InboxTrustedSource {
  key: string;
  source: InboxMailSource;
  readObservation?: InboxReadObservation;
  adapter: SourceClaimAdapter;
}
export interface InboxSourceService { resolve(source: InboxMailSource): Promise<InboxTrustedSource> }
let mailSource: InboxSourceService | undefined;
/** Only an activated host integration can supply canonical identity. Never client input. */
export function registerInboxMailSource(service: InboxSourceService): () => void {
  mailSource = service;
  return () => { if (mailSource === service) mailSource = undefined; };
}
export async function resolveInboxSource(source: InboxMailSource): Promise<InboxTrustedSource> {
  if (!mailSource) throw new Error('Mail actions unavailable: the mail integration is not active');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: InboxTrustedSource;
  try { result = await Promise.race([mailSource.resolve(source), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Email status unavailable: cache lookup timed out')), 3000);
  })]); } finally { if (timer) clearTimeout(timer); }
  if (result.source.account !== source.account || result.source.message !== source.message || result.source.kind !== 'mail') {
    throw new Error('Email unavailable: source identity mismatch');
  }
  return result;
}
