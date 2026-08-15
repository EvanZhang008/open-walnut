/**
 * Runner + cache for a `credential_process`-style command (Claude Code's
 * `awsCredentialExport` settings key).
 *
 * The command prints temporary AWS credentials as JSON on stdout, in EITHER of
 * the two shapes in the wild — we accept both:
 *   flat   { "Version":1, "AccessKeyId", "SecretAccessKey", "SessionToken", "Expiration" }
 *          — the AWS-documented `credential_process` protocol; what SSO/ada-style
 *          helpers and `aws configure export-credentials --format process` emit.
 *   nested { "Credentials": { "AccessKeyId", … } }
 *          — the `sts assume-role` / `claude default-credential-export` shape.
 * Accepting only the nested one silently broke every standards-compliant helper
 * (2026-07-26: the Personal AI ran 18h on expired ~/.aws creds because its configured
 * credential_process was rejected as "not a valid Credentials object").
 *
 * Design mirrors the Claude Code fork's `refreshAndGetAwsCredentials`
 * (src/utils/auth.ts): cache the result and re-run the command only when the
 * cached creds are near expiry — NOT on every model call (the command is slow).
 * We refresh on a safety margin BEFORE `Expiration` so an in-flight request
 * never signs with creds that expire mid-call.
 *
 * SECURITY: the command string is only ever sourced from the user-global
 * ~/.claude/settings.json (see credential-resolver.readClaudeCredentialExport),
 * never a project-level file, so a checked-out repo can't inject a command.
 */
import { execFile } from 'node:child_process';
import { log } from '../logging/index.js';

/** Temporary AWS credentials resolved from a credential_process command. */
export interface ProcessCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** ISO-8601 expiry, if the command reported one. */
  expiration?: string;
}

/** The credential fields, in whichever shape they arrived. */
interface RawCredentialFields {
  AccessKeyId?: unknown;
  SecretAccessKey?: unknown;
  SessionToken?: unknown;
  Expiration?: unknown;
}

/** Parsed shape of the command's JSON stdout — flat or nested under `Credentials`. */
interface CredentialProcessOutput extends RawCredentialFields {
  Credentials?: RawCredentialFields;
}

/** Refresh this many ms BEFORE the reported Expiration so a request never signs
 *  with creds that expire mid-flight. Temp creds are ~60min; 5min margin is safe. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Fallback lifetime when the command reports no Expiration — re-run this often. */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** How long to wait for the command before giving up. */
const COMMAND_TIMEOUT_MS = 30 * 1000;

/**
 * Run a credential_process command once and parse its output.
 * Rejects with a clear error if the command fails, times out, or emits
 * something that isn't the expected `{Credentials:{...}}` JSON — the caller
 * surfaces this to the user (e.g. "SSO session expired, please re-login")
 * rather than hanging.
 *
 * `execFile` with `shell: true` runs the string through the shell so quoted
 * commands like `"/path/to/claude" default-credential-export` work verbatim.
 * We read stdout only (stderr is discarded): ada-style helpers print progress
 * lines to stderr that would otherwise corrupt the JSON parse.
 */
export function runCredentialProcess(command: string): Promise<ProcessCredentials> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      {
        shell: true,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout) => {
        if (err) {
          reject(new Error(`awsCredentialExport command failed: ${err.message}`));
          return;
        }
        let parsed: CredentialProcessOutput;
        try {
          parsed = JSON.parse(String(stdout).trim());
        } catch {
          reject(new Error('awsCredentialExport did not return valid JSON'));
          return;
        }
        // Nested shape wins when present; otherwise read the fields off the root
        // (the standard flat `credential_process` protocol).
        const c: RawCredentialFields = parsed?.Credentials ?? parsed ?? {};
        if (typeof c.AccessKeyId !== 'string' || typeof c.SecretAccessKey !== 'string') {
          reject(new Error(
            'awsCredentialExport did not return AWS credentials: expected AccessKeyId + '
            + 'SecretAccessKey either at the top level or under "Credentials". '
            + `Got keys: ${Object.keys(parsed ?? {}).join(', ') || '(none)'}`,
          ));
          return;
        }
        resolve({
          accessKeyId: c.AccessKeyId,
          secretAccessKey: c.SecretAccessKey,
          sessionToken: typeof c.SessionToken === 'string' ? c.SessionToken : undefined,
          expiration: typeof c.Expiration === 'string' ? c.Expiration : undefined,
        });
      },
    );
  });
}

/**
 * A per-command cache that runs the command lazily and refreshes only near
 * expiry. One instance per distinct command string (the adapter keys by command).
 *
 * `runner` is injectable so tests can supply a fake command runner + clock
 * without spawning real processes.
 */
export class CredentialProcessCache {
  private cached: ProcessCredentials | null = null;
  /** Epoch-ms after which `cached` must be re-fetched (expiry − margin). */
  private refreshAtMs = 0;
  /** In-flight fetch, so concurrent callers share one command invocation. */
  private inflight: Promise<ProcessCredentials> | null = null;

  constructor(
    private readonly command: string,
    private readonly runner: (cmd: string) => Promise<ProcessCredentials> = runCredentialProcess,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Return cached creds if still fresh, else (re-)run the command. */
  async get(): Promise<ProcessCredentials> {
    if (this.cached && this.now() < this.refreshAtMs) return this.cached;
    if (this.inflight) return this.inflight;

    this.inflight = this.runner(this.command)
      .then((creds) => {
        this.cached = creds;
        this.refreshAtMs = this.computeRefreshAt(creds.expiration);
        log.session.debug('aws-credential-process: refreshed credentials', {
          hasSessionToken: !!creds.sessionToken,
          expiration: creds.expiration ?? '(none)',
        });
        return creds;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Drop the cache so the next `get()` re-runs the command. */
  reset(): void {
    this.cached = null;
    this.refreshAtMs = 0;
    this.inflight = null;
  }

  /** When to next refresh: expiry − margin if known, else now + default TTL. */
  private computeRefreshAt(expiration?: string): number {
    if (expiration) {
      const expMs = Date.parse(expiration);
      if (!Number.isNaN(expMs)) return expMs - REFRESH_MARGIN_MS;
    }
    return this.now() + DEFAULT_TTL_MS;
  }
}
