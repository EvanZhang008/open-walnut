/**
 * The remote history storage form's setting (HistoryRemoteGroup.tsx): what it saves and what
 * Test connection and Set up act on.
 */
import type { Config } from '@open-walnut/core';

export type Remote = NonNullable<NonNullable<Config['session']>['history_remote']>;
export type Target = 'aws' | 'other';
export type Method = 'aws_chain' | 'profile';

/** The fields this form edits; every other saved field (prefix, force_path_style, ...) is kept as it is. */
const FORM_FIELDS = ['enabled', 'days', 'bucket', 'region', 'endpoint', 'auth'] as const;

/**
 * The setting as stored: the saved one with the form's fields laid over it, an empty field
 * cleared (left out), never a credential (those stay in the AWS chain or ~/.aws).
 */
export function remoteFormConfig(f: {
  enabled: boolean; target: Target; bucket: string; region: string; endpoint: string; days: number | undefined; method: Method; profile: string;
}, saved: Remote = {}): Remote {
  const kept: Remote = { ...saved };
  for (const k of FORM_FIELDS) delete kept[k];
  return {
    ...kept,
    enabled: f.enabled,
    ...(f.days !== undefined ? { days: f.days } : {}),
    bucket: f.bucket.trim(),
    ...(f.region.trim() ? { region: f.region.trim() } : {}),
    ...(f.target === 'other' && f.endpoint.trim() ? { endpoint: f.endpoint.trim() } : {}),
    auth: f.method === 'profile' && f.profile.trim() ? { method: 'profile', profile: f.profile.trim() } : { method: 'aws_chain' },
  };
}
