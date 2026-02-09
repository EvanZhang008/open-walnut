/**
 * Sensitive data masking — runs BEFORE any log line is written.
 *
 * Patterns covered:
 *  - OpenAI / Anthropic API keys (sk-...)
 *  - AWS access key IDs (AKIA...)
 *  - AWS secrets & session tokens (in key=value form)
 *  - Bearer tokens
 *  - PEM private key blocks
 *  - Generic secrets after password=, secret=, token= (key=value form)
 */

const REDACTED = '[REDACTED]';

// Order matters: more specific patterns first, generic catch-alls last.
const patterns: Array<{ re: RegExp; replacement: string }> = [
  // PEM private key blocks (multiline)
  {
    re: /-----BEGIN\s[\w\s]*PRIVATE KEY-----[\s\S]*?-----END\s[\w\s]*PRIVATE KEY-----/g,
    replacement: REDACTED,
  },

  // Bearer tokens: Authorization: Bearer <token>
  {
    re: /(Bearer\s+)\S+/gi,
    replacement: `$1${REDACTED}`,
  },

  // OpenAI / Anthropic style keys: sk-... (at least 20 chars after prefix)
  {
    re: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: REDACTED,
  },

  // AWS access key IDs: AKIA...
  {
    re: /\bAKIA[A-Z0-9]{12,}\b/g,
    replacement: REDACTED,
  },

  // AWS secret access key in key=value form
  {
    re: /(aws_secret_access_key\s*[=:]\s*)\S+/gi,
    replacement: `$1${REDACTED}`,
  },

  // AWS session token in key=value form
  {
    re: /(aws_session_token\s*[=:]\s*)\S+/gi,
    replacement: `$1${REDACTED}`,
  },

  // Generic secrets: password=, secret=, token=, api_key=, apikey=
  {
    re: /((?:password|secret|token|api_key|apikey)\s*[=:]\s*)\S+/gi,
    replacement: `$1${REDACTED}`,
  },
];

/**
 * Replace sensitive patterns in `text` with [REDACTED].
 * Safe to call on any string — returns the original if nothing matches.
 */
export function redactSensitiveText(text: string): string {
  let result = text;
  for (const { re, replacement } of patterns) {
    result = result.replace(re, replacement);
  }
  return result;
}
