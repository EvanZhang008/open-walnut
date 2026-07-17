/**
 * LIVE integration test — real credentials, real Bedrock round-trip.
 *
 * Proves the full awsCredentialExport chain end-to-end:
 *   settings.json top-level awsCredentialExport
 *     → resolver surfaces method 'credential_process' + command
 *     → CredentialProcessCache runs it → temp creds (with SessionToken)
 *     → AnthropicBedrock (the SAME SDK adapter-bedrock.ts uses) → real model reply
 *
 * Gated: skips gracefully (never reddens CI) unless opt-in via
 * WALNUT_LIVE_BEDROCK=1 AND a credential-export command is available (either the
 * top-level awsCredentialExport in ~/.claude/settings.json, or an explicit
 * WALNUT_LIVE_EXPORT_CMD override — settings.json toggles between auth methods,
 * so the override keeps this test runnable). Run locally with:
 *   env -u VITEST WALNUT_LIVE_BEDROCK=1 \
 *     WALNUT_LIVE_EXPORT_CMD='"/Users/…/.toolbox/bin/claude" default-credential-export' \
 *     npx vitest run --config <live-config> tests/core/credential-resolver.live.test.ts
 */
import { describe, it, expect } from 'vitest';
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { readClaudeCredentialExport, readClaudeSettingsEnv } from '../../src/core/credential-resolver.js';
import { CredentialProcessCache } from '../../src/core/aws-credential-process.js';

const exportCmd = process.env.WALNUT_LIVE_EXPORT_CMD || readClaudeCredentialExport();
const optedIn = process.env.WALNUT_LIVE_BEDROCK === '1';
const runLive = optedIn && !!exportCmd;

// Cheapest model for a smoke round-trip. No [1m] suffix — Bedrock APIs reject it.
const TEST_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

(runLive ? describe : describe.skip)('LIVE: awsCredentialExport → Bedrock', () => {
  it('runs the export command and gets temporary creds with a session token', async () => {
    const cache = new CredentialProcessCache(exportCmd!);
    const creds = await cache.get();
    expect(creds.accessKeyId).toMatch(/^ASIA|^AKIA/);
    expect(creds.secretAccessKey.length).toBeGreaterThan(0);
    // ada / SSO temp creds carry a session token — the whole point of this path.
    expect(creds.sessionToken, 'expected temporary (STS) creds with a session token').toBeTruthy();
  });

  it('signs a real Bedrock call with those creds and gets a reply', async () => {
    const cache = new CredentialProcessCache(exportCmd!);
    const creds = await cache.get();
    const region = readClaudeSettingsEnv().AWS_REGION || 'us-west-2';

    const client = new AnthropicBedrock({
      awsRegion: region,
      awsAccessKey: creds.accessKeyId,
      awsSecretKey: creds.secretAccessKey,
      awsSessionToken: creds.sessionToken,
    } as unknown as ConstructorParameters<typeof AnthropicBedrock>[0]);

    const msg = await client.messages.create({
      model: TEST_MODEL,
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Reply with exactly: WALNUT_LIVE_OK' }],
    });
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text.length).toBeGreaterThan(0);
    expect(msg.usage.output_tokens).toBeGreaterThan(0);
  }, 30_000);
});

// Always emit one visible line so a skipped live suite is obvious, not silent.
if (!runLive) {
  describe('LIVE: awsCredentialExport → Bedrock (skipped)', () => {
    it('is skipped without opt-in + a credential-export command', () => {
      const reason = !optedIn ? 'WALNUT_LIVE_BEDROCK!=1' : 'no awsCredentialExport (settings.json or WALNUT_LIVE_EXPORT_CMD)';
      expect(reason.length).toBeGreaterThan(0);
    });
  });
}
