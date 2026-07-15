/**
 * Bedrock protocol adapter.
 *
 * Extracted from the original model.ts — same behavior, new home.
 * Uses @anthropic-ai/bedrock-sdk with bearer token or AWS credential chain.
 * Aggressive retry on 429/529, auto-recreate client on 403.
 */
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';
import type { ApiProtocol, ProtocolAdapter, AdapterCallOptions, ModelResult, ProviderConfig } from './types.js';
import {
  MAX_RETRIES, isAuthError, isRetryableError, getRetryDelay, sleep,
  abortedResult, extractUsage,
} from './retry.js';
import { CredentialProcessCache } from '../../core/aws-credential-process.js';
import { log } from '../../logging/index.js';

interface ClientConfig {
  region?: string;
  bearerToken?: string;
  accessKey?: string;
  secretKey?: string;
  sessionToken?: string;
  profile?: string;
}

export class BedrockAdapter implements ProtocolAdapter {
  readonly protocol: ApiProtocol = 'bedrock';
  private client: AnthropicBedrock | null = null;
  private lastConfig: string | null = null;
  /** One credential-process cache per distinct `aws_credential_export` command.
   *  Each runs the command lazily and refreshes near expiry (see
   *  aws-credential-process.ts) — the command is slow, so we never run it per call. */
  private credCaches = new Map<string, CredentialProcessCache>();

  private createClient(config: ClientConfig): AnthropicBedrock {
    const effectiveRegion = config.region ?? process.env.AWS_REGION ?? 'us-west-2';

    // Bearer token auth (Identity Center / SSO)
    if (config.bearerToken) {
      return new AnthropicBedrock({
        awsRegion: effectiveRegion,
        skipAuth: true,
        authToken: config.bearerToken,
      } as unknown as ConstructorParameters<typeof AnthropicBedrock>[0]);
    }

    // Explicit access key + secret (+ optional STS session token for temp creds)
    if (config.accessKey && config.secretKey) {
      return new AnthropicBedrock({
        awsRegion: effectiveRegion,
        awsAccessKey: config.accessKey,
        awsSecretKey: config.secretKey,
        ...(config.sessionToken && { awsSessionToken: config.sessionToken }),
      } as unknown as ConstructorParameters<typeof AnthropicBedrock>[0]);
    }

    // AWS profile — use providerChainResolver to specify profile
    if (config.profile) {
      return new AnthropicBedrock({
        awsRegion: effectiveRegion,
        providerChainResolver: () =>
          import('@aws-sdk/credential-providers').then(({ fromNodeProviderChain }) =>
            fromNodeProviderChain({ profile: config.profile }),
          ),
      } as unknown as ConstructorParameters<typeof AnthropicBedrock>[0]);
    }

    // Default: AWS credential chain (env vars → ~/.aws/credentials → instance metadata)
    return new AnthropicBedrock({ awsRegion: effectiveRegion });
  }

  private getClient(config: ClientConfig): AnthropicBedrock {
    // Session token in the key: a refreshed temp cred (new session token) must
    // NOT reuse the client built with the stale one.
    const configKey = `${config.region}:${config.bearerToken?.slice(-6) ?? ''}:${config.accessKey?.slice(-4) ?? ''}:${config.sessionToken?.slice(-8) ?? ''}:${config.profile ?? ''}`;
    if (this.client && this.lastConfig === configKey) return this.client;
    this.client = this.createClient(config);
    this.lastConfig = configKey;
    return this.client;
  }

  /**
   * Resolve the Bedrock client for a provider config. When the config carries a
   * `aws_credential_export` command, run it (cached + auto-refreshed) to get
   * temporary creds and build the client from them; otherwise use the static
   * bearer/keys/profile fields. Async because the export command may spawn.
   */
  private async resolveClient(providerConfig: ProviderConfig): Promise<AnthropicBedrock> {
    if (providerConfig.aws_credential_export) {
      const cmd = providerConfig.aws_credential_export;
      let cache = this.credCaches.get(cmd);
      if (!cache) {
        cache = new CredentialProcessCache(cmd);
        this.credCaches.set(cmd, cache);
      }
      const creds = await cache.get();
      return this.getClient({
        region: providerConfig.region,
        accessKey: creds.accessKeyId,
        secretKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      });
    }
    return this.getClient({
      region: providerConfig.region,
      bearerToken: providerConfig.bearer_token,
      accessKey: providerConfig.aws_access_key_id,
      secretKey: providerConfig.aws_secret_access_key,
      sessionToken: providerConfig.aws_session_token,
      profile: providerConfig.aws_profile,
    });
  }

  resetClient(): void {
    this.client = null;
    this.lastConfig = null;
    // Force a fresh credential-process run on next call (e.g. after a 403 =
    // temp creds expired between the refresh margin and the actual call).
    for (const cache of this.credCaches.values()) cache.reset();
  }

  async sendMessage(opts: AdapterCallOptions): Promise<ModelResult> {
    const { model, providerConfig } = opts;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const bedrock = await this.resolveClient(providerConfig);
      try {
        const params = {
          model,
          max_tokens: opts.maxTokens,
          system: opts.system,
          messages: opts.messages,
          tools: opts.tools,
          // Note: temperature must not be set when thinking is enabled (API defaults to 1.0)
          ...(opts.thinking && opts.thinking.type !== 'disabled' && { thinking: opts.thinking }),
        };
        const requestOpts = opts.signal ? { signal: opts.signal } : undefined;
        // Use beta endpoint when betas are specified (e.g., 1M context window).
        // BetaMessage and Message are structurally identical — safe to treat as same shape.
        const response: { content: any; stop_reason: any; usage?: any } = opts.betas?.length
          ? await (bedrock.beta.messages.create as any)(
              { ...params, betas: opts.betas },
              requestOpts,
            )
          : await bedrock.messages.create(params, requestOpts);

        return { content: response.content, stopReason: response.stop_reason, usage: extractUsage(response.usage) };
      } catch (err) {
        if (opts.signal?.aborted) return abortedResult();
        if (isAuthError(err) && attempt === 0) {
          log.agent.warn('403 auth error, recreating Bedrock client and retrying');
          this.resetClient();
          continue;
        }
        if (isRetryableError(err) && attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt, err);
          log.agent.warn(`bedrock 429/529 on attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${Math.round(delay)}ms`);
          await sleep(delay, opts.signal);
          if (opts.signal?.aborted) return abortedResult();
          continue;
        }
        throw err;
      }
    }
    throw new Error('Unreachable: retry loop exhausted');
  }

  async sendMessageStream(
    opts: AdapterCallOptions & { onTextDelta?: (delta: string) => void },
  ): Promise<ModelResult> {
    const { model, providerConfig } = opts;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let accumulatedText = '';

      try {
        const bedrock = await this.resolveClient(providerConfig);
        const streamParams = {
          model,
          max_tokens: opts.maxTokens,
          system: opts.system,
          messages: opts.messages,
          tools: opts.tools,
          // Note: temperature must not be set when thinking is enabled (API defaults to 1.0)
          ...(opts.thinking && opts.thinking.type !== 'disabled' && { thinking: opts.thinking }),
        };
        // Use beta endpoint when betas are specified (e.g., 1M context window).
        // BetaMessageStream and MessageStream are structurally compatible (same on/abort/finalMessage).
        const stream: MessageStream = opts.betas?.length
          ? (bedrock.beta.messages.stream as any)(
              { ...streamParams, betas: opts.betas },
            )
          : bedrock.messages.stream(streamParams);

        if (opts.signal) {
          if (opts.signal.aborted) {
            stream.abort();
          } else {
            opts.signal.addEventListener('abort', () => stream.abort(), { once: true });
          }
        }

        stream.on('text', (textDelta: string) => {
          accumulatedText += textDelta;
          opts.onTextDelta?.(textDelta);
        });

        const finalMsg = await stream.finalMessage();
        return {
          content: finalMsg.content,
          stopReason: finalMsg.stop_reason,
          usage: extractUsage(finalMsg.usage),
        };
      } catch (err) {
        if (opts.signal?.aborted) return abortedResult(accumulatedText);
        if (isAuthError(err) && attempt === 0) {
          log.agent.warn('403 auth error on stream, recreating Bedrock client and retrying');
          this.resetClient();
          continue;
        }
        if (isRetryableError(err) && attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt, err);
          log.agent.warn(`bedrock 429/529 on stream attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${Math.round(delay)}ms`);
          await sleep(delay, opts.signal);
          if (opts.signal?.aborted) return abortedResult();
          continue;
        }
        throw err;
      }
    }
    throw new Error('Unreachable: retry loop exhausted');
  }
}
