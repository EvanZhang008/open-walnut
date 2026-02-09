/**
 * Unit tests for src/logging/redact.ts
 *
 * Covers: redactSensitiveText() — API keys, AWS keys, Bearer tokens,
 * PEM blocks, aws_secret_access_key, password=, and safe-passthrough.
 */
import { describe, it, expect } from 'vitest';
import { redactSensitiveText } from '../../src/logging/redact.js';

describe('redactSensitiveText', () => {
  it('masks Anthropic/OpenAI API keys (sk-...)', () => {
    const input = 'key is sk-ant-api03-xxxxxxxxxxxxxxxxxxxx';
    const result = redactSensitiveText(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('sk-ant-api03-xxxxxxxxxxxxxxxxxxxx');
  });

  it('masks AWS access key IDs (AKIA...)', () => {
    const input = 'aws key AKIAIOSFODNN7EXAMPLE here';
    const result = redactSensitiveText(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('masks Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.xxxxx';
    const result = redactSensitiveText(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9.xxxxx');
    // The "Bearer " prefix should be preserved
    expect(result).toContain('Bearer');
  });

  it('masks PEM private key blocks', () => {
    const input =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    const result = redactSensitiveText(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(result).not.toContain('MIIEpAIBAAKCAQEA');
  });

  it('masks aws_secret_access_key in key=value form', () => {
    const input = 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCY';
    const result = redactSensitiveText(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCY');
  });

  it('masks password=value', () => {
    const input = 'password=mysecretpassword';
    const result = redactSensitiveText(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('mysecretpassword');
  });

  it('preserves normal text unchanged', () => {
    const input = 'Hello world, this is a normal log message';
    const result = redactSensitiveText(input);
    expect(result).toBe(input);
  });

  it('handles empty string', () => {
    const result = redactSensitiveText('');
    expect(result).toBe('');
  });

  it('masks multiple sensitive values in the same string', () => {
    const input = 'key=sk-ant-api03-abcdefghijklmnopqrst and token=secretvalue123';
    const result = redactSensitiveText(input);
    expect(result).not.toContain('sk-ant-api03-abcdefghijklmnopqrst');
    expect(result).not.toContain('secretvalue123');
  });

  it('masks secret= and token= in key=value form', () => {
    const input = 'secret=hunter2 token=abc123';
    const result = redactSensitiveText(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('hunter2');
    expect(result).not.toContain('abc123');
  });
});
