/**
 * The credentials of a setting that says "sign in with a named profile of ~/.aws". A setting of
 * that kind with no profile name still signs in as it always did (the SDK's default profile:
 * AWS_PROFILE, else [default]), so a setup that works keeps working; but a failure then says
 * that the setting names no profile and where to name one (2026-11-19: Backup was set to
 * `method: profile` with no name, the SDK read [default], whose static session token went stale
 * on 11-16, and every run failed with "The provided token is malformed", which named neither the
 * setting nor the fix).
 */
import { fromIni } from '@aws-sdk/credential-providers'
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'

const hasName = (profile: unknown): profile is string => typeof profile === 'string' && profile.trim() !== ''

export function namedProfileCredentials(profile: string | undefined): AwsCredentialIdentityProvider {
  return fromIni(hasName(profile) ? { profile: profile.trim() } : {})
}

/**
 * The words a failure of `setting` gets when it is set to a profile with no name; '' otherwise.
 * Appended to the error the storage answered, so the person reads the cause next to the fix.
 */
export function unnamedProfileHint(auth: { method?: string; profile?: string } | undefined, setting: string): string {
  if (auth?.method !== 'profile' || hasName(auth.profile)) return ''
  return ` (${setting} is set to sign in with an AWS profile but names none, so it used the default AWS credentials: name the profile in its settings)`
}
