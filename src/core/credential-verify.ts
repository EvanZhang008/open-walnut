/**
 * Live verification of a resolved Bedrock credential — the "is the green dot
 * telling the truth?" check.
 *
 * The resolver (credential-resolver.ts) only decides WHICH source wins; its
 * last rung ('aws-files' / aws_chain) is a bare file-existence check, so a
 * ~/.aws/credentials full of expired session tokens still resolves as "ready".
 * This module actually exercises the winning credential:
 *
 *   - SigV4 methods (access_keys / profile / credential_process / aws_chain):
 *     STS GetCallerIdentity — cheap, no permissions needed, returns the ARN of
 *     whoever the credential actually is. Mirrors the Claude Code fork's
 *     checkStsCallerIdentity() pre-flight.
 *   - bearer_token: NOT SigV4 (it's an Identity Center token consumed only by
 *     Bedrock's HTTP layer), so STS can't validate it. We report 'unverifiable'
 *     here; POST /test-connection is the real round-trip for that method.
 *
 * SECURITY: never logs or returns key material — only the ARN, account, and
 * expiry that STS/the provider chain report.
 */
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  fromIni,
  fromNodeProviderChain,
  fromProcess,
} from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';
import { runCredentialProcess } from './aws-credential-process.js';
import type { ResolvedCredential } from './credential-resolver.js';
import { log } from '../logging/index.js';

/** Outcome of live-verifying a resolved credential. */
export interface CredentialVerifyResult {
  /** 'valid' = STS confirmed the identity; 'invalid' = call failed (expired /
   *  malformed / no such profile); 'unverifiable' = method can't be checked via
   *  STS (bearer token); 'skipped' = nothing resolved to verify. */
  status: 'valid' | 'invalid' | 'unverifiable' | 'skipped';
  /** Who the credential actually is (STS Arn), when valid. */
  arn?: string;
  account?: string;
  /** Session-credential expiry if the provider chain reported one. */
  expiration?: string;
  /** Human-readable failure, when invalid. */
  error?: string;
  /** Wall-clock ms the verification took. */
  latencyMs: number;
}

const STS_TIMEOUT_MS = 8_000;

/** Build the SDK credential provider matching the resolved method. */
function providerFor(cred: ResolvedCredential): AwsCredentialIdentityProvider | AwsCredentialIdentity | null {
  switch (cred.method) {
    case 'access_keys':
      return {
        accessKeyId: cred.accessKeyId!,
        secretAccessKey: cred.secretAccessKey!,
      };
    case 'profile':
      return fromIni({ profile: cred.profile });
    case 'credential_process':
      // Reuse our own runner (handles both flat + nested JSON shapes and strips
      // stderr noise) rather than fromProcess, which expects an ~/.aws profile.
      return async () => {
        const c = await runCredentialProcess(cred.credentialExportCmd!);
        return {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          sessionToken: c.sessionToken,
          ...(c.expiration ? { expiration: new Date(c.expiration) } : {}),
        };
      };
    case 'aws_chain':
      return fromNodeProviderChain();
    default:
      return null;
  }
}

/**
 * Live-verify the resolved credential with STS GetCallerIdentity.
 * Never throws — all failures land in {status:'invalid', error}.
 */
export async function verifyResolvedCredential(cred: ResolvedCredential): Promise<CredentialVerifyResult> {
  const start = Date.now();

  if (cred.source === 'none' || !cred.method) {
    return { status: 'skipped', latencyMs: 0 };
  }
  if (cred.method === 'bearer_token') {
    // Identity Center bearer tokens aren't SigV4 — STS can't see them. The
    // Bedrock test-connection round-trip is the authoritative check for these.
    return { status: 'unverifiable', latencyMs: 0 };
  }

  const provider = providerFor(cred);
  if (!provider) return { status: 'skipped', latencyMs: 0 };

  try {
    // Resolve credentials first so we can surface Expiration even though
    // GetCallerIdentity itself doesn't return it.
    const identity: AwsCredentialIdentity = typeof provider === 'function' ? await provider() : provider;

    const client = new STSClient({
      region: cred.region ?? 'us-west-2',
      credentials: identity,
      requestHandler: { requestTimeout: STS_TIMEOUT_MS },
    });
    const resp = await client.send(new GetCallerIdentityCommand({}));
    return {
      status: 'valid',
      arn: resp.Arn,
      account: resp.Account,
      expiration: identity.expiration?.toISOString(),
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.session.debug('credential-verify: STS check failed', { method: cred.method, error: msg });
    return {
      status: 'invalid',
      error: msg,
      latencyMs: Date.now() - start,
    };
  }
}
