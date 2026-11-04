/**
 * A store error in words the user can act on. The SDK's and the network's own
 * text ("connect ECONNREFUSED 127.0.0.1:9999", "The specified bucket does not
 * exist") says what failed, not what to check; the code stays at the end in
 * parentheses for anyone who needs it.
 */
import type { BackupDestinationConfig } from './types.js';

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'CERT_HAS_EXPIRED', 'UND_ERR_CONNECT_TIMEOUT']);
const KEY_REFUSED = new Set(['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'InvalidToken', 'ExpiredToken', 'Unauthorized', 'InvalidClientTokenId']);

function codeOf(err: unknown): string | undefined {
  let e = err as { code?: string; name?: string; cause?: unknown; Code?: string } | undefined;
  for (let i = 0; e && i < 4; i++) {
    if (e.code && NETWORK_CODES.has(e.code)) return e.code;
    if (e.Code) return e.Code;
    if (e.name && e.name !== 'Error' && e.name !== 'TypeError') return e.name;
    e = e.cause as typeof e;
  }
  return (err as { code?: string } | undefined)?.code;
}

const statusOf = (err: unknown): number | undefined =>
  (err as { $metadata?: { httpStatusCode?: number }; status?: number } | undefined)?.$metadata?.httpStatusCode
  ?? (err as { status?: number } | undefined)?.status;

export function friendlyStoreError(err: unknown, dest: BackupDestinationConfig): string {
  const raw = err instanceof Error ? err.message : String(err);
  const code = codeOf(err);
  const status = statusOf(err);
  const bucket = dest.bucket ? `"${dest.bucket}"` : 'this bucket';
  const tag = code ? ` (${code})` : '';
  if (dest.type === 'gdrive') return raw;
  const cloudflare = dest.type === 'r2' && !dest.endpoint?.trim();
  if ((code && NETWORK_CODES.has(code)) || /fetch failed|getaddrinfo|socket hang up/i.test(raw)) {
    const where = dest.endpoint?.trim() ? `the custom endpoint ${dest.endpoint.trim()}` : dest.type === 'r2' ? 'Cloudflare with this Account ID' : 'AWS';
    return `Can't reach ${where}. Check the address and your internet connection${tag}.`;
  }
  if (code === 'NoSuchBucket' || (status === 404 && /bucket/i.test(raw))) {
    return cloudflare
      ? `No bucket named ${bucket} in this Cloudflare account. Check the spelling, or create it on the R2 page (Create bucket)${tag}.`
      : `No bucket named ${bucket} here. Check the spelling and the region${tag}.`;
  }
  if ((code && KEY_REFUSED.has(code)) || status === 401) {
    return cloudflare
      ? `Cloudflare refused these keys. Check the access key ID and the secret; Cloudflare shows the secret only once, so make a new token if it is lost${tag}.`
      : dest.endpoint?.trim()
        ? `The service refused these keys. Check the access key ID and the secret${tag}.`
        : `AWS refused these credentials. Check the keys or the profile${tag}.`;
  }
  if (code === 'AccessDenied' || status === 403) {
    return cloudflare
      ? `These keys may not write to ${bucket}. Give the API token Object Read & Write on that bucket${tag}.`
      : `These credentials may not write to ${bucket}. They need s3:PutObject, GetObject, ListBucket and DeleteObject on it${tag}.`;
  }
  return raw;
}
