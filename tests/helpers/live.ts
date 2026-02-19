/**
 * Helpers for live tests (Tier 5) — tests that hit real external APIs.
 *
 * Live tests are expensive and require credentials. They are excluded from
 * normal test runs and only execute via `npm run test:live`.
 *
 * Usage:
 *   import { isLiveTest, hasAwsCredentials } from '../helpers/live.js';
 *   describe.skipIf(!isLiveTest() || !hasAwsCredentials())('Bedrock live', () => { ... });
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';

/**
 * Returns true when running in live-test mode.
 * Set WALNUT_LIVE_TEST=1 or LIVE=1 to enable.
 */
export function isLiveTest(): boolean {
  return process.env.WALNUT_LIVE_TEST === '1' || process.env.LIVE === '1';
}

/**
 * Returns true when AWS credentials are available (for Bedrock calls).
 * Checks env vars first, then falls back to `aws sts get-caller-identity`.
 */
export function hasAwsCredentials(): boolean {
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) return true;
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) return true;
  try {
    execSync('aws sts get-caller-identity', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true when Microsoft Graph credentials are available (for MS To-Do).
 * Checks env vars; real auth is via MSAL cache in ~/.walnut/ (set up via `walnut auth`).
 */
export function hasMsGraphCredentials(): boolean {
  return !!(process.env.MS_TODO_ACCESS_TOKEN || process.env.MS_TODO_REFRESH_TOKEN);
}

/** Read and parse ~/.walnut/config.yaml synchronously (for credential gate checks). */
function readConfigSync(): Record<string, unknown> | null {
  try {
    const home = process.env.WALNUT_HOME || path.join(os.homedir(), '.walnut');
    const content = fs.readFileSync(path.join(home, 'config.yaml'), 'utf-8');
    return (yaml.load(content) as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns true when plugin-a credentials are available.
 * Checks config.yaml for plugins.plugin-a.base_url and plugins.plugin-a.auth.token.
 */
export function hasPluginCredentials(): boolean {
  const config = readConfigSync();
  if (!config) return false;
  const plugins = config.plugins as Record<string, unknown> | undefined;
  const pluginA = plugins?.['plugin-a'] as Record<string, unknown> | undefined;
  return !!(pluginA?.base_url && (pluginA?.auth as Record<string, unknown>)?.token);
}

/**
 * Returns true when plugin-b credentials are available.
 * Checks config.yaml for plugins.plugin-b with cookie-based auth — checks if config has room_id.
 */
export function hasPluginCredentials(): boolean {
  const config = readConfigSync();
  if (!config) return false;
  const plugins = config.plugins as Record<string, unknown> | undefined;
  const pluginB = plugins?.['plugin-b'] as Record<string, unknown> | undefined;
  return !!pluginB?.room_id;
}
