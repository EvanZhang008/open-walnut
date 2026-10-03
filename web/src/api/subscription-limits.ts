/**
 * Claude subscription limits per host: GET /api/subscription-limits
 * (src/web/routes/subscription-limits.ts). Live frames arrive as the
 * `host:subscription-limits` WS event; this read hydrates. Same shapes as the
 * server's HostLimitFrame (src/core/sessions/subscription-limits.ts).
 */
import { apiGet } from './client';

export type LimitStatus = 'allowed' | 'allowed_warning' | 'rejected';

export interface LimitWindow {
  /** five_hour | seven_day | seven_day_opus | seven_day_sonnet | seven_day_overage_included | a future name */
  type: string;
  /** 0-1 fraction used (can pass 1); absent when the CLI did not say. */
  utilization?: number;
  /** Epoch ms the window resets. */
  resetsAt?: number;
  /** Server ms this window was last reported. */
  seenAt: number;
  sessionId?: string;
}

export interface LimitCurrent {
  status: LimitStatus;
  /** The window the status is about. */
  type?: string;
  resetsAt?: number;
  utilization?: number;
  surpassedThreshold?: number;
  seenAt: number;
  sessionId?: string;
}

export interface LimitOverage {
  status?: LimitStatus;
  resetsAt?: number;
  disabledReason?: string;
  isUsingOverage?: boolean;
  seenAt: number;
}

export interface HostSignIn {
  kind: 'subscription' | 'other' | 'unknown';
  detail?: string;
  checkedAt?: number;
}

export interface HostLimitFrame {
  /** '__local__' or the host alias. */
  host: string;
  windows: Record<string, LimitWindow>;
  current?: LimitCurrent;
  overage?: LimitOverage;
  updatedAt: number;
  signIn?: HostSignIn;
  /** Server clock when the frame was built. */
  serverNow: number;
}

/** `null` = the server answered 204 (its read ran out of time): keep what is shown. */
export async function fetchSubscriptionLimits(): Promise<HostLimitFrame[] | null> {
  const res = await apiGet<{ hosts: HostLimitFrame[] } | undefined>('/api/subscription-limits', undefined, {
    quietStatuses: [404], timeoutMs: 10_000, priority: 'low',
  });
  return res ? res.hosts ?? [] : null;
}
